// ============================================================================
// Рисование PDF-отчёта по расчёту «Отчёт по начислениям» (PR-2). Только браузер:
// canvas 2D + jsPDF. Кириллица: jsPDF стандартными шрифтами её не рисует, поэтому
// (как и в PDF старого режима) страницы рисуются на canvas системным шрифтом и
// вставляются в A4 картинками. В отличие от старого одностраничного отчёта здесь
// есть ПЕРЕНОС на следующие страницы: строки разбивки, предупреждения и пояснения
// не обрезаются, на каждой странице — шапка/подвал с нумерацией.
//
// Содержимое — из чистой модели pdf-model.ts (её проверяют тесты).
// ============================================================================

import type { AccrualPdfModel, PdfKeyProduct, PdfRow } from "./pdf-model";
import { buildAccrualPdfModel } from "./pdf-model";
import type { AccrualSnapshotV1 } from "./snapshot";

const SCALE = 2;
const W = 794; // A4 @96dpi
const H = 1123;
const ML = 56;
const MR = W - 56;
const CW = MR - ML;
const FOOTER_H = 70; // резерв под подвал
const CONTENT_TOP_NEXT = 84; // верх контента на 2+ страницах

const C = {
  bgTop: "#080a14",
  bgBot: "#05070f",
  panel: "#0d1020",
  panelHi: "#11152b",
  gold: "#C9A84C",
  gold2: "#E8C97A",
  gold3: "#F5DFA0",
  txt: "#E8EEF8",
  txt2: "#8A9FBB",
  txt3: "#56678a",
  green: "#2ECC8A",
  red: "#E05566",
  edge: "rgba(255,255,255,0.08)",
  edge2: "rgba(255,255,255,0.14)",
};
const SANS = "'Helvetica Neue', Arial, sans-serif";
const MONO = "'SF Mono', 'Roboto Mono', Menlo, monospace";

type Ctx = CanvasRenderingContext2D;

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** Перенос текста по ширине (по словам; слишком длинное слово режется по символам). */
function wrapText(ctx: Ctx, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    const flush = () => {
      if (line) out.push(line);
      line = "";
    };
    for (const word of words) {
      const probe = line ? `${line} ${word}` : word;
      if (ctx.measureText(probe).width <= maxW) {
        line = probe;
        continue;
      }
      flush();
      if (ctx.measureText(word).width <= maxW) {
        line = word;
        continue;
      }
      // одно слово шире строки — режем по символам
      let chunk = "";
      for (const ch of word) {
        if (ctx.measureText(chunk + ch).width > maxW && chunk) {
          out.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
    flush();
  }
  return out.length ? out : [""];
}

function ellipsize(ctx: Ctx, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

/** Нарисовать страницы отчёта; возвращает canvas'ы A4 (по одному на страницу). */
export function renderAccrualPages(model: AccrualPdfModel): HTMLCanvasElement[] {
  const canvases: HTMLCanvasElement[] = [];
  let ctx!: Ctx;
  let y = 0;

  const newPage = (first: boolean) => {
    const canvas = document.createElement("canvas");
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    const c = canvas.getContext("2d");
    if (!c) throw new Error("canvas 2d context недоступен");
    c.scale(SCALE, SCALE);
    canvases.push(canvas);
    ctx = c;

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, C.bgTop);
    bg.addColorStop(1, C.bgBot);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    if (first) {
      const glow = ctx.createRadialGradient(W / 2, -140, 40, W / 2, -140, 540);
      glow.addColorStop(0, "rgba(201,168,76,0.18)");
      glow.addColorStop(1, "rgba(201,168,76,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, 380);
    }
    const bar = ctx.createLinearGradient(0, 0, W, 0);
    bar.addColorStop(0, C.gold);
    bar.addColorStop(0.5, C.gold3);
    bar.addColorStop(1, C.gold);
    ctx.fillStyle = bar;
    ctx.fillRect(0, 0, W, 4);
    ctx.textBaseline = "alphabetic";

    if (first) {
      ctx.textAlign = "left";
      ctx.font = `800 30px ${SANS}`;
      ctx.fillStyle = C.txt;
      ctx.fillText("M-", ML, 72);
      const bw = ctx.measureText("M-").width;
      ctx.fillStyle = C.gold2;
      ctx.fillText("Prof", ML + bw, 72);
      ctx.font = `600 10px ${MONO}`;
      ctx.fillStyle = C.txt2;
      ctx.fillText(model.title, ML, 92);
      ctx.textAlign = "right";
      ctx.font = `700 13px ${SANS}`;
      ctx.fillStyle = C.gold2;
      ctx.fillText("Ozon", MR, 60);
      ctx.font = `400 11px ${MONO}`;
      ctx.fillStyle = C.txt2;
      ctx.fillText(model.dateStr, MR, 80);
      ctx.textAlign = "left";
      y = 108;
    } else {
      ctx.textAlign = "left";
      ctx.font = `800 15px ${SANS}`;
      ctx.fillStyle = C.txt;
      ctx.fillText("M-", ML, 46);
      const bw = ctx.measureText("M-").width;
      ctx.fillStyle = C.gold2;
      ctx.fillText("Prof", ML + bw, 46);
      ctx.textAlign = "right";
      ctx.font = `500 10px ${MONO}`;
      ctx.fillStyle = C.txt2;
      ctx.fillText(`${model.title} · ${model.periodLine}`, MR, 46);
      ctx.textAlign = "left";
      ctx.strokeStyle = C.edge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ML, 58);
      ctx.lineTo(MR, 58);
      ctx.stroke();
      y = CONTENT_TOP_NEXT;
    }
  };

  /** Гарантировать h пикселей на текущей странице, иначе начать новую. */
  const ensure = (h: number) => {
    if (y + h > H - FOOTER_H) newPage(false);
  };

  const sectionHeader = (title: string) => {
    ensure(40);
    ctx.textAlign = "left";
    ctx.font = `700 12px ${MONO}`;
    ctx.fillStyle = C.gold2;
    ctx.fillText(title, ML, y);
    const hw = ctx.measureText(title).width;
    ctx.strokeStyle = C.edge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ML + hw + 16, y - 4);
    ctx.lineTo(MR, y - 4);
    ctx.stroke();
    y += 18;
  };

  newPage(true);

  // ── Период и плашки статуса ──
  ctx.textAlign = "left";
  ctx.font = `700 14px ${SANS}`;
  ctx.fillStyle = C.gold2;
  ctx.fillText(model.periodLine, ML, y + 8);
  y += 22;
  if (model.badges.length > 0) {
    let bx = ML;
    ctx.font = `700 9px ${MONO}`;
    for (const b of model.badges) {
      const tw = ctx.measureText(b.text).width;
      const bw = tw + 22;
      if (bx + bw > MR) {
        bx = ML;
        y += 26;
      }
      roundRect(ctx, bx, y, bw, 20, 10);
      ctx.fillStyle = b.tone === "warn" ? "rgba(224,85,102,0.12)" : "rgba(201,168,76,0.10)";
      ctx.fill();
      ctx.strokeStyle = b.tone === "warn" ? "rgba(224,85,102,0.45)" : "rgba(201,168,76,0.4)";
      ctx.lineWidth = 1;
      roundRect(ctx, bx, y, bw, 20, 10);
      ctx.stroke();
      ctx.fillStyle = b.tone === "warn" ? C.red : C.gold2;
      ctx.fillText(b.text, bx + 11, y + 14);
      bx += bw + 8;
    }
    y += 26;
  }
  y += 6;

  // ── Hero: главный итог + маржа/ROI ──
  const heroH = 150;
  const heroY = y;
  const hg = ctx.createLinearGradient(ML, heroY, ML, heroY + heroH);
  hg.addColorStop(0, C.panelHi);
  hg.addColorStop(1, C.panel);
  roundRect(ctx, ML, heroY, CW, heroH, 16);
  ctx.fillStyle = hg;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(201,168,76,0.30)";
  roundRect(ctx, ML, heroY, CW, heroH, 16);
  ctx.stroke();

  const pad = 28;
  ctx.textAlign = "left";
  ctx.font = `600 11px ${MONO}`;
  ctx.fillStyle = C.txt2;
  ctx.fillText(model.hero.label, ML + pad, heroY + 38);
  ctx.font = `800 44px ${SANS}`;
  ctx.fillStyle = model.hero.positive ? C.green : C.red;
  ctx.fillText(model.hero.value, ML + pad, heroY + 92);
  const cardW = 156;
  const cardH = 54;
  const cardX = MR - pad - cardW;
  ctx.font = `500 11.5px ${SANS}`;
  ctx.fillStyle = C.txt3;
  const capLines = wrapText(ctx, model.hero.caption, cardX - (ML + pad) - 16);
  capLines.slice(0, 2).forEach((ln, i) => ctx.fillText(ln, ML + pad, heroY + 116 + i * 15));
  model.hero.stats.forEach((st, i) => {
    const cy = heroY + 19 + i * (cardH + 9);
    roundRect(ctx, cardX, cy, cardW, cardH, 12);
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.edge;
    roundRect(ctx, cardX, cy, cardW, cardH, 12);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.font = `600 9.5px ${MONO}`;
    ctx.fillStyle = C.txt2;
    ctx.fillText(st.label, cardX + 16, cy + 21);
    ctx.font = `700 21px ${SANS}`;
    ctx.fillStyle = st.neg ? C.red : C.gold2;
    ctx.fillText(st.value, cardX + 16, cy + 44);
  });
  y = heroY + heroH + 38;

  // ── Разбивка расчёта (с переносом строк на новые страницы) ──
  sectionHeader(model.breakdownTitle);
  const padX = 20;
  const valueColW = 168;
  const colorFor = (k: PdfRow["kind"]) =>
    k === "income" ? C.green : k === "expense" ? C.red : k === "total" ? C.gold2 : k === "subtotal" ? C.txt : C.txt2;
  for (const r of model.rows) {
    const isTotal = r.kind === "total";
    const isSub = r.kind === "subtotal";
    ctx.font = `500 10px ${SANS}`;
    const noteLines = r.sub ? wrapText(ctx, r.sub, CW - padX * 2 - valueColW) : [];
    const rowH = (isTotal ? 46 : 38) + noteLines.length * 13;
    ensure(rowH + 4);
    if (isTotal) {
      roundRect(ctx, ML + 4, y, CW - 8, rowH - 4, 10);
      ctx.fillStyle = "rgba(201,168,76,0.10)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(201,168,76,0.38)";
      roundRect(ctx, ML + 4, y, CW - 8, rowH - 4, 10);
      ctx.stroke();
    } else if (isSub) {
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(ML, y, CW, rowH - 2);
    }
    const baseY = y + (isTotal ? 29 : 25);
    ctx.textAlign = "left";
    ctx.font = `${isTotal ? "700" : isSub ? "700" : "500"} ${isTotal ? 15 : 13}px ${SANS}`;
    ctx.fillStyle = isTotal || isSub ? C.txt : C.txt2;
    ctx.fillText(ellipsize(ctx, r.label, CW - padX * 2 - valueColW + 60), ML + padX, baseY);
    ctx.textAlign = "right";
    ctx.font = `${isTotal ? "800" : "700"} ${isTotal ? 17 : 13}px ${SANS}`;
    ctx.fillStyle = colorFor(r.kind);
    ctx.fillText(r.value, MR - padX, baseY);
    ctx.textAlign = "left";
    if (noteLines.length > 0) {
      ctx.font = `400 10px ${SANS}`;
      ctx.fillStyle = C.txt3;
      noteLines.forEach((ln, i) => ctx.fillText(ln, ML + padX, baseY + 15 + i * 13));
    }
    if (!isTotal) {
      ctx.strokeStyle = C.edge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ML + padX, y + rowH - 3);
      ctx.lineTo(MR - padX, y + rowH - 3);
      ctx.stroke();
    }
    y += rowH;
  }

  // ── Покрытие каталога ──
  y += 14;
  ctx.font = `500 11px ${SANS}`;
  const covLines = wrapText(ctx, model.coverageLine, CW);
  ensure(covLines.length * 15 + 8);
  ctx.fillStyle = C.txt2;
  ctx.textAlign = "left";
  covLines.forEach((ln, i) => ctx.fillText(ln, ML, y + i * 15));
  y += covLines.length * 15 + 12;

  // ── Ключевые товары ──
  const kp = model.keyProducts;
  if (kp) {
    ensure(18 + 112 + 40);
    y += 8;
    sectionHeader("КЛЮЧЕВЫЕ ТОВАРЫ");
    const gap = 16;
    const cw = (CW - gap) / 2;
    const ch = 112;
    const card = (x: number, kind: "best" | "worst", p: PdfKeyProduct | null) => {
      roundRect(ctx, x, y, cw, ch, 12);
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.edge;
      roundRect(ctx, x, y, cw, ch, 12);
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.font = `700 9.5px ${MONO}`;
      ctx.fillStyle = !p ? C.txt2 : kind === "best" ? C.green : C.red;
      ctx.fillText(kind === "best" ? "САМЫЙ ПРИБЫЛЬНЫЙ" : kp.worstTitle, x + 16, y + 22);
      if (!p) {
        // «Самый прибыльный» без прибыльных товаров — нейтрально-предупреждающий тон.
        const warn = kind === "best" || kp.worstEmptyTone === "warn";
        roundRect(ctx, x + 16, y + ch / 2 - 1, cw - 32, 30, 8);
        ctx.fillStyle = warn ? "rgba(232,176,75,0.10)" : "rgba(46,204,138,0.10)";
        ctx.fill();
        ctx.strokeStyle = warn ? "rgba(232,176,75,0.35)" : "rgba(46,204,138,0.30)";
        roundRect(ctx, x + 16, y + ch / 2 - 1, cw - 32, 30, 8);
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.font = `600 11px ${SANS}`;
        ctx.fillStyle = warn ? C.gold2 : C.green;
        ctx.fillText(kind === "best" ? kp.bestEmptyText : kp.worstEmptyText, x + cw / 2, y + ch / 2 + 19);
        ctx.textAlign = "left";
        return;
      }
      ctx.font = `700 13px ${SANS}`;
      ctx.fillStyle = C.txt;
      ctx.fillText(ellipsize(ctx, p.name, cw - 32), x + 16, y + 46);
      ctx.font = `400 9px ${MONO}`;
      ctx.fillStyle = C.txt3;
      ctx.fillText(ellipsize(ctx, "Артикул: " + p.article, cw - 32), x + 16, y + 63);
      ctx.strokeStyle = C.edge;
      ctx.beginPath();
      ctx.moveTo(x + 16, y + 77);
      ctx.lineTo(x + cw - 16, y + 77);
      ctx.stroke();
      ctx.font = `600 8px ${MONO}`;
      ctx.fillStyle = C.txt3;
      ctx.fillText(kind === "best" ? "ЧИСТАЯ ПРИБЫЛЬ" : kp.worstProfitLabel, x + 16, y + 92);
      ctx.font = `800 15px ${SANS}`;
      ctx.fillStyle = p.positive ? C.green : C.red;
      ctx.fillText(p.profit, x + 16, y + 106);
      ctx.textAlign = "right";
      ctx.font = `600 8px ${MONO}`;
      ctx.fillStyle = C.txt3;
      ctx.fillText(kind === "best" ? "МАРЖА" : kp.worstMarginLabel, x + cw - 16, y + 92);
      ctx.font = `700 14px ${SANS}`;
      ctx.fillStyle = p.marginNeg ? C.red : C.txt;
      ctx.fillText(p.margin, x + cw - 16, y + 106);
      ctx.textAlign = "left";
    };
    card(ML, "best", kp.best);
    card(ML + cw + gap, "worst", kp.worst);
    y += ch + 14;
    if (kp.worstNote) {
      // Подпись охвата «самого убыточного» — то же правило, что на экране.
      ctx.font = `400 10px ${SANS}`;
      const lines = wrapText(ctx, kp.worstNote, CW);
      ensure(lines.length * 14 + 6);
      ctx.fillStyle = C.txt3;
      ctx.textAlign = "left";
      lines.forEach((ln, i) => ctx.fillText(ln, ML, y + 4 + i * 14));
      y += lines.length * 14 + 8;
    }
  }

  // ── Списки с переносом: предупреждения и пояснения ──
  const bulletList = (title: string, items: string[], accent: string) => {
    if (items.length === 0) return;
    ensure(40 + 30);
    y += 14;
    sectionHeader(title);
    ctx.font = `400 11px ${SANS}`;
    for (const it of items) {
      const lines = wrapText(ctx, it, CW - 18);
      ensure(lines.length * 15 + 8);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(ML + 4, y - 3.5, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `400 11px ${SANS}`;
      ctx.fillStyle = C.txt2;
      ctx.textAlign = "left";
      lines.forEach((ln, i) => ctx.fillText(ln, ML + 18, y + i * 15));
      y += lines.length * 15 + 7;
    }
  };
  bulletList(model.splitTitle, model.splitLines, C.gold2);
  bulletList(model.noticesTitle, model.notices, C.red);
  bulletList(model.explanationsTitle, model.explanations, C.gold2);

  // ── Подвал и нумерация на каждой странице ──
  const total = canvases.length;
  canvases.forEach((canvas, i) => {
    const c = canvas.getContext("2d");
    if (!c) return;
    c.textBaseline = "alphabetic";
    c.strokeStyle = C.edge;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(ML, H - 56);
    c.lineTo(MR, H - 56);
    c.stroke();
    c.textAlign = "left";
    c.font = `500 10px ${MONO}`;
    c.fillStyle = C.txt3;
    c.fillText(ellipsize(c, model.footer, CW - 90), ML, H - 38);
    c.textAlign = "right";
    c.fillText(`Стр. ${i + 1} из ${total}`, MR, H - 38);
  });

  return canvases;
}

/** Сформировать и скачать PDF. Возвращает число страниц и имя файла. */
export async function downloadAccrualPdf(
  snapshot: AccrualSnapshotV1,
  now: Date = new Date()
): Promise<{ pages: number; fileName: string }> {
  const { jsPDF } = await import("jspdf");
  const model = buildAccrualPdfModel(snapshot, now);
  const canvases = renderAccrualPages(model);
  const doc = new jsPDF({ orientation: "portrait", unit: "px", format: "a4" });
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  canvases.forEach((canvas, i) => {
    if (i > 0) doc.addPage();
    doc.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, pw, ph);
  });
  doc.save(model.fileName);
  return { pages: canvases.length, fileName: model.fileName };
}
