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
-- consume_api_calculation() — server-authoritative списание ОДНОГО Ozon API-расчёта.
--
-- Отдельная, БОЛЕЕ СТРОГАЯ квота для API-расчётов (PR #21). В отличие от
-- consume_calculation() (файловые/ручные расчёты), здесь single-кредиты (149₽)
-- НЕ дают права на API. API-расчёт доступен ТОЛЬКО:
--   • активный unlimited (449₽) со свежим premium_until > now() → ok, БЕЗ списания;
--   • ИНАЧЕ — ровно один бесплатный ПРОБНЫЙ расчёт: общий счётчик
--     calculations_used < 1 → инкремент того же счётчика + ok; иначе limit_reached.
--
-- Счётчик calculations_used СПЕЦИАЛЬНО общий с consume_calculation(): «первый
-- бесплатный расчёт» — единый пробный на пользователя (файловый/ручной ИЛИ API),
-- а не отдельный бесплатный API-расчёт сверху. Поэтому 149₽ (single) не открывает
-- API: single-кредиты в allowance здесь НЕ учитываются, а пробный — один на всех.
--
-- SECURITY DEFINER / FOR UPDATE / отсутствие идемпотентности — по тем же причинам,
-- что и в consume_calculation() (см. блок выше): authenticated отозван UPDATE на
-- profiles; row-lock сериализует параллельные расчёты (анти-double-spend); каждый
-- успешный вызов = ровно один расход, звать РОВНО один раз перед сохранением.
-- Старую RPC consume_calculation() НЕ трогаем — её зовут файловый/ручной расчёты.
-- ============================================================================
create or replace function public.consume_api_calculation()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid        uuid := auth.uid();
  prof       public.profiles%rowtype;
  used       int;
  free_limit constant int := 1;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;

  -- Блокируем строку профиля до конца транзакции (анти-double-spend).
  select * into prof from public.profiles where id = uid for update;
  if not found then
    -- Профиль создаётся триггером на signup; его отсутствие — аномалия. Для API
    -- fail-closed: не выдаём бесплатный расчёт «в пустоту» (в отличие от
    -- consume_calculation(), здесь профиль НЕ досоздаём).
    return jsonb_build_object('ok', false, 'reason', 'profile_not_found');
  end if;

  -- Безлимит: тариф unlimited (449₽) со свежим сроком. Счётчик НЕ расходуем.
  if prof.plan = 'unlimited'
     and prof.premium_until is not null
     and prof.premium_until > now() then
    return jsonb_build_object('ok', true, 'unlimited', true);
  end if;

  -- Без безлимита API доступен ТОЛЬКО как единственный бесплатный пробный расчёт.
  -- single-кредиты (149₽) НАМЕРЕННО не учитываются → 149₽ не открывает API.
  used := coalesce(prof.calculations_used, 0);

  if used >= free_limit then
    return jsonb_build_object(
      'ok', false, 'reason', 'limit_reached',
      'used', used, 'allowance', free_limit
    );
  end if;

  update public.profiles
     set calculations_used = used + 1
   where id = uid;

  return jsonb_build_object(
    'ok', true, 'unlimited', false, 'used', used + 1, 'allowance', free_limit
  );
end;
$$;

-- Доступ к функции: только залогиненным (как у consume_calculation()).
revoke all on function public.consume_api_calculation() from public;
grant execute on function public.consume_api_calculation() to authenticated;

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

-- Уникальность артикула по КАНОНИЧЕСКОМУ ключу (PR #99). Применяется отдельной
-- миграцией supabase/migrations/20260926_products_article_unique.sql — она же
-- проверяет окружение и ОСТАНАВЛИВАЕТСЯ при существующих конфликтах (сначала
-- read-only supabase/checks/products_article_conflicts.sql). Здесь — итоговое
-- состояние схемы для полноты дампа.
create or replace function public.canonical_article(s text)
returns text
language sql
immutable
parallel safe
strict
as $$
  select nullif(
    lower(
      btrim(
        regexp_replace(
          s,
          '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+',
          ' ',
          'g'
        ),
        ' '
      )
    ),
    ''
  )
$$;

alter table public.products
  add column if not exists sku_key text
  generated always as (public.canonical_article(sku)) stored;

create unique index if not exists products_user_sku_key_uq
  on public.products (user_id, sku_key);

-- ============================================================================
-- report_history — помесячная история расчётов для блока «Аналитика по месяцам»
--
-- Каждый успешный расчёт чистой прибыли пишет сюда одну строку: выручка,
-- расходы, прибыль, маржа и месяц отчёта (report_month — первое число месяца,
-- 'YYYY-MM-01'). UI группирует по месяцам (последняя запись за месяц) и строит
-- карточки текущего месяца + графики прибыли/выручки по месяцам.
-- Таблица создаётся идемпотентно; RLS — по тому же паттерну (только свои строки).
-- ============================================================================
create table if not exists public.report_history (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  report_month  date        not null,
  revenue       numeric     not null default 0,
  expenses      numeric     not null default 0,
  profit        numeric     not null default 0,
  margin        numeric     not null default 0,
  created_at    timestamptz not null default now()
);

-- Гарантируем нужные колонки, даже если таблица уже существовала ранее.
alter table public.report_history add column if not exists report_month date    not null default (date_trunc('month', now())::date);
alter table public.report_history add column if not exists revenue      numeric not null default 0;
alter table public.report_history add column if not exists expenses     numeric not null default 0;
alter table public.report_history add column if not exists profit       numeric not null default 0;
alter table public.report_history add column if not exists margin       numeric not null default 0;
alter table public.report_history add column if not exists created_at   timestamptz not null default now();

create index if not exists idx_report_history_user_month
  on public.report_history(user_id, report_month);

-- ROW LEVEL SECURITY — только свои записи
alter table public.report_history enable row level security;

drop policy if exists "report_history_select_own" on public.report_history;
create policy "report_history_select_own"
  on public.report_history for select
  using (auth.uid() = user_id);

drop policy if exists "report_history_insert_own" on public.report_history;
create policy "report_history_insert_own"
  on public.report_history for insert
  with check (auth.uid() = user_id);

drop policy if exists "report_history_update_own" on public.report_history;
create policy "report_history_update_own"
  on public.report_history for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "report_history_delete_own" on public.report_history;
create policy "report_history_delete_own"
  on public.report_history for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- ozon_connections — безопасное подключение кабинета Ozon Seller API.
--
-- ОДНА строка на пользователя (user_id = PK). Хранит ЗАШИФРОВАННЫЙ Api-Key
-- (AES-256-GCM; ключ шифрования — серверный env OZON_KEYS_ENC_SECRET,
-- см. app/api/ozon/_lib/crypto.ts) + last4 для отображения (••••1234) +
-- Client-Id + статус последней проверки.
--
-- БЕЗОПАСНОСТЬ — таблица ПОЛНОСТЬЮ закрыта для клиентских ролей:
--   • RLS включён, но клиентских policy НЕТ вовсе → под RLS это deny-all для
--     anon/authenticated (в отличие от calculations, где есть *_own policy);
--   • дополнительно REVOKE ALL у anon/authenticated;
--   • единственный путь к строке — backend через service-role (мимо RLS),
--     routes /api/ozon/connection*. Зашифрованный ключ НИКОГДА не уходит в браузер.
-- Строже, чем subscriptions (там есть select-own): здесь нельзя отдавать клиенту
-- даже зашифрованный ключ, поэтому select тоже закрыт.
-- ============================================================================
create table if not exists public.ozon_connections (
  user_id            uuid        primary key references auth.users(id) on delete cascade,
  client_id          text        not null,
  api_key_encrypted  text        not null,
  key_last4          text,
  status             text        not null default 'unknown'
    check (status in ('unknown', 'connected', 'invalid_key', 'forbidden', 'unavailable')),
  last_checked_at    timestamptz,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Гарантируем нужные колонки, если таблица уже существовала ранее (как делалось
-- для products/report_history). NOT NULL без дефолта (client_id, api_key_encrypted)
-- через ALTER не ретрофитим — они приходят из CREATE TABLE; для нового объекта
-- это no-op, повторный прогон безопасен.
alter table public.ozon_connections add column if not exists key_last4       text;
alter table public.ozon_connections add column if not exists status          text        not null default 'unknown';
alter table public.ozon_connections add column if not exists last_checked_at timestamptz;
alter table public.ozon_connections add column if not exists last_error      text;
alter table public.ozon_connections add column if not exists created_at      timestamptz not null default now();
alter table public.ozon_connections add column if not exists updated_at      timestamptz not null default now();

-- Гарантируем check-constraint статуса, даже если колонку добавили без него.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ozon_connections_status_check'
  ) then
    alter table public.ozon_connections
      add constraint ozon_connections_status_check
      check (status in ('unknown', 'connected', 'invalid_key', 'forbidden', 'unavailable'));
  end if;
end $$;

-- updated_at автообновляется на каждый UPDATE (тот же паттерн, что products).
create or replace function public.touch_ozon_connections_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_ozon_connections_touch on public.ozon_connections;
create trigger trg_ozon_connections_touch
  before update on public.ozon_connections
  for each row execute function public.touch_ozon_connections_updated_at();

-- ROW LEVEL SECURITY — полный lockdown для клиента (никаких policy + revoke).
alter table public.ozon_connections enable row level security;

-- НАМЕРЕННО НЕТ ни одной policy: под включённым RLS отсутствие policy = deny-all
-- для anon/authenticated. Зашифрованный ключ не должен быть доступен браузеру даже
-- на чтение. Доступ — только backend через service-role (мимо RLS).
revoke all on public.ozon_connections from anon, authenticated;

-- ============================================================================
-- ozon_performance_connections — безопасное подключение Ozon PERFORMANCE API
-- (реклама/продвижение). Добавлено в PR #43 (foundation).
--
-- >>> Применяется ВРУЧНУЮ (как весь этот файл). См. отдельный apply-файл:
--     supabase/migrations/20260705_ozon_performance_connections.sql <<<
--
-- ОТДЕЛЬНАЯ таблица (НЕ ozon_connections), чтобы не рисковать Seller-подключением.
-- Хранит ЗАШИФРОВАННЫЙ client_secret (AES-256-GCM, env OZON_KEYS_ENC_SECRET — тот
-- же, что у Seller-ключа; см. app/api/ozon/_lib/crypto.ts) + last4 + Client ID +
-- статус проверки токена. Реклама в расчёт прибыли пока НЕ добавляется.
--
-- БЕЗОПАСНОСТЬ — как у ozon_connections: RLS включён, клиентских policy НЕТ
-- (deny-all для anon/authenticated) + REVOKE ALL. Доступ только backend через
-- service-role (routes /api/ozon/performance/connection*). Секрет/токен НИКОГДА
-- не уходят в браузер. Строже, чем select/insert-own: секрет не отдаём даже как
-- шифротекст; на функциональность не влияет (routes ходят под service-role).
-- ============================================================================
create table if not exists public.ozon_performance_connections (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  client_id                text        not null,
  client_secret_encrypted  text        not null,
  secret_last4             text,
  status                   text        not null default 'unknown'
    check (status in ('unknown', 'active', 'invalid_key', 'forbidden', 'unavailable')),
  last_checked_at          timestamptz,
  last_error               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (user_id)
);

alter table public.ozon_performance_connections add column if not exists secret_last4    text;
alter table public.ozon_performance_connections add column if not exists status          text        not null default 'unknown';
alter table public.ozon_performance_connections add column if not exists last_checked_at timestamptz;
alter table public.ozon_performance_connections add column if not exists last_error      text;
alter table public.ozon_performance_connections add column if not exists created_at      timestamptz not null default now();
alter table public.ozon_performance_connections add column if not exists updated_at      timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ozon_performance_connections_user_id_key'
  ) then
    alter table public.ozon_performance_connections
      add constraint ozon_performance_connections_user_id_key unique (user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ozon_performance_connections_status_check'
  ) then
    alter table public.ozon_performance_connections
      add constraint ozon_performance_connections_status_check
      check (status in ('unknown', 'active', 'invalid_key', 'forbidden', 'unavailable'));
  end if;
end $$;

create or replace function public.touch_ozon_performance_connections_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_ozon_performance_connections_touch on public.ozon_performance_connections;
create trigger trg_ozon_performance_connections_touch
  before update on public.ozon_performance_connections
  for each row execute function public.touch_ozon_performance_connections_updated_at();

alter table public.ozon_performance_connections enable row level security;

-- НАМЕРЕННО НЕТ ни одной policy: под включённым RLS отсутствие policy = deny-all.
revoke all on public.ozon_performance_connections from anon, authenticated;

-- ============================================================================
-- Продление безлимита (449 ₽) с сохранением оплаченного срока. Применяется отдельной
-- миграцией supabase/migrations/20260927_unlimited_payment_extension.sql (порядок
-- выпуска и read-only проверки supabase/checks/unlimited_payment_extension.sql — там).
-- Здесь — итоговое состояние схемы для полноты дампа; тест tests/db сверяет, что оно
-- совпадает с миграцией.
-- ============================================================================
-- 1. Ограждение от записей старого обработчика. CREATE TRIGGER берёт блокировку таблиц
--    (SHARE ROW EXCLUSIVE): дожидается уже идущих записей и не пускает новые до COMMIT.
create or replace function public.guard_unlimited_writes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Ограничиваем только серверную роль приложения; grant_unlimited_payment() на время
  -- своих записей ставит транзакционный флаг mprof.unlimited_grant.
  if current_user <> 'service_role'
     or coalesce(current_setting('mprof.unlimited_grant', true), '') = 'on' then
    return new;
  end if;

  if tg_table_name = 'subscriptions' then
    if new.plan = 'unlimited' and (
         (tg_op = 'INSERT' and new.status = 'active')
      or (tg_op = 'UPDATE'
          and (new.status = 'active' or old.status = 'active')
          and (new.status, new.starts_at, new.expires_at)
              is distinct from (old.status, old.starts_at, old.expires_at))
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'unlimited_extension: безлимит активирует только grant_unlimited_payment()';
    end if;
  elsif tg_table_name = 'profiles' then
    if (tg_op = 'INSERT' and new.premium_until is not null)
       or (tg_op = 'UPDATE' and new.premium_until is distinct from old.premium_until) then
      raise exception using
        errcode = 'P0001',
        message = 'unlimited_extension: срок безлимита меняет только grant_unlimited_payment()';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_unlimited_writes() from public, anon, authenticated;

drop trigger if exists guard_unlimited_writes on public.subscriptions;
create trigger guard_unlimited_writes
  before insert or update on public.subscriptions
  for each row execute function public.guard_unlimited_writes();

drop trigger if exists guard_unlimited_writes on public.profiles;
create trigger guard_unlimited_writes
  before insert or update on public.profiles
  for each row execute function public.guard_unlimited_writes();

-- 2. Незавершённая активация старым обработчиком (уже под блокировками п. 1): у каждого
--    пользователя с действующей active-подпиской безлимита срок профиля должен совпадать
--    со сроком самой поздней из них — старый обработчик пишет их одним значением.
do $$
begin
  if exists (
    select 1
      from (
        select distinct on (s.user_id) s.user_id, s.expires_at
          from public.subscriptions s
         where s.plan = 'unlimited' and s.status = 'active' and s.expires_at is not null
         order by s.user_id, s.expires_at desc
      ) latest
      left join public.profiles p on p.id = latest.user_id
     where latest.expires_at > now()
       and p.premium_until is distinct from latest.expires_at
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'unlimited_extension: есть незавершённая активация безлимита старым обработчиком '
             || '(подписка active, срок профиля не совпадает). Ничего не изменено. Повторите '
             || 'миграцию через минуту; если снова так — раздел «ДО» проверок, решение владельца.';
  end if;
end $$;

-- 3. Журнал обработанных платежей безлимита. Строка = «этот платёж уже выдал доступ».
create table if not exists public.payment_activations (
  payment_id            text        primary key,
  subscription_id       uuid        not null unique
    references public.subscriptions(id) on delete cascade,
  user_id               uuid        not null,
  activated_at          timestamptz not null,
  premium_until_before  timestamptz,
  premium_until_after   timestamptz not null,
  created_at            timestamptz not null default now()
);

create index if not exists idx_payment_activations_user
  on public.payment_activations(user_id);

alter table public.payment_activations enable row level security;
-- НАМЕРЕННО нет ни одной policy: для anon/authenticated это deny-all.
revoke all on public.payment_activations from public, anon, authenticated;
grant select, insert on public.payment_activations to service_role;

-- 4. Выдача 30 дней по одному платежу — одна транзакция.
create or replace function public.grant_unlimited_payment(
  p_subscription_id uuid,
  p_payment_id      text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  sub          public.subscriptions%rowtype;
  act          public.payment_activations%rowtype;
  activated    timestamptz := now();  -- время сервера БД (начало транзакции)
  until_before timestamptz;
  until_after  timestamptz;
  inserted     int;
begin
  if p_subscription_id is null or p_payment_id is null or btrim(p_payment_id) = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_arguments');
  end if;

  -- 1. Подписка под блокировкой: повторные доставки одного платежа — по очереди.
  select * into sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'subscription_not_found');
  end if;
  if sub.plan <> 'unlimited' then
    return jsonb_build_object('ok', false, 'reason', 'plan_mismatch');
  end if;
  if sub.provider_payment_id is not null and sub.provider_payment_id <> p_payment_id then
    return jsonb_build_object('ok', false, 'reason', 'payment_mismatch');
  end if;

  -- 2. Уже обработан новым кодом (отметка по payment_id)?
  select * into act from public.payment_activations where payment_id = p_payment_id;
  if found then
    return jsonb_build_object(
      'ok', true, 'granted', false, 'reason', 'already_processed',
      'activated_at', act.activated_at, 'premium_until', act.premium_until_after
    );
  end if;
  -- …или старым кодом до этой миграции (подписка уже active/expired).
  if sub.status in ('active', 'expired') then
    return jsonb_build_object(
      'ok', true, 'granted', false, 'reason', 'already_processed_legacy',
      'activated_at', sub.starts_at, 'premium_until', sub.expires_at
    );
  end if;

  -- 3. Профиль под блокировкой: разные платежи одного пользователя — по очереди,
  --    каждый прибавляет 30 дней к уже сохранённому сроку.
  insert into public.profiles (id) values (sub.user_id) on conflict (id) do nothing;
  select premium_until into until_before
    from public.profiles where id = sub.user_id for update;

  until_after := greatest(coalesce(until_before, activated), activated) + interval '30 days';

  -- 4. Отметка обработки. PRIMARY KEY payment_id: второй одновременный вызов с тем
  --    же платежом дождётся COMMIT первого и ничего не вставит.
  insert into public.payment_activations
    (payment_id, subscription_id, user_id, activated_at, premium_until_before, premium_until_after)
  values
    (p_payment_id, sub.id, sub.user_id, activated, until_before, until_after)
  on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then
    return jsonb_build_object('ok', true, 'granted', false, 'reason', 'already_processed');
  end if;

  -- 5. Срок и статус — в той же транзакции, что и отметка (флаг пропускает ограждение).
  perform set_config('mprof.unlimited_grant', 'on', true);
  update public.profiles
     set plan = 'unlimited', premium_until = until_after
   where id = sub.user_id;

  update public.subscriptions
     set status = 'active',
         starts_at = activated,
         expires_at = until_after,
         provider_payment_id = coalesce(provider_payment_id, p_payment_id)
   where id = sub.id;
  perform set_config('mprof.unlimited_grant', '', true);

  return jsonb_build_object(
    'ok', true, 'granted', true,
    'activated_at', activated,
    'premium_until_before', until_before,
    'premium_until', until_after
  );
end;
$$;

revoke all on function public.grant_unlimited_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.grant_unlimited_payment(uuid, text) to service_role;

-- ============================================================================
-- Операции расчёта по XLSX: атомарное списание попытки и сохранение расчёта.
-- Применяется отдельной миграцией supabase/migrations/20260928_calculation_operations.sql
-- (порядок выпуска и read-only проверки supabase/checks/calculation_operations.sql — там).
-- Здесь — итоговое состояние схемы для полноты дампа; тест tests/db сверяет, что оно
-- совпадает с миграцией.
-- ============================================================================
-- 1. Журнал операций расчёта: строка = «эта операция списала попытку и сохранила
--    расчёт». Первичный ключ — id операции от клиента (UUID). Удаление расчёта или
--    сводки из истории строку журнала не удаляет (ссылка обнуляется).
create table if not exists public.calculation_operations (
  id                 uuid        primary key,
  user_id            uuid        not null references auth.users(id) on delete cascade,
  mode               text        not null check (mode in ('upload')),
  request_hash       text        not null check (char_length(request_hash) between 1 and 200),
  -- SHA-256 (hex) сохранённых данных: расчёт, снимок без generatedAt, строка сводки.
  payload_hash       text        not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  calculation_id     uuid        references public.calculations(id) on delete set null,
  report_history_id  uuid        references public.report_history(id) on delete set null,
  -- true — израсходована попытка (бесплатная или разовый кредит); false — безлимит.
  charged            boolean     not null,
  created_at         timestamptz not null default now()
);

create index if not exists idx_calculation_operations_user
  on public.calculation_operations(user_id, created_at desc);

alter table public.calculation_operations enable row level security;
-- НАМЕРЕННО нет ни одной policy: для anon/authenticated это deny-all.
revoke all on public.calculation_operations from public, anon, authenticated;

-- 2. Списание + сохранение одной транзакцией.
create or replace function public.save_calculation_operation(
  p_operation_id  uuid,
  p_mode          text,
  p_request_hash  text,
  p_calculation   jsonb,
  p_history       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid       uuid := auth.uid();
  op        public.calculation_operations%rowtype;
  payload   text;
  consumed  jsonb;
  calc_id   uuid;
  calc_at   timestamptz;
  calc_snap jsonb;
  hist_id   uuid;
  charged   boolean;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if p_operation_id is null
     or p_mode is distinct from 'upload'
     or coalesce(char_length(p_request_hash), 0) not between 1 and 200
     or jsonb_typeof(p_calculation) is distinct from 'object'
     or jsonb_typeof(p_calculation -> 'ai_insights') is distinct from 'object'
     or jsonb_typeof(p_history) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  -- Отпечаток данных операции. Время формирования снимка не входит: повтор того же
  -- расчёта собирает снимок заново.
  payload := encode(sha256(convert_to(jsonb_build_object(
    'calculation', p_calculation - 'ai_insights',
    'snapshot',    (p_calculation -> 'ai_insights') - 'generatedAt',
    'history',     p_history
  )::text, 'UTF8')), 'hex');

  -- Операции пользователя — строго по очереди (та же строка, что блокирует
  -- consume_calculation): одновременный повтор той же операции дождётся первой и
  -- увидит её результат.
  insert into public.profiles (id) values (uid) on conflict (id) do nothing;
  perform 1 from public.profiles where id = uid for update;

  select * into op from public.calculation_operations where id = p_operation_id;
  if found then
    if op.user_id <> uid or op.mode <> p_mode or op.request_hash <> p_request_hash then
      return jsonb_build_object('ok', false, 'reason', 'operation_conflict');
    end if;
    -- Повтор: ничего не списывается и не пишется, данные повтора не применяются.
    if op.calculation_id is null then
      -- Расчёт удалён из истории: заново не создаётся.
      return jsonb_build_object('ok', true, 'replay', true, 'status', 'deleted', 'charged', op.charged);
    end if;
    select c.created_at, c.ai_insights into calc_at, calc_snap
      from public.calculations c where c.id = op.calculation_id;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'status', 'done',
      'calculation_id', op.calculation_id,
      'created_at', calc_at,
      'snapshot', calc_snap,
      'content_match', op.payload_hash = payload,
      'charged', op.charged
    );
  end if;

  -- Списание по действующим правилам (без дублирования логики).
  consumed := public.consume_calculation();
  if coalesce((consumed ->> 'ok')::boolean, false) is not true then
    return jsonb_build_object(
      'ok', false,
      'reason', coalesce(consumed ->> 'reason', 'limit_reached'),
      'used', consumed -> 'used',
      'allowance', consumed -> 'allowance'
    );
  end if;
  charged := coalesce((consumed ->> 'unlimited')::boolean, false) is not true;

  insert into public.calculations
    (user_id, marketplace, mode, revenue, commission, logistics, ads, storage, tax, cost,
     other_expenses, total_expenses, profit, margin, ai_insights)
  values
    (uid,
     p_calculation ->> 'marketplace',
     p_mode,
     (p_calculation ->> 'revenue')::numeric,
     (p_calculation ->> 'commission')::numeric,
     (p_calculation ->> 'logistics')::numeric,
     (p_calculation ->> 'ads')::numeric,
     (p_calculation ->> 'storage')::numeric,
     (p_calculation ->> 'tax')::numeric,
     (p_calculation ->> 'cost')::numeric,
     (p_calculation ->> 'other_expenses')::numeric,
     (p_calculation ->> 'total_expenses')::numeric,
     (p_calculation ->> 'profit')::numeric,
     (p_calculation ->> 'margin')::numeric,
     p_calculation -> 'ai_insights')
  returning id, created_at into calc_id, calc_at;

  insert into public.report_history (user_id, report_month, revenue, expenses, profit, margin)
  values
    (uid,
     (p_history ->> 'report_month')::date,
     (p_history ->> 'revenue')::numeric,
     (p_history ->> 'expenses')::numeric,
     (p_history ->> 'profit')::numeric,
     (p_history ->> 'margin')::numeric)
  returning id into hist_id;

  insert into public.calculation_operations
    (id, user_id, mode, request_hash, payload_hash, calculation_id, report_history_id, charged)
  values
    (p_operation_id, uid, p_mode, p_request_hash, payload, calc_id, hist_id, charged);

  return jsonb_build_object(
    'ok', true, 'replay', false, 'status', 'done',
    'calculation_id', calc_id,
    'created_at', calc_at,
    'content_match', true,
    'charged', charged,
    'used', consumed -> 'used',
    'allowance', consumed -> 'allowance',
    'unlimited', coalesce((consumed ->> 'unlimited')::boolean, false)
  );
end;
$$;

revoke all on function public.save_calculation_operation(uuid, text, text, jsonb, jsonb)
  from public, anon;
grant execute on function public.save_calculation_operation(uuid, text, text, jsonb, jsonb)
  to authenticated;

-- 3. Статус операции (восстановление после перезагрузки): только своя операция и
--    только для того же файла. done — с сохранённым снимком (показывается как есть,
--    без пересчёта); deleted — расчёт удалён из истории.
create or replace function public.calculation_operation_status(
  p_operation_id  uuid,
  p_request_hash  text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  uid       uuid := auth.uid();
  op        public.calculation_operations%rowtype;
  calc_at   timestamptz;
  calc_snap jsonb;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into op from public.calculation_operations
   where id = p_operation_id and user_id = uid;
  if not found then
    return jsonb_build_object('ok', true, 'status', 'none');
  end if;
  if op.request_hash is distinct from p_request_hash then
    return jsonb_build_object('ok', true, 'status', 'conflict');
  end if;
  if op.calculation_id is null then
    return jsonb_build_object('ok', true, 'status', 'deleted');
  end if;
  select c.created_at, c.ai_insights into calc_at, calc_snap
    from public.calculations c where c.id = op.calculation_id;
  return jsonb_build_object(
    'ok', true, 'status', 'done',
    'calculation_id', op.calculation_id,
    'created_at', calc_at,
    'snapshot', calc_snap
  );
end;
$$;

revoke all on function public.calculation_operation_status(uuid, text) from public, anon;
grant execute on function public.calculation_operation_status(uuid, text) to authenticated;

-- ============================================================================
-- Операции расчёта для ручного режима и Ozon API (поверх секции выше).
-- Применяется отдельной миграцией supabase/migrations/20260929_calculation_operations_manual_api.sql
-- (порядок выпуска и read-only проверки supabase/checks/calculation_operations_manual_api.sql — там).
-- Здесь — итоговое состояние схемы для полноты дампа; тест tests/db сверяет, что оно
-- совпадает с миграцией.
-- ============================================================================
-- 1. Журнал: режимы XLSX, ручной и Ozon API.
alter table public.calculation_operations
  drop constraint if exists calculation_operations_mode_check;
alter table public.calculation_operations
  add constraint calculation_operations_mode_check check (mode in ('upload', 'manual', 'api'));

-- 2. Правила списания — одна реализация на пользователя. Тела — прежние
--    consume_calculation() / consume_api_calculation(), только uid берётся из аргумента.
--    Вызывать напрямую не может никто, кроме функций-владельцев (EXECUTE отозван).
create or replace function public.consume_calculation_for(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid            uuid := p_user_id;
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

revoke all on function public.consume_calculation_for(uuid) from public, anon, authenticated, service_role;

create or replace function public.consume_api_calculation_for(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid        uuid := p_user_id;
  prof       public.profiles%rowtype;
  used       int;
  free_limit constant int := 1;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;

  -- Блокируем строку профиля до конца транзакции (анти-double-spend).
  select * into prof from public.profiles where id = uid for update;
  if not found then
    -- Профиль создаётся триггером на signup; его отсутствие — аномалия. Для API
    -- fail-closed: не выдаём бесплатный расчёт «в пустоту» (профиль НЕ досоздаём).
    return jsonb_build_object('ok', false, 'reason', 'profile_not_found');
  end if;

  -- Безлимит: тариф unlimited (449₽) со свежим сроком. Счётчик НЕ расходуем.
  if prof.plan = 'unlimited'
     and prof.premium_until is not null
     and prof.premium_until > now() then
    return jsonb_build_object('ok', true, 'unlimited', true);
  end if;

  -- Без безлимита API доступен ТОЛЬКО как единственный бесплатный пробный расчёт.
  -- single-кредиты (149₽) НАМЕРЕННО не учитываются → 149₽ не открывает API.
  used := coalesce(prof.calculations_used, 0);

  if used >= free_limit then
    return jsonb_build_object(
      'ok', false, 'reason', 'limit_reached',
      'used', used, 'allowance', free_limit
    );
  end if;

  update public.profiles
     set calculations_used = used + 1
   where id = uid;

  return jsonb_build_object(
    'ok', true, 'unlimited', false, 'used', used + 1, 'allowance', free_limit
  );
end;
$$;

revoke all on function public.consume_api_calculation_for(uuid) from public, anon, authenticated, service_role;

-- Публичные функции списания — обёртки с прежним поведением (пользователь из JWT).
-- Права на них не меняются.
create or replace function public.consume_calculation()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.consume_calculation_for(auth.uid());
end;
$$;

create or replace function public.consume_api_calculation()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.consume_api_calculation_for(auth.uid());
end;
$$;

-- 3. Сохранённая строка расчёта (для повтора и восстановления) — без изменения данных.
create or replace function public.calculation_operation_saved(p_calculation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', c.id, 'user_id', c.user_id, 'created_at', c.created_at,
    'marketplace', c.marketplace, 'mode', c.mode,
    'revenue', c.revenue, 'commission', c.commission, 'logistics', c.logistics,
    'ads', c.ads, 'storage', c.storage, 'tax', c.tax, 'cost', c.cost,
    'other_expenses', c.other_expenses, 'total_expenses', c.total_expenses,
    'profit', c.profit, 'margin', c.margin,
    'ai_score', c.ai_score, 'ai_insights', c.ai_insights
  )
  from public.calculations c
  where c.id = p_calculation_id;
$$;

revoke all on function public.calculation_operation_saved(uuid) from public, anon, authenticated, service_role;

-- 4. Операция расчёта — одна транзакция для всех режимов (внутренняя, без грантов).
create or replace function public.calculation_operation_execute(
  p_user_id       uuid,
  p_operation_id  uuid,
  p_mode          text,
  p_request_hash  text,
  p_calculation   jsonb,
  p_history       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  op        public.calculation_operations%rowtype;
  payload   text;
  consumed  jsonb;
  calc_id   uuid;
  calc_at   timestamptz;
  saved     jsonb;
  hist_id   uuid;
  charged   boolean;
begin
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if p_operation_id is null
     or p_mode is null or p_mode not in ('upload', 'manual', 'api')
     or coalesce(char_length(p_request_hash), 0) not between 1 and 200
     or jsonb_typeof(p_calculation) is distinct from 'object'
     or (p_mode in ('upload', 'api')
         and (jsonb_typeof(p_calculation -> 'ai_insights') is distinct from 'object'
              or jsonb_typeof(p_history) is distinct from 'object'))
     or (p_mode = 'manual' and (p_calculation ? 'ai_insights' or p_history is not null)) then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  -- Отпечаток данных операции. Время формирования снимка (generatedAt у XLSX,
  -- savedAt у API) не входит. Для XLSX значение совпадает с миграцией 20260928.
  payload := encode(sha256(convert_to(jsonb_build_object(
    'calculation', p_calculation - 'ai_insights',
    'snapshot',    (p_calculation -> 'ai_insights') - 'generatedAt' - 'savedAt',
    'history',     p_history
  )::text, 'UTF8')), 'hex');

  -- Операции пользователя — строго по очереди (та же строка, что блокируют правила
  -- списания): параллельные операции любых режимов делят попытки корректно. Для API
  -- профиль не досоздаётся — как в consume_api_calculation (fail-closed).
  if p_mode <> 'api' then
    insert into public.profiles (id) values (p_user_id) on conflict (id) do nothing;
  end if;
  perform 1 from public.profiles where id = p_user_id for update;

  select * into op from public.calculation_operations where id = p_operation_id;
  if found then
    if op.user_id <> p_user_id or op.mode <> p_mode or op.request_hash <> p_request_hash then
      return jsonb_build_object('ok', false, 'reason', 'operation_conflict');
    end if;
    -- Повтор: ничего не списывается и не пишется, данные повтора не применяются.
    if op.calculation_id is null then
      -- Расчёт удалён из истории: заново не создаётся.
      return jsonb_build_object('ok', true, 'replay', true, 'status', 'deleted',
                                'mode', op.mode, 'charged', op.charged);
    end if;
    saved := public.calculation_operation_saved(op.calculation_id);
    return jsonb_build_object(
      'ok', true, 'replay', true, 'status', 'done', 'mode', op.mode,
      'calculation_id', op.calculation_id,
      'created_at', saved -> 'created_at',
      'snapshot', saved -> 'ai_insights',
      'calculation', saved,
      'content_match', op.payload_hash = payload,
      'charged', op.charged
    );
  end if;

  -- Списание по действующим правилам режима (без дублирования логики):
  -- API — общая бесплатная попытка или безлимит; иначе — ещё и разовые кредиты.
  consumed := case when p_mode = 'api'
                   then public.consume_api_calculation_for(p_user_id)
                   else public.consume_calculation_for(p_user_id) end;
  if coalesce((consumed ->> 'ok')::boolean, false) is not true then
    return jsonb_build_object(
      'ok', false,
      'reason', coalesce(consumed ->> 'reason', 'limit_reached'),
      'used', consumed -> 'used',
      'allowance', consumed -> 'allowance'
    );
  end if;
  charged := coalesce((consumed ->> 'unlimited')::boolean, false) is not true;

  insert into public.calculations
    (user_id, marketplace, mode, revenue, commission, logistics, ads, storage, tax, cost,
     other_expenses, total_expenses, profit, margin, ai_insights)
  values
    (p_user_id,
     p_calculation ->> 'marketplace',
     p_mode,
     (p_calculation ->> 'revenue')::numeric,
     (p_calculation ->> 'commission')::numeric,
     (p_calculation ->> 'logistics')::numeric,
     (p_calculation ->> 'ads')::numeric,
     (p_calculation ->> 'storage')::numeric,
     (p_calculation ->> 'tax')::numeric,
     (p_calculation ->> 'cost')::numeric,
     (p_calculation ->> 'other_expenses')::numeric,
     (p_calculation ->> 'total_expenses')::numeric,
     (p_calculation ->> 'profit')::numeric,
     (p_calculation ->> 'margin')::numeric,
     p_calculation -> 'ai_insights')
  returning id, created_at into calc_id, calc_at;

  -- Сводка по месяцам — у XLSX и API (ручной расчёт её не писал и не пишет).
  if p_history is not null then
    insert into public.report_history (user_id, report_month, revenue, expenses, profit, margin)
    values
      (p_user_id,
       (p_history ->> 'report_month')::date,
       (p_history ->> 'revenue')::numeric,
       (p_history ->> 'expenses')::numeric,
       (p_history ->> 'profit')::numeric,
       (p_history ->> 'margin')::numeric)
    returning id into hist_id;
  end if;

  insert into public.calculation_operations
    (id, user_id, mode, request_hash, payload_hash, calculation_id, report_history_id, charged)
  values
    (p_operation_id, p_user_id, p_mode, p_request_hash, payload, calc_id, hist_id, charged);

  saved := public.calculation_operation_saved(calc_id);
  return jsonb_build_object(
    'ok', true, 'replay', false, 'status', 'done', 'mode', p_mode,
    'calculation_id', calc_id,
    'created_at', calc_at,
    'calculation', saved,
    'content_match', true,
    'charged', charged,
    'used', consumed -> 'used',
    'allowance', consumed -> 'allowance',
    'unlimited', coalesce((consumed ->> 'unlimited')::boolean, false)
  );
end;
$$;

revoke all on function public.calculation_operation_execute(uuid, uuid, text, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- 5. Статус операции (внутренний): только операция этого пользователя и того же
--    запроса; p_mode не null — режим тоже должен совпасть.
create or replace function public.calculation_operation_lookup(
  p_user_id       uuid,
  p_operation_id  uuid,
  p_request_hash  text,
  p_mode          text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  op    public.calculation_operations%rowtype;
  saved jsonb;
begin
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into op from public.calculation_operations
   where id = p_operation_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', true, 'status', 'none');
  end if;
  if op.request_hash is distinct from p_request_hash
     or (p_mode is not null and op.mode is distinct from p_mode) then
    return jsonb_build_object('ok', true, 'status', 'conflict');
  end if;
  if op.calculation_id is null then
    return jsonb_build_object('ok', true, 'status', 'deleted', 'mode', op.mode);
  end if;
  saved := public.calculation_operation_saved(op.calculation_id);
  return jsonb_build_object(
    'ok', true, 'status', 'done', 'mode', op.mode,
    'calculation_id', op.calculation_id,
    'created_at', saved -> 'created_at',
    'snapshot', saved -> 'ai_insights',
    'calculation', saved
  );
end;
$$;

revoke all on function public.calculation_operation_lookup(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

-- 6. Публичные функции пользователя (authenticated, пользователь из JWT).
--    XLSX — контракт миграции 20260928 без изменений (только режим upload).
create or replace function public.save_calculation_operation(
  p_operation_id  uuid,
  p_mode          text,
  p_request_hash  text,
  p_calculation   jsonb,
  p_history       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if p_mode is distinct from 'upload' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;
  return public.calculation_operation_execute(
    auth.uid(), p_operation_id, 'upload', p_request_hash, p_calculation, p_history);
end;
$$;

-- Ручной расчёт: только режим manual (строку mode 'api' так не создать).
create or replace function public.save_manual_calculation_operation(
  p_operation_id  uuid,
  p_request_hash  text,
  p_calculation   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.calculation_operation_execute(
    auth.uid(), p_operation_id, 'manual', p_request_hash, p_calculation, null);
end;
$$;

revoke all on function public.save_manual_calculation_operation(uuid, text, jsonb) from public, anon;
grant execute on function public.save_manual_calculation_operation(uuid, text, jsonb) to authenticated;

-- Статус своей операции (любой режим; режим возвращается в ответе).
create or replace function public.calculation_operation_status(
  p_operation_id  uuid,
  p_request_hash  text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return public.calculation_operation_lookup(auth.uid(), p_operation_id, p_request_hash, null);
end;
$$;

-- 7. Ozon API — ТОЛЬКО сервер (service_role). Результат считает маршрут из данных
--    Ozon; пользователь передаётся маршрутом из проверенного токена.
create or replace function public.save_api_calculation_operation(
  p_user_id       uuid,
  p_operation_id  uuid,
  p_request_hash  text,
  p_calculation   jsonb,
  p_history       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.calculation_operation_execute(
    p_user_id, p_operation_id, 'api', p_request_hash, p_calculation, p_history);
end;
$$;

revoke all on function public.save_api_calculation_operation(uuid, uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_api_calculation_operation(uuid, uuid, text, jsonb, jsonb)
  to service_role;

create or replace function public.api_calculation_operation_status(
  p_user_id       uuid,
  p_operation_id  uuid,
  p_request_hash  text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return public.calculation_operation_lookup(p_user_id, p_operation_id, p_request_hash, 'api');
end;
$$;

revoke all on function public.api_calculation_operation_status(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.api_calculation_operation_status(uuid, uuid, text)
  to service_role;

-- 8. RLS: строки mode = 'api' пишет только сервер — пользователь не может сам
--    вставить такую строку или изменить её (чтение и удаление своих — как раньше).
drop policy if exists "calculations_insert_own" on public.calculations;
create policy "calculations_insert_own"
  on public.calculations for insert
  with check (auth.uid() = user_id and mode is distinct from 'api');

drop policy if exists "calculations_update_own" on public.calculations;
create policy "calculations_update_own"
  on public.calculations for update
  using (auth.uid() = user_id and mode is distinct from 'api')
  with check (auth.uid() = user_id and mode is distinct from 'api');
