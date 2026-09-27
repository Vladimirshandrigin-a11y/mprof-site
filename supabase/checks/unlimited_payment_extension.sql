-- ============================================================================
-- READ-ONLY проверки для миграции 20260927_unlimited_payment_extension.sql
-- Только SELECT: ничего не создаёт, не меняет и не удаляет. Персональных данных не
-- выводит — только признаки схемы и агрегированные числа.
--
-- Как запускать в Supabase SQL Editor: КАЖДЫЙ SELECT ОТДЕЛЬНО (выделить запрос от select
-- до «;» и выполнить только выделенное). При запуске раздела целиком редактор покажет
-- лишь результат последнего оператора. Обёртка begin read only / rollback нужна только
-- при запуске раздела целиком через psql.
--
-- Когда запускать (порядок выпуска PR #105):
--   • «ДО» — перед merge; запрос с unfinished_legacy_activations — ещё раз сразу перед
--     миграцией, уже после того, как в Timeweb активно развёртывание нового кода;
--   • «ПОСЛЕ» — сразу после успешной миграции;
--   • «СОГЛАСОВАННОСТЬ» — сразу после миграции и затем после оплат безлимита.
-- ============================================================================

-- ─── РАЗДЕЛ «ДО»: перед применением миграции ────────────────────────────────
-- Ожидается:
--   • tables_ok = true, roles_ok = true;
--   • already_table = false и already_function = false (миграция ещё не применялась;
--     если true — она уже применена, повторный запуск безопасен);
--   • status_check содержит 'pending' и 'active';
--   • duplicate_payment_ids = 0 — иначе не переходить к миграции до выяснения причины
--     (технически миграцию это не блокирует: журнал всё равно не даст одному платежу
--     выдать доступ дважды);
--   • unfinished_legacy_activations = 0 — то же условие, что проверяет миграция: у
--     пользователя с действующей active-подпиской безлимита срок профиля не совпадает со
--     сроком самой поздней из них (старый обработчик отметил подписку, но ещё не записал
--     профиль, или срок меняли вручную). При > 0 миграция остановится; если значение не
--     обнуляется за 1–2 минуты — это не текущая запись, а данные: не переходить к
--     миграции, статусы и сроки не менять, сначала выяснить причину.
--     Автоматически ничего не исправляется.
begin read only;

select
  to_regclass('public.subscriptions') is not null
    and to_regclass('public.profiles') is not null                              as tables_ok,
  (select count(*) = 3 from pg_roles
    where rolname in ('service_role', 'anon', 'authenticated'))                 as roles_ok,
  to_regclass('public.payment_activations') is not null                         as already_table,
  to_regprocedure('public.grant_unlimited_payment(uuid,text)') is not null      as already_function,
  (select string_agg(pg_get_constraintdef(c.oid), '; ')
     from pg_constraint c
    where c.conrelid = 'public.subscriptions'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%status%')                          as status_check,
  (select string_agg(column_name || ':' || data_type, ', ' order by column_name)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'subscriptions'
      and column_name in ('id', 'user_id', 'plan', 'status', 'provider_payment_id',
                          'starts_at', 'expires_at'))                           as subscription_columns,
  (select string_agg(column_name || ':' || data_type, ', ' order by column_name)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name in ('id', 'plan', 'premium_until'))                       as profile_columns;

-- Сводка платежей по тарифу и статусу (только числа).
select plan, status, count(*) as subscriptions
  from public.subscriptions
 group by plan, status
 order by plan, status;

select
  (select count(*) from (
     select provider_payment_id from public.subscriptions
      where provider_payment_id is not null
      group by provider_payment_id having count(*) > 1) d)                     as duplicate_payment_ids,
  (select count(*) from public.profiles
    where plan = 'unlimited' and premium_until > now())                          as unlimited_active_now,
  (select count(*) from public.profiles
    where plan = 'unlimited' and (premium_until is null or premium_until <= now())) as unlimited_expired,
  (select count(*) from (
     select distinct on (s.user_id) s.user_id, s.expires_at
       from public.subscriptions s
      where s.plan = 'unlimited' and s.status = 'active' and s.expires_at is not null
      order by s.user_id, s.expires_at desc) latest
     left join public.profiles p on p.id = latest.user_id
    where latest.expires_at > now()
      and p.premium_until is distinct from latest.expires_at)                   as unfinished_legacy_activations;

rollback;

-- ─── РАЗДЕЛ «ПОСЛЕ»: сразу после применения миграции ────────────────────────
-- Ожидается: все колонки *_ok = true (включая fence_ok — ограждение от старого
-- обработчика). Любое *_ok = false: новый код безлимит не выдаёт (500), ЮKassa повторяет
-- уведомления; сообщить разработчику, код не откатывать, ограждение не снимать.
-- activations — сколько платежей безлимита уже выдал новый код; может быть > 0 сразу
-- после миграции (ожидавшее уведомление ЮKassa могло прийти тут же). Это не ошибка —
-- согласованность выдач проверяет раздел «СОГЛАСОВАННОСТЬ».
-- Сводка по тарифам и статусам может отличаться от раздела «ДО» из-за новых платежей
-- (новые pending, активации, отмены); сама миграция существующие строки не меняет.
begin read only;

select
  to_regclass('public.payment_activations') is not null                         as table_ok,
  (select relrowsecurity from pg_class
    where oid = 'public.payment_activations'::regclass)                          as rls_ok,
  (select count(*) = 0 from pg_policies
    where schemaname = 'public' and tablename = 'payment_activations')          as no_policies_ok,
  not has_table_privilege('anon', 'public.payment_activations', 'select,insert,update,delete')
    and not has_table_privilege('authenticated', 'public.payment_activations', 'select,insert,update,delete')
                                                                                as table_closed_for_browser_ok,
  has_table_privilege('service_role', 'public.payment_activations', 'select')
    and has_table_privilege('service_role', 'public.payment_activations', 'insert')
                                                                                as table_service_role_ok,
  to_regprocedure('public.grant_unlimited_payment(uuid,text)') is not null      as function_ok,
  (select not prosecdef from pg_proc
    where oid = to_regprocedure('public.grant_unlimited_payment(uuid,text)'))   as security_invoker_ok,
  not has_function_privilege('anon', 'public.grant_unlimited_payment(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.grant_unlimited_payment(uuid,text)', 'execute')
                                                                                as function_closed_for_browser_ok,
  not exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = to_regprocedure('public.grant_unlimited_payment(uuid,text)')
       and a.grantee = 0 and a.privilege_type = 'EXECUTE')                      as function_closed_for_public_ok,
  has_function_privilege('service_role', 'public.grant_unlimited_payment(uuid,text)', 'execute')
                                                                                as function_service_role_ok,
  (select count(*) = 2 from pg_trigger
    where tgname = 'guard_unlimited_writes' and tgenabled = 'O'
      and tgrelid in ('public.subscriptions'::regclass, 'public.profiles'::regclass)) as fence_ok,
  (select count(*) from public.payment_activations)                             as activations;

select plan, status, count(*) as subscriptions
  from public.subscriptions
 group by plan, status
 order by plan, status;

rollback;

-- ─── РАЗДЕЛ «СОГЛАСОВАННОСТЬ»: после миграции (можно повторять) ─────────────
-- Ожидается: все *_mismatch = 0 и gap_legacy_activations = 0.
--   • activations — сколько платежей безлимита выдал новый код (растёт с оплатами);
--   • subscription_mismatch — отметка журнала не совпадает со своей подпиской;
--   • rule_mismatch — срок выдан не по правилу max(прежний срок, активация) + 30 дней;
--   • profile_behind_mismatch — срок в профиле меньше выданного по отметке;
--   • gap_legacy_activations — безлимиты, активированные после применения миграции без
--     отметки в журнале. Ограждение не даёт старому обработчику их создавать, поэтому
--     ожидается 0. Впишите время применения миграции (UTC; момент успешного выполнения
--     или чуть позже) вместо '2000-01-01 00:00:00+00' — более раннее время захватит
--     активации, сделанные старым кодом до миграции.
-- Любое ненулевое *_mismatch или gap_legacy_activations: ничего не исправлять
-- автоматически, сообщить разработчику.
begin read only;

with m as (select timestamptz '2000-01-01 00:00:00+00' as migration_applied_at)
select
  (select count(*) from public.payment_activations)                             as activations,
  (select count(*) from public.payment_activations a
     join public.subscriptions s on s.id = a.subscription_id
    where s.status <> 'active' or s.plan <> 'unlimited'
       or s.user_id <> a.user_id or s.expires_at <> a.premium_until_after)       as subscription_mismatch,
  (select count(*) from public.payment_activations a
    where a.premium_until_after
          <> greatest(coalesce(a.premium_until_before, a.activated_at), a.activated_at)
             + interval '30 days')                                              as rule_mismatch,
  (select count(*) from public.payment_activations a
     join public.profiles p on p.id = a.user_id
    where p.premium_until is null or p.premium_until < a.premium_until_after)   as profile_behind_mismatch,
  (select count(*) from public.subscriptions s, m
    where s.plan = 'unlimited' and s.status = 'active'
      and s.starts_at >= m.migration_applied_at
      and not exists (select 1 from public.payment_activations a
                       where a.subscription_id = s.id))                          as gap_legacy_activations;

rollback;
