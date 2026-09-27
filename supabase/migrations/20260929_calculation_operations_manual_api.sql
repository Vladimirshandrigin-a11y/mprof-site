-- ============================================================================
-- MIGRATION: операции расчёта для ручного режима и Ozon API (поверх
--            20260928_calculation_operations.sql — та миграция уже применена и
--            здесь не меняется)
--
--   >>> ПРИМЕНИТЬ ВРУЧНУЮ в Supabase SQL Editor. Автоматически НЕ применяется. <<<
--   >>> Порядок выпуска: 1) read-only supabase/checks/calculation_operations_manual_api.sql,
--   >>> раздел «ДО»; 2) эта миграция; 3) раздел «ПОСЛЕ»; 4) merge и публикация кода
--   >>> в Timeweb; 5) раздел «СОГЛАСОВАННОСТЬ». Старый код с этой миграцией работает
--   >>> как раньше (см. «Совместимость»). Подробности — в PR.
--
-- Было: ручной расчёт списывал попытку (consume_calculation) и ОТДЕЛЬНЫМ запросом
-- писал calculations; Ozon API — consume_api_calculation и insert в одном HTTP-запросе,
-- но в разных транзакциях. Сбой записи оставлял списанную попытку без расчёта,
-- повтор после потерянного ответа списывал ещё раз.
--
-- Стало — тот же журнал calculation_operations и та же схема операции, что у XLSX:
--   • журнал принимает режимы upload | manual | api;
--   • правила списания — ОДНА реализация на пользователя: consume_calculation_for(uid)
--     и consume_api_calculation_for(uid). Публичные consume_calculation() и
--     consume_api_calculation() — обёртки с прежним поведением (auth.uid());
--   • calculation_operation_execute() — внутренняя операция (блокировка профиля,
--     повтор без записи, списание по правилам режима, calculations, report_history для
--     upload/api, журнал) — одна транзакция, сбой откатывает всё;
--   • save_calculation_operation — XLSX (контракт #107 без изменений);
--     save_manual_calculation_operation — ручной режим (только mode 'manual');
--     обе — authenticated, пользователь из JWT;
--   • save_api_calculation_operation / api_calculation_operation_status — ТОЛЬКО
--     service_role (маршрут /api/ozon/save-calculation): результат API считает сервер
--     из данных Ozon, клиент не может записать API-расчёт или применить к нему правила
--     ручного списания;
--   • статус и повтор отдают сохранённую строку расчёта (восстановление без пересчёта);
--   • RLS: пользователь не может сам вставить или изменить строку mode = 'api'
--     (API-расчёты пишет только сервер).
--
-- Совместимость: старый код (29b275b) с этой миграцией — XLSX через прежние функции,
-- ручной и API — через consume_* (обёртки с тем же поведением) и вставку service role.
-- Новый код без этой миграции — ручной и API сохранения отвечают 503, раздельного
-- списания нет.
--
-- Идемпотентна: повторный запуск ничего не ломает. Существующие строки не меняются.
-- ============================================================================
begin;

-- Предпосылки: применена миграция 20260928 (журнал и функции XLSX).
do $$
begin
  if to_regclass('public.calculation_operations') is null
     or to_regprocedure('public.save_calculation_operation(uuid,text,text,jsonb,jsonb)') is null
     or to_regprocedure('public.calculation_operation_status(uuid,text)') is null then
    raise exception 'calculation_operations_manual_api: сначала миграция 20260928_calculation_operations.sql';
  end if;
  if to_regprocedure('public.consume_calculation()') is null
     or to_regprocedure('public.consume_api_calculation()') is null then
    raise exception 'calculation_operations_manual_api: нет consume_calculation() / consume_api_calculation()';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'calculation_operations_manual_api: нет ролей authenticated / service_role';
  end if;
end $$;

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

commit;

-- PostgREST (Supabase API) перечитывает схему, чтобы увидеть новые функции.
notify pgrst, 'reload schema';
