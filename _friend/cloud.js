// Sincronización opcional en la nube usando Supabase (carga perezosa).
// Modelo: un registro por "clave" con todo el inventario + mazos, y un
// historial lineal de guardados. La reconciliación se basa en si la fila
// cambió en la nube desde la última vez que este dispositivo la vio
// (independiente del reloj de cada equipo).
import { loadScript, CDN } from "./cdn.js";

const KEY = "myl.cloud.v1";       // configuración (url, key, clave, device)
const SYNC = "myl.syncstate.v1";  // estado de sync (lastServerTs, dirty)
const TABLE = "inventario_myl";
const LOG = "inventario_myl_log";

let cfg = read(KEY, {});
let sync = read(SYNC, { lastServerTs: "", dirty: false });
let sb = null;

function read(k, fb) { try { return JSON.parse(localStorage.getItem(k)) || fb; } catch { return fb; } }
function writeSync() { localStorage.setItem(SYNC, JSON.stringify(sync)); }

export function getConfig() { return { ...cfg }; }
export function isConfigured() { return !!(cfg.url && cfg.key && cfg.clave); }
export function setConfig(c) {
  cfg = {
    url: (c.url || "").trim().replace(/\/$/, ""),
    key: (c.key || "").trim(),
    clave: (c.clave || "").trim(),
    device: (c.device || "").trim() || "dispositivo",
  };
  localStorage.setItem(KEY, JSON.stringify(cfg));
  sb = null;
}
export function disconnect() { cfg = {}; localStorage.removeItem(KEY); sync = { lastServerTs: "", dirty: false }; writeSync(); sb = null; }

// Estado de sincronización
export function getLastTs() { return sync.lastServerTs || ""; }
export function setLastTs(ts) { sync.lastServerTs = ts || ""; writeSync(); }
export function isDirty() { return !!sync.dirty; }
export function markDirty() { sync.dirty = true; writeSync(); }
export function clearDirty() { sync.dirty = false; writeSync(); }

async function client() {
  if (!isConfigured()) throw new Error("Sincronización no configurada");
  if (sb) return sb;
  await loadScript(CDN.supabase);
  sb = window.supabase.createClient(cfg.url, cfg.key);
  return sb;
}

// Descarga el snapshot remoto (o null si no existe).
export async function pull() {
  const c = await client();
  const { data, error } = await c.from(TABLE).select("datos,actualizado").eq("clave", cfg.clave).maybeSingle();
  if (error) throw new Error(error.message || "Error al leer de la nube");
  if (!data) return null;
  return { snapshot: data.datos, actualizado: data.actualizado };
}

// Sube el snapshot completo y devuelve la marca 'actualizado' guardada.
// Además registra una línea en el historial (si la tabla existe).
export async function push(snapshot, { accion = "auto", copias = 0 } = {}) {
  const c = await client();
  const { data, error } = await c.from(TABLE)
    .upsert({ clave: cfg.clave, datos: snapshot, actualizado: new Date().toISOString() }, { onConflict: "clave" })
    .select("actualizado").single();
  if (error) throw new Error(error.message || "Error al guardar en la nube");
  // Historial (best-effort: si la tabla no existe, se ignora)
  try {
    await c.from(LOG).insert({ clave: cfg.clave, dispositivo: cfg.device || "dispositivo", accion, copias });
  } catch {}
  return data?.actualizado || "";
}

// Tiempo real: avisa cuando la fila de esta 'clave' cambia en la nube.
let channel = null;
export async function subscribeRealtime(cb) {
  const c = await client();
  if (channel) { try { c.removeChannel(channel); } catch {} channel = null; }
  channel = c.channel("inv-" + cfg.clave)
    .on("postgres_changes",
      { event: "*", schema: "public", table: TABLE, filter: `clave=eq.${cfg.clave}` },
      (payload) => {
        const row = payload.new || {};
        if (row.datos) cb({ snapshot: row.datos, actualizado: row.actualizado });
      })
    .subscribe();
  return channel;
}
export function unsubscribeRealtime() {
  if (sb && channel) { try { sb.removeChannel(channel); } catch {} channel = null; }
}

// Lee el historial lineal (más reciente primero). Devuelve null si no está disponible.
export async function getLog(limit = 30) {
  try {
    const c = await client();
    const { data, error } = await c.from(LOG).select("*").eq("clave", cfg.clave).order("id", { ascending: false }).limit(limit);
    if (error) return null;
    return data;
  } catch { return null; }
}
