import pg from 'pg';
import {readFileSync} from 'node:fs';
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
try {
 await client.query('BEGIN');
 await client.query('SELECT pg_advisory_xact_lock(745193)');
 await client.query('CREATE TABLE IF NOT EXISTS app_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
 const done=await client.query("SELECT 1 FROM app_schema_migrations WHERE name='initial_schema'");
 if(!done.rowCount){
  await client.query(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  await client.query("INSERT INTO app_schema_migrations(name) VALUES('initial_schema')");
 }
 await client.query(readFileSync(new URL('./migrations/004-member-profiles.sql',import.meta.url),'utf8'));
 const operations = '005-gym-operations.sql';
 const applied = await client.query('SELECT 1 FROM app_schema_migrations WHERE name=$1',[operations]);
 if (!applied.rowCount) {
  await client.query(readFileSync(new URL('./migrations/'+operations,import.meta.url),'utf8'));
  await client.query('INSERT INTO app_schema_migrations(name) VALUES($1)',[operations]);
 }
 await client.query('COMMIT');
 console.log('Database schema ready');
} catch(err){await client.query('ROLLBACK');throw err} finally {await client.end()}
