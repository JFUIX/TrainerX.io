import pg from 'pg';
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();
try{
 await db.query('BEGIN');
 await db.query('SELECT pg_advisory_xact_lock(82736419)');
 await db.query('CREATE TABLE IF NOT EXISTS app_data_resets (reset_key text PRIMARY KEY, performed_at timestamptz NOT NULL DEFAULT now())');
 const done=await db.query("SELECT 1 FROM app_data_resets WHERE reset_key='fresh-start-2026-11-21'");
 if(!done.rowCount){
  await db.query('TRUNCATE TABLE sessions, fee_payments, attendance, workout_plans, diet_plans, member_profiles, memberships, plans, users, gyms RESTART IDENTITY CASCADE');
  await db.query("INSERT INTO app_data_resets(reset_key) VALUES ('fresh-start-2026-11-21')");
  console.log('Fresh start completed: all gym and account records cleared');
 }else console.log('Fresh start already completed; no changes');
 await db.query('COMMIT');
}catch(e){await db.query('ROLLBACK');throw e}finally{await db.end()}
