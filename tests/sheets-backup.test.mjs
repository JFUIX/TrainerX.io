import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import test from 'node:test';
import {loadBackup,storeBackup} from '../sheets-backup.mjs';

function fakeSheet(){
  const tabs=new Map();
  let failChunk=false;
  return {
    failNextChunk(){failChunk=true},
    async request(path,method,body){
      if(path.startsWith('?fields='))return {sheets:[...tabs.values()].map(({properties})=>({properties}))};
      if(path===':batchUpdate'){
        const {addSheet,updateSheetProperties}=body.requests[0];
        if(addSheet){
          const properties={sheetId:tabs.size,...addSheet.properties};
          tabs.set(properties.title,{properties,rows:[]});
        }else{
          const update=updateSheetProperties.properties;
          const tab=[...tabs.values()].find(v=>v.properties.sheetId===update.sheetId);
          tab.properties.gridProperties.rowCount=update.gridProperties.rowCount;
          tab.rows.length=Math.min(tab.rows.length,update.gridProperties.rowCount);
        }
        return {};
      }
      const match=decodeURIComponent(path).match(/^\/values\/'([^']+)'!A(\d+)(?::A(\d+))?/);
      assert.ok(match,path);
      const [,title,first,last]=match;
      const tab=tabs.get(title);
      const start=Number(first),end=Number(last||first);
      if(method==='PUT'){
        assert.equal(body.values.length,end-start+1);
        assert.ok(end<=tab.properties.gridProperties.rowCount);
        if(start>1&&failChunk){failChunk=false;throw new Error('interrupted write')}
        body.values.forEach((row,index)=>{tab.rows[start-1+index]=row});
        return {};
      }
      return {values:tab.rows.slice(start-1,end)};
    }
  };
}

test('Sheets backup rotates snapshots, ignores partial uploads, and verifies encryption',async()=>{
  const sheets=fakeSheet();
  const key=randomBytes(32),archive=randomBytes(900000);
  const first='2026-11-25',second='2026-11-26',rotated='2026-12-02';
  assert.equal(await storeBackup(sheets.request,key,archive,first),true);
  assert.equal(await storeBackup(sheets.request,key,Buffer.from('duplicate'),first),false);
  assert.deepEqual(await loadBackup(sheets.request,key),archive);
  await assert.rejects(loadBackup(sheets.request,randomBytes(32)));
  sheets.failNextChunk();
  await assert.rejects(storeBackup(sheets.request,key,archive,second),/interrupted/);
  assert.deepEqual(await loadBackup(sheets.request,key),archive);
  await assert.rejects(loadBackup(sheets.request,key,second),/No completed/);
  const newer=Buffer.from('next snapshot');
  assert.equal(await storeBackup(sheets.request,key,newer,second),true);
  assert.deepEqual(await loadBackup(sheets.request,key),newer);
  assert.equal(await storeBackup(sheets.request,key,newer,rotated),true);
  await assert.rejects(loadBackup(sheets.request,key,first),/No completed/);
  assert.deepEqual(await loadBackup(sheets.request,key,rotated),newer);
});
