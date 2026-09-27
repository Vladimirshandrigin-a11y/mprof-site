-- ============================================================================
-- MIGRATION: продление безлимита (449 ₽) с сохранением оплаченного срока
--
--   >>> ПРИМЕНИТЬ ВРУЧНУЮ в Supabase SQL Editor. Автоматически НЕ применяется. <<<
--   >>> Применять ТОЛЬКО ПОСЛЕ того, как новый код (merge-коммит PR #105) опубликован
--   >>> в Timeweb и активно именно его развёртывание. Порядок выпуска:
--   >>>   1) read-only supabase/checks/unlimited_payment_extension.sql, раздел «ДО»;
--   >>>   2) merge PR #105 (merge сам по себе не публикует код);
--   >>>   3) Timeweb: выбрать merge-коммит, дождаться успешной сборки, убедиться, что
--   >>>      активно развёртывание именно этого коммита;
--   >>>   4) повторить запрос unfinished_legacy_activations из раздела «ДО» — должно быть 0;
--   >>>   5) эта миграция целиком (если остановилась из-за незавершённой активации —
--   >>>      ничего не изменено, повторить через 1–2 минуты);
--   >>>   6) разделы «ПОСЛЕ» и «СОГЛАСОВАННОСТЬ»; если API не видит новую функцию —
--   >>>      отдельно выполнить: notify pgrst, 'reload schema';
--   >>> Между шагами 3 и 5 новый код отвечает на оплату безлимита 500 migration_missing
--   >>> и ничего не записывает; ЮKassa повторяет уведомление 24 часа с момента платежа,
--   >>> после миграции повтор активирует безлимит один раз. Подробности — в PR #105.
--
-- Было: webhook ЮKassa считал срок в JavaScript (время Node-сервера) и ПЕРЕЗАПИСЫВАЛ
-- profiles.premium_until = «сейчас + 30 дней» двумя отдельными запросами без общей
-- транзакции. Повторная покупка при активном безлимите теряла оставшиеся дни.
--
-- Стало: один вызов public.grant_unlimited_payment() — одна транзакция БД:
--   новое окончание = max(текущее premium_until, момент активации) + 30 дней,
--   момент активации = now() сервера БД при ПЕРВОЙ успешной обработке платежа.
--
-- Однократность и конкуренция (всё внутри функции, под блокировками строк):
--   • строка подписки блокируется FOR UPDATE — повторные доставки ОДНОГО платежа
--     выполняются строго по очереди, вторая видит результат первой;
--   • отметка обработки — строка в public.payment_activations (PRIMARY KEY
--     payment_id, UNIQUE subscription_id): один платёж выдаёт доступ не более
--     одного раза даже при аномалиях поиска подписки;
--   • строка профиля блокируется FOR UPDATE — РАЗНЫЕ платежи одного пользователя
--     прибавляют дни последовательно к уже сохранённому сроку, ничего не теряя;
--   • отметка, срок профиля и статус подписки фиксируются одним COMMIT: сбой на любом
--     шаге откатывает всё, повтор начисляет ровно один раз; повтор после успешного
--     COMMIT (потерянный HTTP-ответ) ничего не начисляет.
--
-- Совместимость: подписки, которые старый код уже перевёл в active (или expired),
-- считаются обработанными — дни повторно НЕ выдаются. Существующие сроки и платежи
-- не пересчитываются; миграция не меняет ни одной существующей строки.
--
-- Ограждение от СТАРОГО обработчика (webhook до этого PR). Он пишет срок абсолютным
-- значением «сейчас + 30» двумя отдельными запросами (подписка → профиль); запоздавшая
-- запись стёрла бы продление, уже выданное новым кодом. Поэтому с момента этой миграции
-- БД отклоняет его записи, от кого бы они ни пришли (любой экземпляр старой версии, в том
-- числе уже выполняющийся запрос или откат кода):
--   • роль service_role не может перевести подписку безлимита в active или поменять
--     статус/срок active-подписки иначе как через grant_unlimited_payment();
--   • роль service_role не может поменять profiles.premium_until иначе как через неё.
-- Старый обработчик получает ошибку и отвечает 500 → ЮKassa повторит уведомление, и его
-- обработает новый код. Разовые подписки, отмена pending, /payment/create, SQL Editor
-- (роль postgres) и SECURITY DEFINER-функции ограждение не затрагивает.
-- Незавершённая запись старого обработчика в момент миграции (подписка уже active, профиль
-- ещё не записан) обнаруживается ПОСЛЕ того, как ограждение взяло блокировки таблиц, —
-- тогда миграция останавливается целиком и её нужно повторить позже.
--
-- Доступ: функцию может вызвать ТОЛЬКО service_role (серверный webhook). У PUBLIC,
-- anon и authenticated право EXECUTE отозвано; функция SECURITY INVOKER — даже при
-- случайно выданном EXECUTE браузерной роли не хватило бы прав на запись.
-- Журнал payment_activations: RLS без политик + REVOKE у anon/authenticated.
--
-- Идемпотентна: повторный запуск ничего не ломает (IF NOT EXISTS / OR REPLACE).
-- ============================================================================
begin;

-- Предпосылки: таблицы и роль, на которые опирается функция.
do $$
begin
  if to_regclass('public.subscriptions') is null or to_regclass('public.profiles') is null then
    raise exception 'unlimited_extension: нет public.subscriptions или public.profiles';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'unlimited_extension: нет роли service_role';
  end if;
end $$;

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

commit;

-- PostgREST (Supabase API) перечитывает схему, чтобы увидеть новую функцию.
notify pgrst, 'reload schema';
