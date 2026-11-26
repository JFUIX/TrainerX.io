import {createHash} from 'node:crypto';
import {openSheet} from './sheets-backup.mjs';

const title='TrainerX.io Readable Data';
const width=9;
const intervals=5*60_000;
const membershipNumber="COALESCE(mp.membership_no::text,m.member_id::text)";
const sections=[
  ['Members',['Member ID','Name','Account status','Joined on'],
    `SELECT COALESCE(mp.membership_no::text,u.id::text),mp.full_name,
      CASE WHEN u.active THEN 'Active' ELSE 'Inactive' END,mp.joined_on::text
      FROM users u LEFT JOIN member_profiles mp ON mp.gym_id=u.gym_id AND mp.user_id=u.id
      WHERE u.gym_id=$1 AND u.role='member' ORDER BY mp.membership_no NULLS LAST,u.id`],
  ['Memberships',['Member ID','Plan','Starts','Ends','Cancelled','Price','Paid','Balance','Membership ID'],
    `SELECT ${membershipNumber},p.name,m.starts_on::text,m.ends_on::text,m.cancelled_on::text,
      COALESCE(m.total_price,p.price)::float8,paid.total::float8,
      GREATEST(COALESCE(m.total_price,p.price)-paid.total,0)::float8,m.id::text
      FROM memberships m JOIN plans p ON p.gym_id=m.gym_id AND p.id=m.plan_id
      LEFT JOIN member_profiles mp ON mp.gym_id=m.gym_id AND mp.user_id=m.member_id
      CROSS JOIN LATERAL (SELECT COALESCE(sum(amount),0) AS total FROM fee_payments
        WHERE gym_id=m.gym_id AND membership_id=m.id) paid
      WHERE m.gym_id=$1 ORDER BY m.starts_on DESC,m.id`],
  ['Plans',['Plan','Months','Price','Plan ID'],
    'SELECT name,months,price::float8,id::text FROM plans WHERE gym_id=$1 ORDER BY months,name,id'],
  ['Payments',['Member ID','Paid at','Billing month','Method','Amount','Receipt ID','Membership ID'],
    `SELECT ${membershipNumber},to_char(f.paid_at AT TIME ZONE gym_timezone($1),'YYYY-MM-DD HH24:MI'),
      to_char(f.billing_month,'YYYY-MM'),replace(f.method,'_',' '),f.amount::float8,f.id::text,m.id::text
      FROM fee_payments f JOIN memberships m ON m.gym_id=f.gym_id AND m.id=f.membership_id
      LEFT JOIN member_profiles mp ON mp.gym_id=m.gym_id AND mp.user_id=m.member_id
      WHERE f.gym_id=$1 ORDER BY f.paid_at DESC,f.id`],
  ['Expenses',['Date','Category','Amount','Expense ID'],
    'SELECT incurred_on::text,category,amount::float8,id::text FROM gym_expenses WHERE gym_id=$1 ORDER BY incurred_on DESC,id'],
  ['Attendance',['Member ID','Check-in time'],
    `SELECT COALESCE(mp.membership_no::text,a.member_id::text),
      to_char(a.checked_at AT TIME ZONE gym_timezone($1),'YYYY-MM-DD HH24:MI')
      FROM attendance a LEFT JOIN member_profiles mp ON mp.gym_id=a.gym_id AND mp.user_id=a.member_id
      WHERE a.gym_id=$1 ORDER BY a.checked_at DESC,a.member_id`],
  ['Membership freezes',['Member ID','Starts','Ends','Record'],
    `SELECT COALESCE(mp.membership_no::text,f.member_id::text),f.starts_on::text,f.ends_on::text,f.record
      FROM (SELECT gym_id,member_id,starts_on,ends_on,'Current record' AS record FROM member_freezes
        UNION ALL SELECT gym_id,member_id,starts_on,ends_on,'History' FROM member_freeze_history) f
      LEFT JOIN member_profiles mp ON mp.gym_id=f.gym_id AND mp.user_id=f.member_id
      WHERE f.gym_id=$1 ORDER BY f.starts_on DESC,f.member_id`],
  ['Training',['Member ID','Type','Program','Updated at','Plan ID'],
    `SELECT COALESCE(mp.membership_no::text,p.member_id::text),p.kind,p.title,
      to_char(p.updated_at AT TIME ZONE gym_timezone($1),'YYYY-MM-DD HH24:MI'),p.id::text
      FROM (SELECT id,gym_id,member_id,title,updated_at,'Workout' AS kind FROM workout_plans
        UNION ALL SELECT id,gym_id,member_id,title,updated_at,'Diet' FROM diet_plans) p
      LEFT JOIN member_profiles mp ON mp.gym_id=p.gym_id AND mp.user_id=p.member_id
      WHERE p.gym_id=$1 ORDER BY p.updated_at DESC,p.id`]
];

async function snapshot(db,gymName){
  const client=await db.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const {rows}=await client.query('SELECT id,name,currency,timezone FROM gyms WHERE lower(btrim(name))=lower($1)',[gymName]);
    if(rows.length!==1)throw new Error('Expected exactly one gym matching the configured name');
    const gym=rows[0],tables=[];
    for(const [name,headers,sql] of sections){
      const {rows:data}=await client.query({text:sql,values:[gym.id],rowMode:'array'});
      tables.push({name,headers,data});
    }
    await client.query('COMMIT');
    return {gym,tables};
  }catch(error){
    await client.query('ROLLBACK');
    throw error;
  }finally{client.release()}
}

const colors={
  navy:{red:.11,green:.18,blue:.28},
  teal:{red:.06,green:.36,blue:.38},
  white:{red:1,green:1,blue:1},
  soft:{red:.93,green:.96,blue:.98},
  ink:{red:.11,green:.17,blue:.25}
};
function row(values,kind,index=0){
  const heading=['title','section','headers'].includes(kind);
  const backgroundColor=kind==='title'?colors.navy:kind==='section'?colors.teal:
    kind==='headers'||index%2===1?colors.soft:colors.white;
  return {values:Array.from({length:width},(_,column)=>{
    const value=values[column];
    return {
      userEnteredFormat:{backgroundColor,verticalAlignment:'MIDDLE',
        wrapStrategy:'WRAP',textFormat:{fontFamily:'Arial',fontSize:kind==='title'?15:10,
          bold:heading,foregroundColor:kind==='title'||kind==='section'?colors.white:colors.ink}},
      ...(value==null?{}:{userEnteredValue:typeof value==='number'?{numberValue:value}:{stringValue:String(value)}})
    };
  })};
}

export async function writeReadableSnapshot(sheet,sheetId,{gym,tables},now=new Date()){
  const meta=await sheet('?fields=sheets(properties(sheetId,title,gridProperties))');
  const properties=meta.sheets?.find(tab=>tab.properties.sheetId===sheetId)?.properties;
  if(properties?.title!==title)throw new Error('The configured tab does not match '+title);
  const range=encodeURIComponent("'"+title+"'");
  const preview=await sheet('/values/'+range+'!A1:A2');
  if(preview.values?.[0]?.[0]!==title||preview.values?.[1]?.[0]!=='Managed by TrainerX'){
    const existing=await sheet('/values/'+range);
    const occupied=existing.values?.some((row,i)=>row.some((value,j)=>value!==''&&!(i===0&&j===0&&value===title)));
    if(occupied)throw new Error('The target tab already has content. Sync requires a blank tab.');
  }
  const updated=new Intl.DateTimeFormat('en-GB',{timeZone:gym.timezone,dateStyle:'medium',timeStyle:'short'}).format(now);
  const rows=[row([title],'title'),row(['Managed by TrainerX',gym.name,'Currency',gym.currency]),
    row(['Last synced',updated,'Time zone',gym.timezone])];
  const lookup=name=>tables.find(table=>table.name===name)?.data??[];
  const revenue=lookup('Payments').reduce((sum,record)=>sum+Math.round(record[4]*100),0);
  const expenses=lookup('Expenses').reduce((sum,record)=>sum+Math.round(record[2]*100),0);
  rows.push(row([]),row(['Overview'],'section'),row(['Members','Check-ins','Revenue','Expenses','Net'],'headers'),
    row([lookup('Members').length,lookup('Attendance').length,revenue/100,expenses/100,(revenue-expenses)/100]));
  for(const table of tables){
    rows.push(row([]),row([table.name,table.data.length,'Records'],'section'),row(table.headers,'headers'));
    if(!table.data.length)rows.push(row(['No records']));
    table.data.forEach((values,index)=>rows.push(row(values,'data',index)));
  }
  const rowCount=Math.max(properties.gridProperties.rowCount,rows.length);
  const columnCount=Math.max(properties.gridProperties.columnCount,width);
  await sheet(':batchUpdate','POST',{requests:[
    {updateSheetProperties:{properties:{sheetId,gridProperties:{rowCount,columnCount,frozenRowCount:3}},
      fields:'gridProperties(rowCount,columnCount,frozenRowCount)'}},
    {updateDimensionProperties:{range:{sheetId,dimension:'COLUMNS',startIndex:0,endIndex:width},
      properties:{pixelSize:165},fields:'pixelSize'}},
    {updateCells:{range:{sheetId,startRowIndex:0,endRowIndex:rowCount,startColumnIndex:0,endColumnIndex:width},
      rows,fields:'userEnteredValue,userEnteredFormat'}}
  ]});
}

export function startReadableSheet(db){
  const {GOOGLE_READABLE_SHEET_ID:book,GOOGLE_READABLE_TAB_ID:tab,GOOGLE_READABLE_GYM:gymName,
    GOOGLE_BACKUP_SERVICE_ACCOUNT:credentials}=process.env;
  if(!book)return;
  if(!/^[\w-]+$/.test(book)||!/^\d+$/.test(tab||'')||!gymName?.trim()||!credentials){
    console.error('Readable Sheets sync configuration is incomplete');
    return;
  }
  let busy=false,lastHash;
  async function tick(){
    if(busy)return;
    busy=true;
    try{
      const data=await snapshot(db,gymName.trim());
      const hash=createHash('sha256').update(JSON.stringify(data)).digest('hex');
      if(hash===lastHash)return;
      const sheet=await openSheet({sheetId:book,account:JSON.parse(credentials)});
      await writeReadableSnapshot(sheet,Number(tab),data);
      lastHash=hash;
      console.log('Readable Sheets sync complete. '+data.tables.reduce((sum,table)=>sum+table.data.length,0)+' rows.');
    }catch(error){
      console.error('Readable Sheets sync failed:',error.code||error.message);
    }finally{busy=false}
  }
  void tick();
  setInterval(tick,intervals).unref();
}
