import { logger } from "../lib/logger.js";
import { resolveMessageThreadKey, digitsOnlyPhone } from "../lib/phoneCanonical.js";

function sessionPhoneKey(phoneNumber) {
  const raw = String(phoneNumber || "").trim();
  if (!raw) return "";
  if (/^web[_-]/i.test(raw)) return raw;
  const c = resolveMessageThreadKey(raw);
  if (c && c.length >= 10) return c;
  return digitsOnlyPhone(raw) || "";
}

const STATES = {
  AWAITING_GREETING: "awaiting_greeting",
  COLLECTING_INFO: "collecting_info",
  CONFIRMING_DATA: "confirming_data",
  TICKET_CREATED: "ticket_created",
  CLOSED: "closed",
};

const SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

class ConversationManager {
  constructor() {
    this.sessions = new Map();
    this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);
  }

  getSession(phoneNumber) {
    const normalized = sessionPhoneKey(phoneNumber);
    const session = this.sessions.get(normalized);
    if (session) {
      session.lastActivity = Date.now();
      return session;
    }
    return null;
  }

  createSession(phoneNumber) {
    const normalized = sessionPhoneKey(phoneNumber);
    const session = {
      phoneNumber: normalized,
      state: STATES.AWAITING_GREETING,
      /** true após o assistente enviar o resumo pedindo confirmação (create_ticket) */
      pendingConfirmation: false,
      /** evita confirmar no mesmo request em que o resumo foi gerado (ex.: usuário disse "sim" ao cumprimento) */
      skipConfirmSameTurn: false,
      /** campo atualmente em edição durante a etapa de confirmação */
      pendingEditField: null,
      messages: [],
      collectedData: {
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
      },
      /** fluxo de simulação sem LLM (fases em orchestrator.simulateInboundAttendance) */
      simulatePhase: null,
      attendanceId: null,
      serviceId: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    this.sessions.set(normalized, session);
    logger.info({ phone: normalized }, "Nova sessão de conversa criada");
    return session;
  }

  getOrCreateSession(phoneNumber) {
    return this.getSession(phoneNumber) || this.createSession(phoneNumber);
  }

  addMessage(phoneNumber, role, content) {
    const session = this.getOrCreateSession(phoneNumber);
    session.messages.push({ role, content, timestamp: Date.now() });
    session.lastActivity = Date.now();
    return session;
  }

  updateState(phoneNumber, newState) {
    const session = this.getSession(phoneNumber);
    if (session) {
      const oldState = session.state;
      session.state = newState;
      logger.info({ phone: phoneNumber, from: oldState, to: newState }, "Estado de conversa atualizado");
    }
    return session;
  }

  updateCollectedData(phoneNumber, data) {
    const session = this.getSession(phoneNumber);
    if (session) {
      Object.assign(session.collectedData, data);
      logger.info({ phone: phoneNumber, data }, "Dados coletados atualizados");
    }
    return session;
  }

  setPendingConfirmation(phoneNumber, value) {
    const session = this.getSession(phoneNumber);
    if (session) session.pendingConfirmation = !!value;
    return session;
  }

  setSkipConfirmSameTurn(phoneNumber, value) {
    const session = this.getSession(phoneNumber);
    if (session) session.skipConfirmSameTurn = !!value;
    return session;
  }

  clearConfirmationFlags(phoneNumber) {
    const session = this.getSession(phoneNumber);
    if (session) {
      session.pendingConfirmation = false;
      session.skipConfirmSameTurn = false;
      session.pendingEditField = null;
    }
    return session;
  }

  setPendingEditField(phoneNumber, field) {
    const session = this.getSession(phoneNumber);
    if (session) session.pendingEditField = field || null;
    return session;
  }

  closeSession(phoneNumber) {
    const normalized = sessionPhoneKey(phoneNumber);
    this.sessions.delete(normalized);
    logger.info({ phone: normalized }, "Sessão encerrada");
  }

  isDataComplete(phoneNumber) {
    const session = this.getSession(phoneNumber);
    if (!session) return false;
    const d = session.collectedData;
    return !!(d.customer_name && d.location && d.problem_type);
  }

  getMessageHistory(phoneNumber) {
    const session = this.getSession(phoneNumber);
    if (!session) return [];
    return session.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  _cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [phone, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        this.sessions.delete(phone);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned }, "Sessões expiradas removidas");
    }
  }

  destroy() {
    clearInterval(this._cleanupTimer);
    this.sessions.clear();
  }
}

const conversationManager = new ConversationManager();

export { STATES, conversationManager, ConversationManager };
