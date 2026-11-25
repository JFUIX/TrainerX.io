import {execFile} from 'node:child_process';
import {createCipheriv,createDecipheriv,createSign,randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import pg from 'pg';

const runFile=promisify(execFile);
const slotNames=Array.from({length:7},(_,i)=>'TrainerX Backup '+(i+1));
const chunkSize=32000;
const batchSize=24;
const maxDumpBytes=20*1024*1024;
const lockId=746527;
const tokenUrl='https://oauth2.googleapis.com/token';

function configuration(){
  const {GOOGLE_BACKUP_SHEET_ID:sheetId,GOOGLE_BACKUP_SERVICE_ACCOUNT:credentials,GOOGLE_BACKUP_KEY:encodedKey}=process.env;
  if(!/^[\w-]+$/.test(sheetId||'')||!credentials||!encodedKey)throw new Error('Google Sheets backup configuration is incomplete');
  let account;
  try{account=JSON.parse(credentials)}catch{throw new Error('Invalid backup service account JSON')}
  const key=Buffer.from(encodedKey,'base64');
  if(!account?.client_email||!account.private_key||key.length!==32)throw new Error('Invalid backup credentials or encryption key');
  return {sheetId,account,key};
}

async function jsonRequest(url,options){
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(30000)});
  if(!response.ok){
    await response.body?.cancel();
    throw new Error('Google backup API returned HTTP '+response.status);
  }
  return response.json();
}

async function openSheet({sheetId,account}){
  const now=Math.floor(Date.now()/1000);
  const segment=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const claim=segment({alg:'RS256',typ:'JWT'})+'.'+segment({
    iss:account.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',
    aud:tokenUrl,iat:now,exp:now+3600
  });
  const assertion=claim+'.'+createSign('RSA-SHA256').update(claim).sign(account.private_key,'base64url');
  const token=await jsonRequest(tokenUrl,{method:'POST',body:new URLSearchParams({
    grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion
  })});
  const base='https://sheets.googleapis.com/v4/spreadsheets/'+sheetId;
  return (path,method='GET',body)=>jsonRequest(base+path,{
    method,headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)
  });
}

const range=(title,cells)=>encodeURIComponent("'"+title+"'!"+cells);
const metadata=(title,rows)=>rows.find(row=>row.properties.title===title)?.properties;
const slotFor=date=>slotNames[Math.floor(Date.parse(date)/86400000)%slotNames.length];
const aad=(title,date)=>Buffer.from('TrainerX/1/'+title+'/'+date);

export function encryptBackup(bytes,key,title,date){
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(aad(title,date));
  const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64');
}

export function decryptBackup(encoded,key,title,date){
  const archive=Buffer.from(encoded,'base64');
  const decipher=createDecipheriv('aes-256-gcm',key,archive.subarray(0,12));
  decipher.setAAD(aad(title,date));
  decipher.setAuthTag(archive.subarray(12,28));
  return Buffer.concat([decipher.update(archive.subarray(28)),decipher.final()]);
}

async function sheetTabs(sheet){
  const data=await sheet('?fields=sheets(properties(sheetId,title,gridProperties))');
  return data.sheets||[];
}

async function getManifest(sheet,title){
  const data=await sheet('/values/'+range(title,'A1'));
  try{return JSON.parse(data.values?.[0]?.[0]||'null')}catch{return null}
}

function putRows(sheet,title,row,values){
  return sheet('/values/'+range(title,'A'+row+':A'+(row+values.length-1))+'?valueInputOption=RAW','PUT',{values:values.map(value=>[value])});
}

export async function storeBackup(sheet,key,bytes,date){
  const title=slotFor(date);
  const tabs=await sheetTabs(sheet);
  const tab=metadata(title,tabs);
  const previous=tab?await getManifest(sheet,title):null;
  if(previous?.state==='complete'&&previous.date===date)return false;
  const encoded=encryptBackup(bytes,key,title,date);
  const chunks=[];
  for(let offset=0;offset<encoded.length;offset+=chunkSize)chunks.push(encoded.slice(offset,offset+chunkSize));
  const gridProperties={rowCount:chunks.length+1,columnCount:1};
  if(!tab){
    await sheet(':batchUpdate','POST',{requests:[{addSheet:{properties:{title,gridProperties}}}]});
  }
  const manifest={version:1,state:'pending',date,chunks:chunks.length};
  await putRows(sheet,title,1,[JSON.stringify(manifest)]);
  if(tab&&tab.gridProperties.rowCount!==gridProperties.rowCount){
    await sheet(':batchUpdate','POST',{requests:[{updateSheetProperties:{
      properties:{sheetId:tab.sheetId,gridProperties:{rowCount:gridProperties.rowCount}},
      fields:'gridProperties.rowCount'
    }}]});
  }
  for(let offset=0;offset<chunks.length;offset+=batchSize){
    await putRows(sheet,title,offset+2,chunks.slice(offset,offset+batchSize));
  }
  await putRows(sheet,title,1,[JSON.stringify({...manifest,state:'complete'})]);
  return true;
}

export async function loadBackup(sheet,key,date){
  const tabs=(await sheetTabs(sheet)).filter(tab=>slotNames.includes(tab.properties.title));
  const manifests=await Promise.all(tabs.map(async ({properties:{title}})=>({title,info:await getManifest(sheet,title)})));
  const latest=manifests.filter(({info})=>info?.version===1&&info.state==='complete'&&
    /^\d{4}-\d{2}-\d{2}$/.test(info.date)&&(!date||date===info.date))
    .sort((a,b)=>b.info.date.localeCompare(a.info.date))[0];
  if(!latest)throw new Error('No completed Google Sheets backup found');
  const {title,info}=latest;
  if(!Number.isInteger(info.chunks)||info.chunks<1||info.chunks>Math.ceil((maxDumpBytes+28)*4/3/chunkSize)+1)throw new Error('Invalid backup chunk count');
  const chunks=[];
  for(let start=0;start<info.chunks;start+=batchSize){
    const count=Math.min(batchSize,info.chunks-start);
    const result=await sheet('/values/'+range(title,'A'+(start+2)+':A'+(start+count+1)));
    if(result.values?.length!==count||result.values.some(row=>typeof row[0]!=='string'||!row[0]))throw new Error('Incomplete Google Sheets backup');
    chunks.push(...result.values.map(row=>row[0]));
  }
  return decryptBackup(chunks.join(''),key,title,info.date);
}

function databaseEnvironment(){
  if(!process.env.DATABASE_URL){
    return {...process.env,PGHOST:'db',PGUSER:'trainerx',PGDATABASE:'trainerx',PGPASSWORD:process.env.DB_PASSWORD};
  }
  const url=new URL(process.env.DATABASE_URL);
  const env={...process.env,PGHOST:url.hostname.replace(/^\[|\]$/g,''),PGPORT:url.port||'5432',
    PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),
    PGDATABASE:decodeURIComponent(url.pathname.slice(1))};
  for(const [key,variable] of Object.entries({
    sslmode:'PGSSLMODE',sslrootcert:'PGSSLROOTCERT',sslcert:'PGSSLCERT',sslkey:'PGSSLKEY',
    options:'PGOPTIONS',connect_timeout:'PGCONNECT_TIMEOUT'
  })){
    if(url.searchParams.has(key))env[variable]=url.searchParams.get(key);
  }
  return env;
}

async function backUp(db,date){
  const config=configuration();
  const client=await db.connect();
  let locked=false;
  try{
    const {rows:[row]}=await client.query('SELECT pg_try_advisory_lock($1) AS locked',[lockId]);
    locked=row.locked;
    if(!locked)return false;
    const sheet=await openSheet(config);
    const title=slotFor(date);
    const existing=metadata(title,await sheetTabs(sheet))?await getManifest(sheet,title):null;
    if(existing?.state==='complete'&&existing.date===date)return true;
    let archive;
    try{
      const {stdout}=await runFile('pg_dump',['--format=custom','--no-owner','--no-acl'],{
        env:databaseEnvironment(),encoding:'buffer',maxBuffer:maxDumpBytes,timeout:180000
      });
      archive=stdout;
    }catch(error){throw new Error('Postgres backup failed ('+(error.code||error.signal||'pg_dump')+')')}
    const written=await storeBackup(sheet,config.key,archive,date);
    if(written)console.log('Google Sheets database backup complete for '+date);
    return true;
  }finally{
    try{if(locked)await client.query('SELECT pg_advisory_unlock($1)',[lockId])}
    finally{client.release()}
  }
}

const today=()=>new Date().toISOString().slice(0,10);
export function startSheetsBackup(db){
  if(!process.env.GOOGLE_BACKUP_SHEET_ID)return;
  if(!process.env.GOOGLE_BACKUP_SERVICE_ACCOUNT||!process.env.GOOGLE_BACKUP_KEY){
    console.warn('Google Sheets backup is waiting for credentials and an encryption key');
    return;
  }
  let lastBackup;
  let running=false;
  async function tick(){
    const date=today();
    if(running||lastBackup===date)return;
    running=true;
    try{if(await backUp(db,date))lastBackup=date}
    catch(error){console.error('Google Sheets backup failed:',error.message)}
    finally{running=false}
  }
  setTimeout(tick,30000).unref();
  setInterval(tick,30*60000).unref();
}

async function main(){
  const [command,file,date]=process.argv.slice(2);
  if(command==='restore'&&file){
    const config=configuration();
    const archive=await loadBackup(await openSheet(config),config.key,date);
    await writeFile(file,archive,{mode:0o600,flag:'wx'});
    console.log('Decrypted Postgres archive written');
    return;
  }
  if(command==='run'){
    const db=new pg.Pool(process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:
      {host:'db',user:'trainerx',database:'trainerx',password:process.env.DB_PASSWORD});
    try{if(!await backUp(db,today()))throw new Error('A backup is already running')}
    finally{await db.end()}
    return;
  }
  throw new Error('Usage: node sheets-backup.mjs run | restore <archive-path> [YYYY-MM-DD]');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{console.error(error.message);process.exitCode=1});
}
