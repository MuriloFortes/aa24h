import { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext } from "react";
import {
  Send, MapPin, Truck, Phone, MessageCircle, BarChart3,
  Users, Settings, ChevronRight, Clock, CheckCircle, AlertTriangle,
  Navigation, Loader2, Menu, X, Shield, Timer, Bell, Play, Square,
  MessageSquare, Zap, ZapOff, Trash2, RotateCcw, Plus, ClipboardList,
  Search, Palette, Type, Image as ImageIcon, Filter, Download, Crosshair,
  Maximize2, RefreshCw, SlidersHorizontal, Pencil
} from "lucide-react";
import { io } from "socket.io-client";
import { SERVICE_TYPES, formatServiceList } from "./serviceTypes.js";
import { extractLatLngFromText, normalizeBrazilLatLng } from "../../lib/locationParse.js";
import { canonicalBrPhone as brPhoneCanonical } from "../../lib/phoneCanonical.js";

const BASE = import.meta.env.VITE_API_URL || "";
const API = BASE ? `${BASE}/api` : "/api";
const socket = io(BASE || undefined, { transports: ["websocket", "polling"] });

/** Valor exibido na cotação: `counter_price` tem precedência sobre `offered_price`. */
function negotiationQuotedPrice(n) {
  const c = n?.counter_price;
  if (c != null && c !== "" && Number.isFinite(Number(c))) return Number(c);
  const o = n?.offered_price;
  if (o != null && o !== "" && Number.isFinite(Number(o))) return Number(o);
  return null;
}

// ==================== THEME / APARÊNCIA ====================

const DEFAULT_THEME = {
  primaryColor: "#6366f1",
  appBackground: "#0f172a",
  fontSize: "md", // sm | md | lg | xl
  logoUrl: "",
  brandName: "Novamart Assist",
  clientTagline: "Assistência 24h",
};

const THEME_STORAGE_KEY = "novamart.theme.v1";

function readStoredTheme() {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return DEFAULT_THEME;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_THEME, ...parsed };
  } catch {
    return DEFAULT_THEME;
  }
}

function hexToRgb(hex) {
  const clean = String(hex || "").replace("#", "");
  if (clean.length !== 3 && clean.length !== 6) return null;
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return null;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function shadeHex(hex, amount) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const mix = (c) => {
    const n = amount < 0
      ? Math.max(0, Math.round(c + amount))
      : Math.min(255, Math.round(c + (255 - c) * amount));
    return n;
  };
  const r = mix(rgb.r);
  const g = mix(rgb.g);
  const b = mix(rgb.b);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function applyThemeToDocument(theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const primary = theme.primaryColor || DEFAULT_THEME.primaryColor;
  const hover = shadeHex(primary, -25);
  const rgb = hexToRgb(primary);
  const soft = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)` : "rgba(99,102,241,0.18)";
  const ring = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.55)` : "rgba(99,102,241,0.55)";
  root.style.setProperty("--color-primary", primary);
  root.style.setProperty("--color-primary-hover", hover);
  root.style.setProperty("--color-primary-soft", soft);
  root.style.setProperty("--color-primary-ring", ring);
  root.style.setProperty("--bg-app", theme.appBackground || DEFAULT_THEME.appBackground);
  if (typeof document !== "undefined" && document.body) {
    document.body.style.backgroundColor = theme.appBackground || DEFAULT_THEME.appBackground;
  }
  root.dataset.font = theme.fontSize || "md";
  if (theme.brandName) {
    document.title = `${theme.brandName} — Painel`;
  }
}

const ThemeContext = createContext({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  resetTheme: () => {},
});

function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => readStoredTheme());

  useEffect(() => {
    applyThemeToDocument(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
    } catch {
      /* ignore */
    }
  }, [theme]);

  const setTheme = useCallback((patch) => {
    setThemeState((prev) => ({ ...prev, ...patch }));
  }, []);
  const resetTheme = useCallback(() => setThemeState(DEFAULT_THEME), []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resetTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

function useTheme() {
  return useContext(ThemeContext);
}

function parseNotesJson(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Coordenadas do chamado para o mapa (notes JSON ou texto [Localização: lat, lng]) */
function getServiceMapCoords(svc) {
  const n = parseNotesJson(svc.notes);
  if (Number.isFinite(Number(n.location_lat)) && Number.isFinite(Number(n.location_lng))) {
    const norm = normalizeBrazilLatLng(Number(n.location_lat), Number(n.location_lng));
    if (norm) return [norm.lat, norm.lng];
  }
  const loc = String(n.location || n.location_text || "");
  const fromText = extractLatLngFromText(loc);
  if (fromText) return [fromText.lat, fromText.lng];
  return null;
}

function NegotiationsTable({ negotiations }) {
  if (!Array.isArray(negotiations) || negotiations.length === 0) {
    return <p className="text-xs text-gray-500">Nenhuma negociação registrada.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-700">
      <table className="w-full text-xs min-w-[720px]">
        <thead className="bg-gray-700/60 text-gray-200">
          <tr className="text-left">
            <th className="px-3 py-2">Prestador</th>
            <th className="px-3 py-2">Telefone</th>
            <th className="px-3 py-2">Distância</th>
            <th className="px-3 py-2">Preço</th>
            <th className="px-3 py-2">Previsão</th>
            <th className="px-3 py-2">Nota fiscal</th>
            <th className="px-3 py-2">Score</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Contato</th>
          </tr>
        </thead>
        <tbody>
          {negotiations.map((n) => (
            <tr
              key={n.id}
              className={`border-t border-gray-700 ${n.status === "accepted" ? "bg-green-900/20" : ""}`}
            >
              <td className="px-3 py-2 text-gray-100">
                {n.provider_name_full || (n.provider_id ? String(n.provider_id).slice(0, 8) : "—")}
              </td>
              <td className="px-3 py-2 font-mono text-gray-300">
                {n.provider_phone_full || "—"}
              </td>
              <td className="px-3 py-2">
                {n.distance_km != null ? `${Number(n.distance_km).toFixed(1)} km` : "—"}
              </td>
              <td className="px-3 py-2">
                {n.final_price != null
                  ? `R$ ${Number(n.final_price).toFixed(2)}`
                  : n.counter_price != null
                  ? `R$ ${Number(n.counter_price).toFixed(2)}`
                  : n.offered_price != null
                  ? `R$ ${Number(n.offered_price).toFixed(2)}`
                  : "—"}
              </td>
              <td className="px-3 py-2">{n.eta_minutes != null ? `${n.eta_minutes} min` : "—"}</td>
              <td className="px-3 py-2 text-[11px]">
                {n.invoice_awaiting ? (
                  <span className="text-amber-400">aguardando resposta</span>
                ) : n.invoice_info ? (
                  <span className="text-gray-200">{n.invoice_info}</span>
                ) : (
                  <span className="text-gray-500">—</span>
                )}
              </td>
              <td className="px-3 py-2">{n.score != null ? Number(n.score).toFixed(2) : "—"}</td>
              <td className="px-3 py-2"><StatusBadge status={n.status} small /></td>
              <td className="px-3 py-2 text-[10px] text-gray-400">{formatDate(n.contacted_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GoogleDebugTables({ debug }) {
  const [showRaw, setShowRaw] = useState(false);
  if (!debug || typeof debug !== "object") return null;
  const manualLinks = Array.isArray(debug.manual_maps_search) ? debug.manual_maps_search : [];
  const geocoding = debug.geocoding || debug.geocodingLateResolved || null;
  const distanceMatrix = debug.distanceMatrix || null;
  const nearby = debug.placesNearbySearch || null;
  const placesSample = Array.isArray(debug.placesDetailsSample) ? debug.placesDetailsSample : [];

  return (
    <div className="space-y-4">
      {manualLinks.length > 0 && (
        <div className="rounded-lg border border-green-700/40 bg-green-950/20">
          <div className="px-3 py-2 border-b border-green-700/40 flex items-center justify-between">
            <h5 className="text-xs font-semibold text-green-200 uppercase tracking-wide">
              Busca manual no Google Maps
            </h5>
            <span className="text-[10px] text-green-300/80">
              Abre o Maps no navegador, sem consumir API.
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-green-900/30 text-green-100">
                <tr className="text-left">
                  <th className="px-3 py-2">Palavra-chave</th>
                  <th className="px-3 py-2">Região</th>
                  <th className="px-3 py-2">Link</th>
                </tr>
              </thead>
              <tbody>
                {manualLinks.map((m) => (
                  <tr key={`${m.keyword}-${m.url}`} className="border-t border-green-800/40">
                    <td className="px-3 py-2 text-green-100 capitalize">{m.keyword}</td>
                    <td className="px-3 py-2 text-gray-300">
                      {m.lat != null && m.lng != null
                        ? `${Number(m.lat).toFixed(4)}, ${Number(m.lng).toFixed(4)}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <a
                        href={m.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-green-800/40 border border-green-600/50 text-green-200 hover:bg-green-700/50"
                      >
                        Abrir no Maps ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {geocoding && (
        <div className="rounded-lg border border-amber-700/40 bg-amber-950/10">
          <div className="px-3 py-2 border-b border-amber-700/40">
            <h5 className="text-xs font-semibold text-amber-200 uppercase tracking-wide">Geocoding</h5>
          </div>
          <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <Info
              label="Entrada"
              value={geocoding.input || geocoding.query || geocoding.address || "—"}
              colSpan
            />
            <Info label="Status" value={geocoding.status || "—"} />
            <Info
              label="Coordenadas"
              value={
                geocoding.coords
                  ? `${Number(geocoding.coords.lat).toFixed(6)}, ${Number(geocoding.coords.lng).toFixed(6)}`
                  : "—"
              }
            />
            <Info
              label="Endereço formatado"
              value={geocoding.formatted_address || geocoding.result?.formatted_address || "—"}
              colSpan
            />
          </div>
        </div>
      )}

      {distanceMatrix && (
        <div className="rounded-lg border border-blue-700/40 bg-blue-950/10">
          <div className="px-3 py-2 border-b border-blue-700/40">
            <h5 className="text-xs font-semibold text-blue-200 uppercase tracking-wide">
              Distance Matrix (trajeto)
            </h5>
          </div>
          <div className="p-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            <Info label="Status" value={distanceMatrix.status || "—"} />
            <Info
              label="Distância"
              value={
                distanceMatrix.distance_km != null
                  ? `${Number(distanceMatrix.distance_km).toFixed(2)} km`
                  : distanceMatrix.distance?.text || "—"
              }
            />
            <Info
              label="Duração"
              value={
                distanceMatrix.duration_min != null
                  ? `${Math.round(Number(distanceMatrix.duration_min))} min`
                  : distanceMatrix.duration?.text || "—"
              }
            />
          </div>
        </div>
      )}

      {nearby && (
        <div className="rounded-lg border border-fuchsia-700/40 bg-fuchsia-950/10">
          <div className="px-3 py-2 border-b border-fuchsia-700/40">
            <h5 className="text-xs font-semibold text-fuchsia-200 uppercase tracking-wide">
              Places Nearby Search
            </h5>
          </div>
          <div className="p-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            <Info label="Keyword" value={nearby.keywordUsed || nearby.keyword || "—"} />
            <Info label="Status" value={nearby.status || nearby.error || "—"} />
            <Info
              label="Resultados"
              value={
                Array.isArray(nearby.results)
                  ? nearby.results.length
                  : nearby.resultsCount != null
                  ? nearby.resultsCount
                  : "—"
              }
            />
          </div>
        </div>
      )}

      {placesSample.length > 0 && (
        <div className="rounded-lg border border-gray-700">
          <div className="px-3 py-2 border-b border-gray-700">
            <h5 className="text-xs font-semibold text-gray-200 uppercase tracking-wide">
              Places Details (amostra)
            </h5>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-700/60">
                <tr className="text-left">
                  <th className="px-3 py-2">Nome</th>
                  <th className="px-3 py-2">Telefone</th>
                  <th className="px-3 py-2">Endereço</th>
                  <th className="px-3 py-2">Place ID</th>
                </tr>
              </thead>
              <tbody>
                {placesSample.map((p) => (
                  <tr key={p.placeId} className="border-t border-gray-700">
                    <td className="px-3 py-2 text-gray-100">{p.name || "—"}</td>
                    <td className="px-3 py-2 font-mono text-gray-300">{p.phone || "—"}</td>
                    <td className="px-3 py-2 text-gray-300">{p.address || "—"}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-gray-500 truncate max-w-[160px]" title={p.placeId}>
                      {p.placeId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="text-[11px] text-gray-400 hover:text-gray-200 underline underline-offset-2"
        >
          {showRaw ? "ocultar JSON bruto" : "ver JSON bruto"}
        </button>
        {showRaw && (
          <pre className="mt-2 p-3 rounded-lg bg-gray-950 border border-gray-700 text-[11px] overflow-auto max-h-96 text-gray-300">
            {JSON.stringify(debug, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function ServiceLinkedCard({ svc }) {
  const n = parseNotesJson(svc.notes);
  return (
    <div className="rounded-xl border border-indigo-500/30 bg-gray-900/50 p-4 space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-white capitalize">{svc.service_type || "Serviço"}</span>
        <StatusBadge status={svc.status} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div>
          <span className="text-gray-500 block mb-0.5">Cliente</span>
          <span className="text-gray-200">{svc.customer_name || "—"}</span>
        </div>
        <div>
          <span className="text-gray-500 block mb-0.5">Telefone</span>
          <span className="text-gray-200 font-mono">{svc.customer_phone || "—"}</span>
        </div>
        <div>
          <span className="text-gray-500 block mb-0.5">Placa</span>
          <span className="text-gray-200 font-mono">{svc.plate || "—"}</span>
        </div>
        <div>
          <span className="text-gray-500 block mb-0.5">Valor</span>
          <span className="text-indigo-300">
            {svc.price != null && svc.price !== "" ? `R$ ${parseFloat(svc.price).toFixed(2)}` : "—"}
          </span>
        </div>
        <div className="sm:col-span-2">
          <span className="text-gray-500 block mb-0.5">Local / origem</span>
          <span className="text-gray-200 break-words">{n.location_text || n.location || "—"}</span>
        </div>
        <div className="sm:col-span-2">
          <span className="text-gray-500 block mb-0.5">Destino</span>
          <span className="text-gray-200 break-words">{n.destination || "—"}</span>
        </div>
        {svc.provider_name && (
          <div className="sm:col-span-2">
            <span className="text-gray-500 block mb-0.5">Prestador</span>
            <span className="text-green-400">{svc.provider_name}</span>
          </div>
        )}
      </div>
      <p className="text-[10px] text-gray-600 font-mono truncate" title={svc.id}>
        ID serviço: {svc.id}
      </p>
    </div>
  );
}

function resolveDefaultView() {
  if (typeof window === "undefined") return "client";
  const port = window.location.port;
  const params = new URLSearchParams(window.location.search);
  const override = params.get("view");
  if (override === "admin" || override === "client") return override;
  if (port === "3003") return "admin";
  if (port === "3004") return "client";
  return "client";
}

export default function App() {
  const [view, setView] = useState(resolveDefaultView);
  return (
    <ThemeProvider>
      {view === "client" ? (
        <ClientView onSwitch={() => setView("admin")} />
      ) : (
        <AdminDashboard onSwitch={() => setView("client")} />
      )}
    </ThemeProvider>
  );
}

// ==================== CLIENT CHAT VIEW ====================

function ClientHeader({ onSwitch }) {
  const { theme } = useTheme();
  return (
    <header className="bg-slate-900/70 backdrop-blur border-b border-slate-800 px-4 py-3">
      <div className="max-w-2xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BrandLogo size="sm" />
          <div>
            <h1 className="text-white font-bold leading-tight">
              {theme.brandName || "Assistência"}
            </h1>
            <p className="text-xs text-slate-400">{theme.clientTagline || "Assistência 24h"}</p>
          </div>
        </div>
        <button onClick={onSwitch} className="text-xs text-slate-500 hover:text-slate-200">
          Painel Admin
        </button>
      </div>
    </header>
  );
}

function ClientView({ onSwitch }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [location, setLocation] = useState(null);
  const [ticketInfo, setTicketInfo] = useState(null);
  const chatRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const sid = localStorage.getItem("chat_session") || `web_${Date.now()}`;
    localStorage.setItem("chat_session", sid);
    setSessionId(sid);

    setMessages([]);
  }, []);

  useEffect(() => {
    if (!sessionId) return undefined;
    function onOutboundToSession(msg) {
      if (msg?.direction !== "outbound") return;
      if (msg.phone !== sessionId) return;
      const text = String(msg.content || "").trim();
      if (!text) return;
      setMessages((prev) => {
        const ts = msg.timestamp || new Date().toISOString();
        const dup = prev.some(
          (m) =>
            m.role === "assistant" &&
            m.content === text &&
            Math.abs(new Date(m.timestamp).getTime() - new Date(ts).getTime()) < 4000
        );
        if (dup) return prev;
        return [...prev, { role: "assistant", content: text, timestamp: ts }];
      });
    }
    socket.on("ticket:created", (ticket) => {
      if (ticket.phoneNumber === sessionId || ticket.channel === "web") {
        setTicketInfo(ticket);
      }
    });
    socket.on("provider:accepted", (data) => {
      setMessages(prev => [...prev, {
        role: "system",
        content: `🎉 Prestador encontrado! ${data.provider.name} está a caminho. Valor: R$ ${data.finalPrice.toFixed(2)}`,
        timestamp: new Date().toISOString(),
      }]);
    });
    socket.on("whatsapp:message", onOutboundToSession);
    return () => {
      socket.off("ticket:created");
      socket.off("provider:accepted");
      socket.off("whatsapp:message", onOutboundToSession);
    };
  }, [sessionId]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setLocation(loc);
        setMessages(prev => [...prev, {
          role: "user",
          content: `📍 Localização compartilhada: ${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`,
          timestamp: new Date().toISOString(),
        }]);
        sendToAgent(`[Localização: ${loc.lat}, ${loc.lng}]`);
      },
      () => {
        setMessages(prev => [...prev, {
          role: "system",
          content: "Não consegui acessar sua localização. Por favor, descreva onde você está.",
          timestamp: new Date().toISOString(),
        }]);
      }
    );
  }, [sessionId]);

  async function sendToAgent(text) {
    try {
      const res = await fetch(`${API}/chat/web`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessages(prev => [...prev, {
          role: "system",
          content: data.error || `Erro ${res.status} no atendimento.`,
          timestamp: new Date().toISOString(),
        }]);
      } else if (data.response) {
        setMessages(prev => [...prev, {
          role: "assistant",
          content: data.response,
          timestamp: new Date().toISOString(),
        }]);
      }
    } catch {
      setMessages(prev => [...prev, {
        role: "system",
        content: "Erro de conexão. Tente novamente.",
        timestamp: new Date().toISOString(),
      }]);
    }
  }

  async function handleSend(e) {
    e?.preventDefault();
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput("");
    setSending(true);

    setMessages(prev => [...prev, {
      role: "user", content: text, timestamp: new Date().toISOString(),
    }]);

    try {
      await sendToAgent(text);
    } finally {
      setSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  return (
    <div
      className="min-h-screen flex flex-col text-white"
      style={{
        background: `radial-gradient(circle at top, var(--color-primary-soft), transparent 60%), linear-gradient(135deg, var(--bg-app) 0%, #1e293b 60%, var(--bg-app) 100%)`,
      }}
    >
      <ClientHeader onSwitch={onSwitch} />

      <div className="flex-1 max-w-2xl mx-auto w-full flex flex-col p-4 gap-4">
        {ticketInfo && (
          <div className="bg-green-900/30 border border-green-600/30 rounded-xl p-4">
            <div className="flex items-center gap-2 text-green-400 mb-2">
              <CheckCircle className="w-5 h-5" />
              <span className="font-semibold">Chamado Registrado</span>
            </div>
            <p className="text-sm text-gray-300">Protocolo: {ticketInfo.protocol || ticketInfo.attendanceId?.slice(0, 8).toUpperCase()}</p>
            <p className="text-sm text-gray-400">{ticketInfo.serviceType} - {ticketInfo.location}</p>
          </div>
        )}

        <div ref={chatRef} className="chat-messages flex-1 overflow-y-auto space-y-3 min-h-0" style={{ maxHeight: "60vh" }}>
          {messages.length === 0 && !sending && (
            <p className="text-sm text-gray-500 text-center py-8 px-2">
              Envie uma mensagem para iniciar. O atendimento é feito em uma pergunta por vez.
            </p>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                msg.role === "user"
                  ? "bg-indigo-600 text-white"
                  : msg.role === "system"
                  ? "bg-yellow-900/30 border border-yellow-600/30 text-yellow-200"
                  : "bg-gray-700 text-gray-100"
              }`}>
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                <p className="text-[10px] mt-1 opacity-50">
                  {new Date(msg.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-gray-700 rounded-2xl px-4 py-3">
                <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={requestLocation}
            className="p-3 bg-gray-700 hover:bg-gray-600 rounded-xl text-gray-300 transition-colors"
            title="Compartilhar localização"
          >
            <MapPin className="w-5 h-5" />
          </button>
          <form onSubmit={handleSend} className="flex-1 flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Digite oi para começar…"
              className="flex-1 bg-gray-700 text-white rounded-xl px-4 py-3 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              autoFocus
            />
            <button
              type="submit"
              disabled={!input.trim() || sending}
              className="p-3 btn-primary rounded-xl text-white"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ==================== ADMIN DASHBOARD ====================

function AdminDashboard({ onSwitch }) {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [stats, setStats] = useState({ total: 0, today: 0, in_progress: 0, completed: 0, recent: [], by_service: [] });
  const [attendances, setAttendances] = useState([]);
  const [services, setServices] = useState([]);
  const [providers, setProviders] = useState([]);
  const [negotiations, setNegotiations] = useState([]);
  /** Abre detalhe na aba Serviços ao vir do dashboard */
  const [pendingServiceOpenId, setPendingServiceOpenId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [whatsappStatus, setWhatsappStatus] = useState({ connected: false });
  const [liveMessages, setLiveMessages] = useState([]);
  /** Modal central (permanece até clicar em OK) — novo atendimento ou falha SGA */
  const [centerModal, setCenterModal] = useState({
    show: false,
    title: "",
    message: "",
    variant: "info",
  });

  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: BarChart3, group: "operação" },
    { id: "attendances", label: "Atendimentos", icon: Phone, group: "operação" },
    { id: "services", label: "Serviços", icon: Truck, group: "operação" },
    { id: "map", label: "Mapa", icon: MapPin, group: "operação" },
    { id: "providers", label: "Prestadores", icon: Users, group: "cadastros" },
    { id: "conversations", label: "Conversas", icon: MessageSquare, group: "cadastros" },
    { id: "tracking", label: "Diagnóstico", icon: ClipboardList, group: "ferramentas" },
    { id: "settings", label: "Configurações", icon: Settings, group: "ferramentas" },
  ];

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);

    socket.on("attendance:created", (row) => {
      loadData();
      const nome = row?.customer_name || "Cliente";
      const svc = row?.service_type ? ` (${row.service_type})` : "";
      const placa = row?.vehicle_plate || "—";
      const msg = `Cliente: ${nome}\nPlaca: ${placa}${svc ? `\nServiço: ${row.service_type}` : ""}`;
      setCenterModal({
        show: true,
        title: "Novo atendimento registrado",
        message: msg,
        variant: "success",
      });
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("SGA — Novo atendimento", { body: `${nome} — ${placa}`, tag: "sga-attendance" });
        } else if (typeof Notification !== "undefined" && Notification.permission === "default") {
          Notification.requestPermission();
        }
      } catch {
        /* ignore */
      }
    });

    socket.on("sga:verification_failed", (data) => {
      loadData();
      const lines = [
        data?.panelDetail || "Falha na validação SGA.",
        "",
        `Cliente: ${data?.customerName || "—"}`,
        `Telefone: ${data?.phone || "—"}`,
        `Placa: ${data?.plate || "—"}`,
        "",
        `Mensagem ao cliente: ${data?.clientMessage || "—"}`,
      ];
      setCenterModal({
        show: true,
        title: "Validação da proteção veicular",
        message: lines.join("\n"),
        variant: "error",
      });
    });
    socket.on("ticket:created", () => {
      loadData();
    });
    socket.on("whatsapp:message", (msg) => {
      setLiveMessages(prev => [msg, ...prev].slice(0, 100));
    });
    socket.on("outbound:blocked", (msg) => {
      setLiveMessages(prev => [{ ...msg, direction: "blocked" }, ...prev].slice(0, 100));
    });
    socket.on("inbound:ignored", (msg) => {
      setLiveMessages(prev => [{ ...msg, direction: "ignored" }, ...prev].slice(0, 100));
    });
    socket.on("provider:accepted", loadData);
    socket.on("dispatch:searching", loadData);
    socket.on("attendance:updated", loadData);
    socket.on("attendance:distance_calculated", loadData);
    socket.on("quotes:round_started", loadData);
    socket.on("quotes:update", loadData);
    socket.on("quotes:leader_updated", loadData);
    socket.on("quotes:round_finished", loadData);
    socket.on("attendance:blocked", (data) => {
      loadData();
      setCenterModal({
        show: true,
        title: "Atendimento bloqueado por regra de negócio",
        message: `Cliente: ${data?.customerName || "—"}\nTelefone: ${data?.phoneNumber || "—"}\nServiço: ${data?.serviceType || "—"}\n\n${data?.reason || ""}`,
        variant: "error",
      });
    });

    return () => {
      clearInterval(interval);
      socket.off("attendance:created");
      socket.off("ticket:created");
      socket.off("whatsapp:message");
      socket.off("outbound:blocked");
      socket.off("inbound:ignored");
      socket.off("provider:accepted");
      socket.off("dispatch:searching");
      socket.off("sga:verification_failed");
      socket.off("attendance:updated");
      socket.off("attendance:distance_calculated");
      socket.off("quotes:round_started");
      socket.off("quotes:update");
      socket.off("quotes:leader_updated");
      socket.off("quotes:round_finished");
      socket.off("attendance:blocked");
    };
  }, []);

  async function loadData() {
    try {
      const [statsRes, attsRes, svcsRes, provsRes, waRes] = await Promise.all([
        fetch(`${API}/statistics`).then(r => r.json()),
        fetch(`${API}/attendance`).then(r => r.json()),
        fetch(`${API}/services`).then(r => r.json()),
        fetch(`${API}/providers`).then(r => r.json()),
        fetch(`${API}/whatsapp/status`).then(r => r.json()),
      ]);
      setStats(statsRes);
      setAttendances(attsRes);
      setServices(svcsRes);
      setProviders(provsRes);
      setWhatsappStatus(waRes);
    } catch {}
    try {
      const negsRes = await fetch(`${API}/negotiations`).then(r => r.json());
      setNegotiations(negsRes);
    } catch {}
  }

  return (
    <div className="min-h-screen text-slate-100 flex" style={{ backgroundColor: "var(--bg-app, #0f172a)" }}>
      <Sidebar
        tabs={tabs}
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        onSwitchToClient={onSwitch}
      />

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar
          activeTab={activeTab}
          whatsappStatus={whatsappStatus}
          stats={stats}
          attendancesCount={attendances.length}
          onOpenSettings={() => setActiveTab("settings")}
        />

        <div className="flex-1 overflow-auto px-6 py-6">
          {centerModal.show && (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70"
              role="dialog"
              aria-modal="true"
              aria-labelledby="center-modal-title"
            >
              <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl p-6 flex flex-col gap-4">
                <h2
                  id="center-modal-title"
                  className={`text-lg font-semibold ${
                    centerModal.variant === "success" ? "text-green-400" : centerModal.variant === "error" ? "text-red-400" : "text-white"
                  }`}
                >
                  {centerModal.title}
                </h2>
                <p className="text-sm text-slate-300 whitespace-pre-line">{centerModal.message}</p>
                <button
                  type="button"
                  className="mt-2 w-full py-3 rounded-xl btn-primary font-medium"
                  onClick={() => setCenterModal((m) => ({ ...m, show: false }))}
                >
                  OK
                </button>
              </div>
            </div>
          )}

        {activeTab === "dashboard" && (
          <DashboardTab
            stats={stats}
            services={services}
            negotiations={negotiations}
            onGoToService={(serviceId) => {
              setPendingServiceOpenId(serviceId);
              setActiveTab("services");
            }}
          />
        )}
        {activeTab === "attendances" && <AttendancesTab attendances={attendances} />}
        {activeTab === "services" && (
          <ServicesTab
            services={services}
            negotiations={negotiations}
            pendingOpenId={pendingServiceOpenId}
            onConsumedPendingOpen={() => setPendingServiceOpenId(null)}
          />
        )}
        {activeTab === "providers" && <ProvidersTab providers={providers} onRefresh={loadData} />}
        {activeTab === "map" && (
          <MapTab providers={providers} services={services} attendances={attendances} />
        )}
        {activeTab === "tracking" && <TrackingTab />}
        {activeTab === "conversations" && <ConversationsTab liveMessages={liveMessages} />}
        {activeTab === "settings" && <SettingsTab />}
        </div>
      </main>
    </div>
  );
}

function Sidebar({ tabs, activeTab, onChangeTab, sidebarOpen, onToggleSidebar, onSwitchToClient }) {
  const { theme } = useTheme();
  const grouped = useMemo(() => {
    const map = new Map();
    for (const t of tabs) {
      if (!map.has(t.group || "outros")) map.set(t.group || "outros", []);
      map.get(t.group || "outros").push(t);
    }
    return Array.from(map.entries());
  }, [tabs]);

  return (
    <aside
      className={`${sidebarOpen ? "w-64" : "w-[4.25rem]"} bg-slate-900 border-r border-slate-800 min-h-screen p-3 transition-all duration-200 flex flex-col shrink-0`}
    >
      <div className="flex items-center justify-between mb-5 px-1">
        {sidebarOpen ? (
          <div className="flex items-center gap-2.5 min-w-0">
            <BrandLogo size="sm" />
            <div className="min-w-0">
              <p className="font-bold text-sm text-white truncate leading-tight">
                {theme.brandName || "Novamart"}
              </p>
              <p className="text-[10px] text-slate-400 uppercase tracking-wider">Painel</p>
            </div>
          </div>
        ) : (
          <BrandLogo size="sm" />
        )}
        <button
          onClick={onToggleSidebar}
          className="p-1.5 hover:bg-slate-800 rounded-md text-slate-400 hover:text-white"
          title={sidebarOpen ? "Recolher" : "Expandir"}
        >
          {sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
        </button>
      </div>

      <nav className="space-y-4 flex-1 overflow-y-auto -mx-1 px-1">
        {grouped.map(([group, items]) => (
          <div key={group}>
            {sidebarOpen && (
              <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 mb-1.5">
                {group}
              </p>
            )}
            <div className="space-y-0.5">
              {items.map((tab) => {
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => onChangeTab(tab.id)}
                    title={!sidebarOpen ? tab.label : undefined}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                      active
                        ? "bg-primary-soft text-white border border-[color:var(--color-primary)]/60"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white border border-transparent"
                    }`}
                  >
                    <tab.icon
                      className={`w-[18px] h-[18px] flex-shrink-0 ${active ? "text-primary" : ""}`}
                      style={active ? { color: "var(--color-primary)" } : undefined}
                    />
                    {sidebarOpen && <span className="truncate">{tab.label}</span>}
                    {sidebarOpen && active && <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-80" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-3 pt-3 border-t border-slate-800 space-y-1">
        <button
          onClick={onSwitchToClient}
          className="w-full px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 flex items-center gap-2"
        >
          <MessageCircle className="w-3.5 h-3.5" />
          {sidebarOpen && <span>Ver chat do cliente</span>}
        </button>
        <button
          type="button"
          onClick={() => {
            if (typeof Notification !== "undefined" && Notification.permission === "default") {
              Notification.requestPermission();
            }
          }}
          className="w-full px-3 py-2 rounded-lg text-xs text-slate-500 hover:text-slate-200 hover:bg-slate-800 flex items-center gap-2"
        >
          <Bell className="w-3.5 h-3.5" />
          {sidebarOpen && <span>Notificações do navegador</span>}
        </button>
      </div>
    </aside>
  );
}

function BrandLogo({ size = "md" }) {
  const { theme } = useTheme();
  const dims = size === "sm" ? "w-9 h-9" : size === "lg" ? "w-16 h-16" : "w-12 h-12";
  if (theme.logoUrl) {
    return (
      <div className={`${dims} rounded-xl overflow-hidden flex items-center justify-center shrink-0 bg-slate-800 border border-slate-700`}>
        <img src={theme.logoUrl} alt={theme.brandName || "Logo"} className="w-full h-full object-contain" />
      </div>
    );
  }
  return (
    <div
      className={`${dims} rounded-xl flex items-center justify-center shrink-0 shadow-sm`}
      style={{
        background: `linear-gradient(135deg, var(--color-primary), var(--color-primary-hover))`,
      }}
    >
      <Truck className="w-1/2 h-1/2 text-white" />
    </div>
  );
}

function TopBar({ activeTab, whatsappStatus, attendancesCount, onOpenSettings }) {
  const titles = {
    dashboard: { title: "Dashboard", subtitle: "Visão geral das operações em tempo real" },
    attendances: { title: "Atendimentos", subtitle: "Chamados registrados pelos clientes" },
    services: { title: "Serviços", subtitle: "Execução e despacho dos chamados" },
    providers: { title: "Prestadores", subtitle: "Base de parceiros cadastrados" },
    map: { title: "Mapa de operações", subtitle: "Prestadores e chamados ativos geolocalizados" },
    conversations: { title: "Conversas", subtitle: "WhatsApp, test mode e histórico" },
    tracking: { title: "Diagnóstico", subtitle: "Negociações, Google Maps e logs técnicos" },
    settings: { title: "Configurações", subtitle: "Preferências, aparência e regras de negócio" },
  };
  const current = titles[activeTab] || { title: "Painel", subtitle: "" };

  return (
    <header className="sticky top-0 z-30 flex items-center gap-4 px-6 py-3 bg-slate-900/80 backdrop-blur border-b border-slate-800">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-xl font-semibold truncate">{current.title}</h1>
          <span className="hidden sm:inline text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
            {attendancesCount} atendimentos
          </span>
        </div>
        <p className="text-xs text-slate-400 truncate">{current.subtitle}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div
          className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border ${
            whatsappStatus.connected
              ? "bg-green-500/10 text-green-300 border-green-500/30"
              : "bg-red-500/10 text-red-300 border-red-500/30"
          }`}
          title={whatsappStatus.connected ? "WhatsApp conectado" : "WhatsApp desconectado"}
        >
          <span
            className={`w-2 h-2 rounded-full ${whatsappStatus.connected ? "bg-green-400 animate-pulse" : "bg-red-400"}`}
          />
          WhatsApp {whatsappStatus.connected ? "online" : "offline"}
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          title="Preferências"
          className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}

function DashboardTab({ stats, services, negotiations, onGoToService }) {
  const cards = [
    { label: "Total de atendimentos", value: stats.total, icon: Phone, tone: "indigo" },
    { label: "Hoje", value: stats.today, icon: Clock, tone: "sky" },
    { label: "Em andamento", value: stats.in_progress, icon: Loader2, tone: "amber" },
    { label: "Concluídos", value: stats.completed, icon: CheckCircle, tone: "emerald" },
  ];

  const tonePalette = {
    indigo: { bg: "bg-indigo-500/10", border: "border-indigo-500/30", text: "text-indigo-300" },
    sky: { bg: "bg-sky-500/10", border: "border-sky-500/30", text: "text-sky-300" },
    amber: { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-300" },
    emerald: { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-300" },
  };

  const activeNeg = negotiations.filter(n => n.status === "pending").length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        {cards.map(card => {
          const t = tonePalette[card.tone];
          return (
            <div
              key={card.label}
              className={`relative rounded-xl p-5 border ${t.border} bg-slate-900 overflow-hidden`}
            >
              <div className={`absolute -top-4 -right-4 w-20 h-20 rounded-full ${t.bg}`} />
              <div className="flex items-center justify-between mb-2 relative">
                <span className="text-slate-400 text-xs uppercase tracking-wider">{card.label}</span>
                <card.icon className={`w-5 h-5 ${t.text}`} />
              </div>
              <p className="text-3xl font-bold text-white relative">{card.value || 0}</p>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-5">
        <div className="lg:col-span-1 panel p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-primary-soft">
              <MessageSquare className="w-5 h-5" style={{ color: "var(--color-primary)" }} />
            </div>
            <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
              Negociações ativas
            </h3>
          </div>
          <p className="text-4xl font-bold text-white">{activeNeg}</p>
          <p className="text-xs text-slate-400 mt-2">prestadores sendo contatados agora</p>
        </div>

        <div className="lg:col-span-2 panel p-6">
          <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider mb-4">
            Por tipo de serviço
          </h3>
          {(stats.by_service || []).length === 0 ? (
            <p className="text-slate-500 text-sm">Nenhum dado ainda.</p>
          ) : (
            <div className="space-y-2">
              {(stats.by_service || []).map((s, i) => {
                const maxCount = Math.max(1, ...(stats.by_service || []).map((x) => x.count || 0));
                const pct = Math.round(((s.count || 0) / maxCount) * 100);
                return (
                  <div key={i} className="flex items-center gap-3">
                    <span className="text-sm text-slate-300 capitalize w-32 shrink-0 truncate">
                      {s.service_type}
                    </span>
                    <div className="flex-1 h-2 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: "var(--color-primary)" }}
                      />
                    </div>
                    <span className="text-xs font-semibold text-slate-200 bg-slate-800 px-2 py-0.5 rounded-md shrink-0">
                      {s.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-5">
        <div className="panel p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
              Últimos atendimentos
            </h3>
            <span className="text-[11px] text-slate-500">{(stats.recent || []).length} registros</span>
          </div>
          {(stats.recent || []).length === 0 ? (
            <p className="text-slate-500 text-sm">Nenhum atendimento ainda.</p>
          ) : (
            <div className="space-y-1">
              {(stats.recent || []).slice(0, 6).map((att) => (
                <div
                  key={att.id}
                  className="flex items-center justify-between gap-3 py-2.5 px-3 rounded-lg hover:bg-slate-800/50"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-slate-100 truncate text-sm flex items-center gap-2">
                      {att.protocol && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary-soft text-primary" style={{ color: "var(--color-primary)" }}>
                          {att.protocol}
                        </span>
                      )}
                      {att.customer_name || "Cliente"}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {att.vehicle_plate || "—"} · {att.service_type || "—"}
                    </p>
                  </div>
                  <div className="text-right shrink-0 flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5">
                      <Timer className="w-3.5 h-3.5 text-slate-500" />
                      <ElapsedBadge att={att} />
                    </div>
                    <StatusBadge status={att.status} />
                    <p className="text-[10px] text-slate-500 mt-0.5">{formatDate(att.created_at)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
              Serviços recentes
            </h3>
            <span className="text-[11px] text-slate-500">clique para abrir</span>
          </div>
          {(!services || services.length === 0) ? (
            <p className="text-slate-500 text-sm">Nenhum serviço ainda.</p>
          ) : (
            <div className="space-y-1">
              {(services || []).slice(0, 6).map((svc) => (
                <button
                  key={svc.id}
                  type="button"
                  onClick={() => onGoToService?.(svc.id)}
                  className="w-full flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 hover:bg-slate-800/60 px-3 py-2.5 text-left transition-colors"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-sm capitalize truncate text-slate-100">
                      {svc.service_type || "Serviço"}
                    </p>
                    <p className="text-xs text-slate-500 truncate">
                      {svc.customer_name || "—"} · {svc.plate || "—"}
                    </p>
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1 text-[11px]">
                      <Timer className="w-3 h-3 text-slate-500" />
                      <ElapsedBadge
                        att={{
                          started_at: svc.attendance_started_at,
                          finished_at: svc.attendance_finished_at,
                          eta_minutes: svc.attendance_eta_minutes,
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={svc.status} />
                      <ChevronRight className="w-4 h-4 text-slate-500" />
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AttendancesTab({ attendances }) {
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [periodFilter, setPeriodFilter] = useState("all"); // all | today | 7d | 30d
  const [serviceFilter, setServiceFilter] = useState("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    const periodCutoff = periodFilter === "today"
      ? new Date().setHours(0, 0, 0, 0)
      : periodFilter === "7d"
      ? now - 7 * 24 * 3600 * 1000
      : periodFilter === "30d"
      ? now - 30 * 24 * 3600 * 1000
      : null;

    return (attendances || []).filter((a) => {
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      if (serviceFilter !== "all" && a.service_type !== serviceFilter) return false;
      if (periodCutoff != null) {
        const ts = Date.parse(String(a.created_at || "").replace(" ", "T") + "Z");
        if (!Number.isFinite(ts) || ts < periodCutoff) return false;
      }
      if (q) {
        const hay = [
          a.protocol,
          a.customer_name,
          a.caller_id,
          a.vehicle_plate,
          a.service_type,
          a.location,
          a.destination_address,
          a.provider_name,
        ]
          .map((v) => String(v || "").toLowerCase())
          .join(" ");
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [attendances, query, statusFilter, serviceFilter, periodFilter]);

  const statusOptions = [
    { id: "all", label: "Todos os status" },
    { id: "confirmed", label: "Confirmado" },
    { id: "in_progress", label: "Em andamento" },
    { id: "assigned", label: "Despachado" },
    { id: "completed", label: "Concluído" },
    { id: "cancelled", label: "Cancelado" },
    { id: "blocked", label: "Bloqueado" },
  ];
  const serviceOptions = useMemo(() => {
    const set = new Set();
    (attendances || []).forEach((a) => a.service_type && set.add(a.service_type));
    return [{ id: "all", label: "Todos os serviços" }, ...Array.from(set).map((s) => ({ id: s, label: s }))];
  }, [attendances]);

  const selected = filtered.find((a) => a.id === selectedId) || attendances.find((a) => a.id === selectedId) || null;

  return (
    <div className="space-y-5">
      <div className="panel p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 md:gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por protocolo, cliente, placa, telefone, endereço ou prestador..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
            />
          </div>
          <FilterSelect value={statusFilter} onChange={setStatusFilter} options={statusOptions} />
          <FilterSelect value={serviceFilter} onChange={setServiceFilter} options={serviceOptions} />
          <FilterSelect
            value={periodFilter}
            onChange={setPeriodFilter}
            options={[
              { id: "all", label: "Qualquer data" },
              { id: "today", label: "Hoje" },
              { id: "7d", label: "Últimos 7 dias" },
              { id: "30d", label: "Últimos 30 dias" },
            ]}
          />
          {(query || statusFilter !== "all" || serviceFilter !== "all" || periodFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
                setServiceFilter("all");
                setPeriodFilter("all");
              }}
              className="px-3 py-2 text-xs rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
            >
              Limpar filtros
            </button>
          )}
        </div>
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>
            Exibindo <strong className="text-slate-200">{filtered.length}</strong> de {attendances.length} atendimentos.
            Clique em uma linha para abrir o detalhe, iniciar o cronômetro e finalizar.
          </span>
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px]">
            <thead className="bg-slate-900/80 sticky top-0">
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Protocolo</th>
                <th className="px-4 py-3">Horário</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Telefone</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Placa</th>
                <th className="px-4 py-3">Origem</th>
                <th className="px-4 py-3">Destino</th>
                <th className="px-4 py-3">Prestador</th>
                <th className="px-4 py-3">Valor</th>
                <th className="px-4 py-3">Prev.</th>
                <th className="px-4 py-3">Tempo</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((att, idx) => {
                const notes = tryParse(att.notes);
                const origin = att.location || notes?.location || notes?.location_text || "—";
                const destination = att.destination_address || notes?.destination || "—";
                return (
                  <tr
                    key={att.id}
                    className={`border-t border-slate-800 hover:bg-slate-800/70 cursor-pointer ${idx % 2 === 0 ? "bg-slate-900/40" : ""}`}
                    onClick={() => setSelectedId(att.id)}
                  >
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: "var(--color-primary)" }}>
                      {att.protocol || String(att.id).slice(0, 8).toUpperCase()}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
                      {formatDate(att.created_at)}
                    </td>
                    <td className="px-4 py-3 text-slate-100">{att.customer_name || "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-300">{att.caller_id || "—"}</td>
                    <td className="px-4 py-3 capitalize text-slate-200">{att.service_type || "—"}</td>
                    <td className="px-4 py-3 font-mono text-slate-200">{att.vehicle_plate || "—"}</td>
                    <td className="px-4 py-3 text-xs text-slate-300 max-w-[180px] truncate" title={origin}>
                      {origin}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-300 max-w-[180px] truncate" title={destination}>
                      {destination}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-200">{att.provider_name || "—"}</td>
                    <td className="px-4 py-3 text-xs text-slate-200">
                      {att.provider_price != null ? `R$ ${parseFloat(att.provider_price).toFixed(2)}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-300">
                      {att.eta_minutes ? `${att.eta_minutes}min` : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs"><ElapsedBadge att={att} /></td>
                    <td className="px-4 py-3"><StatusBadge status={att.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="p-10 text-center text-slate-500">
            {attendances.length === 0
              ? "Nenhum atendimento registrado ainda."
              : "Nenhum atendimento corresponde aos filtros aplicados."}
          </div>
        )}
      </div>

      {selected && (
        <AttendanceDetailModal
          attendance={selected}
          onClose={() => setSelectedId(null)}
        />
      )}

      {attendances.some((a) => a.started_at && !a.finished_at) && (
        <DelayAlarmWatcher attendances={attendances} />
      )}
    </div>
  );
}

function FilterSelect({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function computeElapsedSeconds(att, now) {
  if (!att?.started_at) return 0;
  const started = Date.parse(String(att.started_at).replace(" ", "T") + "Z");
  if (!Number.isFinite(started)) return 0;
  const endMs = att.finished_at
    ? Date.parse(String(att.finished_at).replace(" ", "T") + "Z")
    : now;
  return Math.max(0, Math.floor((endMs - started) / 1000));
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function ElapsedBadge({ att }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!att?.started_at || att?.finished_at) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [att?.started_at, att?.finished_at]);
  if (!att?.started_at) return <span className="text-gray-500">—</span>;
  const secs = computeElapsedSeconds(att, now);
  const eta = Number(att.eta_minutes || 0);
  const delayed = eta > 0 && secs > eta * 60;
  return (
    <span
      className={`font-mono ${delayed ? "text-red-400" : att.finished_at ? "text-emerald-400" : ""}`}
      style={!delayed && !att.finished_at ? { color: "var(--color-primary)" } : undefined}
    >
      {formatClock(secs)}
    </span>
  );
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.2;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 600);
  } catch { /* ignore */ }
}

function DelayAlarmWatcher({ attendances }) {
  const [now, setNow] = useState(Date.now());
  const firedRef = useRef(new Set());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    for (const att of attendances) {
      if (!att.started_at || att.finished_at) continue;
      const eta = Number(att.eta_minutes || 0);
      if (!eta) continue;
      const secs = computeElapsedSeconds(att, now);
      const delayMinutes = Math.floor((secs - eta * 60) / 60);
      if (delayMinutes <= 0) continue;
      const step = Math.floor(delayMinutes / 10);
      if (step < 1) continue;
      const key = `${att.id}:${step}`;
      if (firedRef.current.has(key)) continue;
      firedRef.current.add(key);
      playBeep();
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("⏰ Atendimento atrasado", {
            body: `${att.customer_name || "Cliente"} — ${step * 10} min além da previsão`,
            tag: `delay-${att.id}`,
          });
        }
      } catch { /* ignore */ }
      fetch(`${API}/attendance/${att.id}/alarm-ack`, { method: "POST" }).catch(() => {});
    }
  }, [attendances, now]);

  return null;
}

function AttendanceDetailModal({ attendance, onClose }) {
  const [now, setNow] = useState(Date.now());
  const [form, setForm] = useState({
    provider_name: attendance.provider_name || "",
    provider_phone: attendance.provider_phone || "",
    provider_price: attendance.provider_price ?? "",
    eta_minutes: attendance.eta_minutes ?? "",
    destination_address: attendance.destination_address || "",
  });
  const [saving, setSaving] = useState(false);
  const [negotiations, setNegotiations] = useState([]);
  const [reloadTick, setReloadTick] = useState(0);
  const [startingQuotes, setStartingQuotes] = useState(false);
  const [observation, setObservation] = useState(attendance.observation || "");
  const [savingObs, setSavingObs] = useState(false);
  const [obsSaved, setObsSaved] = useState(false);

  useEffect(() => {
    setObservation(attendance.observation || "");
  }, [attendance.id, attendance.observation]);

  async function saveObservation() {
    setSavingObs(true);
    try {
      await fetch(`${API}/attendance/${attendance.id}/observation`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observation }),
      });
      setObsSaved(true);
      setTimeout(() => setObsSaved(false), 1800);
    } finally {
      setSavingObs(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/attendance/${attendance.id}/negotiations`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!cancelled) setNegotiations(Array.isArray(data) ? data : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [attendance.id, reloadTick]);

  async function startQuotes() {
    if (!confirm("Iniciar cotação com até 5 prestadores mais próximos (conforme regras de negócio)?")) return;
    setStartingQuotes(true);
    try {
      await fetch(`${API}/attendance/${attendance.id}/start-quotes`, { method: "POST" });
      setTimeout(() => setReloadTick((t) => t + 1), 800);
    } finally {
      setStartingQuotes(false);
    }
  }
  const notes = tryParse(attendance.notes);
  let gestorMedia = [];
  try {
    if (attendance.gestor_media_json) {
      const j = JSON.parse(attendance.gestor_media_json);
      if (Array.isArray(j)) gestorMedia = j;
    }
  } catch {
    gestorMedia = [];
  }
  const origin = attendance.location || notes?.location || notes?.location_text || "—";
  const isRunning = !!attendance.started_at && !attendance.finished_at;
  const secs = computeElapsedSeconds(attendance, now);
  const eta = Number(attendance.eta_minutes || 0);
  const delayed = eta > 0 && secs > eta * 60 && !attendance.finished_at;

  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  useEffect(() => {
    setForm({
      provider_name: attendance.provider_name || "",
      provider_phone: attendance.provider_phone || "",
      provider_price: attendance.provider_price ?? "",
      eta_minutes: attendance.eta_minutes ?? "",
      destination_address: attendance.destination_address || notes?.destination || "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attendance.id]);

  async function saveProvider() {
    setSaving(true);
    try {
      await fetch(`${API}/attendance/${attendance.id}/provider`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    } finally {
      setSaving(false);
    }
  }

  async function startTimer() {
    await fetch(`${API}/attendance/${attendance.id}/start`, { method: "POST" });
  }

  async function finish() {
    if (!confirm("Confirma finalizar este atendimento?")) return;
    await fetch(`${API}/attendance/${attendance.id}/finish`, { method: "POST" });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 rounded-2xl max-w-3xl w-full border border-slate-700 max-h-[92vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 px-6 py-4 border-b border-slate-800 bg-slate-900/95 backdrop-blur">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="px-2.5 py-1 rounded-md text-xs font-mono"
              style={{ background: "var(--color-primary-soft)", color: "var(--color-primary)" }}
            >
              {attendance.protocol || String(attendance.id).slice(0, 8).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-bold text-white truncate">
                {attendance.customer_name || "Atendimento"}
              </h3>
              <p className="text-[11px] text-slate-500 font-mono">ID: {attendance.id}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0 flex-wrap justify-end">
            <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5">
              <Timer className="w-4 h-4 text-slate-400" />
              <ElapsedBadge att={attendance} />
            </div>
            <StatusBadge status={attendance.status} />
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-white"
              aria-label="Fechar"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="p-6">

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm mb-5">
          <Info label="Horário (criado)" value={formatDate(attendance.created_at)} />
          <Info label="Telefone" value={attendance.caller_id || "—"} mono />
          <Info label="Cliente" value={attendance.customer_name || "—"} />
          <Info label="Tipo" value={attendance.service_type || "—"} capitalize />
          <Info label="Placa" value={attendance.vehicle_plate || "—"} mono />
          <Info label="Veículo" value={attendance.vehicle_type || notes?.vehicle_type || "—"} />
          <Info label="Origem" value={origin} colSpan />
          <Info label="Destino" value={form.destination_address || "—"} colSpan />
          <Info label="Status" value={<StatusBadge status={attendance.status} />} />
          <Info label="Canal" value={notes?.channel || "—"} />
        </div>

        <div className={`rounded-xl p-4 border mb-5 ${delayed ? "border-red-500/60 bg-red-950/40" : "border-gray-700 bg-gray-900/40"}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Timer className="w-5 h-5" />
              <span className="text-sm text-gray-300">Cronômetro</span>
            </div>
            <div className="flex items-center gap-2">
              {!attendance.started_at && (
                <button type="button" onClick={startTimer} className="flex items-center gap-1 px-3 py-1.5 btn-primary text-sm">
                  <Play className="w-4 h-4" /> Iniciar
                </button>
              )}
              {attendance.started_at && !attendance.finished_at && (
                <button type="button" onClick={finish} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-sm">
                  <Square className="w-4 h-4" /> Finalizar
                </button>
              )}
            </div>
          </div>
          <div className={`mt-3 text-3xl font-mono ${delayed ? "text-red-400" : attendance.finished_at ? "text-green-400" : "text-indigo-300"}`}>
            {formatClock(secs)}
          </div>
          {eta > 0 && (
            <p className="mt-1 text-xs text-gray-400 flex items-center gap-1">
              <Bell className="w-3 h-3" />
              Previsão {eta} min {delayed ? `— atrasado há ${Math.floor((secs - eta * 60) / 60)} min (alarme a cada 10 min)` : ""}
            </p>
          )}
          {attendance.finished_at && (
            <p className="mt-1 text-xs text-green-400">Concluído em {formatDate(attendance.finished_at)}</p>
          )}
        </div>

        {(attendance.distance_km != null || attendance.plan_used) && (
          <div className="mb-5 rounded-xl border border-gray-700 bg-gray-900/40 p-4">
            <h4 className="text-sm font-semibold mb-2">Distância e plano</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <Info
                label="Distância"
                value={attendance.distance_km != null ? `${Number(attendance.distance_km).toFixed(1)} km` : "—"}
              />
              <Info
                label="Plano"
                value={attendance.plan_used ? `${attendance.plan_used} (${attendance.plan_max_km} km)` : "—"}
              />
              <Info
                label="Excedente"
                value={Number(attendance.excess_km || 0) > 0 ? `${Number(attendance.excess_km).toFixed(1)} km` : "dentro"}
              />
              <Info
                label="Valor excedente"
                value={`R$ ${Number(attendance.excess_charge || 0).toFixed(2)}`}
              />
            </div>
          </div>
        )}

        {(notes?.billing_mode === "prepay_non_associate" || gestorMedia.length > 0) && (
          <div className="mb-5 rounded-xl border border-amber-900/50 bg-amber-950/20 p-4">
            <h4 className="text-sm font-semibold mb-2 text-amber-200">Pagamento e mídias (gestor)</h4>
            {notes?.billing_mode === "prepay_non_associate" && (
              <div className="text-xs text-slate-300 space-y-1 mb-3">
                <p>
                  Modo: <span className="text-amber-400">não associado — pagamento antecipado</span>
                </p>
                {notes?.provider_quote_price != null && (
                  <p>Valor do reboque (prestador): R$ {Number(notes.provider_quote_price).toFixed(2)}</p>
                )}
                {notes?.client_charge_price != null && (
                  <p>Valor ao cliente (com taxa): R$ {Number(notes.client_charge_price).toFixed(2)}</p>
                )}
                {notes?.markup_percent_applied != null && Number(notes.markup_percent_applied) > 0 && (
                  <p>Taxa aplicada: {notes.markup_percent_applied}%</p>
                )}
                {notes?.workflow_phase && (
                  <p>
                    Etapa do fluxo: <span className="font-mono text-slate-400">{notes.workflow_phase}</span>
                  </p>
                )}
                {notes?.provider_pix_key && (
                  <p className="break-all text-slate-200">Chave PIX (prestador): {notes.provider_pix_key}</p>
                )}
              </div>
            )}
            {gestorMedia.length > 0 ? (
              <ul className="space-y-2 text-xs">
                {gestorMedia.map((m, i) => (
                  <li key={i} className="border border-slate-700 rounded-lg p-2 bg-slate-900/60">
                    <span className="text-slate-500">{m.at ? formatDate(m.at) : "—"}</span>
                    <span className="text-slate-400"> · {m.kind || "mídia"}</span>
                    <span className="text-slate-400"> · {m.from || "?"}</span>
                    {m.caption && <span className="block text-slate-300 mt-1">{m.caption}</span>}
                    {m.media_hint && (
                      <span className="block text-slate-500 mt-1 break-all text-[11px]">{m.media_hint}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              notes?.billing_mode === "prepay_non_associate" && (
                <p className="text-xs text-slate-500">Nenhuma mídia registrada ainda (fotos / comprovante).</p>
              )
            )}
          </div>
        )}

        <div className="mb-5 rounded-xl border border-gray-700 bg-gray-900/40 p-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold">Cotações dos prestadores</h4>
            <button
              type="button"
              onClick={startQuotes}
              disabled={startingQuotes}
              className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-xs"
            >
              {startingQuotes ? "Iniciando..." : negotiations.length > 0 ? "Recotar" : "Iniciar cotação"}
            </button>
          </div>
          {negotiations.length === 0 ? (
            <p className="text-xs text-gray-500">Nenhum orçamento solicitado para este atendimento ainda.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-gray-700">
              <table className="w-full text-xs">
                <thead className="bg-gray-700/60">
                  <tr className="text-left">
                    <th className="px-3 py-2">Prestador</th>
                    <th className="px-3 py-2">Distância</th>
                    <th className="px-3 py-2">Preço</th>
                    <th className="px-3 py-2">Previsão</th>
                    <th className="px-3 py-2">Nota fiscal</th>
                    <th className="px-3 py-2">Score</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {negotiations.map((n) => (
                    <tr
                      key={n.id}
                      className={`border-t border-gray-700 ${n.status === "accepted" ? "bg-green-900/20" : ""}`}
                    >
                      <td className="px-3 py-2">{n.provider_name_full || n.provider_id?.slice(0, 8) || "—"}</td>
                      <td className="px-3 py-2">
                        {n.distance_km != null ? `${Number(n.distance_km).toFixed(1)} km` : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {n.final_price != null
                          ? `R$ ${Number(n.final_price).toFixed(2)}`
                          : n.counter_price != null
                          ? `R$ ${Number(n.counter_price).toFixed(2)}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2">{n.eta_minutes != null ? `${n.eta_minutes} min` : "—"}</td>
                      <td className="px-3 py-2 text-[11px]">
                        {n.invoice_awaiting ? (
                          <span className="text-amber-400">aguardando resposta</span>
                        ) : n.invoice_info ? (
                          <span className="text-gray-200">{n.invoice_info}</span>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{n.score != null ? Number(n.score).toFixed(2) : "—"}</td>
                      <td className="px-3 py-2">
                        <StatusBadge status={n.status} small />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="mb-5 rounded-xl border border-gray-700 bg-gray-900/40 p-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold">Observação</h4>
            <div className="flex items-center gap-2">
              {obsSaved && <span className="text-xs text-green-400">✓ salvo</span>}
              <button
                type="button"
                onClick={saveObservation}
                disabled={savingObs}
                className="px-3 py-1.5 btn-primary disabled:opacity-50 text-xs"
              >
                {savingObs ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
          <textarea
            value={observation}
            onChange={(e) => setObservation(e.target.value)}
            rows={4}
            placeholder="Ex.: nota fiscal enviada em 2 dias; prestador pediu pedágio à parte; etc."
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <p className="text-[11px] text-gray-500 mt-1">
            Informações da nota fiscal e comentários do atendimento ficam aqui. Preenchido automaticamente ao fechar a cotação.
          </p>
        </div>

        <h4 className="text-sm font-semibold mb-2">Prestador / Atendimento</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <LabeledInput label="Prestador (nome)" value={form.provider_name} onChange={(v) => setForm({ ...form, provider_name: v })} />
          <LabeledInput label="Telefone do prestador" value={form.provider_phone} onChange={(v) => setForm({ ...form, provider_phone: v })} />
          <LabeledInput label="Valor cobrado (R$)" value={form.provider_price} onChange={(v) => setForm({ ...form, provider_price: v })} />
          <LabeledInput label="Previsão (min)" value={form.eta_minutes} onChange={(v) => setForm({ ...form, eta_minutes: v })} />
          <div className="md:col-span-2">
            <LabeledInput label="Endereço de destino" value={form.destination_address} onChange={(v) => setForm({ ...form, destination_address: v })} />
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button type="button" onClick={saveProvider} disabled={saving} className="flex-1 py-2 btn-primary disabled:opacity-50 text-sm">
            {saving ? "Salvando..." : "Salvar dados do prestador"}
          </button>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-200">
            Fechar
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}

function Info({ label, value, mono, capitalize, colSpan }) {
  return (
    <div className={colSpan ? "sm:col-span-2 min-w-0" : "min-w-0"}>
      <p className="text-xs text-slate-500 mb-0.5 uppercase tracking-wider">{label}</p>
      <div className={`text-gray-200 break-words ${mono ? "font-mono" : ""} ${capitalize ? "capitalize" : ""}`}>{value}</div>
    </div>
  );
}

function LabeledInput({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
      />
    </label>
  );
}

function ServicesTab({ services, negotiations, pendingOpenId, onConsumedPendingOpen }) {
  const [selected, setSelected] = useState(null);
  const [detailPayload, setDetailPayload] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    if (!pendingOpenId || !services?.length) return;
    const svc = services.find((s) => s.id === pendingOpenId);
    if (svc) {
      openDetail(svc);
      onConsumedPendingOpen?.();
    }
  }, [pendingOpenId, services]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- openDetail is stable enough for this trigger

  async function openDetail(svc) {
    setSelected(svc);
    setDetailPayload(null);
    setLoadingDetail(true);
    try {
      const r = await fetch(`${API}/services/${svc.id}`);
      if (r.ok) setDetailPayload(await r.json());
    } catch {
      setDetailPayload(null);
    }
    setLoadingDetail(false);
  }

  function parseSvcNotes(svc) {
    try {
      return svc.notes ? JSON.parse(svc.notes) : {};
    } catch {
      return {};
    }
  }

  function closeDetail() {
    setSelected(null);
    setDetailPayload(null);
  }

  function towingLabel(ta) {
    if (!ta || ta === "nao_aplicavel") return "—";
    const m = { facil: "fácil", dificil: "difícil", bloqueado: "bloqueado" };
    return m[ta] || ta;
  }

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const serviceStatusOptions = [
    { id: "all", label: "Todos os status" },
    { id: "pending", label: "Pendente" },
    { id: "assigned", label: "Despachado" },
    { id: "in_progress", label: "Em andamento" },
    { id: "completed", label: "Concluído" },
    { id: "cancelled", label: "Cancelado" },
  ];

  const filteredServices = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (services || []).filter((svc) => {
      if (statusFilter !== "all" && svc.status !== statusFilter) return false;
      if (!q) return true;
      const n = parseSvcNotes(svc);
      const hay = [
        svc.service_type,
        svc.customer_name,
        svc.customer_phone,
        svc.plate,
        svc.provider_name,
        n.location_text,
        n.location,
      ]
        .map((v) => String(v || "").toLowerCase())
        .join(" ");
      return hay.includes(q);
    });
  }, [services, query, statusFilter]);

  return (
    <div className="space-y-5">
      <div className="panel p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 md:gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por cliente, placa, prestador, endereço..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
            />
          </div>
          <FilterSelect value={statusFilter} onChange={setStatusFilter} options={serviceStatusOptions} />
          {(query || statusFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
              }}
              className="px-3 py-2 text-xs rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
            >
              Limpar
            </button>
          )}
        </div>
        <p className="text-xs text-slate-400">
          Exibindo <strong className="text-slate-200">{filteredServices.length}</strong> de {services.length}. Clique em um serviço para ver endereço, placa e demais dados.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredServices.map((svc) => {
          const svcNegs = negotiations.filter((n) => n.service_id === svc.id);
          const n = parseSvcNotes(svc);
          const locPreview = n.location_text || n.location || "";
          return (
            <button
              type="button"
              key={svc.id}
              onClick={() => openDetail(svc)}
              className="panel p-5 text-left hover:border-[color:var(--color-primary)]/60 transition-colors w-full flex flex-col gap-2"
            >
              <div className="flex items-center justify-between">
                <StatusBadge status={svc.status} />
                <span className="text-[10px] text-slate-500">{formatDate(svc.created_at)}</span>
              </div>
              <h3 className="font-semibold capitalize text-slate-100">{svc.service_type || "—"}</h3>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Timer className="w-3.5 h-3.5 shrink-0" />
                <ElapsedBadge
                  att={{
                    started_at: svc.attendance_started_at,
                    finished_at: svc.attendance_finished_at,
                    eta_minutes: svc.attendance_eta_minutes,
                  }}
                />
              </div>
              <p className="text-sm text-slate-400">
                {svc.customer_name || "Cliente"} · Placa {svc.plate || "—"}
              </p>
              {locPreview && (
                <p className="text-xs text-slate-500 line-clamp-2">
                  <MapPin className="inline w-3 h-3 -mt-0.5 mr-1" />
                  {locPreview}
                </p>
              )}
              {svc.provider_name && (
                <p className="text-sm text-emerald-300">Prestador: {svc.provider_name}</p>
              )}
              {svc.price != null && svc.price !== "" && (
                <p className="text-sm font-semibold" style={{ color: "var(--color-primary)" }}>
                  R$ {parseFloat(svc.price).toFixed(2)}
                </p>
              )}
              {svcNegs.length > 0 && (
                <div className="mt-2 pt-3 border-t border-slate-800">
                  <p className="text-[11px] text-slate-400 mb-1.5">
                    {svcNegs.length} negociação(ões)
                  </p>
                  {svcNegs.slice(0, 12).map((ng) => {
                    const q = negotiationQuotedPrice(ng);
                    return (
                      <div key={ng.id} className="text-xs flex justify-between gap-2">
                        <StatusBadge status={ng.status} small />
                        <span className="text-slate-300 shrink-0">
                          {q != null ? `R$ ${q.toFixed(2)}` : "—"}
                        </span>
                      </div>
                    );
                  })}
                  {svcNegs.length > 12 && (
                    <p className="text-[10px] text-slate-500 mt-1">+{svcNegs.length - 12} outra(s)</p>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
      {filteredServices.length === 0 && (
        <div className="text-center text-slate-500 py-12 panel">
          {services.length === 0 ? "Nenhum serviço registrado." : "Nenhum serviço corresponde à busca."}
        </div>
      )}

      {selected && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/70"
          onClick={closeDetail}
          role="presentation"
        >
          <div
            className="bg-gray-800 rounded-xl w-full max-w-[min(100%,32rem)] p-6 border border-gray-600 max-h-[90vh] overflow-y-auto overflow-x-hidden shadow-xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold mb-4">Detalhes do serviço</h3>
            {loadingDetail && <p className="text-gray-400">Carregando...</p>}
            {!loadingDetail && detailPayload && (
              <div className="space-y-3 text-sm">
                <p><span className="text-gray-500">ID:</span> <span className="font-mono text-xs">{detailPayload.id}</span></p>
                <p><span className="text-gray-500">Cliente:</span> {detailPayload.customer_name || "—"}</p>
                <p><span className="text-gray-500">Telefone:</span> {detailPayload.customer_phone || "—"}</p>
                <p><span className="text-gray-500">Endereço / local:</span> {detailPayload.detail?.location_text || detailPayload.detail?.location || "—"}</p>
                <p><span className="text-gray-500">Placa:</span> {detailPayload.plate || detailPayload.detail?.vehicle_plate || "—"}</p>
                <p><span className="text-gray-500">Veículo:</span> {detailPayload.detail?.vehicle_type || "—"}</p>
                <p><span className="text-gray-500">Problema:</span> {detailPayload.detail?.problem_type || "—"}</p>
                <p><span className="text-gray-500">Urgência:</span> {detailPayload.detail?.urgency || "—"}</p>
                <p><span className="text-gray-500">Acesso reboque:</span> {towingLabel(detailPayload.detail?.towing_access)}</p>
                <p><span className="text-gray-500">Status:</span> <StatusBadge status={detailPayload.status} /></p>
                {detailPayload.provider_name && (
                  <p><span className="text-gray-500">Prestador:</span> {detailPayload.provider_name}</p>
                )}
                {detailPayload.price != null && detailPayload.price !== "" && (
                  <p><span className="text-gray-500">Valor:</span> R$ {parseFloat(detailPayload.price).toFixed(2)}</p>
                )}
              </div>
            )}
            {!loadingDetail && !detailPayload && (
              <p className="text-red-400">Não foi possível carregar os detalhes.</p>
            )}
            <button
              type="button"
              onClick={closeDetail}
              className="mt-6 px-4 py-2 btn-primary text-sm w-full"
            >
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProvidersTab({ providers, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    phone: "",
    whatsapp: "",
    address_text: "",
    latitude: "",
    longitude: "",
    serviceIds: [],
  });

  function toggleProviderService(id) {
    setForm((f) => ({
      ...f,
      serviceIds: f.serviceIds.includes(id) ? f.serviceIds.filter((x) => x !== id) : [...f.serviceIds, id],
    }));
  }

  async function saveProvider() {
    if (!form.name.trim()) {
      alert("Informe o nome do prestador.");
      return;
    }
    if (!form.serviceIds.length) {
      alert("Marque ao menos um tipo de serviço.");
      return;
    }
    const { serviceIds, ...rest } = form;
    const body = {
      ...rest,
      services: serviceIds.join(","),
    };
    if (form.latitude) body.latitude = form.latitude;
    if (form.longitude) body.longitude = form.longitude;
    try {
      const res = await fetch(`${API}/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao salvar prestador.");
        return;
      }
      setShowForm(false);
      setForm({ name: "", phone: "", whatsapp: "", address_text: "", latitude: "", longitude: "", serviceIds: [] });
      onRefresh();
    } catch (e) {
      alert("Erro de conexão: " + e.message);
    }
  }

  async function deleteProvider(id) {
    if (!id || !confirm("Remover este prestador? Ele deixará de aparecer na lista e no despacho.")) return;
    try {
      const res = await fetch(`${API}/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      onRefresh();
    } catch (e) {
      alert("Erro ao excluir: " + e.message);
    }
  }

  const [query, setQuery] = useState("");
  const [serviceFilter, setServiceFilter] = useState("all");

  const providerServiceOptions = useMemo(() => {
    return [
      { id: "all", label: "Todos os serviços" },
      ...SERVICE_TYPES.map((s) => ({ id: s.id, label: s.label })),
    ];
  }, []);

  const filteredProviders = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (providers || []).filter((p) => {
      const servicesStr = String(p.services || "").toLowerCase();
      if (serviceFilter !== "all" && !servicesStr.split(/[,;\s]+/).includes(String(serviceFilter).toLowerCase())) {
        return false;
      }
      if (!q) return true;
      const hay = [p.name, p.phone, p.whatsapp, p.address_text, p.services]
        .map((v) => String(v || "").toLowerCase())
        .join(" ");
      return hay.includes(q);
    });
  }, [providers, query, serviceFilter]);

  return (
    <div className="space-y-5">
      <div className="panel p-4 flex flex-wrap items-center gap-2 md:gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nome, telefone, endereço..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
          />
        </div>
        <FilterSelect value={serviceFilter} onChange={setServiceFilter} options={providerServiceOptions} />
        <span className="text-xs text-slate-400">
          {filteredProviders.length} / {providers.length}
        </span>
        <button
          onClick={() => {
            setForm({ name: "", phone: "", whatsapp: "", address_text: "", latitude: "", longitude: "", serviceIds: [] });
            setShowForm(true);
          }}
          className="ml-auto px-4 py-2 btn-primary rounded-lg text-sm flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> Novo prestador
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredProviders.map((p) => (
          <ProviderCard key={p.id} provider={p} onRefresh={onRefresh} onDelete={deleteProvider} />
        ))}
      </div>
      {filteredProviders.length === 0 && (
        <div className="text-center text-slate-500 py-12 panel">
          {providers.length === 0 ? "Nenhum prestador cadastrado." : "Nenhum prestador corresponde aos filtros."}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowForm(false)}>
          <div className="bg-gray-800 rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">Novo Prestador</h3>
            <div className="space-y-3">
              <input type="text" placeholder="Nome" value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full bg-gray-700 rounded-lg px-4 py-2 text-sm" />
              <input type="text" placeholder="Telefone" value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} className="w-full bg-gray-700 rounded-lg px-4 py-2 text-sm" />
              <input type="text" placeholder="WhatsApp" value={form.whatsapp} onChange={e => setForm({...form, whatsapp: e.target.value})} className="w-full bg-gray-700 rounded-lg px-4 py-2 text-sm" />
              <input
                type="text"
                placeholder="Endereço base (rua, número, cidade)"
                value={form.address_text}
                onChange={(e) => setForm({ ...form, address_text: e.target.value })}
                className="w-full bg-gray-700 rounded-lg px-4 py-2 text-sm"
              />
              <div>
                <p className="text-xs text-gray-400 mb-2">Serviços oferecidos</p>
                <div className="space-y-2 rounded-lg border border-gray-600 bg-gray-900/50 p-3">
                  {SERVICE_TYPES.map((st) => (
                    <label key={st.id} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="rounded border-gray-600 text-indigo-600"
                        checked={form.serviceIds.includes(st.id)}
                        onChange={() => toggleProviderService(st.id)}
                      />
                      {st.label}
                    </label>
                  ))}
                </div>
              </div>
              <p className="text-xs text-gray-400">Coordenadas do local base (despacho por distância). Vírgula ou ponto.</p>
              <button
                type="button"
                className="w-full text-xs py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-gray-200"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    latitude: "-23.5505",
                    longitude: "-46.6333",
                  }))
                }
              >
                Preencher coordenadas (centro de São Paulo — ajuste depois no mapa)
              </button>
              <div className="grid grid-cols-2 gap-3">
                <input type="text" inputMode="decimal" placeholder="Latitude (ex.: -23,5505)" value={form.latitude} onChange={e => setForm({...form, latitude: e.target.value})} className="bg-gray-700 rounded-lg px-4 py-2 text-sm" />
                <input type="text" inputMode="decimal" placeholder="Longitude (ex.: -46,6333)" value={form.longitude} onChange={e => setForm({...form, longitude: e.target.value})} className="bg-gray-700 rounded-lg px-4 py-2 text-sm" />
              </div>
              <div className="flex gap-2 pt-2">
                <button onClick={() => setShowForm(false)} className="flex-1 px-4 py-2 bg-gray-700 rounded-lg text-sm">Cancelar</button>
                <button onClick={saveProvider} className="flex-1 px-4 py-2 btn-primary text-sm">Salvar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MapTab({ providers, services, attendances = [] }) {
  const mapRef = useRef(null);
  const leafletMap = useRef(null);
  const markersLayerRef = useRef(null);
  const leafletRef = useRef(null);
  const providerMarkersRef = useRef([]);
  const serviceMarkersRef = useRef([]);
  const [mapAttendanceId, setMapAttendanceId] = useState("");
  const [query, setQuery] = useState("");
  const [showProviders, setShowProviders] = useState(true);
  const [showServices, setShowServices] = useState(true);

  const { theme } = useTheme();
  const primaryColor = theme.primaryColor || "#6366f1";

  const servicesForMap = useMemo(() => {
    const base = (services || []).filter(
      (s) => s.status === "pending" || s.status === "in_progress" || s.status === "assigned"
    );
    const filtered = mapAttendanceId ? base.filter((s) => s.attendance_id === mapAttendanceId) : base;
    const q = query.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter((s) => {
      const n = parseNotesJson(s.notes);
      const hay = [s.customer_name, s.plate, s.service_type, n.location_text, n.location]
        .map((v) => String(v || "").toLowerCase())
        .join(" ");
      return hay.includes(q);
    });
  }, [services, mapAttendanceId, query]);

  const providersFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers || [];
    return (providers || []).filter((p) =>
      [p.name, p.phone, p.address_text, p.services]
        .map((v) => String(v || "").toLowerCase())
        .join(" ")
        .includes(q)
    );
  }, [providers, query]);

  const attendanceOptions = useMemo(() => {
    return (attendances || []).slice(0, 80).map((a) => ({
      id: a.id,
      label: `${a.protocol || String(a.id).slice(0, 8).toUpperCase()} · ${a.customer_name || "Cliente"} · ${String(a.service_type || "").slice(0, 16)}`,
    }));
  }, [attendances]);

  useEffect(() => {
    if (!mapRef.current) return;
    let cancelled = false;

    import("leaflet").then((L) => {
      if (cancelled || !mapRef.current) return;
      leafletRef.current = L;

      if (!leafletMap.current) {
        const map = L.map(mapRef.current, { zoomControl: true }).setView([-23.55, -46.63], 11);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "&copy; OpenStreetMap",
        }).addTo(map);
        markersLayerRef.current = L.layerGroup().addTo(map);
        leafletMap.current = map;
        setTimeout(() => {
          try { map.invalidateSize(); } catch { /* ignore */ }
        }, 250);
      }

      const map = leafletMap.current;
      const layer = markersLayerRef.current;
      if (!map || !layer) return;

      layer.clearLayers();
      providerMarkersRef.current = [];
      serviceMarkersRef.current = [];

      const providerIcon = L.divIcon({
        className: "",
        html: `<div style="background:${primaryColor};width:28px;height:28px;border-radius:50%;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;color:white;">P</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const serviceIcon = L.divIcon({
        className: "",
        html: `<div style="background:#ef4444;width:28px;height:28px;border-radius:50%;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;color:white;">S</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const bounds = [];

      if (showProviders) {
        providersFiltered.forEach((p) => {
          const la = Number(p.latitude);
          const ln = Number(p.longitude);
          if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
          const safeName = String(p.name || "").replace(/</g, "");
          const svcs = String(p.services || "").replace(/</g, "");
          const phone = String(p.phone || "—").replace(/</g, "");
          const addr = String(p.address_text || "").replace(/</g, "");
          const m = L.marker([la, ln], { icon: providerIcon }).bindPopup(
            `<div style="min-width:220px;">
              <p style="margin:0;font-size:13px;"><b>${safeName}</b></p>
              <p style="margin:4px 0 0;font-size:12px;color:#cbd5e1;">Serviços: ${svcs || "—"}</p>
              ${addr ? `<p style="margin:4px 0 0;font-size:11px;color:#94a3b8;">${addr}</p>` : ""}
              <p style="margin:6px 0 0;font-size:11px;color:#94a3b8;">Tel.: ${phone}</p>
              <p style="margin:6px 0 0;font-size:10px;font-weight:bold;color:${primaryColor};text-transform:uppercase;letter-spacing:.08em;">Prestador</p>
            </div>`
          );
          m._providerId = p.id;
          layer.addLayer(m);
          providerMarkersRef.current.push({ marker: m, lat: la, lng: ln, provider: p });
          bounds.push([la, ln]);
        });
      }

      if (showServices) {
        servicesForMap.forEach((s) => {
          const coords = getServiceMapCoords(s);
          if (!coords) return;
          const [la, ln] = coords;
          const n = parseNotesJson(s.notes);
          const addr = (n.location_text || n.location || "").replace(/</g, "");
          const safeName = String(s.customer_name || "").replace(/</g, "");
          const safeType = String(s.service_type || "").replace(/</g, "");
          const plate = String(s.plate || "—").replace(/</g, "");
          const proto = String(s.attendance_protocol || "").replace(/</g, "");
          const m = L.marker([la, ln], { icon: serviceIcon }).bindPopup(
            `<div style="min-width:220px;">
              ${proto ? `<p style="margin:0;font-size:11px;color:${primaryColor};font-family:monospace;">${proto}</p>` : ""}
              <p style="margin:2px 0 0;font-size:13px;"><b>${safeName}</b></p>
              <p style="margin:4px 0 0;font-size:12px;color:#cbd5e1;">${safeType} · Placa ${plate}</p>
              ${addr ? `<p style="margin:4px 0 0;font-size:11px;color:#94a3b8;">${addr}</p>` : ""}
              <p style="margin:6px 0 0;font-size:10px;font-weight:bold;color:#ef4444;text-transform:uppercase;letter-spacing:.08em;">Chamado</p>
            </div>`
          );
          m._serviceId = s.id;
          layer.addLayer(m);
          serviceMarkersRef.current.push({ marker: m, lat: la, lng: ln, service: s });
          bounds.push([la, ln]);
        });
      }

      if (bounds.length > 0) {
        try {
          map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });
        } catch {
          map.setView(bounds[0], 13);
        }
      }

      setTimeout(() => {
        try { map.invalidateSize(); } catch { /* ignore */ }
      }, 50);
    });

    return () => { cancelled = true; };
  }, [providersFiltered, servicesForMap, showProviders, showServices, primaryColor]);

  useEffect(() => {
    return () => {
      if (leafletMap.current) {
        try { leafletMap.current.remove(); } catch { /* ignore */ }
        leafletMap.current = null;
        markersLayerRef.current = null;
      }
    };
  }, []);

  function handleRecentralize() {
    const map = leafletMap.current;
    if (!map) return;
    const pts = [];
    if (showProviders) providerMarkersRef.current.forEach((p) => pts.push([p.lat, p.lng]));
    if (showServices) serviceMarkersRef.current.forEach((s) => pts.push([s.lat, s.lng]));
    if (pts.length === 0) return;
    try {
      map.fitBounds(pts, { padding: [48, 48], maxZoom: 14, animate: true });
    } catch { /* ignore */ }
  }

  function handleFullScreen() {
    try {
      const el = mapRef.current;
      if (el && !document.fullscreenElement) {
        el.requestFullscreen?.();
      } else {
        document.exitFullscreen?.();
      }
    } catch { /* ignore */ }
    setTimeout(() => {
      try { leafletMap.current?.invalidateSize(); } catch { /* ignore */ }
    }, 150);
  }

  const totalActive = (providers || []).filter((p) => Number.isFinite(Number(p.latitude))).length;
  const totalCalls = servicesForMap.length;

  return (
    <div className="space-y-4 min-w-0">
      <div className="panel p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 md:gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar no mapa (cliente, placa, prestador, endereço)..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
            />
          </div>
          <select
            value={mapAttendanceId}
            onChange={(e) => setMapAttendanceId(e.target.value)}
            className="min-w-[240px] max-w-[340px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200"
          >
            <option value="">Todos os chamados ativos</option>
            {attendanceOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleRecentralize}
            title="Centralizar no que está visível"
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            <Crosshair className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleFullScreen}
            title="Tela cheia"
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-2 cursor-pointer select-none text-slate-300">
            <input
              type="checkbox"
              checked={showProviders}
              onChange={(e) => setShowProviders(e.target.checked)}
              className="rounded border-slate-600"
              style={{ accentColor: "var(--color-primary)" }}
            />
            <span className="flex items-center gap-1.5">
              <span
                className="w-3 h-3 rounded-full inline-block border border-white/50"
                style={{ background: primaryColor }}
              />
              Prestadores
            </span>
            <span className="text-slate-500">({providersFiltered.length})</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none text-slate-300">
            <input
              type="checkbox"
              checked={showServices}
              onChange={(e) => setShowServices(e.target.checked)}
              className="rounded border-slate-600"
              style={{ accentColor: "#ef4444" }}
            />
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full inline-block bg-red-500 border border-white/50" />
              Chamados ativos
            </span>
            <span className="text-slate-500">({totalCalls})</span>
          </label>
          <span className="ml-auto text-slate-500">
            Total no sistema: {totalActive} prestadores geolocalizados · {(services || []).length} serviços.
          </span>
        </div>
      </div>

      <div
        ref={mapRef}
        className="h-[min(75vh,620px)] w-full min-h-[360px] bg-slate-900 rounded-xl border border-slate-800 overflow-hidden"
      />

      <p className="text-[11px] text-slate-500">
        Ordem dos pontos: latitude (Sul) primeiro, longitude (Oeste) depois. Se algo parecer fora do Brasil, o sistema tenta corrigir (lng,lat) invertidos automaticamente.
      </p>
    </div>
  );
}

function TrackingTab() {
  const [list, setList] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [flags, setFlags] = useState(null);
  const [previewLat, setPreviewLat] = useState("-23.5505");
  const [previewLng, setPreviewLng] = useState("-46.6333");
  const [previewService, setPreviewService] = useState("reboque");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState(null);

  useEffect(() => {
    fetch(`${API}/attendance`)
      .then((r) => r.json())
      .then(setList)
      .catch(() => {});
    fetch(`${API}/system/test-flags`)
      .then((r) => r.json())
      .then(setFlags)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setData(null);
      return;
    }
    setLoading(true);
    fetch(`${API}/attendance/${encodeURIComponent(selectedId)}/tracking`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .finally(() => setLoading(false));
  }, [selectedId]);

  async function runPreview() {
    setPreviewLoading(true);
    setPreviewResult(null);
    try {
      const r = await fetch(`${API}/debug/google-nearby-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: parseFloat(String(previewLat).replace(",", ".")),
          lng: parseFloat(String(previewLng).replace(",", ".")),
          serviceType: previewService,
          radiusMeters: 20000,
        }),
      });
      setPreviewResult(await r.json());
    } catch (e) {
      setPreviewResult({ error: String(e?.message || e) });
    } finally {
      setPreviewLoading(false);
    }
  }

  const att = data?.attendance;

  return (
    <div className="space-y-6 max-w-6xl mx-auto w-full min-w-0">
      <div>
        <h2 className="text-2xl font-bold">Acompanhamento de atendimentos</h2>
        <p className="text-sm text-gray-500 mt-1">
          Dados persistidos no banco e metadados das chamadas ao Google (geocoding, distância, Places Nearby Search).
        </p>
      </div>

      {flags && (
        <div className="rounded-xl border border-gray-700 bg-gray-800/50 p-4 text-sm space-y-2">
          <p className="font-semibold text-gray-200">Estado do servidor (testes)</p>
          <ul className="text-xs text-gray-400 space-y-1 font-mono">
            <li>
              WHATSAPP_INBOUND_DISABLED:{" "}
              <span className={flags.WHATSAPP_INBOUND_DISABLED ? "text-amber-400" : "text-green-400"}>
                {String(flags.WHATSAPP_INBOUND_DISABLED)}
              </span>{" "}
              — se true, mensagens recebidas são só registradas; o bot não responde.
            </li>
            <li>
              TEST_MODE:{" "}
              <span className={flags.TEST_MODE ? "text-amber-400" : "text-green-400"}>{String(flags.TEST_MODE)}</span>{" "}
              — restrito à allowlist na aba Conversas.
            </li>
            <li>
              GOOGLE_MAPS_API_KEY:{" "}
              <span className={flags.GOOGLE_MAPS_API_KEY ? "text-green-400" : "text-red-400"}>
                {flags.GOOGLE_MAPS_API_KEY ? "configurada" : "ausente"}
              </span>
            </li>
          </ul>
        </div>
      )}

      <section className="bg-gray-800 rounded-xl border border-gray-700 p-5">
        <h3 className="text-lg font-semibold mb-2">Pré-visualizar busca Google (Places) sem WhatsApp</h3>
        <p className="text-xs text-gray-500 mb-4">
          Usa o mesmo endpoint que o atendimento (keyword conforme tipo de serviço). Não grava atendimento.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
          <label className="text-xs text-gray-400">
            Lat
            <input
              value={previewLat}
              onChange={(e) => setPreviewLat(e.target.value)}
              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 font-mono text-sm"
            />
          </label>
          <label className="text-xs text-gray-400">
            Lng
            <input
              value={previewLng}
              onChange={(e) => setPreviewLng(e.target.value)}
              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 font-mono text-sm"
            />
          </label>
          <label className="text-xs text-gray-400 md:col-span-2">
            Tipo de serviço (keyword mapeada)
            <input
              value={previewService}
              onChange={(e) => setPreviewService(e.target.value)}
              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm"
              placeholder="reboque, chaveiro, ..."
            />
          </label>
        </div>
        <button
          type="button"
          onClick={runPreview}
          disabled={previewLoading}
          className="px-4 py-2 btn-primary disabled:opacity-50 text-sm"
        >
          {previewLoading ? "Consultando..." : "Executar prévia Places"}
        </button>
        {previewResult && (
          <pre className="mt-4 p-4 rounded-lg bg-gray-900 border border-gray-700 text-xs overflow-auto max-h-80 text-gray-300">
            {JSON.stringify(previewResult, null, 2)}
          </pre>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,280px)_1fr] gap-4 min-w-0">
        <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden max-h-[70vh] flex flex-col min-w-0">
          <div className="p-3 border-b border-gray-700 text-sm font-semibold">Atendimentos recentes</div>
          <div className="overflow-y-auto flex-1">
            {list.map((a) => (
              <button
                type="button"
                key={a.id}
                onClick={() => setSelectedId(a.id)}
                className={`w-full text-left px-3 py-2 border-b border-gray-700/60 text-sm hover:bg-gray-700/40 ${
                  selectedId === a.id ? "bg-gray-700/70" : ""
                }`}
              >
                <div className="font-mono text-xs text-indigo-300 truncate">
                  {a.protocol || String(a.id).slice(0, 8).toUpperCase()}
                </div>
                <div className="text-xs text-gray-400 truncate">
                  {a.customer_name || "—"} · {a.service_type || "—"}
                </div>
                <div className="flex items-center justify-between gap-2 mt-1">
                  <span className="text-[10px] text-gray-500">{formatDate(a.created_at)}</span>
                  <span className="text-[10px] font-mono flex items-center gap-1">
                    <Timer className="w-3 h-3 text-gray-500" />
                    <ElapsedBadge att={a} />
                  </span>
                </div>
              </button>
            ))}
            {list.length === 0 && <div className="p-4 text-xs text-gray-500">Nenhum atendimento.</div>}
          </div>
        </div>

        <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 min-h-[400px] min-w-0 overflow-x-hidden">
          {!selectedId && <p className="text-gray-500 text-sm">Selecione um atendimento à esquerda.</p>}
          {selectedId && loading && <p className="text-gray-500 text-sm">Carregando...</p>}
          {selectedId && !loading && data && (
            <div className="space-y-4 min-w-0">
              <div className="min-w-0">
                <h3 className="font-semibold text-lg flex items-center gap-2">
                  Registro do atendimento
                  <span className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-mono text-xs">
                    {att?.protocol || String(att?.id || "").slice(0, 8).toUpperCase()}
                  </span>
                </h3>
                <p className="text-[10px] text-gray-500 font-mono">ID interno: {att?.id}</p>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <div className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900/50 px-3 py-2">
                    <Timer className="w-4 h-4 text-gray-400" />
                    <ElapsedBadge att={att || {}} />
                  </div>
                  <StatusBadge status={att?.status} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm mt-2">
                  <Info label="Telefone" value={att?.caller_id || "—"} mono />
                  <Info label="Tipo" value={att?.service_type || "—"} capitalize />
                  <Info label="Placa" value={att?.vehicle_plate || "—"} mono />
                  <Info label="Origem" value={att?.location_address || att?.location || "—"} colSpan />
                  <Info label="Destino" value={att?.destination_address || "—"} colSpan />
                  <Info label="Distância (km)" value={att?.distance_km != null ? String(Number(att.distance_km).toFixed(2)) : "—"} />
                  <Info label="Plano / excedente" value={`${att?.plan_used || "—"} · ${att?.excess_km != null ? Number(att.excess_km).toFixed(1) + " km" : "—"}`} />
                </div>
              </div>

              {data.services?.length > 0 && (
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-gray-300 mb-2">Serviço vinculado</h4>
                  <ServiceLinkedCard svc={data.services[0]} />
                </div>
              )}

              {data.negotiations?.length > 0 && (
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-gray-300 mb-2">
                    Negociações ({data.negotiations.length})
                  </h4>
                  <NegotiationsTable negotiations={data.negotiations} />
                </div>
              )}

              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-amber-200 mb-1">Google — buscas e metadados (persistidos)</h4>
                <p className="text-[11px] text-gray-500 mb-2">
                  Com API: geocoding, Distance Matrix e Places Nearby. Se aparecer REQUEST_DENIED, configure a chave no Google Cloud ou use os atalhos abaixo (abrem o Maps no navegador, sem API).
                </p>
                {data.google_debug?.google_api_hint && (
                  <p className="text-xs text-amber-300/90 mb-3 border border-amber-800/50 rounded-lg p-2 bg-amber-950/30">
                    {data.google_debug.google_api_hint}
                  </p>
                )}
                <GoogleDebugTables debug={data.google_debug || {}} />
              </div>

              {data.logs?.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-gray-300 mb-1">Logs do fluxo</h4>
                  <pre className="p-3 rounded-lg bg-gray-900 border border-gray-700 text-xs overflow-auto max-h-40">
                    {JSON.stringify(data.logs, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationsTab({ liveMessages }) {
  const [testMode, setTestMode] = useState({ enabled: false, allowlist: [], sourceEnv: "db" });
  const [conversations, setConversations] = useState([]);
  const [selectedPhone, setSelectedPhone] = useState(null);
  const [detail, setDetail] = useState({ messages: [], session: null });
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [forceSend, setForceSend] = useState(false);
  const [allowlistInput, setAllowlistInput] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const scrollRef = useRef(null);

  const loadTestMode = useCallback(async () => {
    try {
      const r = await fetch(`${API}/test-mode`);
      if (r.ok) setTestMode(await r.json());
    } catch {}
  }, []);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const r = await fetch(`${API}/conversations`);
      if (r.ok) setConversations(await r.json());
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadDetail = useCallback(async (phone) => {
    if (!phone) return;
    setLoadingDetail(true);
    try {
      const r = await fetch(`${API}/conversations/${encodeURIComponent(phone)}`);
      if (r.ok) setDetail(await r.json());
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    loadTestMode();
    loadList();
  }, [loadTestMode, loadList]);

  useEffect(() => {
    if (selectedPhone) loadDetail(selectedPhone);
  }, [selectedPhone, loadDetail]);

  useEffect(() => {
    if (!liveMessages || liveMessages.length === 0) return;
    const latest = liveMessages[0];
    const latestPhone = (latest.phone || "").replace(/\D/g, "");
    if (!latestPhone) return;
    loadList();
    const sel = (selectedPhone || "").replace(/\D/g, "");
    if (
      sel &&
      (latestPhone === sel || brPhoneCanonical(latestPhone) === brPhoneCanonical(sel))
    ) {
      loadDetail(selectedPhone);
    }
  }, [liveMessages, selectedPhone, loadList, loadDetail]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [detail.messages?.length, selectedPhone]);

  async function toggleTestMode(next) {
    const updated = { ...testMode, enabled: next };
    setTestMode(updated);
    await fetch(`${API}/test-mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    loadTestMode();
  }

  async function addAllowlist() {
    const digits = allowlistInput.replace(/\D/g, "");
    if (!digits) return;
    const next = Array.from(new Set([...(testMode.allowlist || []), digits]));
    setAllowlistInput("");
    await fetch(`${API}/test-mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowlist: next }),
    });
    loadTestMode();
  }

  async function removeAllowlist(phone) {
    const next = (testMode.allowlist || []).filter((p) => p !== phone);
    await fetch(`${API}/test-mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowlist: next }),
    });
    loadTestMode();
  }

  async function sendManual() {
    const text = draft.trim();
    if (!text || !selectedPhone) return;
    setSending(true);
    try {
      const r = await fetch(`${API}/conversations/${encodeURIComponent(selectedPhone)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, force: forceSend }),
      });
      const data = await r.json().catch(() => ({}));
      if (data?.blocked) {
        alert("Mensagem bloqueada pelo test mode (número fora da allowlist). Marque 'Forçar envio' para bypassar.");
      } else if (!r.ok) {
        alert(data?.error || `Erro ${r.status} ao enviar. Confira EVOLUTION_API_URL (use http://localhost:8080 se o Node roda fora do Docker), WHATSAPP_INSTANCE e o número com DDD.`);
      } else {
        setDraft("");
      }
      loadDetail(selectedPhone);
      loadList();
    } finally {
      setSending(false);
    }
  }

  async function resetSession() {
    if (!selectedPhone) return;
    if (!confirm("Resetar a sessão de conversa deste número? As mensagens não serão apagadas, apenas o estado da conversa.")) return;
    await fetch(`${API}/conversations/${encodeURIComponent(selectedPhone)}/reset`, { method: "POST" });
    loadDetail(selectedPhone);
  }

  async function deleteConversation() {
    if (!selectedPhone) return;
    if (!confirm("Apagar TODAS as mensagens deste número? Esta ação não pode ser desfeita.")) return;
    await fetch(`${API}/conversations/${encodeURIComponent(selectedPhone)}`, { method: "DELETE" });
    setSelectedPhone(null);
    setDetail({ messages: [], session: null });
    loadList();
  }

  function addManualConversation() {
    const digits = manualPhone.replace(/\D/g, "");
    if (!digits) return;
    setSelectedPhone(digits);
    setManualPhone("");
  }

  const filteredConversations = conversations;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold mb-1">Conversas</h2>
        <p className="text-sm text-gray-500">
          Monitore e controle as conversas em tempo real. Use o *Test Mode* para travar envios fora da sua lista de testes.
        </p>
      </div>

      <section
        className={`rounded-xl border p-4 ${
          testMode.enabled ? "border-amber-500/60 bg-amber-950/30" : "border-gray-700 bg-gray-800/40"
        }`}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            {testMode.enabled ? (
              <ZapOff className="w-6 h-6 text-amber-400" />
            ) : (
              <Zap className="w-6 h-6 text-green-400" />
            )}
            <div>
              <h3 className="font-semibold">
                {testMode.enabled ? "Test Mode ATIVO — envios/recebimentos restritos" : "Test Mode desligado — envios livres"}
              </h3>
              <p className="text-xs text-gray-400 mt-1">
                {testMode.enabled
                  ? "Somente números na allowlist podem receber mensagens e ter conversas processadas. Mensagens fora da lista são bloqueadas e registradas."
                  : "Qualquer mensagem recebida dispara o fluxo automático. Ative o Test Mode antes de conectar o WhatsApp para testes."}
                {testMode.sourceEnv === "env" && " (configurado via TEST_MODE no .env)"}
              </p>
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <span className="text-sm text-gray-300">Test Mode</span>
            <input
              type="checkbox"
              checked={!!testMode.enabled}
              onChange={(e) => toggleTestMode(e.target.checked)}
              className="h-5 w-5 accent-amber-500"
            />
          </label>
        </div>

        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase text-gray-400 mb-2">Allowlist de telefones</h4>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={allowlistInput}
              onChange={(e) => setAllowlistInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addAllowlist()}
              placeholder="Ex.: 5531993376525"
              className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={addAllowlist}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg text-sm flex items-center gap-1"
            >
              <Plus className="w-4 h-4" /> Adicionar
            </button>
          </div>
          {testMode.allowlist?.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {testMode.allowlist.map((p) => (
                <span key={p} className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gray-700 border border-gray-600 text-xs font-mono">
                  {p}
                  <button
                    type="button"
                    onClick={() => removeAllowlist(p)}
                    className="text-gray-400 hover:text-red-400"
                    aria-label="Remover"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-500">Nenhum número liberado. Com Test Mode ATIVO, TODAS as mensagens são bloqueadas.</p>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        <section className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden flex flex-col max-h-[75vh]">
          <div className="p-3 border-b border-gray-700 flex gap-2">
            <input
              type="text"
              value={manualPhone}
              onChange={(e) => setManualPhone(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addManualConversation()}
              placeholder="Abrir conversa por número..."
              className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-xs"
            />
            <button
              type="button"
              onClick={addManualConversation}
              className="px-3 py-1.5 btn-primary text-xs"
            >
              Abrir
            </button>
          </div>
          <div className="overflow-y-auto flex-1">
            {loadingList && (
              <div className="p-4 text-center text-xs text-gray-500">Carregando...</div>
            )}
            {!loadingList && filteredConversations.length === 0 && (
              <div className="p-4 text-center text-xs text-gray-500">Nenhuma conversa ainda.</div>
            )}
            {filteredConversations.map((c) => (
              <button
                type="button"
                key={c.phone}
                onClick={() => setSelectedPhone(c.phone)}
                className={`w-full text-left p-3 border-b border-gray-700/60 hover:bg-gray-700/40 transition-colors ${
                  selectedPhone === c.phone ? "bg-gray-700/70" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm truncate">{c.phone}</span>
                  <span className="text-[10px] text-gray-500 shrink-0">{formatDate(c.last_at)}</span>
                </div>
                {c.customer_name && (
                  <div className="text-xs text-gray-300 truncate">{c.customer_name}</div>
                )}
                <div className="text-xs text-gray-500 truncate mt-0.5">
                  {c.last_direction === "outbound" && <span className="text-indigo-400">→ </span>}
                  {c.last_direction === "blocked" && <span className="text-amber-400">⚠ </span>}
                  {c.last_direction === "inbound" && <span className="text-green-400">← </span>}
                  {c.last_message || "—"}
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-[10px] text-gray-500">
                  {c.session_state && (
                    <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">{c.session_state}</span>
                  )}
                  {c.pending_confirmation && (
                    <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">aguarda sim</span>
                  )}
                  {Number(c.blocked_count || 0) > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">
                      {c.blocked_count} bloq.
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="bg-gray-800 rounded-xl border border-gray-700 flex flex-col max-h-[75vh]">
          {!selectedPhone ? (
            <div className="flex-1 flex items-center justify-center text-gray-500 text-sm p-6 text-center">
              Selecione uma conversa à esquerda ou digite um número no campo acima para começar.
            </div>
          ) : (
            <>
              <div className="p-3 border-b border-gray-700 flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="font-mono text-sm">{selectedPhone}</div>
                  {detail.session && (
                    <div className="text-[11px] text-gray-400 mt-0.5">
                      estado: <span className="text-indigo-300">{detail.session.state}</span>
                      {detail.session.pendingConfirmation && <span className="ml-2 text-amber-300">aguardando confirmação</span>}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={resetSession}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-xs"
                    title="Limpar o estado da sessão (para reiniciar o fluxo)"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Resetar sessão
                  </button>
                  <button
                    type="button"
                    onClick={deleteConversation}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-700/80 hover:bg-red-600 text-xs"
                    title="Apagar todas as mensagens deste número"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Apagar conversa
                  </button>
                </div>
              </div>

              <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto p-4 space-y-2 bg-gray-900/40"
              >
                {loadingDetail && (
                  <div className="text-center text-xs text-gray-500">Carregando mensagens...</div>
                )}
                {!loadingDetail && detail.messages?.length === 0 && (
                  <div className="text-center text-xs text-gray-500">Nenhuma mensagem.</div>
                )}
                {detail.messages?.map((m) => {
                  const dir = m.direction;
                  const base = "max-w-[80%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words shadow";
                  const styleMap = {
                    inbound: "bg-gray-700 text-gray-100 self-start rounded-bl-none",
                    outbound: "text-white self-end rounded-br-none",
                    blocked: "bg-amber-700/40 border border-amber-500/60 text-amber-100 self-end rounded-br-none",
                    ignored: "bg-red-900/40 border border-red-500/60 text-red-100 self-start rounded-bl-none",
                  };
                  return (
                    <div key={m.id} className={`flex flex-col ${dir === "inbound" || dir === "ignored" ? "items-start" : "items-end"}`}>
                      <div
                        className={`${base} ${styleMap[dir] || "bg-gray-700 text-gray-100"}`}
                        style={dir === "outbound" ? { background: "var(--color-primary)" } : undefined}
                      >
                        {dir === "blocked" && (
                          <div className="text-[10px] uppercase tracking-wide text-amber-300 mb-1">
                            Bloqueado pelo test mode
                          </div>
                        )}
                        {dir === "ignored" && (
                          <div className="text-[10px] uppercase tracking-wide text-red-300 mb-1">
                            Recebido e ignorado (fora da allowlist)
                          </div>
                        )}
                        {m.content}
                      </div>
                      <div className="text-[10px] text-gray-500 mt-0.5 px-1">{formatDate(m.created_at)}</div>
                    </div>
                  );
                })}
              </div>

              <div className="p-3 border-t border-gray-700 space-y-2">
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendManual();
                      }
                    }}
                    rows={2}
                    placeholder="Enviar mensagem manual (útil pra simular atendente)..."
                    className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={sendManual}
                    disabled={sending || !draft.trim()}
                    className="px-4 py-2 btn-primary disabled:opacity-50 text-sm flex items-center gap-1 shrink-0"
                  >
                    <Send className="w-4 h-4" /> Enviar
                  </button>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={forceSend}
                      onChange={(e) => setForceSend(e.target.checked)}
                      className="h-3.5 w-3.5 accent-amber-500"
                    />
                    <span className="text-gray-400">Forçar envio (ignorar test mode)</span>
                  </label>
                  <span className="text-gray-600">Enter envia · Shift+Enter quebra linha</span>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function MessagesTab({ messages }) {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Mensagens em Tempo Real</h2>
      <div className="bg-gray-800 rounded-xl overflow-hidden max-h-[600px] overflow-y-auto">
        {messages.length === 0 && <div className="p-8 text-center text-gray-500">Aguardando mensagens...</div>}
        {messages.map((msg, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3 border-b border-gray-700 hover:bg-gray-700/30">
            <div className={`w-2 h-2 mt-2 rounded-full flex-shrink-0 ${msg.direction === "inbound" ? "bg-green-500" : "bg-blue-500"}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-sm text-gray-300">{msg.phone}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${msg.direction === "inbound" ? "bg-green-900/30 text-green-400" : "bg-blue-900/30 text-blue-400"}`}>
                  {msg.direction === "inbound" ? "Recebida" : "Enviada"}
                </span>
              </div>
              <p className="text-sm text-gray-200 truncate">{msg.content}</p>
              <p className="text-xs text-gray-500 mt-1">{msg.timestamp}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function providerServiceIdsFromRow(provider) {
  const csv = String(provider.services || "").toLowerCase();
  const byId = SERVICE_TYPES.filter((st) => csv.includes(st.id)).map((s) => s.id);
  if (byId.length) return byId;
  const parts = String(provider.services || "")
    .split(/[,;]/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return SERVICE_TYPES.filter((st) => parts.some((p) => p === st.id)).map((s) => s.id);
}

function ProviderCard({ provider, onRefresh, onDelete }) {
  const [issuesInvoice, setIssuesInvoice] = useState(Number(provider.issues_invoice ?? 1) !== 0);
  const [saving, setSaving] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    phone: "",
    whatsapp: "",
    address_text: "",
    latitude: "",
    longitude: "",
    serviceIds: [],
  });
  const [editSaving, setEditSaving] = useState(false);

  function openEdit() {
    setEditForm({
      name: provider.name || "",
      phone: provider.phone || "",
      whatsapp: provider.whatsapp || "",
      address_text: provider.address_text || "",
      latitude: provider.latitude != null ? String(provider.latitude) : "",
      longitude: provider.longitude != null ? String(provider.longitude) : "",
      serviceIds: providerServiceIdsFromRow(provider),
    });
    setShowEdit(true);
  }

  function toggleEditService(id) {
    setEditForm((f) => ({
      ...f,
      serviceIds: f.serviceIds.includes(id) ? f.serviceIds.filter((x) => x !== id) : [...f.serviceIds, id],
    }));
  }

  async function saveEdit() {
    if (!editForm.name.trim()) {
      alert("Informe o nome do prestador.");
      return;
    }
    if (!editForm.serviceIds.length) {
      alert("Marque ao menos um tipo de serviço.");
      return;
    }
    setEditSaving(true);
    try {
      const res = await fetch(`${API}/providers/${encodeURIComponent(provider.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name.trim(),
          phone: editForm.phone || null,
          whatsapp: editForm.whatsapp || null,
          address_text: editForm.address_text || null,
          latitude: editForm.latitude || null,
          longitude: editForm.longitude || null,
          services: editForm.serviceIds.join(","),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao salvar.");
        return;
      }
      setShowEdit(false);
      onRefresh?.();
    } catch (e) {
      alert("Erro: " + e.message);
    } finally {
      setEditSaving(false);
    }
  }

  async function toggleInvoice() {
    const next = !issuesInvoice;
    setIssuesInvoice(next);
    setSaving(true);
    try {
      await fetch(`${API}/providers/${encodeURIComponent(provider.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issues_invoice: next ? 1 : 0 }),
      });
    } finally {
      setSaving(false);
      onRefresh?.();
    }
  }

  const photo = provider.photo_path;
  const initials = provider.name?.charAt(0) || "?";
  return (
    <div className="panel p-5 flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          {photo ? (
            <img
              src={photo}
              alt={provider.name || "Prestador"}
              className="w-12 h-12 rounded-full object-cover shrink-0 border border-slate-700"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
          ) : (
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center font-bold shrink-0 text-white"
              style={{ background: "var(--color-primary)" }}
            >
              {initials}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-slate-100">{provider.name}</h3>
              {Number(provider.is_test) === 1 && (
                <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  Teste (cotação)
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">{provider.phone || provider.whatsapp || "—"}</p>
            {provider.external_source && (
              <p className="text-[10px] text-slate-400 mt-0.5">via {provider.external_source}</p>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <button
            type="button"
            onClick={openEdit}
            className="px-3 py-1.5 text-xs rounded-lg bg-slate-700 hover:bg-slate-600 text-white flex items-center gap-1"
            title="Editar prestador"
          >
            <Pencil className="w-3.5 h-3.5" /> Editar
          </button>
          <button
            type="button"
            onClick={() => onDelete(provider.id)}
            className="px-3 py-1.5 text-xs rounded-lg bg-red-600/80 hover:bg-red-600 text-white"
            title="Remover prestador"
          >
            Excluir
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-400">
        Serviços: <span className="text-slate-200">{formatServiceList(provider.services)}</span>
      </p>
      {provider.address_text && (
        <p className="text-sm text-slate-300 mt-2">
          <MapPin className="inline w-3.5 h-3.5 -mt-0.5" /> {provider.address_text}
        </p>
      )}
      <div className="flex items-center justify-between mt-3 text-sm">
        <span className="text-amber-400/90">★ {provider.rating || 5.0}</span>
        {provider.latitude != null && provider.longitude != null && (
          <span className="text-xs text-slate-500 font-mono">
            {Number(provider.latitude).toFixed(4)}, {Number(provider.longitude).toFixed(4)}
          </span>
        )}
      </div>
      <label className="mt-3 flex items-center justify-between gap-2 text-xs bg-slate-900/50 border border-slate-700 rounded-lg px-3 py-2 cursor-pointer select-none">
        <span className="text-slate-300">Não emite nota fiscal</span>
        <input
          type="checkbox"
          checked={!issuesInvoice}
          onChange={toggleInvoice}
          disabled={saving}
          className="h-4 w-4"
          style={{ accentColor: "var(--color-primary)" }}
        />
      </label>

      {showEdit && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60" onClick={() => setShowEdit(false)}>
          <div className="bg-slate-900 rounded-xl p-6 w-full max-w-lg border border-slate-700 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-4">Editar prestador</h3>
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Nome"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 text-sm text-white"
              />
              <input
                type="text"
                placeholder="Telefone"
                value={editForm.phone}
                onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 text-sm text-white"
              />
              <input
                type="text"
                placeholder="WhatsApp"
                value={editForm.whatsapp}
                onChange={(e) => setEditForm({ ...editForm, whatsapp: e.target.value })}
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 text-sm text-white"
              />
              <input
                type="text"
                placeholder="Endereço base"
                value={editForm.address_text}
                onChange={(e) => setEditForm({ ...editForm, address_text: e.target.value })}
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 text-sm text-white"
              />
              <p className="text-xs text-slate-500">Serviços oferecidos</p>
              <div className="space-y-2 rounded-lg border border-slate-600 bg-slate-950/50 p-3 max-h-40 overflow-y-auto">
                {SERVICE_TYPES.map((st) => (
                  <label key={st.id} className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                    <input
                      type="checkbox"
                      className="rounded border-slate-600"
                      style={{ accentColor: "var(--color-primary)" }}
                      checked={editForm.serviceIds.includes(st.id)}
                      onChange={() => toggleEditService(st.id)}
                    />
                    {st.label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-slate-500">Latitude / longitude (base para despacho)</p>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Latitude"
                  value={editForm.latitude}
                  onChange={(e) => setEditForm({ ...editForm, latitude: e.target.value })}
                  className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
                />
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Longitude"
                  value={editForm.longitude}
                  onChange={(e) => setEditForm({ ...editForm, longitude: e.target.value })}
                  className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => setShowEdit(false)} className="flex-1 px-4 py-2 bg-slate-700 rounded-lg text-sm text-white">
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={editSaving}
                  className="flex-1 px-4 py-2 btn-primary text-sm disabled:opacity-50"
                >
                  {editSaving ? "Salvando..." : "Salvar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const SERVICE_TYPE_LIMIT_KEYS = [
  { key: "reboque", label: "Reboque" },
  { key: "carga_bateria", label: "Carga de bateria" },
  { key: "troca_pneu", label: "Troca de pneu" },
  { key: "combustivel", label: "Combustível" },
  { key: "chaveiro", label: "Chaveiro" },
];

function RulesTab() {
  const [rules, setRules] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API}/business-rules`)
      .then((r) => r.json())
      .then((data) => {
        const normalized = {
          limits: data?.limits || {},
          plans: {
            basic: { max_km: data?.plans?.basic?.max_km ?? 100 },
            plus: { max_km: data?.plans?.plus?.max_km ?? 300 },
            default_plan: data?.plans?.default_plan ?? "basic",
            price_per_km_excess: Number(data?.plans?.price_per_km_excess ?? 5),
          },
          alarm: { interval_minutes: data?.alarm?.interval_minutes ?? 10 },
          scoring: {
            price_weight: Number(data?.scoring?.price_weight ?? 0.6),
            time_weight: Number(data?.scoring?.time_weight ?? 0.4),
            wait_minutes: Number(data?.scoring?.wait_minutes ?? 10),
            max_providers: Math.min(5, Math.max(1, Number(data?.scoring?.max_providers ?? 5))),
          },
        };
        for (const { key } of SERVICE_TYPE_LIMIT_KEYS) {
          normalized.limits[key] = {
            per_month: normalized.limits?.[key]?.per_month ?? 0,
            per_year: normalized.limits?.[key]?.per_year ?? 0,
          };
        }
        setRules(normalized);
      })
      .catch(() => setError("Não foi possível carregar as regras."))
      .finally(() => setLoading(false));
  }, []);

  function setLimit(key, field, value) {
    const n = parseInt(value, 10);
    setRules((prev) => ({
      ...prev,
      limits: {
        ...prev.limits,
        [key]: {
          ...(prev.limits?.[key] || {}),
          [field]: Number.isFinite(n) && n > 0 ? n : 0,
        },
      },
    }));
  }

  function setPlanKm(plan, value) {
    const n = parseInt(value, 10);
    setRules((prev) => ({
      ...prev,
      plans: {
        ...prev.plans,
        [plan]: { max_km: Number.isFinite(n) && n > 0 ? n : 0 },
      },
    }));
  }

  function setPlans(patch) {
    setRules((prev) => ({ ...prev, plans: { ...prev.plans, ...patch } }));
  }

  function setScoring(patch) {
    setRules((prev) => ({ ...prev, scoring: { ...prev.scoring, ...patch } }));
  }

  async function save() {
    setSaved(false);
    setError("");
    try {
      const r = await fetch(`${API}/business-rules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rules),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(String(err?.message || "Falha ao salvar"));
    }
  }

  if (loading || !rules) {
    return <div className="text-gray-400">Carregando regras...</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold">Regras de Negócio</h2>
        <p className="text-sm text-gray-500 mt-1">
          Defina os limites de atendimento por cliente (telefone) e os limites de km dos planos.
        </p>
      </div>

      <section className="bg-gray-800 rounded-xl p-6 border border-gray-700">
        <h3 className="text-lg font-semibold mb-1">Limites por tipo de atendimento</h3>
        <p className="text-xs text-gray-500 mb-4">Use 0 para "sem limite".</p>
        <div className="overflow-hidden rounded-lg border border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-700/60">
              <tr className="text-left">
                <th className="px-4 py-2">Tipo</th>
                <th className="px-4 py-2 w-48">Máx por mês</th>
                <th className="px-4 py-2 w-48">Máx por ano</th>
              </tr>
            </thead>
            <tbody>
              {SERVICE_TYPE_LIMIT_KEYS.map(({ key, label }) => (
                <tr key={key} className="border-t border-gray-700">
                  <td className="px-4 py-2">{label}</td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      min={0}
                      value={rules.limits?.[key]?.per_month ?? 0}
                      onChange={(e) => setLimit(key, "per_month", e.target.value)}
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      min={0}
                      value={rules.limits?.[key]?.per_year ?? 0}
                      onChange={(e) => setLimit(key, "per_year", e.target.value)}
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-gray-800 rounded-xl p-6 border border-gray-700">
        <h3 className="text-lg font-semibold mb-1">Planos — km máximo de reboque</h3>
        <p className="text-xs text-gray-500 mb-4">
          Define até quantos km o reboque é coberto pelo plano. Acima disso, cobra-se excedente conforme prestador.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-gray-300">Plano Básico (km)</label>
            <input
              type="number"
              min={0}
              value={rules.plans?.basic?.max_km ?? 0}
              onChange={(e) => setPlanKm("basic", e.target.value)}
              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="text-sm text-gray-300">Plano Plus (km)</label>
            <input
              type="number"
              min={0}
              value={rules.plans?.plus?.max_km ?? 0}
              onChange={(e) => setPlanKm("plus", e.target.value)}
              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="text-sm text-gray-300">Plano padrão dos clientes</label>
            <select
              value={rules.plans?.default_plan ?? "basic"}
              onChange={(e) => setPlans({ default_plan: e.target.value })}
              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
            >
              <option value="basic">Básico</option>
              <option value="plus">Plus</option>
            </select>
          </div>
          <div>
            <label className="text-sm text-gray-300">Valor por km excedente (R$/km)</label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={rules.plans?.price_per_km_excess ?? 5}
              onChange={(e) => setPlans({ price_per_km_excess: Number(e.target.value) || 0 })}
              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
            />
          </div>
        </div>
      </section>

      <section className="bg-gray-800 rounded-xl p-6 border border-gray-700">
        <h3 className="text-lg font-semibold mb-1">Cotação com prestadores</h3>
        <p className="text-xs text-gray-500 mb-4">
          Quantos prestadores cotar por atendimento, tempo de espera e peso do preço vs. tempo na escolha do melhor.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-gray-300">Nº de prestadores por cotação</label>
            <input
              type="number"
              min={1}
              max={5}
              value={rules.scoring?.max_providers ?? 5}
              onChange={(e) =>
                setScoring({
                  max_providers: Math.min(5, Math.max(1, parseInt(e.target.value, 10) || 5)),
                })
              }
              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
            />
            <p className="text-[10px] text-gray-500 mt-1">Máximo 5 prestadores por cotação.</p>
          </div>
          <div>
            <label className="text-sm text-gray-300">Tempo de espera por respostas (min)</label>
            <input
              type="number"
              min={1}
              value={rules.scoring?.wait_minutes ?? 10}
              onChange={(e) => setScoring({ wait_minutes: Math.max(1, parseInt(e.target.value, 10) || 10) })}
              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="text-sm text-gray-300">
              Peso no preço: {(Number(rules.scoring?.price_weight ?? 0.6) * 100).toFixed(0)}%
            </label>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(Number(rules.scoring?.price_weight ?? 0.6) * 100)}
              onChange={(e) => {
                const p = Number(e.target.value) / 100;
                setScoring({ price_weight: p, time_weight: 1 - p });
              }}
              className="mt-1 w-full"
            />
          </div>
          <div>
            <label className="text-sm text-gray-300">
              Peso no tempo: {(Number(rules.scoring?.time_weight ?? 0.4) * 100).toFixed(0)}%
            </label>
            <div className="text-xs text-gray-500 mt-2">Ajustado automaticamente para somar 100%.</div>
          </div>
        </div>
      </section>

      <section className="bg-gray-800 rounded-xl p-6 border border-gray-700">
        <h3 className="text-lg font-semibold mb-1">Alarme de atraso</h3>
        <p className="text-xs text-gray-500 mb-4">
          Intervalo (em minutos) entre os alarmes quando o atendimento passa da previsão.
        </p>
        <input
          type="number"
          min={1}
          value={rules.alarm?.interval_minutes ?? 10}
          onChange={(e) =>
            setRules((prev) => ({
              ...prev,
              alarm: { interval_minutes: Math.max(1, parseInt(e.target.value, 10) || 10) },
            }))
          }
          className="w-full md:w-40 bg-gray-700 border border-gray-600 rounded px-3 py-2"
        />
      </section>

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} className="px-6 py-2 btn-primary text-sm">
          Salvar regras
        </button>
        {saved && <span className="text-sm text-green-400">✓ Salvo!</span>}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </div>
  );
}

function SettingsTab() {
  const [section, setSection] = useState("general");

  const sections = [
    { id: "general", label: "Geral", icon: Settings },
    { id: "appearance", label: "Aparência", icon: Palette },
    { id: "rules", label: "Regras de negócio", icon: Shield },
    { id: "danger", label: "Zona de perigo", icon: AlertTriangle },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-800">
        {sections.map((s) => {
          const active = section === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 -mb-px transition-colors ${
                active
                  ? "border-[color:var(--color-primary)] text-white"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              <s.icon className="w-4 h-4" />
              {s.label}
            </button>
          );
        })}
      </div>

      {section === "general" && <SettingsGeneralSection />}
      {section === "appearance" && <SettingsAppearanceSection />}
      {section === "rules" && <RulesTab />}
      {section === "danger" && <SettingsDangerSection />}
    </div>
  );
}

function SettingsGeneralSection() {
  const [settings, setSettings] = useState({});
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/settings`)
      .then((r) => r.json())
      .then((d) => setSettings(d || {}))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    await fetch(`${API}/settings/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (loading) return <div className="text-slate-400">Carregando...</div>;

  return (
    <div className="panel p-6 space-y-5 max-w-3xl">
      <div>
        <h3 className="text-lg font-semibold text-slate-100">Atendimento</h3>
        <p className="text-xs text-slate-400 mt-1">
          Mensagens e políticas de validação aplicadas a novos atendimentos.
        </p>
      </div>

      <div>
        <label className="block text-sm text-slate-300 mb-1">Mensagem de boas-vindas</label>
        <p className="text-xs text-slate-500 mb-2">
          Enviada na primeira mensagem do cliente (WhatsApp ou chat web). Depois disso, o assistente pede nome, local, veículo e demais dados como em um atendimento real.
        </p>
        <textarea
          value={settings.welcome_message || ""}
          onChange={(e) => setSettings({ ...settings, welcome_message: e.target.value })}
          rows={3}
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
        />
      </div>

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          id="sga_validate"
          checked={settings.sga_validate_associates === "true"}
          onChange={(e) =>
            setSettings({ ...settings, sga_validate_associates: e.target.checked ? "true" : "false" })
          }
          className="mt-1"
          style={{ accentColor: "var(--color-primary)" }}
        />
        <span className="text-sm text-slate-200">
          Exigir associado ativo no SGA antes de registrar o chamado
          <span className="block text-xs text-slate-500 mt-1">
            Com isso ligado, cadastre o telefone (somente dígitos) na tabela <code className="text-slate-400">sga_associates</code> no banco ou desligue para desenvolvimento.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          id="allow_non_associate"
          checked={settings.allow_non_associate_service !== "false"}
          onChange={(e) =>
            setSettings({ ...settings, allow_non_associate_service: e.target.checked ? "true" : "false" })
          }
          className="mt-1"
          style={{ accentColor: "var(--color-primary)" }}
        />
        <span className="text-sm text-slate-200">
          Extras de política para não associado (opcional)
          <span className="block text-xs text-slate-500 mt-1">
            Se o veículo não for encontrado na base da associação, o sistema <strong className="text-slate-400">sempre</strong> oferece o atendimento com pagamento antecipado. Esta opção fica reservada para extensões futuras da regra.
          </span>
        </span>
      </label>

      <div>
        <label className="block text-sm text-slate-300 mb-1">Chave PIX da associação</label>
        <p className="text-xs text-slate-500 mb-2">
          Exibida ao cliente no fluxo de não associado e nas notificações ao gestor.
        </p>
        <input
          type="text"
          value={settings.association_pix_key || ""}
          onChange={(e) => setSettings({ ...settings, association_pix_key: e.target.value })}
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm font-mono focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
          placeholder="CPF, e-mail, telefone ou chave aleatória"
        />
      </div>

      <div>
        <label className="block text-sm text-slate-300 mb-1">WhatsApp do gestor da associação</label>
        <p className="text-xs text-slate-500 mb-2">
          Somente dígitos (DDD + número). Recebe abertura de atendimento, resultado da cotação, fotos no reboque e chave PIX do prestador.
        </p>
        <input
          type="text"
          inputMode="numeric"
          value={settings.gestor_whatsapp || ""}
          onChange={(e) => setSettings({ ...settings, gestor_whatsapp: e.target.value })}
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm font-mono focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
          placeholder="5511999999999"
        />
      </div>

      <div>
        <label className="block text-sm text-slate-300 mb-1">Taxa sobre não associado (%)</label>
        <p className="text-xs text-slate-500 mb-2">
          Aplicada sobre o valor do reboque oferecido pelo prestador (ex.: 10 = cliente paga prestador + 10%).
        </p>
        <input
          type="text"
          inputMode="decimal"
          value={settings.non_associate_markup_percent || "10"}
          onChange={(e) => setSettings({ ...settings, non_associate_markup_percent: e.target.value })}
          className="w-full max-w-xs bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
          placeholder="10"
        />
      </div>

      <div className="border-t border-slate-700 my-4"></div>

      <div>
        <label className="block text-sm text-slate-300 mb-1">Mercado Pago (Access Token)</label>
        <p className="text-xs text-slate-500 mb-2">
          Token da API do Mercado Pago para gerar links de pagamento. Gere em: Configurações → Lojas e caixas → Criar loja → Access Token.
        </p>
        <input
          type="password"
          value={settings.mercadopago_access_token || ""}
          onChange={(e) => setSettings({ ...settings, mercadopago_access_token: e.target.value })}
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm font-mono focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
          placeholder="APP_USR-xxxxxxxxxxxx-xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxx"
        />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button type="button" onClick={save} className="px-6 py-2 btn-primary text-sm">
          Salvar alterações
        </button>
        {saved && <span className="text-sm text-emerald-400">✓ Salvo</span>}
      </div>
    </div>
  );
}

function SettingsAppearanceSection() {
  const { theme, setTheme, resetTheme } = useTheme();
  const [logoUrlDraft, setLogoUrlDraft] = useState(theme.logoUrl || "");

  useEffect(() => {
    setLogoUrlDraft(theme.logoUrl || "");
  }, [theme.logoUrl]);

  function handleLogoFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      setTheme({ logoUrl: dataUrl });
      setLogoUrlDraft(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  const presetColors = [
    "#6366f1", "#0ea5e9", "#10b981", "#f59e0b",
    "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6",
  ];

  const fontOptions = [
    { id: "sm", label: "Compacto" },
    { id: "md", label: "Padrão" },
    { id: "lg", label: "Confortável" },
    { id: "xl", label: "Acessível" },
  ];

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="panel p-6 space-y-5">
        <div className="flex items-start gap-4">
          <div className="p-2 rounded-lg bg-primary-soft">
            <Palette className="w-5 h-5" style={{ color: "var(--color-primary)" }} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-100">Aparência</h3>
            <p className="text-xs text-slate-400 mt-1">
              Personalize a identidade visual do painel e do chat do cliente. Todas as preferências ficam salvas neste navegador.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="panel-soft p-4 space-y-3">
            <label className="block text-sm font-medium text-slate-200">Nome da marca</label>
            <input
              type="text"
              value={theme.brandName || ""}
              onChange={(e) => setTheme({ brandName: e.target.value })}
              placeholder="Ex.: Novamart Assist"
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
            />
            <label className="block text-sm font-medium text-slate-200 mt-3">
              Subtítulo (chat do cliente)
            </label>
            <input
              type="text"
              value={theme.clientTagline || ""}
              onChange={(e) => setTheme({ clientTagline: e.target.value })}
              placeholder="Ex.: Assistência 24h"
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
            />
          </div>

          <div className="panel-soft p-4 space-y-3">
            <label className="block text-sm font-medium text-slate-200">Logo</label>
            <div className="flex items-center gap-3">
              <BrandLogo size="lg" />
              <div className="flex-1 space-y-2">
                <label className="inline-flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs cursor-pointer text-slate-200">
                  <ImageIcon className="w-3.5 h-3.5" />
                  Enviar imagem
                  <input type="file" accept="image/*" onChange={handleLogoFile} className="hidden" />
                </label>
                {theme.logoUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      setTheme({ logoUrl: "" });
                      setLogoUrlDraft("");
                    }}
                    className="text-xs text-slate-400 hover:text-red-300 ml-2"
                  >
                    Remover logo
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="url"
                value={logoUrlDraft}
                onChange={(e) => setLogoUrlDraft(e.target.value)}
                placeholder="Ou cole uma URL de imagem (https://...)"
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-[color:var(--color-primary)] ring-primary"
              />
              <button
                type="button"
                onClick={() => setTheme({ logoUrl: logoUrlDraft })}
                className="px-3 py-2 text-xs bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200"
              >
                Aplicar
              </button>
            </div>
            <p className="text-[11px] text-slate-500">
              PNG transparente funciona melhor. Formatos recomendados: quadrado 512×512.
            </p>
          </div>
        </div>

        <div className="panel-soft p-4 space-y-3">
          <label className="block text-sm font-medium text-slate-200 flex items-center gap-2">
            <span
              className="inline-block w-4 h-4 rounded-full border border-white/40"
              style={{ background: theme.primaryColor }}
            />
            Cor primária
          </label>
          <div className="flex items-center gap-3 flex-wrap">
            {presetColors.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setTheme({ primaryColor: c })}
                title={c}
                className={`w-8 h-8 rounded-full border-2 ${
                  theme.primaryColor?.toLowerCase() === c.toLowerCase()
                    ? "border-white ring-2 ring-white/40"
                    : "border-slate-700 hover:border-slate-400"
                }`}
                style={{ background: c }}
              />
            ))}
            <div className="flex items-center gap-2 ml-auto">
              <input
                type="color"
                value={theme.primaryColor}
                onChange={(e) => setTheme({ primaryColor: e.target.value })}
                className="w-9 h-9 rounded border border-slate-700 bg-transparent cursor-pointer"
              />
              <input
                type="text"
                value={theme.primaryColor}
                onChange={(e) => setTheme({ primaryColor: e.target.value })}
                className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[color:var(--color-primary)]"
              />
            </div>
          </div>
        </div>

        <div className="panel-soft p-4 space-y-3">
          <label className="block text-sm font-medium text-slate-200">Cor de fundo (painel e chat)</label>
          <p className="text-[11px] text-slate-500">
            Define o fundo do painel administrativo e a base do degradê no chat do cliente.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            {["#0f172a", "#020617", "#1e1b4b", "#0c4a6e", "#14532d", "#1c1917"].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setTheme({ appBackground: c })}
                title={c}
                className={`w-8 h-8 rounded-full border-2 ${
                  (theme.appBackground || DEFAULT_THEME.appBackground).toLowerCase() === c.toLowerCase()
                    ? "border-white ring-2 ring-white/40"
                    : "border-slate-700 hover:border-slate-400"
                }`}
                style={{ background: c }}
              />
            ))}
            <div className="flex items-center gap-2 ml-auto">
              <input
                type="color"
                value={theme.appBackground || DEFAULT_THEME.appBackground}
                onChange={(e) => setTheme({ appBackground: e.target.value })}
                className="w-9 h-9 rounded border border-slate-700 bg-transparent cursor-pointer"
              />
              <input
                type="text"
                value={theme.appBackground || DEFAULT_THEME.appBackground}
                onChange={(e) => setTheme({ appBackground: e.target.value })}
                className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[color:var(--color-primary)]"
              />
            </div>
          </div>
        </div>

        <div className="panel-soft p-4 space-y-3">
          <label className="block text-sm font-medium text-slate-200 flex items-center gap-2">
            <Type className="w-4 h-4" /> Tamanho da fonte
          </label>
          <div className="grid grid-cols-4 gap-2">
            {fontOptions.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setTheme({ fontSize: f.id })}
                className={`px-3 py-2 rounded-lg text-sm border transition-colors ${
                  theme.fontSize === f.id
                    ? "border-[color:var(--color-primary)] bg-primary-soft text-white"
                    : "border-slate-700 text-slate-300 hover:bg-slate-800"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">
            O ajuste afeta todo o painel e o chat do cliente (zoom progressivo).
          </p>
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 pt-4">
          <button
            type="button"
            onClick={resetTheme}
            className="px-3 py-2 text-xs text-slate-400 hover:text-red-300 rounded-lg hover:bg-slate-800 flex items-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Restaurar padrão
          </button>
          <span className="text-xs text-emerald-400">
            ✓ Alterações aplicadas em tempo real
          </span>
        </div>
      </div>

      <div className="panel p-6">
        <h4 className="text-sm font-semibold text-slate-200 uppercase tracking-wider mb-3">Pré-visualização</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="panel-soft p-4 flex items-center gap-3">
            <BrandLogo size="md" />
            <div>
              <p className="font-semibold text-white">{theme.brandName}</p>
              <p className="text-xs text-slate-400">{theme.clientTagline}</p>
            </div>
          </div>
          <div className="panel-soft p-4 flex items-center gap-3">
            <button type="button" className="btn-primary px-4 py-2 text-sm">Ação primária</button>
            <span className="text-sm text-primary" style={{ color: "var(--color-primary)" }}>
              Destaque
            </span>
            <StatusBadge status="completed" />
          </div>
          <div
            className="md:col-span-2 rounded-xl border border-slate-600 p-4 min-h-[72px]"
            style={{ background: theme.appBackground || DEFAULT_THEME.appBackground }}
          >
            <p className="text-xs text-slate-400/90">Prévia da cor de fundo do site</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsDangerSection() {
  const [purging, setPurging] = useState(false);
  const [purgeResult, setPurgeResult] = useState(null);

  async function purgeAttendances() {
    if (!confirm("tem certeza que deseja excluir TODOS os atendimentos?")) return;
    if (!confirm("Esta ação é IRREVERSÍVEL. Todos os atendimentos, serviços, negociações e logs serão apagados. Confirmar?")) return;
    setPurging(true);
    setPurgeResult(null);
    try {
      const r = await fetch(`${API}/attendances`, {
        method: "DELETE",
        headers: { "x-confirm-delete-all": "YES" },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setPurgeResult({ ok: false, message: data?.error || `Erro ${r.status}` });
      } else {
        setPurgeResult({ ok: true, message: `${data.deleted ?? 0} atendimento(s) excluído(s).` });
      }
    } catch (err) {
      setPurgeResult({ ok: false, message: err?.message || "Falha ao excluir" });
    } finally {
      setPurging(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div className="bg-red-950/30 border border-red-800/60 rounded-xl p-6 space-y-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-red-500/15 border border-red-500/30">
            <Trash2 className="w-5 h-5 text-red-300" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-red-200">Excluir todos os atendimentos</h3>
            <p className="text-xs text-red-200/80 mt-1">
              Exclui <strong>TODOS</strong> os atendimentos, serviços, negociações e logs do banco de dados. Útil para limpar dados de testes. Esta ação é <strong>irreversível</strong>.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={purgeAttendances}
          disabled={purging}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-50 text-sm font-semibold text-white"
        >
          <Trash2 className="w-4 h-4" />
          {purging ? "Excluindo..." : "Excluir TODOS os atendimentos"}
        </button>
        {purgeResult && (
          <p className={`text-xs ${purgeResult.ok ? "text-emerald-300" : "text-red-300"}`}>
            {purgeResult.ok ? "✓ " : "✗ "}{purgeResult.message}
          </p>
        )}
      </div>
    </div>
  );
}

// ==================== SHARED COMPONENTS ====================

function StatusBadge({ status, small }) {
  const meta = {
    in_progress: { cls: "bg-amber-500/15 text-amber-300 border-amber-500/30", label: "Em andamento" },
    confirmed: { cls: "bg-sky-500/15 text-sky-300 border-sky-500/30", label: "Confirmado" },
    assigned: { cls: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30", label: "Despachado" },
    completed: { cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", label: "Concluído" },
    cancelled: { cls: "bg-red-500/15 text-red-300 border-red-500/30", label: "Cancelado" },
    pending: { cls: "bg-amber-500/15 text-amber-300 border-amber-500/30", label: "Pendente" },
    no_provider: { cls: "bg-red-500/15 text-red-300 border-red-500/30", label: "Sem prestador" },
    accepted: { cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", label: "Aceito" },
    rejected: { cls: "bg-red-500/15 text-red-300 border-red-500/30", label: "Recusado" },
    timeout: { cls: "bg-slate-500/15 text-slate-300 border-slate-500/30", label: "Timeout" },
    blocked: { cls: "bg-red-500/15 text-red-300 border-red-500/30", label: "Bloqueado" },
    awaiting_quote: { cls: "bg-amber-500/15 text-amber-300 border-amber-500/30", label: "Aguard. cotação" },
    quoted: { cls: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30", label: "Cotado" },
  };
  const def = meta[status] || { cls: "bg-slate-500/15 text-slate-300 border-slate-500/30", label: status || "—" };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full border font-medium ${small ? "text-[10px]" : "text-xs"} ${def.cls}`}
    >
      {def.label}
    </span>
  );
}

function formatDate(d) {
  if (!d) return "-";
  return new Date(d).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function tryParse(json) {
  try { return JSON.parse(json); } catch { return {}; }
}
