-- ============================================================================
-- MIGRATION (PR #43): ozon_performance_connections
--
--   >>> ПРИМЕНИТЬ ВРУЧНУЮ в Supabase SQL Editor ПЕРЕД merge/deploy. <<<
--   Автоматически этот SQL НЕ применяется. Идемпотентно (if not exists) —
--   повторный прогон безопасен. Тот же блок добавлен и в supabase/schema.sql,
--   чтобы канонический дамп схемы оставался полным.
--
-- Назначение: безопасное хранение кредов Ozon PERFORMANCE API (реклама/
-- продвижение) для будущего автоматического подтягивания рекламных расходов.
-- FOUNDATION: сама реклама в расчёт прибыли пока НЕ добавляется.
--
-- ОТДЕЛЬНАЯ таблица (НЕ ozon_connections), чтобы не рисковать текущим Seller API
-- подключением. Хранит ЗАШИФРОВАННЫЙ client_secret (AES-256-GCM; ключ шифрования —
-- серверный env OZON_KEYS_ENC_SECRET, тот же, что у Seller-ключа; см.
-- app/api/ozon/_lib/crypto.ts) + last4 для отображения (••••1234) + Client ID +
-- статус последней проверки токена.
--
-- БЕЗОПАСНОСТЬ — как у ozon_connections: таблица ПОЛНОСТЬЮ закрыта для клиентских
-- ролей (RLS включён, клиентских policy НЕТ → deny-all для anon/authenticated) +
-- REVOKE ALL. Единственный путь к строке — backend через service-role (мимо RLS),
-- routes /api/ozon/performance/connection*. Зашифрованный секрет и access_token
-- НИКОГДА не уходят в браузер. (Это строже, чем «select/insert own row»: секрет-
-- содержащую таблицу не отдаём клиенту даже как шифротекст; на функциональность
-- не влияет — все routes ходят под service-role.)
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

-- Идемпотентно гарантируем нужные колонки, если таблица уже существовала.
alter table public.ozon_performance_connections add column if not exists secret_last4    text;
alter table public.ozon_performance_connections add column if not exists status          text        not null default 'unknown';
alter table public.ozon_performance_connections add column if not exists last_checked_at timestamptz;
alter table public.ozon_performance_connections add column if not exists last_error      text;
alter table public.ozon_performance_connections add column if not exists created_at      timestamptz not null default now();
alter table public.ozon_performance_connections add column if not exists updated_at      timestamptz not null default now();

-- Уникальность одной строки на пользователя (нужно для upsert onConflict user_id).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ozon_performance_connections_user_id_key'
  ) then
    alter table public.ozon_performance_connections
      add constraint ozon_performance_connections_user_id_key unique (user_id);
  end if;
end $$;

-- Гарантируем check-constraint статуса, даже если колонку добавили без него.
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

-- updated_at автообновляется на каждый UPDATE (тот же паттерн, что ozon_connections).
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

-- ROW LEVEL SECURITY — полный lockdown для клиента (никаких policy + revoke).
alter table public.ozon_performance_connections enable row level security;

-- НАМЕРЕННО НЕТ ни одной policy: под включённым RLS отсутствие policy = deny-all
-- для anon/authenticated. Зашифрованный секрет не должен быть доступен браузеру
-- даже на чтение. Доступ — только backend через service-role (мимо RLS).
revoke all on public.ozon_performance_connections from anon, authenticated;
