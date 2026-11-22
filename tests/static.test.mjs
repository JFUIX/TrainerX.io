import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
test('backend parses as ECMAScript module',()=>{execFileSync(process.execPath,['--check','server.mjs'])});
test('browser script parses',()=>{const html=readFileSync('public/index.html','utf8');const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];assert.ok(script);new Function(script)});
test('docker image includes UI',()=>{const file=readFileSync('Dockerfile','utf8');assert.match(file,/COPY public \.\/public/)});
test('schema includes payments and training',()=>{const sql=readFileSync('schema.sql','utf8');for(const name of ['fee_payments','workout_plans','diet_plans'])assert.ok(sql.includes(name))});

test('only one executable browser script and one member enrollment form',()=>{const html=readFileSync('public/index.html','utf8');assert.equal((html.match(/<script>/g)||[]).length,1);assert.equal((html.match(/id="memberForm"/g)||[]).length,1);assert.equal((html.match(/id="setupForm"/g)||[]).length,1)});
test('Docker image includes database reset utility',()=>{const file=readFileSync('Dockerfile','utf8');assert.match(file,/COPY[^\n]*reset-once\.mjs/)});

test('plans and merged membership management are reachable',()=>{const html=readFileSync('public/index.html','utf8');assert.match(html,/if\(view==='Plans'\)/);assert.match(html,/if\(view==='Members'&&\['owner','reception'\]/);assert.doesNotMatch(html,/if\(view==='Memberships'\)/);assert.match(html,/id="membershipForm"/);assert.match(html,/,'planForm','Create plan'\)/);assert.match(html,/bind\('planForm',/)});
