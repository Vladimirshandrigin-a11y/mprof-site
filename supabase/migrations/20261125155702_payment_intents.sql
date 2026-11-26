-- DAY 5: one durable order/provider key per explicit checkout intent.
-- Additive: existing orders and paid rights are not rewritten.
begin;
create table public.payment_intents (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  subscription_id uuid not null unique references public.subscriptions(id) on delete restrict,
  plan text not null check (plan in ('single','unlimited')),
  provider_key uuid not null unique default gen_random_uuid(),
  provider_shop_id text not null,
  return_url text not null,
  first_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  provider_payment_id text unique,
  confirmation_url text,
  provider_status text check (provider_status in ('pending','waiting_for_capture','succeeded','canceled')),
  created_at timestamptz not null default now(),
  primary key(user_id,id)
);
alter table public.payment_intents enable row level security;
revoke all on public.payment_intents from public,anon,authenticated;
grant select,insert,update on public.payment_intents to service_role;

create or replace function public.claim_payment_intent(p_user_id uuid,p_intent_id uuid,p_plan text,p_site_url text,p_shop_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare i public.payment_intents%rowtype; s public.subscriptions%rowtype; sid uuid; at_time timestamptz;
begin
  if current_user <> 'service_role' then raise insufficient_privilege; end if;
  if p_user_id is null or p_intent_id is null or p_plan is null or p_plan not in ('single','unlimited')
    or p_shop_id is null or btrim(p_shop_id)='' or length(p_shop_id)>128
    or p_site_url is null or length(p_site_url)>2048 or p_site_url !~ '^https?://' then
    return jsonb_build_object('ok',false,'reason','bad_arguments');
  end if;
  -- Also serialize the initial INSERT: no orphan order can precede a unique-key conflict.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_intent_id::text,0));
  select * into i from public.payment_intents where user_id=p_user_id and id=p_intent_id for update;
  if not found then
    sid := gen_random_uuid();
    insert into public.subscriptions(id,user_id,plan,status,provider)
      values(sid,p_user_id,p_plan,'pending','yookassa');
    insert into public.payment_intents(user_id,id,subscription_id,plan,provider_shop_id,return_url)
      values(p_user_id,p_intent_id,sid,p_plan,p_shop_id,rtrim(p_site_url,'/')||'/app?payment=return&sub='||sid)
      returning * into i;
  end if;
  -- Provider keys are merchant-scoped: a shop/config change must not recreate payment.
  if i.plan<>p_plan or i.provider_shop_id<>p_shop_id then return jsonb_build_object('ok',false,'reason','intent_conflict'); end if;
  select * into s from public.subscriptions where id=i.subscription_id;
  if s.user_id<>p_user_id or s.plan<>i.plan or s.provider is distinct from 'yookassa'
    or (i.provider_payment_id is not null and s.provider_payment_id is distinct from i.provider_payment_id) then
    return jsonb_build_object('ok',false,'reason','intent_conflict');
  end if;
  -- A webhook can bind the order before the create response is received.
  if i.provider_payment_id is null and s.provider_payment_id is not null then
    update public.payment_intents set provider_payment_id=s.provider_payment_id where user_id=p_user_id and id=p_intent_id returning * into i;
  end if;
  if i.provider_payment_id is not null then
    return jsonb_build_object('ok',true,'action','lookup','subscription_id',i.subscription_id,'provider_payment_id',i.provider_payment_id);
  end if;
  at_time := clock_timestamp();
  -- Provider idempotency is only guaranteed for 24h. Stop BEFORE that boundary,
  -- retaining the same order forever until an operator/provider reconciles it.
  if i.first_attempt_at is not null and i.first_attempt_at<=at_time-interval '23 hours 55 minutes' then
    return jsonb_build_object('ok',true,'action','reconcile','subscription_id',i.subscription_id);
  end if;
  if i.lease_until>at_time then
    return jsonb_build_object('ok',true,'action','wait','subscription_id',i.subscription_id);
  end if;
  update public.payment_intents set first_attempt_at=coalesce(first_attempt_at,at_time),
    lease_token=gen_random_uuid(),lease_until=at_time+interval '60 seconds'
    where user_id=p_user_id and id=p_intent_id returning * into i;
  return jsonb_build_object('ok',true,'action','create','subscription_id',i.subscription_id,
    'provider_key',i.provider_key,'lease_token',i.lease_token,'return_url',i.return_url);
end $$;

create or replace function public.release_payment_intent(p_user_id uuid,p_intent_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
begin
  if current_user <> 'service_role' then raise insufficient_privilege; end if;
  update public.payment_intents set lease_until=clock_timestamp()
    where user_id=p_user_id and id=p_intent_id and lease_token=p_lease_token and provider_payment_id is null;
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.complete_payment_intent(p_user_id uuid,p_intent_id uuid,p_lease_token uuid,p_payment_id text,p_confirmation_url text,p_status text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare i public.payment_intents%rowtype; s public.subscriptions%rowtype;
begin
  if current_user <> 'service_role' then raise insufficient_privilege; end if;
  if p_payment_id is null or btrim(p_payment_id)='' or p_status is null or p_status not in ('pending','waiting_for_capture','succeeded','canceled') then
    return jsonb_build_object('ok',false,'reason','bad_arguments');
  end if;
  select * into i from public.payment_intents where user_id=p_user_id and id=p_intent_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','intent_not_found'); end if;
  if i.provider_payment_id is not null and i.provider_payment_id<>p_payment_id then
    return jsonb_build_object('ok',false,'reason','payment_mismatch');
  end if;
  if i.provider_payment_id is null and (p_lease_token is null or i.lease_token is distinct from p_lease_token) then
    return jsonb_build_object('ok',false,'reason','lease_lost');
  end if;
  select * into s from public.subscriptions where id=i.subscription_id for update;
  if s.user_id<>p_user_id or s.plan<>i.plan or s.provider is distinct from 'yookassa'
    or (s.provider_payment_id is not null and s.provider_payment_id<>p_payment_id) then
    return jsonb_build_object('ok',false,'reason','payment_mismatch');
  end if;
  -- Do not overwrite webhook activation/cancellation or grant any rights here.
  update public.subscriptions set provider_payment_id=coalesce(provider_payment_id,p_payment_id) where id=s.id;
  update public.payment_intents set provider_payment_id=p_payment_id,confirmation_url=p_confirmation_url,
    provider_status=p_status,lease_until=null where user_id=p_user_id and id=p_intent_id;
  return jsonb_build_object('ok',true);
end $$;

create table public.single_payment_activations (
  payment_id text primary key,
  subscription_id uuid not null unique references public.subscriptions(id) on delete restrict,
  user_id uuid not null,
  activated_at timestamptz not null default now()
);
alter table public.single_payment_activations enable row level security;
revoke all on public.single_payment_activations from public,anon,authenticated;
grant select,insert on public.single_payment_activations to service_role;

create or replace function public.grant_single_payment(p_subscription_id uuid,p_payment_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare s public.subscriptions%rowtype; a public.single_payment_activations%rowtype; activated timestamptz := now();
begin
  if current_user <> 'service_role' then raise insufficient_privilege; end if;
  if p_subscription_id is null or p_payment_id is null or btrim(p_payment_id)='' then return jsonb_build_object('ok',false,'reason','bad_arguments'); end if;
  select * into s from public.subscriptions where id=p_subscription_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','subscription_not_found'); end if;
  if s.plan<>'single' then return jsonb_build_object('ok',false,'reason','plan_mismatch'); end if;
  if s.provider is distinct from 'yookassa' or (s.provider_payment_id is not null and s.provider_payment_id<>p_payment_id) then
    return jsonb_build_object('ok',false,'reason','payment_mismatch');
  end if;
  select * into a from public.single_payment_activations where payment_id=p_payment_id or subscription_id=s.id;
  if found then
    if a.subscription_id<>s.id or a.payment_id<>p_payment_id then return jsonb_build_object('ok',false,'reason','payment_mismatch'); end if;
    return jsonb_build_object('ok',true,'granted',false,'reason','already_processed','status',s.status,'activated_at',a.activated_at);
  end if;
  -- Preserve pre-migration paid/expired rights; do not reissue legacy credit.
  if s.status in ('active','expired') then return jsonb_build_object('ok',true,'granted',false,'reason','already_processed_legacy','status',s.status,'activated_at',s.starts_at); end if;
  insert into public.single_payment_activations(payment_id,subscription_id,user_id,activated_at)
    values(p_payment_id,s.id,s.user_id,activated) on conflict do nothing;
  if not found then return jsonb_build_object('ok',false,'reason','payment_mismatch'); end if;
  update public.subscriptions set provider_payment_id=coalesce(provider_payment_id,p_payment_id),status='active',starts_at=activated,expires_at=null where id=s.id;
  return jsonb_build_object('ok',true,'granted',true,'status','active','activated_at',activated);
end $$;

create or replace function public.cancel_pending_payment(p_subscription_id uuid,p_payment_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare s public.subscriptions%rowtype;
begin
  if current_user <> 'service_role' then raise insufficient_privilege; end if;
  select * into s from public.subscriptions where id=p_subscription_id for update;
  if not found then return jsonb_build_object('ok',false,'reason','subscription_not_found'); end if;
  if p_payment_id is null or btrim(p_payment_id)='' or s.provider is distinct from 'yookassa'
    or (s.provider_payment_id is not null and s.provider_payment_id<>p_payment_id) then
    return jsonb_build_object('ok',false,'reason','payment_mismatch');
  end if;
  if s.status='pending' then
    update public.subscriptions set status='cancelled',provider_payment_id=coalesce(provider_payment_id,p_payment_id) where id=s.id;
    s.status := 'cancelled';
  end if;
  return jsonb_build_object('ok',true,'status',s.status,'subscriptionId',s.id);
end $$;

revoke all on function public.claim_payment_intent(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.release_payment_intent(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.complete_payment_intent(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.grant_single_payment(uuid,text) from public,anon,authenticated;
revoke all on function public.cancel_pending_payment(uuid,text) from public,anon,authenticated;
grant execute on function public.claim_payment_intent(uuid,uuid,text,text,text),public.release_payment_intent(uuid,uuid,uuid),public.complete_payment_intent(uuid,uuid,uuid,text,text,text),public.grant_single_payment(uuid,text),public.cancel_pending_payment(uuid,text) to service_role;
commit;
notify pgrst,'reload schema';
