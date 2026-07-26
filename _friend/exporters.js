// Exportación a Excel (.xlsx) y PDF con diseño cuidado. Carga perezosa.
import { loadScript, CDN } from "./cdn.js";
import { typeIcon, raceIcon } from "./icons.js";

const FMT_NAMES = { PE: "Primera Era", PB: "Primer Bloque", SB: "Segundo Bloque", FX: "Furia Extendido", NE: "Nueva Era / Imperio" };
const today = () => new Date().toISOString().slice(0, 10);

// Logo de la app como dataURL (para incrustarlo en la imagen exportada)
let _logoData;
async function getLogoData() {
  if (_logoData !== undefined) return _logoData;
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej;
      i.src = "./assets/logo.jpg";
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    _logoData = c.toDataURL("image/jpeg", 0.85);
  } catch { _logoData = ""; }
  return _logoData;
}

// Resumen agregado del conjunto de cartas
export function summarize(cards, getQty) {
  let uniqueOwned = 0, copies = 0;
  const byFmt = {};
  for (const c of cards) {
    const q = getQty(c.id);
    if (q > 0) { uniqueOwned++; copies += q; }
    const f = (byFmt[c.format] ||= { total: 0, owned: 0 });
    f.total++; if (q > 0) f.owned++;
  }
  const pct = cards.length ? Math.round((uniqueOwned / cards.length) * 100) : 0;
  return { total: cards.length, uniqueOwned, copies, pct, byFmt };
}

function rows(cards, getQty) {
  const out = [["Nombre", "Edición", "Formato", "Tipo", "Raza", "Rareza", "Coste", "Fuerza", "Cantidad"]];
  for (const c of cards) {
    out.push([c.name, c.editionName || c.edition, FMT_NAMES[c.format] || c.format,
      c.type, c.race, c.rarity, c.cost ?? "", c.strength ?? "", getQty(c.id)]);
  }
  return out;
}

/* ===================== EXCEL ===================== */
export async function exportExcel(cards, getQty, scopeLabel = "Colección") {
  await loadScript(CDN.xlsx);
  const XLSX = window.XLSX;
  const s = summarize(cards, getQty);

  const resumen = [
    ["Inventario Mitos y Leyendas"],
    ["Generado", new Date().toLocaleString("es-CL")],
    ["Alcance", scopeLabel],
    [],
    ["Cartas en el listado", s.total],
    ["Cartas únicas que tengo", s.uniqueOwned],
    ["Copias totales", s.copies],
    ["Avance", s.pct + "%"],
    [],
    ["Formato", "Tengo", "Total", "Avance"],
    ...Object.entries(s.byFmt).map(([f, v]) => [FMT_NAMES[f] || f, v.owned, v.total, (v.total ? Math.round((v.owned / v.total) * 100) : 0) + "%"]),
  ];

  const wb = XLSX.utils.book_new();
  const wsR = XLSX.utils.aoa_to_sheet(resumen);
  wsR["!cols"] = [{ wch: 28 }, { wch: 16 }, { wch: 10 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsR, "Resumen");

  const data = rows(cards, getQty);
  const wsC = XLSX.utils.aoa_to_sheet(data);
  wsC["!cols"] = [{ wch: 34 }, { wch: 26 }, { wch: 18 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 7 }, { wch: 7 }, { wch: 9 }];
  wsC["!autofilter"] = { ref: `A1:I${data.length}` };
  wsC["!freeze"] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsC, "Cartas");

  XLSX.writeFile(wb, `inventario_myl_${today()}.xlsx`);
}

/* ===================== PDF ===================== */
export async function exportPDF(cards, getQty, scopeLabel = "Colección") {
  await loadScript(CDN.jspdf);
  await loadScript(CDN.autotable);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const s = summarize(cards, getQty);
  const W = doc.internal.pageSize.getWidth();
  const GOLD = [201, 161, 59];

  // Encabezado
  doc.setFillColor(15, 17, 23); doc.rect(0, 0, W, 64, "F");
  doc.setTextColor(...GOLD); doc.setFont("helvetica", "bold"); doc.setFontSize(20);
  doc.text("Inventario Mitos y Leyendas", 40, 32);
  doc.setTextColor(200); doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  doc.text(`${scopeLabel}  ·  ${new Date().toLocaleString("es-CL")}`, 40, 50);

  // Tarjetas de resumen
  const cardsRow = [
    ["Cartas en listado", s.total],
    ["Únicas que tengo", s.uniqueOwned],
    ["Copias totales", s.copies],
    ["Avance", s.pct + "%"],
  ];
  let x = 40; const y = 80, cw = (W - 80) / 4 - 10;
  cardsRow.forEach(([lbl, val]) => {
    doc.setFillColor(247, 247, 250); doc.roundedRect(x, y, cw, 52, 6, 6, "F");
    doc.setTextColor(40); doc.setFont("helvetica", "bold"); doc.setFontSize(18);
    doc.text(String(val), x + 12, y + 26);
    doc.setTextColor(110); doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    doc.text(String(lbl), x + 12, y + 42);
    x += cw + 13;
  });

  // Resumen por formato
  doc.autoTable({
    startY: y + 70,
    head: [["Formato", "Tengo", "Total", "Avance"]],
    body: Object.entries(s.byFmt).map(([f, v]) => [FMT_NAMES[f] || f, v.owned, v.total, (v.total ? Math.round((v.owned / v.total) * 100) : 0) + "%"]),
    theme: "grid",
    headStyles: { fillColor: GOLD, textColor: 20 },
    styles: { fontSize: 9 },
    margin: { left: 40, right: 40 },
  });

  // Tabla de cartas
  const data = rows(cards, getQty);
  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 18,
    head: [data[0]],
    body: data.slice(1),
    theme: "striped",
    headStyles: { fillColor: [31, 35, 48], textColor: 220 },
    alternateRowStyles: { fillColor: [245, 246, 250] },
    styles: { fontSize: 7.5, cellPadding: 2.5, overflow: "ellipsize" },
    columnStyles: { 0: { cellWidth: 150 }, 6: { halign: "center" }, 7: { halign: "center" }, 8: { halign: "center", fontStyle: "bold" } },
    margin: { left: 40, right: 40 },
    didDrawPage: () => {
      const p = doc.internal.getNumberOfPages();
      doc.setFontSize(8); doc.setTextColor(150);
      doc.text(`Página ${p}`, W - 60, doc.internal.pageSize.getHeight() - 16);
    },
  });

  doc.save(`inventario_myl_${today()}.pdf`);
}

/* ===================== MAZO: helpers ===================== */
function fmtDate(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" });
}
// Devuelve las cartas del mazo enriquecidas y agrupadas por tipo
function deckRows(deck, cards, getQty, displayName) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rows = [];
  for (const [cid, q] of Object.entries(deck.cards)) {
    const c = byId.get(cid) || { name: cid, race: "—", type: "Otro", cost: null, strength: null, rarity: "—", editionName: "" };
    rows.push({
      qty: q, name: displayName ? displayName(c) : c.name, race: c.race, type: c.type,
      cost: c.cost, strength: c.strength, rarity: c.rarity, edition: c.editionName || c.edition || "",
      own: getQty(cid), missing: Math.max(0, q - getQty(cid)),
    });
  }
  rows.sort((a, b) => (a.type || "").localeCompare(b.type || "", "es") || a.name.localeCompare(b.name, "es"));
  return rows;
}

// Resumen del mazo: totales, distribución por tipo y matriz tipo × coste
export function deckSummary(deck, cards, getQty, displayName) {
  const rows = deckRows(deck, cards, getQty, displayName);
  const total = rows.reduce((s, r) => s + r.qty, 0);
  const missing = rows.reduce((s, r) => s + r.missing, 0);
  const TYPE_ORDER = ["Aliado", "Talismán", "Tótem", "Arma", "Oro", "Monumento", "Otro"];
  const typeTotal = {}, matrix = {}, costKeys = new Set();
  for (const r of rows) {
    const t = r.type || "Otro";
    typeTotal[t] = (typeTotal[t] || 0) + r.qty;
    const ck = r.cost == null ? "–" : (r.cost >= 8 ? "8+" : String(r.cost));
    (matrix[t] ||= {})[ck] = (matrix[t][ck] || 0) + r.qty;
    costKeys.add(ck);
  }
  const ord = (k) => (k === "–" ? 999 : k === "8+" ? 100 : Number(k));
  const cols = [...costKeys].sort((a, b) => ord(a) - ord(b));
  const typesPresent = TYPE_ORDER.filter((t) => typeTotal[t]);
  for (const t of Object.keys(typeTotal)) if (!typesPresent.includes(t)) typesPresent.push(t);
  const colTotal = (c) => typesPresent.reduce((s, t) => s + (matrix[t][c] || 0), 0);
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return { rows, total, missing, typeTotal, matrix, cols, typesPresent, colTotal, pct };
}

/* ===================== MAZO: Excel ===================== */
export async function exportDeckExcel(deck, cards, getQty, displayName) {
  await loadScript(CDN.xlsx);
  const XLSX = window.XLSX;
  const rows = deckRows(deck, cards, getQty, displayName);
  const total = rows.reduce((s, r) => s + r.qty, 0);
  const missing = rows.reduce((s, r) => s + r.missing, 0);

  const head = [
    [`Mazo: ${deck.name}`],
    ["Actualizado", fmtDate(deck.updatedAt)],
    ["Total de cartas", total],
    ["Te faltan", missing],
    [],
    ["Cant.", "Nombre", "Raza", "Tipo", "Coste", "Fuerza", "Rareza", "Edición", "Tengo", "Faltan"],
  ];
  const body = rows.map((r) => [r.qty, r.name, r.race, r.type, r.cost ?? "", r.strength ?? "", r.rarity, r.edition, r.own, r.missing || ""]);
  const ws = XLSX.utils.aoa_to_sheet(head.concat(body));
  ws["!cols"] = [{ wch: 6 }, { wch: 30 }, { wch: 16 }, { wch: 12 }, { wch: 7 }, { wch: 7 }, { wch: 14 }, { wch: 22 }, { wch: 7 }, { wch: 7 }];
  ws["!autofilter"] = { ref: `A6:J${6 + body.length}` };
  const wb = XLSX.utils.book_new();

  // Hoja "Resumen": distribución por tipo + matriz tipo × coste
  const S = deckSummary(deck, cards, getQty, displayName);
  const resumen = [
    [`Resumen: ${deck.name}`],
    ["Actualizado", fmtDate(deck.updatedAt)],
    ["Total de cartas", S.total],
    [],
    ["Distribución por tipo", "Cantidad", "%"],
    ...S.typesPresent.map((t) => [t, S.typeTotal[t], S.pct(S.typeTotal[t]) + "%"]),
    [],
    ["Detalle por tipo y coste"],
    ["Tipo", ...S.cols, "Total"],
    ...S.typesPresent.map((t) => [t, ...S.cols.map((c) => S.matrix[t][c] || ""), S.typeTotal[t]]),
    ["Total", ...S.cols.map((c) => S.colTotal(c)), S.total],
  ];
  const wsR = XLSX.utils.aoa_to_sheet(resumen);
  wsR["!cols"] = [{ wch: 16 }, ...S.cols.map(() => ({ wch: 5 })), { wch: 7 }];
  XLSX.utils.book_append_sheet(wb, wsR, "Resumen");

  XLSX.utils.book_append_sheet(wb, ws, "Mazo");
  XLSX.writeFile(wb, `mazo_${deck.name.replace(/\s+/g, "_")}_${today()}.xlsx`);
}

/* ===================== MAZO: Imagen (PNG) ===================== */
export async function exportDeckImage(deck, cards, getQty, displayName) {
  await loadScript(CDN.html2canvas);
  const logo = await getLogoData();
  const { rows, total, missing, typeTotal, matrix, cols, typesPresent, colTotal, pct } = deckSummary(deck, cards, getQty, displayName);

  // Agrupa por tipo
  const groups = {};
  for (const r of rows) (groups[r.type] ||= []).push(r);

  const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const colsHtml = Object.entries(groups).map(([type, rs]) => `
    <div style="break-inside:avoid;margin-bottom:14px">
      <div style="color:#d9b85a;font-weight:700;font-size:15px;border-bottom:1px solid #3a3f50;padding-bottom:4px;margin-bottom:6px">
        ${typeIcon(type)} ${esc(type)} <span style="color:#8b93a7;font-weight:400">(${rs.reduce((a, r) => a + r.qty, 0)})</span>
      </div>
      ${rs.map((r) => `
        <div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:14px">
          <span style="color:#d9b85a;font-weight:700;min-width:26px">${r.qty}×</span>
          <span style="flex:1;color:#fff">${esc(r.name)}${r.missing ? ` <span style="color:#e5707a;font-size:12px">(faltan ${r.missing})</span>` : ""}</span>
          <span style="color:#9aa1b2;font-size:12px">${raceIcon(r.race)} ${esc(r.race)}</span>
          ${r.cost != null ? `<span style="background:#1f2330;color:#e7e9ee;border-radius:10px;padding:1px 7px;font-size:12px">⛁ ${r.cost}</span>` : ""}
          ${r.strength != null ? `<span style="background:#7a2a2f;color:#fff;border-radius:6px;padding:1px 7px;font-size:12px">⚔ ${r.strength}</span>` : ""}
        </div>`).join("")}
    </div>`).join("");

  const distHtml = typesPresent.map((t) => `
    <div style="flex:1;min-width:120px;background:#171a23;border:1px solid #2b3040;border-radius:10px;padding:10px 12px">
      <div style="font-size:12px;color:#9aa1b2">${typeIcon(t)} ${esc(t)}</div>
      <div style="font-size:22px;font-weight:800;color:#d9b85a">${typeTotal[t]}<span style="font-size:12px;color:#8b93a7;font-weight:400"> · ${pct(typeTotal[t])}%</span></div>
    </div>`).join("");

  const th = (x) => `<th style="padding:5px 8px;color:#9aa1b2;font-weight:600;border-bottom:1px solid #2b3040;text-align:center">${x}</th>`;
  const td = (x, b) => `<td style="padding:5px 8px;text-align:center;${b ? "font-weight:700;color:#d9b85a" : "color:#e7e9ee"}">${x || ""}</td>`;
  const matrixHtml = `
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:10px">
      <thead><tr><th style="padding:5px 8px;text-align:left;color:#9aa1b2;border-bottom:1px solid #2b3040">Tipo</th>${cols.map((c) => th(c)).join("")}${th("Total")}</tr></thead>
      <tbody>
        ${typesPresent.map((t) => `<tr><td style="padding:5px 8px;color:#e7e9ee">${typeIcon(t)} ${esc(t)}</td>${cols.map((c) => td(matrix[t][c])).join("")}${td(typeTotal[t], true)}</tr>`).join("")}
        <tr style="border-top:1px solid #2b3040"><td style="padding:5px 8px;color:#9aa1b2;font-weight:700">Total</td>${cols.map((c) => td(colTotal(c), true)).join("")}${td(total, true)}</tr>
      </tbody>
    </table>`;

  const summaryHtml = `
    <div style="font-size:12px;color:#c9a13b;letter-spacing:1px;margin-bottom:8px">DISTRIBUCIÓN POR TIPO</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">${distHtml}</div>
    <div style="font-size:12px;color:#c9a13b;letter-spacing:1px">DETALLE POR TIPO Y COSTE</div>
    ${matrixHtml}
    <div style="height:18px"></div>`;

  const node = document.createElement("div");
  node.style.cssText = "position:fixed;left:-9999px;top:0;width:680px;padding:24px;background:#0f1117;color:#e7e9ee;font-family:Segoe UI,system-ui,sans-serif;box-sizing:border-box";
  node.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #c9a13b;padding-bottom:10px;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:12px">
        ${logo ? `<img src="${logo}" style="height:58px;width:auto;border-radius:6px" />` : ""}
        <div>
          <div style="font-size:13px;color:#c9a13b;letter-spacing:1px">INVENTARIO MyL · MAZO</div>
          <div style="font-size:24px;font-weight:800">${esc(deck.name)}</div>
        </div>
      </div>
      <div style="text-align:right;font-size:12px;color:#9aa1b2">
        <div><b style="color:#e7e9ee">${total}</b> cartas${missing ? ` · faltan ${missing}` : ""}</div>
        <div>Actualizado: ${fmtDate(deck.updatedAt)}</div>
      </div>
    </div>
    ${rows.length ? summaryHtml : ""}
    <div style="column-count:2;column-gap:24px">${colsHtml || '<span style="color:#9aa1b2">Mazo vacío</span>'}</div>
    <div style="margin-top:18px;text-align:center;color:#5b6273;font-size:11px">knomoio.github.io/InventarioMYL</div>`;
  document.body.appendChild(node);
  try {
    const canvas = await window.html2canvas(node, { backgroundColor: "#0f1117", scale: 2 });
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `mazo_${deck.name.replace(/\s+/g, "_")}_${today()}.png`;
    a.click();
  } finally {
    node.remove();
  }
}
