#!/usr/bin/env node
// Descarga los archivos de la app del amigo a ../_friend/ para estudiarlos y portar features.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "_friend");
fs.mkdirSync(OUT, { recursive: true });

const BASE = "https://mrgerardgdj.github.io/InventarioMYL/";
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36" };
const files = [["index.html", "index.html"], ["js/app.js", "app.js"], ["css/styles.css", "styles.css"]];
for (const [rel, out] of files) {
  const r = await fetch(new URL(rel, BASE).href, { headers: H });
  const t = await r.text();
  fs.writeFileSync(path.join(OUT, out), t);
  console.log(`[${r.status}] ${rel} -> _friend/${out} (${t.length} bytes)`);
}
console.log("### FIN");
