// Explicit integration test: POSTGREST_BIN=/path/postgrest TEST_DATABASE_URL=... node --test this-file
// Requires a real local PostgREST binary; no HTTP adapter and no hosted Supabase.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { it } from 'node:test';
import { payTestEnv, read, runScript } from './helpers/pay-db.mjs';
const { freshDb } = payTestEnv();
const secret = 'local-postgrest-integration-only-0123456789abcdef';
function token(role) {
  const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const msg = `${b64({alg:'HS256',typ:'JWT'})}.${b64({role,exp:Math.floor(Date.now()/1000)+120})}`;
  return `${msg}.${createHmac('sha256',secret).update(msg).digest('base64url')}`;
}
async function poll(check, message) {
  for (let i=0;i<100;i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert.fail(message);
}
it('real PostgREST: missing RPC before migration, NOTIFY refreshes cache, service edit/replay works', async t => {
  assert.ok(process.env.POSTGREST_BIN,'POSTGREST_BIN is required; this check must not silently skip');
  const db = await freshDb({extraMigrations:['20260928_calculation_operations.sql','20260929_calculation_operations_manual_api.sql'].map(n=>read(`supabase/migrations/${n}`))});
  const u = await db.user();
  const client = await db.client('authenticated');
  await client.query("select set_config('request.jwt.claim.sub',$1,false)",[u]);
  const calculation = {marketplace:'ozon',revenue:1000,commission:100,logistics:10,ads:20,storage:0,tax:60,cost:200,other_expenses:10,total_expenses:400,profit:600,margin:60};
  const saved = (await client.query("select public.save_manual_calculation_operation($1,'manual:test',$2) as r",[randomUUID(),calculation])).rows[0].r;
  assert.equal(saved.ok,true);
  const listener = createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening');
  const port = listener.address().port; await new Promise(resolve=>listener.close(resolve));
  let logs = '';
  const server = spawn(process.env.POSTGREST_BIN,[],{env:{...process.env,
    PGRST_DB_URI:db.url,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',
    PGRST_JWT_SECRET:secret,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(port),
    PGRST_DB_CHANNEL:'pgrst',PGRST_DB_CHANNEL_ENABLED:'true',PGRST_LOG_LEVEL:'info',
  },stdio:['ignore','pipe','pipe']});
  let spawnError; server.on('error',e=>{spawnError=e;});
  server.stderr.on('data',chunk=>{logs+=chunk;});
  server.stdout.on('data',chunk=>{logs+=chunk;});
  t.after(async()=>{
    if (server.exitCode===null && !spawnError) { const exited=once(server,'exit'); server.kill('SIGTERM'); await exited; }
  });
  const base = `http://127.0.0.1:${port}`;
  await poll(async()=>{if(spawnError) throw spawnError;try{return (await fetch(base)).ok;}catch{return false;}},`PostgREST did not start: ${logs}`);
  const body = {p_user_id:u,p_calculation_id:saved.calculation_id,p_calculation:{...calculation,cost:250,total_expenses:450,profit:550,margin:55},p_history:null,p_expected_version:0,p_edit_operation_id:randomUUID()};
  const rpc = async role => {
    const res = await fetch(`${base}/rpc/edit_calculation_operation`,{method:'POST',headers:{authorization:`Bearer ${token(role)}`,'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:res.status,body:await res.json()};
  };
  const missing = await rpc('service_role');
  assert.deepEqual([missing.status,missing.body.code],[404,'PGRST202']);
  // Wait for LISTEN before running migration. There are no DDL refresh triggers in this DB.
  await poll(async()=> (await db.main.query("select 1 from pg_stat_activity where datname=current_database() and query ~* '^LISTEN'")).rowCount>0,`PostgREST notification listener not ready: ${logs}`);
  await runScript(db.main,read('supabase/migrations/20261113221918_quota_atomic_edits.sql'));
  let result;
  await poll(async()=>{ result=await rpc('service_role'); return result.status===200; },`RPC unavailable after NOTIFY: ${logs}`);
  assert.equal(result.body.ok,true); assert.equal(result.body.calculation.edit_version,1); assert.equal(result.body.calculation.profit,550);
  assert.equal((await rpc('service_role')).body.replay,true);
  assert.equal((await rpc('authenticated')).status,403);
  assert.equal((await rpc('anon')).status,401);
  assert.equal(Number((await db.main.query('select calculations_used from public.profiles where id=$1',[u])).rows[0].calculations_used),1);
  assert.equal((await db.main.query('select count(*)::int as n from public.calculation_edit_operations where user_id=$1',[u])).rows[0].n,1);
});
