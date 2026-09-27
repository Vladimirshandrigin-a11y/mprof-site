-- ============================================================================
-- MIGRATION: атомарное списание попытки и сохранение расчёта по XLSX
--            «Отчёт по начислениям» (операции расчёта)
--
--   >>> ПРИМЕНИТЬ ВРУЧНУЮ в Supabase SQL Editor. Автоматически НЕ применяется. <<<
--   >>> Порядок выпуска: 1) read-only supabase/checks/calculation_operations.sql,
--   >>> раздел «ДО»; 2) эта миграция; 3) раздел «ПОСЛЕ»; 4) merge и публикация кода
--   >>> в Timeweb; 5) раздел «СОГЛАСОВАННОСТЬ». Старый код с этой миграцией работает
--   >>> как раньше (consume_calculation и таблицы не меняются). Подробности — в PR.
--
-- Было: браузер списывал попытку (/api/cloud/consume → consume_calculation) и затем
-- ОТДЕЛЬНЫМИ запросами писал calculations и report_history. Обрыв между запросами,
-- перезагрузка страницы или потерянный ответ оставляли списанную попытку без
-- сохранённого расчёта: отметка «оплачено» жила только в памяти вкладки.
--
-- Стало: public.save_calculation_operation() — ОДНА транзакция БД:
--   • строка профиля блокируется FOR UPDATE — операции пользователя идут по очереди;
--   • операция с тем же id уже есть → повтор: НИЧЕГО не списывается и не пишется.
--     Возвращается сохранённый расчёт (его снимок) и признак, совпадают ли данные
--     повтора с сохранёнными (content_match); расчёт удалён пользователем → статус
--     «deleted», без повторного создания расчёта и сводки;
--   • иначе — списание по действующим правилам (вызов consume_calculation(): общая
--     бесплатная попытка, разовые кредиты, безлимит без расхода), затем строки
--     calculations и report_history и отметка операции. Сбой на любом шаге откатывает
--     всё: ни списания, ни частичных записей.
-- Операция привязана к пользователю, к конкретному файлу (request_hash — отпечаток
-- разобранного отчёта) и к сохранённым данным (payload_hash — SHA-256 расчёта, снимка
-- без времени формирования и строки сводки; считает сервер при первом сохранении).
-- Тот же id с другим файлом или от другого пользователя → operation_conflict, без
-- данных чужой операции. Удаление расчёта из истории журнал не стирает: ссылка на
-- строку обнуляется, факт завершённой операции остаётся.
--
-- Доступ: функции выполняются от владельца (SECURITY DEFINER), пользователь — из JWT
-- (auth.uid()), как у consume_calculation. EXECUTE — только authenticated. Журнал
-- calculation_operations: RLS без политик + REVOKE у anon/authenticated — прочитать
-- или изменить отметки напрямую нельзя, только через функции.
--
-- Идемпотентна: повторный запуск ничего не ломает (IF NOT EXISTS / OR REPLACE).
-- Существующие строки не меняются; исторические списания не пересчитываются.
-- ============================================================================
begin;

-- Предпосылки.
do $$
begin
  if to_regclass('public.calculations') is null
     or to_regclass('public.report_history') is null
     or to_regclass('public.profiles') is null then
    raise exception 'calculation_operations: нет calculations / report_history / profiles';
  end if;
  if to_regprocedure('public.consume_calculation()') is null then
    raise exception 'calculation_operations: нет функции public.consume_calculation()';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'calculation_operations: нет роли authenticated';
  end if;
end $$;

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

commit;

-- PostgREST (Supabase API) перечитывает схему, чтобы увидеть новые функции.
notify pgrst, 'reload schema';
