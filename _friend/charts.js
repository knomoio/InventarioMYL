// Gráficos de la vista Estadísticas usando Chart.js (carga perezosa).
import { loadScript, CDN } from "./cdn.js";

const charts = {}; // id -> instancia Chart
const PALETTE = [
  "#c9a13b", "#d9b85a", "#5b8def", "#46a758", "#e5484d", "#9b5de5",
  "#f59e0b", "#14b8a6", "#ec4899", "#64748b", "#84cc16", "#06b6d4",
  "#a855f7", "#ef4444", "#22c55e", "#eab308",
];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function draw(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (charts[id]) charts[id].destroy();
  charts[id] = new window.Chart(canvas.getContext("2d"), config);
}

function countBy(cards, keyFn) {
  const m = new Map();
  for (const c of cards) {
    const k = keyFn(c);
    if (k == null || k === "—" || k === "") continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function sortedEntries(map, limit) {
  let e = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (limit && e.length > limit) {
    const top = e.slice(0, limit);
    const rest = e.slice(limit).reduce((s, [, v]) => s + v, 0);
    if (rest > 0) top.push(["Otras", rest]);
    e = top;
  }
  return e;
}

const FMT_NAMES = { PE: "Primera Era", PB: "Primer Bloque", SB: "Segundo Bloque", FX: "Furia Ext.", NE: "Nueva Era/IMP" };

export async function renderCharts({ cards, getQty, scope = "all", format = "" }) {
  await loadScript(CDN.chart);
  const Chart = window.Chart;
  Chart.defaults.color = cssVar("--muted") || "#9aa1b2";
  Chart.defaults.font.family = "Segoe UI, system-ui, sans-serif";
  Chart.defaults.plugins.legend.labels.boxWidth = 12;

  // Conjunto base (respeta formato elegido en estadísticas)
  const base = format ? cards.filter((c) => c.format === format) : cards;
  // Conjunto según alcance para los gráficos por dimensión
  const set = base.filter((c) => {
    const q = getQty(c.id);
    if (scope === "owned") return q > 0;
    if (scope === "missing") return q === 0;
    return true;
  });

  const baseOpts = (legend = "right") => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: legend } },
  });

  // 1) Progreso (poseídas vs faltantes) sobre el conjunto base
  const owned = base.filter((c) => getQty(c.id) > 0).length;
  const missing = base.length - owned;
  draw("chart-progress", {
    type: "doughnut",
    data: {
      labels: ["Poseídas", "Faltantes"],
      datasets: [{ data: [owned, missing], backgroundColor: ["#46a758", "#2b3040"], borderWidth: 0 }],
    },
    options: { ...baseOpts("bottom"), cutout: "62%" },
  });

  // 2) Por formato
  const byFmt = countBy(set, (c) => c.format);
  draw("chart-format", {
    type: "doughnut",
    data: {
      labels: [...byFmt.keys()].map((k) => FMT_NAMES[k] || k),
      datasets: [{ data: [...byFmt.values()], backgroundColor: PALETTE, borderWidth: 0 }],
    },
    options: baseOpts("right"),
  });

  // 3) Top razas
  const byRace = sortedEntries(countBy(set, (c) => c.race), 12);
  draw("chart-race", {
    type: "bar",
    data: {
      labels: byRace.map((e) => e[0]),
      datasets: [{ label: "Cartas", data: byRace.map((e) => e[1]), backgroundColor: "#c9a13b", borderRadius: 4 }],
    },
    options: { ...baseOpts(), indexAxis: "y", plugins: { legend: { display: false } } },
  });

  // 4) Curva de coste
  const costMap = new Map();
  for (const c of set) {
    if (c.cost == null) continue;
    const k = c.cost >= 11 ? "11+" : String(c.cost);
    costMap.set(k, (costMap.get(k) || 0) + 1);
  }
  const costKeys = [...Array(11).keys()].map(String).concat("11+").filter((k) => costMap.has(k));
  draw("chart-cost", {
    type: "bar",
    data: {
      labels: costKeys,
      datasets: [{ label: "Cartas", data: costKeys.map((k) => costMap.get(k) || 0), backgroundColor: "#5b8def", borderRadius: 4 }],
    },
    options: { ...baseOpts(), plugins: { legend: { display: false } } },
  });

  // 5) Por tipo
  const byType = sortedEntries(countBy(set, (c) => c.type));
  draw("chart-type", {
    type: "doughnut",
    data: {
      labels: byType.map((e) => e[0]),
      datasets: [{ data: byType.map((e) => e[1]), backgroundColor: PALETTE, borderWidth: 0 }],
    },
    options: baseOpts("right"),
  });

  // 6) Por rareza
  const byRarity = sortedEntries(countBy(set, (c) => c.rarity), 10);
  draw("chart-rarity", {
    type: "bar",
    data: {
      labels: byRarity.map((e) => e[0]),
      datasets: [{ label: "Cartas", data: byRarity.map((e) => e[1]), backgroundColor: "#9b5de5", borderRadius: 4 }],
    },
    options: { ...baseOpts(), plugins: { legend: { display: false } } },
  });
}
