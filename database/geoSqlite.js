import { logger } from "../lib/logger.js";


const DEFAULT_RADII_KM = [5, 10, 20, 50];

/** Distância em km entre dois pontos WGS84 (Haversine). */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function calculatePrice(provider, distanceMeters) {
  const distanceKm = distanceMeters / 1000;
  const base = parseFloat(provider.price_base) || 100;
  const perKm = parseFloat(provider.price_per_km) || 5;
  return Math.round((base + perKm * distanceKm) * 100) / 100;
}

function providerMatchesService(provider, serviceType) {
  if (!serviceType) return true;
  if (!provider?.services || String(provider.services).trim() === "") return true;
  return String(provider.services).toLowerCase().includes(String(serviceType).toLowerCase());
}

function minRatingOk(provider, minRating) {
  const r = provider.rating != null ? Number(provider.rating) : 5;
  return Math.round(r * 100) / 100 >= minRating;
}

/**
 * Busca prestadores próximos usando SQLite (lat/lng nas colunas).
 * Não depende de PostgreSQL/PostGIS — alinhado ao mesmo banco do servidor.
 */
export function findProvidersWithExpansionSqlite(db, { lat, lng, serviceType, minRating = 3.5, minResults = 1 }) {
  if (!db?.prepare) {
    logger.warn("findProvidersWithExpansionSqlite: db sem prepare");
    return { providers: [], radiusKm: DEFAULT_RADII_KM[DEFAULT_RADII_KM.length - 1] };
  }

  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT id, name, phone, whatsapp, services, latitude, longitude,
                rating, price_base, price_per_km, available, active
         FROM providers
         WHERE active = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL`
      )
      .all();
  } catch (err) {
    logger.error({ err }, "Erro ao listar prestadores para busca geográfica");
    return { providers: [], radiusKm: DEFAULT_RADII_KM[DEFAULT_RADII_KM.length - 1] };
  }

  const withDistance = rows
    .filter((p) => p.available !== 0 && p.available !== false)
    .filter((p) => providerMatchesService(p, serviceType))
    .filter((p) => minRatingOk(p, minRating))
    .map((p) => {
      const dKm = haversineKm(lat, lng, Number(p.latitude), Number(p.longitude));
      const meters = dKm * 1000;
      return {
        ...p,
        distance_meters: meters,
        distance_km: Math.round(dKm * 100) / 100,
        estimated_price: calculatePrice(p, meters),
      };
    })
    .sort((a, b) => a.distance_meters - b.distance_meters);

  for (const radiusKm of DEFAULT_RADII_KM) {
    const inRadius = withDistance.filter((p) => p.distance_km <= radiusKm);
    if (inRadius.length >= minResults) {
      logger.info({ radiusKm, found: inRadius.length, lat, lng }, "Prestadores encontrados (SQLite)");
      return { providers: inRadius.slice(0, 20), radiusKm };
    }
    logger.info({ radiusKm, found: inRadius.length }, "Expandindo raio de busca (SQLite)...");
  }

  logger.warn({ lat, lng, serviceType }, "Nenhum prestador encontrado em todos os raios (SQLite)");
  return { providers: [], radiusKm: DEFAULT_RADII_KM[DEFAULT_RADII_KM.length - 1] };
}
