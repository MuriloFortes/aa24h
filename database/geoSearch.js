import { db } from "./db.js";
import { logger } from "../lib/logger.js";


const DEFAULT_RADII_KM = [5, 10, 20, 50];

async function findNearbyProviders({ lat, lng, serviceType, radiusKm, minRating = 3.5, limit = 10 }) {
  const radius = (radiusKm || 5) * 1000;

  let query = `
    SELECT
      id, name, phone, whatsapp, services, latitude, longitude,
      rating, total_ratings, vehicle_types, price_base, price_per_km,
      available, active,
      ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_meters
    FROM providers
    WHERE active = true
      AND available = true
      AND location IS NOT NULL
      AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
      AND rating >= $4
  `;

  const params = [lng, lat, radius, minRating];
  let paramIdx = 5;

  if (serviceType) {
    query += ` AND services LIKE $${paramIdx}`;
    params.push(`%${serviceType}%`);
    paramIdx++;
  }

  query += ` ORDER BY distance_meters ASC LIMIT $${paramIdx}`;
  params.push(limit);

  const result = await db.getAll(query, params);

  return result.map((p) => ({
    ...p,
    distance_km: Math.round((p.distance_meters / 1000) * 100) / 100,
    estimated_price: calculatePrice(p, p.distance_meters),
  }));
}

async function findProvidersWithExpansion({ lat, lng, serviceType, minRating = 3.5, minResults = 1 }) {
  for (const radiusKm of DEFAULT_RADII_KM) {
    const providers = await findNearbyProviders({
      lat, lng, serviceType, radiusKm, minRating,
    });

    if (providers.length >= minResults) {
      logger.info({ radiusKm, found: providers.length, lat, lng }, "Prestadores encontrados");
      return { providers, radiusKm };
    }

    logger.info({ radiusKm, found: providers.length }, "Expandindo raio de busca...");
  }

  logger.warn({ lat, lng, serviceType }, "Nenhum prestador encontrado em todos os raios");
  return { providers: [], radiusKm: DEFAULT_RADII_KM[DEFAULT_RADII_KM.length - 1] };
}

function calculatePrice(provider, distanceMeters) {
  const distanceKm = distanceMeters / 1000;
  const base = parseFloat(provider.price_base) || 100;
  const perKm = parseFloat(provider.price_per_km) || 5;
  return Math.round((base + perKm * distanceKm) * 100) / 100;
}

async function updateProviderLocation(providerId, lat, lng) {
  await db.run(
    `UPDATE providers SET latitude = $1, longitude = $2, last_seen_at = NOW() WHERE id = $3`,
    [lat, lng, providerId]
  );
}

async function setProviderAvailability(providerId, available) {
  await db.run(
    `UPDATE providers SET available = $1 WHERE id = $2`,
    [available, providerId]
  );
}

export {
  findNearbyProviders,
  findProvidersWithExpansion,
  updateProviderLocation,
  setProviderAvailability,
  calculatePrice,
};
