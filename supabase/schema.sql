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

-- BACKFILL: создать profile для уже существующих пользователей, у которых его нет
-- (зарегистрировались до установки триггера). Без этого их entitlements читают
-- пустой профиль → hasPremium=false даже после оплаты. Идемпотентно.
insert into public.profiles (id, email)
select u.id, u.email
from auth.users u
on conflict (id) do nothing;

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

-- profiles UPDATE: клиенту НЕ открываем. Раньше здесь была политика
-- profiles_update_own (auth.uid() = id) — но она позволяла пользователю менять
-- собственные plan / premium_until / calculations_used обычным anon-клиентом и
-- так обойти paywall (выдать себе unlimited / обнулить счётчик). Теперь эти поля
-- меняют ТОЛЬКО:
--   • RPC public.consume_calculation() — SECURITY DEFINER, выполняется как owner;
--   • webhook ЮKassa — service_role, обходит RLS.
-- Снимаем саму политику и (ниже) отзываем привилегию UPDATE у клиентских ролей.
drop policy if exists "profiles_update_own" on public.profiles;

-- LOCKDOWN. Column-level REVOKE здесь НЕ сработал бы: Supabase по умолчанию
-- грантит table-level ALL ролям anon/authenticated, а table-level UPDATE
-- перекрывает column-level revoke. Поэтому забираем UPDATE на profiles целиком —
-- клиент в profiles не пишет вообще (см. supabase-cloud.ts: setCalculationsUsed
-- удалён, расход списывает RPC). Идемпотентно. SECURITY DEFINER-функция и
-- service_role на это не влияют — они работают мимо клиентских грантов.
revoke update on public.profiles from anon, authenticated;

-- insert идёт через trigger (security definer), отдельный policy не нужен

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

-- ============================================================================
-- consume_calculation() — server-authoritative списание одного расчёта.
--
-- Единственный путь, которым расходуется квота. Клиент НЕ инкрементит счётчик
-- сам (UPDATE на profiles ему отозван). Функция атомарно под row-lock:
--   • unlimited со свежим premium_until > now()  → ok, лимит НЕ трогаем;
--   • иначе allowance = 1 бесплатный + число active single-подписок (кредиты),
--     и если calculations_used < allowance → инкремент + ok, иначе → limit_reached.
--
-- Почему SECURITY DEFINER: authenticated-роли отозван UPDATE на profiles, а
-- функция выполняется как owner и потому может писать счётчик. auth.uid() внутри
-- DEFINER по-прежнему возвращает uid вызывающего (читается из JWT-claims GUC).
--
-- Почему FOR UPDATE: сериализует параллельные расчёты одного пользователя
-- (две вкладки/быстрые клики) — без блокировки оба прочли бы старый счётчик и
-- списали бы один кредит дважды. Лок на строку profiles исключает double-spend.
--
-- Идемпотентности тут НЕТ намеренно: каждый успешный вызов = один расход. Вызывать
-- РОВНО один раз на расчёт, ПЕРЕД сохранением/выдачей результата.
-- ============================================================================
create or replace function public.consume_calculation()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid            uuid := auth.uid();
  prof           public.profiles%rowtype;
  single_credits int;
  allowance      int;
  used           int;
  free_limit     constant int := 1;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;

  -- Блокируем строку профиля до конца транзакции (анти-double-spend).
  select * into prof from public.profiles where id = uid for update;
  if not found then
    -- Профиль обычно создаётся триггером на signup; это страховка.
    insert into public.profiles (id) values (uid) on conflict (id) do nothing;
    select * into prof from public.profiles where id = uid for update;
  end if;

  -- Безлимит: тариф unlimited со свежим сроком. Счётчик не расходуем.
  if prof.plan = 'unlimited'
     and prof.premium_until is not null
     and prof.premium_until > now() then
    return jsonb_build_object('ok', true, 'unlimited', true);
  end if;

  -- Квота = 1 бесплатный + по +1 за каждую активную single-подписку (реестр кредитов).
  select count(*) into single_credits
  from public.subscriptions
  where user_id = uid and plan = 'single' and status = 'active';

  used      := coalesce(prof.calculations_used, 0);
  allowance := free_limit + single_credits;

  if used >= allowance then
    return jsonb_build_object(
      'ok', false, 'reason', 'limit_reached',
      'used', used, 'allowance', allowance
    );
  end if;

  update public.profiles
     set calculations_used = used + 1
   where id = uid;

  return jsonb_build_object('ok', true, 'used', used + 1, 'allowance', allowance);
end;
$$;

-- Доступ к функции: только залогиненным. anon (аноним) считает лимит в
-- localStorage и RPC не зовёт; revoke from public убирает неявный широкий грант.
revoke all on function public.consume_calculation() from public;
grant execute on function public.consume_calculation() to authenticated;

-- ============================================================================
-- products — каталог товаров пользователя (Артикул / Название / Себестоимость)
--
-- Таблица создаётся идемпотентно. Если она уже была заведена вручную в Supabase
-- (возможно, с другим набором колонок) — ALTER ... ADD COLUMN IF NOT EXISTS ниже
-- гарантирует наличие именно тех колонок, которые читает клиент:
--   sku (text) / name (text) / cost_price (numeric).
-- RLS — по тому же паттерну, что calculations / uploaded_reports: пользователь
-- видит и правит ТОЛЬКО свои товары (auth.uid() = user_id).
-- ============================================================================
create table if not exists public.products (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  sku         text,
  name        text        not null default '',
  cost_price  numeric     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Гарантируем нужные колонки, даже если таблица уже существовала ранее.
alter table public.products add column if not exists sku        text;
alter table public.products add column if not exists name       text        not null default '';
alter table public.products add column if not exists cost_price numeric     not null default 0;
alter table public.products add column if not exists created_at timestamptz not null default now();
alter table public.products add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_products_user_created
  on public.products(user_id, created_at desc);

-- updated_at автообновляется на каждый UPDATE строки.
create or replace function public.touch_products_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_products_touch on public.products;
create trigger trg_products_touch
  before update on public.products
  for each row execute function public.touch_products_updated_at();

-- ROW LEVEL SECURITY — только свои товары
alter table public.products enable row level security;

drop policy if exists "products_select_own" on public.products;
create policy "products_select_own"
  on public.products for select
  using (auth.uid() = user_id);

drop policy if exists "products_insert_own" on public.products;
create policy "products_insert_own"
  on public.products for insert
  with check (auth.uid() = user_id);

drop policy if exists "products_update_own" on public.products;
create policy "products_update_own"
  on public.products for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "products_delete_own" on public.products;
create policy "products_delete_own"
  on public.products for delete
  using (auth.uid() = user_id);
