-- DAY 5: one durable order/provider key per explicit checkout intent.
-- Additive: existing orders and paid rights are not rewritten.
begin;
create table public.payment_intents (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  subscription_id uuid not null unique references public.subscriptions(id) on delete cascade,
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
revoke all on public.payment_intents from public,anon,authenticated,service_role;
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
  subscription_id uuid not null unique references public.subscriptions(id) on delete cascade,
  user_id uuid not null,
  activated_at timestamptz not null default now()
);
alter table public.single_payment_activations enable row level security;
revoke all on public.single_payment_activations from public,anon,authenticated,service_role;
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

-- Record only refunds confirmed by the provider. A review outcome is durable
-- even after YooKassa has acknowledged the notification.
create table public.payment_refunds (
  refund_id text primary key,
  payment_id text not null,
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  amount_kopecks integer not null check (amount_kopecks > 0),
  is_full boolean not null,
  outcome text not null check (outcome in (
    'revoked_single', 'revoked_unlimited', 'blocked_pending', 'already_refunded', 'already_expired',
    'review_partial', 'review_single_usage', 'review_unlimited_attribution'
  )),
  recorded_at timestamptz not null default now()
);
create index payment_refunds_full_payment_idx on public.payment_refunds(payment_id) where is_full;
create index payment_refunds_subscription_idx on public.payment_refunds(subscription_id);
alter table public.payment_refunds enable row level security;
revoke all on public.payment_refunds from public, anon, authenticated, service_role;
grant select, insert on public.payment_refunds to service_role;

create function public.apply_payment_refund(
  p_refund_id text, p_subscription_id uuid, p_payment_id text,
  p_amount_kopecks integer, p_is_full boolean
) returns jsonb language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare
  sub public.subscriptions%rowtype;
  prof public.profiles%rowtype;
  act public.payment_activations%rowtype;
  existing public.payment_refunds%rowtype;
  price integer;
  decision text;
begin
  if current_user <> 'service_role' then raise insufficient_privilege; end if;
  if nullif(btrim(p_refund_id),'') is null or length(p_refund_id)>128
    or nullif(btrim(p_payment_id),'') is null or length(p_payment_id)>128
    or p_amount_kopecks is null or p_amount_kopecks<=0 or p_is_full is null then
    return jsonb_build_object('ok',false,'reason','bad_arguments');
  end if;

  -- The grant path locks this row first too. Lock the profile second when
  -- reading usage or shortening unlimited, as the consume/grant paths do.
  select * into sub from public.subscriptions where id=p_subscription_id for update;
  if not found or sub.provider is distinct from 'yookassa'
    or (sub.provider_payment_id is not null and sub.provider_payment_id<>p_payment_id)
    or (sub.provider_payment_id is null and sub.status in ('active','expired')) then
    return jsonb_build_object('ok',false,'reason','payment_mismatch');
  end if;
  price := case sub.plan when 'single' then 14900 when 'unlimited' then 44900 end;
  if price is null or p_amount_kopecks>price or p_is_full is distinct from (p_amount_kopecks=price) then
    return jsonb_build_object('ok',false,'reason','amount_mismatch');
  end if;
  select * into existing from public.payment_refunds where refund_id=p_refund_id;
  if found then
    if (existing.payment_id, existing.subscription_id, existing.amount_kopecks, existing.is_full)
      is distinct from (p_payment_id, sub.id, p_amount_kopecks, p_is_full) then
      return jsonb_build_object('ok',false,'reason','refund_mismatch');
    end if;
    return jsonb_build_object('ok',true,'outcome',existing.outcome);
  end if;

  if not p_is_full then
    decision := 'review_partial';
  elsif exists (select 1 from public.payment_refunds where payment_id=p_payment_id and is_full) then
    decision := 'already_refunded';
  elsif sub.status in ('pending','cancelled','failed') then
    update public.subscriptions set status='cancelled',provider_payment_id=p_payment_id where id=sub.id;
    decision := 'blocked_pending';
  else
    select * into prof from public.profiles where id=sub.user_id for update;
    if sub.plan='single' then
      -- Usage is aggregate. The first use is free, so zero or one total use
      -- proves this credit is still whole. After that we cannot attribute it.
      if sub.status='active' and sub.starts_at is not null and sub.expires_at is null
        and prof.calculations_used between 0 and 1 then
        update public.subscriptions set status='cancelled' where id=sub.id;
        decision := 'revoked_single';
      else
        decision := 'review_single_usage';
      end if;
    else
      select * into act from public.payment_activations
       where payment_id=p_payment_id and subscription_id=sub.id and user_id=sub.user_id;
      if act.premium_until_after<=clock_timestamp() then
        decision := 'already_expired';
      elsif sub.status='active' and prof.plan='unlimited'
        and sub.expires_at=act.premium_until_after and prof.premium_until=act.premium_until_after
        and act.premium_until_after=greatest(act.premium_until_before,act.activated_at)+interval '30 days'
        and not exists (
          select 1 from public.subscriptions other where other.user_id=sub.user_id and other.id<>sub.id
           and other.plan='unlimited' and other.status='active'
           and other.expires_at>greatest(act.premium_until_before,clock_timestamp())
        ) then
        -- Only the tail can be removed without changing any other payment's term.
        perform set_config('mprof.unlimited_grant','on',true);
        update public.profiles set premium_until=act.premium_until_before where id=sub.user_id;
        update public.subscriptions set status='cancelled' where id=sub.id;
        perform set_config('mprof.unlimited_grant','',true);
        decision := 'revoked_unlimited';
      else
        decision := 'review_unlimited_attribution';
      end if;
    end if;
  end if;

  insert into public.payment_refunds(refund_id,payment_id,subscription_id,amount_kopecks,is_full,outcome)
    values(p_refund_id,p_payment_id,sub.id,p_amount_kopecks,p_is_full,decision);
  return jsonb_build_object('ok',true,'outcome',decision);
end $$;

-- Prevent a delayed payment.succeeded from issuing a fully refunded payment.
-- The subscription trigger also fences the previous single-credit handler.
create function public.prevent_refunded_payment_grant()
returns trigger language plpgsql security invoker set search_path=pg_catalog,pg_temp as $$
declare payment text;
begin
  if current_user <> 'service_role' then return new; end if;
  if tg_table_name='subscriptions' then
    if new.status<>'active' or old.status='active' then return new; end if;
    payment := new.provider_payment_id;
  else
    payment := new.payment_id;
  end if;
  if exists (select 1 from public.payment_refunds where payment_id=payment and is_full) then
    return null;
  end if;
  return new;
end $$;
create trigger prevent_refunded_single_receipt before insert on public.single_payment_activations
  for each row execute function public.prevent_refunded_payment_grant();
create trigger prevent_refunded_unlimited_receipt before insert on public.payment_activations
  for each row execute function public.prevent_refunded_payment_grant();
create trigger prevent_refunded_legacy_grant before update of status on public.subscriptions
  for each row execute function public.prevent_refunded_payment_grant();
revoke all on function public.apply_payment_refund(text,uuid,text,integer,boolean),
  public.prevent_refunded_payment_grant() from public, anon, authenticated, service_role;
grant execute on function public.apply_payment_refund(text,uuid,text,integer,boolean) to service_role;
commit;
notify pgrst,'reload schema';
