-- ============================================================================
-- READ-ONLY проверки для миграции 20260927_unlimited_payment_extension.sql
-- Только SELECT в транзакции READ ONLY: ничего не создаёт, не меняет и не удаляет.
-- Персональных данных не выводит — только признаки схемы и агрегированные числа.
-- Запускать в Supabase SQL Editor по одному разделу.
-- ============================================================================

-- ─── РАЗДЕЛ «ДО»: перед применением миграции ────────────────────────────────
-- Ожидается:
--   • tables_ok = true, roles_ok = true;
--   • already_table = false и already_function = false (миграция ещё не применялась;
--     если true — она уже применена, повторный запуск безопасен);
--   • status_check содержит 'pending' и 'active';
--   • duplicate_payment_ids = 0 — иначе сообщить разработчику (миграцию это не
--     блокирует: журнал всё равно не даст одному платежу выдать доступ дважды);
--   • legacy_half_processed — подписки безлимита, которые старый код отметил active,
--     но срок профиля меньше срока подписки (сбой между двумя запросами старого кода).
--     Новый код их НЕ чинит автоматически (исторические сроки не пересчитываются);
--     при значении > 0 владелец решает вручную.
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
  (select count(*) from public.subscriptions s
     join public.profiles p on p.id = s.user_id
    where s.plan = 'unlimited' and s.status = 'active'
      and s.expires_at is not null
      and (p.premium_until is null or p.premium_until < s.expires_at))          as legacy_half_processed;

rollback;

-- ─── РАЗДЕЛ «ПОСЛЕ»: сразу после применения миграции ────────────────────────
-- Ожидается: все колонки *_ok = true, activations = 0. Сводка по тарифам и статусам
-- из раздела «ДО» не изменилась (миграция существующие строки не трогает).
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
  (select count(*) from public.payment_activations)                             as activations;

select plan, status, count(*) as subscriptions
  from public.subscriptions
 group by plan, status
 order by plan, status;

rollback;

-- ─── РАЗДЕЛ «ПОСЛЕ ДЕПЛОЯ»: после выпуска кода (можно повторять) ────────────
-- Ожидается: все *_mismatch = 0.
--   • activations — сколько платежей безлимита обработал новый код;
--   • gap_legacy_activations — безлимиты, активированные СТАРЫМ кодом после
--     применения миграции (промежуток до деплоя кода): их срок посчитан по-старому
--     («сейчас + 30», без остатка). Впишите время применения миграции вместо
--     '2000-01-01 00:00:00+00'. Автоматически ничего не исправляется.
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
