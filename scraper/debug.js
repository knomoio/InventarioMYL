#!/usr/bin/env node
// Descarga TODOS los módulos js del amigo a ../_friend/ para portar features.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "_friend");
fs.mkdirSync(OUT, { recursive: true });

const BASE = "https://mrgerardgdj.github.io/InventarioMYL/";
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36" };
const files = [
  "js/store.js", "js/exporters.js", "js/charts.js", "js/cloud.js",
  "js/icons.js", "js/wiki-import.js",
];
for (const rel of files) {
  const r = await fetch(new URL(rel, BASE).href, { headers: H });
  const t = await r.text();
  const out = rel.split("/").pop();
  fs.writeFileSync(path.join(OUT, out), t);
  console.log(`[${r.status}] ${rel} -> _friend/${out} (${t.length} bytes)`);
}
console.log("### FIN");
