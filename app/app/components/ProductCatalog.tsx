"use client";

// ============================================================================
// ProductCatalog — вкладка «Каталог товаров».
//
// Полный CRUD по таблице public.products (RLS отдаёт только свои строки):
//   • просмотр списка
//   • добавление
//   • редактирование (inline-форма)
//   • удаление (с подтверждением прямо в строке)
//
// Поля товара: Артикул (sku) / Название (name) / Себестоимость (cost_price).
// Стиль — существующая тема M-PROF (глобальные CSS-переменные --gold/--txt/…).
// К расчётам каталог пока НЕ подключён (по требованию задачи).
//
// Массовый импорт из Excel («Импорт Excel»): принимает .xlsx/.xls/.csv с шапкой
// формата `sku | cost_price` либо `артикул | себестоимость`. Новые товары
// создаются, существующие обновляются по sku (без upsert-helper'а — грузим
// текущий каталог и матчим по нормализованному sku). Библиотека xlsx грузится
// лениво (dynamic import), чтобы не попадать в initial bundle вкладки.
// ============================================================================

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import type { User } from "@supabase/supabase-js";
import {
  loadProductsFromCloud,
  addProductToCloud,
  updateProductInCloud,
  deleteProductFromCloud,
  type Product,
} from "../lib/supabase-cloud";

type ToastFn = (message: string, type?: "ok" | "warn" | "err") => void;

interface Props {
  user: User;
  showToast: ToastFn;
}

interface Draft {
  sku: string;
  name: string;
  cost: string;
}

const EMPTY_DRAFT: Draft = { sku: "", name: "", cost: "" };

/** Итог массового импорта — показывается отдельной панелью после загрузки файла. */
interface ImportResult {
  added: number;
  updated: number;
  errors: number;
  /** Сколько строк фактически обработано (added + updated + errors). */
  processed: number;
  fileName: string;
  /** Первые несколько текстов ошибок, чтобы пользователь мог поправить файл. */
  errorSamples: string[];
}

// "1 234,56" / "1234.56" / "1234" → number; пустая/некорректная/отрицательная → null.
function parseCost(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function pluralProducts(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "товар";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "товара";
  return "товаров";
}

function pluralRows(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "строка";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "строки";
  return "строк";
}

export function ProductCatalog({ user, showToast }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Inline-форма: добавление (editingId=null) или редактирование (editingId=id).
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  // Подтверждение удаления — прямо в строке.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Массовый импорт из Excel.
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Inline-редактирование себестоимости прямо в строке таблицы каталога.
  // costDraft — введённый текст по id товара (контролируемый input);
  // costSavingId — id строки, которая сейчас сохраняется (блокирует кнопку);
  // costErr — текст ошибки по id товара (показывается под полем).
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  const [costSavingId, setCostSavingId] = useState<string | null>(null);
  const [costErr, setCostErr] = useState<Record<string, string>>({});

  // Поиск и фильтры каталога. Чисто UI-слой: фильтруют уже отсортированный
  // список для отображения и НЕ трогают Supabase, формулы прибыли, парсеры,
  // Excel или сохранение себестоимости.
  // search — живой текстовый поиск (по названию и артикулу/SKU, без кнопки);
  // costFilter — активный фильтр по наличию себестоимости.
  const [search, setSearch] = useState("");
  const [costFilter, setCostFilter] = useState<"all" | "without" | "with">(
    "all"
  );

  // Массовое редактирование себестоимости. Чисто UI-слой поверх уже
  // существующей функции сохранения (updateProductInCloud) — новой
  // Supabase-логики не добавляем. selectedIds — выбранные товары (учитываются
  // только пока видимы в текущем поиске/фильтре); bulkCost — себестоимость за
  // 1 шт. для всех выбранных; bulkErr — ошибка валидации рядом с полем;
  // bulkSaving — идёт массовое сохранение (блокирует кнопку).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkCost, setBulkCost] = useState("");
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await loadProductsFromCloud(user.id);
    if (error) {
      setLoadError(error.message);
      setProducts([]);
    } else {
      setProducts(data ?? []);
    }
    setLoading(false);
  }, [user.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  function openAdd() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setDeletingId(null);
    setFormOpen(true);
  }

  function openEdit(p: Product) {
    setEditingId(p.id);
    setDraft({
      sku: p.sku ?? "",
      name: p.name ?? "",
      cost: p.cost_price != null ? String(p.cost_price) : "",
    });
    setDeletingId(null);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  }

  async function submitForm(e: FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    const sku = draft.sku.trim();
    const cost = parseCost(draft.cost);
    if (!name) {
      showToast("Введите название товара", "warn");
      return;
    }
    if (cost === null) {
      showToast("Укажите корректную себестоимость", "warn");
      return;
    }

    setSaving(true);
    if (editingId) {
      const { error } = await updateProductInCloud(
        editingId,
        { sku: sku || null, name, cost_price: cost },
        user.id
      );
      setSaving(false);
      if (error) {
        showToast("Не удалось сохранить: " + error.message, "err");
        return;
      }
      showToast("Товар обновлён", "ok");
    } else {
      const { error } = await addProductToCloud(
        { sku: sku || null, name, cost_price: cost },
        user.id
      );
      setSaving(false);
      if (error) {
        showToast("Не удалось добавить: " + error.message, "err");
        return;
      }
      showToast("Товар добавлен", "ok");
    }
    closeForm();
    reload();
  }

  async function confirmDelete(id: string) {
    setBusyId(id);
    const { error } = await deleteProductFromCloud(id, user.id);
    setBusyId(null);
    setDeletingId(null);
    if (error) {
      showToast("Не удалось удалить: " + error.message, "err");
      return;
    }
    showToast("Товар удалён", "ok");
    setProducts((prev) => prev.filter((p) => p.id !== id));
  }

  // --- Inline-редактирование себестоимости в строке -----------------------
  // Меняем черновик строки и сбрасываем её ошибку (если была).
  function onCostDraftChange(id: string, value: string) {
    setCostDraft((d) => ({ ...d, [id]: value }));
    setCostErr((e) => {
      if (!e[id]) return e;
      const next = { ...e };
      delete next[id];
      return next;
    });
  }

  // Сохранить себестоимость одной строки. Товар всегда уже есть в каталоге
  // (это его строка) → используем существующую updateProductInCloud, без
  // addProductToCloud и без изменения schema. Локальный state обновляется
  // точечно, без reload; сортировка не меняется (cost не входит в ключ).
  async function saveCost(p: Product) {
    if (costSavingId === p.id) return; // защита от двойного клика
    const raw = costDraft[p.id] ?? String(p.cost_price ?? "");
    const parsed = parseCost(raw); // запятая → точка внутри parseCost
    // Требование: принимать только число строго больше 0.
    if (parsed === null || parsed <= 0) {
      setCostErr((e) => ({ ...e, [p.id]: "Введите число больше 0" }));
      return;
    }
    // Значение не изменилось — сеть не дёргаем, просто подтверждаем.
    if (parsed === p.cost_price) {
      setCostErr((e) => {
        const next = { ...e };
        delete next[p.id];
        return next;
      });
      showToast("Себестоимость сохранена", "ok");
      return;
    }

    setCostSavingId(p.id);
    const { data, error } = await updateProductInCloud(
      p.id,
      { cost_price: parsed },
      user.id
    );
    setCostSavingId(null);

    if (error) {
      setCostErr((e) => ({ ...e, [p.id]: error.message }));
      showToast("Не удалось сохранить: " + error.message, "err");
      return;
    }

    // Обновляем только эту строку каталога в локальном state.
    setProducts((prev) =>
      prev.map((x) => (x.id === p.id ? data ?? { ...x, cost_price: parsed } : x))
    );
    // Чистим черновик и ошибку — поле снова берёт значение из state.
    setCostDraft((d) => {
      const next = { ...d };
      delete next[p.id];
      return next;
    });
    setCostErr((e) => {
      const next = { ...e };
      delete next[p.id];
      return next;
    });
    showToast("Себестоимость сохранена", "ok");
  }

  // --- Массовый импорт из Excel -------------------------------------------
  function triggerImport() {
    if (importing) return;
    setImportResult(null);
    fileInputRef.current?.click();
  }

  async function onImportFile(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0] ?? null;
    // Сбрасываем value, чтобы повторный выбор того же файла снова сработал.
    input.value = "";
    if (!file) return;

    setImporting(true);
    setImportResult(null);

    try {
      // xlsx грузим лениво — большая библиотека не должна попадать в bundle вкладки.
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheetName = wb.SheetNames[0];
      const sheet = sheetName ? wb.Sheets[sheetName] : null;
      if (!sheet) {
        showToast("В файле не найден лист с данными", "err");
        setImporting(false);
        return;
      }

      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
        blankrows: false,
      }) as unknown[][];

      // Ищем строку-шапку и колонки sku / себестоимости (+ опционально название).
      let headerIdx = -1;
      let skuCol = -1;
      let costCol = -1;
      let nameCol = -1;
      const scanLimit = Math.min(rows.length, 12);
      for (let r = 0; r < scanLimit; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;
        let s = -1;
        let c = -1;
        let nm = -1;
        for (let i = 0; i < row.length; i++) {
          const h = String(row[i] ?? "").trim().toLowerCase();
          if (h === "") continue;
          if (s === -1 && (/sku/.test(h) || /артикул/.test(h))) s = i;
          if (c === -1 && (/cost[\s_]*price/.test(h) || /себестоим/.test(h))) c = i;
          if (nm === -1 && (/^name$/.test(h) || /наимен/.test(h) || /назван/.test(h)))
            nm = i;
        }
        if (s !== -1 && c !== -1) {
          headerIdx = r;
          skuCol = s;
          costCol = c;
          nameCol = nm;
          break;
        }
      }

      if (headerIdx === -1) {
        showToast(
          "Не найдены колонки. Нужны «sku» и «cost_price» либо «артикул» и «себестоимость».",
          "err"
        );
        setImporting(false);
        return;
      }

      // Грузим текущий каталог и матчим по нормализованному sku (upsert вручную).
      const { data: existing, error: loadErr } = await loadProductsFromCloud(
        user.id
      );
      if (loadErr) {
        showToast("Не удалось загрузить каталог: " + loadErr.message, "err");
        setImporting(false);
        return;
      }
      const bySku = new Map<string, Product>();
      for (const p of existing ?? []) {
        if (p.sku) bySku.set(p.sku.trim().toLowerCase(), p);
      }

      let added = 0;
      let updated = 0;
      let errors = 0;
      const errorSamples: string[] = [];
      const noteError = (msg: string) => {
        errors++;
        if (errorSamples.length < 4) errorSamples.push(msg);
      };

      for (let r = headerIdx + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;
        const sku = String(row[skuCol] ?? "").trim();
        const costRaw = String(row[costCol] ?? "").trim();
        const nameRaw = nameCol !== -1 ? String(row[nameCol] ?? "").trim() : "";

        // Полностью пустая строка — тихо пропускаем.
        if (sku === "" && costRaw === "" && nameRaw === "") continue;

        const humanRow = r + 1; // 1-based для пользователя
        if (sku === "") {
          noteError(`Строка ${humanRow}: пустой артикул`);
          continue;
        }
        const cost = parseCost(costRaw);
        if (cost === null) {
          noteError(`Строка ${humanRow}: некорректная себестоимость «${costRaw}»`);
          continue;
        }

        const key = sku.toLowerCase();
        const found = bySku.get(key);
        if (found) {
          const { error } = await updateProductInCloud(
            found.id,
            { cost_price: cost },
            user.id
          );
          if (error) {
            noteError(`Строка ${humanRow}: ${error.message}`);
          } else {
            updated++;
          }
        } else {
          const { data, error } = await addProductToCloud(
            { sku, name: nameRaw || sku, cost_price: cost },
            user.id
          );
          if (error) {
            noteError(`Строка ${humanRow}: ${error.message}`);
          } else {
            added++;
            // Кладём в Map, чтобы дубликат того же sku в файле обновил, а не задвоил.
            if (data) bySku.set(key, data);
          }
        }
      }

      const processed = added + updated + errors;
      setImportResult({
        added,
        updated,
        errors,
        processed,
        fileName: file.name,
        errorSamples,
      });
      showToast(
        `Импорт: добавлено ${added}, обновлено ${updated}, ошибок ${errors}`,
        errors > 0 ? "warn" : "ok"
      );
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "неизвестная ошибка";
      showToast("Не удалось обработать файл: " + msg, "err");
    } finally {
      setImporting(false);
    }
  }

  const count = products.length;

  // Порядок отображения каталога = как в Excel-выгрузке и блоке «без
  // себестоимости»: сначала по названию, затем по артикулу/SKU (русская
  // локаль), похожие названия идут рядом. Копия массива ([...products]) →
  // sort НЕ мутирует исходный state. Зависит только от products → НЕ
  // пересортировывается при редактировании себестоимости. На сохранение в
  // Supabase, формулы и другие блоки не влияет. Стабильно (равные сохраняют
  // исходный порядок).
  const sortedProducts = useMemo(
    () =>
      [...products].sort(
        (a, b) =>
          (a.name ?? "").localeCompare(b.name ?? "", "ru") ||
          (a.sku ?? "").localeCompare(b.sku ?? "", "ru")
      ),
    [products]
  );

  // Счётчики для кнопок-фильтров. «С себестоимостью» = cost_price конечное
  // число > 0; всё остальное (0, null, NaN, невалидное) — «без себестоимости».
  // Считаем по полному products, чтобы цифры не зависели от поиска/фильтра.
  const withCostCount = useMemo(
    () =>
      products.filter((p) => Number.isFinite(p.cost_price) && p.cost_price > 0)
        .length,
    [products]
  );
  const withoutCostCount = products.length - withCostCount;

  // Видимый список = отсортированный каталог, к которому применены фильтр по
  // себестоимости и текстовый поиск. Деривация из sortedProducts гарантирует,
  // что порядок (name → sku, русская локаль) НЕ ломается после фильтрации.
  // Поиск регистронезависимый, по названию и артикулу/SKU; пустой запрос
  // ничего не отсекает.
  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sortedProducts.filter((p) => {
      const hasCost = Number.isFinite(p.cost_price) && p.cost_price > 0;
      if (costFilter === "with" && !hasCost) return false;
      if (costFilter === "without" && hasCost) return false;
      if (q !== "") {
        const name = (p.name ?? "").toLowerCase();
        const sku = (p.sku ?? "").toLowerCase();
        if (!name.includes(q) && !sku.includes(q)) return false;
      }
      return true;
    });
  }, [sortedProducts, search, costFilter]);

  // Эффективная выборка для массового действия = выбранные ∩ видимые. Так
  // массовое сохранение НИКОГДА не трогает скрытые поиском/фильтром товары
  // (требование «применять только к видимым/выбранным»), а сама выборка
  // переживает смену фильтра — скрытые товары вернутся при сбросе фильтра.
  const selectedVisible = useMemo(
    () => visibleProducts.filter((p) => selectedIds.has(p.id)),
    [visibleProducts, selectedIds]
  );
  const selectedVisibleCount = selectedVisible.length;
  const allVisibleSelected =
    visibleProducts.length > 0 &&
    selectedVisibleCount === visibleProducts.length;

  // «Выбрать все видимые» в промежуточном состоянии, когда выбрана лишь часть.
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selectedVisibleCount > 0 &&
        selectedVisibleCount < visibleProducts.length;
    }
  }, [selectedVisibleCount, visibleProducts.length]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Выбрать/снять все ВИДИМЫЕ (с учётом текущего поиска и фильтра).
  function toggleSelectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSel =
        visibleProducts.length > 0 &&
        visibleProducts.every((p) => next.has(p.id));
      for (const p of visibleProducts) {
        if (allSel) next.delete(p.id);
        else next.add(p.id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setBulkCost("");
    setBulkErr(null);
  }

  // Применить себестоимость ко всем выбранным (видимым) товарам. Для каждого —
  // существующая updateProductInCloud (товар всегда уже в каталоге, ведь это
  // его строка → addProductToCloud не нужен). Локальный state обновляется
  // точечно, без reload; сортировка не ломается (cost_price не в ключе сорта).
  async function applyBulkCost() {
    if (bulkSaving) return;
    const parsed = parseCost(bulkCost); // запятая → точка внутри parseCost
    // Требование: число строго больше 0; иначе ошибка и НЕ шлём запросы.
    if (parsed === null || parsed <= 0) {
      setBulkErr("Введите число больше 0");
      return;
    }
    const targets = selectedVisible;
    if (targets.length === 0) {
      setBulkErr("Выберите хотя бы один товар");
      return;
    }
    setBulkErr(null);
    setBulkSaving(true);

    let ok = 0;
    let failed = 0;
    const updatedById = new Map<string, Product>();
    for (const p of targets) {
      const { data, error } = await updateProductInCloud(
        p.id,
        { cost_price: parsed },
        user.id
      );
      if (error) {
        failed++;
      } else {
        ok++;
        updatedById.set(p.id, data ?? { ...p, cost_price: parsed });
      }
    }

    // Точечно обновляем затронутые строки в локальном state (без reload).
    if (updatedById.size > 0) {
      setProducts((prev) => prev.map((x) => updatedById.get(x.id) ?? x));
    }
    setBulkSaving(false);

    // Родительный после «для N»: 1 → «товара», иначе → «товаров».
    const gen = ok === 1 ? "товара" : "товаров";
    if (failed === 0) {
      showToast(`Себестоимость сохранена для ${ok} ${gen}`, "ok");
      setSelectedIds(new Set());
      setBulkCost("");
      setBulkErr(null);
    } else if (ok > 0) {
      // Часть сохранилась: снимаем выбор с успешных, проблемные оставляем.
      setSelectedIds((prev) => {
        const next = new Set(prev);
        updatedById.forEach((_, id) => next.delete(id));
        return next;
      });
      showToast(`Сохранено для ${ok} ${gen}, не удалось — ${failed}`, "warn");
      setBulkErr(
        `Не удалось сохранить ${failed} ${pluralProducts(failed)}. Попробуйте ещё раз.`
      );
    } else {
      showToast("Не удалось сохранить себестоимость", "err");
      setBulkErr("Не удалось сохранить. Попробуйте ещё раз.");
    }
  }

  return (
    <section className="pc">
      <div className="pc-head">
        <div className="pc-head-l">
          <h2 className="pc-title">Каталог товаров</h2>
          <p className="pc-sub">
            {count > 0
              ? `${count} ${pluralProducts(count)} в каталоге`
              : "Храните себестоимость товаров в одном месте"}
          </p>
        </div>
        {!formOpen && (
          <div className="pc-actions">
            <button
              type="button"
              className="pc-import-btn"
              onClick={triggerImport}
              disabled={importing}
            >
              {importing ? (
                <span className="pc-spinner pc-spinner-sm" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="M17 8l-5-5-5 5" />
                  <path d="M12 3v12" />
                </svg>
              )}
              {importing ? "Импорт…" : "Импорт Excel"}
            </button>
            <button type="button" className="pc-add" onClick={openAdd}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Добавить товар
            </button>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        hidden
        onChange={onImportFile}
      />

      {formOpen && (
        <form className="pc-form" onSubmit={submitForm}>
          <div className="pc-form-title">
            {editingId ? "Редактирование товара" : "Новый товар"}
          </div>
          <div className="pc-form-grid">
            <label className="pc-field">
              <span className="pc-label">Артикул</span>
              <input
                className="pc-input"
                value={draft.sku}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, sku: e.target.value }))
                }
                placeholder="SKU-001"
                autoComplete="off"
              />
            </label>
            <label className="pc-field">
              <span className="pc-label">
                Название <i>*</i>
              </span>
              <input
                className="pc-input"
                value={draft.name}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
                placeholder="Например, Кружка керамическая"
                autoComplete="off"
              />
            </label>
            <label className="pc-field">
              <span className="pc-label">
                Себестоимость, ₽ <i>*</i>
              </span>
              <input
                className="pc-input"
                value={draft.cost}
                inputMode="decimal"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, cost: e.target.value }))
                }
                placeholder="0"
                autoComplete="off"
              />
            </label>
          </div>
          <div className="pc-form-actions">
            <button type="submit" className="pc-save" disabled={saving}>
              {saving ? "Сохранение…" : editingId ? "Сохранить" : "Добавить"}
            </button>
            <button
              type="button"
              className="pc-cancel"
              onClick={closeForm}
              disabled={saving}
            >
              Отмена
            </button>
          </div>
        </form>
      )}

      {importResult && (
        <div className="pc-import">
          <div className="pc-import-head">
            <span className="pc-import-title">Импорт завершён</span>
            <button
              type="button"
              className="pc-import-x"
              onClick={() => setImportResult(null)}
              aria-label="Закрыть"
            >
              ×
            </button>
          </div>
          <div className="pc-import-rows">
            <div className="pc-import-row">
              <span className="pc-import-dot add" />
              <span className="pc-import-label">Добавлено товаров</span>
              <span className="pc-import-num add">{importResult.added}</span>
            </div>
            <div className="pc-import-row">
              <span className="pc-import-dot upd" />
              <span className="pc-import-label">Обновлено товаров</span>
              <span className="pc-import-num upd">{importResult.updated}</span>
            </div>
            <div className="pc-import-row">
              <span
                className={`pc-import-dot ${
                  importResult.errors > 0 ? "err" : "zero"
                }`}
              />
              <span className="pc-import-label">Ошибок</span>
              <span
                className={`pc-import-num ${
                  importResult.errors > 0 ? "err" : "zero"
                }`}
              >
                {importResult.errors}
              </span>
            </div>
          </div>
          {importResult.errorSamples.length > 0 && (
            <div className="pc-import-errs">
              {importResult.errorSamples.map((m, i) => (
                <span className="pc-import-err-item" key={i}>
                  {m}
                </span>
              ))}
              {importResult.errors > importResult.errorSamples.length && (
                <span className="pc-import-err-item">
                  …и ещё {importResult.errors - importResult.errorSamples.length}
                </span>
              )}
            </div>
          )}
          <div className="pc-import-foot">
            Файл «{importResult.fileName}» · обработано {importResult.processed}{" "}
            {pluralRows(importResult.processed)}
          </div>
        </div>
      )}

      {loading ? (
        <div className="pc-state">
          <span className="pc-spinner" aria-hidden="true" />
          <span>Загрузка товаров…</span>
        </div>
      ) : loadError ? (
        <div className="pc-state pc-state-err">
          <span>Не удалось загрузить каталог: {loadError}</span>
          <button type="button" className="pc-retry" onClick={reload}>
            Повторить
          </button>
        </div>
      ) : count === 0 ? (
        <div className="pc-empty">
          <span className="pc-empty-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M3 7l9-4 9 4-9 4-9-4z" />
              <path d="M3 7v10l9 4 9-4V7" />
              <path d="M12 11v10" />
            </svg>
          </span>
          <div className="pc-empty-t">Пока нет товаров</div>
          <div className="pc-empty-d">
            Добавьте первый товар, чтобы хранить его себестоимость.
          </div>
          {!formOpen && (
            <button
              type="button"
              className="pc-add pc-add-empty"
              onClick={openAdd}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Добавить товар
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="pc-toolbar">
            <div className="pc-search">
              <svg
                className="pc-search-ic"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                type="search"
                className="pc-search-input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск по названию или артикулу"
                aria-label="Поиск по товарам"
              />
              {search && (
                <button
                  type="button"
                  className="pc-search-clear"
                  aria-label="Очистить поиск"
                  onClick={() => setSearch("")}
                >
                  ×
                </button>
              )}
            </div>
            <div
              className="pc-filters"
              role="group"
              aria-label="Фильтр по себестоимости"
            >
              <button
                type="button"
                className={`pc-chip${costFilter === "all" ? " active" : ""}`}
                aria-pressed={costFilter === "all"}
                onClick={() => setCostFilter("all")}
              >
                Все товары
                <span className="pc-chip-n">{count}</span>
              </button>
              <button
                type="button"
                className={`pc-chip${
                  costFilter === "without" ? " active" : ""
                }`}
                aria-pressed={costFilter === "without"}
                onClick={() => setCostFilter("without")}
              >
                Без себестоимости
                <span className="pc-chip-n">{withoutCostCount}</span>
              </button>
              <button
                type="button"
                className={`pc-chip${costFilter === "with" ? " active" : ""}`}
                aria-pressed={costFilter === "with"}
                onClick={() => setCostFilter("with")}
              >
                С себестоимостью
                <span className="pc-chip-n">{withCostCount}</span>
              </button>
            </div>
          </div>
          {visibleProducts.length === 0 ? (
            <div className="pc-noresults">Товары не найдены</div>
          ) : (
            <>
              <div className="pc-bulkbar">
                <label className="pc-selall">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    className="pc-check"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    aria-label="Выбрать все видимые товары"
                  />
                  <span>Выбрать все видимые</span>
                </label>
                {selectedVisibleCount > 0 && (
                  <div className="pc-bulk">
                    <span className="pc-bulk-count">
                      Выбрано товаров: {selectedVisibleCount}
                    </span>
                    <span className="pc-bulk-field">
                      <span className="pc-cost-input-wrap pc-bulk-input-wrap">
                        <input
                          className={`pc-cost-input${
                            bulkErr ? " has-err" : ""
                          }`}
                          value={bulkCost}
                          inputMode="decimal"
                          placeholder="Себестоимость за 1 шт."
                          aria-label="Себестоимость за 1 шт. для выбранных товаров"
                          disabled={bulkSaving}
                          onChange={(e) => {
                            setBulkCost(e.target.value);
                            if (bulkErr) setBulkErr(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              applyBulkCost();
                            }
                          }}
                        />
                        <span className="pc-cost-rub" aria-hidden="true">
                          ₽
                        </span>
                      </span>
                      <button
                        type="button"
                        className="pc-bulk-apply"
                        disabled={bulkSaving}
                        onClick={applyBulkCost}
                      >
                        {bulkSaving ? "Сохраняем…" : "Применить к выбранным"}
                      </button>
                    </span>
                    <button
                      type="button"
                      className="pc-bulk-clear"
                      onClick={clearSelection}
                      disabled={bulkSaving}
                    >
                      Снять выбор
                    </button>
                    {bulkErr && (
                      <span className="pc-bulk-err" role="alert">
                        {bulkErr}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="pc-table" role="table" aria-label="Список товаров">
              <div className="pc-thead" role="row">
                <span
                  role="columnheader"
                  className="pc-th-check"
                  aria-hidden="true"
                />
                <span role="columnheader">Артикул</span>
                <span role="columnheader">Название</span>
                <span role="columnheader">Себестоимость</span>
                <span role="columnheader" className="pc-th-act">
                  Действия
                </span>
              </div>
              {visibleProducts.map((p) => (
                <div
                  className={"pc-row" + (selectedIds.has(p.id) ? " selected" : "")}
                  role="row"
                  key={p.id}
                >
                  <span className="pc-cell pc-c-check" role="cell">
                    <input
                      type="checkbox"
                      className="pc-check"
                      checked={selectedIds.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                      aria-label={`Выбрать товар ${p.name}`}
                    />
                  </span>
                  <span
                    className="pc-cell pc-c-sku"
                    role="cell"
                    data-label="Артикул"
                  >
                    {p.sku || "—"}
                  </span>
                  <span
                    className="pc-cell pc-c-name"
                    role="cell"
                    data-label="Название"
                  >
                    {p.name}
                  </span>
                  <span
                    className="pc-cell pc-c-cost"
                    role="cell"
                    data-label="Себестоимость за 1 шт."
                  >
                    <span className="pc-cost-edit">
                      <span className="pc-cost-input-wrap">
                        <input
                          className={`pc-cost-input${
                            costErr[p.id] ? " has-err" : ""
                          }`}
                          value={costDraft[p.id] ?? String(p.cost_price ?? "")}
                          inputMode="decimal"
                          aria-label="Себестоимость за 1 шт."
                          placeholder="Например, 120"
                          disabled={costSavingId === p.id}
                          onChange={(e) =>
                            onCostDraftChange(p.id, e.target.value)
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              saveCost(p);
                            }
                          }}
                        />
                        <span className="pc-cost-rub" aria-hidden="true">
                          ₽
                        </span>
                      </span>
                      <button
                        type="button"
                        className="pc-cost-save"
                        disabled={costSavingId === p.id}
                        onClick={() => saveCost(p)}
                      >
                        {costSavingId === p.id ? "…" : "Сохранить"}
                      </button>
                    </span>
                    {costErr[p.id] && (
                      <span className="pc-cost-err" role="alert">
                        {costErr[p.id]}
                      </span>
                    )}
                  </span>
                  <span className="pc-cell pc-c-act" role="cell">
                    {deletingId === p.id ? (
                      <span className="pc-confirm">
                        <span className="pc-confirm-q">Удалить?</span>
                        <button
                          type="button"
                          className="pc-mini pc-mini-yes"
                          disabled={busyId === p.id}
                          onClick={() => confirmDelete(p.id)}
                        >
                          {busyId === p.id ? "…" : "Да"}
                        </button>
                        <button
                          type="button"
                          className="pc-mini"
                          disabled={busyId === p.id}
                          onClick={() => setDeletingId(null)}
                        >
                          Нет
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="pc-icon"
                          title="Редактировать"
                          aria-label="Редактировать"
                          onClick={() => openEdit(p)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="pc-icon pc-icon-del"
                          title="Удалить"
                          aria-label="Удалить"
                          onClick={() => setDeletingId(p.id)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M3 6h18" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                            <path d="M10 11v6M14 11v6" />
                          </svg>
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))}
              </div>
            </>
          )}
        </>
      )}

      <style jsx>{`
        .pc {
          background: var(--glass);
          border: 1px solid var(--edge);
          border-radius: 16px;
          padding: 1.4rem 1.5rem 1.6rem;
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24);
          margin-top: 0.3rem;
        }
        .pc-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1rem;
          flex-wrap: wrap;
        }
        .pc-title {
          font-family: var(--display);
          font-size: 1.3rem;
          font-weight: 700;
          color: var(--txt);
          letter-spacing: -0.01em;
        }
        .pc-sub {
          font-size: 0.85rem;
          color: var(--txt2);
          margin-top: 0.25rem;
          font-weight: 300;
        }
        .pc-add {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: 44px;
          padding: 0 18px;
          font-family: var(--sans);
          font-size: 0.88rem;
          font-weight: 700;
          color: var(--void);
          cursor: pointer;
          border: 0;
          border-radius: 11px;
          background: linear-gradient(135deg, var(--gold) 0%, var(--gold2) 100%);
          box-shadow: 0 8px 24px rgba(201, 168, 76, 0.28);
          transition: transform 0.18s ease, box-shadow 0.18s ease;
          white-space: nowrap;
        }
        .pc-add:hover {
          transform: translateY(-1px);
          box-shadow: 0 12px 30px rgba(201, 168, 76, 0.36);
        }
        .pc-add svg {
          width: 17px;
          height: 17px;
          stroke: currentColor;
          stroke-width: 2.4;
          fill: none;
          stroke-linecap: round;
        }

        .pc-actions {
          display: inline-flex;
          align-items: center;
          gap: 0.6rem;
          flex-wrap: wrap;
        }
        .pc-import-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: 44px;
          padding: 0 16px;
          font-family: var(--sans);
          font-size: 0.88rem;
          font-weight: 600;
          color: var(--txt2);
          cursor: pointer;
          border: 1px solid var(--edge2);
          border-radius: 11px;
          background: rgba(255, 255, 255, 0.03);
          transition: color 0.18s ease, border-color 0.18s ease,
            background 0.18s ease;
          white-space: nowrap;
        }
        .pc-import-btn:hover:not(:disabled) {
          color: var(--gold2);
          border-color: var(--gold);
          background: var(--gold-bg);
        }
        .pc-import-btn:disabled {
          opacity: 0.65;
          cursor: default;
        }
        .pc-import-btn svg {
          width: 16px;
          height: 16px;
          stroke: currentColor;
          stroke-width: 2;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .pc-spinner-sm {
          width: 15px;
          height: 15px;
          border-width: 2px;
        }

        .pc-import {
          margin-top: 1.1rem;
          border: 1px solid var(--edge2);
          border-radius: 13px;
          background: rgba(255, 255, 255, 0.02);
          padding: 1rem 1.15rem 1.05rem;
        }
        .pc-import-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 0.8rem;
        }
        .pc-import-title {
          font-family: var(--sans);
          font-size: 0.78rem;
          font-weight: 700;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: var(--gold2);
        }
        .pc-import-x {
          width: 30px;
          height: 30px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid var(--edge2);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.03);
          color: var(--txt2);
          font-size: 1.2rem;
          line-height: 1;
          cursor: pointer;
          transition: color 0.16s ease, border-color 0.16s ease;
        }
        .pc-import-x:hover {
          color: var(--txt);
          border-color: var(--gold);
        }
        .pc-import-rows {
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
        }
        .pc-import-row {
          display: flex;
          align-items: center;
          gap: 0.65rem;
        }
        .pc-import-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex: none;
        }
        .pc-import-dot.add {
          background: var(--green);
        }
        .pc-import-dot.upd {
          background: var(--gold);
        }
        .pc-import-dot.err {
          background: var(--red);
        }
        .pc-import-dot.zero {
          background: var(--txt3);
        }
        .pc-import-label {
          flex: 1;
          font-size: 0.9rem;
          color: var(--txt2);
        }
        .pc-import-num {
          font-family: var(--mono);
          font-size: 1.05rem;
          font-weight: 600;
          color: var(--txt);
        }
        .pc-import-num.add {
          color: var(--green);
        }
        .pc-import-num.upd {
          color: var(--gold2);
        }
        .pc-import-num.err {
          color: var(--red);
        }
        .pc-import-num.zero {
          color: var(--txt3);
        }
        .pc-import-errs {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          margin-top: 0.7rem;
        }
        .pc-import-err-item {
          font-size: 0.76rem;
          color: var(--txt3);
          font-family: var(--mono);
        }
        .pc-import-foot {
          margin-top: 0.8rem;
          padding-top: 0.7rem;
          border-top: 1px solid var(--edge);
          font-size: 0.78rem;
          color: var(--txt3);
        }

        .pc-form {
          margin-top: 1.1rem;
          padding: 1.1rem 1.15rem 1.2rem;
          border: 1px solid var(--edge2);
          border-radius: 13px;
          background: rgba(255, 255, 255, 0.02);
        }
        .pc-form-title {
          font-family: var(--sans);
          font-size: 0.78rem;
          font-weight: 700;
          letter-spacing: 0.05em;
          color: var(--gold2);
          text-transform: uppercase;
          margin-bottom: 0.85rem;
        }
        .pc-form-grid {
          display: grid;
          grid-template-columns: 1fr 1.6fr 1fr;
          gap: 0.8rem;
        }
        .pc-field {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          min-width: 0;
        }
        .pc-label {
          font-size: 0.74rem;
          font-weight: 600;
          color: var(--txt2);
          letter-spacing: 0.01em;
        }
        .pc-label i {
          color: var(--gold);
          font-style: normal;
        }
        .pc-input {
          width: 100%;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--edge2);
          border-radius: 9px;
          padding: 11px 13px;
          font-family: var(--sans);
          font-size: 0.92rem;
          color: var(--txt);
          transition: border-color 0.2s ease, box-shadow 0.2s ease;
          outline: none;
        }
        .pc-input::placeholder {
          color: var(--txt3);
        }
        .pc-input:focus {
          border-color: var(--gold);
          box-shadow: 0 0 0 3px rgba(201, 168, 76, 0.14);
        }
        .pc-form-actions {
          display: flex;
          gap: 0.6rem;
          margin-top: 1rem;
        }
        .pc-save {
          min-height: 44px;
          padding: 0 22px;
          border: 0;
          border-radius: 11px;
          cursor: pointer;
          font-family: var(--sans);
          font-size: 0.88rem;
          font-weight: 700;
          color: var(--void);
          background: linear-gradient(135deg, var(--gold) 0%, var(--gold2) 100%);
          box-shadow: 0 8px 22px rgba(201, 168, 76, 0.28);
          transition: transform 0.18s ease;
        }
        .pc-save:hover:not(:disabled) {
          transform: translateY(-1px);
        }
        .pc-save:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .pc-cancel {
          min-height: 44px;
          padding: 0 18px;
          border: 1px solid var(--edge2);
          border-radius: 11px;
          cursor: pointer;
          font-family: var(--sans);
          font-size: 0.88rem;
          font-weight: 600;
          color: var(--txt2);
          background: rgba(255, 255, 255, 0.03);
          transition: all 0.18s ease;
        }
        .pc-cancel:hover:not(:disabled) {
          color: var(--txt);
          border-color: var(--gold);
        }

        .pc-table {
          margin-top: 1.2rem;
          display: flex;
          flex-direction: column;
          gap: 2px;
          border: 1px solid var(--edge);
          border-radius: 12px;
          overflow: hidden;
        }
        .pc-thead,
        .pc-row {
          display: grid;
          grid-template-columns: 34px 130px minmax(0, 1fr) 240px 110px;
          align-items: center;
          gap: 0.8rem;
          padding: 0.7rem 1rem;
        }
        .pc-thead {
          background: rgba(255, 255, 255, 0.03);
          font-size: 0.72rem;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--txt3);
        }
        .pc-th-act {
          text-align: right;
        }
        .pc-row {
          background: rgba(255, 255, 255, 0.012);
          transition: background 0.16s ease;
        }
        .pc-row:hover {
          background: rgba(255, 255, 255, 0.035);
        }
        .pc-row.selected {
          background: rgba(201, 168, 76, 0.07);
        }
        .pc-row.selected:hover {
          background: rgba(201, 168, 76, 0.1);
        }
        .pc-th-check,
        .pc-c-check {
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .pc-check {
          width: 18px;
          height: 18px;
          margin: 0;
          accent-color: var(--gold);
          cursor: pointer;
          flex: none;
        }
        .pc-cell {
          font-size: 0.9rem;
          color: var(--txt);
          min-width: 0;
          word-break: break-word;
        }
        .pc-c-sku {
          font-family: var(--mono);
          font-size: 0.82rem;
          color: var(--txt2);
        }
        .pc-c-name {
          font-weight: 500;
        }
        .pc-c-cost {
          font-family: var(--mono);
          font-weight: 500;
          color: var(--gold2);
          display: flex;
          flex-direction: column;
          align-items: stretch;
        }
        .pc-cost-edit {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
        }
        .pc-cost-input-wrap {
          position: relative;
          flex: 1;
          min-width: 0;
        }
        .pc-cost-input {
          width: 100%;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--edge2);
          border-radius: 9px;
          padding: 8px 24px 8px 11px;
          font-family: var(--mono);
          font-size: 0.86rem;
          font-weight: 500;
          color: var(--gold2);
          transition: border-color 0.2s ease, box-shadow 0.2s ease;
          outline: none;
        }
        .pc-cost-input::placeholder {
          color: var(--txt3);
          font-family: var(--sans);
          font-weight: 400;
        }
        .pc-cost-input:focus {
          border-color: var(--gold);
          box-shadow: 0 0 0 3px rgba(201, 168, 76, 0.14);
        }
        .pc-cost-input:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .pc-cost-input.has-err {
          border-color: rgba(224, 85, 102, 0.6);
        }
        .pc-cost-rub {
          position: absolute;
          right: 9px;
          top: 50%;
          transform: translateY(-50%);
          font-family: var(--mono);
          font-size: 0.8rem;
          color: var(--txt3);
          pointer-events: none;
        }
        .pc-cost-save {
          flex: none;
          min-height: 36px;
          padding: 0 12px;
          border: 1px solid var(--edge2);
          border-radius: 9px;
          background: rgba(255, 255, 255, 0.03);
          color: var(--txt2);
          font-family: var(--sans);
          font-size: 0.8rem;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
          transition: color 0.18s ease, border-color 0.18s ease,
            background 0.18s ease;
        }
        .pc-cost-save:hover:not(:disabled) {
          color: var(--gold2);
          border-color: var(--gold);
          background: var(--gold-bg);
        }
        .pc-cost-save:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .pc-cost-err {
          margin-top: 5px;
          font-size: 0.74rem;
          font-family: var(--sans);
          font-weight: 500;
          color: var(--red);
        }
        .pc-c-act {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 6px;
        }
        .pc-c-sku::before,
        .pc-c-name::before,
        .pc-c-cost::before {
          content: attr(data-label);
          display: none;
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--txt3);
          margin-bottom: 3px;
        }

        .pc-icon {
          width: 36px;
          height: 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid var(--edge2);
          border-radius: 9px;
          background: rgba(255, 255, 255, 0.03);
          color: var(--txt2);
          cursor: pointer;
          transition: all 0.18s ease;
        }
        .pc-icon svg {
          width: 16px;
          height: 16px;
          stroke: currentColor;
          stroke-width: 1.9;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .pc-icon:hover {
          color: var(--gold2);
          border-color: var(--gold);
          background: var(--gold-bg);
        }
        .pc-icon-del:hover {
          color: var(--red);
          border-color: rgba(224, 85, 102, 0.5);
          background: rgba(224, 85, 102, 0.1);
        }

        .pc-confirm {
          display: inline-flex;
          align-items: center;
          gap: 7px;
        }
        .pc-confirm-q {
          font-size: 0.8rem;
          color: var(--txt2);
        }
        .pc-mini {
          min-height: 32px;
          padding: 0 12px;
          border-radius: 8px;
          border: 1px solid var(--edge2);
          background: rgba(255, 255, 255, 0.03);
          color: var(--txt2);
          font-size: 0.8rem;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.16s ease;
        }
        .pc-mini:hover:not(:disabled) {
          color: var(--txt);
        }
        .pc-mini-yes {
          color: #fff;
          border-color: rgba(224, 85, 102, 0.5);
          background: rgba(224, 85, 102, 0.85);
        }
        .pc-mini-yes:hover:not(:disabled) {
          background: var(--red);
        }
        .pc-mini:disabled {
          opacity: 0.6;
          cursor: default;
        }

        .pc-state {
          display: flex;
          align-items: center;
          gap: 10px;
          justify-content: center;
          padding: 2.4rem 1rem;
          color: var(--txt2);
          font-size: 0.9rem;
        }
        .pc-state-err {
          flex-direction: column;
          color: var(--red);
        }
        .pc-retry {
          min-height: 40px;
          padding: 0 18px;
          border: 1px solid var(--edge2);
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.03);
          color: var(--txt);
          font-weight: 600;
          cursor: pointer;
        }
        .pc-spinner {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: 2px solid var(--edge2);
          border-top-color: var(--gold);
          animation: pcSpin 0.7s linear infinite;
        }
        @keyframes pcSpin {
          to {
            transform: rotate(360deg);
          }
        }

        .pc-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          padding: 2.6rem 1rem 2.2rem;
          gap: 0.5rem;
        }
        .pc-empty-ic {
          width: 54px;
          height: 54px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 14px;
          border: 1px solid var(--edge2);
          background: var(--gold-bg);
          color: var(--gold2);
          margin-bottom: 0.4rem;
        }
        .pc-empty-ic svg {
          width: 26px;
          height: 26px;
          stroke: currentColor;
          stroke-width: 1.7;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .pc-empty-t {
          font-family: var(--display);
          font-size: 1.05rem;
          font-weight: 700;
          color: var(--txt);
        }
        .pc-empty-d {
          font-size: 0.86rem;
          color: var(--txt2);
          max-width: 360px;
        }
        .pc-add-empty {
          margin-top: 0.8rem;
        }

        .pc-toolbar {
          display: flex;
          align-items: center;
          gap: 0.8rem;
          flex-wrap: wrap;
          margin-top: 1.4rem;
        }
        .pc-search {
          position: relative;
          flex: 1 1 240px;
          min-width: 200px;
        }
        .pc-search-ic {
          position: absolute;
          left: 12px;
          top: 50%;
          transform: translateY(-50%);
          width: 17px;
          height: 17px;
          stroke: var(--txt3);
          stroke-width: 2;
          fill: none;
          stroke-linecap: round;
          pointer-events: none;
        }
        .pc-search-input {
          width: 100%;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--edge2);
          border-radius: 11px;
          padding: 11px 38px;
          font-family: var(--sans);
          font-size: 0.92rem;
          color: var(--txt);
          transition: border-color 0.2s ease, box-shadow 0.2s ease;
          outline: none;
          -webkit-appearance: none;
          appearance: none;
        }
        .pc-search-input::placeholder {
          color: var(--txt3);
        }
        .pc-search-input::-webkit-search-cancel-button {
          -webkit-appearance: none;
          appearance: none;
        }
        .pc-search-input:focus {
          border-color: var(--gold);
          box-shadow: 0 0 0 3px rgba(201, 168, 76, 0.14);
        }
        .pc-search-clear {
          position: absolute;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          padding: 0;
          font-size: 1.25rem;
          line-height: 1;
          color: var(--txt3);
          background: transparent;
          border: 0;
          border-radius: 7px;
          cursor: pointer;
          transition: color 0.18s ease, background 0.18s ease;
        }
        .pc-search-clear:hover {
          color: var(--txt);
          background: rgba(255, 255, 255, 0.06);
        }
        .pc-filters {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .pc-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: 44px;
          padding: 0 14px;
          font-family: var(--sans);
          font-size: 0.84rem;
          font-weight: 600;
          color: var(--txt2);
          cursor: pointer;
          border: 1px solid var(--edge2);
          border-radius: 11px;
          background: rgba(255, 255, 255, 0.03);
          transition: color 0.18s ease, border-color 0.18s ease,
            background 0.18s ease, box-shadow 0.18s ease;
          white-space: nowrap;
        }
        .pc-chip:hover:not(.active) {
          color: var(--gold2);
          border-color: var(--gold);
          background: var(--gold-bg);
        }
        .pc-chip.active {
          color: var(--void);
          border-color: transparent;
          background: linear-gradient(135deg, var(--gold) 0%, var(--gold2) 100%);
          box-shadow: 0 6px 18px rgba(201, 168, 76, 0.26);
        }
        .pc-chip-n {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 22px;
          height: 20px;
          padding: 0 6px;
          font-family: var(--mono);
          font-size: 0.74rem;
          font-weight: 700;
          color: var(--txt3);
          background: rgba(255, 255, 255, 0.06);
          border-radius: 6px;
          transition: color 0.18s ease, background 0.18s ease;
        }
        .pc-chip:hover:not(.active) .pc-chip-n {
          color: var(--gold2);
        }
        .pc-chip.active .pc-chip-n {
          color: var(--void);
          background: rgba(0, 0, 0, 0.18);
        }
        .pc-noresults {
          margin-top: 1.2rem;
          padding: 2.2rem 1rem;
          text-align: center;
          font-size: 0.92rem;
          color: var(--txt3);
          border: 1px dashed var(--edge2);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.012);
        }
        .pc-bulkbar {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 0.7rem 1rem;
          margin-top: 1rem;
          padding: 0.75rem 0.95rem;
          border: 1px solid var(--edge2);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.02);
        }
        .pc-selall {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          font-family: var(--sans);
          font-size: 0.86rem;
          font-weight: 600;
          color: var(--txt2);
          cursor: pointer;
          user-select: none;
          white-space: nowrap;
        }
        .pc-bulk {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 0.55rem 0.8rem;
          margin-left: auto;
        }
        .pc-bulk-count {
          font-family: var(--sans);
          font-size: 0.84rem;
          font-weight: 700;
          color: var(--txt);
          white-space: nowrap;
        }
        .pc-bulk-field {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .pc-bulk-input-wrap {
          flex: 0 0 auto;
          width: 230px;
        }
        .pc-bulk-apply {
          flex: none;
          min-height: 38px;
          padding: 0 16px;
          border: 0;
          border-radius: 10px;
          font-family: var(--sans);
          font-size: 0.84rem;
          font-weight: 700;
          color: var(--void);
          cursor: pointer;
          background: linear-gradient(135deg, var(--gold) 0%, var(--gold2) 100%);
          box-shadow: 0 6px 18px rgba(201, 168, 76, 0.26);
          transition: transform 0.18s ease, box-shadow 0.18s ease,
            opacity 0.18s ease;
          white-space: nowrap;
        }
        .pc-bulk-apply:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 10px 26px rgba(201, 168, 76, 0.34);
        }
        .pc-bulk-apply:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .pc-bulk-clear {
          flex: none;
          min-height: 38px;
          padding: 0 12px;
          border: 1px solid var(--edge2);
          border-radius: 10px;
          background: transparent;
          color: var(--txt3);
          font-family: var(--sans);
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
          transition: color 0.18s ease, border-color 0.18s ease;
          white-space: nowrap;
        }
        .pc-bulk-clear:hover:not(:disabled) {
          color: var(--txt);
          border-color: var(--edge);
        }
        .pc-bulk-clear:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .pc-bulk-err {
          flex: 1 1 100%;
          font-family: var(--sans);
          font-size: 0.78rem;
          font-weight: 500;
          color: var(--red);
          text-align: right;
        }

        @media (max-width: 760px) {
          .pc-form-grid {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 640px) {
          .pc {
            padding: 1.2rem 1.1rem 1.3rem;
          }
          .pc-actions {
            width: 100%;
            flex-direction: column-reverse;
          }
          .pc-add,
          .pc-import-btn {
            width: 100%;
            justify-content: center;
          }
          .pc-toolbar {
            flex-direction: column;
            align-items: stretch;
            gap: 0.6rem;
          }
          .pc-search {
            flex-basis: auto;
            width: 100%;
          }
          .pc-filters {
            width: 100%;
          }
          .pc-chip {
            flex: 1 1 auto;
            justify-content: center;
          }
          .pc-thead {
            display: none;
          }
          .pc-row {
            grid-template-columns: 1fr;
            gap: 0.55rem;
            padding: 0.9rem 1rem;
            border-bottom: 1px solid var(--edge);
          }
          .pc-c-sku::before,
          .pc-c-name::before,
          .pc-c-cost::before {
            display: block;
          }
          .pc-c-act {
            justify-content: flex-start;
            margin-top: 0.2rem;
          }
          .pc-input,
          .pc-cost-input,
          .pc-search-input {
            font-size: 16px;
          }
          .pc-icon {
            width: 44px;
            height: 44px;
          }
          .pc-mini,
          .pc-cost-save {
            min-height: 44px;
          }
          .pc-c-check {
            justify-content: flex-start;
          }
          .pc-bulkbar {
            flex-direction: column;
            align-items: stretch;
          }
          .pc-bulk {
            margin-left: 0;
            flex-direction: column;
            align-items: stretch;
          }
          .pc-bulk-field {
            flex-direction: column;
            align-items: stretch;
          }
          .pc-bulk-input-wrap {
            width: 100%;
          }
          .pc-bulk-apply,
          .pc-bulk-clear {
            min-height: 44px;
            text-align: center;
          }
          .pc-bulk-err {
            text-align: left;
          }
        }
      `}</style>
    </section>
  );
}
