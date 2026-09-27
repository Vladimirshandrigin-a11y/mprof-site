-- ============================================================================
-- READ-ONLY проверки для миграции 20260928_calculation_operations.sql
-- Только SELECT: ничего не создаёт, не меняет и не удаляет. Персональных данных не
-- выводит — только признаки схемы и агрегированные числа.
--
-- Как запускать в Supabase SQL Editor: КАЖДЫЙ SELECT ОТДЕЛЬНО (выделить запрос от select
-- до «;» и выполнить только выделенное). При запуске раздела целиком редактор покажет
-- лишь результат последнего оператора. Обёртка begin read only / rollback нужна только
-- при запуске раздела целиком через psql.
--
-- Когда запускать: «ДО» — перед миграцией; «ПОСЛЕ» — сразу после неё;
-- «СОГЛАСОВАННОСТЬ» — после публикации кода и первых расчётов по XLSX (можно повторять).
-- ============================================================================

-- ─── РАЗДЕЛ «ДО»: перед применением миграции ────────────────────────────────
-- Ожидается: tables_ok, consume_ok, roles_ok, calc_columns_ok, history_columns_ok,
-- mode_upload_ok = true; already_table = false и already_functions = false (миграция ещё
-- не применялась; если true — уже применена, повторный запуск безопасен). Любое другое
-- false — не применять, сообщить разработчику.
begin read only;

select
  to_regclass('public.calculations') is not null
    and to_regclass('public.report_history') is not null
    and to_regclass('public.profiles') is not null                              as tables_ok,
  to_regprocedure('public.consume_calculation()') is not null                   as consume_ok,
  (select count(*) = 2 from pg_roles where rolname in ('anon', 'authenticated')) as roles_ok,
  (select count(*) = 15 from information_schema.columns
    where table_schema = 'public' and table_name = 'calculations'
      and column_name in ('user_id', 'marketplace', 'mode', 'revenue', 'commission', 'logistics',
                          'ads', 'storage', 'tax', 'cost', 'other_expenses', 'total_expenses',
                          'profit', 'margin', 'ai_insights'))                   as calc_columns_ok,
  (select count(*) = 6 from information_schema.columns
    where table_schema = 'public' and table_name = 'report_history'
      and column_name in ('user_id', 'report_month', 'revenue', 'expenses', 'profit', 'margin'))
                                                                                as history_columns_ok,
  exists (select 1 from pg_constraint
           where conrelid = 'public.calculations'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%mode%' and pg_get_constraintdef(oid) like '%upload%')
                                                                                as mode_upload_ok,
  to_regclass('public.calculation_operations') is not null                      as already_table,
  to_regprocedure('public.save_calculation_operation(uuid,text,text,text,jsonb,jsonb)') is not null
    or to_regprocedure('public.calculation_operation_status(uuid,text)') is not null
                                                                                as already_functions;

-- Сводка (только числа): сколько расчётов в каждом режиме.
select mode, count(*) as calculations
  from public.calculations
 group by mode
 order by mode;

rollback;

-- ─── РАЗДЕЛ «ПОСЛЕ»: сразу после применения миграции ────────────────────────
-- Ожидается: все *_ok = true. operations — сколько операций уже выполнено (сразу после
-- миграции обычно 0; больше 0 — новый код уже работает, это не ошибка).
begin read only;

select
  to_regclass('public.calculation_operations') is not null                      as table_ok,
  (select relrowsecurity from pg_class
    where oid = 'public.calculation_operations'::regclass)                       as rls_ok,
  (select count(*) = 0 from pg_policies
    where schemaname = 'public' and tablename = 'calculation_operations')       as no_policies_ok,
  not has_table_privilege('anon', 'public.calculation_operations', 'select,insert,update,delete')
    and not has_table_privilege('authenticated', 'public.calculation_operations', 'select,insert,update,delete')
                                                                                as table_closed_for_browser_ok,
  to_regprocedure('public.save_calculation_operation(uuid,text,text,text,jsonb,jsonb)') is not null
    and to_regprocedure('public.calculation_operation_status(uuid,text)') is not null
                                                                                as functions_ok,
  (select bool_and(prosecdef) from pg_proc
    where oid in (to_regprocedure('public.save_calculation_operation(uuid,text,text,text,jsonb,jsonb)'),
                  to_regprocedure('public.calculation_operation_status(uuid,text)'))) as security_definer_ok,
  not has_function_privilege('anon', 'public.save_calculation_operation(uuid,text,text,text,jsonb,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.calculation_operation_status(uuid,text)', 'execute')
                                                                                as functions_closed_for_anon_ok,
  not exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid in (to_regprocedure('public.save_calculation_operation(uuid,text,text,text,jsonb,jsonb)'),
                     to_regprocedure('public.calculation_operation_status(uuid,text)'))
       and a.grantee = 0 and a.privilege_type = 'EXECUTE')                      as functions_closed_for_public_ok,
  has_function_privilege('authenticated', 'public.save_calculation_operation(uuid,text,text,text,jsonb,jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.calculation_operation_status(uuid,text)', 'execute')
                                                                                as functions_authenticated_ok,
  (select count(*) from public.calculation_operations)                          as operations;

rollback;

-- ─── РАЗДЕЛ «СОГЛАСОВАННОСТЬ»: после публикации кода (можно повторять) ───────
-- Ожидается: все *_mismatch = 0.
--   • operations — сколько расчётов по XLSX сохранено операциями;
--   • charged / not_charged — со списанием попытки / на безлимите (справочно);
--   • deleted_by_user — строку расчёта пользователь удалил из истории (справочно);
--   • user_mismatch — строка расчёта или сводки принадлежит другому пользователю;
--   • mode_mismatch — строка расчёта не режима upload.
-- Любое ненулевое *_mismatch: ничего не исправлять автоматически, сообщить разработчику.
begin read only;

select
  (select count(*) from public.calculation_operations)                          as operations,
  (select count(*) from public.calculation_operations where charged)            as charged,
  (select count(*) from public.calculation_operations where not charged)        as not_charged,
  (select count(*) from public.calculation_operations where calculation_id is null) as deleted_by_user,
  (select count(*) from public.calculation_operations o
     left join public.calculations c on c.id = o.calculation_id
     left join public.report_history h on h.id = o.report_history_id
    where (c.id is not null and c.user_id <> o.user_id)
       or (h.id is not null and h.user_id <> o.user_id))                        as user_mismatch,
  (select count(*) from public.calculation_operations o
     join public.calculations c on c.id = o.calculation_id
    where c.mode <> o.mode)                                                     as mode_mismatch;

rollback;
