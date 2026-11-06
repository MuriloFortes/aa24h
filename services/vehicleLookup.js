/**
 * Consulta de veículo por placa (API Brasil — Base Nacional V2).
 * Docs: https://doc.apibrasil.io (gateway.apibrasil.io)
 *
 * Env:
 *   APIBRASIL_TOKEN          Bearer token (obrigatório para consultas reais)
 *   APIBRASIL_HOMOLOG=true   usa base de homologação (sem cobrança)
 *   APIBRASIL_TIMEOUT_MS     timeout HTTP (padrão 12000)
 *   VEHICLE_LOOKUP_DISABLED  true = nunca chama a API
 */
import axios from "axios";
import { logger } from "../lib/logger.js";
import { normalizeBrazilianPlate } from "../lib/plate.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _cache = new Map();

function cacheGet(plate) {
  const hit = _cache.get(plate);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    _cache.delete(plate);
    return null;
  }
  return hit.value;
}

function cacheSet(plate, value) {
  _cache.set(plate, { at: Date.now(), value });
  if (_cache.size > 500) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

export function isVehicleLookupConfigured() {
  if (process.env.VEHICLE_LOOKUP_DISABLED === "true") return false;
  // Homolog ainda exige Bearer válido; só não cobra a consulta.
  return !!(process.env.APIBRASIL_TOKEN || "").trim();
}

/**
 * Normaliza marca/modelo a partir do payload da API Brasil.
 * @returns {{ ok: boolean, plate: string, vehicle_type?: string, brand?: string, model?: string, year?: string, color?: string, rawType?: string, error?: string, source?: string }}
 */
export function parseApiBrasilVehicle(data, plate) {
  if (!data || typeof data !== "object") {
    return { ok: false, plate, error: "payload_vazio" };
  }
  const marcaModelo = String(data.marcaModelo || data.marca_modelo || "").trim();
  let brand = "";
  let model = marcaModelo;
  if (marcaModelo.includes("/")) {
    const [b, ...rest] = marcaModelo.split("/");
    brand = b.trim();
    model = rest.join("/").trim() || marcaModelo;
  }
  const year =
    String(data.anoModelo || data.anoFabricacao || data.baseNacional?.anoModelo || "").trim() ||
    undefined;
  const color = String(data.corVeiculo || data.baseNacional?.cor || "")
    .replace(/^\d+\s*-\s*/, "")
    .trim() || undefined;
  const rawType = String(data.tipoVeiculo || data.baseNacional?.tipoVeiculo || "").trim() || undefined;

  const labelParts = [brand, model].filter(Boolean);
  if (year) labelParts.push(year);
  const vehicle_type = labelParts.join(" ").trim() || rawType || undefined;

  if (!vehicle_type) {
    return { ok: false, plate, error: "sem_marca_modelo", source: "apibrasil" };
  }

  return {
    ok: true,
    plate,
    vehicle_type,
    brand: brand || undefined,
    model: model || undefined,
    year,
    color,
    rawType,
    source: "apibrasil",
  };
}

/**
 * Consulta placa. Nunca faz retry automático em 4xx (cobrança).
 */
export async function lookupVehicleByPlate(rawPlate) {
  const plate = normalizeBrazilianPlate(rawPlate);
  if (!plate || plate.length !== 7) {
    return { ok: false, plate, error: "placa_invalida" };
  }

  if (process.env.VEHICLE_LOOKUP_DISABLED === "true") {
    return { ok: false, plate, error: "disabled" };
  }

  const cached = cacheGet(plate);
  if (cached) return { ...cached, cached: true };

  const token = (process.env.APIBRASIL_TOKEN || "").trim();
  const homolog = process.env.APIBRASIL_HOMOLOG === "true";
  if (!token) {
    return { ok: false, plate, error: "not_configured" };
  }

  const timeout = Number.parseInt(String(process.env.APIBRASIL_TIMEOUT_MS || "12000"), 10) || 12000;
  const url = "https://gateway.apibrasil.io/api/v2/consulta/veiculos/credits";

  try {
    const response = await axios.post(
      url,
      {
        tipo: "base-nacional-v2",
        placa: plate,
        ...(homolog ? { homolog: true } : {}),
      },
      {
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout,
        validateStatus: () => true,
      }
    );

    if (response.status === 402) {
      logger.error({ plate }, "API Brasil: saldo insuficiente (402)");
      return { ok: false, plate, error: "saldo_insuficiente" };
    }

    if (response.status >= 500) {
      logger.warn({ plate, status: response.status }, "API Brasil: erro de servidor");
      return { ok: false, plate, error: "upstream_5xx" };
    }

    if (response.status >= 400) {
      logger.warn({ plate, status: response.status, body: response.data }, "API Brasil: erro cliente");
      return { ok: false, plate, error: `http_${response.status}` };
    }

    const body = response.data || {};
    if (body.error === true) {
      logger.warn({ plate, message: body.message }, "API Brasil: error=true no body");
      return { ok: false, plate, error: body.message || "api_error" };
    }

    const parsed = parseApiBrasilVehicle(body.data || body, plate);
    if (parsed.ok) cacheSet(plate, parsed);
    return parsed;
  } catch (err) {
    logger.warn({ err: err?.message, plate }, "API Brasil: falha de rede/timeout");
    return { ok: false, plate, error: "network" };
  }
}

/** Patch para collectedData do attendant. */
export function vehicleLookupToCollectedPatch(result) {
  if (!result?.ok) return {};
  const patch = {
    vehicle_type: result.vehicle_type,
  };
  if (result.brand) patch.vehicle_brand = result.brand;
  if (result.model) patch.vehicle_model = result.model;
  if (result.year) patch.vehicle_year = result.year;
  if (result.color) patch.vehicle_color = result.color;
  if (result.source) patch.vehicle_lookup_source = result.source;
  return patch;
}
