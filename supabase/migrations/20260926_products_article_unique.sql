-- ============================================================================
-- MIGRATION (PR #99): уникальность артикула в каталоге по КАНОНИЧЕСКОМУ ключу
--
--   >>> ПРИМЕНИТЬ ВРУЧНУЮ в Supabase SQL Editor. Автоматически НЕ применяется. <<<
--   >>> СНАЧАЛА запустить read-only проверку supabase/checks/products_article_conflicts.sql
--   >>> и убедиться, что конфликтов нет. При конфликтах эта миграция САМА остановится
--   >>> и ничего не изменит (ничего не удаляет, стоимость не выбирает).
--
-- Зачем: автодобавление товаров (XLSX и API-расчёт) и ручное добавление в каталог
-- могут выполняться одновременно из разных инстансов сервера и из браузера. Только
-- ограничение в БД защищает от дубликатов при любой гонке и любом пути записи.
--
-- Ключ = ровно нормализация расчёта (normArticleKey / normArticle в приложении):
--   trim → lower → любые пробельные символы (включая NBSP, табуляцию, U+2000–200A,
--   U+3000, BOM) подряд → один пробел. Пустой ключ = NULL (товары без артикула не
--   конфликтуют друг с другом, как и в расчётах, где пустой артикул не сопоставляется).
-- Уникальны (user_id, ключ): разные написания одного артикула («Art  1», «ART 1»,
-- « art 1 ») — одна строка; у разных пользователей одинаковые артикулы разрешены.
--
-- Известное ограничение ключа: lower() в PostgreSQL и String.toLowerCase() в JS
-- расходятся только на экзотических символах (турецкая İ, конечная сигма Σ в
-- греческом, титульные диграфы ǅ ǈ ǋ ǲ). Для латиницы, кириллицы, цифр и пробельных
-- вариантов ключи совпадают (проверено тестом tests/db). Артикулы Ozon с такими
-- символами практически не встречаются.
--
-- Требование к БД: UTF-8 с локалью, различающей регистр кириллицы (en_US.UTF-8 —
-- стандарт Supabase). Миграция сама проверяет это и при несоответствии не применяется.
--
-- Что добавляется:
--   • функция public.canonical_article(text) — канонический ключ;
--   • колонка products.sku_key (GENERATED ALWAYS … STORED) — ключ хранится в строке,
--     приложение его не пишет (вычисляет БД при каждом insert/update sku);
--   • уникальный индекс products_user_sku_key_uq (user_id, sku_key) — гарантия БД
--     для ЛЮБОГО пути записи (сервер, браузер, SQL) и любого числа инстансов.
--   Автоимпорт вставляет через INSERT … ON CONFLICT (user_id, sku_key) DO NOTHING
--   (PostgREST: upsert onConflict="user_id,sku_key", ignoreDuplicates): уже
--   существующая строка не меняется, дубль не создаётся, ошибки нет.
--
-- Зависимость приложения (PR #99): автодобавление ТРЕБУЕТ эту миграцию. Без неё
-- оно не вставляет ничего и честно возвращает ошибку «не применена миграция»
-- (приблизительной защиты вместо гарантии БД нет). Ручное добавление в каталоге
-- работает и без миграции. ПОРЯДОК:
--   1) read-only проверка supabase/checks/products_article_conflicts.sql;
--   2) если конфликтов нет — эта миграция; если есть — решение владельца по данным
--      (эта миграция при конфликтах сама остановится, ничего не изменив);
--   3) только после этого merge/deploy PR #99.
--
-- Идемпотентно (повторный прогон безопасен). Откат (без потери данных):
--   drop index if exists public.products_user_sku_key_uq;
--   alter table public.products drop column if exists sku_key;
--   drop function if exists public.canonical_article(text);
-- Блокировка: добавление STORED-колонки переписывает таблицу products под
-- эксклюзивной блокировкой (каталог небольшой — доли секунды).
-- ============================================================================
begin;

-- 1) Канонический ключ артикула.
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

-- 2) Охрана окружения: без корректного lower() для кириллицы ключ не совпадёт с расчётом.
do $$
begin
  if public.canonical_article(E'  АрТ\u00a0 1\t') is distinct from 'арт 1' then
    raise exception
      'canonical_article: база не даёт ожидаемого ключа (нужна UTF-8 локаль с регистром кириллицы). Индекс не создан, ничего не изменено.';
  end if;
end
$$;

-- 3) Охрана данных: при существующих конфликтах — СТОП. Ничего не удаляем и не сливаем,
--    стоимость не выбираем; решение по данным принимает владелец (см. проверку конфликтов).
do $$
declare
  n_groups integer;
  n_rows   integer;
begin
  select count(*), coalesce(sum(c), 0)
    into n_groups, n_rows
  from (
    select count(*) as c
    from public.products
    where public.canonical_article(sku) is not null
    group by user_id, public.canonical_article(sku)
    having count(*) > 1
  ) g;
  if n_groups > 0 then
    raise exception
      'products: найдено % групп (% строк) с одинаковым артикулом по каноническому ключу. Ничего не изменено. Запустите supabase/checks/products_article_conflicts.sql и решите по данным вручную.',
      n_groups, n_rows;
  end if;
end
$$;

-- 4) Канонический ключ как хранимая колонка (нужна для ON CONFLICT через PostgREST).
alter table public.products
  add column if not exists sku_key text
  generated always as (public.canonical_article(sku)) stored;

-- 5) Уникальность по (пользователь, канонический ключ). NULL-ключи (пустой sku) не конфликтуют.
create unique index if not exists products_user_sku_key_uq
  on public.products (user_id, sku_key);

commit;
