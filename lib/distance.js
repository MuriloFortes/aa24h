/**
 * Cálculo de distância via Google Distance Matrix API com fallback Haversine.
 * Aceita coordenadas ({lat, lng}) ou strings (endereço livre).
 */
import axios from "axios";
import { logger } from "./logger.js";


const GOOGLE_API_BASE = "https://maps.googleapis.com/maps/api/distancematrix/json";
const GOOGLE_PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

function toLatLngString(point) {
  if (!point) return null;
  if (typeof point === "string") return point.trim();
  if (typeof point === "object" && Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
    return `${point.lat},${point.lng}`;
  }
  return null;
}

function haversineKm(origin, destination) {
  if (!origin || !destination) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const lat1 = Number(origin.lat);
  const lng1 = Number(origin.lng);
  const lat2 = Number(destination.lat);
  const lng2 = Number(destination.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calcula distância por rota real (metros/min) via Google Distance Matrix.
 * Retorna { km, durationMin, source }.
 */
export async function calculateDistance({ origin, destination }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  const originStr = toLatLngString(origin);
  const destStr = toLatLngString(destination);
  if (!originStr || !destStr) {
    return { km: null, durationMin: null, source: "invalid_input", error: "origin/destination inválidos" };
  }

  if (apiKey) {
    try {
      const { data } = await axios.get(GOOGLE_API_BASE, {
        params: {
          origins: originStr,
          destinations: destStr,
          key: apiKey,
          mode: "driving",
          language: "pt-BR",
          region: "br",
        },
        timeout: 8000,
      });
      const el = data?.rows?.[0]?.elements?.[0];
      if (data?.status === "OK" && el?.status === "OK") {
        const km = el.distance?.value / 1000;
        const durationMin = Math.round((el.duration?.value || 0) / 60);
        return { km, durationMin, source: "google", raw: el };
      }
      logger.warn({ status: data?.status, elStatus: el?.status }, "Google Distance Matrix retornou erro");
    } catch (err) {
      logger.warn({ err: err?.message }, "Falha ao consultar Google Distance Matrix, caindo no Haversine");
    }
  }

  const km = haversineKm(origin, destination);
  if (km == null) {
    return { km: null, durationMin: null, source: "unavailable", error: "sem coordenadas para fallback" };
  }
  const durationMin = Math.round((km / 50) * 60);
  return { km, durationMin, source: "haversine" };
}

/**
 * Geocoding reverso opcional: transforma texto em coordenadas.
 * Requer GOOGLE_MAPS_API_KEY. Retorna { lat, lng } ou null.
 */
export async function geocodeAddress(text) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey || !text) return null;
  try {
    const { data } = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address: text,
        key: apiKey,
        region: "br",
        language: "pt-BR",
        components: "country:BR",
      },
      timeout: 8000,
    });
    const loc = data?.results?.[0]?.geometry?.location;
    if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) return { lat: loc.lat, lng: loc.lng };
  } catch (err) {
    logger.warn({ err: err?.message }, "Falha no geocoding");
  }
  return null;
}

/**
 * Busca prestadores externos (tow trucks) via Google Places nearbysearch.
 * Útil como complemento ao banco local. Retorna [{ name, phone?, location, placeId, rating, distance_km }].
 */
/**
 * Palavra-chave usada no Places Nearby Search conforme o tipo de serviço.
 */
export function keywordForServiceType(serviceType) {
  const s = String(serviceType || "").toLowerCase().trim();
  const map = {
    reboque: "reboque guincho automotivo",
    pane_mecanica: "reboque guincho",
    pane_eletrica: "reboque guincho",
    acidente: "reboque guincho",
    chaveiro: "chaveiro veicular 24h",
    carga_bateria: "socorro bateria veículo",
    troca_pneu: "troca de pneu veicular",
    combustivel: "combustível emergência veículo",
    pneu_furado: "troca de pneu veicular",
    sem_combustivel: "combustível emergência veículo",
    bateria_descarregada: "socorro bateria veículo",
  };
  if (map[s]) return map[s];
  if (s) return `${s} guincho serviço veicular`;
  return "reboque guincho";
}

function mapNearbyResults(lat, lng, data) {
  const results = (data.results || []).map((r) => ({
    name: r.name,
    placeId: r.place_id,
    location: r.geometry?.location,
    rating: r.rating,
    totalRatings: r.user_ratings_total,
    distance_km: haversineKm({ lat, lng }, r.geometry?.location),
    vicinity: r.vicinity,
    external: true,
  }));
  return results.sort((a, b) => (a.distance_km ?? 99) - (b.distance_km ?? 99));
}

export async function searchNearbyTowProviders({ lat, lng, radiusMeters = 15000, keyword = "reboque guincho" }) {
  const { results } = await searchNearbyTowProvidersDebug({ lat, lng, radiusMeters, keyword });
  return results;
}

/**
 * Mesma busca que searchNearbyTowProviders, mas retorna metadados da API (para painel de acompanhamento).
 */
export async function searchNearbyTowProvidersDebug({ lat, lng, radiusMeters = 15000, keyword = "reboque guincho" }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  const radius = Math.min(radiusMeters, 50000);
  const debug = {
    api: "place/nearbysearch",
    requestedAt: new Date().toISOString(),
    keyword,
    location: { lat, lng },
    radiusMeters: radius,
    status: null,
    errorMessage: null,
    resultCount: 0,
    nextPageToken: null,
    resultsPreview: [],
  };
  if (!apiKey || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    debug.errorMessage = !apiKey ? "GOOGLE_MAPS_API_KEY não configurada" : "coordenadas inválidas";
    return { results: [], debug };
  }
  try {
    const { data } = await axios.get(`${GOOGLE_PLACES_BASE}/nearbysearch/json`, {
      params: {
        location: `${lat},${lng}`,
        radius,
        keyword,
        key: apiKey,
        language: "pt-BR",
      },
      timeout: 8000,
    });
    debug.status = data?.status;
    debug.nextPageToken = data?.next_page_token || null;
    if (data?.status !== "OK" && data?.status !== "ZERO_RESULTS") {
      logger.warn({ status: data?.status }, "Google Places nearbysearch retornou erro");
      debug.errorMessage = `API status: ${data?.status}`;
      return { results: [], debug };
    }
    const results = mapNearbyResults(lat, lng, data);
    debug.resultCount = results.length;
    debug.resultsPreview = results.slice(0, 25).map((r) => ({
      name: r.name,
      placeId: r.placeId,
      vicinity: r.vicinity,
      rating: r.rating,
      distance_km: r.distance_km != null ? Number(r.distance_km.toFixed(3)) : null,
    }));
    return { results, debug };
  } catch (err) {
    debug.errorMessage = err?.message || String(err);
    logger.warn({ err: err?.message }, "Falha ao buscar prestadores externos");
    return { results: [], debug };
  }
}

/**
 * Geocoding com metadados (para painel).
 */
export async function geocodeAddressDebug(text) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!text?.trim()) {
    return { coords: null, debug: { input: text, error: "texto vazio" } };
  }
  if (!apiKey) {
    return { coords: null, debug: { input: text, error: "GOOGLE_MAPS_API_KEY não configurada" } };
  }
  try {
    const { data } = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: {
        address: text,
        key: apiKey,
        region: "br",
        language: "pt-BR",
        components: "country:BR",
      },
      timeout: 8000,
    });
    const result = data?.results?.[0];
    const loc = result?.geometry?.location;
    const coords =
      loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) ? { lat: loc.lat, lng: loc.lng } : null;
    return {
      coords,
      debug: {
        input: text,
        status: data?.status,
        formatted_address: result?.formatted_address,
        place_id: result?.place_id,
      },
    };
  } catch (err) {
    return { coords: null, debug: { input: text, error: err?.message } };
  }
}

/**
 * Distance Matrix com metadados (para painel).
 */
export async function calculateDistanceDebug({ origin, destination }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  const originStr = toLatLngString(origin);
  const destStr = toLatLngString(destination);
  const debug = {
    api: "distancematrix",
    requestedAt: new Date().toISOString(),
    origins: originStr,
    destinations: destStr,
    responseStatus: null,
    elementStatus: null,
    fallback: null,
  };
  if (!originStr || !destStr) {
    return {
      km: null,
      durationMin: null,
      source: "invalid_input",
      error: "origin/destination inválidos",
      debug: { ...debug, error: "invalid_input" },
    };
  }
  if (apiKey) {
    try {
      const { data } = await axios.get(GOOGLE_API_BASE, {
        params: {
          origins: originStr,
          destinations: destStr,
          key: apiKey,
          mode: "driving",
          language: "pt-BR",
          region: "br",
        },
        timeout: 8000,
      });
      debug.responseStatus = data?.status;
      const el = data?.rows?.[0]?.elements?.[0];
      debug.elementStatus = el?.status;
      if (data?.status === "OK" && el?.status === "OK") {
        const km = el.distance?.value / 1000;
        const durationMin = Math.round((el.duration?.value || 0) / 60);
        return { km, durationMin, source: "google", raw: el, debug };
      }
    } catch (err) {
      debug.fallback = err?.message;
    }
  }
  const km = haversineKm(origin, destination);
  if (km == null) {
    return {
      km: null,
      durationMin: null,
      source: "unavailable",
      error: "sem coordenadas para fallback",
      debug: { ...debug, fallback: "haversine_failed" },
    };
  }
  const durationMin = Math.round((km / 50) * 60);
  return {
    km,
    durationMin,
    source: "haversine",
    debug: { ...debug, fallback: "haversine" },
  };
}

export { haversineKm };
