import * as store from "./store.js";
import { exportExcel, exportPDF, exportDeckExcel, exportDeckImage, deckSummary } from "./exporters.js";
import { renderCharts } from "./charts.js";
import * as cloud from "./cloud.js";
import { typeIcon, raceIcon, NO_STRENGTH_TYPES } from "./icons.js";
import { importEditionFromWiki } from "./wiki-import.js";

/* ===================== Estado global ===================== */
const state = {
  cards: [],
  editions: [],
  editionName: {}, // slug -> nombre legible
  filtered: [],
  page: 0,
  pageSize: 60,
  view: "coleccion",
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ===================== Carga de datos ===================== */
async function loadData() {
  const [cardsRes, edRes, customRes] = await Promise.all([
    fetch("./data/cards.json").then((r) => r.json()).catch(() => ({ cards: [] })),
    fetch("./data/editions.json").then((r) => r.json()).catch(() => []),
    fetch("./data/custom-cards.json").then((r) => (r.ok ? r.json() : { cards: [] })).catch(() => ({ cards: [] })),
  ]);

  const scraped = (cardsRes.cards || cardsRes || []).map(normalizeCard);
  const bundledCustom = (customRes.cards || []).map(normalizeCard);
  state.baseCards = [...scraped, ...bundledCustom];
  state.editions = Array.isArray(edRes) ? edRes : [];
  state.editionName = Object.fromEntries(state.editions.map((e) => [e.slug, e.name]));

  // Asegura nombre legible de edición y precalcula texto de búsqueda (una vez)
  for (const c of state.baseCards) {
    c.editionName = c.editionName || state.editionName[c.edition] || c.edition || "—";
    c.searchText = normText(c.name + " " + c.ability);
  }
  // Migración auto-reconciliante (Capa B): remapea inventario/mazos de
  // legacyId → id estable usando el catálogo. Idempotente; se cura sola cuando
  // vuelve una edición que había fallado.
  try {
    const legacyMap = {};
    for (const c of state.baseCards) if (c.legacyId && c.legacyId !== c.id) legacyMap[c.legacyId] = c.id;
    if (store.migrateKeys(legacyMap)) console.info("Inventario/mazos migrados a ids estables");
  } catch (e) { console.warn("migración de ids:", e); }

  rebuildCards();
  if (cardsRes.meta?.source === "seed") {
    showToast("Mostrando datos de demostración. Ejecuta el scraper para cargar el catálogo real.", 5000);
  }
}

function normalizeCard(c, i) {
  const id = c.id || `${c.edition || "x"}__${(c.name || "carta_" + i).toLowerCase().replace(/\s+/g, "_")}`;
  return {
    id,
    slug: c.slug || "",
    legacyId: c.legacyId || "",
    name: c.name || "Sin nombre",
    edition: c.edition || "",
    editionName: c.editionName || "",
    format: c.format || "",
    edid: c.edid || "",
    specialId: c.specialId || "",
    type: c.type || "—",
    race: c.race || "—",
    rarity: c.rarity || "—",
    keyword: c.keyword || "",
    cost: numOrNull(c.cost),
    strength: NO_STRENGTH_TYPES.has(c.type || "—") ? null : numOrNull(c.strength ?? c.attack),
    ability: c.ability || "",
    flavour: c.flavour || "",
    image: c.image || c.image_path || "",
    custom: !!c.custom,
  };
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// Combina las cartas base (catálogo + bundle) con las cartas manuales del usuario
function rebuildCards() {
  editionCardsCache.clear();
  // Nombres de ediciones personalizadas (para selects, colecciones, etc.)
  for (const ce of store.getCustomEditions()) state.editionName[ce.slug] = ce.name;
  const userCustom = store.getCustomCards().map(normalizeCard);
  for (const c of userCustom) {
    c.editionName = c.editionName || state.editionName[c.edition] || c.edition || "—";
    c.searchText = normText(c.name + " " + c.ability);
  }
  state.cards = (state.baseCards || []).concat(userCustom);
}
// Minúsculas sin diacríticos (á→a, ñ→n) para comparar/buscar sin importar tildes
function normText(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/* --- Correcci\u00f3n perezosa de nombres (la API del listado los entrega sin
   tildes/\u00f1; el perfil s\u00ed los trae). Se corrigen solo las cartas visibles y
   se cachean para no volver a consultarlas. --- */
const nameCache = (() => { try { return JSON.parse(localStorage.getItem("myl.namecache.v1")) || {}; } catch { return {}; } })();
let nameCacheTimer;
function saveNameCache() {
  clearTimeout(nameCacheTimer);
  nameCacheTimer = setTimeout(() => { try { localStorage.setItem("myl.namecache.v1", JSON.stringify(nameCache)); } catch {} }, 800);
}
function displayName(card) { return nameCache[card.id] || card.name; }

let nameQueue = [], nameActive = 0;
function scheduleNameCorrection(cards) {
  for (const c of cards) { if (c.custom || c.id in nameCache) continue; nameQueue.push(c); }
  pumpNames();
}
function pumpNames() {
  while (nameActive < 6 && nameQueue.length) {
    const c = nameQueue.shift();
    if (c.id in nameCache) continue;
    nameActive++;
    fetchProfile(c).then((p) => {
      const nm = p?.details?.name?.trim();
      nameCache[c.id] = nm || c.name; // marca como revisada (evita reconsultar)
      if (nm && nm !== c.name) updateCardNameInDom(c.id, nm);
      saveNameCache();
    }).catch(() => {}).finally(() => { nameActive--; pumpNames(); });
  }
}
function updateCardNameInDom(id, name) {
  const sel = `.card[data-id="${CSS.escape(id)}"]`;
  const el = document.querySelector(sel + " .card-name");
  if (el) el.textContent = name;
  const ph = document.querySelector(sel + " .ph-name");
  if (ph) ph.textContent = name;
}

/* ===================== Filtros (poblar selects) ===================== */
function uniqueSorted(values) {
  return [...new Set(values.filter((v) => v && v !== "—"))].sort((a, b) =>
    String(a).localeCompare(String(b), "es")
  );
}

function populateFilters() {
  // Formato
  const fmtNames = { PE: "Primera Era", PB: "Primer Bloque", SB: "Segundo Bloque", FX: "Furia Extendido", NE: "Nueva Era / Imperio" };
  fillSelect("#f-format", uniqueSorted(state.cards.map((c) => c.format)).map((f) => ({ value: f, label: fmtNames[f] || f })));
  fillSelect("#f-race", uniqueSorted(state.cards.map((c) => c.race)).map((v) => ({ value: v, label: v })));
  fillSelect("#f-type", uniqueSorted(state.cards.map((c) => c.type)).map((v) => ({ value: v, label: v })));
  fillSelect("#f-rarity", uniqueSorted(state.cards.map((c) => c.rarity)).map((v) => ({ value: v, label: v })));
  // Formato también en la vista de estadísticas
  fillSelect("#stats-format", uniqueSorted(state.cards.map((c) => c.format)).map((f) => ({ value: f, label: fmtNames[f] || f })));
  refreshEditionOptions();
}

function refreshEditionOptions() {
  const fmt = $("#f-format").value;
  // ediciones presentes en el dataset (respeta el formato seleccionado)
  const present = uniqueSorted(
    state.cards.filter((c) => !fmt || c.format === fmt).map((c) => c.edition)
  );
  const opts = present.map((slug) => ({ value: slug, label: state.editionName[slug] || slug }));
  fillSelect("#f-edition", opts);
}

function fillSelect(sel, opts) {
  const el = $(sel);
  const first = el.querySelector("option");
  el.innerHTML = "";
  el.appendChild(first.cloneNode(true));
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    el.appendChild(opt);
  }
}

/* ===================== Aplicar filtros ===================== */
function applyFilters() {
  const q = normText($("#search").value.trim());
  const ownership = $("#f-ownership").value;
  const fmt = $("#f-format").value;
  const ed = $("#f-edition").value;
  const race = $("#f-race").value;
  const type = $("#f-type").value;
  const rarity = $("#f-rarity").value;
  const maxCost = Number($("#f-cost").value);
  const sort = $("#f-sort").value;

  let out = state.cards.filter((c) => {
    if (q && !c.searchText.includes(q)) return false;
    if (fmt && c.format !== fmt) return false;
    if (ed && c.edition !== ed) return false;
    if (race && c.race !== race) return false;
    if (type && c.type !== type) return false;
    if (rarity && c.rarity !== rarity) return false;
    if (maxCost < 12 && c.cost != null && c.cost > maxCost) return false;
    const qty = store.getQty(c.id);
    if (ownership === "owned" && qty < 1) return false;
    if (ownership === "missing" && qty >= 1) return false;
    if (ownership === "dup" && qty < 2) return false;
    return true;
  });

  out.sort((a, b) => {
    switch (sort) {
      case "name_desc": return b.name.localeCompare(a.name, "es");
      case "cost": return (a.cost ?? 99) - (b.cost ?? 99);
      case "cost_desc": return (b.cost ?? -1) - (a.cost ?? -1);
      case "strength_desc": return (b.strength ?? -1) - (a.strength ?? -1);
      case "edition": return (a.editionName || "").localeCompare(b.editionName || "", "es");
      case "qty_desc": return store.getQty(b.id) - store.getQty(a.id);
      default: return a.name.localeCompare(b.name, "es");
    }
  });

  state.filtered = out;
  state.page = 0;
  renderGrid(true);
  updateResultCount();
  updateOrphanNote();
}

/* ===================== Cartas fuera de catálogo (huérfanas) ===================== */
function computeOrphans() {
  const ids = new Set(state.cards.map((c) => c.id));
  return Object.entries(store.getInventory())
    .filter(([id, q]) => q > 0 && !ids.has(id))
    .map(([id, qty]) => ({ id, qty }));
}
function updateOrphanNote() {
  const el = $("#orphan-note");
  if (!el) return;
  const n = computeOrphans().length;
  el.classList.toggle("hidden", n === 0);
  if (n) el.textContent = `⚠ ${n} fuera de catálogo`;
}
function openOrphanModal() {
  const list = computeOrphans();
  const box = $("#orphan-modal-box");
  box.innerHTML = `
    <button class="modal-close" data-close-orphan>×</button>
    <h2>Cartas fuera de catálogo</h2>
    <p class="muted">Cantidades guardadas en tu inventario que no calzan con ninguna carta del catálogo actual (p. ej. una edición que TOR aún no publica, o un dato antiguo). <b>No se borran solas</b>: si la edición vuelve al catálogo, se reconectan automáticamente. Puedes eliminarlas manualmente si sabes que ya no aplican.</p>
    ${list.length
      ? `<div class="orphan-list">` + list.map((o) => `
          <div class="orphan-row" data-id="${escapeAttr(o.id)}">
            <span class="mono">${escapeHtml(o.id)}</span>
            <span class="muted">×${o.qty}</span>
            <button class="btn small" data-del-orphan>Eliminar</button>
          </div>`).join("") + `</div>`
      : `<p class="muted">No hay cartas fuera de catálogo. 🎉</p>`}`;
  box.querySelector("[data-close-orphan]").onclick = closeOrphanModal;
  box.querySelectorAll(".orphan-row").forEach((r) => {
    r.querySelector("[data-del-orphan]").onclick = () => {
      if (!confirm(`¿Eliminar la cantidad de «${r.dataset.id}» de tu inventario?`)) return;
      store.setQty(r.dataset.id, 0);
      r.remove();
      updateOrphanNote();
    };
  });
  $("#orphan-modal").classList.remove("hidden");
}
function closeOrphanModal() { $("#orphan-modal").classList.add("hidden"); }

function updateResultCount() {
  const n = state.filtered.length;
  const owned = state.filtered.filter((c) => store.getQty(c.id) > 0).length;
  $("#result-count").textContent = `${n} carta${n === 1 ? "" : "s"} · ${owned} en tu colección`;
}

/* ===================== Render grid ===================== */
function renderGrid(reset) {
  const grid = $("#cards-grid");
  if (reset) grid.innerHTML = "";
  const start = state.page * state.pageSize;
  const slice = state.filtered.slice(start, start + state.pageSize);
  const frag = document.createDocumentFragment();
  for (const card of slice) frag.appendChild(cardEl(card));
  grid.appendChild(frag);
  scheduleNameCorrection(slice);

  $("#grid-empty").classList.toggle("hidden", state.filtered.length !== 0);
  const hasMore = (state.page + 1) * state.pageSize < state.filtered.length;
  $("#load-more").classList.toggle("hidden", !hasMore);
}

function cardEl(card) {
  const qty = store.getQty(card.id);
  const el = document.createElement("div");
  el.className = "card" + (qty > 0 ? " owned" : "");
  el.dataset.id = card.id;

  const dName = displayName(card);
  const img = card.image
    ? `<img loading="lazy" src="${escapeAttr(card.image)}" alt="${escapeAttr(dName)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'placeholder',innerHTML:'<div class=ph-name>${escapeAttr(dName)}</div>'}))" />`
    : `<div class="placeholder"><div class="ph-name">${escapeHtml(dName)}</div>${card.editionName || ""}</div>`;

  const activeDeck = store.getDeck(store.getSetting("activeDeckId"));
  const deckBtn = `<button class="qty-btn deck-add" title="${activeDeck ? "Añadir a «" + escapeAttr(activeDeck.name) + "»" : "Añadir a un mazo"}">🃏＋</button>`;

  el.innerHTML = `
    <div class="card-img" data-act="detail">
      ${card.cost != null ? `<span class="badge-cost">${card.cost}</span>` : ""}
      ${card.strength != null ? `<span class="badge-str">${card.strength}</span>` : ""}
      ${img}
    </div>
    <div class="card-body">
      <div class="card-name">${escapeHtml(dName)}</div>
      <div class="card-meta">${escapeHtml(card.race)} · ${escapeHtml(card.type)}</div>
      <div class="card-meta">${escapeHtml(card.editionName || "")}</div>
      <div class="qty-row">
        <button class="qty-btn" data-act="minus">−</button>
        <span class="qty-num ${qty === 0 ? "zero" : ""}" data-role="qty">${qty}</span>
        <button class="qty-btn" data-act="plus">+</button>
        ${deckBtn}
      </div>
    </div>`;

  el.addEventListener("click", (e) => {
    if (e.target.closest(".deck-add")) { addToDeckQuick(card); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "plus") changeQty(el, card, +1);
    else if (act === "minus") changeQty(el, card, -1);
    else if (act === "detail") openModal(card);
  });
  return el;
}

function changeQty(el, card, delta) {
  const qty = store.addQty(card.id, delta);
  const numEl = el.querySelector('[data-role="qty"]');
  numEl.textContent = qty;
  numEl.classList.toggle("zero", qty === 0);
  el.classList.toggle("owned", qty > 0);
  updateResultCount();
  updateCollectionProgress();
}

/* ===================== Modal detalle ===================== */
const FORMAT_LABELS = { empire: "Imperio", unified: "Unificado", first_era: "Primera Era", infantry: "Infantería", vcr: "VCR", joust: "Justa", reborn: "Renacido" };
const profileCache = new Map();
function fetchProfile(card) {
  const edition = card.edition;
  const slug = card.slug || card.id.split("__").slice(2).join("__");
  if (!edition || !slug) return Promise.resolve(null);
  const key = edition + "/" + slug;
  if (profileCache.has(key)) return profileCache.get(key);
  const p = fetch(`https://api.myl.cl/cards/profile/${encodeURIComponent(edition)}/${encodeURIComponent(slug)}`)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  profileCache.set(key, p);
  return p;
}
function nl2br(s) { return escapeHtml(s).replace(/\n/g, "<br>"); }

function openModal(card) {
  const qty = store.getQty(card.id);
  const box = $("#modal-box");
  const img = card.image
    ? `<img src="${escapeAttr(card.image)}" alt="${escapeAttr(card.name)}" />`
    : `<div class="placeholder" style="color:var(--muted);padding:20px;text-align:center">Sin imagen</div>`;
  const tag = (t) => `<span class="tag">${escapeHtml(t)}</span>`;
  box.innerHTML = `
    <button class="modal-close" data-close>×</button>
    <div class="card-detail">
      <div class="cd-image" ${card.image ? 'data-zoom="1"' : ""}>
        ${img}
        ${card.image ? '<span class="cd-zoom-hint">🔍 Ampliar</span>' : ""}
      </div>
      <div class="cd-body">
        <h2 id="cd-name">${escapeHtml(displayName(card))}</h2>
        <div class="m-tags">
          ${tag(card.editionName || "")}${tag(card.race)}${tag(card.type)}${tag(card.rarity)}
          ${card.cost != null ? tag("Coste " + card.cost) : ""}${card.strength != null ? tag("Fuerza " + card.strength) : ""}
        </div>
        <div class="qty-row" style="border:none;padding:0;margin:14px 0">
          <button class="qty-btn" data-m="minus">−</button>
          <span class="qty-num ${qty === 0 ? "zero" : ""}" data-role="mqty">${qty}</span>
          <button class="qty-btn" data-m="plus">+</button>
          <button class="btn small" data-add-deck>🃏 Añadir a mazo</button>
        </div>
        ${card.userCustom ? `<div class="sync-row" style="margin-top:4px"><button class="btn small" data-edit-card>✏️ Editar</button><button class="btn small" data-del-card>🗑 Eliminar</button></div>` : ""}
        <div class="cd-section"><h4>Habilidad</h4><div id="cd-ability">${card.ability ? nl2br(card.ability) : "<span class='muted'>Sin texto.</span>"}</div></div>
        ${card.flavour ? `<div class="cd-section"><h4>Historia</h4><p class="cd-flavour">«${escapeHtml(card.flavour)}»</p></div>` : ""}
        <div id="cd-extra" class="cd-extra"><p class="muted">Cargando detalle ampliado…</p></div>
      </div>
    </div>`;

  box.querySelector("[data-close]").onclick = closeModal;
  const zoomEl = box.querySelector("[data-zoom]");
  if (zoomEl) zoomEl.onclick = () => openZoom(card.image, card.name);
  box.querySelector("[data-add-deck]").onclick = () => addToDeckQuick(card);
  const editBtn = box.querySelector("[data-edit-card]");
  if (editBtn) editBtn.onclick = () => { closeModal(); openCardForm(card); };
  const delBtn = box.querySelector("[data-del-card]");
  if (delBtn) delBtn.onclick = () => {
    if (!confirm(`¿Eliminar la carta manual «${card.name}»?`)) return;
    store.deleteCustomCard(card.id);
    rebuildCards(); populateFilters(); applyFilters(); closeModal();
    showToast("Carta eliminada");
  };
  box.querySelectorAll("[data-m]").forEach((b) => {
    b.onclick = () => {
      const newQty = store.addQty(card.id, b.dataset.m === "plus" ? 1 : -1);
      const mq = box.querySelector('[data-role="mqty"]');
      mq.textContent = newQty;
      mq.classList.toggle("zero", newQty === 0);
      const gridCard = document.querySelector(`.card[data-id="${CSS.escape(card.id)}"]`);
      if (gridCard) {
        const g = gridCard.querySelector('[data-role="qty"]');
        g.textContent = newQty; g.classList.toggle("zero", newQty === 0);
        gridCard.classList.toggle("owned", newQty > 0);
      }
      updateResultCount();
    };
  });

  $("#modal").classList.remove("hidden");

  // Detalle ampliado en vivo (api.myl.cl)
  fetchProfile(card).then((p) => renderProfileExtra(p, card));
}

function renderProfileExtra(p, card) {
  const box = $("#cd-extra");
  if (!box) return;
  // Corrige el nombre (tildes/ñ) con el del perfil
  const realName = p?.details?.name?.trim();
  if (card && realName) {
    const h = $("#cd-name"); if (h) h.textContent = realName;
    if (realName !== card.name) { nameCache[card.id] = realName; saveNameCache(); updateCardNameInDom(card.id, realName); }
  }
  if (!p || !p.details) {
    box.innerHTML = `<p class="muted">No se pudo cargar el detalle ampliado (revisa tu conexión).</p>`;
    return;
  }
  let html = "";
  // Habilidad formateada del perfil (si difiere/está más completa)
  const ab = p.details.ability_html || p.details.ability;
  if (ab) { const a = $("#cd-ability"); if (a) a.innerHTML = nl2br(ab); }

  // Formatos / torneos
  const vf = p.valid_formats || {};
  const valid = Object.entries(vf).filter(([, v]) => v).map(([k]) => FORMAT_LABELS[k] || k);
  if (valid.length) {
    html += `<div class="cd-section"><h4>Formatos de torneo</h4><div class="m-tags">${valid.map((f) => `<span class="tag ok-tag">✓ ${escapeHtml(f)}</span>`).join("")}</div></div>`;
  }
  // Palabras clave
  const kws = (p.keywords || []).map((k) => k.name || k.slug).filter(Boolean);
  if (kws.length) html += `<div class="cd-section"><h4>Palabras clave</h4><div class="m-tags">${kws.map((k) => `<span class="tag">${escapeHtml(k)}</span>`).join("")}</div></div>`;

  // Datos de edición / ilustrador
  const meta = [];
  const ill = p.illustrator?.name || p.details.illustrator;
  if (ill && typeof ill === "string") meta.push(["Ilustrador", ill]);
  if (p.edition?.title) meta.push(["Edición", p.edition.title]);
  if (p.edition?.date_release && !/^1990|^2000/.test(p.edition.date_release)) meta.push(["Lanzamiento", p.edition.date_release]);
  if (meta.length) html += `<div class="cd-section"><h4>Ficha</h4>${meta.map(([k, v]) => `<div class="cd-meta"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join("")}</div>`;

  // Errata
  const errata = (p.errata || []).map((e) => e.text || e.description || e.errata).filter(Boolean);
  if (errata.length) html += `<div class="cd-section"><h4>Errata / aclaraciones</h4>${errata.map((t) => `<p class="muted">${nl2br(t)}</p>`).join("")}</div>`;

  // Productos donde aparece
  const prods = (p.products || []).map((x) => x.name || x.title).filter(Boolean);
  if (prods.length) html += `<div class="cd-section"><h4>Aparece en</h4><div class="m-tags">${prods.map((x) => `<span class="tag">${escapeHtml(x)}</span>`).join("")}</div></div>`;

  box.innerHTML = html || `<p class="muted">Sin información adicional.</p>`;
}

function openZoom(src, alt) {
  let z = $("#img-zoom");
  if (!z) {
    z = document.createElement("div");
    z.id = "img-zoom";
    z.className = "img-zoom hidden";
    z.addEventListener("click", () => z.classList.add("hidden"));
    document.body.appendChild(z);
  }
  z.innerHTML = `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt || "")}" />`;
  z.classList.remove("hidden");
}
function closeModal() { $("#modal").classList.add("hidden"); }

/* ===================== Carta manual (formulario) ===================== */
let cfImageData = "";
function editionSlug(text) {
  return normText(text).trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") || "personalizada";
}
function populateEditionDatalist() {
  const dl = $("#cf-editions");
  if (!dl) return;
  const names = [...new Set(state.cards.map((c) => c.editionName).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  dl.innerHTML = names.map((n) => `<option value="${escapeAttr(n)}"></option>`).join("");
}
function openCardForm(card) {
  populateEditionDatalist();
  const editing = card && card.userCustom;
  $("#cf-title").textContent = editing ? "Editar carta" : "Agregar carta manual";
  $("#cf-id").value = editing ? card.id : "";
  $("#cf-name").value = editing ? card.name : "";
  $("#cf-edition").value = editing ? (card.editionName || "") : "";
  $("#cf-format").value = editing ? (card.format || "NE") : "NE";
  $("#cf-race").value = editing && card.race !== "—" ? card.race : "";
  $("#cf-type").value = editing ? card.type : "Aliado";
  $("#cf-rarity").value = editing && card.rarity !== "—" ? card.rarity : "";
  $("#cf-cost").value = editing && card.cost != null ? card.cost : "";
  $("#cf-strength").value = editing && card.strength != null ? card.strength : "";
  $("#cf-ability").value = editing ? card.ability : "";
  $("#cf-flavour").value = editing ? card.flavour : "";
  $("#cf-image-url").value = editing && /^https?:|^\.\//.test(card.image || "") ? card.image : "";
  $("#cf-image-file").value = "";
  cfImageData = editing ? (card.image || "") : "";
  renderCfPreview();
  $("#cf-delete").style.display = editing ? "" : "none";
  $("#card-form-modal").classList.remove("hidden");
}
function closeCardForm() { $("#card-form-modal").classList.add("hidden"); }
function renderCfPreview() {
  const src = $("#cf-image-url").value.trim() || cfImageData;
  $("#cf-preview").innerHTML = src ? `<img src="${escapeAttr(src)}" alt="" />` : "";
}
function saveCardForm(another) {
  const name = $("#cf-name").value.trim();
  if (!name) { showToast("Escribe al menos el nombre"); return; }
  const edName = $("#cf-edition").value.trim() || "Personalizada";
  const card = {
    name,
    edition: editionSlug(edName),
    editionName: edName,
    format: $("#cf-format").value,
    type: $("#cf-type").value,
    race: $("#cf-race").value.trim() || "—",
    rarity: $("#cf-rarity").value.trim() || "—",
    cost: $("#cf-cost").value === "" ? null : Number($("#cf-cost").value),
    strength: $("#cf-strength").value === "" ? null : Number($("#cf-strength").value),
    ability: $("#cf-ability").value.trim(),
    flavour: $("#cf-flavour").value.trim(),
    image: $("#cf-image-url").value.trim() || cfImageData || "",
  };
  const id = $("#cf-id").value;
  if (id) store.updateCustomCard(id, card);
  else store.addCustomCard(card);
  rebuildCards(); populateFilters(); applyFilters(); refreshActiveDeckUI();
  if (another) {
    // Mantiene edición/formato/raza/rareza; limpia lo específico de la carta
    $("#cf-id").value = "";
    $("#cf-name").value = "";
    $("#cf-cost").value = "";
    $("#cf-strength").value = "";
    $("#cf-ability").value = "";
    $("#cf-flavour").value = "";
    $("#cf-image-url").value = "";
    $("#cf-image-file").value = "";
    cfImageData = "";
    renderCfPreview();
    $("#cf-delete").style.display = "none";
    $("#cf-title").textContent = "Agregar carta manual";
    $("#cf-name").focus();
    showToast("Guardada ✓ — agrega la siguiente");
  } else {
    closeCardForm();
    showToast(id ? "Carta actualizada" : "Carta agregada ✓");
  }
}
function bindCardFormEvents() {
  $("#btn-add-card").addEventListener("click", () => openCardForm(null));
  $("#cf-save").addEventListener("click", () => saveCardForm(false));
  $("#cf-save-another").addEventListener("click", () => saveCardForm(true));
  $("#cf-delete").addEventListener("click", () => {
    const id = $("#cf-id").value;
    if (id && confirm("¿Eliminar esta carta manual?")) {
      store.deleteCustomCard(id);
      rebuildCards(); populateFilters(); applyFilters(); closeCardForm();
      showToast("Carta eliminada");
    }
  });
  $$("[data-close-cf]").forEach((el) => el.addEventListener("click", closeCardForm));
  $("#cf-image-url").addEventListener("input", renderCfPreview);
  $("#cf-image-file").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 1.5 * 1024 * 1024) { showToast("Imagen muy grande (máx ~1.5 MB)", 3500); e.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => { cfImageData = reader.result; $("#cf-image-url").value = ""; renderCfPreview(); };
    reader.readAsDataURL(f);
  });
}

/* ===================== Añadir a mazo (desde Colección) ===================== */
function addToDeckQuick(card) {
  const activeId = store.getSetting("activeDeckId");
  if (activeId && store.getDeck(activeId)) {
    store.deckAdd(activeId, card.id, 1);
    const d = store.getDeck(activeId);
    refreshActiveDeckCount();
    showToast(`«${card.name}» → ${d.name} (${d.cards[card.id]})`);
  } else {
    openDeckPicker(card);
  }
}

function openDeckPicker(card) {
  const decks = store.getDecks();
  const box = $("#deck-modal-box");
  const list = decks.length
    ? decks.map((d) => `<button class="picker-deck" data-id="${escapeAttr(d.id)}">
        <span class="pd-name">${escapeHtml(d.name)}</span>
        <span class="muted">${d.cards[card.id] ? "ya tienes ×" + d.cards[card.id] + " · " : ""}${store.deckCount(d.id)} cartas</span>
      </button>`).join("")
    : `<p class="muted">Aún no tienes mazos. Crea uno abajo.</p>`;
  box.innerHTML = `
    <button class="modal-close" data-close-deck>×</button>
    <h2>Añadir a un mazo</h2>
    <p class="muted">«${escapeHtml(card.name)}»</p>
    <div class="picker-list">${list}</div>
    <button class="btn full" data-new-deck>＋ Crear mazo nuevo y añadir</button>`;
  box.querySelector("[data-close-deck]").onclick = closeDeckModal;
  box.querySelectorAll(".picker-deck").forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.id;
      store.deckAdd(id, card.id, 1);
      store.setSetting("activeDeckId", id);
      refreshActiveDeckUI();
      showToast(`«${card.name}» → ${store.getDeck(id).name}`);
      closeDeckModal();
    };
  });
  box.querySelector("[data-new-deck]").onclick = () => {
    const name = prompt("Nombre del nuevo mazo:", "Mazo nuevo");
    if (name === null) return;
    const d = store.createDeck(name);
    store.deckAdd(d.id, card.id, 1);
    store.setSetting("activeDeckId", d.id);
    refreshActiveDeckUI();
    showToast(`Mazo «${d.name}» creado con «${card.name}»`);
    closeDeckModal();
  };
  $("#deck-modal").classList.remove("hidden");
}
function closeDeckModal() { $("#deck-modal").classList.add("hidden"); }

function populateActiveDeckSelect() {
  const sel = $("#active-deck-select");
  if (!sel) return;
  const decks = store.getDecks();
  const active = store.getSetting("activeDeckId") || "";
  sel.innerHTML = `<option value="">(ninguno)</option>` +
    decks.map((d) => `<option value="${escapeAttr(d.id)}">${escapeHtml(d.name)}</option>`).join("");
  sel.value = decks.some((d) => d.id === active) ? active : "";
}
function refreshActiveDeckCount() {
  const el = $("#active-deck-count");
  if (!el) return;
  const d = store.getDeck(store.getSetting("activeDeckId"));
  el.textContent = d ? `${store.deckCount(d.id)} cartas` : "Elige o crea un mazo para agregar con 🃏＋";
}
function refreshActiveDeckUI() { populateActiveDeckSelect(); refreshActiveDeckCount(); }

function bindDeckBarEvents() {
  $("#active-deck-select").addEventListener("change", (e) => {
    store.setSetting("activeDeckId", e.target.value || null);
    refreshActiveDeckCount();
  });
  $("#active-deck-new").addEventListener("click", () => {
    const name = prompt("Nombre del nuevo mazo:", "Mazo nuevo");
    if (name === null) return;
    const d = store.createDeck(name);
    store.setSetting("activeDeckId", d.id);
    refreshActiveDeckUI();
    showToast(`Mazo «${d.name}» creado y activo`);
  });
  $$("[data-close-deck]").forEach((el) => el.addEventListener("click", closeDeckModal));
}

/* ===================== Mazos ===================== */
function renderDecksView() {
  const list = $("#deck-list");
  const decks = store.getDecks();
  list.innerHTML = "";
  const activeId = store.getSetting("activeDeckId");
  if (decks.length === 0) {
    list.innerHTML = `<p class="muted">Aún no tienes mazos.</p>`;
  }
  for (const d of decks) {
    const row = document.createElement("div");
    row.className = "deck-item" + (d.id === activeId ? " active" : "");
    row.dataset.deckId = d.id;
    row.innerHTML = `
      <span class="d-name">${escapeHtml(d.name)}</span>
      <span class="d-count">${store.deckCount(d.id)}</span>
      <button class="qty-btn" data-del title="Eliminar">🗑</button>`;
    row.querySelector(".d-name").onclick = () => { store.setSetting("activeDeckId", d.id); renderDecksView(); renderDeckDetail(); };
    row.querySelector("[data-del]").onclick = () => {
      if (confirm(`¿Eliminar el mazo «${d.name}»?`)) {
        store.deleteDeck(d.id);
        if (activeId === d.id) store.setSetting("activeDeckId", null);
        renderDecksView(); renderDeckDetail();
      }
    };
    list.appendChild(row);
  }
  refreshActiveDeckUI();
  renderDeckDetail();
}

function renderDeckDetail() {
  const wrap = $("#deck-detail");
  const deck = store.getDeck(store.getSetting("activeDeckId"));
  if (!deck) {
    wrap.innerHTML = `<p class="muted">Selecciona o crea un mazo para empezar a construirlo. Desde la vista <b>Colección</b> puedes añadir cartas al mazo activo con el botón 🃏＋, o buscarlas aquí abajo.</p>`;
    return;
  }
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <h2><input id="deck-name" value="${escapeAttr(deck.name)}" style="background:var(--bg-3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 10px;font-size:18px;font-weight:700" /></h2>
      <span class="muted" id="deck-total"></span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn small" id="deck-xlsx">📊 Excel</button>
      <button class="btn small" id="deck-img">🖼️ Imagen</button>
      <button class="btn small" id="deck-txt">📋 Texto</button>
    </div>
    <div class="muted" style="font-size:12px;margin-top:4px">Actualizado: ${deck.updatedAt ? new Date(deck.updatedAt).toLocaleString("es-CL") : "—"}</div>
    <div id="deck-banner"></div>
    <div id="deck-summary" class="deck-summary"></div>
    <div class="deck-add-search">
      <input id="deck-search" type="search" placeholder="🔎 Buscar carta por nombre para añadir a este mazo…" autocomplete="off" />
      <div id="deck-search-results" class="deck-search-results"></div>
    </div>
    <div id="deck-contents"></div>`;

  $("#deck-name").onchange = (e) => { store.renameDeck(deck.id, e.target.value || "Mazo"); populateActiveDeckSelect(); updateDeckCounts(); };
  $("#deck-txt").onclick = () => exportDeck(deck);
  $("#deck-xlsx").onclick = () => {
    showToast("Generando Excel…", 4000);
    exportDeckExcel(deck, state.cards, store.getQty, displayName)
      .then(() => showToast("Excel descargado ✓")).catch((e) => showToast("Error: " + e.message, 4000));
  };
  $("#deck-img").onclick = () => {
    showToast("Generando imagen…", 4000);
    exportDeckImage(deck, state.cards, store.getQty, displayName)
      .then(() => showToast("Imagen descargada ✓")).catch((e) => showToast("Error: " + e.message, 4000));
  };

  const di = $("#deck-search");
  di.oninput = debounce(() => {
    const q = normText(di.value.trim());
    const res = $("#deck-search-results");
    if (q.length < 2) { res.innerHTML = ""; return; }
    const matches = state.cards.filter((c) => c.searchText.includes(q)).slice(0, 30);
    res.innerHTML = matches.map((c) => {
      const own = store.getQty(c.id);
      return `<div class="dsr" data-id="${escapeAttr(c.id)}">
        <span class="dsr-name">${escapeHtml(displayName(c))}</span>
        <span class="dsr-meta">${escapeHtml(c.editionName || "")} · <span class="${own > 0 ? "owned-tag" : ""}">tengo ${own}</span></span>
        <button class="qty-btn" data-add title="Añadir al mazo">＋</button>
      </div>`;
    }).join("") || `<p class="muted">Sin resultados</p>`;
    res.querySelectorAll(".dsr").forEach((row) => {
      row.querySelector("[data-add]").onclick = () => {
        store.deckAdd(deck.id, row.dataset.id, 1);
        renderDeckContents(deck); updateDeckCounts(); refreshActiveDeckCount();
      };
    });
  }, 180);

  renderDeckContents(deck);
}

function renderDeckContents(deck) {
  const cont = $("#deck-contents");
  if (!cont) return;
  const entries = Object.entries(deck.cards);
  const total = entries.reduce((a, [, q]) => a + q, 0);
  const totalEl = $("#deck-total"); if (totalEl) totalEl.textContent = `${total} cartas`;

  const byType = {};
  let missing = 0;
  for (const [cid, q] of entries) {
    const card = state.cards.find((c) => c.id === cid);
    const t = card ? card.type : "Otro";
    (byType[t] ||= []).push({ card, cid, q });
    const own = store.getQty(cid);
    if (own < q) missing += q - own;
  }
  const banner = $("#deck-banner");
  if (banner) banner.innerHTML = missing > 0 ? `<div class="active-deck-banner">Te faltan <b>${missing}</b> copias de este mazo en tu colección.</div>` : "";

  let html = "";
  for (const [type, rows] of Object.entries(byType)) {
    html += `<h3 class="deck-section-title">${typeIcon(type)} ${escapeHtml(type)} (${rows.reduce((a, r) => a + r.q, 0)})</h3>`;
    for (const { card, cid, q } of rows) {
      const name = card ? displayName(card) : cid;
      const own = store.getQty(cid);
      const lack = own < q ? ` <span style="color:var(--danger)">(faltan ${q - own})</span>` : "";
      const meta = card
        ? `${raceIcon(card.race)} ${escapeHtml(card.race)}${card.cost != null ? " · ⛁" + card.cost : ""}${card.strength != null ? " · ⚔" + card.strength : ""}`
        : "";
      html += `
        <div class="deck-row" data-cid="${escapeAttr(cid)}">
          <span class="dr-qty">${q}×</span>
          <span class="dr-name">${escapeHtml(name)}${lack}<span class="dr-sub">${meta}</span></span>
          <span class="dr-actions">
            <button class="qty-btn" data-d="minus">−</button>
            <button class="qty-btn" data-d="plus">+</button>
          </span>
        </div>`;
    }
  }
  if (entries.length === 0) html = `<p class="muted">Mazo vacío. Busca una carta arriba para añadirla, o usa 🃏＋ en la Colección.</p>`;
  cont.innerHTML = html;
  cont.querySelectorAll(".deck-row").forEach((row) => {
    const cid = row.dataset.cid;
    row.querySelectorAll("[data-d]").forEach((b) => {
      b.onclick = () => { store.deckAdd(deck.id, cid, b.dataset.d === "plus" ? 1 : -1); renderDeckContents(deck); updateDeckCounts(); refreshActiveDeckCount(); };
    });
  });
  renderDeckSummary(deck);
}

function renderDeckSummary(deck) {
  const box = $("#deck-summary");
  if (!box) return;
  const S = deckSummary(deck, state.cards, store.getQty, displayName);
  if (!S.total) { box.innerHTML = ""; return; }
  const chips = S.typesPresent.map((t) =>
    `<div class="ds-chip"><div class="ds-t">${typeIcon(t)} ${escapeHtml(t)}</div><div class="ds-n">${S.typeTotal[t]} <span class="muted">· ${S.pct(S.typeTotal[t])}%</span></div></div>`).join("");
  const head = `<tr><th>Tipo</th>${S.cols.map((c) => `<th>${c}</th>`).join("")}<th>Total</th></tr>`;
  const body = S.typesPresent.map((t) =>
    `<tr><td>${typeIcon(t)} ${escapeHtml(t)}</td>${S.cols.map((c) => `<td>${S.matrix[t][c] || ""}</td>`).join("")}<td class="b">${S.typeTotal[t]}</td></tr>`).join("");
  const totalRow = `<tr class="tot"><td>Total</td>${S.cols.map((c) => `<td>${S.colTotal(c)}</td>`).join("")}<td>${S.total}</td></tr>`;
  box.innerHTML =
    `<div class="ds-title">Distribución por tipo</div><div class="ds-chips">${chips}</div>
     <div class="ds-title">Detalle por tipo y coste</div>
     <div class="ds-matrix"><table>${head}${body}${totalRow}</table></div>`;
}

function updateDeckCounts() {
  $$("#deck-list .deck-item").forEach((row) => {
    const id = row.dataset.deckId;
    const c = row.querySelector(".d-count");
    if (id && c) c.textContent = store.deckCount(id);
  });
}

/* ===================== Estadísticas ===================== */
function statsScopeLabel() {
  const sc = $("#stats-scope").value;
  const fm = $("#stats-format");
  const fTxt = fm.value ? " · " + fm.options[fm.selectedIndex].text : "";
  return (sc === "owned" ? "Solo las que tengo" : sc === "missing" ? "Solo faltantes" : "Todo el catálogo") + fTxt;
}

function renderStats() {
  const scope = $("#stats-scope")?.value || "all";
  const fmt = $("#stats-format")?.value || "";
  const base = fmt ? state.cards.filter((c) => c.format === fmt) : state.cards;

  const owned = base.filter((c) => store.getQty(c.id) > 0);
  const ownedCopies = base.reduce((s, c) => s + store.getQty(c.id), 0);
  const pct = base.length ? Math.round((owned.length / base.length) * 100) : 0;

  $("#stats-cards").innerHTML = `
    ${statCard(owned.length, "Cartas únicas")}
    ${statCard(ownedCopies, "Copias totales")}
    ${statCard(base.length, "Cartas en catálogo")}
    ${statCard(pct + "%", "Colección completa")}
    ${statCard(store.getDecks().length, "Mazos guardados")}`;

  // Gráficos (carga perezosa de Chart.js)
  renderCharts({ cards: state.cards, getQty: store.getQty, scope, format: fmt })
    .catch((e) => console.warn("charts:", e));

  // Progreso por edición (respeta el formato elegido)
  const byEd = {};
  for (const c of base) {
    const e = (byEd[c.edition] ||= { name: c.editionName, total: 0, owned: 0 });
    e.total++;
    if (store.getQty(c.id) > 0) e.owned++;
  }
  const rows = Object.values(byEd)
    .filter((e) => e.total > 0)
    .sort((a, b) => b.owned / b.total - a.owned / a.total || b.total - a.total);
  $("#stats-editions").innerHTML = rows
    .map((e) => {
      const p = Math.round((e.owned / e.total) * 100);
      return `<div class="ep-row">
        <span>${escapeHtml(e.name || "—")}</span>
        <span class="ep-bar"><span class="ep-fill" style="width:${p}%"></span></span>
        <span class="muted">${e.owned}/${e.total} (${p}%)</span>
      </div>`;
    })
    .join("") || `<p class="muted">Sin datos.</p>`;
}
function statCard(num, lbl) {
  return `<div class="stat-card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`;
}

function statsExportPDF() {
  const scope = $("#stats-scope").value, fmt = $("#stats-format").value;
  let cards = fmt ? state.cards.filter((c) => c.format === fmt) : state.cards.slice();
  if (scope === "owned") cards = cards.filter((c) => store.getQty(c.id) > 0);
  else if (scope === "missing") cards = cards.filter((c) => store.getQty(c.id) === 0);
  if (cards.length > 1500 && !confirm(`Son ${cards.length} cartas. El PDF puede ser grande. ¿Continuar?`)) return;
  showToast("Generando PDF…", 5000);
  exportPDF(cards, store.getQty, statsScopeLabel())
    .then(() => showToast("PDF descargado ✓"))
    .catch((e) => showToast("Error: " + e.message, 4000));
}

/* ===================== Exportar / Importar ===================== */
function download(filename, text, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function scopeLabel() {
  const own = $("#f-ownership");
  const ownTxt = own.selectedIndex > 0 ? own.options[own.selectedIndex].text : "Todas las cartas";
  const ed = $("#f-edition");
  const edTxt = ed.value ? " · " + ed.options[ed.selectedIndex].text : "";
  return ownTxt + edTxt;
}

function exportCollection(format) {
  // Excel / PDF: exportan el conjunto filtrado actual
  if (format === "xlsx" || format === "pdf") {
    const cards = state.filtered.length ? state.filtered : state.cards;
    if (format === "pdf" && cards.length > 1500 &&
        !confirm(`Vas a exportar ${cards.length} cartas a PDF (puede tardar). \n\nSugerencia: filtra primero (p. ej. "Solo las que tengo" o una edición). ¿Continuar igual?`)) return;
    showToast("Generando archivo…", 5000);
    const fn = format === "xlsx" ? exportExcel : exportPDF;
    fn(cards, store.getQty, scopeLabel())
      .then(() => showToast(format === "xlsx" ? "Excel descargado ✓" : "PDF descargado ✓"))
      .catch((e) => showToast("Error al exportar: " + e.message, 4000));
    return;
  }

  const inv = store.getInventory();
  if (format === "json") {
    const data = {
      app: "Inventario MyL",
      exportedAt: new Date().toISOString(),
      inventory: inv,
      decks: store.getDecks(),
    };
    download(`coleccion_myl_${today()}.json`, JSON.stringify(data, null, 2));
    showToast("Colección exportada (JSON)");
    return;
  }
  // CSV
  const wantMissing = format === "missing-csv";
  const rows = [["nombre", "edicion", "formato", "tipo", "raza", "rareza", "coste", "fuerza", "cantidad"]];
  for (const c of state.cards) {
    const qty = inv[c.id] || 0;
    if (wantMissing ? qty > 0 : qty === 0) continue;
    rows.push([c.name, c.editionName, c.format, c.type, c.race, c.rarity, c.cost ?? "", c.strength ?? "", wantMissing ? "" : qty]);
  }
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
  download(`${wantMissing ? "faltantes" : "coleccion"}_myl_${today()}.csv`, csv, "text/csv");
  showToast(`Exportado (CSV): ${rows.length - 1} filas`);
}

function exportDeck(deck) {
  const lines = [`# ${deck.name}`];
  for (const [cid, q] of Object.entries(deck.cards)) {
    const card = state.cards.find((c) => c.id === cid);
    lines.push(`${q} ${card ? card.name : cid}`);
  }
  download(`mazo_${deck.name.replace(/\s+/g, "_")}.txt`, lines.join("\n"), "text/plain");
  showToast("Mazo exportado");
}

function importCollection(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const inv = data.inventory || data;
      const merge = confirm("¿Combinar con tu colección actual?\n\nAceptar = combinar (suma cantidades)\nCancelar = reemplazar todo");
      if (merge) store.mergeInventory(inv);
      else store.replaceInventory(inv);
      if (Array.isArray(data.decks)) store.replaceDecks(data.decks);
      applyFilters();
      renderDecksView();
      showToast("Colección importada");
    } catch {
      showToast("Archivo no válido", 3000);
    }
  };
  reader.readAsText(file);
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function today() { return new Date().toISOString().slice(0, 10); }

/* ===================== Utilidades ===================== */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

let toastTimer;
function showToast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

/* ===================== Guardado / Sincronización ===================== */
function setChip(text, cls = "") {
  const c = $("#sync-chip");
  if (!c) return;
  c.textContent = text;
  c.className = "sync-chip " + cls;
}
let chipTimer;
function flashChip(text, cls) {
  setChip(text, cls);
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => { if (!cloud.isConfigured()) setChip(""); }, 2500);
}

function refreshAll() {
  rebuildCards();
  applyFilters();
  if (state.view === "colecciones") renderCollectionsView();
  if (state.view === "cambios") renderTradeView();
  if (state.view === "mazos") renderDecksView();
  if (state.view === "stats") renderStats();
  refreshActiveDeckUI();
}

function autoUpload() { return store.getSetting("cloudAuto") !== false; } // por defecto sí

let pushTimer;
function scheduleCloudPush() {
  setChip("☁ Cambios sin subir…", "sync");
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => doCloudPush(false), 1800);
}

async function doCloudPush(manual) {
  if (!cloud.isConfigured()) return;
  try {
    setChip("☁ Subiendo…", "sync");
    const ts = await cloud.push(store.getSnapshot(), { accion: manual ? "guardado manual" : "automático", copias: store.totalCards() });
    cloud.setLastTs(ts);
    cloud.clearDirty();
    setChip("☁ Guardado ✓", "ok");
  } catch (e) { setChip("☁ Error", "err"); showToast("Error al subir: " + e.message, 4000); }
}

function adoptRemote(remote) {
  store.applySnapshot(remote.snapshot);
  cloud.setLastTs(remote.actualizado);
  cloud.clearDirty();
  refreshAll();
  setChip("☁ Sincronizado", "ok");
}

// Reconciliación basada en "¿cambió la fila en la nube desde la última vez?"
async function cloudReconcile() {
  if (!cloud.isConfigured()) return;
  setChip("☁ Sincronizando…", "sync");
  try {
    const remote = await cloud.pull();
    if (!remote || !remote.snapshot) { await doCloudPush(false); return; } // primera vez: subir
    const changedElsewhere = remote.actualizado !== cloud.getLastTs();
    if (!changedElsewhere) {
      if (cloud.isDirty()) await doCloudPush(false);
      else setChip("☁ Sincronizado", "ok");
      return;
    }
    // La nube cambió desde otro dispositivo
    if (cloud.isDirty()) {
      const takeCloud = confirm(
        "Hay cambios en la NUBE (desde otro dispositivo) y también cambios locales sin subir.\n\n" +
        "Aceptar = usar lo de la NUBE (descarta lo local de este equipo)\n" +
        "Cancelar = subir lo de ESTE equipo (sobrescribe la nube)"
      );
      if (takeCloud) adoptRemote(remote);
      else await doCloudPush(false);
    } else {
      adoptRemote(remote);
    }
  } catch (e) { setChip("☁ Error", "err"); showToast("Sincronización: " + e.message, 4000); }
}

/* ----- Tiempo real (Supabase Realtime) ----- */
async function startRealtime() {
  if (!cloud.isConfigured()) return;
  try { await cloud.subscribeRealtime(onRealtime); }
  catch (e) { console.warn("realtime:", e); }
}
function onRealtime({ snapshot, actualizado }) {
  if (!snapshot || actualizado === cloud.getLastTs()) return; // cambio propio
  if (cloud.isDirty()) {
    setChip("☁ Cambios nuevos en la nube — toca Bajar", "sync");
    showToast("Hay cambios desde otro dispositivo. Toca ⬇️ Bajar para traerlos.", 4500);
    return;
  }
  store.applySnapshot(snapshot);
  cloud.setLastTs(actualizado);
  cloud.clearDirty();
  refreshAll();
  setChip("☁ Actualizado", "ok");
  showToast("Actualizado en tiempo real desde la nube");
}

function onStoreChange(origin) {
  if (origin === "remote") { refreshAll(); return; }
  if (!cloud.isConfigured()) { flashChip("Guardado ✓", "ok"); return; }
  cloud.markDirty();
  if (autoUpload()) scheduleCloudPush();
  else setChip("☁ Cambios sin subir — toca Guardar", "sync");
}

/* ----- Red de seguridad: re-sincroniza al volver a la pestaña y cada 30s ----- */
async function quietPull() {
  if (!cloud.isConfigured() || cloud.isDirty()) return;
  try {
    const r = await cloud.pull();
    if (r && r.snapshot && r.actualizado !== cloud.getLastTs()) {
      store.applySnapshot(r.snapshot);
      cloud.setLastTs(r.actualizado);
      cloud.clearDirty();
      refreshAll();
      setChip("☁ Actualizado", "ok");
    }
  } catch {}
}
function startCloudBackgroundSync() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && cloud.isConfigured()) {
      startRealtime();   // reasegura la suscripción (el navegador la duerme en 2º plano)
      quietPull();       // y trae cambios perdidos al instante
    }
  });
  window.addEventListener("focus", () => { if (cloud.isConfigured()) quietPull(); });
  setInterval(() => { if (cloud.isConfigured() && document.visibilityState === "visible") quietPull(); }, 30000);
}

/* ----- Modal de datos / nube ----- */
function openSyncModal() {
  const cfg = cloud.getConfig();
  $("#cloud-url").value = cfg.url || "";
  $("#cloud-key").value = cfg.key || "";
  $("#cloud-clave").value = cfg.clave || "";
  $("#cloud-device").value = cfg.device || "";
  $("#cloud-auto").checked = autoUpload();
  $("#cloud-status").textContent = cloud.isConfigured()
    ? (cloud.isDirty() ? "Conectado. Tienes cambios sin subir." : "Conectado y sincronizado.")
    : "Sincronización no configurada.";
  $("#cloud-log").innerHTML = "";
  $("#sync-modal").classList.remove("hidden");
}
function closeSyncModal() { $("#sync-modal").classList.add("hidden"); }

async function showLog() {
  if (!cloud.isConfigured()) { showToast("Conecta primero"); return; }
  const box = $("#cloud-log");
  box.innerHTML = `<p class="muted">Cargando historial…</p>`;
  const rows = await cloud.getLog(30);
  if (rows == null) {
    box.innerHTML = `<p class="muted">El historial requiere una tabla extra. Ejecuta el SQL de "historial" (en la ayuda) una vez.</p>`;
    return;
  }
  if (!rows.length) { box.innerHTML = `<p class="muted">Aún no hay registros.</p>`; return; }
  box.innerHTML = `<table class="log-table"><thead><tr><th>Fecha</th><th>Dispositivo</th><th>Acción</th><th>Copias</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${new Date(r.creado).toLocaleString("es-CL")}</td><td>${escapeHtml(r.dispositivo || "—")}</td><td>${escapeHtml(r.accion || "—")}</td><td>${r.copias ?? ""}</td></tr>`).join("") +
    `</tbody></table>`;
}

function bindSyncEvents() {
  $("#open-sync").addEventListener("click", openSyncModal);
  $$("[data-close-sync]").forEach((el) => el.addEventListener("click", closeSyncModal));
  $("#sync-help-toggle").addEventListener("click", (e) => { e.preventDefault(); $("#sync-help").classList.toggle("hidden"); });
  $$("[data-copy-sql]").forEach((b) => b.addEventListener("click", () => {
    navigator.clipboard.writeText($("#" + b.dataset.copySql).textContent).then(() => showToast("SQL copiado"));
  }));
  $("#sync-backup").addEventListener("click", () => exportCollection("json"));
  $("#sync-restore").addEventListener("click", () => $("#import-file").click());

  $("#cloud-auto").addEventListener("change", (e) => {
    store.setSetting("cloudAuto", e.target.checked);
    if (e.target.checked && cloud.isConfigured() && cloud.isDirty()) doCloudPush(false);
  });

  $("#cloud-connect").addEventListener("click", async () => {
    const url = $("#cloud-url").value, key = $("#cloud-key").value, clave = $("#cloud-clave").value, device = $("#cloud-device").value;
    if (!url || !key || !clave) { showToast("Completa URL, clave y código de colección", 3500); return; }
    cloud.setConfig({ url, key, clave, device });
    $("#cloud-status").textContent = "Conectando…";
    await cloudReconcile();
    startRealtime();
    $("#cloud-status").textContent = "Conexión lista. " + (autoUpload() ? "Tus cambios se subirán solos." : "Recuerda tocar Guardar para subir.") + " Tiempo real activo.";
    showToast("Nube conectada ✓");
  });
  $("#cloud-push").addEventListener("click", async () => { if (!cloud.isConfigured()) return showToast("Conecta primero"); await doCloudPush(true); showToast("Guardado en la nube ✓"); openSyncModal(); });
  $("#cloud-pull").addEventListener("click", async () => {
    if (!cloud.isConfigured()) return showToast("Conecta primero");
    try {
      const r = await cloud.pull();
      if (r && r.snapshot) { adoptRemote(r); showToast("Bajado ✓"); }
      else showToast("No hay datos en la nube todavía");
    } catch (e) { showToast("Error: " + e.message, 4000); }
  });
  $("#cloud-disconnect").addEventListener("click", () => {
    cloud.unsubscribeRealtime();
    cloud.disconnect(); setChip(""); $("#cloud-status").textContent = "Sincronización desactivada.";
    showToast("Nube desconectada");
  });
  $("#cloud-log-btn").addEventListener("click", showLog);
}

/* ===================== Colecciones (álbum por edición) =====================
   Una colección es una VISTA de una edición sobre el inventario: no guarda
   cantidades (esas viven en la Capa B). Muestra todas las cartas de la edición
   y marca el avance; las que no tienes se ven en blanco y negro. */
const editionCardsCache = new Map();

function compareEditionCards(a, b) {
  const na = Number(a.edid), nb = Number(b.edid);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return (a.name || "").localeCompare(b.name || "", "es");
}
function collectionCards(col) {
  let arr = editionCardsCache.get(col.edition);
  if (!arr) {
    arr = state.cards.filter((c) => c.edition === col.edition).sort(compareEditionCards);
    editionCardsCache.set(col.edition, arr);
  }
  return arr;
}
function collectionStats(col) {
  const cards = collectionCards(col);
  const owned = cards.filter((c) => store.getQty(c.id) > 0).length;
  const ce = store.getCustomEdition(col.edition);
  const total = Math.max(cards.length, Number(ce?.expectedTotal) || 0);
  return { total, owned, pct: total ? Math.round((owned / total) * 100) : 0 };
}
// Llena un <select> de ediciones DIVIDIDO por bloque/tipo de juego (optgroups):
// Primera Era, Primer Bloque, Segundo Bloque, Furia Extendido, Nueva Era/Imperio, Otras.
function fillEditionSelectGrouped(selId, placeholder = "— Elige una edición —") {
  const el = $(selId);
  const fmtNames = { PE: "Primera Era", PB: "Primer Bloque", SB: "Segundo Bloque", FX: "Furia Extendido", NE: "Nueva Era / Imperio", OT: "Otras / personalizadas" };
  const fmtOrder = { PE: 0, PB: 1, SB: 2, FX: 3, NE: 4, OT: 5 };
  const byFmt = {};
  const seen = new Map();
  for (const c of state.cards) if (!seen.has(c.edition)) seen.set(c.edition, c.format || "OT");
  for (const [slug, fmt] of seen) (byFmt[fmt] ||= []).push(slug);
  el.innerHTML = `<option value="">${placeholder}</option>`;
  Object.keys(byFmt).sort((a, b) => (fmtOrder[a] ?? 9) - (fmtOrder[b] ?? 9)).forEach((fmt) => {
    const og = document.createElement("optgroup");
    og.label = fmtNames[fmt] || fmt;
    byFmt[fmt]
      .sort((a, b) => (state.editionName[a] || a).localeCompare(state.editionName[b] || b, "es"))
      .forEach((slug) => {
        const o = document.createElement("option");
        o.value = slug; o.textContent = state.editionName[slug] || slug;
        og.appendChild(o);
      });
    el.appendChild(og);
  });
}

function renderCollectionsView() {
  const list = $("#collection-list");
  const cols = store.getCollections();
  let activeId = store.getSetting("activeCollectionId");
  if (!store.getCollection(activeId) && cols.length) {
    activeId = cols[0].id;
    store.setSetting("activeCollectionId", activeId);
  }
  list.innerHTML = cols.length ? "" : `<p class="muted">Aún no tienes colecciones.</p>`;
  for (const col of cols) {
    const s = collectionStats(col);
    const row = document.createElement("div");
    row.className = "col-item" + (col.id === activeId ? " active" : "");
    row.dataset.colId = col.id;
    row.innerHTML = `
      <div class="col-top">
        <span class="d-name">${escapeHtml(col.name)}</span>
        <button class="qty-btn" data-del title="Eliminar colección">🗑</button>
      </div>
      <div class="col-ed muted">${escapeHtml(state.editionName[col.edition] || col.edition)}</div>
      <span class="ep-bar"><span class="ep-fill" style="width:${s.pct}%"></span></span>
      <div class="col-nums muted">${s.owned}/${s.total} (${s.pct}%)</div>`;
    row.querySelector(".d-name").onclick = () => { store.setSetting("activeCollectionId", col.id); renderCollectionsView(); };
    row.querySelector("[data-del]").onclick = () => {
      if (!confirm(`¿Eliminar la colección «${col.name}»?\n\n(No borra las cantidades de tu inventario)`)) return;
      store.deleteCollection(col.id);
      if (store.getSetting("activeCollectionId") === col.id) store.setSetting("activeCollectionId", null);
      renderCollectionsView();
    };
    list.appendChild(row);
  }
  renderCollectionDetail();
}
function renderCollectionDetail() {
  const wrap = $("#collection-detail");
  const col = store.getCollection(store.getSetting("activeCollectionId"));
  if (!col) {
    wrap.innerHTML = `<p class="muted">Crea una colección con <b>+ Nueva colección</b>: eliges una edición y verás todas sus cartas ordenadas por número, marcando tu progreso.</p>`;
    return;
  }
  const s = collectionStats(col);
  wrap.innerHTML = `
    <div class="col-head">
      <h2><input id="col-name-edit" value="${escapeAttr(col.name)}" /></h2>
      <span class="tag">${escapeHtml(state.editionName[col.edition] || col.edition)}</span>
      <div class="spacer"></div>
      <label class="field inline"><span>Mostrar</span>
        <select id="col-filter">
          <option value="all">Todas las cartas</option>
          <option value="missing">Solo las que faltan</option>
          <option value="owned">Solo las que tengo</option>
        </select>
      </label>
    </div>
    <div class="col-progress-big">
      <span class="ep-bar"><span class="ep-fill" id="col-fill" style="width:${s.pct}%"></span></span>
      <span class="muted" id="col-progress-text">${s.owned}/${s.total} cartas (${s.pct}%)</span>
    </div>
    <div id="collection-grid"></div>
    <div id="col-empty" class="empty hidden">No hay cartas con este filtro.</div>`;
  $("#col-name-edit").onchange = (e) => { store.renameCollection(col.id, e.target.value.trim() || "Colección"); renderCollectionsView(); };
  const filterSel = $("#col-filter");
  filterSel.value = state.colFilter || "all";
  filterSel.onchange = (e) => { state.colFilter = e.target.value; renderCollectionGrid(col); };
  renderCollectionGrid(col);
}
function renderCollectionGrid(col) {
  const wrap = $("#collection-grid");
  if (!wrap) return;
  let cards = collectionCards(col);
  const f = state.colFilter || "all";
  if (f === "missing") cards = cards.filter((c) => store.getQty(c.id) === 0);
  else if (f === "owned") cards = cards.filter((c) => store.getQty(c.id) > 0);
  const query = normText($("#search").value.trim());
  if (query) cards = cards.filter((c) => c.searchText.includes(query));
  wrap.innerHTML = "";
  const g = document.createElement("div");
  g.className = "cards-grid collection-grid";
  for (const c of cards) g.appendChild(cardEl(c));
  wrap.appendChild(g);
  scheduleNameCorrection(cards);
  $("#col-empty").classList.toggle("hidden", cards.length !== 0);
}
function updateCollectionProgress() {
  if (state.view !== "colecciones") return;
  const col = store.getCollection(store.getSetting("activeCollectionId"));
  if (!col) return;
  const s = collectionStats(col);
  const fill = $("#col-fill");
  if (fill) fill.style.width = s.pct + "%";
  const txt = $("#col-progress-text");
  if (txt) txt.textContent = `${s.owned}/${s.total} cartas (${s.pct}%)`;
  const row = document.querySelector(`.col-item[data-col-id="${CSS.escape(col.id)}"]`);
  if (row) {
    row.querySelector(".ep-fill").style.width = s.pct + "%";
    row.querySelector(".col-nums").textContent = `${s.owned}/${s.total} (${s.pct}%)`;
  }
}
function openCollectionModal() {
  fillEditionSelectGrouped("#col-edition");
  $("#col-name").value = "";
  $("#collection-modal").classList.remove("hidden");
}
function closeCollectionModal() { $("#collection-modal").classList.add("hidden"); }
function createCollectionFromModal() {
  const ed = $("#col-edition").value;
  if (!ed) { showToast("Elige una edición para la colección"); return; }
  const name = $("#col-name").value.trim() || (state.editionName[ed] || ed);
  const col = store.createCollection(name, ed);
  store.setSetting("activeCollectionId", col.id);
  closeCollectionModal();
  renderCollectionsView();
  showToast(`Colección «${name}» creada ✓`);
}
function bindCollectionEvents() {
  $("#new-collection").addEventListener("click", openCollectionModal);
  $("#col-create").addEventListener("click", createCollectionFromModal);
  $$("[data-close-col]").forEach((el) => el.addEventListener("click", closeCollectionModal));
  $("#collection-modal").addEventListener("click", (e) => { if (e.target.classList.contains("modal-backdrop")) closeCollectionModal(); });
}

/* ===================== Ediciones personalizadas + import CSV =====================
   Crea una edición propia (p. ej. una que TOR aún no publica) y carga su listado
   desde un CSV. Las cartas se guardan como cartas manuales ligadas por su slug,
   así aparecen en el Catálogo y se pueden coleccionar como cualquier edición. */
const CSV_HEADERS = ["numero", "especial", "nombre", "tipo", "raza", "rareza", "coste", "fuerza", "habilidad", "historia", "imagen"];
const CF_FMT = { PE: "Primera Era", PB: "Primer Bloque", SB: "Segundo Bloque", FX: "Furia Extendido", NE: "Nueva Era / Imperio", OT: "Otro / personalizado" };
let edModal = { mode: "list", slug: null, csv: null };

function cardById(id) { return state.cards.find((c) => c.id === id) || null; }
function editionCardList(slug) {
  return state.cards.filter((c) => c.edition === slug)
    .sort((a, b) => (a.specialId ? 0 : 1) - (b.specialId ? 0 : 1) || compareEditionCards(a, b));
}

function openEditionsModal() { edModal = { mode: "list", slug: null, csv: null }; renderEditionsModal(); $("#editions-modal").classList.remove("hidden"); }
function closeEditionsModal() { $("#editions-modal").classList.add("hidden"); }

function renderEditionsModal() {
  const box = $("#editions-modal-box");
  if (edModal.mode === "list") {
    const eds = store.getCustomEditions();
    box.innerHTML = `
      <button class="modal-close" data-close-ed>×</button>
      <h2>Ediciones personalizadas</h2>
      <p class="muted">Crea ediciones propias (las que TOR aún no publica) y carga su listado desde un CSV. Sus cartas aparecen en el Catálogo y se pueden coleccionar.</p>
      <div class="sync-row"><button class="btn primary" id="ed-new">+ Nueva edición</button></div>
      <div class="ed-list">${eds.length ? eds.map((e) => {
        const n = editionCardList(e.slug).length;
        return `<div class="ed-item" data-slug="${escapeAttr(e.slug)}">
          <div><b>${escapeHtml(e.name)}</b> <span class="muted">· ${CF_FMT[e.format] || e.format} · ${n} carta(s)${e.expectedTotal ? " de " + e.expectedTotal : ""}</span></div>
          <div class="ed-item-btns"><button class="btn small" data-ed-open>Abrir</button><button class="btn small" data-ed-del>🗑</button></div>
        </div>`;
      }).join("") : `<p class="muted">Aún no tienes ediciones personalizadas.</p>`}</div>`;
    box.querySelector("[data-close-ed]").onclick = closeEditionsModal;
    $("#ed-new").onclick = () => {
      const name = prompt("Nombre de la nueva edición (p. ej. «AyD Vigilantes»):");
      if (!name || !name.trim()) return;
      const slug = uniqueEditionSlug(name.trim());
      store.createCustomEdition({ slug, name: name.trim(), format: "NE" });
      edModal = { mode: "detail", slug, csv: null };
      renderEditionsModal();
    };
    box.querySelectorAll(".ed-item").forEach((row) => {
      row.querySelector("[data-ed-open]").onclick = () => { edModal = { mode: "detail", slug: row.dataset.slug, csv: null }; renderEditionsModal(); };
      row.querySelector("[data-ed-del]").onclick = () => {
        const ed = store.getCustomEdition(row.dataset.slug);
        if (!ed || !confirm(`¿Eliminar la edición «${ed.name}»?\n\n(No borra sus cartas ni tus cantidades; solo la edición personalizada)`)) return;
        store.deleteCustomEdition(ed.slug);
        renderEditionsModal();
      };
    });
    return;
  }

  // ----- Detalle de una edición -----
  const ed = store.getCustomEdition(edModal.slug);
  if (!ed) { edModal = { mode: "list", slug: null, csv: null }; return renderEditionsModal(); }
  const cards = editionCardList(ed.slug);
  const fmtOpts = Object.entries(CF_FMT).map(([v, l]) => `<option value="${v}"${ed.format === v ? " selected" : ""}>${l}</option>`).join("");
  const cardRow = (c) => `<div class="ed-card-row" data-id="${escapeAttr(c.id)}">
      <span>${c.specialId ? `<b>${escapeHtml(c.specialId)}</b>` : (c.edid || "—")} · ${escapeHtml(c.name)} <span class="muted">${escapeHtml(c.type)}${c.cost != null ? " · ⛁" + c.cost : ""}${c.strength != null ? " · ⚔" + c.strength : ""}</span></span>
      <span class="ed-item-btns"><button class="btn small" data-ec-edit>✎</button><button class="btn small" data-ec-del>🗑</button></span>
    </div>`;
  box.innerHTML = `
    <button class="modal-close" data-close-ed>×</button>
    <button class="btn small" id="ed-back">← Mis ediciones</button>
    <h2 style="margin-top:10px">${escapeHtml(ed.name)}</h2>
    <div class="cf-grid">
      <label class="field"><span>Nombre *</span><input id="ed-name" type="text" value="${escapeAttr(ed.name)}" /></label>
      <label class="field"><span>Bloque / formato</span><select id="ed-format">${fmtOpts}</select></label>
      <label class="field cf-full"><span>Descripción</span><textarea id="ed-desc" rows="2">${escapeHtml(ed.description || "")}</textarea></label>
      <label class="field"><span>N.º de cartas de la edición (opcional)</span><input id="ed-total" type="number" min="0" value="${ed.expectedTotal ?? ""}" placeholder="Ej: 100" /></label>
    </div>
    <div class="sync-row">
      <button class="btn primary" id="ed-save">Guardar cambios</button>
      <button class="btn" id="ed-addcard">Agregar carta a mano</button>
    </div>
    <h3 class="sync-h3">Cartas de la edición (${cards.length}${ed.expectedTotal ? " de " + ed.expectedTotal : ""})</h3>
    <div class="ed-cards">${cards.map(cardRow).join("") || `<p class="muted">Aún no tiene cartas. Agrégalas a mano o importa el listado desde un CSV.</p>`}</div>
    <h3 class="sync-h3">Cargar cartas desde myl.fandom.com</h3>
    <p class="muted">Trae automáticamente el listado numerado directo desde el wiki (y sus promocionales, si indicas la página). Completa las cartas que encuentra con certeza; las dudosas quedan listadas para editarlas a mano. Si tu navegador bloquea la conexión, usa el CSV de más abajo.</p>
    <div class="cf-grid">
      <label class="field"><span>Nombre de la edición en el wiki</span><input id="wi-name" type="text" value="${escapeAttr(ed.name)}" placeholder="Ej: Cofradía" /></label>
      <label class="field"><span>Página de promocionales (opcional)</span><input id="wi-promo" type="text" placeholder="Ej: Lista de cartas Promo …" /></label>
    </div>
    <div class="sync-row"><button class="btn primary" id="wi-load">Buscar y cargar cartas</button></div>
    <div id="wi-status" class="muted" style="margin-top:8px"></div>
    <div id="wi-report" class="csv-report"></div>

    <h3 class="sync-h3">Importar listado desde CSV (UTF-8)</h3>
    <p class="muted">Columnas: <b>${CSV_HEADERS.join(", ")}</b>. Usa <b>numero</b> para las cartas normales o <b>especial</b> (ej: Promo, P-001) para las promocionales. La imagen debe ser un enlace https://…. Reimportar el mismo archivo <b>actualiza</b> las cartas en vez de duplicarlas.</p>
    <div class="sync-row">
      <button class="btn" id="ed-tpl">Descargar plantilla CSV</button>
      <label class="btn" style="cursor:pointer">Elegir archivo CSV<input id="ed-csv" type="file" accept=".csv,text/csv" hidden /></label>
    </div>
    <div id="ed-csv-preview" class="csv-report"></div>`;
  box.querySelector("[data-close-ed]").onclick = closeEditionsModal;
  $("#ed-back").onclick = () => { edModal = { mode: "list", slug: null, csv: null }; renderEditionsModal(); };
  $("#ed-save").onclick = () => {
    const name = $("#ed-name").value.trim();
    if (!name) { showToast("El nombre no puede quedar vacío"); return; }
    const totalRaw = $("#ed-total").value;
    store.updateCustomEdition(ed.slug, {
      name, description: $("#ed-desc").value.trim(), format: $("#ed-format").value,
      expectedTotal: totalRaw === "" ? null : Math.max(0, Math.floor(Number(totalRaw))),
    });
    if (name !== ed.name) store.renameEditionOnCards(ed.slug, name);
    rebuildCards(); populateFilters(); applyFilters();
    if (state.view === "colecciones") renderCollectionsView();
    renderEditionsModal();
    showToast("Edición guardada ✓");
  };
  $("#ed-addcard").onclick = () => {
    openCardForm(null);
    $("#cf-edition").value = ed.name;
    $("#cf-format").value = ed.format === "OT" ? "NE" : ed.format;
  };
  $("#wi-load").onclick = () => loadEditionFromWiki(ed);
  box.querySelectorAll(".ed-card-row").forEach((row) => {
    const card = cardById(row.dataset.id);
    row.querySelector("[data-ec-edit]").onclick = () => { if (card) { closeEditionsModal(); openCardForm(card); } };
    row.querySelector("[data-ec-del]").onclick = () => {
      if (!card || !confirm(`¿Quitar «${card.name}» de la edición? (Se elimina la carta manual)`)) return;
      store.deleteCustomCard(card.id);
      rebuildCards(); populateFilters(); applyFilters();
      renderEditionsModal();
    };
  });
  $("#ed-tpl").onclick = downloadCSVTemplate;
  $("#ed-csv").onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { edModal.csv = parseEditionCSV(String(reader.result), ed); renderCSVPreview(); };
    reader.readAsText(f, "utf-8");
    e.target.value = "";
  };
}

function uniqueEditionSlug(name) {
  let base = editionSlug(name), slug = base, i = 2;
  const taken = new Set(state.cards.map((c) => c.edition).concat(store.getCustomEditions().map((e) => e.slug)));
  while (taken.has(slug)) slug = base + "_" + i++;
  return slug;
}

function downloadCSVTemplate() {
  const tpl = CSV_HEADERS.join(",") + "\n" +
    `1,,Ejemplo Aliado,Aliado,Guerrero,Cortesano,3,2,"Cuando entra en juego, roba una carta.","Texto de ambientación.",https://ejemplo.com/carta1.png\n` +
    `2,,Ejemplo Talismán,Talismán,,Real,2,,"Destierra un Oro en juego.",,\n` +
    `,Promo,Inti,Aliado,Sacerdote,Promocional,3,4,"Ejemplo promocional sin número.",,https://ejemplo.com/inti.png\n`;
  download("plantilla_edicion.csv", "﻿" + tpl, "text/csv;charset=utf-8");
  showToast("Plantilla descargada: llénala en Excel/Sheets y guárdala como CSV UTF-8");
}

function parseCSV(text) {
  text = String(text).replace(/^﻿/, "");
  const rows = []; let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function parseEditionCSV(text, ed) {
  const rows = parseCSV(text);
  if (!rows.length) return { cards: [], errors: ["El archivo está vacío."] };
  const header = rows[0].map((h) => normText(h).trim());
  const idx = {};
  for (const col of CSV_HEADERS) idx[col] = header.indexOf(col);
  if (idx.nombre === -1) return { cards: [], errors: ['Falta la columna "nombre" en la primera fila. Descarga la plantilla para ver el formato.'] };
  const cards = [], errors = [], seenNums = new Set(), seenSpecials = new Set();
  const get = (r, col) => (idx[col] === -1 ? "" : (r[idx[col]] ?? "").trim());
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], fila = i + 1;
    const nombre = get(r, "nombre");
    if (!nombre) { errors.push(`fila ${fila}: sin nombre`); continue; }
    const numRaw = get(r, "numero"), espRaw = get(r, "especial");
    if (numRaw !== "" && espRaw !== "") { errors.push(`fila ${fila} («${nombre}»): usa "numero" O "especial", no ambos`); continue; }
    let num = null;
    if (espRaw !== "") {
      const key = normText(espRaw);
      if (seenSpecials.has(key)) { errors.push(`fila ${fila} («${nombre}»): especial "${espRaw}" repetido`); continue; }
      seenSpecials.add(key);
    } else if (numRaw !== "") {
      num = Number(numRaw);
      if (!Number.isInteger(num) || num < 1) { errors.push(`fila ${fila} («${nombre}»): número inválido "${numRaw}"`); continue; }
      if (seenNums.has(num)) { errors.push(`fila ${fila} («${nombre}»): número ${num} repetido`); continue; }
      seenNums.add(num);
    }
    const imagen = get(r, "imagen");
    if (imagen && !/^https?:\/\//i.test(imagen)) { errors.push(`fila ${fila} («${nombre}»): la imagen debe ser un enlace https://…`); continue; }
    const numOrEmpty = (col) => { const v = get(r, col); if (v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
    const coste = numOrEmpty("coste"), fuerza = numOrEmpty("fuerza");
    if (Number.isNaN(coste) || Number.isNaN(fuerza)) { errors.push(`fila ${fila} («${nombre}»): coste o fuerza no numérico`); continue; }
    cards.push({
      name: nombre, edition: ed.slug, editionName: ed.name, specialId: espRaw,
      edid: num ? String(num).padStart(3, "0") : "",
      format: ed.format === "OT" ? "NE" : ed.format,
      type: get(r, "tipo") || "—", race: get(r, "raza") || "—", rarity: get(r, "rareza") || "—",
      cost: coste, strength: fuerza, ability: get(r, "habilidad"), flavour: get(r, "historia"), image: imagen,
    });
  }
  return { cards, errors };
}

function renderCSVPreview() {
  const boxp = $("#ed-csv-preview");
  const { cards, errors } = edModal.csv || { cards: [], errors: [] };
  const errList = errors.slice(0, 12).map((e) => `<div class="err">✗ ${escapeHtml(e)}</div>`).join("") +
    (errors.length > 12 ? `<div class="err">… y ${errors.length - 12} error(es) más</div>` : "");
  boxp.innerHTML = `
    <p><b>${cards.length}</b> carta(s) lista(s) para importar${errors.length ? ` · <b>${errors.length}</b> fila(s) con error (se omiten)` : " · sin errores"}.</p>
    ${errList}
    ${cards.length ? `<div class="sync-row"><button class="btn primary" id="ed-import">Importar ${cards.length} carta(s)</button></div>` : ""}`;
  const btn = $("#ed-import");
  if (btn) btn.onclick = () => importCSVCards();
}

// Crea o actualiza cartas de la edición, emparejando por número, por
// identificador especial, o por nombre — así reimportar actualiza en vez de duplicar.
function importCSVCards() {
  const ed = store.getCustomEdition(edModal.slug);
  const existing = store.getCustomCards().filter((c) => c.edition === ed.slug);
  let created = 0, updated = 0;
  for (const card of edModal.csv.cards) {
    const match = existing.find((c) =>
      card.specialId ? normText(c.specialId || "") === normText(card.specialId)
        : card.edid ? String(c.edid) === String(card.edid)
        : normText(c.name) === normText(card.name)
    );
    if (match) { store.updateCustomCard(match.id, card); updated++; }
    else { store.addCustomCard(card); created++; }
  }
  edModal.csv = null;
  rebuildCards(); populateFilters(); applyFilters();
  if (state.view === "colecciones") renderCollectionsView();
  renderEditionsModal();
  showToast(`Importación lista: ${created} nueva(s), ${updated} actualizada(s)`, 4500);
}

// Crea o actualiza cartas de una edición, emparejando por número, identificador
// especial, o nombre. La usan el import CSV y la carga desde el wiki.
function mergeEditionCards(ed, cards, matchKeyOf) {
  const existing = store.getCustomCards().filter((c) => c.edition === ed.slug);
  let created = 0, updated = 0;
  for (const card of cards) {
    const key = matchKeyOf(card);
    const match = existing.find((c) =>
      key.esp ? normText(c.specialId || "") === normText(key.esp)
        : key.num != null ? parseInt(c.edid, 10) === key.num
        : normText(c.name) === normText(card.name)
    );
    if (match) { store.updateCustomCard(match.id, card); updated++; }
    else { store.addCustomCard(card); created++; }
  }
  return { created, updated };
}

// Trae el listado de una edición desde myl.fandom.com (API MediaWiki con CORS,
// ver js/wiki-import.js) y lo fusiona en la edición actual. Lo que no se pueda
// identificar con certeza llega con datos mínimos y se lista aparte.
async function loadEditionFromWiki(ed) {
  const wikiName = $("#wi-name").value.trim();
  if (!wikiName) { showToast("Escribe el nombre de la edición en el wiki"); return; }
  const promoPage = $("#wi-promo").value.trim() || null;
  const btn = $("#wi-load");
  const statusEl = $("#wi-status");
  $("#wi-report").innerHTML = "";
  btn.disabled = true;
  statusEl.textContent = "Conectando con myl.fandom.com…";
  try {
    const { cards, report } = await importEditionFromWiki({
      wikiEditionName: wikiName,
      editionSlug: ed.slug,
      editionDisplayName: ed.name,
      format: ed.format === "OT" ? "NE" : ed.format,
      promoPage,
      onProgress: (msg) => { statusEl.textContent = msg; },
    });
    const { created, updated } = mergeEditionCards(
      ed, cards, (card) => ({ num: card.edid ? parseInt(card.edid, 10) : null, esp: card.specialId })
    );
    rebuildCards(); populateFilters(); applyFilters();
    if (state.view === "colecciones") renderCollectionsView();
    // renderEditionsModal reconstruye el DOM: hay que volver a pedir referencias.
    renderEditionsModal();
    const gaps = report.sinResolver.length;
    $("#wi-status").textContent = `Listo: ${created} carta(s) nueva(s), ${updated} actualizada(s).`;
    $("#wi-report").innerHTML = gaps
      ? `<p>${gaps} carta(s) no se identificaron con certeza y quedaron con datos mínimos:</p>` +
        report.sinResolver.slice(0, 30).map((e) => `<div class="err">✗ ${escapeHtml(e.nombre)}</div>`).join("") +
        (gaps > 30 ? `<div class="err">… y ${gaps - 30} más</div>` : "") +
        `<p class="muted">Edítalas a mano arriba o vuelve a intentar con la página exacta.</p>`
      : `<p>Todas las cartas se identificaron con certeza ✓</p>`;
    showToast(`Cargado desde el wiki: ${created + updated} carta(s)`, 4500);
  } catch (e) {
    statusEl.textContent = "";
    $("#wi-report").innerHTML = `<p class="err">✗ ${escapeHtml(e.message)}</p><p class="muted">Si tu navegador bloquea la conexión, usa el import por CSV de abajo.</p>`;
    btn.disabled = false;
  }
}

function bindEditionsEvents() {
  const btn = $("#open-editions");
  if (btn) btn.addEventListener("click", openEditionsModal);
  $("#editions-modal").addEventListener("click", (e) => { if (e.target.classList.contains("modal-backdrop")) closeEditionsModal(); });
}

/* ===================== Cambios (inventario de intercambio) =====================
   Marca copias repetidas como disponibles para cambio. Al registrar un
   intercambio: −1 la entregada, +1 la recibida, la recibida entra a la colección
   de su edición (si no existe, se crea sola) y queda en el historial. */
function cardNum(c) { return parseInt(c.edid, 10); }

function renderTradeView() { renderTradeList(); renderTradeLog(); }
function renderTradeList() {
  const wrap = $("#trade-list");
  const entries = Object.entries(store.getTradeList());
  const copies = entries.reduce((a, [, n]) => a + n, 0);
  $("#trade-summary").textContent = entries.length
    ? `${entries.length} carta(s) distinta(s) · ${copies} copia(s) ofrecida(s)`
    : "Aún no marcas cartas para cambio.";
  if (!entries.length) {
    wrap.innerHTML = `<p class="muted">Busca arriba una carta que tengas repetida y ofrécela.</p>`;
    return;
  }
  wrap.innerHTML = entries.map(([id, n]) => {
    const c = cardById(id);
    const name = c ? escapeHtml(displayName(c)) : `<span class="mono">${escapeHtml(id)}</span>`;
    const meta = c
      ? `${escapeHtml(c.editionName || "")}${Number.isFinite(cardNum(c)) ? " · #" + cardNum(c) : ""} · tienes ${store.getQty(id)}`
      : "fuera de catálogo";
    return `<div class="trade-row" data-id="${escapeAttr(id)}">
      <div class="tr-info"><span class="tr-name">${name}</span><span class="tr-meta">${meta}</span></div>
      <div class="tr-qty"><button class="qty-btn" data-tr="minus">−</button><span>${n}</span><button class="qty-btn" data-tr="plus">+</button></div>
      <button class="btn small" data-exchange ${c ? "" : "disabled"}>Intercambiar</button>
    </div>`;
  }).join("");
  wrap.querySelectorAll(".trade-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll("[data-tr]").forEach((b) => {
      b.onclick = () => { store.addTradeQty(id, b.dataset.tr === "plus" ? 1 : -1); renderTradeList(); };
    });
    row.querySelector("[data-exchange]").onclick = () => { const c = cardById(id); if (c) openTradeModal(c); };
  });
}
function renderTradeLog() {
  const wrap = $("#trade-log");
  const log = store.getTradeLog();
  if (!log.length) { wrap.innerHTML = `<p class="muted">Todavía no registras intercambios.</p>`; return; }
  wrap.innerHTML = log.map((e) => {
    const g = cardById(e.given), r = cardById(e.received);
    return `<div class="tlog-row">
      <span class="muted">${new Date(e.date).toLocaleString("es-CL")}</span>
      <span>Entregada: <b>${escapeHtml(g ? displayName(g) : e.given)}</b></span>
      <span>Recibida: <b>${escapeHtml(r ? displayName(r) : e.received)}</b></span>
    </div>`;
  }).join("");
}
function renderTradeSearchResults() {
  const q = normText($("#trade-search").value.trim());
  const res = $("#trade-search-results");
  if (q.length < 2) { res.innerHTML = ""; return; }
  const matches = state.cards.filter((c) => store.getQty(c.id) > 0 && c.searchText.includes(q)).slice(0, 30);
  res.innerHTML = matches.map((c) => `
    <div class="dsr" data-id="${escapeAttr(c.id)}">
      <span class="dsr-name">${escapeHtml(displayName(c))}</span>
      <span class="dsr-meta">${escapeHtml(c.editionName || "")} · tienes ${store.getQty(c.id)} · en cambio ${store.getTradeQty(c.id)}</span>
      <button class="btn small" data-offer>Ofrecer copia</button>
    </div>`).join("") || `<p class="muted">Sin resultados (solo cartas con copias en tu inventario).</p>`;
  res.querySelectorAll(".dsr").forEach((row) => {
    row.querySelector("[data-offer]").onclick = () => {
      const before = store.getTradeQty(row.dataset.id);
      const after = store.addTradeQty(row.dataset.id, 1);
      if (after === before) showToast("Ya ofreces todas las copias que tienes de esa carta", 3000);
      renderTradeList();
      renderTradeSearchResults();
    };
  });
}
let tradeGivenCard = null;
function openTradeModal(card) {
  tradeGivenCard = card;
  $("#tm-given").textContent = `«${displayName(card)}» (${card.editionName || "—"})`;
  $("#tm-search").value = "";
  $("#tm-results").innerHTML = "";
  $("#trade-modal").classList.remove("hidden");
  $("#tm-search").focus();
}
function closeTradeModal() { $("#trade-modal").classList.add("hidden"); tradeGivenCard = null; }
function renderTradeModalResults() {
  const q = normText($("#tm-search").value.trim());
  const res = $("#tm-results");
  if (q.length < 2) { res.innerHTML = ""; return; }
  const matches = state.cards.filter((c) => c.searchText.includes(q)).slice(0, 30);
  res.innerHTML = matches.map((c) => `
    <div class="dsr" data-id="${escapeAttr(c.id)}">
      <span class="dsr-name">${escapeHtml(displayName(c))}</span>
      <span class="dsr-meta">${escapeHtml(c.editionName || "")}${Number.isFinite(cardNum(c)) ? " · #" + cardNum(c) : ""}</span>
      <button class="btn small" data-receive>Esta recibí</button>
    </div>`).join("") || `<p class="muted">Sin resultados.</p>`;
  res.querySelectorAll(".dsr").forEach((row) => {
    row.querySelector("[data-receive]").onclick = () => {
      const received = cardById(row.dataset.id);
      if (received && tradeGivenCard) executeTrade(tradeGivenCard, received);
    };
  });
}
function executeTrade(given, received) {
  if (store.getQty(given.id) < 1) { showToast("Ya no tienes copias de la carta entregada", 3000); return; }
  if (!confirm(`¿Registrar este intercambio?\n\nEntregas: ${displayName(given)}\nRecibes: ${displayName(received)}`)) return;
  store.addQty(given.id, -1);
  store.addTradeQty(given.id, -1);
  store.addQty(received.id, +1);
  let col = store.getCollections().find((c) => c.edition === received.edition);
  let created = false;
  if (!col) {
    const name = state.editionName[received.edition] || received.editionName || received.edition || "Colección";
    col = store.createCollection(name, received.edition);
    created = true;
  }
  store.addTradeLogEntry({ given: given.id, received: received.id });
  closeTradeModal();
  renderTradeView();
  applyFilters();
  showToast(`Cambio registrado: −«${displayName(given)}» +«${displayName(received)}», sumada a «${col.name}»${created ? " (creada)" : ""}.`, 5500);
}
function bindTradeEvents() {
  $("#trade-search").addEventListener("input", debounce(renderTradeSearchResults, 180));
  $("#tm-search").addEventListener("input", debounce(renderTradeModalResults, 180));
  $$("[data-close-trade]").forEach((el) => el.addEventListener("click", closeTradeModal));
  $("#trade-modal").addEventListener("click", (e) => { if (e.target.classList.contains("modal-backdrop")) closeTradeModal(); });
}

/* ===================== Navegación / eventos ===================== */
function switchView(view) {
  state.view = view;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  if (view === "colecciones") renderCollectionsView();
  if (view === "cambios") renderTradeView();
  if (view === "mazos") renderDecksView();
  if (view === "stats") renderStats();
}

function bindEvents() {
  // Tabs
  $$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

  // Filtros
  const debounced = debounce(applyFilters, 180);
  $("#search").addEventListener("input", debounced);
  ["#f-ownership", "#f-edition", "#f-race", "#f-type", "#f-rarity", "#f-sort"].forEach((s) =>
    $(s).addEventListener("change", applyFilters)
  );
  $("#f-format").addEventListener("change", () => { refreshEditionOptions(); applyFilters(); });
  $("#f-cost").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    $("#cost-val").textContent = v >= 12 ? "∞" : v;
    applyFilters();
  });
  $("#clear-filters").addEventListener("click", () => {
    $("#search").value = "";
    ["#f-ownership", "#f-format", "#f-edition", "#f-race", "#f-type", "#f-rarity", "#f-sort"].forEach((s) => ($(s).selectedIndex = 0));
    $("#f-cost").value = 12; $("#cost-val").textContent = "∞";
    refreshEditionOptions();
    applyFilters();
  });

  // Paginación
  $("#load-more").addEventListener("click", () => { state.page++; renderGrid(false); });

  // Modal
  $("#modal").addEventListener("click", (e) => { if (e.target.classList.contains("modal-backdrop")) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closeDeckModal(); closeSyncModal(); closeCardForm(); closeOrphanModal(); closeCollectionModal(); closeEditionsModal(); closeTradeModal(); } });
  bindCollectionEvents();
  bindEditionsEvents();
  bindTradeEvents();
  $("#orphan-note").addEventListener("click", openOrphanModal);
  $("#orphan-modal").addEventListener("click", (e) => { if (e.target.classList.contains("modal-backdrop")) closeOrphanModal(); });
  $$("[data-close-orphan]").forEach((el) => el.addEventListener("click", closeOrphanModal));
  $("#deck-modal").addEventListener("click", (e) => { if (e.target.classList.contains("modal-backdrop")) closeDeckModal(); });

  // Exportar / importar
  const dd = $(".dropdown");
  $("#btn-export").addEventListener("click", () => dd.classList.toggle("open"));
  document.addEventListener("click", (e) => { if (!dd.contains(e.target)) dd.classList.remove("open"); });
  $$(".dropdown-menu button").forEach((b) =>
    b.addEventListener("click", () => { exportCollection(b.dataset.export); dd.classList.remove("open"); })
  );
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => { if (e.target.files[0]) importCollection(e.target.files[0]); e.target.value = ""; });

  // Mazos
  $("#new-deck").addEventListener("click", () => {
    const name = prompt("Nombre del mazo:", "Mazo nuevo");
    if (name !== null) { const d = store.createDeck(name); store.setSetting("activeDeckId", d.id); renderDecksView(); }
  });
  bindDeckBarEvents();

  // Estadísticas
  ["#stats-scope", "#stats-format"].forEach((s) => $(s).addEventListener("change", renderStats));
  $("#stats-export-pdf").addEventListener("click", statsExportPDF);

  // Datos / sincronización
  bindSyncEvents();

  // Carta manual
  bindCardFormEvents();

  // Tema
  $("#theme-toggle").addEventListener("click", toggleTheme);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  applyTheme(cur);
  store.setSetting("theme", cur);
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("#theme-toggle").textContent = theme === "light" ? "☀️" : "🌙";
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ===================== Init ===================== */
async function init() {
  applyTheme(store.getSetting("theme") || "dark");
  bindEvents();
  store.onChange(onStoreChange);
  await loadData();
  populateFilters();
  refreshActiveDeckUI();
  applyFilters();
  // Sincronización en la nube (si está configurada)
  if (cloud.isConfigured()) { setChip("☁ Sincronizado", "ok"); cloudReconcile(); startRealtime(); }
  startCloudBackgroundSync();
}
init();
