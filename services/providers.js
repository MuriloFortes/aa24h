/**
 * Cadastro e busca de prestadores.
 *  - upsertProviderByContact: insere/atualiza automaticamente ao fazer o 1º contato.
 *  - downloadProviderPhoto: baixa a foto via Google Places Photo API.
 *  - fetchPlaceDetails: detalhes (phone/place_id/foto) a partir de um place_id.
 */
import fs from "fs";
import path from "path";
import axios from "axios";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../lib/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PHOTOS_DIR = path.join(__dirname, "..", "providers-photos");

function ensurePhotosDir() {
  try {
    if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  } catch {}
}

function normPhone(p) {
  return String(p || "").replace(/\D/g, "");
}

/**
 * Busca detalhes de um place (telefone formatado, foto, endereço, location).
 */
export async function fetchPlaceDetails(placeId) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey || !placeId) return null;
  try {
    const { data } = await axios.get("https://maps.googleapis.com/maps/api/place/details/json", {
      params: {
        place_id: placeId,
        key: apiKey,
        language: "pt-BR",
        fields: "name,formatted_address,formatted_phone_number,international_phone_number,geometry,photos,rating,user_ratings_total",
      },
      timeout: 8000,
    });
    if (data?.status !== "OK") {
      logger.warn({ status: data?.status }, "Place details não OK");
      return null;
    }
    const r = data.result || {};
    return {
      name: r.name,
      address: r.formatted_address,
      phone: r.formatted_phone_number || r.international_phone_number || null,
      location: r.geometry?.location || null,
      rating: r.rating,
      totalRatings: r.user_ratings_total,
      photoReference: r.photos?.[0]?.photo_reference || null,
    };
  } catch (err) {
    logger.warn({ err: err?.message }, "Falha em fetchPlaceDetails");
    return null;
  }
}

/**
 * Baixa a foto do prestador (via photoReference) e salva em providers-photos/.
 * Retorna o caminho servido publicamente (`/providers-photos/...`) ou null.
 */
export async function downloadProviderPhoto(photoReference, { providerId, maxWidth = 600 } = {}) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey || !photoReference) return null;
  ensurePhotosDir();
  const safeId = providerId || crypto.randomBytes(6).toString("hex");
  const filename = `${safeId}.jpg`;
  const fullPath = path.join(PHOTOS_DIR, filename);
  try {
    const response = await axios.get("https://maps.googleapis.com/maps/api/place/photo", {
      params: { maxwidth: maxWidth, photoreference: photoReference, key: apiKey },
      responseType: "arraybuffer",
      timeout: 10000,
    });
    fs.writeFileSync(fullPath, response.data);
    return `/providers-photos/${filename}`;
  } catch (err) {
    logger.warn({ err: err?.message }, "Falha ao baixar foto do prestador");
    return null;
  }
}

/**
 * Insere ou atualiza prestador identificado pelo telefone (priorizado) ou placeId.
 * Retorna { id, created, photoPath } — id é o registro interno.
 */
export async function upsertProviderByContact(db, input) {
  const {
    name,
    phone,
    whatsapp,
    latitude,
    longitude,
    addressText,
    placeId,
    services,
    source,
    photoReference,
    downloadPhoto = true,
  } = input || {};

  const phoneN = normPhone(phone);
  const waN = normPhone(whatsapp || phone);

  let existing = null;
  if (placeId) {
    existing = db.prepare("SELECT * FROM providers WHERE place_id = ?").get(placeId);
  }
  if (!existing && waN) {
    existing = db
      .prepare(
        `SELECT * FROM providers
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(whatsapp, phone, ''), ' ', ''), '-', ''), '(', ''), ')', '') = ?`
      )
      .get(waN);
  }

  let photoPath = null;
  if (downloadPhoto && photoReference) {
    try {
      photoPath = await downloadProviderPhoto(photoReference, { providerId: existing?.id });
    } catch {}
  }

  if (existing) {
    const fields = [];
    const values = [];
    const pushField = (col, val) => {
      if (val != null && val !== "" && existing[col] !== val) {
        fields.push(`${col} = ?`);
        values.push(val);
      }
    };
    pushField("name", name);
    pushField("phone", phone || null);
    pushField("whatsapp", whatsapp || phone || null);
    pushField("latitude", Number.isFinite(Number(latitude)) ? Number(latitude) : null);
    pushField("longitude", Number.isFinite(Number(longitude)) ? Number(longitude) : null);
    pushField("address_text", addressText || null);
    pushField("place_id", placeId || null);
    pushField("external_source", source || null);
    pushField("services", services || null);
    if (photoPath) {
      fields.push("photo_path = ?");
      values.push(photoPath);
    }
    fields.push("last_seen_at = datetime('now')");
    if (!existing.first_contacted_at) {
      fields.push("first_contacted_at = datetime('now')");
    }
    if (fields.length > 0) {
      values.push(existing.id);
      try {
        db.prepare(`UPDATE providers SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      } catch (err) {
        logger.warn({ err }, "Falha ao atualizar prestador existente");
      }
    }
    return { id: existing.id, created: false, photoPath: photoPath || existing.photo_path || null };
  }

  const id = uuidv4();
  try {
    db.prepare(
      `INSERT INTO providers (
         id, name, phone, whatsapp, services, latitude, longitude,
         address_text, place_id, external_source, photo_path,
         first_contacted_at, last_seen_at, issues_invoice
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 1)`
    ).run(
      id,
      name || "(sem nome)",
      phone || null,
      whatsapp || phone || null,
      services || "",
      Number.isFinite(Number(latitude)) ? Number(latitude) : null,
      Number.isFinite(Number(longitude)) ? Number(longitude) : null,
      addressText || null,
      placeId || null,
      source || null,
      photoPath || null
    );
    return { id, created: true, photoPath };
  } catch (err) {
    logger.error({ err, phone: phoneN }, "Falha ao inserir prestador");
    return { id: null, created: false, photoPath: null };
  }
}

/**
 * Dado um prestador que já existe (vindo de findNearestProviders) faz o registro
 * de 1º contato: apenas atualiza last_seen_at/first_contacted_at; retorna o id.
 */
export function markProviderContacted(db, providerId) {
  if (!providerId) return;
  try {
    db.prepare(
      `UPDATE providers
         SET last_seen_at = datetime('now'),
             first_contacted_at = COALESCE(first_contacted_at, datetime('now'))
       WHERE id = ?`
    ).run(providerId);
  } catch (err) {
    logger.warn({ err, providerId }, "markProviderContacted falhou");
  }
}

export { PHOTOS_DIR };
