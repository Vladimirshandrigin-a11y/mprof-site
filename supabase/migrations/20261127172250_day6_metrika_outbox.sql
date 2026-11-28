begin;

create table public.metrika_consent (
  user_id uuid primary key references auth.users(id) on delete cascade,
  client_id text not null check (client_id ~ '^[1-9][0-9]{0,18}$'),
  recorded_at timestamptz not null default now()
);
create index metrika_consent_client on public.metrika_consent(client_id);
alter table public.metrika_consent enable row level security;
revoke all on public.metrika_consent from public, anon, authenticated, service_role;

create table public.metrika_revoked_clients (
  client_id text primary key check (client_id ~ '^[1-9][0-9]{0,18}$')
);
alter table public.metrika_revoked_clients enable row level security;
revoke all on public.metrika_revoked_clients from public, anon, authenticated, service_role;
grant select on public.metrika_revoked_clients to service_role;

create table public.metrika_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null,
  client_id text not null check (client_id ~ '^[1-9][0-9]{0,18}$'),
  name text not null check (name in ('registration_confirmed','first_free_calculation','checkout_started',
    'payment_confirmed','purchase_149','subscription_449','subscription_renewed','payment_failed')),
  plan text check (plan in ('single','unlimited')),
  occurred_at timestamptz not null,
  state text not null default 'ready' check (state in ('ready','sending','sent','uncertain','rejected','expired','revoked')),
  external_id text unique check (external_id ~ '^[0-9a-f]{64}$'),
  unique (source_id, name)
);
create index metrika_events_pending on public.metrika_events(occurred_at) where state='ready';
alter table public.metrika_events enable row level security;
revoke all on public.metrika_events from public, anon, authenticated, service_role;
grant select, update on public.metrika_events to service_role;

create function public.register_metrika_consent(p_user_id uuid, p_client_id text, p_signup_confirmed_at timestamptz)
returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('metrika:'||p_client_id,0));
  if exists (select 1 from public.metrika_revoked_clients where client_id=p_client_id) then return; end if;
  insert into public.metrika_consent(user_id,client_id) values (p_user_id,p_client_id)
  on conflict (user_id) do nothing;
  if p_signup_confirmed_at is not null then
    insert into public.metrika_events(user_id,source_id,client_id,name,occurred_at)
    select user_id,user_id,client_id,'registration_confirmed',p_signup_confirmed_at
    from public.metrika_consent where user_id=p_user_id and client_id=p_client_id
    on conflict (source_id,name) do nothing;
  end if;
end $$;

create function public.revoke_metrika_consent(p_client_id text)
returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('metrika:'||p_client_id,0));
  insert into public.metrika_revoked_clients(client_id) values (p_client_id) on conflict do nothing;
  delete from public.metrika_consent where client_id=p_client_id;
  update public.metrika_events set state='revoked'
    where client_id=p_client_id and state in ('ready','sending') and external_id is null;
end $$;

-- Analytics records results in the transaction which creates the authoritative
-- receipt. No provider action or external request runs in a business transaction.
create function public.capture_metrika_event() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare
  client text;
  goal text;
  source uuid;
  tariff text;
  event_time timestamptz;
  confirmed boolean := false;
begin
  select client_id into client from public.metrika_consent
    where user_id=new.user_id and recorded_at <= statement_timestamp();
  if not found then return new; end if;
  case tg_table_name
    when 'payment_intents' then
      goal := 'checkout_started';
      source := new.subscription_id;
      tariff := new.plan;
      event_time := new.created_at;
    when 'single_payment_activations' then
      goal := 'purchase_149';
      source := new.subscription_id;
      tariff := 'single';
      event_time := new.activated_at;
      confirmed := true;
    when 'payment_activations' then
      goal := case when new.premium_until_before > new.activated_at
        then 'subscription_renewed' else 'subscription_449' end;
      source := new.subscription_id;
      tariff := 'unlimited';
      event_time := new.activated_at;
      confirmed := true;
    when 'subscriptions' then
      if old.status <> 'pending' or new.status <> 'cancelled' or new.provider_payment_id is null
        or not exists (select 1 from public.payment_intents where subscription_id=new.id)
      then return new; end if;
      goal := 'payment_failed';
      source := new.id;
      tariff := new.plan;
      event_time := statement_timestamp();
    when 'calculation_operations' then
      if not new.charged or not exists (select 1 from public.profiles
        where id=new.user_id and calculations_used=1) then return new; end if;
      goal := 'first_free_calculation';
      source := new.user_id;
      event_time := new.created_at;
    else
      return new;
  end case;
  insert into public.metrika_events(user_id,source_id,client_id,name,plan,occurred_at)
  values (new.user_id,source,client,goal,tariff,event_time)
  on conflict (source_id,name) do nothing;
  if confirmed then
    insert into public.metrika_events(user_id,source_id,client_id,name,plan,occurred_at)
    values (new.user_id,source,client,'payment_confirmed',tariff,event_time)
    on conflict (source_id,name) do nothing;
  end if;
  return new;
exception when others then
  -- Analytics must never block account, calculation or payment processing.
  raise warning 'metrika capture failed: %', sqlstate;
  return new;
end $$;

create trigger metrika_checkout after insert on public.payment_intents
for each row execute function public.capture_metrika_event();
create trigger metrika_single after insert on public.single_payment_activations
for each row execute function public.capture_metrika_event();
create trigger metrika_unlimited after insert on public.payment_activations
for each row execute function public.capture_metrika_event();
create trigger metrika_cancelled after update of status on public.subscriptions
for each row execute function public.capture_metrika_event();
create trigger metrika_first_free after insert on public.calculation_operations
for each row execute function public.capture_metrika_event();

create function public.claim_metrika_events()
returns table(id uuid, name text, plan text, client_id text, occurred_at timestamptz)
language sql security definer set search_path=pg_catalog as $$
  with pending as (
    select e.id from public.metrika_events e
    join public.metrika_consent c using (user_id, client_id)
    where e.state='ready' order by e.occurred_at, e.id
    for update of e skip locked limit 8
  )
  update public.metrika_events e set state='sending'
  from pending p where e.id=p.id
  returning e.id,e.name,e.plan,e.client_id,e.occurred_at
$$;

revoke all on function public.capture_metrika_event(), public.claim_metrika_events(), public.revoke_metrika_consent(text),
  public.register_metrika_consent(uuid,text,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.claim_metrika_events(), public.revoke_metrika_consent(text),
  public.register_metrika_consent(uuid,text,timestamptz) to service_role;

commit;
notify pgrst,'reload schema';
