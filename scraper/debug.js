#!/usr/bin/env node
// Rescata y analiza la app del amigo (GitHub Pages).
const BASE = "https://mrgerardgdj.github.io/InventarioMYL/";
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36" };
const get = async (u) => { try { const r = await fetch(u, { headers: H }); return { s: r.status, ct: r.headers.get("content-type") || "", t: await r.text() }; } catch (e) { return { s: 0, t: "", err: e.message }; } };
const abs = (p) => { try { return new URL(p, BASE).href; } catch { return null; } };

const home = await get(BASE);
console.log("INDEX", home.s, "len", home.t.length);
const html = home.t;
console.log("TITLE:", (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "");
console.log("H1/H2:", [...html.matchAll(/<h[12][^>]*>([^<]+)<\/h[12]>/gi)].map((m) => m[1].trim()).slice(0, 20));
// pestañas/botones
console.log("BOTONES:", [...html.matchAll(/<button[^>]*>([^<]{1,40})<\/button>/gi)].map((m) => m[1].trim()).filter(Boolean).slice(0, 40));
console.log("NAV/TABS:", [...html.matchAll(/data-(?:tab|view|panel)=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 30));

const assets = [...new Set([
  ...[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]),
  ...[...html.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)].map((m) => m[1]),
])];
console.log("\nASSETS:", JSON.stringify(assets));

const KW = ["inventario", "inventory", "mazo", "deck", "export", "import", "csv", "excel", "scan", "camera", "camara", "qr", "chart", "grafic", "stat", "estadist", "filtro", "filter", "supabase", "firebase", "localStorage", "cloud", "sync", "sincron", "pdf", "wishlist", "falta", "precio", "price", "valor", "trade", "cambio", "dark", "tema", "theme", "login", "auth"];
for (const a of assets) {
  const u = abs(a); if (!u) continue;
  const r = await get(u);
  if (r.s !== 200) { console.log(`\n[${r.s}] ${a}`); continue; }
  const hits = KW.filter((k) => new RegExp(k, "i").test(r.t));
  const funcs = [...new Set([...r.t.matchAll(/(?:function|const|let)\s+([a-zA-Z_$][\w$]*)\s*[=(]/g)].map((m) => m[1]))].slice(0, 30);
  console.log(`\n=== ${a} (${r.t.length} bytes) ===`);
  console.log("keywords:", hits.join(", "));
  if (funcs.length) console.log("nombres:", funcs.join(", "));
}

// buscar posibles archivos de datos
console.log("\n== POSIBLES DATOS ==");
for (const p of ["data/cards.json", "cards.json", "data.json", "assets/cards.json", "js/data.json"]) {
  const r = await get(abs(p));
  console.log(`[${r.s}] ${p} len=${(r.t || "").length}` + (r.s === 200 ? " :: " + r.t.slice(0, 120).replace(/\s+/g, " ") : ""));
}
console.log("### FIN");
