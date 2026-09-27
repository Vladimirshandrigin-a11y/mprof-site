-- ============================================================================
-- READ-ONLY проверки для миграции 20260929_calculation_operations_manual_api.sql
-- Только SELECT: ничего не создаёт, не меняет и не удаляет. Персональных данных не
-- выводит — только признаки схемы и агрегированные числа.
--
-- Как запускать в Supabase SQL Editor: КАЖДЫЙ SELECT ОТДЕЛЬНО (выделить запрос от select
-- до «;» и выполнить только выделенное). Обёртка begin read only / rollback нужна только
-- при запуске раздела целиком через psql.
--
-- Когда запускать: «ДО» — перед миграцией; «ПОСЛЕ» — сразу после неё;
-- «СОГЛАСОВАННОСТЬ» — после публикации кода и первых ручных / API-расчётов (можно повторять).
-- ============================================================================

-- ─── РАЗДЕЛ «ДО»: перед применением миграции ────────────────────────────────
-- Ожидается: все *_ok = true; already_applied = false (миграция ещё не применялась).
-- Любое false (или already_applied = true) — не применять, сообщить разработчику.
begin read only;

select
  to_regclass('public.calculation_operations') is not null
    and to_regprocedure('public.save_calculation_operation(uuid,text,text,jsonb,jsonb)') is not null
    and to_regprocedure('public.calculation_operation_status(uuid,text)') is not null
                                                                                as xlsx_operations_ok,
  to_regprocedure('public.consume_calculation()') is not null
    and to_regprocedure('public.consume_api_calculation()') is not null        as consume_ok,
  (select count(*) = 2 from pg_roles where rolname in ('authenticated', 'service_role')) as roles_ok,
  exists (select 1 from pg_constraint
           where conrelid = 'public.calculation_operations'::regclass
             and conname = 'calculation_operations_mode_check')                as journal_mode_check_ok,
  exists (select 1 from pg_constraint
           where conrelid = 'public.calculations'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%manual%'
             and pg_get_constraintdef(oid) like '%upload%'
             and pg_get_constraintdef(oid) like '%api%')                       as calc_modes_ok,
  (select count(*) = 2 from pg_policies
    where schemaname = 'public' and tablename = 'calculations'
      and policyname in ('calculations_insert_own', 'calculations_update_own')) as policies_ok,
  to_regprocedure('public.save_manual_calculation_operation(uuid,text,jsonb)') is not null
    or to_regprocedure('public.save_api_calculation_operation(uuid,uuid,text,jsonb,jsonb)') is not null
    or to_regprocedure('public.consume_calculation_for(uuid)') is not null     as already_applied;

-- Сводка (только числа): операции журнала по режимам (до миграции — только upload).
select mode, count(*) as operations
  from public.calculation_operations
 group by mode
 order by mode;

rollback;

-- ─── РАЗДЕЛ «ПОСЛЕ»: сразу после применения миграции ────────────────────────
-- Ожидается: все *_ok = true.
begin read only;

select
  (select pg_get_constraintdef(oid) like '%upload%'
          and pg_get_constraintdef(oid) like '%manual%'
          and pg_get_constraintdef(oid) like '%api%'
     from pg_constraint
    where conrelid = 'public.calculation_operations'::regclass
      and conname = 'calculation_operations_mode_check')                       as journal_modes_ok,
  to_regprocedure('public.consume_calculation_for(uuid)') is not null
    and to_regprocedure('public.consume_api_calculation_for(uuid)') is not null
    and to_regprocedure('public.calculation_operation_saved(uuid)') is not null
    and to_regprocedure('public.calculation_operation_execute(uuid,uuid,text,text,jsonb,jsonb)') is not null
    and to_regprocedure('public.calculation_operation_lookup(uuid,uuid,text,text)') is not null
    and to_regprocedure('public.save_manual_calculation_operation(uuid,text,jsonb)') is not null
    and to_regprocedure('public.save_api_calculation_operation(uuid,uuid,text,jsonb,jsonb)') is not null
    and to_regprocedure('public.api_calculation_operation_status(uuid,uuid,text)') is not null
                                                                                as functions_ok,
  (select bool_and(prosecdef) from pg_proc
    where oid in (to_regprocedure('public.consume_calculation_for(uuid)'),
                  to_regprocedure('public.consume_api_calculation_for(uuid)'),
                  to_regprocedure('public.calculation_operation_saved(uuid)'),
                  to_regprocedure('public.calculation_operation_execute(uuid,uuid,text,text,jsonb,jsonb)'),
                  to_regprocedure('public.calculation_operation_lookup(uuid,uuid,text,text)'),
                  to_regprocedure('public.save_manual_calculation_operation(uuid,text,jsonb)'),
                  to_regprocedure('public.save_api_calculation_operation(uuid,uuid,text,jsonb,jsonb)'),
                  to_regprocedure('public.api_calculation_operation_status(uuid,uuid,text)'))) as security_definer_ok,
  -- Внутренние функции (правила списания, операция, статус) напрямую не вызвать никому.
  not exists (
    select 1
      from unnest(array['anon', 'authenticated', 'service_role']) r(role),
           unnest(array['public.consume_calculation_for(uuid)',
                        'public.consume_api_calculation_for(uuid)',
                        'public.calculation_operation_saved(uuid)',
                        'public.calculation_operation_execute(uuid,uuid,text,text,jsonb,jsonb)',
                        'public.calculation_operation_lookup(uuid,uuid,text,text)']) f(fn)
     where has_function_privilege(r.role, f.fn, 'execute'))                  as internal_closed_ok,
  -- Ручной расчёт — только authenticated.
  has_function_privilege('authenticated', 'public.save_manual_calculation_operation(uuid,text,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.save_manual_calculation_operation(uuid,text,jsonb)', 'execute')
                                                                                as manual_fn_ok,
  -- Ozon API — только service_role (сервер).
  has_function_privilege('service_role', 'public.save_api_calculation_operation(uuid,uuid,text,jsonb,jsonb)', 'execute')
    and has_function_privilege('service_role', 'public.api_calculation_operation_status(uuid,uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.save_api_calculation_operation(uuid,uuid,text,jsonb,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.api_calculation_operation_status(uuid,uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.save_api_calculation_operation(uuid,uuid,text,jsonb,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.api_calculation_operation_status(uuid,uuid,text)', 'execute')
                                                                                as api_fn_server_only_ok,
  not exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid in (to_regprocedure('public.save_manual_calculation_operation(uuid,text,jsonb)'),
                     to_regprocedure('public.save_api_calculation_operation(uuid,uuid,text,jsonb,jsonb)'),
                     to_regprocedure('public.api_calculation_operation_status(uuid,uuid,text)'))
       and a.grantee = 0 and a.privilege_type = 'EXECUTE')                      as functions_closed_for_public_ok,
  -- Прежние контракты доступны как раньше.
  has_function_privilege('authenticated', 'public.consume_calculation()', 'execute')
    and has_function_privilege('authenticated', 'public.consume_api_calculation()', 'execute')
    and has_function_privilege('authenticated', 'public.save_calculation_operation(uuid,text,text,jsonb,jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.calculation_operation_status(uuid,text)', 'execute')
                                                                                as previous_contracts_ok,
  (select count(*) = 2 from pg_policies
    where schemaname = 'public' and tablename = 'calculations'
      and policyname in ('calculations_insert_own', 'calculations_update_own')
      and coalesce(with_check, '') like '%api%')                              as api_rows_server_only_ok;

-- Сводка (только числа): операции журнала по режимам (сразу после миграции — как в «ДО»).
select mode, count(*) as operations
  from public.calculation_operations
 group by mode
 order by mode;

rollback;

-- ─── РАЗДЕЛ «СОГЛАСОВАННОСТЬ»: после публикации кода (можно повторять) ───────
-- Ожидается: все *_mismatch = 0.
--   • operations_* — сколько расчётов сохранено операциями по режимам (справочно);
--   • deleted_by_user — строку расчёта пользователь удалил из истории (справочно);
--   • user_mismatch — строка расчёта или сводки принадлежит другому пользователю;
--   • mode_mismatch — режим строки расчёта не совпадает с режимом операции;
--   • manual_history_mismatch — у ручной операции есть строка сводки (ручной её не пишет);
--   • api_charge_mismatch — операция API списала попытку сверх бесплатной (у API
--     списывается только общая бесплатная; разовые кредиты API не открывают).
-- Любое ненулевое *_mismatch: ничего не исправлять автоматически, сообщить разработчику.
begin read only;

select
  (select count(*) from public.calculation_operations where mode = 'upload')   as operations_upload,
  (select count(*) from public.calculation_operations where mode = 'manual')   as operations_manual,
  (select count(*) from public.calculation_operations where mode = 'api')      as operations_api,
  (select count(*) from public.calculation_operations where calculation_id is null) as deleted_by_user,
  (select count(*) from public.calculation_operations o
     left join public.calculations c on c.id = o.calculation_id
     left join public.report_history h on h.id = o.report_history_id
    where (c.id is not null and c.user_id <> o.user_id)
       or (h.id is not null and h.user_id <> o.user_id))                        as user_mismatch,
  (select count(*) from public.calculation_operations o
     join public.calculations c on c.id = o.calculation_id
    where c.mode <> o.mode)                                                     as mode_mismatch,
  (select count(*) from public.calculation_operations
    where mode = 'manual' and report_history_id is not null)                   as manual_history_mismatch,
  (select count(*) from (
      select user_id from public.calculation_operations
       where mode = 'api' and charged
       group by user_id having count(*) > 1) x)                                 as api_charge_mismatch;

rollback;
