-- ============================================================================
-- READ-ONLY проверка перед миграцией 20260926_products_article_unique.sql
-- Только SELECT в транзакции READ ONLY: ничего не создаёт, не меняет и не удаляет
-- (в том числе не создаёт функцию — ключ вычислен тем же выражением прямо в запросах).
-- Запускать запросы по одному в Supabase SQL Editor и читать результат.
--
-- Что делать с результатом:
--   • Запрос 2 пуст (конфликтов нет) → миграцию можно применять.
--   • Есть строки → миграция НЕ применится (она остановится сама). Для каждой группы
--     владелец решает по данным: какая строка остаётся, какую стоимость считать верной,
--     что делать с остальными. Автоматически ничего не удаляется и стоимость не выбирается.
--     Ориентир: колонка costs_differ = true означает разные стоимости — нужен ручной выбор.
-- ============================================================================
begin read only;

-- 0) Окружение: должно быть case_mapping_ok = true и encoding = UTF8.
select
  lower(E'  АрТ\u00a0 1\t') = E'  арт\u00a0 1\t' as case_mapping_ok,
  current_setting('server_encoding')              as encoding,
  (select datcollate from pg_database where datname = current_database()) as collation;

-- 1) Сводка.
with keyed as (
  select
    id, user_id, sku, cost_price,
    nullif(lower(btrim(regexp_replace(sku,
      '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'), ' ')), '') as k
  from public.products
), groups as (
  select user_id, k, count(*) as c
  from keyed
  where k is not null
  group by user_id, k
)
select
  (select count(*) from keyed)                                      as products_total,
  (select count(*) from keyed where k is null)                      as without_article,
  (select count(*) from groups where c > 1)                         as conflict_groups,
  coalesce((select sum(c) from groups where c > 1), 0)              as conflict_rows,
  (select count(distinct user_id) from groups where c > 1)          as users_affected;

-- 2) Группы-конфликты (колонка raw_skus показывает исходные написания: сюда попадают
--    и строки, отличающиеся только регистром/пробелами — расчёт считает их одним артикулом): по одной строке на группу. Пусто → конфликтов нет.
with keyed as (
  select
    id, user_id, sku, name, cost_price, created_at,
    nullif(lower(btrim(regexp_replace(sku,
      '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'), ' ')), '') as k
  from public.products
)
select
  user_id,
  k                                                          as canonical_key,
  count(*)                                                   as rows_in_group,
  array_agg(id order by created_at, id)                      as product_ids,
  array_agg(sku order by created_at, id)                     as raw_skus,
  array_agg(name order by created_at, id)                    as names,
  array_agg(cost_price order by created_at, id)              as costs,
  count(distinct cost_price) > 1                             as costs_differ,
  count(*) filter (where cost_price is not null and cost_price > 0) as rows_with_valid_cost,
  min(created_at)                                            as first_created,
  max(created_at)                                            as last_created
from keyed
where k is not null
group by user_id, k
having count(*) > 1
order by user_id, k;

rollback;
