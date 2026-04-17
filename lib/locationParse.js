/**
 * Extrai latitude/longitude de textos comuns no WhatsApp e em endereços livres.
 * Evita depender só do Geocoding (API) quando o cliente já enviou coordenadas.
 */

/** Aceita vírgula ou ponto-e-vírgula entre os graus (ex.: [Localização: -23.3; -51.1]) */
const RE_BRACKET = /\[Localiza[çc][ãa]o:\s*(-?\d+(?:[.,]\d+)?)\s*[,;]\s*(-?\d+(?:[.,]\d+)?)\]/gi;
const RE_LATLNG_LINE = /(-?\d+(?:[.,]\d+)?)\s*[,;]\s*(-?\d+(?:[.,]\d+)?)/;

/**
 * Corrige ordem (lat,lng) vs (lng,lat) comum em GIS e em erros de digitação no Brasil.
 * Faixa aproximada Brasil: lat −35…5, lng −75…−28.
 */
export function normalizeBrazilLatLng(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  const inLatBr = (a) => a >= -35 && a <= 5;
  const inLngBr = (a) => a >= -75 && a <= -28;
  if (inLatBr(la) && inLngBr(ln)) return { lat: la, lng: ln, swapped: false };
  if (inLatBr(ln) && inLngBr(la)) return { lat: ln, lng: la, swapped: true };
  return { lat: la, lng: ln, swapped: false };
}

/**
 * @param {string} text
 * @returns {{ lat: number, lng: number } | null}
 */
export function extractLatLngFromText(text) {
  if (!text || typeof text !== "string") return null;
  const t = text.trim();
  let m = null;
  const bracketMatches = [...t.matchAll(RE_BRACKET)];
  if (bracketMatches.length > 0) {
    m = bracketMatches[bracketMatches.length - 1];
  }
  if (!m && /localiza[çc]/i.test(t)) {
    m = t.match(RE_LATLNG_LINE);
  }
  if (!m) {
    m = t.match(RE_LATLNG_LINE);
  }
  if (!m) return null;
  const lat = parseFloat(String(m[1]).replace(",", "."));
  const lng = parseFloat(String(m[2]).replace(",", "."));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const norm = normalizeBrazilLatLng(lat, lng);
  if (!norm) return null;
  return { lat: norm.lat, lng: norm.lng };
}

/**
 * Converte possíveis valores de lat/lng (evita Number(null) === 0).
 * @returns {{ lat: number, lng: number } | null}
 */
export function coerceLatLng(lat, lng) {
  if (lat == null || lng === undefined) return null;
  if (lat === "" || lng === "") return null;
  const la = typeof lat === "number" ? lat : parseFloat(String(lat).replace(",", "."));
  const ln = typeof lng === "number" ? lng : parseFloat(String(lng).replace(",", "."));
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la === 0 && ln === 0) return null;
  const norm = normalizeBrazilLatLng(la, ln);
  if (!norm) return null;
  return { lat: norm.lat, lng: norm.lng };
}

/**
 * Links para abrir o Google Maps no navegador com busca por serviço perto de um ponto (sem API).
 * @param {number} lat
 * @param {number} lng
 * @param {string[]} keywords
 */
export function buildGoogleMapsManualSearchLinks(lat, lng, keywords) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const base = `https://www.google.com/maps/search`;
  const queries = keywords.length
    ? keywords
    : ["reboque guincho", "auto socorro 24 horas", "guincho"];
  return queries.map((q) => ({
    keyword: q,
    url: `${base}/${encodeURIComponent(q)}/@${lat},${lng},14z`,
  }));
}
