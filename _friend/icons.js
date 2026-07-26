// Íconos (emoji) por tipo y raza, compartidos por la app y los exportadores.
export const TYPE_ICON = {
  "Aliado": "🛡️", "Arma": "⚔️", "Talismán": "✨", "Tótem": "🗿",
  "Oro": "🪙", "Monumento": "🏛️", "Otro": "🃏", "—": "🃏",
};
export const RACE_ICON = {
  "Guerrero": "🗡️", "Héroe": "🦸", "Dragón": "🐉", "Bestia": "🐾", "Eterno": "⚡",
  "Faerie": "🧚", "Olímpico": "🏛️", "Sombra": "🌑", "Sacerdote": "🙏", "Caballero": "🐎",
  "Faraón": "🏺", "Titán": "🗻", "Bárbaro": "🪓", "Defensor": "🛡️", "Desafiante": "🎯",
  "Vampiro": "🧛", "Licántropo": "🐺", "Samurái": "🥷", "Kami": "⛩️", "Oni": "👹",
  "Dios": "🔱", "Sirena": "🧜", "Cazador": "🏹", "Sacerdotisa": "🙏", "Chamán": "🪶",
  "Paladín": "✝️", "Asesino": "🗡️", "Abominación": "🧟", "Ancestral": "🗿", "Campeón": "🏆",
  "Sin Raza": "▫️", "Criaturas": "🐾", "Xian": "🐲", "Tenebris": "🌑",
};
export function typeIcon(t) { return TYPE_ICON[t] || "🃏"; }
export function raceIcon(r) {
  if (RACE_ICON[r]) return RACE_ICON[r];
  const first = String(r || "").split("/")[0].trim();
  return RACE_ICON[first] || "";
}
// Tipos que NO tienen Fuerza en MyL (solo los Aliados —y Armas como bonus— la tienen)
export const NO_STRENGTH_TYPES = new Set(["Talismán", "Tótem", "Oro", "Monumento"]);
