import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { Server } from "socket.io";
import Database from "better-sqlite3";
import fs from "fs";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./lib/logger.js";
import axios from "axios";
import { processMessage, hasLLMConfigured } from "./agents/attendant.js";
import { conversationManager, STATES } from "./agents/conversationFlow.js";
import { Orchestrator } from "./agents/orchestrator.js";
import { Analyst } from "./agents/analyst.js";
import { PaymentService } from "./services/payment.js";
import { NotificationService, calculateETA } from "./services/notifications.js";
import {
  canonicalBrPhone,
  extractWhatsAppUserDigits,
  digitsFromInboundMessageKey,
  resolveMessageThreadKey,
  normalizeMessagesThreadKeys,
} from "./lib/phoneCanonical.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Modo legado: usa simulateInboundAttendance no orquestrador (fluxo antigo).
 * Padrão: false — sempre usa processMessage (attendant.js, uma pergunta por vez).
 * true = forçar simulação legada; false = fluxo estruturado (recomendado).
 */
function shouldSimulateAttendance() {
  if (process.env.SIMULATE_ATTENDANCE === "true") return true;
  if (process.env.SIMULATE_ATTENDANCE === "false") return false;
  return false;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PREFERRED_PORT = (() => {
  const n = Number.parseInt(String(process.env.PORT || ""), 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 3003;
})();
const PORT_FALLBACK_MAX = Number.parseInt(String(process.env.PORT_FALLBACK_MAX || "40"), 10) || 40;

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";

const db = new Database(path.join(__dirname, "attendance.db"));
db.pragma("journal_mode = WAL");

runSchema();
runSeed();
mergeMessagesThreadsOnStartup();

// WhatsApp via Evolution API
let whatsappConnected = false;
let whatsappNumber = "";
let whatsappInstance = process.env.WHATSAPP_INSTANCE || "sga-instance";

function normalizePhoneList(raw) {
  return String(raw || "")
    .split(/[\s,;|]+/)
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean);
}

function getTestModeConfig() {
  const enabled =
    (getSetting("test_mode") || "").toLowerCase() === "true" ||
    process.env.TEST_MODE === "true";
  const allowlist = normalizePhoneList(
    getSetting("test_allowlist") || process.env.TEST_ALLOWLIST || ""
  );
  return { enabled, allowlist };
}

/**
 * Evolution API v2 exige `number` só com dígitos e código do país (ex.: 5511999999999).
 * Não usar JID (@s.whatsapp.net) no corpo do JSON — isso faz o envio falhar.
 */
function normalizeNumberForEvolutionApi(digitsRaw) {
  return canonicalBrPhone(digitsRaw);
}

/** Allowlist aceita número com ou sem 55. */
function allowlistHasCanonical(allowlist, phoneRaw) {
  const c = canonicalBrPhone(phoneRaw);
  if (!c) return false;
  for (const entry of allowlist || []) {
    const e = String(entry || "").trim();
    if (!e) continue;
    if (canonicalBrPhone(e) === c) return true;
    if (String(e).replace(/\D/g, "") === c) return true;
  }
  return false;
}

/** Une todas as variantes de telefone/JID na mesma chave da tabela `messages`. */
function mergeMessagesThreadsOnStartup() {
  const n = normalizeMessagesThreadKeys(db);
  if (n > 0) {
    logger.info({ rowsUpdated: n }, "messages: conversas agrupadas na mesma chave (inbound + outbound)");
  }
}

async function sendEvolutionMessage(to, message, opts = {}) {
  const rawTo = String(to || "").trim();
  /** Cliente pelo chat web: não há número Evolution — só painel/socket/histórico local. */
  if (/^web[_-]/i.test(rawTo)) {
    return { channel: "web_chat" };
  }

  const phoneDigits = extractWhatsAppUserDigits(to) || String(to || "").replace(/\D/g, "");
  const { enabled: testMode, allowlist } = getTestModeConfig();

  if (testMode && !opts.force && !allowlistHasCanonical(allowlist, phoneDigits)) {
    logger.warn({ to: phoneDigits, preview: String(message).slice(0, 80) }, "[TEST MODE] envio bloqueado");
    try {
      const canon = resolveMessageThreadKey(phoneDigits);
      db.prepare(
        "INSERT INTO messages (phone, direction, content, message_type) VALUES (?, 'blocked', ?, 'text')"
      ).run(canon || phoneDigits, String(message).slice(0, 4000));
    } catch {}
    try {
      io.emit("outbound:blocked", {
        phone: resolveMessageThreadKey(phoneDigits) || phoneDigits,
        content: message,
        direction: "blocked",
        timestamp: new Date().toISOString(),
        reason: "test_mode",
      });
    } catch {}
    return { blocked: true, reason: "test_mode" };
  }

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    throw new Error("Evolution API não configurada");
  }
  const numberForApi = normalizeNumberForEvolutionApi(phoneDigits);
  if (!numberForApi || numberForApi.length < 12) {
    throw new Error(
      "Número inválido para WhatsApp: use DDD + número (ex.: 11999999999) ou já com 55."
    );
  }

  const url = `${EVOLUTION_API_URL.replace(/\/$/, "")}/message/sendText/${encodeURIComponent(whatsappInstance)}`;
  try {
    const response = await axios.post(
      url,
      { number: numberForApi, text: String(message ?? "") },
      {
        headers: {
          apikey: EVOLUTION_API_KEY,
          "Content-Type": "application/json",
        },
        validateStatus: () => true,
      }
    );
    if (response.status >= 400) {
      const detail =
        typeof response.data === "object" && response.data !== null
          ? JSON.stringify(response.data).slice(0, 500)
          : String(response.data || "").slice(0, 500);
      logger.error(
        { status: response.status, url, numberForApi, detail },
        "Evolution API rejeitou sendText"
      );
      throw new Error(
        response.status === 404
          ? `Instância WhatsApp não encontrada na Evolution (verifique WHATSAPP_INSTANCE=${whatsappInstance}). ${detail}`
          : `Evolution sendText falhou (${response.status}): ${detail}`
      );
    }
    return response.data;
  } catch (err) {
    if (err.response?.data) {
      logger.error(
        { err: err.message, evolution: err.response.data },
        "sendEvolutionMessage axios error"
      );
    }
    throw err;
  }
}

/**
 * Evolution + persistência em `messages` + evento Socket (aba Conversas).
 * O webhook já grava respostas do assistente que chamam `sendEvolutionMessage` direto.
 */
async function evolutionMsgForOrchestrator(to, message, opts = {}) {
  const r = await sendEvolutionMessage(to, message, opts);
  if (r?.blocked) return r;
  if (opts.skipConversationLog) return r;
  const rawTo = String(to || "").trim();
  const phoneKey = /^web[_-]/i.test(rawTo) ? rawTo : resolveMessageThreadKey(to);
  if (!phoneKey) return r;
  const body = String(message ?? "").slice(0, 4000);
  try {
    db.prepare(
      "INSERT INTO messages (phone, direction, content, message_type) VALUES (?, 'outbound', ?, 'text')"
    ).run(phoneKey, body);
  } catch (err) {
    logger.warn({ err: err?.message }, "Falha ao gravar outbound em messages (orquestrador)");
  }
  try {
    io.emit("whatsapp:message", {
      phone: phoneKey,
      content: body,
      direction: "outbound",
      timestamp: new Date().toISOString(),
      origin: opts.origin || "assistant",
      channel: /^web[_-]/i.test(rawTo) ? "web" : "whatsapp",
    });
  } catch {}
  return r;
}

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function mergeAttendanceNotes(attendanceId, patch) {
  if (!attendanceId || !db.prepare) return;
  const row = db.prepare("SELECT notes FROM attendances WHERE id = ?").get(attendanceId);
  let o = {};
  try {
    if (row?.notes) o = JSON.parse(row.notes) || {};
  } catch {
    o = {};
  }
  const next = { ...o, ...patch };
  db.prepare("UPDATE attendances SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(next),
    attendanceId
  );
  try {
    io.emit("attendance:updated", { id: attendanceId });
  } catch {}
}

function appendGestorMedia(attendanceId, entry) {
  if (!attendanceId) return;
  let arr = [];
  try {
    const row = db.prepare("SELECT gestor_media_json FROM attendances WHERE id = ?").get(attendanceId);
    if (row?.gestor_media_json) arr = JSON.parse(row.gestor_media_json);
  } catch {
    arr = [];
  }
  if (!Array.isArray(arr)) arr = [];
  arr.push({ ...entry, at: entry.at || new Date().toISOString() });
  db.prepare("UPDATE attendances SET gestor_media_json = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(arr),
    attendanceId
  );
  try {
    io.emit("attendance:updated", { id: attendanceId });
  } catch {}
}

function notifyGestor(text) {
  const g = digitsOnly(getSetting("gestor_whatsapp", ""));
  if (!g || g.length < 10) return Promise.resolve();
  return sendEvolutionMessage(g, text, { force: true }).catch(() => {});
}

const orchestrator = new Orchestrator(db, io, evolutionMsgForOrchestrator, {
  getBusinessRules: () => getBusinessRules(),
  generateProtocol: () => generateAttendanceProtocol(),
  getSetting,
  notifyGestor,
  mergeAttendanceNotes,
  appendGestorMedia,
});
const analyst = new Analyst(db);
const paymentService = new PaymentService(db, sendEvolutionMessage);
const notificationService = new NotificationService(io, sendEvolutionMessage);

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/audio", express.static(path.join(__dirname, "audio")));
app.use("/providers-photos", express.static(path.join(__dirname, "providers-photos")));

const WEB_CLIENT_DIST = path.join(__dirname, "web-client", "dist");
const HAS_WEB_CLIENT_BUILD =
  fs.existsSync(WEB_CLIENT_DIST) &&
  fs.existsSync(path.join(WEB_CLIENT_DIST, "index.html"));
if (HAS_WEB_CLIENT_BUILD) {
  app.use(express.static(WEB_CLIENT_DIST));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'audio');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

function runSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendances (
      id TEXT PRIMARY KEY,
      caller_id TEXT,
      customer_name TEXT,
      vehicle_plate TEXT,
      service_type TEXT,
      status TEXT DEFAULT 'in_progress',
      sga_response TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attendance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendance_id TEXT,
      step TEXT,
      question TEXT,
      answer TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      attendance_id TEXT,
      plate TEXT,
      service_type TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      provider_name TEXT,
      status TEXT DEFAULT 'pending',
      price REAL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      whatsapp TEXT,
      services TEXT,
      latitude REAL,
      longitude REAL,
      rating REAL DEFAULT 5.0,
      total_ratings INTEGER DEFAULT 0,
      vehicle_types TEXT,
      price_base REAL DEFAULT 100.00,
      price_per_km REAL DEFAULT 5.00,
      available INTEGER DEFAULT 1,
      active INTEGER DEFAULT 1,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sga_associates (
      phone TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 1,
      name TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'inbound',
      content TEXT,
      message_type TEXT DEFAULT 'text',
      attendance_id TEXT,
      raw_payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS negotiations (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      offered_price REAL,
      counter_price REAL,
      final_price REAL,
      status TEXT DEFAULT 'pending',
      contacted_at TEXT,
      responded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      amount REAL NOT NULL,
      method TEXT NOT NULL DEFAULT 'pix',
      gateway TEXT,
      gateway_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      pix_code TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_status ON attendances(status);
    CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);
    CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
    CREATE INDEX IF NOT EXISTS idx_negotiations_service ON negotiations(service_id);
  `);

  const migrations = [
    "ALTER TABLE providers ADD COLUMN total_ratings INTEGER DEFAULT 0",
    "ALTER TABLE providers ADD COLUMN vehicle_types TEXT",
    "ALTER TABLE providers ADD COLUMN price_base REAL DEFAULT 100.00",
    "ALTER TABLE providers ADD COLUMN price_per_km REAL DEFAULT 5.00",
    "ALTER TABLE providers ADD COLUMN available INTEGER DEFAULT 1",
    "ALTER TABLE providers ADD COLUMN last_seen_at TEXT",
    "ALTER TABLE attendances ADD COLUMN channel TEXT DEFAULT 'manual'",
    "ALTER TABLE attendances ADD COLUMN location TEXT",
    "ALTER TABLE attendances ADD COLUMN vehicle_type TEXT",
    "ALTER TABLE attendances ADD COLUMN problem_type TEXT",
    "ALTER TABLE attendances ADD COLUMN urgency TEXT DEFAULT 'normal'",
    "ALTER TABLE services ADD COLUMN provider_id TEXT",
    "ALTER TABLE services ADD COLUMN eta_minutes INTEGER",
    "ALTER TABLE providers ADD COLUMN address_text TEXT",
    "ALTER TABLE attendances ADD COLUMN started_at TEXT",
    "ALTER TABLE attendances ADD COLUMN finished_at TEXT",
    "ALTER TABLE attendances ADD COLUMN destination_address TEXT",
    "ALTER TABLE attendances ADD COLUMN provider_id TEXT",
    "ALTER TABLE attendances ADD COLUMN provider_name TEXT",
    "ALTER TABLE attendances ADD COLUMN provider_phone TEXT",
    "ALTER TABLE attendances ADD COLUMN provider_price REAL",
    "ALTER TABLE attendances ADD COLUMN eta_minutes INTEGER",
    "ALTER TABLE attendances ADD COLUMN alarm_last_at TEXT",
    "ALTER TABLE attendances ADD COLUMN block_reason TEXT",
    "ALTER TABLE attendances ADD COLUMN distance_km REAL",
    "ALTER TABLE attendances ADD COLUMN duration_min INTEGER",
    "ALTER TABLE attendances ADD COLUMN plan_used TEXT",
    "ALTER TABLE attendances ADD COLUMN plan_max_km INTEGER",
    "ALTER TABLE attendances ADD COLUMN excess_km REAL",
    "ALTER TABLE attendances ADD COLUMN excess_charge REAL",
    "ALTER TABLE negotiations ADD COLUMN eta_minutes INTEGER",
    "ALTER TABLE negotiations ADD COLUMN score REAL",
    "ALTER TABLE negotiations ADD COLUMN distance_km REAL",
    "ALTER TABLE negotiations ADD COLUMN response_text TEXT",
    "ALTER TABLE negotiations ADD COLUMN quote_round_id TEXT",
    "ALTER TABLE negotiations ADD COLUMN invoice_info TEXT",
    "ALTER TABLE negotiations ADD COLUMN invoice_awaiting INTEGER DEFAULT 0",
    "ALTER TABLE providers ADD COLUMN plan_price_per_km REAL",
    "ALTER TABLE providers ADD COLUMN issues_invoice INTEGER DEFAULT 1",
    "ALTER TABLE providers ADD COLUMN photo_path TEXT",
    "ALTER TABLE providers ADD COLUMN place_id TEXT",
    "ALTER TABLE providers ADD COLUMN external_source TEXT",
    "ALTER TABLE providers ADD COLUMN first_contacted_at TEXT",
    "ALTER TABLE providers ADD COLUMN is_test INTEGER DEFAULT 0",
    "ALTER TABLE attendances ADD COLUMN observation TEXT",
    "ALTER TABLE attendances ADD COLUMN google_debug_json TEXT",
    "ALTER TABLE attendances ADD COLUMN protocol TEXT",
    "ALTER TABLE attendances ADD COLUMN gestor_media_json TEXT",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch {}
  }
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_attendances_protocol ON attendances(protocol)");
  } catch {}
  try {
    backfillAttendanceProtocols();
  } catch (err) {
    logger?.warn?.({ err: err?.message }, "Falha ao backfill de protocolos");
  }
}

/**
 * Gera protocolo curto e legivel no formato NM-YYMMDD-NNNN.
 * NNNN reinicia todo dia com base nos protocolos ja gravados naquela data.
 */
function generateAttendanceProtocol(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const prefix = `NM-${yy}${mm}${dd}-`;
  const row = db
    .prepare(
      "SELECT protocol FROM attendances WHERE protocol LIKE ? ORDER BY protocol DESC LIMIT 1"
    )
    .get(`${prefix}%`);
  let seq = 1;
  if (row?.protocol) {
    const n = parseInt(row.protocol.split("-").pop(), 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

function backfillAttendanceProtocols() {
  const rows = db
    .prepare("SELECT id, created_at FROM attendances WHERE protocol IS NULL OR protocol = '' ORDER BY created_at ASC")
    .all();
  if (!rows.length) return;
  const update = db.prepare("UPDATE attendances SET protocol = ? WHERE id = ?");
  const tx = db.transaction((items) => {
    for (const r of items) {
      const d = r.created_at ? new Date(String(r.created_at).replace(" ", "T") + "Z") : new Date();
      const p = generateAttendanceProtocol(d);
      update.run(p, r.id);
    }
  });
  tx(rows);
}

function getSetting(key, defaultValue = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? defaultValue;
}

function runSeed() {
  const defaultBusinessRules = {
    limits: {
      reboque: { per_month: 2, per_year: 12 },
      carga_bateria: { per_month: 4, per_year: 24 },
      troca_pneu: { per_month: 4, per_year: 24 },
      combustivel: { per_month: 2, per_year: 12 },
      chaveiro: { per_month: 2, per_year: 12 },
    },
    plans: {
      basic: { max_km: 100 },
      plus: { max_km: 300 },
      default_plan: "basic",
      price_per_km_excess: 5.0,
    },
    alarm: {
      interval_minutes: 10,
    },
    scoring: {
      price_weight: 0.6,
      time_weight: 0.4,
      wait_minutes: 10,
      max_providers: 5,
    },
  };
  const defaults = [
    ["whatsapp_connected", "false"],
    ["whatsapp_number", ""],
    ["welcome_message", "Olá! Sou a assistente virtual da SGA Assistência."],
    ["sga_validate_associates", "false"],
    ["association_pix_key", ""],
    ["gestor_whatsapp", ""],
    ["non_associate_markup_percent", "10"],
    ["allow_non_associate_service", "true"],
    ["quote_client_offer_minutes", "3"],
    ["quote_client_confirm_minutes", "5"],
    ["business_rules", JSON.stringify(defaultBusinessRules)],
  ];
  for (const [key, value] of defaults) {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
  const cur = db.prepare("SELECT value FROM settings WHERE key = 'welcome_message'").get();
  if (cur?.value && cur.value.includes("?")) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'welcome_message'").run(
      "Olá! Sou a assistente virtual da SGA Assistência."
    );
    logger.info("welcome_message corrigida (removida pergunta do boas-vindas)");
  }
  try {
    const r = db
      .prepare("UPDATE providers SET is_test = 1 WHERE lower(name) LIKE '%rayssa%' AND lower(name) LIKE '%reboque%'")
      .run();
    if (r.changes > 0) {
      logger.info({ changes: r.changes }, "Prestador(es) de teste (Rayssa Reboque) marcado(s) com is_test=1");
    }
  } catch (err) {
    logger.warn({ err }, "Seed is_test prestador de teste");
  }
}

app.get("/", (req, res) => {
  if (HAS_WEB_CLIENT_BUILD) {
    res.sendFile(path.join(WEB_CLIENT_DIST, "index.html"));
  } else {
    res.sendFile(path.join(__dirname, "index.html"));
  }
});

app.get("/api/settings", (req, res) => {
  const settings = {};
  db.prepare("SELECT key, value FROM settings").all().forEach(s => settings[s.key] = s.value);
  res.json(settings);
});

app.post("/api/settings", (req, res) => {
  const { key, value } = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
  res.json({ success: true });
});

app.post("/api/settings/batch", (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
  }
  res.json({ success: true });
});

app.get("/api/statistics", (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const total = db.prepare("SELECT COUNT(*) as n FROM attendances").get();
  const todayTotal = db.prepare("SELECT COUNT(*) as n FROM attendances WHERE date(created_at) = date(?)").get(today);
  const inProgress = db.prepare("SELECT COUNT(*) as n FROM attendances WHERE status = 'in_progress'").get();
  const completed = db.prepare("SELECT COUNT(*) as n FROM attendances WHERE status = 'completed'").get();
  const recent = db.prepare("SELECT * FROM attendances ORDER BY created_at DESC LIMIT 10").all();
  const byService = db.prepare("SELECT service_type, COUNT(*) as count FROM attendances WHERE service_type IS NOT NULL GROUP BY service_type").all();
  res.json({ total: total.n, today: todayTotal.n, in_progress: inProgress.n, completed: completed.n, recent: recent, by_service: byService });
});

app.get("/api/attendance", (req, res) => {
  const { status, date } = req.query;
  let query = "SELECT * FROM attendances WHERE 1=1";
  const params = [];
  if (status) { query += " AND status = ?"; params.push(status); }
  if (date) { query += " AND date(created_at) = date(?)"; params.push(date); }
  query += " ORDER BY created_at DESC";
  res.json(db.prepare(query).all(...params));
});

app.get("/api/attendance/:id", (req, res) => {
  const attendance = db.prepare("SELECT * FROM attendances WHERE id = ?").get(req.params.id);
  if (!attendance) return res.status(404).json({ error: "Não encontrado" });
  attendance.logs = db.prepare("SELECT * FROM attendance_logs WHERE attendance_id = ? ORDER BY created_at").all(req.params.id);
  res.json(attendance);
});

/**
 * Exclui TODOS os atendimentos e dados derivados (servicos, negociacoes, logs, auditoria).
 * Requer header "x-confirm-delete-all: YES" para evitar acidente.
 */
app.delete("/api/attendances", (req, res) => {
  const confirm = String(req.headers["x-confirm-delete-all"] || req.query.confirm || "").toUpperCase();
  if (confirm !== "YES") {
    return res.status(400).json({
      error: "Confirmacao ausente. Envie o header x-confirm-delete-all: YES ou ?confirm=YES.",
    });
  }
  const before = db.prepare("SELECT COUNT(*) AS c FROM attendances").get()?.c || 0;
  const tx = db.transaction(() => {
    try { db.prepare("DELETE FROM negotiations").run(); } catch {}
    try { db.prepare("DELETE FROM attendance_logs").run(); } catch {}
    try { db.prepare("DELETE FROM services").run(); } catch {}
    try { db.prepare("DELETE FROM audit_logs WHERE entity_type = 'attendance'").run(); } catch {}
    try { db.prepare("DELETE FROM attendances").run(); } catch {}
  });
  tx();
  try { io.emit("attendances:purged", { count: before }); } catch {}
  logger.warn({ deleted: before }, "Todos os atendimentos foram excluidos pela UI");
  res.json({ success: true, deleted: before });
});

/** Painel de acompanhamento: atendimento + serviço + negociações + debug Google persistido */
app.get("/api/attendance/:id/tracking", (req, res) => {
  const id = req.params.id;
  const attendance = db.prepare("SELECT * FROM attendances WHERE id = ?").get(id);
  if (!attendance) return res.status(404).json({ error: "Não encontrado" });
  let googleDebug = {};
  try {
    googleDebug = attendance.google_debug_json ? JSON.parse(attendance.google_debug_json) : {};
  } catch {
    googleDebug = { parseError: true };
  }
  const services = db.prepare("SELECT * FROM services WHERE attendance_id = ? ORDER BY created_at DESC").all(id);
  const negotiations = db
    .prepare(
      `SELECT n.*, p.name AS provider_name_full, p.phone AS provider_phone_full
       FROM negotiations n
       INNER JOIN services s ON s.id = n.service_id
       LEFT JOIN providers p ON p.id = n.provider_id
       WHERE s.attendance_id = ?
       ORDER BY n.contacted_at ASC`
    )
    .all(id);
  let notesParsed = null;
  try {
    notesParsed = attendance.notes ? JSON.parse(attendance.notes) : null;
  } catch {
    notesParsed = attendance.notes;
  }
  res.json({
    attendance: { ...attendance, google_debug_json: undefined },
    google_debug: googleDebug,
    services,
    negotiations,
    logs: db.prepare("SELECT * FROM attendance_logs WHERE attendance_id = ? ORDER BY created_at").all(id),
    notes_parsed: notesParsed,
    env_flags: {
      whatsapp_inbound_disabled: process.env.WHATSAPP_INBOUND_DISABLED === "true",
      test_mode: (getSetting("test_mode") || "").toLowerCase() === "true" || process.env.TEST_MODE === "true",
      google_maps_configured: !!process.env.GOOGLE_MAPS_API_KEY?.trim(),
    },
  });
});

/** Pré-visualização da busca Places (sem atendimento) — útil para testar com WhatsApp desligado */
app.post("/api/debug/google-nearby-preview", async (req, res) => {
  try {
    const { lat, lng, serviceType, radiusMeters } = req.body || {};
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) {
      return res.status(400).json({ error: "Informe lat e lng numéricos" });
    }
    const { keywordForServiceType, searchNearbyTowProvidersDebug } = await import("./lib/distance.js");
    const keyword = keywordForServiceType(serviceType);
    const { results, debug } = await searchNearbyTowProvidersDebug({
      lat: la,
      lng: ln,
      radiusMeters: Number(radiusMeters) || 20000,
      keyword,
    });
    res.json({
      keyword,
      resultCount: results.length,
      results: results.slice(0, 20),
      debug,
    });
  } catch (err) {
    logger.error({ err }, "POST /api/debug/google-nearby-preview");
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get("/api/system/test-flags", (req, res) => {
  res.json({
    WHATSAPP_INBOUND_DISABLED: process.env.WHATSAPP_INBOUND_DISABLED === "true",
    TEST_MODE: (getSetting("test_mode") || "").toLowerCase() === "true" || process.env.TEST_MODE === "true",
    GOOGLE_MAPS_API_KEY: !!process.env.GOOGLE_MAPS_API_KEY?.trim(),
  });
});

/**
 * Últimas mensagens inbound com payload bruto do Evolution — extrai `remoteJid` / `remoteJidAlt` para diagnóstico.
 * Requer header `x-diagnostic-secret` = variável de ambiente DIAGNOSTIC_SECRET (defina no .env).
 */
app.get("/api/debug/whatsapp-inbound", (req, res) => {
  const secret = String(process.env.DIAGNOSTIC_SECRET || "").trim();
  if (!secret) {
    return res.status(403).json({
      error:
        "Defina DIAGNOSTIC_SECRET no .env do auto-attendance e reinicie. Depois chame com header x-diagnostic-secret igual ao valor.",
    });
  }
  if (String(req.headers["x-diagnostic-secret"] || "") !== secret) {
    return res.status(403).json({ error: "Header x-diagnostic-secret inválido ou ausente." });
  }
  const limit = Math.min(30, Math.max(1, parseInt(String(req.query.limit || "10"), 10) || 10));
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT id, phone, direction, content, created_at, raw_payload
         FROM messages
         WHERE direction = 'inbound' AND raw_payload IS NOT NULL AND length(trim(raw_payload)) > 2
         ORDER BY datetime(created_at) DESC
         LIMIT ?`
      )
      .all(limit);
  } catch (err) {
    logger.error({ err }, "GET /api/debug/whatsapp-inbound");
    return res.status(500).json({ error: String(err?.message || err) });
  }

  const out = rows.map((r) => {
    let keyInfo = null;
    let eventName = null;
    try {
      const root = JSON.parse(r.raw_payload);
      eventName = root?.event || null;
      const data = root?.data ?? root;
      const key = data?.key || {};
      keyInfo = {
        remoteJid: key.remoteJid || null,
        remoteJidAlt: key.remoteJidAlt || null,
        fromMe: key.fromMe,
        participant: key.participant || null,
        addressingMode: key.addressingMode || null,
        id: key.id || null,
        digitsUsadosPeloServidor: digitsFromInboundMessageKey(key) || null,
        phoneNormalizadoGravadoNaTabelaMessages: r.phone,
      };
    } catch {
      keyInfo = { parseError: "raw_payload não é JSON válido" };
    }
    return {
      messageRowId: r.id,
      created_at: r.created_at,
      contentPreview: String(r.content || "").slice(0, 160),
      event: eventName,
      key: keyInfo,
    };
  });

  res.json({
    hint: "O JID está em key.remoteJid ou key.remoteJidAlt (trecho antes do @). Formato telefone termina em @s.whatsapp.net.",
    count: out.length,
    items: out,
  });
});

/**
 * Força `UPDATE messages SET phone = chave_canônica` em todas as linhas (agrupa threads duplicadas).
 * Mesmo critério do startup; requer `x-diagnostic-secret` = DIAGNOSTIC_SECRET.
 */
app.post("/api/debug/normalize-message-threads", (req, res) => {
  const secret = String(process.env.DIAGNOSTIC_SECRET || "").trim();
  if (!secret) {
    return res.status(403).json({
      error:
        "Defina DIAGNOSTIC_SECRET no .env do auto-attendance e reinicie. Depois chame com header x-diagnostic-secret igual ao valor.",
    });
  }
  if (String(req.headers["x-diagnostic-secret"] || "") !== secret) {
    return res.status(403).json({ error: "Header x-diagnostic-secret inválido ou ausente." });
  }
  try {
    const rowsUpdated = normalizeMessagesThreadKeys(db);
    try {
      io.emit("conversations:normalized", { rowsUpdated, at: new Date().toISOString() });
    } catch {}
    res.json({ ok: true, rowsUpdated });
  } catch (err) {
    logger.error({ err }, "POST /api/debug/normalize-message-threads");
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post("/api/attendance/start", (req, res) => {
  const { caller_id } = req.body;
  const id = uuidv4();
  db.prepare("INSERT INTO attendances (id, caller_id, status) VALUES (?, ?, 'in_progress')").run(id, caller_id);
  res.json({ id, caller_id });
});

app.post("/api/attendance/:id/update", (req, res) => {
  const { customer_name, vehicle_plate, service_type, sga_response, status, notes } = req.body;
  const fields = [];
  const values = [];
  if (customer_name !== undefined) { fields.push("customer_name = ?"); values.push(customer_name); }
  if (vehicle_plate !== undefined) { fields.push("vehicle_plate = ?"); values.push(vehicle_plate); }
  if (service_type !== undefined) { fields.push("service_type = ?"); values.push(service_type); }
  if (sga_response !== undefined) { fields.push("sga_response = ?"); values.push(JSON.stringify(sga_response)); }
  if (status !== undefined) { fields.push("status = ?"); values.push(status); }
  if (notes !== undefined) { fields.push("notes = ?"); values.push(notes); }
  fields.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE attendances SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

app.post("/api/attendance/:id/log", (req, res) => {
  const { step, question, answer } = req.body;
  db.prepare("INSERT INTO attendance_logs (attendance_id, step, question, answer) VALUES (?, ?, ?, ?)").run(req.params.id, step, question, answer);
  res.json({ success: true });
});

function emitAttendanceUpdated(id) {
  try {
    const row = db.prepare("SELECT * FROM attendances WHERE id = ?").get(id);
    if (row && io) io.emit("attendance:updated", row);
  } catch (err) {
    logger.warn({ err }, "emitAttendanceUpdated falhou");
  }
}

app.post("/api/attendance/:id/start", (req, res) => {
  const row = db.prepare("SELECT * FROM attendances WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Não encontrado" });
  if (row.started_at) return res.json({ success: true, already: true, started_at: row.started_at });
  db.prepare(
    "UPDATE attendances SET started_at = datetime('now'), status = 'in_progress', updated_at = datetime('now') WHERE id = ?"
  ).run(req.params.id);
  emitAttendanceUpdated(req.params.id);
  res.json({ success: true });
});

app.post("/api/attendance/:id/finish", (req, res) => {
  const row = db.prepare("SELECT * FROM attendances WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Não encontrado" });
  db.prepare(
    "UPDATE attendances SET finished_at = datetime('now'), status = 'completed', updated_at = datetime('now') WHERE id = ?"
  ).run(req.params.id);
  try {
    db.prepare("UPDATE services SET status = 'completed', updated_at = datetime('now') WHERE attendance_id = ?").run(req.params.id);
  } catch {}
  emitAttendanceUpdated(req.params.id);
  res.json({ success: true });
});

app.put("/api/attendance/:id/provider", (req, res) => {
  const { provider_id, provider_name, provider_phone, provider_price, eta_minutes, destination_address } = req.body || {};
  const row = db.prepare("SELECT * FROM attendances WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Não encontrado" });
  const fields = [];
  const values = [];
  if (provider_id !== undefined) { fields.push("provider_id = ?"); values.push(provider_id || null); }
  if (provider_name !== undefined) { fields.push("provider_name = ?"); values.push(provider_name || null); }
  if (provider_phone !== undefined) { fields.push("provider_phone = ?"); values.push(provider_phone || null); }
  if (provider_price !== undefined) {
    const n = Number(String(provider_price).replace(",", "."));
    fields.push("provider_price = ?");
    values.push(Number.isFinite(n) ? n : null);
  }
  if (eta_minutes !== undefined) {
    const n = parseInt(eta_minutes, 10);
    fields.push("eta_minutes = ?");
    values.push(Number.isFinite(n) ? n : null);
  }
  if (destination_address !== undefined) { fields.push("destination_address = ?"); values.push(destination_address || null); }
  if (!fields.length) return res.json({ success: true });
  fields.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE attendances SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  emitAttendanceUpdated(req.params.id);
  res.json({ success: true });
});

app.post("/api/attendance/:id/alarm-ack", (req, res) => {
  db.prepare(
    "UPDATE attendances SET alarm_last_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(req.params.id);
  emitAttendanceUpdated(req.params.id);
  res.json({ success: true });
});

const DEFAULT_RULES = {
  limits: {},
  plans: { basic: { max_km: 100 }, plus: { max_km: 300 }, default_plan: "basic", price_per_km_excess: 5.0 },
  alarm: { interval_minutes: 10 },
  scoring: { price_weight: 0.6, time_weight: 0.4, wait_minutes: 10, max_providers: 5 },
};

function getBusinessRules() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'business_rules'").get();
  let parsed;
  try {
    parsed = row?.value ? JSON.parse(row.value) : {};
  } catch {
    parsed = {};
  }
  return {
    limits: parsed.limits || {},
    plans: {
      basic: { max_km: parsed?.plans?.basic?.max_km ?? DEFAULT_RULES.plans.basic.max_km },
      plus: { max_km: parsed?.plans?.plus?.max_km ?? DEFAULT_RULES.plans.plus.max_km },
      default_plan: parsed?.plans?.default_plan ?? DEFAULT_RULES.plans.default_plan,
      price_per_km_excess: parsed?.plans?.price_per_km_excess ?? DEFAULT_RULES.plans.price_per_km_excess,
    },
    alarm: { interval_minutes: parsed?.alarm?.interval_minutes ?? DEFAULT_RULES.alarm.interval_minutes },
    scoring: {
      price_weight: parsed?.scoring?.price_weight ?? DEFAULT_RULES.scoring.price_weight,
      time_weight: parsed?.scoring?.time_weight ?? DEFAULT_RULES.scoring.time_weight,
      wait_minutes: parsed?.scoring?.wait_minutes ?? DEFAULT_RULES.scoring.wait_minutes,
      max_providers: (() => {
        const rawMp = Number(parsed?.scoring?.max_providers ?? DEFAULT_RULES.scoring.max_providers);
        return Number.isFinite(rawMp) ? Math.min(5, Math.max(1, rawMp)) : 5;
      })(),
    },
  };
}

app.get("/api/business-rules", (req, res) => {
  res.json(getBusinessRules());
});

app.put("/api/business-rules", (req, res) => {
  const body = req.body || {};
  const current = getBusinessRules();
  const merged = {
    limits: body.limits && typeof body.limits === "object" ? body.limits : current.limits,
    plans: body.plans && typeof body.plans === "object" ? { ...current.plans, ...body.plans } : current.plans,
    alarm: body.alarm && typeof body.alarm === "object" ? { ...current.alarm, ...body.alarm } : current.alarm,
    scoring: body.scoring && typeof body.scoring === "object" ? { ...current.scoring, ...body.scoring } : current.scoring,
  };
  if (merged.scoring) {
    const pW = Number(merged.scoring.price_weight);
    const tW = Number(merged.scoring.time_weight);
    if (Number.isFinite(pW) && Number.isFinite(tW) && pW + tW > 0) {
      merged.scoring.price_weight = pW / (pW + tW);
      merged.scoring.time_weight = tW / (pW + tW);
    }
    const mp = Number(merged.scoring.max_providers);
    if (Number.isFinite(mp)) {
      merged.scoring.max_providers = Math.min(5, Math.max(1, mp));
    }
  }
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_rules', ?, datetime('now'))"
  ).run(JSON.stringify(merged));
  res.json({ success: true, rules: merged });
});

app.get("/api/customer-usage", (req, res) => {
  const phone = String(req.query.phone || "").trim();
  if (!phone) return res.status(400).json({ error: "phone obrigatório" });
  const perMonth = db
    .prepare(
      "SELECT service_type, COUNT(*) as n FROM attendances WHERE caller_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') AND status != 'blocked' GROUP BY service_type"
    )
    .all(phone);
  const perYear = db
    .prepare(
      "SELECT service_type, COUNT(*) as n FROM attendances WHERE caller_id = ? AND strftime('%Y', created_at) = strftime('%Y', 'now') AND status != 'blocked' GROUP BY service_type"
    )
    .all(phone);
  const totalMonth = perMonth.reduce((s, r) => s + Number(r.n || 0), 0);
  const totalYear = perYear.reduce((s, r) => s + Number(r.n || 0), 0);
  res.json({
    phone,
    month: Object.fromEntries(perMonth.map((r) => [r.service_type || "outro", Number(r.n || 0)])),
    year: Object.fromEntries(perYear.map((r) => [r.service_type || "outro", Number(r.n || 0)])),
    total_month: totalMonth,
    total_year: totalYear,
  });
});

app.post("/api/distance", async (req, res) => {
  try {
    const { calculateDistance, geocodeAddress } = await import("./lib/distance.js");
    const { origin, destination } = req.body || {};
    let o = origin;
    let d = destination;
    if (typeof o === "string") o = (await geocodeAddress(o)) || o;
    if (typeof d === "string") d = (await geocodeAddress(d)) || d;
    const result = await calculateDistance({ origin: o, destination: d });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Falha ao calcular distância");
    res.status(500).json({ error: "Falha ao calcular distância" });
  }
});

app.get("/api/attendance/:id/negotiations", (req, res) => {
  const rows = db
    .prepare(
      `SELECT n.*, p.name AS provider_name_full, p.phone AS provider_phone_full, p.whatsapp AS provider_whatsapp
         FROM negotiations n
         LEFT JOIN providers p ON p.id = n.provider_id
         LEFT JOIN services s ON s.id = n.service_id
         WHERE s.attendance_id = ?
         ORDER BY n.contacted_at ASC`
    )
    .all(req.params.id);
  res.json(rows);
});

app.post("/api/attendance/:id/start-quotes", async (req, res) => {
  try {
    const att = db.prepare("SELECT * FROM attendances WHERE id = ?").get(req.params.id);
    if (!att) return res.status(404).json({ error: "atendimento não encontrado" });
    const svc = db.prepare("SELECT * FROM services WHERE attendance_id = ? ORDER BY created_at DESC LIMIT 1").get(att.id);
    if (!svc) return res.status(400).json({ error: "serviço não encontrado para o atendimento" });
    let notesObj = {};
    try {
      notesObj = att.notes ? JSON.parse(att.notes) : {};
    } catch {
      notesObj = {};
    }
    const locationText =
      att.location || notesObj.location || notesObj.location_text || att.location_address || "";
    const ticket = {
      attendanceId: att.id,
      protocol: att.protocol || null,
      serviceId: svc.id,
      phoneNumber: att.caller_id,
      customerName: att.customer_name,
      serviceType: svc.service_type,
      vehiclePlate: att.vehicle_plate,
      vehicleType: att.vehicle_type,
      towingAccess: att.towing_access,
      location: locationText,
      destination: att.destination_address || notesObj.destination || "",
      locationLat: att.location_lat ?? notesObj.location_lat ?? null,
      locationLng: att.location_lng ?? notesObj.location_lng ?? null,
    };
    await orchestrator._computeDistanceAndPlan(ticket);
    await orchestrator._startQuoteRound(ticket);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Falha ao iniciar cotações");
    res.status(500).json({ error: "Falha ao iniciar cotações" });
  }
});

app.get("/api/services", (req, res) => {
  const { status } = req.query;
  let query = `
    SELECT s.*,
      a.started_at AS attendance_started_at,
      a.finished_at AS attendance_finished_at,
      a.protocol AS attendance_protocol,
      a.eta_minutes AS attendance_eta_minutes
    FROM services s
    LEFT JOIN attendances a ON a.id = s.attendance_id
    WHERE 1=1`;
  const params = [];
  if (status) {
    query += " AND s.status = ?";
    params.push(status);
  }
  query += " ORDER BY s.created_at DESC";
  res.json(db.prepare(query).all(...params));
});

app.get("/api/services/:id", (req, res) => {
  const svc = db.prepare("SELECT * FROM services WHERE id = ?").get(req.params.id);
  if (!svc) return res.status(404).json({ error: "Não encontrado" });
  const att = db.prepare("SELECT * FROM attendances WHERE id = ?").get(svc.attendance_id);
  let detail = {};
  try {
    detail = svc.notes ? JSON.parse(svc.notes) : {};
  } catch {
    detail = {};
  }
  if (att?.notes) {
    try {
      const an = JSON.parse(att.notes);
      detail = { ...an, ...detail };
    } catch {
      /* ignore */
    }
  }
  res.json({ ...svc, attendance: att || null, detail });
});

app.post("/api/services", (req, res) => {
  const { attendance_id, plate, service_type, customer_name, customer_phone } = req.body;
  const id = uuidv4();
  db.prepare("INSERT INTO services (id, attendance_id, plate, service_type, customer_name, customer_phone, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')").run(id, attendance_id, plate, service_type, customer_name, customer_phone);
  res.json({ id, success: true });
});

app.put("/api/services/:id", (req, res) => {
  const { status, provider_name, price, notes } = req.body;
  const fields = [];
  const values = [];
  if (status !== undefined) { fields.push("status = ?"); values.push(status); }
  if (provider_name !== undefined) { fields.push("provider_name = ?"); values.push(provider_name); }
  if (price !== undefined) { fields.push("price = ?"); values.push(price); }
  if (notes !== undefined) { fields.push("notes = ?"); values.push(notes); }
  fields.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE services SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

app.get("/api/providers", (req, res) => {
  try {
    res.json(db.prepare("SELECT * FROM providers WHERE active = 1 ORDER BY rating DESC").all());
  } catch (err) {
    logger.error({ err }, "GET /api/providers");
    res.json([]);
  }
});

app.post("/api/providers", (req, res) => {
  try {
    const { name, phone, whatsapp, services, latitude, longitude, address_text } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Nome é obrigatório" });
    }

    const parseBr = (v) => {
      if (v == null || v === "") return null;
      const n = parseFloat(String(v).replace(",", ".").trim());
      return Number.isFinite(n) ? n : null;
    };
    const lat = parseBr(latitude);
    const lng = parseBr(longitude);
    const addr = address_text ? String(address_text).trim() : "";

    const hasAddr = db.prepare("PRAGMA table_info(providers)").all().some((c) => c.name === "address_text");
    const id = uuidv4();

    if (hasAddr) {
      db.prepare(
        "INSERT INTO providers (id, name, phone, whatsapp, services, latitude, longitude, address_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(id, name, phone || null, whatsapp || null, services || "", lat, lng, addr);
    } else {
      db.prepare(
        "INSERT INTO providers (id, name, phone, whatsapp, services, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(id, name, phone || null, whatsapp || null, services || "", lat, lng);
    }
    res.json({ id, success: true });
  } catch (err) {
    logger.error({ err }, "POST /api/providers");
    res.status(500).json({ error: String(err?.message || "Erro ao salvar prestador") });
  }
});

app.put("/api/providers/:id", (req, res) => {
  const id = req.params.id;
  const existing = db.prepare("SELECT * FROM providers WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Prestador não encontrado" });
  const body = req.body || {};

  const parseBr = (v) => {
    if (v == null || v === "") return null;
    const n = parseFloat(String(v).replace(",", ".").trim());
    return Number.isFinite(n) ? n : null;
  };

  const fields = [];
  const values = [];
  const map = {
    name: body.name,
    phone: body.phone,
    whatsapp: body.whatsapp,
    services: body.services,
    address_text: body.address_text,
    latitude: body.latitude != null ? parseBr(body.latitude) : undefined,
    longitude: body.longitude != null ? parseBr(body.longitude) : undefined,
    available: body.available != null ? (body.available ? 1 : 0) : undefined,
    issues_invoice: body.issues_invoice != null ? (body.issues_invoice ? 1 : 0) : undefined,
    is_test: body.is_test != null ? (body.is_test ? 1 : 0) : undefined,
  };
  for (const [col, val] of Object.entries(map)) {
    if (val !== undefined) {
      fields.push(`${col} = ?`);
      values.push(val);
    }
  }
  if (!fields.length) return res.json({ success: true, noop: true });
  values.push(id);
  db.prepare(`UPDATE providers SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

app.delete("/api/providers/:id", (req, res) => {
  db.prepare("UPDATE providers SET active = 0 WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.put("/api/attendance/:id/observation", (req, res) => {
  const id = req.params.id;
  const obs = typeof req.body?.observation === "string" ? req.body.observation : "";
  const exists = db.prepare("SELECT id FROM attendances WHERE id = ?").get(id);
  if (!exists) return res.status(404).json({ error: "Atendimento não encontrado" });
  db.prepare("UPDATE attendances SET observation = ?, updated_at = datetime('now') WHERE id = ?").run(obs, id);
  try {
    io.emit("attendance:updated", { id });
  } catch {}
  res.json({ success: true });
});

app.post("/api/audio/upload", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });
  res.json({ success: true, filename: req.file.filename, path: `/audio/${req.file.filename}` });
});

app.get("/api/audio", (req, res) => {
  const dir = path.join(__dirname, "audio");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  res.json(files.map(f => ({ name: f, path: `/audio/${f}` })));
});

app.delete("/api/audio/:filename", (req, res) => {
  const filepath = path.join(__dirname, "audio", req.params.filename);
  if (fs.existsSync(filepath)) { fs.unlinkSync(filepath); res.json({ success: true }); }
  else res.status(404).json({ error: "Arquivo não encontrado" });
});

async function checkEvolutionStatus() {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    return { connected: false, error: "Evolution API não configurada" };
  }
  
  try {
    const response = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${whatsappInstance}`, {
      headers: { "apikey": EVOLUTION_API_KEY }
    });
    return { connected: response.data.instance?.state === "open", state: response.data.instance?.state };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

async function getEvolutionQR() {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return null;
  
  try {
    const response = await axios.get(`${EVOLUTION_API_URL}/instance/connect/${whatsappInstance}`, {
      headers: { "apikey": EVOLUTION_API_KEY }
    });
    if (response.data.base64) {
      return response.data.base64;
    }
    if (response.data.qrcode?.base64) {
      return response.data.qrcode.base64;
    }
    return null;
  } catch (err) {
    logger.error({ err }, "Erro ao buscar QR Code");
    return null;
  }
}

async function connectEvolution() {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    logger.warn("Evolution API não configurada");
    return;
  }

  try {
    await axios.post(`${EVOLUTION_API_URL}/instance/connect/${whatsappInstance}`, {}, {
      headers: { "apikey": EVOLUTION_API_KEY }
    });
    logger.info("Solicitando conexão Evolution API...");
  } catch (err) {
    logger.error({ err }, "Erro ao conectar Evolution API");
  }
}

io.on("connection", (socket) => {
  logger.info("Cliente socket conectado");
  
  socket.emit("whatsapp:status", { 
    connected: whatsappConnected, 
    number: whatsappNumber,
    qr: null 
  });
});

// Endpoints WhatsApp
app.get("/api/whatsapp/status", async (req, res) => {
  const status = await checkEvolutionStatus();
  whatsappConnected = status.connected;
  res.json({ connected: status.connected, state: status.state, error: status.error });
});

app.get("/api/whatsapp/qr", async (req, res) => {
  const qr = await getEvolutionQR();
  if (qr) {
    res.json({ qr });
  } else {
    res.json({ qr: null, message: "QR Code não disponível" });
  }
});

app.post("/api/whatsapp/connect", async (req, res) => {
  if (!EVOLUTION_API_URL) {
    return res.status(400).json({ error: "Configure EVOLUTION_API_URL no .env" });
  }
  await connectEvolution();
  res.json({ success: true, message: "Conectando..." });
});

app.post("/api/whatsapp/send", async (req, res) => {
  const { to, message } = req.body;
  try {
    await sendEvolutionMessage(to, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/whatsapp/send-service", async (req, res) => {
  const { to, data } = req.body;
  const message = `🔔 *Novo Serviço*

📍 Placa: ${data.plate}
🔧 Serviço: ${data.service_type}
👤 Cliente: ${data.customer_name}
📞 Tel: ${data.customer_phone}

Aguarde, localizando prestador...`;
  
  try {
    await sendEvolutionMessage(to, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Deduplicação: Evolution API envia o mesmo evento para a URL base E para a
 * sub-rota (ex.: /webhook E /webhook/messages-upsert). Sem dedup, cada
 * mensagem é processada 2×, causando 2 perguntas por vez e dados errados.
 */
const _recentMsgIds = new Map();
const DEDUP_TTL_MS = 60_000;
setInterval(() => {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [k, ts] of _recentMsgIds) {
    if (ts < cutoff) _recentMsgIds.delete(k);
  }
}, 30_000);

function isDuplicateWebhookMsg(payload) {
  const msgId =
    payload?.data?.key?.id ||
    payload?.data?.id ||
    payload?.key?.id ||
    null;
  if (!msgId) return false;
  if (_recentMsgIds.has(msgId)) return true;
  _recentMsgIds.set(msgId, Date.now());
  return false;
}

// Webhook para receber mensagens da Evolution API (rota base + sub-rotas do v2)
app.post("/api/whatsapp/webhook/:event?", async (req, res) => {
  res.json({ received: true });

  try {
    const payload = req.body;
    const eventParam = req.params.event;
    const event = payload.event || (eventParam ? eventParam.replace(/-/g, ".").replace("_", ".").toUpperCase() : "");

    logger.info({ event, eventParam }, "Webhook recebido da Evolution API");

    if (event === "connection.update" || event === "CONNECTION.UPDATE") {
      const state = payload.data?.state || payload.state;
      if (state === "open") {
        whatsappConnected = true;
        whatsappNumber = payload.data?.instance?.wuid?.split(":")[0] || "";
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("whatsapp_connected", "true");
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("whatsapp_number", whatsappNumber);
        io.emit("whatsapp:status", { connected: true, number: whatsappNumber });
        logger.info({ number: whatsappNumber }, "WhatsApp conectado com sucesso!");
      } else if (state === "close") {
        whatsappConnected = false;
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("whatsapp_connected", "false");
        io.emit("whatsapp:status", { connected: false });
        logger.warn("WhatsApp desconectado");
      }
      return;
    }

    if (event === "messages.upsert" || event === "MESSAGES.UPSERT") {
      if (isDuplicateWebhookMsg(payload)) {
        logger.info({ event, eventParam }, "Webhook duplicado ignorado (mesmo message id)");
        return;
      }

      const messageData = payload.data;
      if (!messageData || messageData.key?.fromMe) return;

      const key = messageData.key || {};
      const remoteJid = key.remoteJid || "";
      const remoteJidAlt = key.remoteJidAlt || "";
      if (remoteJid.includes("@g.us") || String(remoteJidAlt).includes("@g.us")) return;

      const phoneDigits = digitsFromInboundMessageKey(key);
      if (!phoneDigits) {
        logger.warn(
          { event, remoteJid, remoteJidAlt, addressingMode: key.addressingMode },
          "Webhook: sem JID em formato de telefone (@s.whatsapp.net / @c.us) em remoteJid nem remoteJidAlt — automação não identifica o número"
        );
        return;
      }
      const phone = resolveMessageThreadKey(phoneDigits);
      if (!phone) return;

      let textContent = "";
      let hasImage = false;
      if (messageData.message?.conversation) {
        textContent = messageData.message.conversation;
      } else if (messageData.message?.extendedTextMessage?.text) {
        textContent = messageData.message.extendedTextMessage.text;
      } else if (messageData.message?.imageMessage) {
        hasImage = true;
        textContent =
          (messageData.message.imageMessage.caption || "").trim() || "[Imagem recebida]";
      } else if (messageData.message?.audioMessage) {
        textContent = "[Áudio recebido - transcrição não disponível]";
      } else if (messageData.message?.locationMessage) {
        const lat = messageData.message.locationMessage.degreesLatitude;
        const lng = messageData.message.locationMessage.degreesLongitude;
        textContent = `[Localização: ${lat}, ${lng}]`;
        const session = conversationManager.getOrCreateSession(phone);
        session.collectedData.location_lat = lat;
        session.collectedData.location_lng = lng;
        session.collectedData.location = `Lat: ${lat}, Lng: ${lng}`;
      }

      if (!textContent) {
        logger.info(
          {
            event,
            remoteJid,
            remoteJidAlt,
            participant: messageData.key?.participant || null,
            tiposDeBloco: messageData.message ? Object.keys(messageData.message) : [],
          },
          "Webhook: sem texto (áudio/imagem só, botão, etc.) — fluxo de cotação ignora até haver legenda/texto"
        );
        return;
      }

      db.prepare(
        "INSERT INTO messages (phone, direction, content, message_type, raw_payload) VALUES (?, 'inbound', ?, 'text', ?)"
      ).run(phone, textContent, JSON.stringify(payload));

      db.prepare(
        "INSERT INTO audit_logs (event_type, entity_type, entity_id, data) VALUES ('message_received', 'whatsapp', ?, ?)"
      ).run(phone, JSON.stringify({ content: textContent }));

      io.emit("whatsapp:message", { phone, content: textContent, direction: "inbound", timestamp: new Date().toISOString() });

      logger.info(
        {
          event,
          remoteJid,
          remoteJidAlt,
          addressingMode: key.addressingMode,
          participant: key.participant || null,
          phoneNormalizado: phone,
          content: textContent.slice(0, 120),
        },
        "Mensagem WhatsApp recebida (use remoteJid/remoteJidAlt no Evolution; phoneNormalizado = número interno)"
      );

      if (process.env.WHATSAPP_INBOUND_DISABLED === "true") {
        logger.warn({ phone }, "[WHATSAPP_INBOUND_DISABLED] Fluxo automático desligado — mensagem só registrada");
        try {
          io.emit("whatsapp:inbound_suppressed", {
            phone,
            reason: "WHATSAPP_INBOUND_DISABLED",
            timestamp: new Date().toISOString(),
          });
        } catch {}
        return;
      }

      const _tm = getTestModeConfig();
      if (_tm.enabled && !allowlistHasCanonical(_tm.allowlist, phone)) {
        logger.warn({ phone }, "[TEST MODE] mensagem recebida ignorada (fora da allowlist)");
        try {
          io.emit("inbound:ignored", { phone, content: textContent, reason: "test_mode", timestamp: new Date().toISOString() });
        } catch {}
        return;
      }

      if (hasImage) {
        try {
          const aux = await orchestrator.handleInboundAuxiliary(phone, textContent, payload);
          if (aux?.handled) return;
        } catch (e) {
          logger.warn({ err: e?.message }, "handleInboundAuxiliary");
        }
      }

      try {
        const cc = await orchestrator.handleClientQuoteConfirmation(phone, textContent);
        if (cc?.handled) return;
      } catch (e) {
        logger.warn({ err: e?.message }, "handleClientQuoteConfirmation");
      }

      const providerResult = await orchestrator.handleIncomingProviderMessage(phone, textContent);
      if (providerResult?.pixForwarded) {
        return;
      }
      if (providerResult) {
        logger.info({ phone, providerResult: !!providerResult.accepted }, "Resposta de prestador processada");
        if (providerResult.accepted) {
          const service = db.prepare("SELECT * FROM services WHERE id = ?").get(providerResult.provider?.id ? null : "");
          const attendance = db.prepare(
            "SELECT caller_id FROM attendances a JOIN services s ON s.attendance_id = a.id WHERE s.provider_id IS NOT NULL ORDER BY a.created_at DESC LIMIT 1"
          ).get();
          if (attendance) {
            await orchestrator.onProviderAccepted(
              null, providerResult.provider, providerResult.finalPrice, attendance.caller_id
            );
          }
        }
        return;
      }

      let result;
      if (shouldSimulateAttendance()) {
        result = await orchestrator.simulateInboundAttendance(phone, textContent);
        if (result.response) {
          try {
            await sendEvolutionMessage(phone, result.response);
            db.prepare(
              "INSERT INTO messages (phone, direction, content, message_type) VALUES (?, 'outbound', ?, 'text')"
            ).run(phone, result.response);
            io.emit("whatsapp:message", {
              phone,
              content: result.response,
              direction: "outbound",
              timestamp: new Date().toISOString(),
            });
          } catch (sendErr) {
            logger.error({ err: sendErr, phone }, "Erro ao enviar resposta WhatsApp (simulação)");
          }
        }
      } else {
        const sess = conversationManager.getSession(phone);
        const confirmOnly =
          sess?.state === STATES.CONFIRMING_DATA &&
          sess?.pendingConfirmation &&
          isConfirmation(textContent);

        if (confirmOnly) {
          conversationManager.addMessage(phone, "user", textContent);
          const ticket = await orchestrator.handleConfirmation(phone, true);
          result = {
            simulated: false,
            response: null,
            ticketData: null,
            state: conversationManager.getSession(phone)?.state,
          };
          if (ticket?.blocked) {
            logger.warn({ phone }, "Chamado bloqueado: associado não ativo no SGA");
          } else if (ticket?.attendanceId) {
            logger.info({ phone, ticketId: ticket.attendanceId }, "Ticket confirmado pelo cliente");
          }
        } else {
          result = await processMessage(phone, textContent, {
            welcomeMessage: getSetting("welcome_message"),
          });

          if (result.response) {
            try {
              await sendEvolutionMessage(phone, result.response);
              db.prepare(
                "INSERT INTO messages (phone, direction, content, message_type) VALUES (?, 'outbound', ?, 'text')"
              ).run(phone, result.response);
              io.emit("whatsapp:message", {
                phone,
                content: result.response,
                direction: "outbound",
                timestamp: new Date().toISOString(),
              });
            } catch (sendErr) {
              logger.error({ err: sendErr, phone }, "Erro ao enviar resposta WhatsApp");
            }
          }
        }
      }

      if (!result.simulated && result.ticketData && result.state === STATES.CONFIRMING_DATA) {
        logger.info({ phone, ticketData: result.ticketData }, "Dados completos, aguardando confirmação");
      }
    } else if (event === "connection.update") {
      const state = payload.data?.state;
      if (state === "open") {
        whatsappConnected = true;
        io.emit("whatsapp:connected", { number: whatsappNumber });
      } else if (state === "close") {
        whatsappConnected = false;
        io.emit("whatsapp:disconnected");
      }
    }
  } catch (err) {
    logger.error({ err }, "Erro ao processar webhook WhatsApp");
  }
});

function isConfirmation(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  if (
    /\bcancel/.test(t) ||
    /\breiniciar?\b/.test(t) ||
    /\bcomecar novamente\b/.test(t) ||
    /\brecomecar\b/.test(t) ||
    /\bnovo atendimento\b/.test(t) ||
    /\bdesistir\b/.test(t)
  ) {
    return false;
  }
  /** Confirmação explícita (evita "ok"/"s" soltos após saudação) */
  const phrases = [
    "sim",
    "confirmo",
    "confirmar",
    "pode confirmar",
    "pode prosseguir",
    "pode seguir",
    "está correto",
    "esta correto",
    "está certo",
    "esta certo",
    "isso mesmo",
    "isso aí",
    "isso ai",
    "correto",
    "certo",
    "pode ser",
    "pode criar",
    "pode registrar",
    "registra",
    "registre",
    "confirma",
    "confirmado",
    "autorizo",
    "pode enviar",
    "yes",
    "pode",
  ];
  if (phrases.some((p) => t === p || t.startsWith(p + " "))) return true;
  if (t === "tá certo" || t === "ta certo" || t.startsWith("tá certo ") || t.startsWith("ta certo ")) return true;
  return false;
}

// Endpoint para chat via web (canal web do cliente)
app.post("/api/chat/web", async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: "sessionId e message são obrigatórios" });
  }

  try {
    let result;
    db.prepare(
      "INSERT INTO messages (phone, direction, content, message_type) VALUES (?, 'inbound', ?, 'text')"
    ).run(sessionId, message);

    const quoteConfirm = await orchestrator.handleClientQuoteConfirmation(sessionId, message);
    if (quoteConfirm?.handled) {
      const session = conversationManager.getSession(sessionId);
      return res.json({
        response:
          "✅ Proposta confirmada. Estamos liberando o prestador e enviando as instruções por WhatsApp.",
        state: session?.state,
        collectedData: session?.collectedData,
        simulated: false,
      });
    }

    if (shouldSimulateAttendance()) {
      result = await orchestrator.simulateInboundAttendance(sessionId, message);
    } else {
      const sess = conversationManager.getSession(sessionId);
      const confirmOnly =
        sess?.state === STATES.CONFIRMING_DATA &&
        sess?.pendingConfirmation &&
        isConfirmation(message);

      if (confirmOnly) {
        conversationManager.addMessage(sessionId, "user", message);
        const ticket = await orchestrator.handleConfirmation(sessionId, true, { skipSendMessage: true });
        if (ticket?.blocked) {
          result = {
            simulated: false,
            response: ticket.sgaMessage,
            ticketData: null,
            state: STATES.COLLECTING_INFO,
          };
        } else if (ticket?.attendanceId) {
          result = {
            simulated: false,
            response: ticket.confirmMessage,
            ticketData: null,
            state: STATES.TICKET_CREATED,
          };
        } else {
          result = {
            simulated: false,
            response: null,
            ticketData: null,
            state: conversationManager.getSession(sessionId)?.state,
          };
        }
      } else {
        result = await processMessage(sessionId, message, {
          welcomeMessage: getSetting("welcome_message"),
        });
      }
    }

    if (result.response) {
      db.prepare(
        "INSERT INTO messages (phone, direction, content, message_type) VALUES (?, 'outbound', ?, 'text')"
      ).run(sessionId, result.response);
    }

    const session = conversationManager.getSession(sessionId);
    res.json({
      response: result.response,
      state: result.state ?? session?.state,
      collectedData: session?.collectedData,
      simulated: !!result.simulated,
    });
  } catch (err) {
    logger.error({ err, sessionId }, "Erro no chat web");
    res.status(500).json({ error: "Erro interno", response: "Desculpe, ocorreu um erro. Tente novamente." });
  }
});

app.get("/api/messages/:phone", (req, res) => {
  const phone = resolveMessageThreadKey(req.params.phone);
  if (!phone) return res.json([]);
  const messages = db.prepare(
    "SELECT * FROM messages WHERE phone = ? ORDER BY created_at DESC LIMIT 100"
  ).all(phone);
  res.json(messages);
});

app.get("/api/test-mode", (req, res) => {
  const cfg = getTestModeConfig();
  res.json({
    enabled: cfg.enabled,
    allowlist: cfg.allowlist,
    sourceEnv: process.env.TEST_MODE === "true" ? "env" : "db",
  });
});

app.put("/api/test-mode", (req, res) => {
  const { enabled, allowlist } = req.body || {};
  if (typeof enabled === "boolean") {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('test_mode', ?, datetime('now'))"
    ).run(String(enabled));
  }
  if (Array.isArray(allowlist) || typeof allowlist === "string") {
    const list = Array.isArray(allowlist) ? allowlist.join(",") : allowlist;
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('test_allowlist', ?, datetime('now'))"
    ).run(list);
  }
  try {
    io.emit("test_mode:changed", getTestModeConfig());
  } catch {}
  res.json(getTestModeConfig());
});

app.get("/api/conversations", (req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT
            phone,
            (SELECT content FROM messages m2 WHERE m2.phone = m.phone ORDER BY m2.created_at DESC LIMIT 1) AS last_message,
            (SELECT direction FROM messages m3 WHERE m3.phone = m.phone ORDER BY m3.created_at DESC LIMIT 1) AS last_direction,
            MAX(created_at) AS last_at,
            SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_count,
            SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_count,
            SUM(CASE WHEN direction = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
            COUNT(*) AS total
         FROM messages m
         GROUP BY phone
         ORDER BY last_at DESC
         LIMIT 200`
      )
      .all();
    const withMeta = rows.map((r) => {
      const session = conversationManager.getSession(r.phone);
      const att = db
        .prepare(
          "SELECT id, customer_name, status FROM attendances WHERE caller_id = ? ORDER BY created_at DESC LIMIT 1"
        )
        .get(r.phone);
      return {
        ...r,
        customer_name: att?.customer_name || null,
        attendance_id: att?.id || null,
        attendance_status: att?.status || null,
        session_state: session?.state || null,
        pending_confirmation: !!session?.pendingConfirmation,
      };
    });
    res.json(withMeta);
  } catch (err) {
    logger.error({ err }, "GET /api/conversations");
    res.json([]);
  }
});

app.get("/api/conversations/:phone", (req, res) => {
  const phone = resolveMessageThreadKey(req.params.phone);
  if (!phone) return res.status(400).json({ error: "Telefone inválido" });
  const msgs = db
    .prepare(
      "SELECT id, phone, direction, content, message_type, created_at FROM messages WHERE phone = ? ORDER BY created_at ASC LIMIT 500"
    )
    .all(phone);
  const session = conversationManager.getSession(phone);
  res.json({
    phone,
    messages: msgs,
    session: session
      ? {
          state: session.state,
          pendingConfirmation: !!session.pendingConfirmation,
          pendingEditField: session.pendingEditField || null,
          collectedData: session.collectedData || {},
        }
      : null,
  });
});

app.post("/api/conversations/:phone/send", async (req, res) => {
  try {
    const phone = resolveMessageThreadKey(req.params.phone);
    if (!phone) return res.status(400).json({ error: "Telefone inválido" });
    const content = String(req.body?.content || "").trim();
    const force = !!req.body?.force;
    if (!content) return res.status(400).json({ error: "content obrigatório" });

    const result = await sendEvolutionMessage(phone, content, { force });

    if (!result?.blocked) {
      db.prepare(
        "INSERT INTO messages (phone, direction, content, message_type) VALUES (?, 'outbound', ?, 'text')"
      ).run(phone, content);
      try {
        io.emit("whatsapp:message", {
          phone,
          content,
          direction: "outbound",
          timestamp: new Date().toISOString(),
          origin: "admin",
        });
      } catch {}
    }
    res.json({ success: !result?.blocked, blocked: !!result?.blocked, reason: result?.reason || null });
  } catch (err) {
    logger.error({ err }, "POST /api/conversations/:phone/send");
    res.status(500).json({ error: String(err?.message || "erro ao enviar") });
  }
});

app.post("/api/conversations/:phone/reset", (req, res) => {
  const phone = resolveMessageThreadKey(req.params.phone);
  if (!phone) return res.status(400).json({ error: "Telefone inválido" });
  try {
    conversationManager.closeSession(phone);
  } catch {}
  try {
    io.emit("conversation:reset", { phone });
  } catch {}
  res.json({ success: true });
});

app.delete("/api/conversations/:phone", (req, res) => {
  const phone = resolveMessageThreadKey(req.params.phone);
  if (!phone) return res.status(400).json({ error: "Telefone inválido" });
  try {
    db.prepare("DELETE FROM messages WHERE phone = ?").run(phone);
    conversationManager.closeSession(phone);
  } catch (err) {
    logger.warn({ err }, "DELETE /api/conversations/:phone");
  }
  try {
    io.emit("conversation:cleared", { phone });
  } catch {}
  res.json({ success: true });
});

// Endpoint para tickets ativos (usado pelo dashboard)
app.get("/api/tickets/active", (req, res) => {
  res.json(orchestrator.getActiveTickets());
});

// Endpoint para status da sessão de conversa
app.get("/api/conversation/:phone", (req, res) => {
  const phone = resolveMessageThreadKey(req.params.phone);
  if (!phone) return res.json({ active: false });
  const session = conversationManager.getSession(phone);
  if (!session) return res.json({ active: false });
  res.json({
    active: true,
    state: session.state,
    collectedData: session.collectedData,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
  });
});

// Pagamentos
app.post("/api/payments", async (req, res) => {
  const { service_id, amount, method } = req.body;
  if (!service_id || !amount) return res.status(400).json({ error: "service_id e amount são obrigatórios" });
  try {
    const payment = await paymentService.createPayment(service_id, parseFloat(amount), method || "pix");
    res.json(payment);
  } catch (err) {
    logger.error({ err }, "Erro ao criar pagamento");
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/payments/:id/send-link", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
  try {
    const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(req.params.id);
    if (!payment) return res.status(404).json({ error: "Pagamento não encontrado" });
    await paymentService.sendPaymentLink(phone, payment);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/payments/:id/confirm", async (req, res) => {
  try {
    const result = await paymentService.confirmPayment(req.params.id);
    io.emit("payment:confirmed", { paymentId: req.params.id });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/payments/service/:serviceId", async (req, res) => {
  const payment = await paymentService.getPaymentByService(req.params.serviceId);
  res.json(payment || { exists: false });
});

// Analista - validações e avaliações
app.post("/api/analyst/validate-dispatch", (req, res) => {
  const { provider, negotiation, ticket } = req.body;
  const result = analyst.validateDispatch(provider, negotiation, ticket);
  res.json(result);
});

app.post("/api/analyst/validate-eta", (req, res) => {
  const { eta_minutes } = req.body;
  const result = analyst.validateETA(parseInt(eta_minutes));
  res.json(result);
});

app.post("/api/analyst/rate", (req, res) => {
  const { service_id, provider_id, rating } = req.body;
  if (!service_id || !provider_id || !rating) {
    return res.status(400).json({ error: "service_id, provider_id e rating são obrigatórios" });
  }
  analyst.processRating(service_id, provider_id, parseInt(rating));
  res.json({ success: true });
});

app.get("/api/analyst/sla-config", (req, res) => {
  res.json(analyst.slaConfig);
});

app.put("/api/analyst/sla-config", (req, res) => {
  analyst.updateSLAConfig(req.body);
  res.json({ success: true, config: analyst.slaConfig });
});

// Notificações
app.post("/api/notifications/provider-enroute", async (req, res) => {
  const { client_phone, provider_name } = req.body;
  await notificationService.notifyClientProviderEnRoute(client_phone, provider_name);
  res.json({ success: true });
});

app.post("/api/notifications/provider-arrived", async (req, res) => {
  const { client_phone, provider_name } = req.body;
  await notificationService.notifyClientProviderArrived(client_phone, provider_name);
  res.json({ success: true });
});

app.post("/api/notifications/service-completed", async (req, res) => {
  const { client_phone, service_id } = req.body;
  await notificationService.notifyClientServiceCompleted(client_phone, service_id);
  res.json({ success: true });
});

app.get("/api/eta", async (req, res) => {
  const { origin_lat, origin_lng, dest_lat, dest_lng } = req.query;
  if (!origin_lat || !origin_lng || !dest_lat || !dest_lng) {
    return res.status(400).json({ error: "Coordenadas de origem e destino são obrigatórias" });
  }
  const minutes = await calculateETA(
    parseFloat(origin_lat), parseFloat(origin_lng),
    parseFloat(dest_lat), parseFloat(dest_lng)
  );
  res.json({ eta_minutes: minutes });
});

// Endpoint de busca geoespacial de prestadores (usado quando PostgreSQL+PostGIS estiver ativo)
app.get("/api/providers/nearby", async (req, res) => {
  const { lat, lng, radius, service_type, min_rating } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat e lng são obrigatórios" });

  try {
    const { findNearbyProviders } = await import("./database/geoSearch.js");
    const providers = await findNearbyProviders({
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      radiusKm: parseInt(radius) || 10,
      serviceType: service_type,
      minRating: parseFloat(min_rating) || 3.5,
    });
    res.json(providers);
  } catch (err) {
    const allProviders = db.prepare("SELECT * FROM providers WHERE active = 1 ORDER BY rating DESC").all();
    res.json(allProviders);
  }
});

// Endpoint de negociações
app.get("/api/negotiations", (req, res) => {
  const { service_id, status } = req.query;
  let query = "SELECT * FROM negotiations WHERE 1=1";
  const params = [];
  if (service_id) { query += " AND service_id = ?"; params.push(service_id); }
  if (status) { query += " AND status = ?"; params.push(status); }
  query += " ORDER BY created_at DESC";
  try {
    res.json(db.prepare(query).all(...params));
  } catch {
    res.json([]);
  }
});

// Endpoint de audit logs
app.get("/api/audit-logs", (req, res) => {
  const { entity_type, entity_id, limit: lim } = req.query;
  let query = "SELECT * FROM audit_logs WHERE 1=1";
  const params = [];
  if (entity_type) { query += " AND entity_type = ?"; params.push(entity_type); }
  if (entity_id) { query += " AND entity_id = ?"; params.push(entity_id); }
  query += ` ORDER BY created_at DESC LIMIT ${parseInt(lim) || 50}`;
  try {
    res.json(db.prepare(query).all(...params));
  } catch {
    res.json([]);
  }
});

// Verificar status periodicamente
setInterval(async () => {
  const status = await checkEvolutionStatus();
  const wasConnected = whatsappConnected;
  whatsappConnected = status.connected;
  
  if (status.connected && !wasConnected) {
    whatsappNumber = status.number || "Conectado";
    io.emit("whatsapp:connected", { number: whatsappNumber });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('whatsapp_connected', 'true')").run();
  } else if (!status.connected && wasConnected) {
    io.emit("whatsapp:disconnected");
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('whatsapp_connected', 'false')").run();
  }
}, 30000);

function bindServer(port) {
  const onListenError = (err) => {
    server.off("error", onListenError);
    if (err.code === "EADDRINUSE" && port < PREFERRED_PORT + PORT_FALLBACK_MAX) {
      const next = port + 1;
      logger.warn(
        { ocupada: port, usando: next },
        "Porta em uso; tentando a próxima (evita travar o dev — libere a porta ou defina PORT no .env)"
      );
      bindServer(next);
      return;
    }
    logger.error({ err }, "Falha ao abrir porta HTTP");
    process.exit(1);
  };

  server.once("error", onListenError);
  server.listen(port, () => {
    server.off("error", onListenError);
    const chosen = port;
    if (chosen !== PREFERRED_PORT) {
      logger.warn(
        { preferida: PREFERRED_PORT, emUso: chosen },
        "Servidor subiu em porta alternativa. Atualize webhooks/clientes para esta URL ou libere a porta preferida."
      );
    }
    logger.info(`========================================`);
    logger.info(`  SGA Assistência - Reboque Inteligente`);
    logger.info(`  http://localhost:${chosen}`);
    if (EVOLUTION_API_URL) {
      logger.info(`  Evolution API: ${EVOLUTION_API_URL}`);
    } else {
      logger.info(`  WhatsApp: Modo Demo (configure Evolution API)`);
    }
    if (shouldSimulateAttendance()) {
      logger.info(
        `  Atendimento: SIMULAÇÃO (1ª mensagem = chamado de teste + despacho). Configure LLM (OPENAI_API_KEY ou OPENAI_BASE_URL) e SIMULATE_ATTENDANCE=false para usar o modelo.`
      );
    } else {
      logger.info(`  Agente Atendente: ${hasLLMConfigured() ? "Ativo (LLM)" : "Desativado (configure credenciais LLM)"}`);
    }
    logger.info(`========================================`);
  });
}

bindServer(PREFERRED_PORT);

export { app, io, db };
