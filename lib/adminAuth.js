import crypto from "crypto";

const COOKIE = "rj_admin";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function adminUser() {
  return String(process.env.ADMIN_USER || "admin");
}

function adminPassword() {
  return String(process.env.ADMIN_PASSWORD || "");
}

function sessionSecret() {
  return String(process.env.ADMIN_SESSION_SECRET || "reboque-ja-dev-session");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token) {
  const raw = String(token || "");
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data?.exp || Date.now() > data.exp) return null;
    if (data.u !== adminUser()) return null;
    return data;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const piece = part.trim();
    const i = piece.indexOf("=");
    if (i < 0) continue;
    const key = decodeURIComponent(piece.slice(0, i));
    if (key === name) return decodeURIComponent(piece.slice(i + 1));
  }
  return "";
}

function cookieHeader(token, { clear = false } = {}) {
  const parts = [
    `${COOKIE}=${clear ? "" : encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    clear ? "Max-Age=0" : `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  return parts.join("; ");
}

export function isPublicApi(req) {
  const path = req.path || "";
  if (!path.startsWith("/api/")) return true;
  if (req.method === "GET" && path === "/api/health") return true;
  if (req.method === "GET" && path === "/api/auth/me") return true;
  if (req.method === "POST" && (path === "/api/auth/login" || path === "/api/auth/logout")) return true;
  if (req.method === "POST" && path === "/api/chat/web") return true;
  if (req.method === "POST" && path.startsWith("/api/whatsapp/webhook")) return true;
  if (req.method === "POST" && path === "/api/payment/webhook") return true;
  return false;
}

export function requireAdmin(req, res, next) {
  if (isPublicApi(req)) return next();
  const session = verify(readCookie(req, COOKIE));
  if (!session) {
    return res.status(401).json({ error: "Não autenticado" });
  }
  req.admin = { username: session.u };
  return next();
}

export function loginAdmin(username, password) {
  if (!adminPassword()) return { ok: false, error: "ADMIN_PASSWORD não configurada" };
  if (!safeEqual(username, adminUser()) || !safeEqual(password, adminPassword())) {
    return { ok: false, error: "Usuário ou senha inválidos" };
  }
  const token = sign({ u: adminUser(), exp: Date.now() + TTL_MS });
  return { ok: true, username: adminUser(), cookie: cookieHeader(token) };
}

export function logoutCookie() {
  return cookieHeader("", { clear: true });
}

export function currentAdmin(req) {
  const session = verify(readCookie(req, COOKIE));
  return session ? { authenticated: true, username: session.u } : { authenticated: false };
}
