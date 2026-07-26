/* =============================================================================
   wiki-import.js — Cargar el listado de una edición desde myl.fandom.com
   -----------------------------------------------------------------------------
   Versión en el navegador (sin backend) del mismo proceso que hace la skill
   ".claude/skills/importar-edicion-myl-wiki" desde la terminal. Se ejecuta
   directamente contra la API pública de MediaWiki (api.php), que expone
   CORS (`&origin=*`) y por eso se puede llamar desde fetch() en el cliente.

   IMPORTANTE — mismo diseño de "no adivinar" que la skill, y por el mismo
   motivo real: al construir la skill, una primera versión que aceptaba
   automáticamente el primer resultado de búsqueda con el mismo tipo/rareza
   estuvo a punto de asignarle a la carta "Daphne und Gregor" la imagen y el
   texto de "Niamh" (ambas Aliado/Vasallo, pero cartas distintas). Por eso
   acá también: solo se completan cartas cuya página en el wiki se encuentra
   por su título EXACTO (de la edición o una página base compartida); las
   que no se encuentran así quedan en el "informe" para completar a mano o
   pedirle a Claude que las resuelva con la skill (que sí hace verificación
   cruzada con juicio, algo que no es seguro automatizar en un botón).

   LIMITACIÓN CONOCIDA (sin confirmar en producción): en las pruebas hechas
   para construir esto, un navegador AUTOMATIZADO (headless, sin pantalla,
   corriendo en un sandbox) no pudo completar las peticiones a myl.fandom.com
   — ni siquiera a la propia API con CORS — mientras que la herramienta curl,
   desde la misma red, sí. Es un patrón típico de protección anti-bot
   (Cloudflare) que distingue tráfico de navegador automatizado del de un
   navegador real. No hay forma de confirmar desde ese entorno si un
   navegador real (el tuyo, en tu propio computador) tiene el mismo problema
   — por eso este módulo atrapa cualquier error de red y lo explica con
   claridad en vez de fallar en silencio. Si falla para ti también, el
   camino de siempre (CSV generado por la skill) sigue funcionando igual. */

const API = "https://myl.fandom.com/es/api.php";

/* ===================== HTTP (con CORS) ===================== */
async function apiGet(params) {
  const url = API + "?" + new URLSearchParams({ ...params, origin: "*" }).toString();
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    // Sin más detalle disponible en el navegador: puede ser falta de
    // conexión, o el wiki bloqueando la petición (ver nota arriba).
    throw new Error(
      "No se pudo conectar con myl.fandom.com. Puede ser tu conexión, o que el " +
      "wiki esté bloqueando peticiones automáticas desde el navegador. " +
      "Pídele a Claude que genere el CSV con la skill como alternativa."
    );
  }
  if (!res.ok) throw new Error(`El wiki respondió ${res.status} al consultar la API.`);
  return res.json();
}

async function fetchWikitext(pageTitle) {
  const d = await apiGet({ action: "parse", page: pageTitle, prop: "wikitext", format: "json" });
  if (d.error) return null;
  return d.parse.wikitext["*"];
}

// Trae el wikitext de varias páginas a la vez (lotes de 40, igual que el
// script de la skill: la API no tiene un límite documentado estricto para
// `titles`, pero URLs muy largas pueden fallar).
async function fetchContents(titles, onProgress) {
  const out = new Map();
  const arr = Array.from(titles);
  for (let i = 0; i < arr.length; i += 40) {
    const chunk = arr.slice(i, i + 40);
    const d = await apiGet({
      action: "query", prop: "revisions", rvprop: "content",
      titles: chunk.join("|"), format: "json", formatversion: "2", redirects: "1",
    });
    for (const p of d.query?.pages || []) {
      if (p.missing || !p.revisions) continue;
      out.set(p.title, p.revisions[0].content);
    }
    if (onProgress) onProgress(Math.min(i + 40, arr.length), arr.length);
  }
  return out;
}

async function resolveImageUrls(files, onProgress) {
  const unique = [...new Set(files.filter(Boolean))];
  const urlByFile = new Map();

  async function queryBatch(names) {
    const found = new Map();
    const titles = names.map((n) => "File:" + n);
    for (let i = 0; i < titles.length; i += 40) {
      const d = await apiGet({
        action: "query", titles: titles.slice(i, i + 40).join("|"),
        prop: "imageinfo", iiprop: "url", format: "json", formatversion: "2",
      });
      for (const p of d.query?.pages || []) {
        // La API devuelve el namespace LOCALIZADO ("Archivo:" en es.fandom,
        // no "File:") aunque se haya preguntado con "File:" — no asumir el
        // prefijo, cortar por los dos puntos.
        const clean = p.title.includes(":") ? p.title.split(":").slice(1).join(":") : p.title;
        if (!p.missing && p.imageinfo) found.set(clean, p.imageinfo[0].url);
      }
    }
    return found;
  }

  const first = await queryBatch(unique);
  for (const [k, v] of first) urlByFile.set(k, v);
  if (onProgress) onProgress(urlByFile.size, unique.length);

  const missing = unique.filter((f) => !urlByFile.has(f));
  if (missing.length) {
    const variantSets = new Map();
    for (const f of missing) {
      const opts = new Set([f[0].toUpperCase() + f.slice(1)]);
      const base = f.replace(/\s+[A-ZÀ-ÿ][\wÀ-ÿ]*\.(jpg|png)$/i, ".$1"); // quita " Edicion.ext"
      opts.add(base[0].toUpperCase() + base.slice(1));
      opts.add(f.replace(/\.jpg$/i, ".png"));
      opts.add(f.replace(/\.png$/i, ".jpg"));
      variantSets.set(f, opts);
    }
    const allOpts = [...new Set([...variantSets.values()].flatMap((s) => [...s]))];
    const foundVariants = await queryBatch(allOpts);
    for (const [f, opts] of variantSets) {
      for (const o of opts) {
        if (foundVariants.has(o)) { urlByFile.set(f, foundVariants.get(o)); break; }
      }
    }
  }
  return urlByFile;
}

/* ===================== Parseo de la tabla de listado ===================== */
function stripWiki(s) {
  if (!s) return "";
  s = s.replace(/\[\[:?Categoría:([^|\]]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a);
  s = s.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]]+)\]\]/g, "$1");
  return s.replace(/'''/g, "").replace(/''/g, "").trim();
}

function splitRows(wikitext) {
  return wikitext.split(/\n\|-\n/).map((r) => r.trim()).filter(Boolean);
}
function rowCells(raw) {
  return raw.split("\n")
    .map((ln) => ln.trim())
    .filter((ln) => ln.startsWith("|"))
    .map((ln) => ln.slice(1).trim());
}

function parseListTable(wikitext) {
  const marker = wikitext.indexOf("!'''N°'''");
  if (marker === -1) {
    throw new Error(
      "No se encontró la tabla de cartas (columna N°) en esta página. " +
      "Puede que esta edición liste las cartas de otra forma."
    );
  }
  const end = wikitext.indexOf("|}", marker);
  const table = wikitext.slice(marker, end === -1 ? undefined : end);
  const cards = [];
  for (const raw of splitRows(table)) {
    if (raw.startsWith("!") || raw.startsWith("class=")) continue;
    const cells = rowCells(raw);
    if (cells.length < 4 || !/^\d+$/.test(cells[0])) continue;
    const m = cells[1].match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (!m) continue;
    cards.push({
      num: parseInt(cells[0], 10),
      pageTitle: m[1],
      name: m[2] || m[1],
      type: stripWiki(cells[2]),
      rarity: cells.length > 3 ? stripWiki(cells[3]) : "",
    });
  }
  cards.sort((a, b) => a.num - b.num);
  return cards;
}

function parsePromoTable(wikitext) {
  const cards = [];
  for (const raw of splitRows(wikitext)) {
    if (raw.startsWith("!") || raw.startsWith("class=")) continue;
    const cells = rowCells(raw);
    if (cells.length < 2) continue;
    const m = cells[1].match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (!m) continue;
    const ident = stripWiki(cells[0]);
    if (!ident || /^\d+$/.test(ident)) continue; // ya es una carta numerada normal
    cards.push({
      specialId: ident,
      pageTitle: m[1],
      name: m[2] || m[1],
      type: cells.length > 2 ? stripWiki(cells[2]) : "",
      rarity: cells.length > 3 ? stripWiki(cells[3]) : "",
    });
  }
  return cards;
}

/* ===================== Parseo de la plantilla {{Carta...}} ===================== */
function extractTemplate(text) {
  const m = text.match(/\{\{Carta\w*/);
  if (!m) return null;
  let i = m.index, depth = 0, j = i;
  while (j < text.length) {
    if (text.slice(j, j + 2) === "{{") { depth++; j += 2; continue; }
    if (text.slice(j, j + 2) === "}}") { depth--; j += 2; }
    if (depth === 0) break;
    j++;
  }
  return depth === 0 ? text.slice(i + m[0].length, j - 2) : null;
}

// Separa por '|' de nivel superior, respetando [[ ]] anidados y bloques
// <tabber>...</tabber> (variantes Digital/Scan de la imagen). El bug real
// que tuvo la primera versión de esto (tanto en Python como acá) fue un
// desfase de índice al detectar "<tabber>"/"</tabber>" que hacía perder la
// imagen de las cartas que usan ese formato — ojo si se toca este código.
function splitFields(body) {
  const fields = [];
  let cur = "", depthBr = 0, inTabber = false, i = 0;
  while (i < body.length) {
    if (body.slice(i, i + 8) === "<tabber>") inTabber = true;
    if (body.slice(i, i + 9) === "</tabber>") inTabber = false;
    if (body.slice(i, i + 2) === "[[") { depthBr++; cur += "[["; i += 2; continue; }
    if (body.slice(i, i + 2) === "]]") { depthBr--; cur += "]]"; i += 2; continue; }
    const ch = body[i];
    if (ch === "|" && depthBr === 0 && !inTabber) { fields.push(cur); cur = ""; i++; continue; }
    cur += ch; i++;
  }
  fields.push(cur);
  return fields;
}

function parseCardTemplate(text) {
  const body = extractTemplate(text);
  if (body == null) return {};
  const data = {};
  for (const f of splitFields(body)) {
    const eq = f.indexOf("=");
    if (eq === -1) continue;
    data[f.slice(0, eq).trim().toLowerCase()] = f.slice(eq + 1).trim();
  }
  return data;
}

function firstImageFile(imagenField) {
  if (!imagenField) return null;
  const m = imagenField.match(/\[\[(?:File|Archivo):([^|\]]+)/);
  return m ? m[1].trim() : null;
}

/* ===================== Resolución de la página de cada carta ===================== */
// Solo página específica de la edición o página base compartida — nunca
// búsqueda + adivinanza (ver nota al inicio del archivo).
function resolveCardContent(card, editionName, contents, report) {
  const title = card.pageTitle;
  const specific = title.includes(`(${editionName})`) ? title : `${title} (${editionName})`;
  if (contents.has(specific)) return contents.get(specific);
  if (contents.has(title)) return contents.get(title);
  const base = title.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (contents.has(base)) return contents.get(base);
  report.sinResolver.push({ nombre: card.name, paginaIntentada: title });
  return null;
}

function buildCard(card, txt, editionSlug, editionDisplayName, format, specialId) {
  const d = txt ? parseCardTemplate(txt) : {};
  let coste = (d["coste de oro"] || "").trim();
  let fuerza = (d["ataque"] || "").trim();
  let habilidad = stripWiki(d["habilidad"] || "");
  // Cartas con coste o fuerza "X" (variable): el modelo de datos exige
  // números, así que el valor se deja vacío y la aclaración se antepone a
  // la habilidad para no perder la información (mismo criterio que el CSV).
  if (fuerza.toUpperCase() === "X") { fuerza = ""; habilidad = "(Fuerza X) " + habilidad; }
  if (coste.toUpperCase() === "X") { coste = ""; habilidad = "(Coste X) " + habilidad; }
  const imgFile = firstImageFile(d["imagen"] || "");
  return {
    name: card.name,
    edition: editionSlug,
    editionName: editionDisplayName,
    edid: specialId ? "" : (card.num != null ? String(card.num).padStart(3, "0") : ""),
    specialId: specialId || "",
    format,
    type: stripWiki(d["tipo"] || "") || card.type || "—",
    race: stripWiki(d["raza"] || "") || "—",
    rarity: stripWiki(d["frecuencia"] || "") || card.rarity || "—",
    cost: coste === "" ? null : Number(coste),
    strength: fuerza === "" ? null : Number(fuerza),
    ability: habilidad,
    flavour: stripWiki(d["texto"] || ""),
    image: "", // se completa después con resolveImageUrls
    _imageFile: imgFile,
  };
}

/* ===================== Función principal ===================== */
// editionSlug/editionDisplayName: identidad de la edición en la app (la que
// ya existe o se está creando en el gestor de Ediciones).
// wikiEditionName: nombre tal como aparece en la URL del wiki (puede diferir
// ligeramente, p. ej. mayúsculas).
// Devuelve { cards, report } — cards ya vienen listas para
// store.addCustomCard/updateCustomCard; report.sinResolver lista lo que no
// se pudo completar automáticamente.
export async function importEditionFromWiki({
  wikiEditionName, editionSlug, editionDisplayName, format, listPage, promoPage, onProgress,
}) {
  const progress = (msg) => onProgress && onProgress(msg);
  const listTitle = listPage || `Lista de cartas de ${wikiEditionName}`;

  progress(`Descargando listado: ${listTitle}…`);
  const listWikitext = await fetchWikitext(listTitle);
  if (listWikitext == null) {
    throw new Error(
      `No existe la página «${listTitle}» en myl.fandom.com. Revisa el nombre ` +
      `exacto de la edición (tal como aparece en la URL del wiki).`
    );
  }
  const numbered = parseListTable(listWikitext);

  let specials = [];
  if (promoPage) {
    progress(`Descargando promocionales: ${promoPage}…`);
    const promoWt = await fetchWikitext(promoPage);
    if (promoWt) specials = parsePromoTable(promoWt);
  }

  const allItems = [...numbered, ...specials];
  const titlesNeeded = new Set();
  for (const c of allItems) {
    titlesNeeded.add(c.pageTitle);
    titlesNeeded.add(`${c.pageTitle} (${wikiEditionName})`);
    titlesNeeded.add(c.pageTitle.replace(/\s*\([^)]*\)\s*$/, "").trim());
  }
  progress(`Descargando el contenido de ${titlesNeeded.size} páginas candidatas…`);
  const contents = await fetchContents(titlesNeeded, (done, total) =>
    progress(`Descargando páginas… ${done}/${total}`));

  const report = { sinResolver: [], sinImagen: [] };
  const cards = [];
  for (const c of numbered) {
    const txt = resolveCardContent(c, wikiEditionName, contents, report);
    const card = buildCard(c, txt, editionSlug, editionDisplayName, format);
    cards.push(card);
    if (!card._imageFile) report.sinImagen.push(c.name);
  }
  for (const c of specials) {
    const txt = resolveCardContent(c, wikiEditionName, contents, report);
    const card = buildCard(c, txt, editionSlug, editionDisplayName, format, c.specialId);
    cards.push(card);
    if (!card._imageFile) report.sinImagen.push(c.name);
  }

  progress("Resolviendo imágenes…");
  const files = cards.map((c) => c._imageFile).filter(Boolean);
  const urlByFile = await resolveImageUrls(files, (done, total) =>
    progress(`Resolviendo imágenes… ${done}/${total}`));
  for (const c of cards) {
    if (c._imageFile) c.image = urlByFile.get(c._imageFile) || "";
    delete c._imageFile;
  }

  return { cards, report };
}
