-- ============================================================================
-- M-Prof — Supabase production schema
--
-- Запускать в Supabase Dashboard → SQL Editor. Идемпотентно (можно прогонять
-- повторно — все объекты создаются через IF NOT EXISTS / OR REPLACE).
--
-- Включает:
--   • Таблицы: profiles, calculations, uploaded_reports, subscriptions
--   • Auto-create profile на signup (trigger)
--   • Индексы для частых запросов
--   • Row Level Security: пользователь видит/правит ТОЛЬКО свои данные
-- ============================================================================

-- gen_random_uuid()
create extension if not exists "pgcrypto";

-- ============================================================================
-- profiles
-- ============================================================================
create table if not exists public.profiles (
  id                  uuid        primary key references auth.users(id) on delete cascade,
  email               text,
  created_at          timestamptz default now(),
  plan                text        default 'free'
    check (plan in ('free', 'single', 'unlimited')),
  premium_until       timestamptz,
  calculations_used   int         default 0
);

-- Auto-создание profile при регистрации auth.users
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- calculations
-- ============================================================================
create table if not exists public.calculations (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  marketplace       text        not null
    check (marketplace in ('ozon', 'wb')),
  mode              text        not null default 'manual'
    check (mode in ('manual', 'upload', 'api')),
  revenue           numeric     not null default 0,
  commission        numeric     not null default 0,
  logistics         numeric     not null default 0,
  ads               numeric     not null default 0,
  storage           numeric     not null default 0,
  tax               numeric     not null default 0,
  cost              numeric     not null default 0,
  other_expenses    numeric     not null default 0,
  total_expenses    numeric     not null default 0,
  profit            numeric     not null default 0,
  margin            numeric     not null default 0,
  ai_score          int,
  ai_insights       jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists idx_calculations_user_created
  on public.calculations(user_id, created_at desc);

-- ============================================================================
-- MIGRATION: если у вас уже есть calculations table из старого кода (где
-- использовались колонки cost_price), эти ALTER'ы добавят недостающие.
-- CREATE TABLE IF NOT EXISTS выше для уже существующей таблицы — no-op,
-- поэтому новые колонки добавляются отдельно.
-- ============================================================================
alter table public.calculations
  add column if not exists mode text default 'manual';
alter table public.calculations
  add column if not exists ai_score int;
alter table public.calculations
  add column if not exists ai_insights jsonb;
alter table public.calculations
  add column if not exists cost numeric default 0;

-- Перенос legacy cost_price → cost, если старая колонка ещё существует
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'calculations'
      and column_name = 'cost_price'
  ) then
    update public.calculations
       set cost = coalesce(cost, cost_price)
     where cost is null or cost = 0;
    -- cost_price оставляем — на случай rollback. Дроп — отдельным шагом:
    --   alter table public.calculations drop column cost_price;
  end if;
end $$;

-- Заодно гарантируем check-constraint для mode (если был добавлен без него)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'calculations_mode_check'
  ) then
    alter table public.calculations
      add constraint calculations_mode_check
      check (mode in ('manual', 'upload', 'api'));
  end if;
end $$;

-- ============================================================================
-- uploaded_reports
-- ============================================================================
create table if not exists public.uploaded_reports (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id) on delete cascade,
  file_name       text,
  file_size       text,
  marketplace     text
    check (marketplace is null or marketplace in ('ozon', 'wb')),
  period          text,
  rows_count      int,
  status          text        not null default 'processed'
    check (status in ('processed', 'failed', 'pending')),
  calculation_id  uuid        references public.calculations(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_uploaded_reports_user_created
  on public.uploaded_reports(user_id, created_at desc);

-- ============================================================================
-- subscriptions
-- ============================================================================
create table if not exists public.subscriptions (
  id                    uuid        primary key default gen_random_uuid(),
  user_id               uuid        not null references auth.users(id) on delete cascade,
  plan                  text        not null
    check (plan in ('single', 'unlimited')),
  status                text        not null default 'pending'
    check (status in ('pending', 'active', 'expired', 'cancelled', 'failed')),
  provider              text,
  provider_payment_id   text,
  starts_at             timestamptz,
  expires_at            timestamptz,
  created_at            timestamptz not null default now()
);

create index if not exists idx_subscriptions_user_status
  on public.subscriptions(user_id, status);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

-- profiles
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- insert idёт через trigger (security definer), отдельный policy не нужен

-- calculations
alter table public.calculations enable row level security;

drop policy if exists "calculations_select_own" on public.calculations;
create policy "calculations_select_own"
  on public.calculations for select
  using (auth.uid() = user_id);

drop policy if exists "calculations_insert_own" on public.calculations;
create policy "calculations_insert_own"
  on public.calculations for insert
  with check (auth.uid() = user_id);

drop policy if exists "calculations_update_own" on public.calculations;
create policy "calculations_update_own"
  on public.calculations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "calculations_delete_own" on public.calculations;
create policy "calculations_delete_own"
  on public.calculations for delete
  using (auth.uid() = user_id);

-- uploaded_reports
alter table public.uploaded_reports enable row level security;

drop policy if exists "uploaded_reports_select_own" on public.uploaded_reports;
create policy "uploaded_reports_select_own"
  on public.uploaded_reports for select
  using (auth.uid() = user_id);

drop policy if exists "uploaded_reports_insert_own" on public.uploaded_reports;
create policy "uploaded_reports_insert_own"
  on public.uploaded_reports for insert
  with check (auth.uid() = user_id);

drop policy if exists "uploaded_reports_update_own" on public.uploaded_reports;
create policy "uploaded_reports_update_own"
  on public.uploaded_reports for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "uploaded_reports_delete_own" on public.uploaded_reports;
create policy "uploaded_reports_delete_own"
  on public.uploaded_reports for delete
  using (auth.uid() = user_id);

-- subscriptions
-- Чтение — только своё. Insert/update идут через service-role (бэкенд webhook
-- от платёжного провайдера), поэтому write-policy не открываем для anon/auth.
alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own"
  on public.subscriptions for select
  using (auth.uid() = user_id);
