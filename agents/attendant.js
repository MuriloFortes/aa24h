import { logger } from "../lib/logger.js";
import { conversationManager, STATES } from "./conversationFlow.js";
import { normalizeBrazilianPlate, compactPlateFromNoisyText } from "../lib/plate.js";
import { resolveMessageThreadKey, digitsOnlyPhone } from "../lib/phoneCanonical.js";

/** Mesma lógica de chave que conversationFlow (fila anti-duplicata alinhada à sessão). */
function chatSessionKey(phoneNumber) {
  const raw = String(phoneNumber || "").trim();
  if (!raw) return "_";
  if (/^web[_-]/i.test(raw)) return raw;
  const c = resolveMessageThreadKey(raw);
  if (c && c.length >= 10) return c;
  return digitsOnlyPhone(raw) || raw;
}

const _processMessageTail = new Map();


export function resolveOpenAILikeBaseURL() {
  const fromEnv = process.env.OPENAI_BASE_URL?.trim();
  if (fromEnv) return fromEnv;
  return process.env.OPENCODE_LLM_BASE_URL?.trim() || undefined;
}

export function hasLLMConfigured() {
  const key = (process.env.OPENAI_API_KEY || "").trim();
  const base = resolveOpenAILikeBaseURL();
  return !!(key || base);
}

const DEFAULT_WELCOME_MESSAGE =
  "Olá! Sou a assistente virtual da SGA Assistência.";

export function requiresTowingAccessForProblem(problemType) {
  if (!problemType) return false;
  const needs = new Set([
    "reboque", "acidente", "pane_mecanica", "pane_eletrica",
    "bateria_descarregada", "chave_trancada", "pneu_furado", "outro",
  ]);
  return needs.has(problemType);
}

/* ─── Validadores ─── */

const PLATE_REGEX_OLD = /^[A-Z]{3}\d{4}$/;
const PLATE_REGEX_MERCOSUL = /^[A-Z]{3}\d[A-Z]\d{2}$/;

function isValidPlate(raw) {
  const s = normalizeBrazilianPlate(raw);
  if (!s || s.length !== 7) return false;
  return PLATE_REGEX_OLD.test(s) || PLATE_REGEX_MERCOSUL.test(s);
}

function extractFirstValidPlate(text) {
  const merged = compactPlateFromNoisyText(text);
  if (merged.length >= 7 && isValidPlate(merged.slice(0, 7))) {
    return normalizeBrazilianPlate(merged.slice(0, 7));
  }
  if (isValidPlate(merged)) return normalizeBrazilianPlate(merged);
  const upper = String(text || "").toUpperCase();
  const compact = upper.replace(/[^A-Z0-9]/g, " ");
  const tokens = compact.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (isValidPlate(token)) return normalizeBrazilianPlate(token);
  }
  return null;
}

function isValidAddress(text) {
  const t = (text || "").trim();
  if (t.length < 5) return false;
  if (/^\d+$/.test(t)) return false;
  if (!/[a-záàâãéêíóôõúüç]/i.test(t)) return false;
  return true;
}

function isValidReceiverInfo(text) {
  const t = (text || "").trim();
  const hasName = /[a-záàâãéêíóôõúüç]{2,}/i.test(t);
  const hasPhone = /\d{8,}/.test(t.replace(/\D/g, ""));
  return hasName && hasPhone;
}

function isValidName(text) {
  const t = (text || "").trim();
  if (t.length < 3) return false;
  if (/^\d+$/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 2;
}

/* ─── Etapas de coleta ─── */

const COLLECTION_STEPS = [
  {
    field: "schedule_type",
    question: "O atendimento será para *agora* ou *agendado*?",
    validate: (text) => {
      const t = text.toLowerCase().trim();
      return (
        /agora|j[áa]\b|imediato|imediat|agend|depois|mais tarde|amanh[ãa]|marcar|programad|hor[áa]rio|outro dia|urgent|logo|r[áa]pid|emerg|\bhoje\b|combinad|marcado/i.test(
          t
        )
      );
    },
    reask: "Por favor, responda *agora* ou *agendado* (ou *depois* / *agendar*).",
    parse: (text) => {
      const t = text.toLowerCase();
      const wantsScheduled =
        /agend|depois|mais tarde|amanh[ãa]|marcar|programad|hor[áa]rio|outro dia|combinad|marcado/i.test(t);
      const wantsNow =
        /\bagora\b|urgent|imediat|j[áa]\b|imediato|logo|r[áa]pid|emerg|\bhoje\b/i.test(t);
      if (wantsScheduled && !wantsNow) return { schedule_type: "agendado" };
      if (wantsNow && !wantsScheduled) return { schedule_type: "agora" };
      if (wantsScheduled && wantsNow) {
        if (/n[aã]o[^\n]{0,20}\bagenda|n[aã]o[^\n]{0,20}\bagora|depois|agend|marcar/i.test(t)) {
          return { schedule_type: /depois|agend|marcar|programad|hor[áa]rio/i.test(t) ? "agendado" : "agora" };
        }
        return { schedule_type: "agora" };
      }
      if (/agend/.test(t)) return { schedule_type: "agendado" };
      return { schedule_type: "agora" };
    },
  },
  {
    field: "customer_name",
    question: "Qual é o seu *nome completo*?",
    validate: isValidName,
    reask: "Por favor, informe seu *nome e sobrenome* (mínimo nome e sobrenome).",
    parse: (text) => ({ customer_name: text.trim() }),
  },
  {
    field: "location",
    question: "Onde está o veículo agora? Envie o *endereço de origem* ou compartilhe a *localização* pelo WhatsApp.",
    validate: isValidAddress,
    reask: "Endereço inválido. Informe um *endereço completo* (rua, número, bairro ou referência).",
    parse: (text) => ({ location: text.trim() }),
  },
  {
    field: "destination",
    question: "O veículo irá para qual *endereço de destino*?",
    validate: isValidAddress,
    reask: "Endereço de destino inválido. Informe um *endereço completo* (rua, número, bairro).",
    parse: (text) => ({ destination: text.trim() }),
  },
  {
    field: "vehicle_plate",
    question: "Qual a *placa do veículo*? (formato antigo ABC1234 ou Mercosul ABC1D23)",
    validate: (text) => isValidPlate(text),
    reask: "Placa inválida. Informe no formato *antigo* (ABC1234) ou *Mercosul* (ABC1D23).",
    parse: (text) => ({ vehicle_plate: normalizeBrazilianPlate(text) }),
  },
  {
    field: "vehicle_type",
    question: "Qual o *modelo/tipo do veículo*? (ex.: Gol, Civic, HB20, Moto CG, Van Fiorino)",
    validate: (text) => text.trim().length >= 2,
    reask: "Informe o *modelo do veículo* (ex.: Gol, Onix, Moto CG).",
    parse: (text) => ({ vehicle_type: text.trim() }),
  },
  {
    field: "problem_type",
    question: "Qual o *problema* ou *serviço* que você precisa? (ex.: reboque, pane elétrica, pneu furado, combustível, chaveiro)",
    validate: () => true,
    reask: "",
    parse: (text) => {
      const t = text.toLowerCase();
      let pt = "reboque";
      if (/bateria|carga/.test(t)) pt = "bateria_descarregada";
      else if (/pneu|calibr/.test(t)) pt = "pneu_furado";
      else if (/chave/.test(t)) pt = "chave_trancada";
      else if (/combust|gasolina|diesel/.test(t)) pt = "sem_combustivel";
      else if (/el[eé]tr/.test(t)) pt = "pane_eletrica";
      else if (/mec[aâ]nic|motor/.test(t)) pt = "pane_mecanica";
      else if (/acidente|batida|colis/.test(t)) pt = "acidente";
      return { problem_type: pt };
    },
  },
  {
    field: "towing_access",
    question: "O local permite *acesso fácil* ao guincho (via larga) ou há alguma *ressalva* (difícil, bloqueado, garagem)?",
    validate: () => true,
    reask: "",
    parse: (text) => {
      const t = text.toLowerCase();
      if (/bloquead|imposs/.test(t)) return { towing_access: "bloqueado" };
      if (/dif[ií]cil|apertad|viela|estreit|garagem|subsolo/.test(t)) return { towing_access: "dificil" };
      return { towing_access: "facil" };
    },
  },
  {
    field: "receiver_info",
    question: "Qual o *nome* e *telefone* de quem irá *receber o veículo* no destino? (ex.: Maria Silva 11999887766)",
    validate: isValidReceiverInfo,
    reask: "Informe o *nome* e *telefone* (com DDD) de quem receberá o veículo. Ex.: Maria Silva 11999887766",
    parse: (text) => ({ receiver_info: text.trim() }),
  },
  {
    field: "ride_along",
    question: "Você irá no reboque *junto com o veículo*? (sim ou não)",
    validate: (text) => /sim|n[aã]o|nao/i.test(text.trim()),
    reask: "Por favor, responda *sim* ou *não*.",
    parse: (text) => {
      if (/n[aã]o|nao/i.test(text)) return { ride_along: "não" };
      return { ride_along: "sim" };
    },
  },
];

function fieldIsEmpty(val) {
  return val === null || val === undefined || String(val).trim() === "";
}

const EDITABLE_FIELDS = {
  tipo: "schedule_type",
  agendamento: "schedule_type",
  nome: "customer_name",
  origem: "location",
  localizacao: "location",
  localização: "location",
  destino: "destination",
  placa: "vehicle_plate",
  veiculo: "vehicle_type",
  veículo: "vehicle_type",
  modelo: "vehicle_type",
  servico: "problem_type",
  serviço: "problem_type",
  problema: "problem_type",
  acesso: "towing_access",
  recebedor: "receiver_info",
  receptor: "receiver_info",
  telefone: "receiver_info",
  junto: "ride_along",
  reboque: "ride_along",
};

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function findStepByField(field) {
  return COLLECTION_STEPS.find((s) => s.field === field) || null;
}

function detectEditField(text) {
  const t = normalizeText(text);
  for (const [key, field] of Object.entries(EDITABLE_FIELDS)) {
    if (t.includes(key)) return field;
  }
  return null;
}

function isCancelOrRestartIntent(text) {
  const t = normalizeText(text);
  return (
    /\bcancel/.test(t) ||
    /\breiniciar?\b/.test(t) ||
    /\bcomecar novamente\b/.test(t) ||
    /\brecomecar\b/.test(t) ||
    /\bnovo atendimento\b/.test(t) ||
    /\bdesistir\b/.test(t)
  );
}

function resetCollectedData() {
  return {
    schedule_type: null,
    customer_name: null,
    location: null,
    location_lat: null,
    location_lng: null,
    destination: null,
    vehicle_type: null,
    vehicle_plate: null,
    problem_type: null,
    towing_access: null,
    receiver_info: null,
    ride_along: null,
  };
}

function getNextStep(collectedData) {
  for (const step of COLLECTION_STEPS) {
    if (fieldIsEmpty(collectedData[step.field])) {
      return step;
    }
  }
  return null;
}

function buildSummary(data) {
  const PROBLEM_LABELS = {
    pane_mecanica: "pane mecânica", pane_eletrica: "pane elétrica",
    pneu_furado: "pneu furado", acidente: "acidente",
    sem_combustivel: "sem combustível", chave_trancada: "chave trancada",
    bateria_descarregada: "bateria descarregada", reboque: "reboque", outro: "outro",
  };
  const prob = PROBLEM_LABELS[data.problem_type] || data.problem_type || "—";
  const twMap = { facil: "fácil", dificil: "difícil / com ressalva", bloqueado: "bloqueado" };
  const tw = twMap[data.towing_access] || data.towing_access || "—";
  const sched = data.schedule_type === "agendado" ? "Agendado" : "Para agora";

  return (
    `📋 *Resumo do chamado*\n\n` +
    `⏱️ *Tipo:* ${sched}\n` +
    `👤 *Nome:* ${data.customer_name || "—"}\n` +
    `📍 *Origem:* ${data.location || "—"}\n` +
    `📍 *Destino:* ${data.destination || "—"}\n` +
    `🚗 *Placa:* ${data.vehicle_plate || "—"}\n` +
    `🏷️ *Veículo:* ${data.vehicle_type || "—"}\n` +
    `🔧 *Serviço:* ${prob}\n` +
    `🚚 *Acesso:* ${tw}\n` +
    `👥 *Recebedor:* ${data.receiver_info || "—"}\n` +
    `🧑‍🤝‍🧑 *Vai junto no reboque:* ${data.ride_along || "—"}\n\n` +
    `Está tudo certo? Responda *sim* para confirmar ou diga o que deseja corrigir.`
  );
}

/**
 * Máquina de estados pura com validação: uma pergunta por mensagem.
 * (Implementação interna — use `processMessage` exportado, que serializa por sessão.)
 */
async function processMessageImpl(phoneNumber, userMessage, options = {}) {
  let session = conversationManager.getOrCreateSession(phoneNumber);
  conversationManager.addMessage(phoneNumber, "user", userMessage);

  if (session.state === STATES.TICKET_CREATED || session.state === STATES.CLOSED) {
    conversationManager.closeSession(phoneNumber);
    session = conversationManager.createSession(phoneNumber);
    session.messages.push({ role: "user", content: userMessage, timestamp: Date.now() });
  }

  session = conversationManager.getSession(phoneNumber);
  if (!session) {
    return { response: "Não foi possível iniciar a conversa. Tente novamente.", ticketData: null, state: STATES.AWAITING_GREETING, collectedData: {} };
  }

  if (session.state === STATES.AWAITING_GREETING) {
    conversationManager.updateState(phoneNumber, STATES.COLLECTING_INFO);
    session = conversationManager.getSession(phoneNumber);
  }

  if (session.state === STATES.COLLECTING_INFO) {
    const botAlreadySpoke = session.messages.some((m) => m.role === "assistant");

    if (botAlreadySpoke) {
      const currentStep = getNextStep(session.collectedData);
      if (currentStep) {
        if (currentStep.validate && !currentStep.validate(userMessage)) {
          const reply = currentStep.reask || currentStep.question;
          conversationManager.addMessage(phoneNumber, "assistant", reply);
          return { response: reply, ticketData: null, state: STATES.COLLECTING_INFO, collectedData: session.collectedData };
        }
        const parsed = currentStep.parse(userMessage);
        conversationManager.updateCollectedData(phoneNumber, parsed);
        logger.info({ phone: phoneNumber, field: currentStep.field, parsed }, "Dado coletado");
      }
    } else {
      /* Primeira mensagem: antes só enviávamos a pergunta e ignorávamos o texto — ex.: "preciso para agora" gerava de novo "agora ou agendado?". */
      const firstStep = getNextStep(session.collectedData);
      if (firstStep && firstStep.validate && firstStep.validate(userMessage)) {
        const parsed = firstStep.parse(userMessage);
        conversationManager.updateCollectedData(phoneNumber, parsed);
        logger.info({ phone: phoneNumber, field: firstStep.field, parsed }, "Dado coletado (primeira mensagem)");
      }
    }

    session = conversationManager.getSession(phoneNumber);
    const nextStep = getNextStep(session.collectedData);

    if (nextStep) {
      let reply = nextStep.question;
      if (!botAlreadySpoke) {
        let raw = (options.welcomeMessage || "").trim();
        if (raw.includes("?")) raw = "";
        reply = `${raw || DEFAULT_WELCOME_MESSAGE}\n\n${reply}`;
      }
      conversationManager.addMessage(phoneNumber, "assistant", reply);
      return { response: reply, ticketData: null, state: STATES.COLLECTING_INFO, collectedData: session.collectedData };
    }

    conversationManager.updateState(phoneNumber, STATES.CONFIRMING_DATA);
    const ticketData = { ...conversationManager.getSession(phoneNumber).collectedData };
    conversationManager.setPendingConfirmation(phoneNumber, true);
    conversationManager.setSkipConfirmSameTurn(phoneNumber, true);
    const summary = buildSummary(ticketData);
    conversationManager.addMessage(phoneNumber, "assistant", summary);
    return { response: summary, ticketData, state: STATES.CONFIRMING_DATA, collectedData: ticketData };
  }

  if (session.state === STATES.CONFIRMING_DATA) {
    if (isCancelOrRestartIntent(userMessage)) {
      conversationManager.updateCollectedData(phoneNumber, resetCollectedData());
      conversationManager.clearConfirmationFlags(phoneNumber);
      conversationManager.updateState(phoneNumber, STATES.COLLECTING_INFO);
      const firstStep = getNextStep(conversationManager.getSession(phoneNumber).collectedData);
      const reply =
        "Atendimento cancelado e reiniciado com sucesso.\n\n" +
        (firstStep?.question || "Vamos começar novamente. Qual é o seu *nome completo*?");
      conversationManager.addMessage(phoneNumber, "assistant", reply);
      return {
        response: reply,
        ticketData: null,
        state: STATES.COLLECTING_INFO,
        collectedData: conversationManager.getSession(phoneNumber).collectedData,
      };
    }

    if (session.pendingEditField) {
      const step = findStepByField(session.pendingEditField);
      if (step) {
        if (step.validate && !step.validate(userMessage)) {
          const reply = step.reask || step.question;
          conversationManager.addMessage(phoneNumber, "assistant", reply);
          return { response: reply, ticketData: null, state: STATES.CONFIRMING_DATA, collectedData: session.collectedData };
        }
        const parsed = step.parse(userMessage);
        conversationManager.updateCollectedData(phoneNumber, parsed);
        conversationManager.setPendingEditField(phoneNumber, null);
        conversationManager.setPendingConfirmation(phoneNumber, true);
        conversationManager.setSkipConfirmSameTurn(phoneNumber, true);
        const updated = conversationManager.getSession(phoneNumber).collectedData;
        const summary = buildSummary(updated);
        conversationManager.addMessage(phoneNumber, "assistant", summary);
        return { response: summary, ticketData: updated, state: STATES.CONFIRMING_DATA, collectedData: updated };
      }
    }

    const editField = detectEditField(userMessage);
    const inlinePlate = extractFirstValidPlate(userMessage);
    if (inlinePlate && (editField === "vehicle_plate" || isValidPlate(userMessage))) {
      conversationManager.updateCollectedData(phoneNumber, { vehicle_plate: inlinePlate });
      conversationManager.setPendingEditField(phoneNumber, null);
      conversationManager.setPendingConfirmation(phoneNumber, true);
      conversationManager.setSkipConfirmSameTurn(phoneNumber, true);
      const updated = conversationManager.getSession(phoneNumber).collectedData;
      const summary = buildSummary(updated);
      conversationManager.addMessage(phoneNumber, "assistant", summary);
      return { response: summary, ticketData: updated, state: STATES.CONFIRMING_DATA, collectedData: updated };
    }

    if (editField) {
      const step = findStepByField(editField);
      conversationManager.setPendingEditField(phoneNumber, editField);
      const reply =
        `Perfeito, vamos corrigir *${step?.field === "vehicle_plate" ? "a placa" : "esse dado"}*.\n` +
        `${step?.question || "Envie o valor correto."}`;
      conversationManager.addMessage(phoneNumber, "assistant", reply);
      return { response: reply, ticketData: null, state: STATES.CONFIRMING_DATA, collectedData: session.collectedData };
    }

    const reply =
      "Responda *sim* para confirmar o chamado, diga *quero corrigir a placa* (ou outro dado), " +
      "ou *cancelar* para reiniciar o atendimento.";
    conversationManager.addMessage(phoneNumber, "assistant", reply);
    return { response: reply, ticketData: null, state: STATES.CONFIRMING_DATA, collectedData: session.collectedData };
  }

  return { response: "Envie uma mensagem para iniciar o atendimento.", ticketData: null, state: session.state, collectedData: session.collectedData };
}

/**
 * Evita duas respostas quando o webhook dispara em paralelo para a mesma conversa.
 * Mantém sempre a cauda da cadeia em `_processMessageTail` (sem apagar no finally de cada turno).
 */
async function processMessage(phoneNumber, userMessage, options = {}) {
  const key = chatSessionKey(phoneNumber);
  const prev = _processMessageTail.get(key) || Promise.resolve();
  const result = prev.catch(() => {}).then(() => processMessageImpl(phoneNumber, userMessage, options));
  _processMessageTail.set(key, result.catch(() => {}));
  return result;
}

async function confirmTicket(phoneNumber) {
  const session = conversationManager.getSession(phoneNumber);
  if (!session) return null;
  conversationManager.updateState(phoneNumber, STATES.TICKET_CREATED);
  return { ...session.collectedData, phoneNumber: session.phoneNumber, confirmedAt: Date.now() };
}

export { processMessage, confirmTicket, DEFAULT_WELCOME_MESSAGE };
export const SYSTEM_PROMPT = "";
