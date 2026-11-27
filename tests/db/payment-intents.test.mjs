// Durable checkout through the real route -> supabase-js -> isolated PostgreSQL.
// Provider requests are deterministically simulated; all other network is denied.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, describe, it } from 'node:test';
import { buildRequire, payTestEnv, read, runScript } from './helpers/pay-db.mjs';
import { installFetch, userJwt, SERVICE_KEY, SUPABASE_URL } from './helpers/fetch-stub.mjs';
process.env.YOOKASSA_SHOP_ID='test-shop';process.env.YOOKASSA_SECRET_KEY='test-secret';
process.env.NEXT_PUBLIC_SUPABASE_URL=SUPABASE_URL;process.env.SUPABASE_SERVICE_ROLE_KEY=SERVICE_KEY;
process.env.NEXT_PUBLIC_SITE_URL='https://mprof.test';
const CREATE=buildRequire('./api/payment/create/route.js');
const migration=read('supabase/migrations/20261125155702_payment_intents.sql');
const {freshDb}=payTestEnv();const net=installFetch();after(()=>net.restore());
let db,payments,postCount,loseProviderResponse;
const providerResponse=p=>new Response(JSON.stringify(p),{status:200,headers:{'content-type':'application/json'}});
const create=async(user,plan='single',intentId=randomUUID())=>{
 const r=await CREATE.POST(new Request('http://localhost/api/payment/create',{method:'POST',headers:{'content-type':'application/json',...(user?{authorization:'Bearer '+userJwt(user)}:{})},body:JSON.stringify({plan,intentId})}));
 return{status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};
};
const counts=async()=> (await db.main.query("select (select count(*)::int from public.subscriptions) as orders,(select count(*)::int from public.payment_intents) as intents")).rows[0];
const call=async(sql,args=[],role='service_role')=>{const c=await db.client(role);return (await c.query(sql,args)).rows[0]?.r;};
beforeEach(async()=>{
 process.env.YOOKASSA_SHOP_ID='test-shop';
 db=await freshDb({extraMigrations:[migration]});net.reset();net.state.pool=db.pool(20);payments=new Map();postCount=0;loseProviderResponse=false;
 net.state.yookassa=async(id,req)=>{
  if(req.method==='POST'){
   postCount++;const key=req.headers['idempotence-key'];assert.ok(key);
   let p=payments.get(key);
   if(!p){p={id:'pay-'+randomUUID(),status:'pending',paid:false,amount:req.body.amount,metadata:req.body.metadata,confirmation:{confirmation_url:'https://yoomoney.ru/checkout/'+randomUUID()}};payments.set(key,p);}
   if(loseProviderResponse){loseProviderResponse=false;throw new TypeError('response lost after provider commit');}
   return providerResponse(p);
  }
  const p=[...payments.values()].find(p=>p.id===id);return p?providerResponse(p):new Response('{}',{status:404});
 };
});
describe('DAY5 durable payment intents',()=>{
 for(const [plan,amount]of[['single',149],['unlimited',449]])it(`${plan}: one server-priced payment and stable replay`,async()=>{
  const u=await db.user(),intent=randomUUID();const a=await create(u,plan,intent),b=await create(u,plan,intent);
  assert.equal(a.status,200);assert.equal(a.body.amount,amount);assert.equal(a.body.subscriptionId,b.body.subscriptionId);assert.equal(a.body.confirmationUrl,b.body.confirmationUrl);
  assert.equal(a.cache,'no-store');assert.equal(postCount,1);assert.equal(payments.size,1);assert.deepEqual(await counts(),{orders:1,intents:1});
  const request=net.state.log.find(r=>r.url==='https://api.yookassa.ru/v3/payments'&&r.method==='POST');
  assert.deepEqual(request.body.amount,{value:amount+'.00',currency:'RUB'});assert.equal(request.body.capture,true);assert.equal(request.body.save_payment_method,undefined);
 });
 it('parallel double click creates one order/payment; second request waits on a fenced lease',async()=>{
  const u=await db.user(),id=randomUUID();const results=await Promise.all([create(u,'single',id),create(u,'single',id),create(u,'single',id)]);
  assert.ok(results.some(r=>r.status===200));assert.ok(results.every(r=>[200,202].includes(r.status)));assert.equal(postCount,1);assert.deepEqual(await counts(),{orders:1,intents:1});
 });
 it('lost M-PROF response recovers the persisted payment without another provider POST',async()=>{
  const u=await db.user(),id=randomUUID();await create(u,'single',id);const retry=await create(u,'single',id);
  assert.equal(retry.status,200);assert.equal(postCount,1);assert.deepEqual(await counts(),{orders:1,intents:1});
 });
 it('lost provider response reuses the same order, body and Idempotence-Key',async()=>{
  const u=await db.user(),id=randomUUID();loseProviderResponse=true;
  assert.equal((await create(u,'single',id)).status,502);const retry=await create(u,'single',id);assert.equal(retry.status,200);
  assert.equal(postCount,2);assert.equal(payments.size,1);assert.deepEqual(await counts(),{orders:1,intents:1});
  const calls=net.state.log.filter(r=>r.method==='POST'&&r.url==='https://api.yookassa.ru/v3/payments');assert.equal(calls[0].headers['idempotence-key'],calls[1].headers['idempotence-key']);assert.deepEqual(calls[0].body,calls[1].body);
 });
 it('lost complete COMMIT response replays bound payment and never issues a new POST',async()=>{
  const u=await db.user(),id=randomUUID();let lost=false;net.state.dropAfterCommit=req=>req.path==='/rest/v1/rpc/complete_payment_intent'&&!lost&&(lost=true);
  assert.equal((await create(u,'single',id)).status,503);net.state.dropAfterCommit=null;
  assert.equal((await create(u,'single',id)).status,200);assert.equal(postCount,1);assert.equal(payments.size,1);
 });
 it('unknown outcome outside 24h fails closed and never contacts provider creation',async()=>{
  const u=await db.user(),id=randomUUID();loseProviderResponse=true;await create(u,'single',id);
  await db.main.query("update public.payment_intents set first_attempt_at=now()-interval '25 hours',lease_until=now()-interval '1 hour' where user_id=$1 and id=$2",[u,id]);
  const retry=await create(u,'single',id);assert.deepEqual([retry.status,retry.body.code],[409,'reconciliation_required']);assert.equal(postCount,1);assert.deepEqual(await counts(),{orders:1,intents:1});
 });
 it('known payment is reused beyond the provider idempotency window',async()=>{
  const u=await db.user(),id=randomUUID();const first=await create(u,'single',id);
  await db.main.query("update public.payment_intents set first_attempt_at=now()-interval '3 days' where user_id=$1 and id=$2",[u,id]);
  const retry=await create(u,'single',id);assert.equal(retry.status,200);assert.equal(retry.body.subscriptionId,first.body.subscriptionId);assert.equal(postCount,1);
 });
 it('changing plan for the same intent is rejected without a new order/payment',async()=>{
  const u=await db.user(),id=randomUUID();await create(u,'single',id);const r=await create(u,'unlimited',id);
  assert.deepEqual([r.status,r.body.code],[409,'intent_conflict']);assert.equal(postCount,1);assert.deepEqual(await counts(),{orders:1,intents:1});
 });
 it('canceled intent remains terminal; a new deliberate intent permits a new purchase',async()=>{
  const u=await db.user(),id=randomUUID();const a=await create(u,'single',id);[...payments.values()][0].status='canceled';
  const r=await create(u,'single',id);assert.deepEqual([r.status,r.body.code],[409,'payment_canceled']);assert.equal(postCount,1);
  const b=await create(u,'single',randomUUID());assert.equal(b.status,200);assert.notEqual(a.body.subscriptionId,b.body.subscriptionId);assert.equal(postCount,2);
 });
 it('succeeded payment replay reports completion but does not activate rights from redirect/create',async()=>{
  const u=await db.user(),id=randomUUID();const a=await create(u,'single',id);const p=[...payments.values()][0];p.status='succeeded';p.paid=true;
  const r=await create(u,'single',id);assert.deepEqual([r.status,r.body.code],[200,'payment_succeeded']);assert.equal(r.body.confirmationUrl,undefined);
  assert.equal((await db.subRow(a.body.subscriptionId)).status,'pending');assert.equal(postCount,1);
 });
 it('browser roles cannot call service RPCs or read the private intent table',async()=>{
  const u=await db.user(),id=randomUUID();await create(u,'single',id);
  for(const role of['anon','authenticated']){
   await assert.rejects(call("select public.claim_payment_intent($1,$2,'single','https://mprof.test','test-shop') as r",[u,id],role),{code:'42501'});
   const c=await db.client(role);await assert.rejects(c.query('select * from public.payment_intents'),{code:'42501'});
  }
 });
 it('one user cannot complete another user intent; same UUID in two accounts stays isolated',async()=>{
  const u=await db.user(),other=await db.user(),id=randomUUID();const a=await create(u,'single',id);
  assert.equal((await call("select public.complete_payment_intent($1,$2,null,'spoof',null,'pending') as r",[other,id])).reason,'intent_not_found');
  const b=await create(other,'single',id);assert.notEqual(a.body.subscriptionId,b.body.subscriptionId);assert.equal(postCount,2);
 });
 it('lease renewal fences a delayed response but preserves its stable provider key',async()=>{
  const u=await db.user(),id=randomUUID();const claim=()=>call("select public.claim_payment_intent($1,$2,'single','https://mprof.test','test-shop') as r",[u,id]);
  const a=await claim();assert.equal((await claim()).action,'wait');
  await db.main.query("update public.payment_intents set lease_until=now()-interval '1 second' where user_id=$1 and id=$2",[u,id]);
  const b=await claim();assert.equal(a.provider_key,b.provider_key);assert.notEqual(a.lease_token,b.lease_token);
  assert.equal((await call("select public.complete_payment_intent($1,$2,$3,'late',null,'pending') as r",[u,id,a.lease_token])).reason,'lease_lost');
 });
 it('invalid or unauthenticated create never creates an order',async()=>{
  const u=await db.user();assert.equal((await create(u,'single','not-a-uuid')).status,400);assert.equal((await create(null)).status,401);assert.deepEqual(await counts(),{orders:0,intents:0});assert.equal(postCount,0);
 });
 it('webhook-first binding recovers even when local provider-create result was lost',async()=>{
  const u=await db.user(),id=randomUUID();loseProviderResponse=true;await create(u,'single',id);const p=[...payments.values()][0];
  await db.main.query('update public.subscriptions set provider_payment_id=$1 where id=$2',[p.id,p.metadata.subscription_id]);
  await db.main.query("update public.payment_intents set first_attempt_at=now()-interval '25 hours' where user_id=$1 and id=$2",[u,id]);
  assert.equal((await create(u,'single',id)).status,200);assert.equal(postCount,1);
 });

 it('merchant change cannot reuse an intent to create a second provider payment',async()=>{
  const u=await db.user(),id=randomUUID();const a=await create(u,'single',id);
  process.env.YOOKASSA_SHOP_ID='different-shop';const blocked=await create(u,'single',id);
  assert.deepEqual([blocked.status,blocked.body.code],[409,'intent_conflict']);assert.equal(postCount,1);assert.deepEqual(await counts(),{orders:1,intents:1});
  process.env.YOOKASSA_SHOP_ID='test-shop';assert.equal((await create(u,'single',id)).body.subscriptionId,a.body.subscriptionId);
 });
 it('missing migration fails closed before creating any order or contacting provider',async()=>{
  const old=await freshDb();net.state.pool=old.pool(3);const u=await old.user();
  const r=await create(u);assert.deepEqual([r.status,r.body.code],[503,'payment_intent_unavailable']);assert.equal(postCount,0);
  assert.equal((await old.main.query('select count(*)::int as n from public.subscriptions')).rows[0].n,0);
 });
 it('additive migration preserves all old pending/paid orders and paid rights; old clients fail closed',async()=>{
  const old=await freshDb();const u=await old.user({premium:'10 days',plan:'unlimited'});
  await old.sub(u,'single',{status:'active'});await old.sub(u,'unlimited',{status:'pending'});
  const snapshot=async()=>JSON.stringify([(await old.main.query('select * from public.subscriptions order by id')).rows,await old.profile(u)]);
  const before=await snapshot();await runScript(old.main,migration);assert.equal(await snapshot(),before);
  net.state.pool=old.pool(3);const r=await CREATE.POST(new Request('http://localhost/api/payment/create',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+userJwt(u)},body:JSON.stringify({plan:'single'})}));
  assert.equal(r.status,400);assert.equal(await snapshot(),before);assert.equal(postCount,0);
 });
 it('provider response with mismatching order metadata never binds or redirects',async()=>{
  const u=await db.user();net.state.yookassa=()=>providerResponse({id:'bad-provider-response',status:'pending',paid:false,amount:{value:'149.00',currency:'RUB'},metadata:{subscription_id:randomUUID(),plan:'single',intent_id:randomUUID()},confirmation:{confirmation_url:'https://yoomoney.ru/pay'}});
  assert.deepEqual((({status,body})=>[status,body.code])(await create(u)),[502,'payment_binding_mismatch']);
  assert.equal((await db.main.query('select provider_payment_id from public.subscriptions')).rows[0].provider_payment_id,null);
 });
});
