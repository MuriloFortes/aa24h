/**
 * Motor de cotação paralela:
 *  - Envia pedido de orçamento para os N prestadores mais próximos.
 *  - Coleta preço + tempo (min) enviados por cada prestador no WhatsApp.
 *  - A cada cotação válida: atualiza ranking, emite Socket e avisa o cliente em tempo real (sem espera de 3 min);
 *  - Cliente tem até N min (padrão 5) para confirmar (SIM/CONFIRMO); expirado, round encerra sem liberar.
 *  - Cliente confirma; então finaliza e libera o prestador. Timeout longo só se ninguém cotar.
 *  - Aplica score (ponderação configurável preço/tempo) e escolhe o melhor.
 *  - Salva cada negociação em `negotiations` com score e eta_minutes.
 */
import { v4 as uuidv4 } from "uuid";
import { logger } from "../lib/logger.js";
import { haversineKm, searchNearbyTowProviders } from "../lib/distance.js";
import { resolveMessageThreadKey, phonesMatchForBrazilQuote } from "../lib/phoneCanonical.js";
import { upsertProviderByContact, markProviderContacted, fetchPlaceDetails } from "./providers.js";

/** WhatsApp usa *negrito* / _itálico_; isso quebra padrões como `r$ 250`. */
function normalizeInboundQuoteText(raw) {
  return String(raw || "")
    .replace(/\u200e|\u200f|\ufeff/g, "")
    .replace(/[\*_~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class QuotesEngine {
  constructor(db, io, sendMessage, getRules, opts = {}) {
    this.db = db;
    this.io = io;
    this.sendMessage = sendMessage;
    this.getRules = getRules;
    this.getSetting =
      typeof opts.getSetting === "function" ? opts.getSetting : () => "";
    this.notifyGestor =
      typeof opts.notifyGestor === "function" ? opts.notifyGestor : async () => {};
    this.mergeAttendanceNotes =
      typeof opts.mergeAttendanceNotes === "function" ? opts.mergeAttendanceNotes : null;
    /** roundId -> state */
    this.activeRounds = new Map();
    /** telefone cliente (só dígitos) -> roundId aguardando confirmação da proposta */
    this.clientConfirmByPhone = new Map();
  }

  _now() {
    return Date.now();
  }

  _dbRun(sql, params) {
    try {
      if (this.db.prepare) return this.db.prepare(sql).run(...params);
    } catch (err) {
      logger.error({ err, sql: sql.slice(0, 100) }, "Erro na query (quotes)");
    }
  }

  _dbGet(sql, params) {
    try {
      if (this.db.prepare) return this.db.prepare(sql).get(...params);
    } catch (err) {
      logger.warn({ err }, "get query falhou");
      return null;
    }
  }

  _dbAll(sql, params) {
    try {
      if (this.db.prepare) return this.db.prepare(sql).all(...params);
    } catch {
      return [];
    }
  }

  /**
   * Inicia um round de cotação.
   * @param {object} ticket - dados do ticket (precisa de serviceId, attendanceId, phoneNumber, location info, etc.)
   * @param {Array} providers - prestadores [{id, name, phone, whatsapp, distance_km, ...}]
   */
  /**
   * Evita duas cotações para o mesmo prestador (mesmo telefone, mesmo provider_id ou mesmo place).
   */
  _dedupeProvidersForRound(providers) {
    const seenPhone = new Set();
    const seenProvId = new Set();
    const seenPlace = new Set();
    const out = [];
    for (const p of providers || []) {
      if (!p || !(p.whatsapp || p.phone)) continue;
      const phone = resolveMessageThreadKey(p.whatsapp || p.phone);
      if (!phone || phone.length < 10) continue;
      if (seenPhone.has(phone)) {
        logger.info({ phone }, "Cotação: ignorado — mesmo telefone já incluído no round");
        continue;
      }
      const pid = p.id ? String(p.id) : "";
      if (pid && seenProvId.has(pid)) {
        logger.info({ providerId: pid }, "Cotação: ignorado — mesmo provider_id já incluído");
        continue;
      }
      const pk = String(p.placeId || p.place_id || "").trim();
      if (pk && seenPlace.has(pk)) {
        logger.info({ placeId: pk }, "Cotação: ignorado — mesmo place_id já incluído");
        continue;
      }
      seenPhone.add(phone);
      if (pid) seenProvId.add(pid);
      if (pk) seenPlace.add(pk);
      out.push(p);
    }
    return out;
  }

  async startRound(ticket, providers) {
    const rules = this.getRules ? this.getRules() : {};
    const raw = Number(rules?.scoring?.max_providers ?? 5);
    const maxProviders = Math.min(5, Math.max(1, Number.isFinite(raw) ? raw : 5));
    const waitMinutes = Number(rules?.scoring?.wait_minutes ?? 10);

    const deduped = this._dedupeProvidersForRound(providers || []);
    const selected = deduped.slice(0, maxProviders).filter((p) => p && (p.whatsapp || p.phone));
    if (selected.length === 0) {
      logger.warn({ serviceId: ticket.serviceId }, "Nenhum prestador com telefone para cotar");
      return { roundId: null, contacted: 0 };
    }

    const attKmForQuote = this._dbGet("SELECT distance_km FROM attendances WHERE id = ?", [ticket.attendanceId]);
    const routeKmForQuote =
      attKmForQuote?.distance_km != null && Number.isFinite(Number(attKmForQuote.distance_km))
        ? Number(attKmForQuote.distance_km)
        : null;

    const roundId = uuidv4();
    const state = {
      roundId,
      ticket,
      startedAt: this._now(),
      waitMs: waitMinutes * 60 * 1000,
      providers: new Map(),
      responses: [],
      finalized: false,
      collectionTimeoutHandle: null,
      clientOfferDeadlineHandle: null,
      clientResponseDeadlineHandle: null,
      clientOfferPhaseStarted: false,
      clientOfferSent: false,
      awaitingClientConfirm: false,
      pendingWinner: null,
      pendingScored: null,
    };
    this.activeRounds.set(roundId, state);

    for (const p of selected) {
      const negotiationId = uuidv4();
      const phone = resolveMessageThreadKey(p.whatsapp || p.phone);
      if (!phone || phone.length < 10) continue;

      let providerId = p.id;
      try {
        if (p.external || !providerId) {
          const up = await upsertProviderByContact(this.db, {
            name: p.name,
            phone: p.phone || p.whatsapp,
            whatsapp: p.whatsapp || p.phone,
            latitude: p.location?.lat ?? p.latitude,
            longitude: p.location?.lng ?? p.longitude,
            addressText: p.vicinity || p.address_text,
            placeId: p.placeId || p.place_id,
            services: p.services || "reboque",
            source: p.external ? "google_places" : undefined,
            photoReference: p.photoReference,
            downloadPhoto: true,
          });
          if (up?.id) providerId = up.id;
        } else {
          markProviderContacted(this.db, providerId);
        }
      } catch (err) {
        logger.warn({ err, providerId }, "Falha ao registrar contato com prestador");
      }

      state.providers.set(phone, { ...p, id: providerId, negotiationId, phoneNorm: phone });
      this._dbRun(
        `INSERT INTO negotiations
           (id, service_id, provider_id, status, contacted_at, distance_km, quote_round_id)
         VALUES (?, ?, ?, 'awaiting_quote', datetime('now'), ?, ?)`,
        [negotiationId, ticket.serviceId, providerId, p.distance_km ?? null, roundId]
      );

      const message = this._buildQuoteMessage(ticket, p, routeKmForQuote);
      try {
        await this.sendMessage(p.whatsapp || p.phone, message);
        await this._mirrorQuoteMessageIfConfigured(p.whatsapp || p.phone, message);
        logger.info({ roundId, providerId, phone: p.whatsapp || p.phone }, "Cotação solicitada ao prestador");
      } catch (err) {
        logger.warn({ err, providerId }, "Falha ao enviar cotação para prestador");
      }
    }

    state.collectionTimeoutHandle = setTimeout(() => this._finalize(roundId, "timeout"), state.waitMs);

    try {
      this.io.emit("quotes:round_started", {
        roundId,
        attendanceId: ticket.attendanceId,
        serviceId: ticket.serviceId,
        providers: Array.from(state.providers.values()).map((p) => ({
          id: p.id,
          name: p.name,
          phone: p.whatsapp || p.phone,
          distanceKm: p.distance_km ?? null,
        })),
        waitMinutes,
      });
    } catch {}

    return { roundId, contacted: state.providers.size };
  }

  /** Texto parece resposta de orçamento (valor ± tempo), mesmo que o formato não seja perfeito. */
  _messageLooksLikeQuoteOffer(rawText) {
    const parsed = this._parsePriceAndEta(rawText);
    if (parsed.price != null && Number(parsed.price) >= 1) return true;
    const t = normalizeInboundQuoteText(rawText).toLowerCase();
    if (/\br\$\s*[\d.,]+/.test(t) && /(\d+)\s*(?:min|minutos|h)/.test(t)) return true;
    if (/\b(valor|cobro|preço|preco)\b/.test(t) && /\d{2,4}/.test(t) && /(\d+)\s*(?:min|minutos)/.test(t)) return true;
    if (/\d{2,5}\s+em\s+\d{1,3}/.test(t)) return true;
    return false;
  }

  /** Alinha cadastro do prestador ao JID/dígitos canônicos recebidos no WhatsApp. */
  _maybeSyncProviderContactCanon(meta, inboundRaw, opts = {}) {
    if (!meta?.id) return;
    const canon = resolveMessageThreadKey(inboundRaw);
    const cur = resolveMessageThreadKey(meta.whatsapp || meta.phone || "");
    if (!canon || canon.length < 12 || canon === cur) return;
    if (
      !opts.force &&
      !phonesMatchForBrazilQuote(inboundRaw, meta.whatsapp || meta.phone || "")
    ) {
      return;
    }
    try {
      this._dbRun(`UPDATE providers SET whatsapp = ?, phone = ? WHERE id = ?`, [canon, canon, meta.id]);
      meta.whatsapp = canon;
      meta.phone = canon;
      logger.info({ providerId: meta.id, canon }, "Prestador: WhatsApp normalizado (9º dígito / PN)");
    } catch (e) {
      logger.warn({ e, providerId: meta.id }, "Falha ao atualizar WhatsApp canônico do prestador");
    }
  }

  _findProviderMetaForInbound(state, providerPhoneRaw, rawText = null) {
    const inv = String(providerPhoneRaw || "").trim();
    if (!inv) return null;

    for (const [k, meta] of state.providers) {
      if (
        phonesMatchForBrazilQuote(inv, k) ||
        phonesMatchForBrazilQuote(inv, meta?.whatsapp) ||
        phonesMatchForBrazilQuote(inv, meta?.phone)
      ) {
        this._maybeSyncProviderContactCanon(meta, inv);
        return { meta, mapKey: k };
      }
    }

    if (!rawText || !this._messageLooksLikeQuoteOffer(rawText)) return null;
    const tailIn = this._normPhone(inv).slice(-8);
    if (tailIn.length < 8) return null;
    for (const [k, meta] of state.providers) {
      for (const cand of [k, meta?.whatsapp, meta?.phone].filter(Boolean)) {
        if (this._normPhone(cand).slice(-8) === tailIn) {
          logger.info(
            { tailIn, providerId: meta?.id, mapKey: k },
            "Cotação: prestador casado por últimos 8 dígitos + texto tipo orçamento"
          );
          this._maybeSyncProviderContactCanon(meta, inv, { force: true });
          return { meta, mapKey: k };
        }
      }
    }
    return null;
  }

  /**
   * Trata uma resposta de prestador (texto recebido pelo webhook WhatsApp).
   * Esperado algo como: "R$ 250, 25 min" / "250 em 20 minutos" / "valor 180 tempo 15".
   * Retorna true se foi consumido por uma round ativa.
   */
  async handleProviderResponse(providerPhone, rawText) {
    for (const [roundId, state] of this.activeRounds) {
      if (state.finalized) continue;
      const found = this._findProviderMetaForInbound(state, providerPhone, rawText);
      if (!found) continue;
      const { meta: providerMeta, mapKey } = found;

      if (this._isRefusal(rawText)) {
        this._dbRun(
          `UPDATE negotiations
             SET status = 'rejected', responded_at = datetime('now'), response_text = ?
             WHERE id = ?`,
          [String(rawText).slice(0, 500), providerMeta.negotiationId]
        );
        state.providers.delete(mapKey);
        this._emitQuoteUpdate(state, providerMeta, null, null, "rejected");
        if (state.providers.size === 0) {
          this._finalize(roundId, "all_rejected");
        }
        return true;
      }

      const negRow = this._dbGet(
        "SELECT invoice_awaiting, invoice_info, counter_price, eta_minutes FROM negotiations WHERE id = ?",
        [providerMeta.negotiationId]
      );

      if (negRow?.invoice_awaiting === 1) {
        const invoiceInfo = this._extractInvoiceInfo(rawText) || String(rawText).trim().slice(0, 300);
        this._dbRun(
          `UPDATE negotiations
             SET invoice_info = ?, invoice_awaiting = 0,
                 responded_at = datetime('now')
           WHERE id = ?`,
          [invoiceInfo, providerMeta.negotiationId]
        );

        const providerRow = providerMeta.id
          ? this._dbGet("SELECT id FROM providers WHERE id = ?", [providerMeta.id])
          : null;
        if (providerRow) {
          this._dbRun("UPDATE providers SET issues_invoice = 1 WHERE id = ?", [providerRow.id]);
        }

        try {
          await this.sendMessage(
            providerPhone,
            "Obrigado! Registrado. Assim que compararmos as propostas retornaremos."
          );
        } catch {}

        if (!state.responses.find((r) => r.negotiationId === providerMeta.negotiationId)) {
          state.responses.push({
            ...providerMeta,
            price: Number(negRow.counter_price || 0),
            etaMinutes: Number(negRow.eta_minutes || 0),
            negotiationId: providerMeta.negotiationId,
            invoiceInfo,
            invoicePending: false,
          });
        } else {
          const r = state.responses.find((r) => r.negotiationId === providerMeta.negotiationId);
          if (r) {
            r.invoiceInfo = invoiceInfo;
            r.invoicePending = false;
          }
        }

        this._emitQuoteUpdate(state, providerMeta, negRow.counter_price, negRow.eta_minutes, "quoted", { invoiceInfo });
        try {
          await this._notifyClientQuoteProgress(state, roundId);
        } catch (e) {
          logger.warn({ e, roundId }, "Notificação ao cliente falhou (cotação já persistida)");
        }
        return true;
      }

      const parsed = this._parsePriceAndEta(rawText);
      if (parsed.price == null && parsed.etaMinutes == null) {
        try {
          await this.sendMessage(
            providerPhone,
            "Não consegui entender sua resposta. Envie no formato: *R$ 250 em 20 min* (valor e previsão em minutos)."
          );
        } catch {}
        return true;
      }

      if (parsed.price == null) {
        try {
          await this.sendMessage(
            providerPhone,
            "Informe o *valor* no formato: *R$ 250 em 20 min* (valor e previsão em minutos)."
          );
        } catch {}
        return true;
      }

      const price = parsed.price;
      const etaMinutes = parsed.etaMinutes != null ? parsed.etaMinutes : 45;
      const invoiceFromMsg = this._extractInvoiceInfo(rawText);
      const providerRow = providerMeta.id
        ? this._dbGet("SELECT issues_invoice FROM providers WHERE id = ?", [providerMeta.id])
        : null;
      const providerIssuesInvoice = providerRow ? Number(providerRow.issues_invoice ?? 1) !== 0 : true;

      const askInvoice = providerIssuesInvoice && !invoiceFromMsg;

      this._dbRun(
        `UPDATE negotiations
           SET counter_price = ?, offered_price = ?,
               eta_minutes = ?, status = 'quoted',
               responded_at = datetime('now'), response_text = ?,
               invoice_info = COALESCE(?, invoice_info),
               invoice_awaiting = ?
           WHERE id = ?`,
        [
          price,
          price,
          etaMinutes,
          String(rawText).slice(0, 500),
          invoiceFromMsg || null,
          askInvoice ? 1 : 0,
          providerMeta.negotiationId,
        ]
      );

      const existingIdx = state.responses.findIndex((r) => r.negotiationId === providerMeta.negotiationId);
      const responseEntry = {
        ...providerMeta,
        price,
        etaMinutes,
        negotiationId: providerMeta.negotiationId,
        invoiceInfo: invoiceFromMsg || null,
        invoicePending: askInvoice,
      };
      if (existingIdx >= 0) {
        state.responses[existingIdx] = { ...state.responses[existingIdx], ...responseEntry };
      } else {
        state.responses.push(responseEntry);
      }
      this._emitQuoteUpdate(state, providerMeta, price, etaMinutes, "quoted", { invoiceInfo: invoiceFromMsg });
      try {
        await this._notifyClientQuoteProgress(state, roundId);
      } catch (e) {
        logger.warn({ e, roundId }, "Notificação ao cliente falhou (cotação já persistida)");
      }

      try {
        if (askInvoice) {
          await this.sendMessage(
            providerPhone,
            `Recebido: *R$ ${Number(price || 0).toFixed(2)}* em *${etaMinutes} min*.\n\n` +
              `Só para registrarmos — *a nota fiscal você me envia quando?*\n` +
              `(Se você não emite nota fiscal, responda *NÃO EMITO*.)`
          );
        } else {
          await this.sendMessage(
            providerPhone,
            `Recebido: *R$ ${Number(price || 0).toFixed(2)}* em *${etaMinutes} min*.` +
              (invoiceFromMsg ? `\nNF: ${invoiceFromMsg}` : "") +
              `\nJá estamos informando o cliente sobre as cotações em tempo real.`
          );
        }
      } catch {}

      return true;
    }

    if (this.activeRounds.size > 0) {
      const peek = [];
      for (const [, s] of this.activeRounds) {
        for (const [k, m] of s.providers) {
          peek.push({ mapKey: k, whatsapp: m?.whatsapp, phone: m?.phone });
        }
      }
      logger.warn(
        {
          providerPhone,
          activeRounds: this.activeRounds.size,
          peek,
          snippet: String(rawText).slice(0, 140),
        },
        "Cotação: resposta não associada a nenhum prestador da round (telefone no WhatsApp ≠ cadastro?)"
      );
    } else {
      logger.warn(
        { providerPhone, snippet: String(rawText).slice(0, 140) },
        "Cotação: nenhuma round em memória (reinício do processo zera rounds) — tentando fallback no SQLite"
      );
    }
    return await this._fallbackNegotiationQuoteReply(providerPhone, rawText);
  }

  /**
   * Se não houver round em memória (reinício do servidor) ou casar telefone falhou,
   * ainda grava a cotação em `negotiations` e notifica o painel.
   */
  async _fallbackNegotiationQuoteReply(providerPhoneRaw, rawText) {
    if (!String(providerPhoneRaw || "").trim()) return false;
    if (this._isRefusal(rawText)) return false;

    const rows = this._dbAll(
      `SELECT n.id AS negotiation_id, n.quote_round_id, n.service_id, n.provider_id, n.status,
              n.invoice_awaiting, n.counter_price, n.eta_minutes,
              p.phone AS p_phone, p.whatsapp AS p_whatsapp, p.name AS p_name
       FROM negotiations n
       LEFT JOIN providers p ON p.id = n.provider_id
       WHERE n.quote_round_id IS NOT NULL
         AND (
           (n.status = 'awaiting_quote' AND (n.invoice_awaiting IS NULL OR n.invoice_awaiting = 0))
           OR (n.status = 'quoted' AND n.invoice_awaiting = 1)
         )`
    );

    if (!rows.length) {
      logger.warn(
        { providerPhoneRaw },
        "Cotação fallback: nenhuma negociação em awaiting_quote (cotação não iniciada, INSERT falhou ou status já mudou)"
      );
      return false;
    }

    for (const row of rows) {
      const keyLike = row.p_whatsapp || row.p_phone || "";
      if (!phonesMatchForBrazilQuote(providerPhoneRaw, keyLike)) continue;

      if (Number(row.invoice_awaiting) === 1) {
        const invoiceInfo = this._extractInvoiceInfo(rawText) || String(rawText).trim().slice(0, 300);
        this._dbRun(
          `UPDATE negotiations
             SET invoice_info = ?, invoice_awaiting = 0, responded_at = datetime('now')
           WHERE id = ?`,
          [invoiceInfo, row.negotiation_id]
        );
        try {
          await this.sendMessage(
            providerPhoneRaw,
            "Obrigado! Registrado. Assim que compararmos as propostas retornaremos."
          );
        } catch {}
        const ctx = this._loadQuoteNotifyContext(row.service_id);
        if (ctx) {
          try {
            this.io.emit("quotes:update", {
              roundId: row.quote_round_id,
              attendanceId: ctx.attendanceId,
              serviceId: row.service_id,
              provider: { id: row.provider_id, name: row.p_name, phone: row.p_whatsapp || row.p_phone },
              price: Number(row.counter_price || 0),
              etaMinutes: Number(row.eta_minutes || 0),
              status: "quoted",
              invoiceInfo,
              fallback: true,
            });
          } catch {}
          try {
            if (ctx.callerId) {
              await this.sendMessage(
                ctx.callerId,
                `📊 *Cotação atualizada*\n\n${row.p_name || "Prestador"} informou dados de NF.\n` +
                  `Valor registrado: *R$ ${Number(row.counter_price || 0).toFixed(2)}* · ` +
                  `*${Number(row.eta_minutes || 0)} min*`
              );
            }
          } catch (e) {
            logger.warn({ e }, "fallback: aviso ao cliente (NF)");
          }
        }
        logger.info({ negotiationId: row.negotiation_id }, "Cotação (fallback): NF registrada sem round em memória");
        return true;
      }

      const parsed = this._parsePriceAndEta(rawText);
      if (parsed.price == null) continue;
      const price = parsed.price;
      const etaMinutes = parsed.etaMinutes != null ? parsed.etaMinutes : 45;
      const invoiceFromMsg = this._extractInvoiceInfo(rawText);
      const providerRow = row.provider_id
        ? this._dbGet("SELECT issues_invoice FROM providers WHERE id = ?", [row.provider_id])
        : null;
      const providerIssuesInvoice = providerRow ? Number(providerRow.issues_invoice ?? 1) !== 0 : true;
      const askInvoice = providerIssuesInvoice && !invoiceFromMsg;

      this._dbRun(
        `UPDATE negotiations
           SET counter_price = ?, offered_price = ?,
               eta_minutes = ?, status = 'quoted',
               responded_at = datetime('now'), response_text = ?,
               invoice_info = COALESCE(?, invoice_info),
               invoice_awaiting = ?
         WHERE id = ?`,
        [
          price,
          price,
          etaMinutes,
          String(rawText).slice(0, 500),
          invoiceFromMsg || null,
          askInvoice ? 1 : 0,
          row.negotiation_id,
        ]
      );

      const ctx = this._loadQuoteNotifyContext(row.service_id);
      if (ctx) {
        try {
          this.io.emit("quotes:update", {
            roundId: row.quote_round_id,
            attendanceId: ctx.attendanceId,
            serviceId: row.service_id,
            provider: { id: row.provider_id, name: row.p_name, phone: row.p_whatsapp || row.p_phone },
            price,
            etaMinutes,
            status: "quoted",
            invoiceInfo: invoiceFromMsg,
            fallback: true,
          });
        } catch {}
        try {
          if (ctx.callerId) {
            await this.sendMessage(
              ctx.callerId,
              `📊 *Nova cotação*\n\n*${row.p_name || "Prestador"}*: *R$ ${price.toFixed(2)}* em *${etaMinutes} min*.\n` +
                (askInvoice
                  ? "\nAguardando confirmações de NF dos prestadores; você receberá outro resumo em seguida."
                  : "\nResponda *SIM* ou *CONFIRMO* quando quiser aceitar a melhor opção (acompanhe as mensagens).")
            );
          }
        } catch (e) {
          logger.warn({ e }, "fallback: aviso ao cliente");
        }
      }

      try {
        if (askInvoice) {
          await this.sendMessage(
            providerPhoneRaw,
            `Recebido: *R$ ${Number(price || 0).toFixed(2)}* em *${etaMinutes} min*.\n\n` +
              `Só para registrarmos — *a nota fiscal você me envia quando?*\n` +
              `(Se você não emite nota fiscal, responda *NÃO EMITO*.)`
          );
        } else {
          await this.sendMessage(
            providerPhoneRaw,
            `Recebido: *R$ ${Number(price || 0).toFixed(2)}* em *${etaMinutes} min*.` +
              (invoiceFromMsg ? `\nNF: ${invoiceFromMsg}` : "") +
              `\nJá estamos informando o cliente sobre as cotações em tempo real.`
          );
        }
      } catch {}

      logger.warn(
        { negotiationId: row.negotiation_id, quoteRoundId: row.quote_round_id },
        "Cotação aplicada via fallback (sem round ativo em memória — reinicie o fluxo ou evite reiniciar o servidor durante cotações)"
      );
      return true;
    }
    logger.warn(
      { providerPhoneRaw, awaitingRows: rows.length },
      "Cotação fallback: telefone do remetente não bateu com p_phone/p_whatsapp das negociações pendentes"
    );
    return false;
  }

  _loadQuoteNotifyContext(serviceId) {
    if (!serviceId) return null;
    const row = this._dbGet(
      `SELECT s.id AS service_id, s.attendance_id, a.caller_id
       FROM services s
       JOIN attendances a ON a.id = s.attendance_id
       WHERE s.id = ?`,
      [serviceId]
    );
    if (!row) return null;
    return {
      serviceId: row.service_id,
      attendanceId: row.attendance_id,
      callerId: row.caller_id,
    };
  }

  /**
   * Atualiza ranking, Socket e WhatsApp do cliente a cada nova cotação (sem espera de 3 min).
   */
  async _notifyClientQuoteProgress(state, roundId) {
    if (state.finalized) return;
    const priced = state.responses.filter((r) => r.price != null);
    if (priced.length === 0) return;

    const isFirstClientTouch = !state.clientOfferPhaseStarted;
    if (isFirstClientTouch) {
      state.clientOfferPhaseStarted = true;
      if (state.collectionTimeoutHandle) {
        clearTimeout(state.collectionTimeoutHandle);
        state.collectionTimeoutHandle = null;
      }
      if (state.clientOfferDeadlineHandle) {
        clearTimeout(state.clientOfferDeadlineHandle);
        state.clientOfferDeadlineHandle = null;
      }
      state.clientOfferSent = true;
      state.awaitingClientConfirm = true;
      const norm = this._normClientKey(state.ticket.phoneNumber);
      if (norm) this.clientConfirmByPhone.set(norm, roundId);
      try {
        this.mergeAttendanceNotes?.(state.ticket.attendanceId, {
          workflow_phase: "awaiting_client_quote_confirm",
        });
      } catch (e) {
        logger.warn({ e }, "mergeAttendanceNotes awaiting_client_quote_confirm");
      }
      const confirmMinutes = Number(this.getSetting("quote_client_confirm_minutes", "5") || 5);
      const confirmMs = Math.max(1, confirmMinutes) * 60 * 1000;
      if (state.clientResponseDeadlineHandle) clearTimeout(state.clientResponseDeadlineHandle);
      state.clientResponseDeadlineHandle = setTimeout(() => {
        void this._onClientResponseDeadlineExpired(roundId);
      }, confirmMs);
    }

    const scored = this._scoreResponsesFromList(priced);
    for (const s of scored) {
      this._dbRun(`UPDATE negotiations SET score = ? WHERE id = ?`, [s.score, s.negotiationId]);
    }
    const best = scored[0];
    state.pendingWinner = best;
    state.pendingScored = scored;

    try {
      this.io.emit("quotes:leader_updated", {
        roundId: state.roundId,
        attendanceId: state.ticket.attendanceId,
        serviceId: state.ticket.serviceId,
        bestPrice: best.price,
        bestEta: best.etaMinutes,
        bestName: best.name,
        quoteCount: scored.length,
      });
    } catch {}

    try {
      await this._sendClientQuotesDigest(state, scored, isFirstClientTouch);
    } catch (e) {
      logger.warn({ e, roundId }, "Falha ao montar/enviar digest de cotação ao cliente");
    }
    logger.info(
      { roundId, quotes: scored.length, best: best.name },
      "Cliente notificado — cotação em tempo real"
    );
  }

  _scoreResponsesFromList(responses) {
    const rules = this.getRules ? this.getRules() : {};
    const pW = Number(rules?.scoring?.price_weight ?? 0.6);
    const tW = Number(rules?.scoring?.time_weight ?? 0.4);
    const prices = responses.map((r) => Number(r.price));
    const times = responses.map((r) => Number(r.etaMinutes || 0));
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const scored = responses.map((r) => {
      const pN = maxP === minP ? 0 : (Number(r.price) - minP) / (maxP - minP);
      const tN = maxT === minT ? 0 : (Number(r.etaMinutes || 0) - minT) / (maxT - minT);
      const score = pW * pN + tW * tN;
      return { ...r, score };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored;
  }

  /**
   * Prazo para o cliente confirmar (SIM/CONFIRMO) após receber a proposta.
   */
  async _onClientResponseDeadlineExpired(roundId) {
    const state = this.activeRounds.get(roundId);
    if (!state || state.finalized) return;
    if (!state.awaitingClientConfirm || !state.clientOfferSent || !state.pendingWinner) return;
    state.finalized = true;
    if (state.clientResponseDeadlineHandle) {
      clearTimeout(state.clientResponseDeadlineHandle);
      state.clientResponseDeadlineHandle = null;
    }
    clearTimeout(state.collectionTimeoutHandle);
    clearTimeout(state.clientOfferDeadlineHandle);
    state.collectionTimeoutHandle = null;
    state.clientOfferDeadlineHandle = null;

    const normClient = this._normClientKey(state.ticket.phoneNumber);
    if (normClient) {
      this.clientConfirmByPhone.delete(normClient);
      this.clientConfirmByPhone.delete(this._normPhone(state.ticket.phoneNumber));
    }

    this._dbRun(
      `UPDATE negotiations SET status = 'timeout'
       WHERE quote_round_id = ? AND status IN ('awaiting_quote', 'pending', 'quoted')`,
      [roundId]
    );

    const clientPhone = state.ticket.phoneNumber;
    if (clientPhone) {
      try {
        await this.sendMessage(
          clientPhone,
          `⏱️ *Prazo encerrado.* Não recebemos sua confirmação a tempo.\n\n` +
            `Se ainda quiser o serviço, entre em contato com a central para retomar o atendimento.`
        );
      } catch (err) {
        logger.warn({ err }, "Falha ao avisar cliente sobre expiração da confirmação");
      }
    }

    const scored = state.pendingScored || [];
    for (const s of scored) {
      const phone = s.whatsapp || s.phone;
      if (!phone) continue;
      try {
        await this.sendMessage(
          phone,
          "O cliente não confirmou a proposta dentro do prazo. Não se desloque até nova orientação da central."
        );
      } catch {}
    }

    try {
      const prot =
        state.ticket.protocol ||
        (state.ticket.serviceId ? String(state.ticket.serviceId).slice(0, 8).toUpperCase() : "—");
      await this.notifyGestor(
        `⏱️ *Cotação — cliente não confirmou no prazo*\n` +
          `Protocolo: ${prot}\n` +
          `Proposta enviada (melhor opção): ${state.pendingWinner?.name || "—"} — R$ ${Number(state.pendingWinner?.price || 0).toFixed(2)}`
      );
    } catch (e) {
      logger.warn({ e }, "notifyGestor expiração confirmação cliente");
    }

    try {
      this.mergeAttendanceNotes?.(state.ticket.attendanceId, {
        workflow_phase: "client_quote_confirm_expired",
      });
    } catch (e) {
      logger.warn({ e }, "mergeAttendanceNotes client_quote_confirm_expired");
    }

    try {
      this.io.emit("quotes:round_finished", {
        roundId,
        attendanceId: state.ticket.attendanceId,
        serviceId: state.ticket.serviceId,
        reason: "client_confirm_timeout",
        chosen: null,
        candidates: (scored || []).map((s) => ({
          providerId: s.id,
          providerName: s.name,
          price: s.price,
          etaMinutes: s.etaMinutes,
          score: s.score,
        })),
      });
    } catch {}

    logger.info({ roundId }, "Prazo de confirmação do cliente expirado — prestador não liberado");
    this.activeRounds.delete(roundId);
  }

  async _sendClientQuotesDigest(state, scored, isFirst) {
    const clientPhone = state.ticket.phoneNumber;
    if (!clientPhone) return;
    const best = scored[0];
    let billingMode = "associate";
    let markupPct = 10;
    try {
      const attNotesRow = this._dbGet("SELECT notes FROM attendances WHERE id = ?", [state.ticket.attendanceId]);
      const parsed = JSON.parse(attNotesRow?.notes || "{}");
      billingMode = parsed.billing_mode || "associate";
    } catch {
      billingMode = "associate";
    }
    try {
      markupPct = Number(this.getSetting("non_associate_markup_percent", "10") || 10);
      if (!Number.isFinite(markupPct) || markupPct < 0) markupPct = 10;
    } catch {
      markupPct = 10;
    }
    const clientCharge =
      billingMode === "prepay_non_associate"
        ? Number(best.price) * (1 + markupPct / 100)
        : Number(best.price);
    const confirmMinutes = Number(this.getSetting("quote_client_confirm_minutes", "5") || 5);
    const lines = scored
      .map((s, i) => {
        const star = i === 0 ? " ⭐" : "";
        const nf = s.invoicePending === true ? " _(aguardando NF)_" : "";
        return `${i + 1}. ${s.name || "—"} — R$ ${Number(s.price).toFixed(2)} / ${s.etaMinutes ?? "?"} min${star}${nf}`;
      })
      .join("\n");

    const head = isFirst
      ? `📊 *Cotação em andamento*\n\nRecebemos *${scored.length}* proposta(s). Conforme outros prestadores responderem, avisaremos por aqui.\n\n`
      : `📊 *Atualização da sua cotação*\n\nJá temos *${scored.length}* proposta(s).\n\n`;

    let msg =
      head +
      `*Melhor custo-benefício agora:* *${best.name || "—"}*\n` +
      `💰 Valor (prestador): *R$ ${Number(best.price).toFixed(2)}*\n` +
      `⏱️ Previsão: *${best.etaMinutes ?? "?"} min*\n`;
    if (billingMode === "prepay_non_associate") {
      msg += `💳 *Total estimado com taxa (${markupPct}%): R$ ${clientCharge.toFixed(2)}*\n`;
    }
    msg += `\n*Comparativo:*\n${lines}\n\n`;
    msg +=
      `Para *aceitar* a melhor opção *neste momento* e liberar o prestador, responda *SIM* ou *CONFIRMO*.\n` +
      `⏱️ Você tem até *${Math.max(1, confirmMinutes)} minuto(s)* (a partir da primeira atualização) para confirmar.`;
    if (!isFirst) {
      msg += `\n\n_O ranking pode mudar se chegarem novas propostas._`;
    }
    try {
      await this.sendMessage(clientPhone, msg);
    } catch (err) {
      logger.warn({ err }, "Falha ao enviar atualização de cotação ao cliente");
    }
  }

  _isClientConfirmText(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return false;
    if (/\bcancel|desist|reiniciar|não quero|nao quero\b/.test(t)) return false;
    const phrases = [
      "sim",
      "confirmo",
      "confirmar",
      "confirmado",
      "aceito",
      "autorizo",
      "pode enviar",
      "pode liberar",
      "libera",
      "liberar",
      "pode seguir",
      "está correto",
      "esta correto",
      "isso mesmo",
      "pode ser",
      "correto",
      "certo",
    ];
    return phrases.some((p) => t === p || t.startsWith(p + " ") || t.startsWith(p + ","));
  }

  /**
   * Cliente responde SIM/CONFIRMO após receber a proposta com valores.
   * @returns {{ handled: boolean }}
   */
  async handleClientQuoteConfirmation(phone, text) {
    logger.info({ phone, text, clientConfirmMapSize: this.clientConfirmByPhone.size }, "handleClientQuoteConfirmation: INÍCIO");
    const isWebSession = /^web[_-]/i.test(String(phone || ""));
    const norm = this._normClientKey(phone);
    let roundId = this.clientConfirmByPhone.get(norm);
    logger.info({ norm, roundIdFromMap: !!roundId }, "handleClientQuoteConfirmation: buscando no mapa");
    if (!roundId) {
      roundId = this.clientConfirmByPhone.get(this._normPhone(phone));
    }
    // Para sessão web (web_*), buscar pela chave do telefone real do cliente nos rounds ativos
    if (!roundId && isWebSession) {
      logger.info({ activeRounds: this.activeRounds.size }, "handleClientQuoteConfirmation: verificando rounds ativos para web");
      for (const [rid, st] of this.activeRounds) {
        logger.info({ roundId: rid, awaitingConfirm: st.awaitingClientConfirm, offerSent: st.clientOfferSent, winner: !!st.pendingWinner }, "handleClientQuoteConfiguration: round ativo");
        if (st.awaitingClientConfirm && st.clientOfferSent && st.pendingWinner) {
          const ticketPhone = this._normClientKey(st.ticket.phoneNumber);
          logger.info({ ticketPhone, phoneSlice: this._normPhone(phone).slice(-8), ticketPhoneSlice: this._normPhone(ticketPhone || "").slice(-8) }, "comparando telefones");
          if (ticketPhone && this._normPhone(phone).endsWith(this._normPhone(ticketPhone).slice(-8))) {
            roundId = rid;
            logger.info({ roundId }, "handleClientQuoteConfirmation: round encontrado para web");
            break;
          }
        }
      }
    }
    if (!roundId) {
      logger.warn({ phone, norm, isWebSession, activeRoundsSize: this.activeRounds.size, confirmMapKeys: [...this.clientConfirmByPhone.keys()] }, "handleClientQuoteConfirmation: round NÃO encontrado");
      return { handled: false };
    }
    const state = this.activeRounds.get(roundId);
    if (!state || !state.awaitingClientConfirm || !state.clientOfferSent || !state.pendingWinner) {
      logger.warn({ roundId, stateExists: !!state, awaitingConfirm: state?.awaitingClientConfirm, offerSent: state?.clientOfferSent, winner: !!state?.pendingWinner }, "handleClientQuoteConfirmation: estado inválido");
      return { handled: false };
    }
    if (!this._isClientConfirmText(text)) {
      logger.warn({ text }, "handleClientQuoteConfirmation: texto não reconhecido como confirmação");
      return { handled: false };
    }
    logger.info({ roundId, winner: state.pendingWinner?.name }, "handleClientQuoteConfirmation: CONFIRMANDO - chamand o_finalize");
    this.clientConfirmByPhone.delete(norm);
    this.clientConfirmByPhone.delete(this._normPhone(phone));
    if (state.clientResponseDeadlineHandle) {
      clearTimeout(state.clientResponseDeadlineHandle);
      state.clientResponseDeadlineHandle = null;
    }
    this._finalize(roundId, "client_confirmed", {
      winner: state.pendingWinner,
      scored: state.pendingScored,
    });
    return { handled: true };
  }

  /**
   * Identifica menção a nota fiscal + quando será emitida.
   * Retorna string resumida ou null se não houver indicação.
   */
  _extractInvoiceInfo(text) {
    const t = String(text || "").trim();
    const tl = t.toLowerCase();
    const noInvoice = /\b(n[ãa]o emito|sem nota|n[ãa]o emite|n[ãa]o tem nota)\b/.test(tl);
    if (noInvoice) return "Não emite nota fiscal";
    const mentionsInvoice = /\b(nota fiscal|\bnf\b|\bnfs?-?e\b|\bnfe\b)/i.test(t);
    if (!mentionsInvoice) return null;
    const whenMatchers = [
      /\b(hoje|amanh[ãa]|depois|ap[oó]s o servi[çc]o|ap[oó]s finalizar|no final|no fim)\b[^.\n]*/i,
      /\bem (?:at[eé] )?(\d+)\s*(?:dia|dias|h|hora|horas|d[ií]as[ ú]teis)\b/i,
      /\bdia (\d{1,2}[\/-]?\d{0,2})\b/i,
      /\b(ao final|ao concluir)[^.\n]*/i,
    ];
    for (const re of whenMatchers) {
      const m = t.match(re);
      if (m) return `NF: ${m[0]}`;
    }
    return `NF: ${t.slice(0, 120)}`;
  }

  _finalize(roundId, reason, precomputed = null) {
    const state = this.activeRounds.get(roundId);
    if (!state || state.finalized) return;
    state.finalized = true;
    clearTimeout(state.collectionTimeoutHandle);
    clearTimeout(state.clientOfferDeadlineHandle);
    clearTimeout(state.clientResponseDeadlineHandle);

    const normClient = this._normClientKey(state.ticket.phoneNumber);
    if (normClient) {
      this.clientConfirmByPhone.delete(normClient);
      this.clientConfirmByPhone.delete(this._normPhone(state.ticket.phoneNumber));
    }

    let scored;
    let winner;

    if (precomputed?.winner && Array.isArray(precomputed?.scored)) {
      scored = precomputed.scored;
      winner = precomputed.winner;
    } else {
      const responses = state.responses.filter((r) => r.price != null);

      if (responses.length === 0) {
        logger.warn({ roundId, reason }, "Nenhum orçamento recebido dentro do prazo");
        this._dbRun(
          `UPDATE negotiations SET status = 'timeout'
         WHERE quote_round_id = ? AND status IN ('awaiting_quote', 'pending')`,
          [roundId]
        );
        try {
          this.io.emit("quotes:round_finished", {
            roundId,
            attendanceId: state.ticket.attendanceId,
            serviceId: state.ticket.serviceId,
            chosen: null,
            reason,
            candidates: [],
          });
        } catch {}
        this.activeRounds.delete(roundId);
        return;
      }

      const rules = this.getRules ? this.getRules() : {};
      const pW = Number(rules?.scoring?.price_weight ?? 0.6);
      const tW = Number(rules?.scoring?.time_weight ?? 0.4);

      const prices = responses.map((r) => Number(r.price));
      const times = responses.map((r) => Number(r.etaMinutes || 0));
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      const minT = Math.min(...times);
      const maxT = Math.max(...times);

      scored = responses.map((r) => {
        const pN = maxP === minP ? 0 : (Number(r.price) - minP) / (maxP - minP);
        const tN = maxT === minT ? 0 : (Number(r.etaMinutes || 0) - minT) / (maxT - minT);
        const score = pW * pN + tW * tN;
        return { ...r, score };
      });
      scored.sort((a, b) => a.score - b.score);

      for (const s of scored) {
        this._dbRun(`UPDATE negotiations SET score = ? WHERE id = ?`, [s.score, s.negotiationId]);
      }

      winner = scored[0];
    }

    let billingMode = "associate";
    let markupPct = 10;
    try {
      const attNotesRow = this._dbGet("SELECT notes FROM attendances WHERE id = ?", [
        state.ticket.attendanceId,
      ]);
      const parsed = JSON.parse(attNotesRow?.notes || "{}");
      billingMode = parsed.billing_mode || "associate";
    } catch {
      billingMode = "associate";
    }
    try {
      markupPct = Number(this.getSetting("non_associate_markup_percent", "10") || 10);
      if (!Number.isFinite(markupPct) || markupPct < 0) markupPct = 10;
    } catch {
      markupPct = 10;
    }
    const clientCharge =
      billingMode === "prepay_non_associate"
        ? Number(winner.price) * (1 + markupPct / 100)
        : Number(winner.price);

    this._dbRun(
      `UPDATE negotiations SET status = 'accepted', final_price = ? WHERE id = ?`,
      [winner.price, winner.negotiationId]
    );
    for (const other of scored.slice(1)) {
      this._dbRun(
        `UPDATE negotiations SET status = 'rejected' WHERE id = ? AND status = 'quoted'`,
        [other.negotiationId]
      );
    }

    const winnerNegRow = this._dbGet(
      "SELECT invoice_info FROM negotiations WHERE id = ?",
      [winner.negotiationId]
    );
    const providerRow = winner.id
      ? this._dbGet("SELECT issues_invoice FROM providers WHERE id = ?", [winner.id])
      : null;
    const issuesInvoice = providerRow ? Number(providerRow.issues_invoice ?? 1) !== 0 : true;
    const invoiceInfo = winnerNegRow?.invoice_info || (issuesInvoice ? null : "Não emite nota fiscal");

    const obsParts = [];
    obsParts.push(`Prestador escolhido: ${winner.name || "—"} — R$ ${Number(winner.price).toFixed(2)} / ${winner.etaMinutes} min`);
    if (invoiceInfo) obsParts.push(invoiceInfo);
    else obsParts.push("NF: não informada (confirmar manualmente)");
    const observation = obsParts.join("\n");

    this._dbRun(
      `UPDATE attendances SET
          provider_id = ?, provider_name = ?, provider_phone = ?,
          provider_price = ?, eta_minutes = ?, status = 'assigned',
          observation = CASE
            WHEN observation IS NULL OR observation = '' THEN ?
            ELSE observation || char(10) || ?
          END,
          updated_at = datetime('now')
        WHERE id = ?`,
      [
        winner.id,
        winner.name,
        winner.whatsapp || winner.phone || null,
        winner.price,
        winner.etaMinutes,
        observation,
        observation,
        state.ticket.attendanceId,
      ]
    );

    this._dbRun(
      `UPDATE services SET
          provider_id = ?, provider_name = ?, price = ?, eta_minutes = ?,
          status = 'assigned', updated_at = datetime('now')
        WHERE id = ?`,
      [winner.id, winner.name, winner.price, winner.etaMinutes, state.ticket.serviceId]
    );

    try {
      const patch = {
        provider_quote_price: Number(winner.price),
        client_charge_price: clientCharge,
        markup_percent_applied: billingMode === "prepay_non_associate" ? markupPct : 0,
        billing_mode: billingMode,
      };
      if (billingMode === "prepay_non_associate") {
        patch.workflow_phase = "awaiting_tow_photos";
      }
      this.mergeAttendanceNotes?.(state.ticket.attendanceId, patch);
    } catch (e) {
      logger.warn({ e }, "mergeAttendanceNotes no finalize");
    }

    const attKmRow = this._dbGet("SELECT distance_km FROM attendances WHERE id = ?", [state.ticket.attendanceId]);
    const routeKm =
      attKmRow?.distance_km != null && Number.isFinite(Number(attKmRow.distance_km))
        ? Number(attKmRow.distance_km)
        : null;
const routeKmStr = routeKm != null ? routeKm.toFixed(1) : null;

    logger.info({ winnerPhone: winner.whatsapp || winner.phone, clientPhone: state.ticket.phoneNumber, billingMode }, "_finalize: iniciando envio de mensagens");
    (async () => {
      const winnerPhone = winner.whatsapp || winner.phone;
      if (winnerPhone) {
        logger.info({ winnerPhone }, "_finalize: enviando mensagem ao PRESTADOR");
        try {
          if (billingMode === "prepay_non_associate") {
            await this.sendMessage(
              winnerPhone,
              `✅ *Liberação de saída — melhor custo-benefício*\n\n` +
                `Você foi selecionado neste atendimento. Pode *iniciar o deslocamento*.\n` +
                `💰 R$ ${Number(winner.price).toFixed(2)} · ⏱️ ${winner.etaMinutes} min.\n` +
                (routeKmStr ? `📏 Trajeto (origem → destino): *${routeKmStr} km*\n` : "") +
                `📋 Cliente: ${state.ticket.customerName || "—"}\n` +
                `📍 Origem: ${state.ticket.location || "—"}\n` +
                `📍 Destino: ${state.ticket.destination || "—"}\n` +
                `🚗 Placa: ${state.ticket.vehiclePlate || "—"}\n\n` +
                `📸 Quando o veículo estiver *no reboque*, envie *fotos* aqui.\n` +
                `Em seguida envie sua *chave PIX* para repassarmos ao financeiro.`
            );
          } else {
            await this.sendMessage(
              winnerPhone,
              `✅ *Proposta aceita!* Serviço confirmado com você.\n` +
                `💰 R$ ${Number(winner.price).toFixed(2)} · ⏱️ ${winner.etaMinutes} min.\n` +
                (routeKmStr ? `📏 Trajeto do serviço (origem → destino): *${routeKmStr} km*\n` : "") +
                `📋 Cliente: ${state.ticket.customerName || "—"}\n` +
                `📍 Origem: ${state.ticket.location || "—"}\n` +
                `📍 Destino: ${state.ticket.destination || "—"}\n` +
                `🚗 Placa: ${state.ticket.vehiclePlate || "—"}`
            );
          }
        } catch (e) {
          logger.error({ e, winnerPhone }, "_finalize: ERRO ao enviar mensagem ao prestador");
        }
      }
      const clientPhone = state.ticket.phoneNumber;
      if (clientPhone) {
        logger.info({ clientPhone }, "_finalize: enviando mensagem ao CLIENTE");
        try {
          if (billingMode === "prepay_non_associate") {
            await this.sendMessage(
              winnerPhone,
              `✅ *Liberação de saída — melhor custo-benefício*\n\n` +
                `Você foi selecionado neste atendimento. Pode *iniciar o deslocamento*.\n` +
                `💰 R$ ${Number(winner.price).toFixed(2)} · ⏱️ ${winner.etaMinutes} min.\n` +
                (routeKmStr ? `📏 Trajeto (origem → destino): *${routeKmStr} km*\n` : "") +
                `📋 Cliente: ${state.ticket.customerName || "—"}\n` +
                `📍 Origem: ${state.ticket.location || "—"}\n` +
                `📍 Destino: ${state.ticket.destination || "—"}\n` +
                `🚗 Placa: ${state.ticket.vehiclePlate || "—"}\n\n` +
                `📸 Quando o veículo estiver *no reboque*, envie *fotos* aqui.\n` +
                `Em seguida envie sua *chave PIX* para repassarmos ao financeiro.`
            );
          } else {
            await this.sendMessage(
              winnerPhone,
              `✅ *Proposta aceita!* Serviço confirmado com você.\n` +
                `💰 R$ ${Number(winner.price).toFixed(2)} · ⏱️ ${winner.etaMinutes} min.\n` +
                (routeKmStr ? `📏 Trajeto do serviço (origem → destino): *${routeKmStr} km*\n` : "") +
                `📋 Cliente: ${state.ticket.customerName || "—"}\n` +
                `📍 Origem: ${state.ticket.location || "—"}\n` +
                `📍 Destino: ${state.ticket.destination || "—"}\n` +
                `🚗 Placa: ${state.ticket.vehiclePlate || "—"}`
            );
          }
        } catch {}
      }
      if (clientPhone) {
        try {
          if (billingMode === "prepay_non_associate") {
            const pixKey = String(this.getSetting("association_pix_key", "") || "").trim();
            let payBlock = "";
            if (pixKey) {
              payBlock =
                `\n💳 *Chave PIX da associação (pagamento):*\n*${pixKey}*\n` +
                `\n💰 *Valor do reboque (prestador):* R$ ${Number(winner.price).toFixed(2)}\n` +
                `💰 *Total a pagar (reboque + ${markupPct}%):* R$ ${clientCharge.toFixed(2)}\n`;
            } else {
              payBlock =
                `\n⚠️ *Chave PIX* ainda não cadastrada no painel — confirme com a central.\n` +
                `\n💰 *Valor do reboque (prestador):* R$ ${Number(winner.price).toFixed(2)}\n` +
                `💰 *Total a pagar (reboque + ${markupPct}%):* R$ ${clientCharge.toFixed(2)}\n`;
            }
            await this.sendMessage(
              clientPhone,
              `✅ *Cotações finalizadas — serviço confirmado!*\n\n` +
                `👤 *Prestador:* ${winner.name || "—"}\n` +
                `⏱️ *Previsão:* ${winner.etaMinutes} min\n` +
                (routeKmStr ? `📏 *Distância do trajeto (origem → destino):* ${routeKmStr} km\n` : "") +
                payBlock +
                `\nEfetue o pagamento conforme combinado (antecipado).`
            );
          } else {
            await this.sendMessage(
              clientPhone,
              `✅ *Serviço confirmado!*\n\n` +
                `👤 *Prestador:* ${winner.name || "—"}\n` +
                `💰 *Valor:* R$ ${Number(winner.price).toFixed(2)}\n` +
                `⏱️ *Previsão:* ${winner.etaMinutes} min\n` +
                (routeKmStr ? `📏 *Distância do trajeto (origem → destino):* ${routeKmStr} km\n` : "") +
                `\nO prestador foi notificado.`
            );
          }
        } catch (err) {
          logger.warn({ err }, "Falha ao notificar cliente sobre cotação aceita");
        }
      }

      try {
        const prot =
          state.ticket.protocol ||
          (state.ticket.serviceId ? String(state.ticket.serviceId).slice(0, 8).toUpperCase() : "—");
        const lines = scored
          .map(
            (s, i) =>
              `${i + 1}. ${s.name || "—"} — R$ ${Number(s.price).toFixed(2)} / ${s.etaMinutes ?? "?"} min (score ${Number(s.score).toFixed(3)})`
          )
          .join("\n");
        const pixGestor = String(this.getSetting("association_pix_key", "") || "").trim();
        let gestorExtra = "";
        if (billingMode === "prepay_non_associate") {
          gestorExtra =
            `\n💰 Valor cliente (com taxa): R$ ${clientCharge.toFixed(2)}\n` +
            (pixGestor ? `💳 Chave PIX repassada ao cliente: ${pixGestor}\n` : "");
        }
        await this.notifyGestor(
          `📊 *Cotação encerrada*\n` +
            `Protocolo: ${prot}\n` +
            `Escolhido: ${winner.name || "—"} — R$ ${Number(winner.price).toFixed(2)} / ${winner.etaMinutes ?? "?"} min\n` +
            `Comparativo:\n${lines}` +
            gestorExtra
        );
      } catch (e) {
        logger.warn({ e }, "notifyGestor cotação falhou");
      }
      for (const other of scored.slice(1)) {
        const phone = other.whatsapp || other.phone;
        if (!phone) continue;
        try {
          await this.sendMessage(
            phone,
            "Obrigado pela proposta. Para este atendimento optamos por outro prestador. Seguiremos em contato em novas oportunidades."
          );
        } catch {}
      }
    })();

    try {
      this.io.emit("quotes:round_finished", {
        roundId,
        attendanceId: state.ticket.attendanceId,
        serviceId: state.ticket.serviceId,
        reason,
        chosen: {
          providerId: winner.id,
          providerName: winner.name,
          price: winner.price,
          etaMinutes: winner.etaMinutes,
          score: winner.score,
        },
        candidates: scored.map((s) => ({
          providerId: s.id,
          providerName: s.name,
          price: s.price,
          etaMinutes: s.etaMinutes,
          score: s.score,
        })),
      });
    } catch {}

    logger.info(
      { roundId, winner: winner.id, price: winner.price, eta: winner.etaMinutes, reason },
      "Round de cotação finalizado"
    );
    this.activeRounds.delete(roundId);
  }

  _buildQuoteMessage(ticket, provider, routeKm = null) {
    const sid = ticket.protocol
      || (ticket.serviceId ? String(ticket.serviceId).slice(0, 8).toUpperCase() : "—");
    const dist = provider?.distance_km != null ? `${Number(provider.distance_km).toFixed(1)} km` : "—";
    const routeLine =
      routeKm != null && Number.isFinite(Number(routeKm))
        ? `📏 Trajeto do serviço (origem → destino): *${Number(routeKm).toFixed(1)} km*\n`
        : "";
    const tw = { facil: "fácil", dificil: "difícil", bloqueado: "bloqueado" }[ticket.towingAccess] || "—";
    return (
      `📣 *Cotação — SGA Assistência*\n\n` +
      `📋 Ref. serviço: ${sid}\n` +
      `👤 Cliente: ${ticket.customerName || "—"}\n` +
      `📍 Origem: ${ticket.location || "—"}\n` +
      `📍 Destino: ${ticket.destination || "—"}\n` +
      routeLine +
      `🚗 Placa: ${ticket.vehiclePlate || "—"}\n` +
      `🏷️ Veículo: ${ticket.vehicleType || "—"}\n` +
      `🔧 Serviço: ${ticket.serviceType || "—"}\n` +
      `🚚 Acesso: ${tw}\n` +
      `📏 Distância origem → você: ${dist}\n\n` +
      `*Pode atender?* Envie sua proposta no formato:\n` +
      `*R$ <valor> em <previsão em minutos>*\n` +
      `Ex.: *R$ 250 em 20 min*\n\n` +
      `Ou responda *RECUSO* para declinar.`
    );
  }

  _isRefusal(text) {
    if (this._messageLooksLikeQuoteOffer(text)) return false;
    const t = normalizeInboundQuoteText(text).toLowerCase();
    if (/\b(n[ãa]o emito|sem nota|n[ãa]o emite|nfe)\b/.test(t)) return false;
    return (
      /^recuso$|^recusar$|^rejeito$|^rejeitar$|\bnão\b|\bnao consig|\bnao posso|\bindispon[ií]vel\b/.test(t) &&
      !/\br\$|\bvalor|\d{2,}/.test(t)
    );
  }

  _parsePriceAndEta(text) {
    const t = normalizeInboundQuoteText(text).toLowerCase();
    let price = null;
    let etaMinutes = null;

    const priceMatch =
      t.match(/r\$\s*:?\s*([\d.,]+)/) ||
      t.match(/\brs\.?\s*:?\s*([\d.,]+)/) ||
      t.match(/valor\s*:?\s*([\d.,]+)/) ||
      t.match(/\bcobr\w*\s+(?:r\$\s*)?([\d.,]+)/) ||
      t.match(/([\d]{2,5}(?:[.,]\d{1,2})?)\s*(?:reais)\b/);
    if (priceMatch) {
      const n = parseFloat(String(priceMatch[1]).replace(/\./g, "").replace(",", "."));
      if (Number.isFinite(n) && n >= 1) price = n;
    }

    const combined = t.match(/([\d]{2,5}(?:[.,]\d{1,2})?)\s+em\s*(\d{1,3})\s*(?:min|minutos|m\b)?/i);
    if (combined) {
      const pv = parseFloat(combined[1].replace(/\./g, "").replace(",", "."));
      const ev = parseInt(combined[2], 10);
      if (price == null && Number.isFinite(pv) && pv >= 1) price = pv;
      if (etaMinutes == null && Number.isFinite(ev) && ev > 0) etaMinutes = ev;
    }

    if (etaMinutes == null) {
      const etaMatch =
        t.match(/(\d{1,3})\s*(?:min|minutos|'|m\b)/) ||
        t.match(/\bem\s*(\d{1,3})\s*(?:min|minutos|m\b)/) ||
        t.match(/\bem\s+(\d{1,3})\b/) ||
        t.match(/tempo\s*:?\s*(\d{1,3})/);
      if (etaMatch) {
        const n = parseInt(etaMatch[1], 10);
        if (Number.isFinite(n) && n > 0) etaMinutes = n;
      }
    }

    const hourMatch = t.match(/(\d+)\s*h(?:ora)?s?/);
    if (hourMatch && etaMinutes == null) {
      const h = parseInt(hourMatch[1], 10);
      if (Number.isFinite(h)) etaMinutes = h * 60;
    }

    return { price, etaMinutes };
  }

  _normPhone(p) {
    return String(p || "").replace(/\D/g, "");
  }

  /** Chave única para casar cliente do ticket com mensagens inbound (DDI BR + 9º dígito). */
  _normClientKey(phoneRaw) {
    const raw = String(phoneRaw || "").trim();
    if (!raw) return "";
    if (/^web[_-]/i.test(raw)) return raw;
    return resolveMessageThreadKey(raw) || this._normPhone(raw);
  }

  /** Número BR: adiciona 55 se vier com DDD sem país (espelho de cotação para testes). */
  _normMirrorPhone(raw) {
    let d = String(raw || "").replace(/\D/g, "");
    if (!d) return "";
    if (d.length <= 11 && !d.startsWith("55")) d = `55${d}`;
    return d;
  }

  async _mirrorQuoteMessageIfConfigured(providerPhone, message) {
    const mirror = this._normMirrorPhone(process.env.QUOTE_MIRROR_WHATSAPP || process.env.TEST_QUOTE_NOTIFY_PHONE || "");
    if (!mirror) return;
    const prov = this._normPhone(providerPhone);
    if (mirror === prov) return;
    try {
      await this.sendMessage(mirror, `[Espelho cotação]\n${message}`, { force: true });
    } catch (err) {
      logger.warn({ err }, "Falha ao enviar espelho de cotação");
    }
  }

  _emitQuoteUpdate(state, provider, price, etaMinutes, status, extra = {}) {
    try {
      this.io.emit("quotes:update", {
        roundId: state.roundId,
        attendanceId: state.ticket.attendanceId,
        serviceId: state.ticket.serviceId,
        provider: {
          id: provider.id,
          name: provider.name,
          phone: provider.whatsapp || provider.phone,
        },
        price,
        etaMinutes,
        status,
        ...extra,
      });
    } catch {}
  }

  hasActiveRoundForPhone(providerPhone) {
    for (const state of this.activeRounds.values()) {
      if (state.finalized) continue;
      if (this._findProviderMetaForInbound(state, providerPhone, null)) return true;
    }
    return false;
  }

  hasActiveRoundForClient(clientPhone) {
    const isWebSession = /^web[_-]/i.test(String(clientPhone || ""));
    const norm = this._normClientKey(clientPhone);
    // Verifica diretamente no mapa
    if (this.clientConfirmByPhone.has(norm)) return true;
    if (this.clientConfirmByPhone.has(this._normPhone(clientPhone))) return true;
    // Para sessão web, verificar pelo telefone do ticket em cada round
    if (isWebSession) {
      for (const state of this.activeRounds.values()) {
        if (state.finalized || !state.awaitingClientConfirm) continue;
        const ticketPhone = this._normClientKey(state.ticket.phoneNumber);
        if (ticketPhone && this._normPhone(clientPhone).endsWith(this._normPhone(ticketPhone).slice(-8))) {
          return true;
        }
      }
    }
    return false;
  }
}

/**
 * Busca os N prestadores mais próximos no banco local (SQLite).
 * Ordena por haversine entre o ponto de origem e provider(lat,lng).
 */
export function findNearestProviders(db, { lat, lng, serviceType, limit = 5 }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  let rows = [];
  try {
    rows = db.prepare(
      "SELECT id, name, phone, whatsapp, services, latitude, longitude, price_base, price_per_km, COALESCE(is_test, 0) AS is_test FROM providers WHERE active = 1 AND available = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL"
    ).all();
  } catch {
    return [];
  }
  const scored = rows
    .filter((r) => {
      if (!serviceType) return true;
      const csv = String(r.services || "").toLowerCase().trim();
      if (!csv) return true;
      return csv.includes(String(serviceType).toLowerCase());
    })
    .map((r) => ({
      ...r,
      distance_km: haversineKm({ lat, lng }, { lat: r.latitude, lng: r.longitude }),
    }))
    .filter((r) => r.distance_km != null)
    .sort((a, b) => {
      // Prestadores reais primeiro; de teste só preenchem se faltar opção próxima.
      const pa = Number(a.is_test) === 1 ? 1 : 0;
      const pb = Number(b.is_test) === 1 ? 1 : 0;
      if (pa !== pb) return pa - pb;
      return a.distance_km - b.distance_km;
    })
    .slice(0, limit);
  return scored;
}
