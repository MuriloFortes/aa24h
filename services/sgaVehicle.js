import axios from "axios";
import { logger } from "../lib/logger.js";
import { buildPlateVariantsForSgaRequest } from "../lib/plate.js";

let cachedUserToken = null;
/** Uma autenticação por vez — novo login invalida o token anterior no SGA Hinova */
let authRefreshPromise = null;

/**
 * Mensagens fixas para o cliente (WhatsApp / chat).
 */
export const SGA_CLIENT_MSG = {
  not_found:
    "⚠️ Não foi possível localizar o veículo na base da proteção veicular. Entre em contato com a central.",
  inactive:
    "⚠️ O veículo está inativo na proteção veicular. Entre em contato com a associação.",
  error:
    "⚠️ Não foi possível consultar a proteção veicular no momento. Tente novamente ou entre em contato com a central.",
  not_configured:
    "⚠️ Validação da proteção veicular não está disponível no momento. Entre em contato com a central.",
};

/**
 * Verifica se o veículo está ATIVO na API SGA (proteção veicular).
 *
 * Variáveis de ambiente:
 * - SGA_API_BASE_URL — URL base (ex.: https://api.exemplo.com)
 * - SGA_API_KEY — token Bearer
 * - SGA_VEHICLE_PATH — path (padrão: /buscar/situacao-veiculo/:placaOuChassi)
 * - SGA_ACTIVE_STATUS_CODES — códigos considerados ATIVOS (padrão: 1,9 — Hinova costuma usar 1=ATIVO)
 * - SGA_SKIP_VEHICLE_VERIFY — se "true", pula a chamada (apenas desenvolvimento)
 *
 * Hinova: cada novo /usuario/autenticar invalida o token_usuario anterior. O módulo serializa
 * autenticações e, em 401/403 na consulta do veículo, força nova autenticação e atualiza o cache.
 *
 * Contrato oficial SGA (informado):
 * GET /buscar/situacao-veiculo/:placaOuChassi
 * 200: { codigo_veiculo, placa, chassi, codigo_situacao }
 */
export async function verifyVehicleActiveInSga(plateRaw, _phoneRaw) {
  const skip = process.env.SGA_SKIP_VEHICLE_VERIFY === "true";
  if (skip) {
    logger.warn("SGA: verificação de veículo ignorada (SGA_SKIP_VEHICLE_VERIFY=true)");
    return { ok: true, skipped: true };
  }

  const base = (process.env.SGA_API_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) {
    logger.error("SGA_API_BASE_URL não configurada");
    return { ok: false, reason: "not_configured", clientMessage: SGA_CLIENT_MSG.not_configured };
  }

  const pathTemplate = (process.env.SGA_VEHICLE_PATH || "/buscar/situacao-veiculo/:placaOuChassi").trim();

  const compactFallback = String(plateRaw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const variants = buildPlateVariantsForSgaRequest(plateRaw);
  const segments =
    variants.length > 0
      ? variants
      : compactFallback.length >= 7
        ? [compactFallback.slice(0, 7)]
        : compactFallback
          ? [compactFallback]
          : [];

  if (segments.length === 0) {
    return { ok: false, reason: "not_found", clientMessage: SGA_CLIENT_MSG.not_found };
  }

  const token0 = await getSgaAccessToken(base);
  if (!token0) {
    logger.error("SGA: token de acesso indisponível");
    return { ok: false, reason: "not_configured", clientMessage: SGA_CLIENT_MSG.not_configured };
  }

  let lastResult = {
    ok: false,
    reason: "not_found",
    clientMessage: SGA_CLIENT_MSG.not_found,
  };

  try {
    for (const segment of segments) {
      const encodedPlate = encodeURIComponent(segment);
      const resolvedPath = pathTemplate
        .replace(":placaOuChassi", encodedPlate)
        .replace("{placaOuChassi}", encodedPlate);
      const url = resolvedPath.startsWith("http")
        ? resolvedPath
        : `${base}${resolvedPath.startsWith("/") ? "" : "/"}${resolvedPath}`;

      const { data, status, authFailed } = await fetchVehicleSituationOnce(url, base);
      if (authFailed) {
        return { ok: false, reason: "error", clientMessage: SGA_CLIENT_MSG.error };
      }

      if (status === 404) {
        lastResult = { ok: false, reason: "not_found", clientMessage: SGA_CLIENT_MSG.not_found };
        continue;
      }

      if (status >= 500) {
        lastResult = { ok: false, reason: "error", clientMessage: SGA_CLIENT_MSG.error };
        continue;
      }

      const parsed = parseSgaVehicleResponse(data, status);
      lastResult = parsed;

      if (process.env.SGA_DEBUG === "true") {
        const d = pickPayload(typeof data === "object" ? data : {});
        const cs = normalizeSgaSituationCode(d.codigo_situacao ?? d.codigoSituacao ?? d.situacao_codigo);
        const allow = String(process.env.SGA_ACTIVE_STATUS_CODES || "1,9")
          .split(",")
          .map((s) => cleanStatus(s))
          .filter(Boolean);
        logger.info(
          {
            segmento_url: segment,
            codigo_situacao: cs || null,
            SGA_ACTIVE_STATUS_CODES: allow,
            resultado: parsed,
          },
          "SGA: tentativa de variante de placa (SGA_DEBUG=true)"
        );
      }

      if (parsed.ok) {
        return parsed;
      }
      if (parsed.reason === "inactive" || parsed.reason === "not_found") {
        continue;
      }
      if (parsed.reason === "error") {
        continue;
      }
    }

    return lastResult;
  } catch (err) {
    logger.error({ err: err.message }, "SGA: falha na requisição de verificação de veículo");
    return { ok: false, reason: "error", clientMessage: SGA_CLIENT_MSG.error };
  }
}

/**
 * GET situação do veículo com retry de token em 401/403.
 * @returns {{ data: unknown, status: number, authFailed?: boolean }}
 */
async function fetchVehicleSituationOnce(url, base) {
  let token = await getSgaAccessToken(base);
  if (!token) {
    return { data: null, status: 0, authFailed: true };
  }

  let response = await axios.get(url, {
    headers: buildVehicleHeaders(token),
    timeout: Number(process.env.SGA_TIMEOUT_MS || 20000),
    validateStatus: () => true,
  });
  let { data, status } = response;

  if (status === 401 || status === 403) {
    logger.warn(
      { status },
      "SGA: token rejeitado na consulta — obtendo novo token_usuario e repetindo uma vez"
    );
    token = await getSgaAccessToken(base, { forceRefresh: true });
    if (!token) {
      logger.error("SGA: reautenticação falhou após 401/403");
      return { data: null, status, authFailed: true };
    }
    response = await axios.get(url, {
      headers: buildVehicleHeaders(token),
      timeout: Number(process.env.SGA_TIMEOUT_MS || 20000),
      validateStatus: () => true,
    });
    data = response.data;
    status = response.status;
    if (status === 401 || status === 403) {
      logger.error({ status }, "SGA: consulta ainda não autorizada após renovar token");
      clearSgaTokenCache();
      return { data, status, authFailed: true };
    }
  }

  return { data, status, authFailed: false };
}

/**
 * @param {string} baseUrl
 * @param {{ forceRefresh?: boolean }} [options] — se true, descarta token em cache e obtém novo token_usuario (novo login invalida o anterior no SGA).
 */
async function getSgaAccessToken(baseUrl, options = {}) {
  const { forceRefresh = false } = options;

  const user = (process.env.SGA_AUTH_USER || "").trim();
  const pass = (process.env.SGA_AUTH_PASSWORD || "").trim();

  /**
   * Compatibilidade: se não houver usuário/senha, usa SGA_API_KEY direto como token de acesso.
   * Recomendado: configurar SGA_AUTH_USER/SGA_AUTH_PASSWORD para obter token_usuario.
   */
  if (!user || !pass) {
    const direct = (process.env.SGA_API_KEY || "").trim();
    if (direct) return direct;
    return null;
  }

  if (!forceRefresh && cachedUserToken) return cachedUserToken;

  if (authRefreshPromise) {
    await authRefreshPromise;
    if (cachedUserToken) return cachedUserToken;
  }

  if (forceRefresh) {
    clearSgaTokenCache();
    logger.info("SGA: cache de token_usuario limpo — nova autenticação (token anterior invalidado no SGA)");
  }

  if (cachedUserToken) return cachedUserToken;

  if (!authRefreshPromise) {
    authRefreshPromise = fetchSgaUserToken(baseUrl).finally(() => {
      authRefreshPromise = null;
    });
  }

  return authRefreshPromise;
}

async function fetchSgaUserToken(baseUrl) {
  const user = (process.env.SGA_AUTH_USER || "").trim();
  const pass = (process.env.SGA_AUTH_PASSWORD || "").trim();
  const authPath = (process.env.SGA_AUTH_PATH || "/usuario/autenticar").trim();
  const authUrl = authPath.startsWith("http")
    ? authPath
    : `${baseUrl}${authPath.startsWith("/") ? "" : "/"}${authPath}`;
  const associationToken = (process.env.SGA_API_KEY || "").trim();
  if (!associationToken) {
    logger.error("SGA_API_KEY não configurada para autenticação do usuário");
    return null;
  }

  try {
    const { data, status } = await axios.post(
      authUrl,
      { usuario: user, senha: pass },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${associationToken}`,
        },
        timeout: Number(process.env.SGA_TIMEOUT_MS || 20000),
        validateStatus: () => true,
      }
    );

    if (status === 401 || status === 403) {
      logger.error({ status, data }, "SGA: autenticação recusada (Bearer da associação ou credenciais)");
      return null;
    }

    if (status >= 400) {
      logger.error({ status, data }, "SGA: falha ao autenticar usuário");
      return null;
    }

    const tokenUsuario = String(data?.token_usuario || "").trim();
    if (!tokenUsuario) {
      logger.error({ data }, "SGA: resposta de autenticação sem token_usuario");
      return null;
    }

    cachedUserToken = tokenUsuario;
    logger.info("SGA: token_usuario obtido e armazenado");
    return cachedUserToken;
  } catch (err) {
    logger.error({ err: err.message }, "SGA: erro ao autenticar usuário");
    return null;
  }
}

function buildVehicleHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function clearSgaTokenCache() {
  cachedUserToken = null;
}

function pickPayload(data) {
  if (!data || typeof data !== "object") return {};
  return (
    data.data ||
    data.result ||
    data.response ||
    data.veiculo ||
    data.vehicle ||
    data.payload ||
    data
  );
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["true", "1", "sim", "yes", "y", "ativo", "ativa", "active"].includes(s)) return true;
    if (["false", "0", "nao", "não", "no", "n", "inativo", "inativa", "inactive"].includes(s)) return false;
  }
  return null;
}

function cleanStatus(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** "1", "09", 9 → "1" / "9" para comparar com SGA_ACTIVE_STATUS_CODES */
function normalizeSgaSituationCode(value) {
  const s = cleanStatus(value);
  if (!s) return "";
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s;
}

function parseSgaVehicleResponse(data, httpStatus) {
  if (data == null) {
    return { ok: false, reason: "error", clientMessage: SGA_CLIENT_MSG.error };
  }

  const d = pickPayload(typeof data === "object" ? data : {});

  const foundFlags = [d.encontrado, d.found, d.exists, d.localizado, d.existe];
  if (foundFlags.some((f) => toBool(f) === false)) {
    return { ok: false, reason: "not_found", clientMessage: SGA_CLIENT_MSG.not_found };
  }

  const code = cleanStatus(d.codigo || d.code || d.errorCode || d.erro);
  if (
    code.includes("NAO_ENCONTRADO") ||
    code.includes("NÃO_ENCONTRADO") ||
    code.includes("VEICULO_NAO_ENCONTRADO") ||
    code.includes("VEHICLE_NOT_FOUND")
  ) {
    return { ok: false, reason: "not_found", clientMessage: SGA_CLIENT_MSG.not_found };
  }

  /** Hinova retorna descricao_situacao (ex.: "ATIVO") — prioridade sobre só o código numérico */
  const descSituacao = cleanStatus(
    d.descricao_situacao ?? d.descricaoSituacao ?? d.descricao_status ?? ""
  );
  if (descSituacao === "ATIVO" || descSituacao === "ATIVA" || descSituacao === "ACTIVE" || descSituacao === "HABILITADO") {
    return { ok: true, reason: "active" };
  }
  if (
    descSituacao === "INATIVO" ||
    descSituacao === "INATIVA" ||
    descSituacao === "INACTIVE" ||
    descSituacao === "BLOQUEADO" ||
    descSituacao === "SUSPENSO" ||
    descSituacao === "CANCELADO"
  ) {
    return { ok: false, reason: "inactive", clientMessage: SGA_CLIENT_MSG.inactive };
  }

  const statusCandidates = [
    d.situacao,
    d.status,
    d.situacao_veiculo,
    d.status_veiculo,
    d.vehicle_status,
    d.state,
    d.descricao_situacao,
    d.descricaoSituacao,
  ].map(cleanStatus);
  const rawSit = d.codigo_situacao ?? d.codigoSituacao ?? d.situacao_codigo;
  const statusCode = normalizeSgaSituationCode(rawSit);
  const activeCodes = String(process.env.SGA_ACTIVE_STATUS_CODES || "1,9")
    .split(",")
    .map((s) => normalizeSgaSituationCode(s))
    .filter(Boolean);

  const activeFlag = toBool(d.ativo ?? d.active ?? d.ativoProtecao ?? d.isActive);
  const isActiveByCode = !!statusCode && activeCodes.includes(statusCode);
  const isInactiveByCode = !!statusCode && !activeCodes.includes(statusCode);
  const isActiveByStatus = statusCandidates.some((s) =>
    ["ATIVO", "ATIVA", "ACTIVE", "HABILITADO", "LIBERADO"].includes(s)
  );
  const isInactiveByStatus = statusCandidates.some((s) =>
    ["INATIVO", "INATIVA", "INACTIVE", "BLOQUEADO", "SUSPENSO", "CANCELADO"].includes(s)
  );

  const ativo = activeFlag === true || isActiveByCode || isActiveByStatus;
  const inativo = activeFlag === false || isInactiveByCode || isInactiveByStatus;

  if (inativo) {
    return { ok: false, reason: "inactive", clientMessage: SGA_CLIENT_MSG.inactive };
  }

  if (ativo) {
    return { ok: true, reason: "active" };
  }

  if (toBool(d.sucesso ?? d.success) === true && ativo) {
    return { ok: true, reason: "active" };
  }

  logger.warn({ response: data }, "SGA: payload não reconhecido com clareza; tratado como não encontrado");
  return { ok: false, reason: "not_found", clientMessage: SGA_CLIENT_MSG.not_found };
}
