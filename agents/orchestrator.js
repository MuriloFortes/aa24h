import { v4 as uuidv4 } from "uuid";
import { logger } from "../lib/logger.js";
import { conversationManager, STATES } from "./conversationFlow.js";
import { requiresTowingAccessForProblem } from "./attendant.js";
import { normalizeBrazilianPlate } from "../lib/plate.js";
import { Dispatcher } from "./dispatcher.js";
import { verifyVehicleActiveInSga, SGA_CLIENT_MSG } from "../services/sgaVehicle.js";
import {
  calculateDistanceDebug,
  geocodeAddressDebug,
  keywordForServiceType,
  searchNearbyTowProvidersDebug,
} from "../lib/distance.js";
import { QuotesEngine, findNearestProviders } from "../services/quotesEngine.js";
import { fetchPlaceDetails } from "../services/providers.js";
import {
  buildGoogleMapsManualSearchLinks,
  coerceLatLng,
  extractLatLngFromText,
} from "../lib/locationParse.js";
import { resolveMessageThreadKey, phonesMatchForBrazilQuote } from "../lib/phoneCanonical.js";

class Orchestrator {
  constructor(db, io, sendMessage, opts = {}) {
    this.db = db;
    this.io = io;
    this.sendMessage = sendMessage;
    this.getBusinessRules = opts.getBusinessRules || (() => ({}));
    this.generateProtocol = typeof opts.generateProtocol === "function" ? opts.generateProtocol : null;
    this.getSetting =
      typeof opts.getSetting === "function" ? opts.getSetting : (k, d) => this._getSetting(k, d);
    this.notifyGestor = typeof opts.notifyGestor === "function" ? opts.notifyGestor : null;
    this.mergeAttendanceNotes =
      typeof opts.mergeAttendanceNotes === "function" ? opts.mergeAttendanceNotes : null;
    this.appendGestorMedia = typeof opts.appendGestorMedia === "function" ? opts.appendGestorMedia : null;
    this.dispatcher = new Dispatcher(db, io, sendMessage);
    this.quotesEngine = new QuotesEngine(db, io, sendMessage, this.getBusinessRules, {
      getSetting: (k, d) => this.getSetting(k, d),
      notifyGestor: (msg) => (this.notifyGestor ? this.notifyGestor(msg) : Promise.resolve()),
      mergeAttendanceNotes: (id, patch) => this.mergeAttendanceNotes?.(id, patch),
    });

    this._setupEventListeners();
  }

  _setupEventListeners() {
    this.io.on("connection", (socket) => {
      socket.on("dispatch:manual", async (data) => {
        try {
          await this.dispatcher.dispatch(data);
        } catch (err) {
          logger.error({ err }, "Erro ao despachar manualmente");
        }
      });
    });
  }

  async createTicketFromConversation(phoneNumber, ticketData) {
    const raw = String(phoneNumber || "").trim();
    const callerKey = /^web[_-]/i.test(raw) ? raw : resolveMessageThreadKey(raw) || raw.replace(/\D/g, "") || raw;
    const session = conversationManager.getSession(callerKey);
    if (!session) {
      logger.warn({ phone: phoneNumber, callerKey }, "Sessão não encontrada ao criar ticket");
      return null;
    }

    const attendanceId = uuidv4();
    const serviceId = uuidv4();
    let protocol = null;
    try {
      protocol = this.generateProtocol ? this.generateProtocol() : null;
    } catch (err) {
      logger.warn({ err: err?.message }, "Falha ao gerar protocolo — seguindo sem ele");
    }

    const problemToServiceType = {
      pane_mecanica: "reboque",
      pane_eletrica: "reboque",
      pneu_furado: "troca_pneu",
      acidente: "reboque",
      sem_combustivel: "combustivel",
      chave_trancada: "chaveiro",
      bateria_descarregada: "carga_bateria",
      reboque: "reboque",
      outro: "reboque",
    };

    const serviceType = problemToServiceType[ticketData.problem_type] || "reboque";

    const channel = ticketData.channel || "whatsapp";

    const plateNorm = normalizeBrazilianPlate(ticketData.vehicle_plate) || null;

    const locationText =
      String(session.collectedData?.location || "").trim() ||
      String(ticketData.location || "").trim() ||
      "";

    let locationLat =
      session.collectedData.location_lat ?? ticketData.location_lat ?? null;
    let locationLng =
      session.collectedData.location_lng ?? ticketData.location_lng ?? null;
    const coordsFromSession = coerceLatLng(locationLat, locationLng);
    if (coordsFromSession) {
      locationLat = coordsFromSession.lat;
      locationLng = coordsFromSession.lng;
    } else {
      const fromText = extractLatLngFromText(locationText);
      if (fromText) {
        locationLat = fromText.lat;
        locationLng = fromText.lng;
      }
    }

    const notesData = {
      schedule_type: ticketData.schedule_type || session.collectedData.schedule_type || "agora",
      location: locationText,
      destination: ticketData.destination || session.collectedData.destination || "",
      vehicle_type: ticketData.vehicle_type,
      problem_type: ticketData.problem_type,
      channel,
      location_lat: locationLat,
      location_lng: locationLng,
      towing_access: ticketData.towing_access ?? session.collectedData.towing_access,
      vehicle_plate: plateNorm,
      location_text: locationText,
      customer_phone: callerKey,
      receiver_info: ticketData.receiver_info || session.collectedData.receiver_info || "",
      ride_along: ticketData.ride_along || session.collectedData.ride_along || "",
      billing_mode: ticketData.billing_mode || "associate",
      sga_vehicle_reason: ticketData.sga_vehicle_reason || null,
      workflow_phase: "open",
    };

    const serviceNotesJson = JSON.stringify(notesData);

    const limitCheck =
      notesData.billing_mode === "prepay_non_associate"
        ? { blocked: false }
        : this._checkBusinessRulesLimit(callerKey, serviceType);
    if (limitCheck && limitCheck.blocked) {
      this._dbRun(
        `INSERT INTO attendances (id, protocol, caller_id, customer_name, vehicle_plate, service_type, status, location, vehicle_type, problem_type, notes, destination_address, block_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [
          attendanceId,
          protocol,
          callerKey,
          ticketData.customer_name,
          plateNorm,
          serviceType,
          locationText,
          ticketData.vehicle_type || null,
          ticketData.problem_type || null,
          JSON.stringify(notesData),
          notesData.destination || null,
          limitCheck.reason,
        ]
      );
      try {
        await this.sendMessage(
          callerKey,
          `⚠️ Não foi possível abrir um novo chamado: ${limitCheck.clientMsg}\nEntre em contato com a central para mais informações.`
        );
      } catch {}
      try {
        this.io.emit("attendance:blocked", {
          attendanceId,
          phoneNumber: callerKey,
          customerName: ticketData.customer_name,
          serviceType,
          reason: limitCheck.reason,
        });
      } catch {}
      logger.warn({ phone: callerKey, serviceType, reason: limitCheck.reason }, "Chamado bloqueado por regra de negócio");
      return { blocked: true, reason: limitCheck.reason, clientMsg: limitCheck.clientMsg };
    }

    this._dbRun(
      `INSERT INTO attendances (id, protocol, caller_id, customer_name, vehicle_plate, service_type, status, location, vehicle_type, problem_type, notes, destination_address, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
      [
        attendanceId,
        protocol,
        callerKey,
        ticketData.customer_name,
        plateNorm,
        serviceType,
        locationText,
        ticketData.vehicle_type || null,
        ticketData.problem_type || null,
        JSON.stringify(notesData),
        notesData.destination || null,
      ]
    );

    this._dbRun(
      `INSERT INTO services (id, attendance_id, plate, service_type, customer_name, customer_phone, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now'), datetime('now'))`,
      [
        serviceId,
        attendanceId,
        plateNorm,
        serviceType,
        ticketData.customer_name,
        callerKey,
        serviceNotesJson,
      ]
    );

    const conversationLogs = conversationManager.getMessageHistory(callerKey);
    for (let i = 0; i < conversationLogs.length; i++) {
      const msg = conversationLogs[i];
      this._dbRun(
        "INSERT INTO attendance_logs (attendance_id, step, question, answer) VALUES (?, ?, ?, ?)",
        [
          attendanceId,
          `message_${i + 1}`,
          msg.role === "user" ? msg.content : null,
          msg.role === "assistant" ? msg.content : null,
        ]
      );
    }

    this._dbRun(
      "INSERT INTO audit_logs (event_type, entity_type, entity_id, data) VALUES ('ticket_created', 'attendance', ?, ?)",
      [attendanceId, JSON.stringify(notesData)]
    );

    session.attendanceId = attendanceId;
    session.serviceId = serviceId;

    const ticket = {
      attendanceId,
      protocol,
      serviceId,
      phoneNumber: callerKey,
      customerName: ticketData.customer_name,
      vehiclePlate: plateNorm || ticketData.vehicle_plate,
      vehicleType: ticketData.vehicle_type,
      location: locationText,
      destination: notesData.destination,
      locationLat: locationLat,
      locationLng: locationLng,
      problemType: ticketData.problem_type,
      scheduleType: notesData.schedule_type,
      towingAccess: ticketData.towing_access ?? session.collectedData.towing_access,
      receiverInfo: notesData.receiver_info,
      rideAlong: notesData.ride_along,
      serviceType,
      channel,
      createdAt: new Date().toISOString(),
      broadcastProvidersNotified: false,
    };

    let attendanceRow = null;
    try {
      if (this.db.prepare) {
        attendanceRow = this.db.prepare("SELECT * FROM attendances WHERE id = ?").get(attendanceId);
      }
    } catch (e) {
      logger.warn({ e }, "Não foi possível ler attendance após insert");
    }

    ticket.broadcastProvidersNotified = false;
    ticket.broadcastSentCount = 0;

    await this._computeDistanceAndPlan(ticket).catch((err) =>
      logger.warn({ err, attendanceId: ticket.attendanceId }, "Falha ao calcular distância/plano")
    );

    this.io.emit("ticket:created", ticket);
    if (attendanceRow) {
      try {
        attendanceRow = this.db.prepare("SELECT * FROM attendances WHERE id = ?").get(attendanceId) || attendanceRow;
      } catch {
        /* ignore */
      }
      this.io.emit("attendance:created", attendanceRow);
    }
    logger.info({ attendanceId, serviceId, phone: callerKey }, "Ticket criado com sucesso");

    try {
      if (this.notifyGestor) {
        const protocolLabel = ticket.protocol || ticket.attendanceId.slice(0, 8).toUpperCase();
        if (notesData.billing_mode === "prepay_non_associate") {
          await this.notifyGestor(
            `🆕 *Atendimento aberto*\n` +
              `Protocolo: ${protocolLabel}\n` +
              `Cliente: ${ticketData.customer_name}\n` +
              `Placa: ${plateNorm || "—"}\n` +
              `Serviço: ${serviceType}\n` +
              `Local: ${locationText}\n` +
              `⚠️ *Não associado* (veículo não localizado na proteção veicular).\n` +
              `Haverá cobrança antecipada; *chave PIX e valor final* serão enviados ao cliente após o encerramento das cotações.\n`
          );
        } else {
          await this.notifyGestor(
            `🆕 *Atendimento aberto*\n` +
              `Protocolo: ${protocolLabel}\n` +
              `Cliente: ${ticketData.customer_name}\n` +
              `Placa: ${plateNorm || "—"}\n` +
              `Serviço: ${serviceType}\n` +
              `Local: ${locationText}\n`
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "notifyGestor (abertura) falhou");
    }

    this._startQuoteRound(ticket).catch((err) =>
      logger.warn({ err, attendanceId: ticket.attendanceId }, "Falha ao iniciar cotação com prestadores")
    );

    return ticket;
  }

  _mergeGoogleDebug(attendanceId, patch) {
    if (!attendanceId || !this.db.prepare) return;
    let cur = {};
    try {
      const row = this.db.prepare("SELECT google_debug_json FROM attendances WHERE id = ?").get(attendanceId);
      if (row?.google_debug_json) cur = JSON.parse(row.google_debug_json);
    } catch {}
    const next = { ...cur, ...patch, lastUpdatedAt: new Date().toISOString() };
    this._dbRun("UPDATE attendances SET google_debug_json = ? WHERE id = ?", [
      JSON.stringify(next),
      attendanceId,
    ]);
  }

  async _computeDistanceAndPlan(ticket) {
    const rules = this.getBusinessRules?.() || {};
    const plans = rules.plans || {};
    const defaultPlan = plans.default_plan || "basic";
    const maxKm = Number(plans?.[defaultPlan]?.max_km ?? plans?.basic?.max_km ?? 100);
    const pricePerKmExcess = Number(plans?.price_per_km_excess ?? 5);

    let originPoint = null;
    let destPoint = null;
    const geoDebug = { origin: null, destination: null };

    const originDirect = coerceLatLng(ticket.locationLat, ticket.locationLng);
    if (originDirect) {
      originPoint = originDirect;
      geoDebug.origin = { from: "session_or_db", coords: originDirect };
    } else if (ticket.location) {
      const fromText = extractLatLngFromText(String(ticket.location));
      if (fromText) {
        originPoint = fromText;
        geoDebug.origin = { from: "parsed_whatsapp_location", coords: fromText, input: String(ticket.location).slice(0, 200) };
      } else {
        const og = await geocodeAddressDebug(ticket.location);
        originPoint = og.coords;
        geoDebug.origin = og.debug;
      }
    }

    if (originPoint) {
      ticket.locationLat = originPoint.lat;
      ticket.locationLng = originPoint.lng;
      try {
        const row = this._dbGet?.("SELECT notes FROM attendances WHERE id = ?", [ticket.attendanceId]);
        let notesObj = {};
        if (row?.notes) {
          try {
            notesObj = JSON.parse(row.notes) || {};
          } catch {
            notesObj = {};
          }
        }
        notesObj.location_lat = originPoint.lat;
        notesObj.location_lng = originPoint.lng;
        this._dbRun("UPDATE attendances SET notes = ? WHERE id = ?", [JSON.stringify(notesObj), ticket.attendanceId]);
        this._dbRun("UPDATE services SET notes = ? WHERE attendance_id = ?", [JSON.stringify(notesObj), ticket.attendanceId]);
      } catch {
        /* ignore */
      }
    }

    if (ticket.destination) {
      const destText = String(ticket.destination);
      const destParsed = extractLatLngFromText(destText);
      if (destParsed) {
        destPoint = destParsed;
        geoDebug.destination = {
          from: "parsed_coords",
          coords: destParsed,
          input: destText.slice(0, 200),
        };
      } else {
        const dg = await geocodeAddressDebug(destText);
        destPoint = dg.coords;
        geoDebug.destination = dg.debug;
      }
    }

    this._mergeGoogleDebug(ticket.attendanceId, { geocoding: geoDebug, serviceType: ticket.serviceType });

    if (!originPoint || !destPoint) {
      logger.info({ attendanceId: ticket.attendanceId }, "Dist\u00e2ncia n\u00e3o calculada (sem coordenadas suficientes)");
      this._mergeGoogleDebug(ticket.attendanceId, {
        distanceMatrix: { skipped: true, reason: "origem ou destino sem coordenadas" },
      });
      return null;
    }

    const distRes = await calculateDistanceDebug({ origin: originPoint, destination: destPoint });
    const { km, durationMin, source } = distRes;
    if (km == null) {
      this._mergeGoogleDebug(ticket.attendanceId, { distanceMatrix: distRes.debug || distRes });
      return null;
    }

    const excessKm = Math.max(0, km - maxKm);
    const excessCharge = excessKm * pricePerKmExcess;

    this._mergeGoogleDebug(ticket.attendanceId, {
      distanceMatrix: {
        ...(distRes.debug || {}),
        km,
        durationMin,
        source,
        plan: defaultPlan,
        maxKm,
        excessKm,
        excessCharge,
      },
    });

    this._dbRun(
      `UPDATE attendances SET
         distance_km = ?, duration_min = ?, plan_used = ?, plan_max_km = ?,
         excess_km = ?, excess_charge = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [km, durationMin, defaultPlan, maxKm, excessKm, excessCharge, ticket.attendanceId]
    );

    try {
      this.io.emit("attendance:distance_calculated", {
        attendanceId: ticket.attendanceId,
        distanceKm: km,
        durationMin,
        plan: defaultPlan,
        planMaxKm: maxKm,
        excessKm,
        excessCharge,
        source,
      });
    } catch {}

    if (excessKm > 0) {
      try {
        await this.sendMessage(
          ticket.phoneNumber,
          `ℹ️ A distância do trajeto é de *${km.toFixed(1)} km*. O plano *${defaultPlan}* cobre até ${maxKm} km.\n` +
            `Valor adicional estimado: *R$ ${excessCharge.toFixed(2)}* (${excessKm.toFixed(1)} km × R$ ${pricePerKmExcess.toFixed(2)}).\n` +
            `Em seguida enviaremos a confirmação com o valor total do prestador.`
        );
      } catch (err) {
        logger.warn({ err }, "Falha ao notificar cliente sobre km excedente");
      }
    }

    return { km, durationMin, excessKm, excessCharge, plan: defaultPlan };
  }

  async _startQuoteRound(ticket) {
    let latlng = coerceLatLng(ticket.locationLat, ticket.locationLng);
    if (!latlng) latlng = extractLatLngFromText(String(ticket.location || ""));
    if (!latlng && ticket.location) {
      const og = await geocodeAddressDebug(String(ticket.location));
      if (og?.coords) {
        latlng = og.coords;
        ticket.locationLat = og.coords.lat;
        ticket.locationLng = og.coords.lng;
        this._mergeGoogleDebug(ticket.attendanceId, {
          geocodingLateResolved: { ...og.debug, source: "_startQuoteRound" },
        });
        try {
          const row = this._dbGet?.("SELECT notes FROM attendances WHERE id = ?", [ticket.attendanceId]);
          let notesObj = {};
          if (row?.notes) {
            try {
              notesObj = JSON.parse(row.notes) || {};
            } catch {
              notesObj = {};
            }
          }
          notesObj.location_lat = og.coords.lat;
          notesObj.location_lng = og.coords.lng;
          this._dbRun("UPDATE attendances SET notes = ? WHERE id = ?", [JSON.stringify(notesObj), ticket.attendanceId]);
          this._dbRun("UPDATE services SET notes = ? WHERE attendance_id = ?", [JSON.stringify(notesObj), ticket.attendanceId]);
        } catch {
          /* ignore */
        }
      }
    }
    if (!latlng) {
      logger.info({ attendanceId: ticket.attendanceId }, "Sem coordenadas para iniciar round de cotação");
      try {
        await this.sendMessage(
          ticket.phoneNumber,
          "⚠️ Não conseguimos localizar as coordenadas do endereço informado. Envie sua *localização pelo WhatsApp* (clipe → Localização) ou digite o endereço mais detalhado."
        );
      } catch {
        /* ignore */
      }
      return;
    }
    const { lat, lng } = latlng;
    const rules = this.getBusinessRules?.() || {};
    const rawMp = Number(rules?.scoring?.max_providers ?? 5);
    const maxProviders = Math.min(5, Math.max(1, Number.isFinite(rawMp) ? rawMp : 5));
    const placesKeyword = keywordForServiceType(ticket.serviceType);

    this._mergeGoogleDebug(ticket.attendanceId, {
      resolved_coordinates: { lat, lng, note: "coordenadas da sessão ou extraídas do texto [Localização: lat, lng]" },
      manual_maps_search: buildGoogleMapsManualSearchLinks(lat, lng, [
        placesKeyword,
        "reboque guincho",
        "auto socorro 24 horas",
        "guincho",
      ]),
      google_api_hint:
        "REQUEST_DENIED ou sem chave: no Google Cloud ative faturamento e as APIs Places, Geocoding e Distance Matrix; confira restrições da chave (IP/referrer). Enquanto isso use os links manuais do Maps abaixo.",
    });

    let providers = findNearestProviders(this.db, {
      lat,
      lng,
      serviceType: ticket.serviceType,
      limit: maxProviders,
    });

    const placeDetailsFetched = [];

    if (providers.length < maxProviders && process.env.GOOGLE_MAPS_API_KEY) {
      const missing = maxProviders - providers.length;
      try {
        const { results: external, debug: nearbyDebug } = await searchNearbyTowProvidersDebug({
          lat,
          lng,
          radiusMeters: 20000,
          keyword: placesKeyword,
        });
        this._mergeGoogleDebug(ticket.attendanceId, {
          placesNearbySearch: { ...nearbyDebug, keywordUsed: placesKeyword },
        });
        const existingPlaceIds = new Set(providers.map((p) => p.place_id).filter(Boolean));
        const candidates = external.filter((e) => e.placeId && !existingPlaceIds.has(e.placeId)).slice(0, missing);
        for (const ext of candidates) {
          const details = await fetchPlaceDetails(ext.placeId);
          placeDetailsFetched.push({
            placeId: ext.placeId,
            name: details?.name || ext.name,
            phone: details?.phone || null,
            address: details?.address || null,
          });
          if (!details?.phone) continue;
          providers.push({
            id: null,
            name: details.name || ext.name,
            phone: details.phone,
            whatsapp: details.phone,
            latitude: details.location?.lat ?? ext.location?.lat,
            longitude: details.location?.lng ?? ext.location?.lng,
            address_text: details.address || ext.vicinity,
            distance_km: ext.distance_km,
            placeId: ext.placeId,
            photoReference: details.photoReference,
            external: true,
          });
        }
        this._mergeGoogleDebug(ticket.attendanceId, { placesDetailsSample: placeDetailsFetched });
      } catch (err) {
        logger.warn({ err: err?.message }, "Falha ao complementar com Google Places");
        this._mergeGoogleDebug(ticket.attendanceId, {
          placesNearbySearch: { error: err?.message, keywordUsed: placesKeyword },
        });
      }
    }

    if (providers.length === 0) {
      logger.warn({ attendanceId: ticket.attendanceId }, "Nenhum prestador próximo para cotação");
      try {
        await this._notifyClientNoProviders(ticket.phoneNumber);
      } catch {}
      return;
    }
    await this.quotesEngine.startRound(ticket, providers.slice(0, maxProviders));
  }

  async _startDispatch(ticket) {
    try {
      logger.info({ attendanceId: ticket.attendanceId }, "Iniciando despacho automático");
      const result = await this.dispatcher.dispatch(ticket);
      const broadcastOk = Number(ticket.broadcastSentCount || 0) > 0;
      if (!result && !broadcastOk) {
        await this._notifyClientNoProviders(ticket.phoneNumber);
      }
    } catch (err) {
      logger.error({ err, attendanceId: ticket.attendanceId }, "Erro no despacho automático");
    }
  }

  _buildBroadcastMessage(ticket) {
    const PROBLEM_LABELS = {
      pane_mecanica: "pane mecânica", pane_eletrica: "pane elétrica",
      pneu_furado: "pneu furado", acidente: "acidente",
      sem_combustivel: "sem combustível", chave_trancada: "chave trancada",
      bateria_descarregada: "bateria descarregada", reboque: "reboque", outro: "outro",
    };
    const prob = PROBLEM_LABELS[ticket.problemType] || ticket.problemType || ticket.serviceType || "—";
    const twMap = { facil: "Fácil acesso", dificil: "Acesso difícil / com ressalva", bloqueado: "Bloqueado" };
    const tw = twMap[ticket.towingAccess] || "Não informado";
    const sched = ticket.scheduleType === "agendado" ? "Agendado" : "Imediato";
    const sid = ticket.protocol
      || (ticket.serviceId ? String(ticket.serviceId).slice(0, 8).toUpperCase() : "");

    return (
      `🔔 *Novo Serviço Disponível!*\n\n` +
      `📋 Ref: ${sid}\n` +
      `⏱️ *Quando:* ${sched}\n` +
      `🔧 *Serviço:* ${prob}\n` +
      `🚗 *Veículo:* ${ticket.vehicleType || "—"} — Placa ${ticket.vehiclePlate || "—"}\n` +
      `📍 *Origem:* ${ticket.location || "—"}\n` +
      `📍 *Destino:* ${ticket.destination || "—"}\n` +
      `🚚 *Acesso ao veículo:* ${tw}\n\n` +
      `Para atender, informe:\n` +
      `💰 *Valor do serviço* (ex.: "150" ou "R$ 200")\n` +
      `⏱️ *Previsão de chegada* (ex.: "30 min" ou "1 hora")\n\n` +
      `Responda com valor e tempo. Ex.: *150 reais, 30 minutos*\n` +
      `Ou responda *RECUSO* se não puder atender.`
    );
  }

  _providerMatchesServiceType(provider, serviceType) {
    if (!serviceType) return true;
    const csv = String(provider.services || "").toLowerCase().trim();
    if (!csv) return true;
    return csv.includes(serviceType.toLowerCase());
  }

  async broadcastServiceOpportunityToProviders(ticket) {
    let rows = [];
    try {
      rows = this.db.prepare("SELECT id, name, phone, whatsapp, services FROM providers WHERE active = 1").all();
    } catch (e) {
      logger.warn({ e }, "list providers");
      return 0;
    }
    const msg = this._buildBroadcastMessage(ticket);
    let sent = 0;
    for (const p of rows) {
      if (!this._providerMatchesServiceType(p, ticket.serviceType)) {
        logger.info({ providerId: p.id, providerServices: p.services, needed: ticket.serviceType }, "Prestador não atende este tipo de serviço, pulando");
        continue;
      }
      const phone = p.whatsapp || p.phone;
      if (!phone) continue;
      try {
        await this.sendMessage(phone, msg);
        this._trackProviderBroadcast(ticket.serviceId, p.id, phone);
        sent++;
        logger.info({ providerId: p.id, phone }, "Broadcast enviado ao prestador");
      } catch (err) {
        logger.error({ err, providerId: p.id }, "Falha ao notificar prestador");
      }
    }
    logger.info({ serviceId: ticket.serviceId, sent, total: rows.length }, "Broadcast de oportunidade aos prestadores");
    return sent;
  }

  _trackProviderBroadcast(serviceId, providerId, phone) {
    if (!this._broadcastedProviders) this._broadcastedProviders = new Map();
    if (!this._broadcastedProviders.has(serviceId)) this._broadcastedProviders.set(serviceId, []);
    this._broadcastedProviders.get(serviceId).push({
      providerId,
      phone: phone.replace(/\D/g, ""),
      phoneCanon: resolveMessageThreadKey(phone) || phone.replace(/\D/g, ""),
      contactedAt: Date.now(),
    });
  }

  _findBroadcastServiceForProvider(providerPhone) {
    if (!this._broadcastedProviders) return null;
    const norm = String(providerPhone || "").replace(/\D/g, "");
    const ask = resolveMessageThreadKey(providerPhone) || norm;
    for (const [serviceId, providers] of this._broadcastedProviders) {
      for (const p of providers) {
        if (p.phoneCanon && ask && p.phoneCanon === ask) return serviceId;
        if (p.phone === norm) return serviceId;
        if (phonesMatchForBrazilQuote(providerPhone, p.phoneCanon || p.phone)) return serviceId;
      }
    }
    return null;
  }

  async _notifyClientNoProviders(phoneNumber) {
    try {
      await this.sendMessage(
        phoneNumber,
        "⚠️ No momento não encontramos prestadores disponíveis na sua região. " +
        "Estamos expandindo a busca e entraremos em contato assim que localizarmos um prestador. " +
        "Fique tranquilo, não vamos desistir!"
      );
    } catch (err) {
      logger.error({ err }, "Erro ao notificar cliente sobre falta de prestadores");
    }
  }

  _getSetting(key, defaultValue = "") {
    try {
      const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
      return row?.value ?? defaultValue;
    } catch {
      return defaultValue;
    }
  }

  /**
   * Validação legada por telefone em `sga_associates` (opcional, além da API de veículo).
   */
  checkSgaAssociateActive(phoneNumber) {
    const validate =
      process.env.SGA_VALIDATE_ASSOCIATES === "true" || this._getSetting("sga_validate_associates") === "true";
    if (!validate) return { ok: true };

    /** Chat web usa id fictício web_* — não há linha em sga_associates; não bloquear por telefone. */
    if (/^web[_-]/i.test(String(phoneNumber || ""))) {
      return { ok: true };
    }

    const normalized = String(phoneNumber).replace(/\D/g, "");
    if (!normalized) {
      return {
        ok: false,
        message:
          "⚠️ Não foi possível validar o associado no SGA. Entre em contato com a central.",
      };
    }

    try {
      const row = this.db.prepare("SELECT active FROM sga_associates WHERE phone = ?").get(normalized);
      if (row && Number(row.active) === 1) return { ok: true };
    } catch {
      return { ok: true };
    }

    return {
      ok: false,
      message:
        "⚠️ Não localizamos um *associado ativo* no sistema SGA com este telefone. " +
        "Confirme seu cadastro ou fale com a central para ativar o benefício antes de registrar o chamado.",
    };
  }

  async handleConfirmation(phoneNumber, confirmed, options = {}) {
    const session = conversationManager.getSession(phoneNumber);
    if (!session || session.state !== STATES.CONFIRMING_DATA) {
      return null;
    }

    if (confirmed) {
      const plate =
        normalizeBrazilianPlate(session.collectedData.vehicle_plate) || session.collectedData.vehicle_plate || "";
      const sgaVehicle = await verifyVehicleActiveInSga(plate, phoneNumber);

      if (!sgaVehicle.ok && !sgaVehicle.skipped) {
        // Veículo não encontrado na base: sempre seguir com pré-pagamento (regra de negócio).
        // O toggle allow_non_associate_service no painel não deve bloquear este caso.
        if (sgaVehicle.reason === "not_found") {
          conversationManager.updateCollectedData(phoneNumber, {
            billing_mode: "prepay_non_associate",
            sga_vehicle_reason: "not_found",
          });
          try {
            this.io.emit("sga:verification_failed", {
              reason: "not_found_non_associate",
              plate,
              customerName: session.collectedData.customer_name,
              phone: phoneNumber,
              clientMessage:
                "ℹ️ Não localizamos o veículo na proteção veicular. Podemos seguir com o atendimento *mediante pagamento antecipado* antes da solicitação ao prestador.",
              panelDetail: "Fluxo não associado (pagamento antecipado).",
              at: new Date().toISOString(),
            });
          } catch (e) {
            logger.warn({ e }, "emit sga:verification_failed");
          }
        } else {
          const clientMsg = sgaVehicle.clientMessage || SGA_CLIENT_MSG.error;
          const panelDetail =
            sgaVehicle.reason === "inactive"
              ? "O veículo está inativo na proteção veicular. Informe o cliente para contatar a associação."
              : sgaVehicle.reason === "not_found"
                ? "Veículo não encontrado na base da proteção veicular."
                : sgaVehicle.reason === "not_configured"
                  ? "API SGA não configurada no servidor (defina SGA_API_BASE_URL ou SGA_SKIP_VEHICLE_VERIFY=true em desenvolvimento)."
                  : "Falha ao consultar a proteção veicular.";

          try {
            this.io.emit("sga:verification_failed", {
              reason: sgaVehicle.reason,
              plate,
              customerName: session.collectedData.customer_name,
              phone: phoneNumber,
              clientMessage: clientMsg,
              panelDetail,
              at: new Date().toISOString(),
            });
          } catch (e) {
            logger.warn({ e }, "emit sga:verification_failed");
          }

          conversationManager.clearConfirmationFlags(phoneNumber);
          conversationManager.updateState(phoneNumber, STATES.CONFIRMING_DATA);
          if (!options.skipSendMessage) {
            try {
              await this.sendMessage(phoneNumber, clientMsg);
            } catch (err) {
              logger.error({ err }, "Erro ao enviar recusa SGA veículo");
            }
          }
          return { blocked: true, sgaMessage: clientMsg, sgaReason: sgaVehicle.reason };
        }
      }

      const sessionAfterSga = conversationManager.getSession(phoneNumber);
      const prepayNonAssociate =
        sessionAfterSga?.collectedData?.billing_mode === "prepay_non_associate";
      const sgaPhone = prepayNonAssociate
        ? { ok: true }
        : this.checkSgaAssociateActive(phoneNumber);
      if (!sgaPhone.ok) {
        try {
          this.io.emit("sga:verification_failed", {
            reason: "associate_phone",
            plate,
            customerName: session.collectedData.customer_name,
            phone: phoneNumber,
            clientMessage: sgaPhone.message,
            panelDetail: "Associado não localizado ou inativo na tabela local (sga_associates).",
            at: new Date().toISOString(),
          });
        } catch (e) {
          logger.warn({ e }, "emit sga associate failed");
        }
        conversationManager.clearConfirmationFlags(phoneNumber);
        conversationManager.updateState(phoneNumber, STATES.CONFIRMING_DATA);
        if (!options.skipSendMessage) {
          try {
            await this.sendMessage(phoneNumber, sgaPhone.message);
          } catch (err) {
            logger.error({ err }, "Erro ao enviar recusa SGA associado");
          }
        }
        return { blocked: true, sgaMessage: sgaPhone.message };
      }

      const sessionForTicket = conversationManager.getSession(phoneNumber);
      const ticket = await this.createTicketFromConversation(
        phoneNumber,
        sessionForTicket?.collectedData || session.collectedData
      );
      conversationManager.clearConfirmationFlags(phoneNumber);
      conversationManager.updateState(phoneNumber, STATES.TICKET_CREATED);

      let routeKmStr = "";
      try {
        const row = this.db.prepare("SELECT distance_km FROM attendances WHERE id = ?").get(ticket.attendanceId);
        const km = row?.distance_km != null ? Number(row.distance_km) : null;
        if (km != null && Number.isFinite(km)) {
          routeKmStr = `📏 Distância do trajeto (origem → destino): *${km.toFixed(1)} km*\n`;
        }
      } catch {
        /* ignore */
      }

      const protocolLabel = ticket.protocol || ticket.attendanceId.slice(0, 8).toUpperCase();
      let confirmMsg =
        `✅ *Chamado Registrado!*\n\n` +
        `📋 Protocolo: ${protocolLabel}\n` +
        `👤 ${ticket.customerName}\n` +
        `📍 Origem: ${ticket.location}\n` +
        `📍 Destino: ${ticket.destination || "—"}\n` +
        routeKmStr +
        `🚗 ${ticket.vehicleType || "—"} — ${ticket.vehiclePlate || ""}\n` +
        `🔧 ${ticket.serviceType}\n\n` +
        `Estamos enviando para os prestadores. Você receberá atualizações aqui.`;
      if (sessionForTicket?.collectedData?.billing_mode === "prepay_non_associate") {
        confirmMsg +=
          `\n\n💳 *Pagamento antecipado:* haverá cobrança conforme o valor definido após as cotações.\n` +
          `A *chave PIX da associação* e o *valor exato a pagar* serão enviados *neste chat assim que as cotações forem finalizadas*.`;
      }

      ticket.confirmMessage = confirmMsg;

      if (!options.skipSendMessage) {
        try {
          await this.sendMessage(phoneNumber, confirmMsg);
        } catch (err) {
          logger.error({ err }, "Erro ao enviar confirmação WhatsApp");
        }
      }

      return ticket;
    }

    conversationManager.clearConfirmationFlags(phoneNumber);
    conversationManager.updateState(phoneNumber, STATES.COLLECTING_INFO);
    return null;
  }

  /**
   * Coleta sem LLM — cada mensagem do bot contém UMA ÚNICA pergunta.
   * O fluxo não depende de contagem de turnos; depende de qual campo está faltando.
   */
  async simulateInboundAttendance(phoneNumber, userMessage) {
    const isWeb = /^web[_-]/i.test(String(phoneNumber));

    const session = conversationManager.getOrCreateSession(phoneNumber);
    conversationManager.addMessage(phoneNumber, "user", userMessage);

    if (session.state === STATES.TICKET_CREATED && session.attendanceId) {
      let label = session.attendanceId.slice(0, 8).toUpperCase();
      try {
        const row = this.db.prepare("SELECT protocol FROM attendances WHERE id = ?").get(session.attendanceId);
        if (row?.protocol) label = row.protocol;
      } catch {
        /* ignore */
      }
      const msg = `ℹ️ Seu chamado *${label}* já está em andamento. Aguarde atualizações por aqui.`;
      return { simulated: true, response: msg, ticket: null };
    }

    if (session.state === STATES.AWAITING_GREETING) {
      conversationManager.updateState(phoneNumber, STATES.COLLECTING_INFO);
      session.simulatePhase = "collecting";
    }

    if (session.state === STATES.COLLECTING_INFO) {
      return { simulated: true, response: "Use o fluxo padrão (processMessage).", ticket: null };
    }

    return {
      simulated: true,
      response: "Envie uma nova mensagem para iniciar o atendimento.",
      ticket: null,
    };
  }

  _captureAnswerByPhase_DEPRECATED(phoneNumber, userMessage) {
    const session = conversationManager.getSession(phoneNumber);
    if (!session) return;
    const d = session.collectedData;
    const t = String(userMessage || "").trim();
    if (!t) return;
    if (false) {
      const ta = this._parseTowingAccess(t);
      conversationManager.updateCollectedData(phoneNumber, { towing_access: ta });
    }
  }

  _parseVehicleAndProblem(text) {
    const t = (text || "").toLowerCase();
    let vehicle_type = "carro";
    if (/\bmoto\b|moto /.test(t)) vehicle_type = "moto";
    else if (/caminh/.test(t)) vehicle_type = "caminhão";
    else if (/\bvan\b/.test(t)) vehicle_type = "van";
    else if (/suv/.test(t)) vehicle_type = "suv";

    let problem_type = "reboque";
    if (/bateria|carga/.test(t)) problem_type = "bateria_descarregada";
    else if (/pneu|calibr/.test(t)) problem_type = "pneu_furado";
    else if (/chave/.test(t)) problem_type = "chave_trancada";
    else if (/combust|gasolina|diesel|gas/.test(t)) problem_type = "sem_combustivel";
    else if (/el[eé]tr|bateria do carro/.test(t)) problem_type = "pane_eletrica";
    else if (/mec[aâ]nic|motor|pane /.test(t)) problem_type = "pane_mecanica";
    else if (/acidente|batida|colis/.test(t)) problem_type = "acidente";
    else if (/passageiro|transporte/.test(t)) problem_type = "outro";

    return { vehicle_type, problem_type };
  }

  _parseTowingAccess(text) {
    const t = String(text || "").toLowerCase();
    if (/bloqueado|imposs[ií]vel|n[aã]o (d[aá]|cons)/.test(t)) return "bloqueado";
    if (/dif[ií]cil|apertad|viela|estreit|garagem fechada/.test(t)) return "dificil";
    if (/f[aá]cil|larga|tranquilo|sem obst|rua larga/.test(t)) return "facil";
    return "facil";
  }

  async _simulateFinalizeTicket(phoneNumber, isWeb) {
    const session = conversationManager.getSession(phoneNumber);
    const lat = parseFloat(process.env.SIMULATE_DEFAULT_LAT || "-23.5505");
    const lng = parseFloat(process.env.SIMULATE_DEFAULT_LNG || "-46.6333");
    conversationManager.updateCollectedData(phoneNumber, {
      location_lat: session.collectedData.location_lat ?? lat,
      location_lng: session.collectedData.location_lng ?? lng,
      channel: isWeb ? "web" : "whatsapp",
    });
    conversationManager.updateState(phoneNumber, STATES.CONFIRMING_DATA);

    const ticket = await this.handleConfirmation(phoneNumber, true, { skipSendMessage: isWeb });
    if (ticket?.blocked) {
      return {
        simulated: true,
        response: ticket.sgaMessage,
        ticket: null,
        state: STATES.COLLECTING_INFO,
      };
    }
    if (!ticket) {
      return {
        simulated: true,
        response: "Não foi possível registrar o chamado de teste. Tente novamente.",
        ticket: null,
      };
    }

    if (isWeb) {
      return { simulated: true, response: ticket.confirmMessage, ticket, state: STATES.TICKET_CREATED };
    }

    return { simulated: true, response: null, ticket, state: STATES.TICKET_CREATED };
  }

  _buildSimulatedTicketData(phone, text, isWeb) {
    const t = (text || "").toLowerCase();
    let problem_type = "reboque";
    if (/bateria|carga/.test(t)) problem_type = "bateria_descarregada";
    else if (/pneu|calibr/.test(t)) problem_type = "pneu_furado";
    else if (/chave/.test(t)) problem_type = "chave_trancada";
    else if (/passageiro|transporte/.test(t)) problem_type = "outro";

    const defaultLat = parseFloat(process.env.SIMULATE_DEFAULT_LAT || "-23.5505");
    const defaultLng = parseFloat(process.env.SIMULATE_DEFAULT_LNG || "-46.6333");

    const last4 = String(phone).replace(/\D/g, "").slice(-4) || "0000";

    return {
      customer_name: isWeb ? "Cliente Web (teste)" : `Cliente ${last4}`,
      location: "Localização simulada — região metropolitana (teste)",
      location_lat: defaultLat,
      location_lng: defaultLng,
      vehicle_type: "carro",
      vehicle_plate: "TST9A99",
      problem_type,
      urgency: /urgente|emerg/.test(t) ? "urgente" : "normal",
      channel: isWeb ? "web" : "whatsapp",
    };
  }

  _digitsOnly(s) {
    return String(s || "").replace(/\D/g, "");
  }

  _looksLikePixKey(text) {
    const t = String(text || "").trim();
    if (t.length < 5 || t.length > 130) return false;
    if (/\brecuso\b|\br\$\s*\d/i.test(t)) return false;
    if (/@/.test(t)) return true;
    const digits = t.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 14) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true;
    if (/^\+?55\d{10,14}$/.test(digits)) return true;
    return false;
  }

  _findAttendanceByProviderPhone(d) {
    if (!d || d.length < 8) return null;
    const rows = this.db
      .prepare(
        `SELECT id, provider_phone FROM attendances WHERE status IN ('in_progress','assigned','confirmed')
         ORDER BY datetime(updated_at) DESC LIMIT 35`
      )
      .all();
    for (const r of rows) {
      const pp = this._digitsOnly(r.provider_phone || "");
      if (pp && (pp === d || pp.endsWith(d.slice(-9)) || d.endsWith(pp.slice(-9)))) {
        return { id: r.id };
      }
    }
    const provRows = this.db.prepare("SELECT id, phone, whatsapp FROM providers WHERE active = 1").all();
    for (const p of provRows) {
      const p1 = this._digitsOnly(p.phone || "");
      const p2 = this._digitsOnly(p.whatsapp || "");
      if ((p1 && p1 === d) || (p2 && p2 === d)) {
        const att = this.db
          .prepare(
            `SELECT id FROM attendances WHERE provider_id = ? AND status IN ('in_progress','assigned','confirmed')
             ORDER BY datetime(updated_at) DESC LIMIT 1`
          )
          .get(p.id);
        if (att?.id) return { id: att.id };
      }
    }
    return null;
  }

  _findAttendanceForInboundMedia(d) {
    if (!d || d.length < 8) return null;
    const gw = this._digitsOnly(this.getSetting("gestor_whatsapp", ""));
    if (gw && (d === gw || d.endsWith(gw.slice(-9)) || gw.endsWith(d.slice(-9)))) {
      const row = this.db
        .prepare(
          `SELECT id FROM attendances WHERE status IN ('in_progress','assigned','confirmed')
           ORDER BY datetime(updated_at) DESC LIMIT 1`
        )
        .get();
      if (row?.id) return { role: "gestor", attendanceId: row.id };
    }
    const rows = this.db
      .prepare(
        `SELECT id, provider_phone FROM attendances WHERE status IN ('in_progress','assigned','confirmed')
         ORDER BY datetime(updated_at) DESC LIMIT 30`
      )
      .all();
    for (const r of rows) {
      const pp = this._digitsOnly(r.provider_phone || "");
      if (pp && (pp === d || pp.endsWith(d.slice(-9)) || d.endsWith(pp.slice(-9)))) {
        return { role: "provider", attendanceId: r.id };
      }
    }
    const provRows = this.db.prepare("SELECT id, phone, whatsapp FROM providers WHERE active = 1").all();
    for (const p of provRows) {
      const p1 = this._digitsOnly(p.phone || "");
      const p2 = this._digitsOnly(p.whatsapp || "");
      if ((p1 && p1 === d) || (p2 && p2 === d)) {
        const att = this.db
          .prepare(
            `SELECT id FROM attendances WHERE provider_id = ? AND status IN ('in_progress','assigned','confirmed')
             ORDER BY datetime(updated_at) DESC LIMIT 1`
          )
          .get(p.id);
        if (att?.id) return { role: "provider", attendanceId: att.id };
      }
    }
    return null;
  }

  async _tryForwardProviderPix(phone, text) {
    const d = this._digitsOnly(phone);
    const att = this._findAttendanceByProviderPhone(d);
    if (!att) return false;
    let notes = {};
    try {
      notes = JSON.parse(this.db.prepare("SELECT notes FROM attendances WHERE id = ?").get(att.id)?.notes || "{}");
    } catch {
      notes = {};
    }
    if (notes.workflow_phase !== "awaiting_provider_pix") return false;
    if (!this._looksLikePixKey(text)) return false;
    const key = String(text).trim();
    this.mergeAttendanceNotes?.(att.id, {
      workflow_phase: "awaiting_gestor_pix_proof",
      provider_pix_key: key,
    });
    const prot =
      this.db.prepare("SELECT protocol FROM attendances WHERE id = ?").get(att.id)?.protocol || "";
    try {
      await this.notifyGestor?.(
        `🔑 *Chave PIX do prestador*\n` +
          `Protocolo: ${prot || String(att.id).slice(0, 8).toUpperCase()}\n` +
          `Chave: ${key}\n\n` +
          `Efetue o pagamento e envie aqui o *print do comprovante PIX*.`
      );
    } catch {}
    try {
      await this.sendMessage(
        phone,
        "Obrigado. Registramos sua chave PIX e enviamos ao financeiro. Aguarde a confirmação do pagamento."
      );
    } catch {}
    return true;
  }

  async handleInboundAuxiliary(phone, text, rawPayload) {
    const messageData = rawPayload?.data || rawPayload;
    const imageMsg = messageData?.message?.imageMessage;
    if (!imageMsg) return null;
    const d = this._digitsOnly(phone);
    const found = this._findAttendanceForInboundMedia(d);
    if (!found) return null;
    let notes = {};
    try {
      notes = JSON.parse(
        this.db.prepare("SELECT notes FROM attendances WHERE id = ?").get(found.attendanceId)?.notes || "{}"
      );
    } catch {
      notes = {};
    }
    if (found.role === "provider" && notes.billing_mode !== "prepay_non_associate") {
      return null;
    }
    const caption = (imageMsg.caption || "").trim() || "[Imagem recebida]";
    const mediaHint = String(imageMsg.url || imageMsg.directPath || "").slice(0, 400);
    this.appendGestorMedia?.(found.attendanceId, {
      kind: found.role === "gestor" ? "gestor_pix_proof" : "tow_photo",
      from: found.role,
      phone: d,
      caption: caption.slice(0, 500),
      media_hint: mediaHint,
    });
    if (found.role === "provider") {
      if (notes.workflow_phase === "awaiting_tow_photos") {
        this.mergeAttendanceNotes?.(found.attendanceId, { workflow_phase: "awaiting_provider_pix" });
        try {
          await this.sendMessage(
            phone,
            "Recebemos as fotos. Agora envie sua *chave PIX* (CPF, e-mail ou telefone) para repassarmos ao financeiro."
          );
        } catch {}
      }
      try {
        await this.notifyGestor?.(
          `📸 *Foto do prestador* (veículo no reboque)\n` +
            `Atendimento: ${String(found.attendanceId).slice(0, 8).toUpperCase()}\n` +
            (caption && caption !== "[Imagem recebida]" ? `Legenda: ${caption}\n` : "")
        );
      } catch {}
    }
    return { handled: true };
  }

  async handleClientQuoteConfirmation(phone, text) {
    try {
      return await this.quotesEngine.handleClientQuoteConfirmation(phone, text);
    } catch (err) {
      logger.warn({ err }, "handleClientQuoteConfirmation");
      return { handled: false };
    }
  }

  async handleIncomingProviderMessage(phone, text) {
    const raw = String(phone || "").trim();
    const phoneWork = /^web[_-]/i.test(raw) ? raw : resolveMessageThreadKey(raw) || raw;

    try {
      const pix = await this._tryForwardProviderPix(phoneWork, text);
      if (pix) return { pixForwarded: true };
    } catch (err) {
      logger.warn({ err }, "_tryForwardProviderPix");
    }
    try {
      const consumed = await this.quotesEngine.handleProviderResponse(phoneWork, text);
      if (consumed) return { accepted: false, quoted: true };
    } catch (err) {
      logger.warn({ err }, "Falha no quotesEngine.handleProviderResponse");
    }

    const dispatchResult = this.dispatcher.handleProviderResponse(phoneWork, text);
    if (dispatchResult) return dispatchResult;

    const serviceId = this._findBroadcastServiceForProvider(phoneWork);
    if (!serviceId) return null;

    const t = text.trim().toLowerCase();
    if (/recuso|recusar|n[aã]o posso|indispon/i.test(t)) {
      logger.info({ phone: phoneWork, serviceId }, "Prestador recusou via broadcast");
      return { accepted: false, declined: true };
    }

    const priceMatch = t.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:reais|r\$|real)?/);
    const timeMatch = t.match(/(\d+)\s*(?:min|hora|h\b|hr)/);

    if (priceMatch) {
      const price = parseFloat(priceMatch[1].replace(",", "."));
      const timeStr = timeMatch ? `${timeMatch[1]} ${timeMatch[0].replace(timeMatch[1], "").trim()}` : "não informado";

      const digits = phoneWork.replace(/\D/g, "");
      const providerRow = this.db.prepare("SELECT id, name, phone, whatsapp FROM providers WHERE active = 1 AND (phone = ? OR whatsapp = ? OR phone LIKE ? OR whatsapp LIKE ?)").get(
        phoneWork,
        phoneWork,
        `%${digits.slice(-8)}%`,
        `%${digits.slice(-8)}%`
      );

      const providerName = providerRow?.name || phoneWork;
      const providerId = providerRow?.id || null;

      if (providerId) {
        try {
          const negId = uuidv4();
          this.db.prepare(
            "INSERT INTO negotiations (id, service_id, provider_id, offered_price, status, contacted_at) VALUES (?, ?, ?, ?, 'provider_offer', datetime('now'))"
          ).run(negId, serviceId, providerId, price);
        } catch (err) {
          logger.error({ err }, "Erro ao salvar negociação do broadcast");
        }
      }

      const svc = this.db.prepare("SELECT customer_phone, customer_name, attendance_id FROM services WHERE id = ?").get(serviceId);
      const clientPhone = svc?.customer_phone;

      if (clientPhone) {
        const offerMsg =
          `💰 *Proposta de prestador*\n\n` +
          `👤 *Prestador:* ${providerName}\n` +
          `💵 *Valor:* R$ ${price.toFixed(2)}\n` +
          `⏱️ *Previsão de chegada:* ${timeStr}\n\n` +
          `Responda *ACEITAR ${providerName.split(" ")[0].toUpperCase()}* para confirmar este prestador.`;
        try {
          await this.sendMessage(clientPhone, offerMsg);
        } catch (err) {
          logger.error({ err }, "Erro ao enviar proposta ao cliente");
        }
      }

      try {
        await this.sendMessage(
          phoneWork,
          `✅ Recebemos sua proposta de *R$ ${price.toFixed(2)}* com previsão de *${timeStr}*. Aguarde a confirmação do cliente.`
        );
      } catch {}

      this.io.emit("provider:offer", {
        serviceId, providerId, providerName, price, timeStr,
      });

      logger.info({ phone: phoneWork, serviceId, price, timeStr }, "Proposta de prestador recebida via broadcast");
      return { accepted: false, offer: true, price, timeStr, providerName };
    }

    return null;
  }

  async onProviderAccepted(serviceId, provider, finalPrice, clientPhone) {
    try {
      let routeKm = null;
      try {
        const sid = serviceId;
        const attId = sid
          ? this.db.prepare("SELECT attendance_id FROM services WHERE id = ?").get(sid)?.attendance_id
          : null;
        if (attId) {
          const row = this.db.prepare("SELECT distance_km FROM attendances WHERE id = ?").get(attId);
          routeKm = row?.distance_km != null ? Number(row.distance_km) : null;
        }
      } catch {
        /* ignore */
      }
      const routeLine =
        routeKm != null && Number.isFinite(routeKm)
          ? `📏 Trajeto do serviço (origem → destino): *${routeKm.toFixed(1)} km*\n`
          : "";
      const distProv =
        provider.distance_km != null && Number.isFinite(Number(provider.distance_km))
          ? `${Number(provider.distance_km).toFixed(1)} km`
          : "?";
      const message =
        `🎉 *Prestador a caminho!*\n\n` +
        `👤 ${provider.name}\n` +
        `📞 ${provider.whatsapp || provider.phone}\n` +
        routeLine +
        `📏 Até o local do cliente (estimada): ${distProv}\n` +
        `💰 Valor: R$ ${finalPrice.toFixed(2)}\n\n` +
        `Ele está se deslocando até você. Acompanhe as atualizações aqui.`;
      await this.sendMessage(clientPhone, message);
    } catch (err) {
      logger.error({ err }, "Erro ao notificar cliente sobre prestador aceito");
    }
  }

  getActiveTickets() {
    try {
      if (this.db.prepare) {
        return this.db
          .prepare(
            `SELECT a.*, s.id as service_id, s.status as service_status, s.provider_name
             FROM attendances a
             LEFT JOIN services s ON s.attendance_id = a.id
             WHERE a.status IN ('confirmed', 'in_progress', 'assigned')
             ORDER BY a.created_at DESC`
          )
          .all();
      }
    } catch {}
    return [];
  }

  _dbRun(sql, params) {
    try {
      if (this.db.prepare) {
        return this.db.prepare(sql).run(...params);
      }
    } catch (err) {
      logger.error({ err, sql: sql.slice(0, 80) }, "Erro ao executar query");
    }
  }

  _dbGet(sql, params) {
    try {
      if (this.db.prepare) {
        return this.db.prepare(sql).get(...params);
      }
    } catch (err) {
      logger.warn({ err, sql: sql.slice(0, 80) }, "Erro ao executar get");
    }
    return null;
  }

  _getBusinessRules() {
    try {
      if (!this.db.prepare) return null;
      const row = this.db.prepare("SELECT value FROM settings WHERE key = 'business_rules'").get();
      if (!row?.value) return null;
      return JSON.parse(row.value);
    } catch (err) {
      logger.warn({ err }, "Falha ao ler business_rules");
      return null;
    }
  }

  _checkBusinessRulesLimit(phoneNumber, serviceType) {
    const rules = this._getBusinessRules();
    const limit = rules?.limits?.[serviceType];
    if (!limit || (!limit.per_month && !limit.per_year)) return { blocked: false };
    try {
      if (!this.db.prepare) return { blocked: false };
      const countMonth = this.db
        .prepare(
          "SELECT COUNT(*) as n FROM attendances WHERE caller_id = ? AND service_type = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') AND status != 'blocked'"
        )
        .get(phoneNumber, serviceType)?.n || 0;
      const countYear = this.db
        .prepare(
          "SELECT COUNT(*) as n FROM attendances WHERE caller_id = ? AND service_type = ? AND strftime('%Y', created_at) = strftime('%Y', 'now') AND status != 'blocked'"
        )
        .get(phoneNumber, serviceType)?.n || 0;

      const maxMonth = Number(limit.per_month || 0);
      const maxYear = Number(limit.per_year || 0);
      if (maxMonth > 0 && countMonth >= maxMonth) {
        return {
          blocked: true,
          reason: `Limite mensal de ${maxMonth} atendimento(s) do tipo "${serviceType}" atingido (${countMonth}/${maxMonth}).`,
          clientMsg: `você atingiu o limite de ${maxMonth} atendimento(s) de ${serviceType} neste mês.`,
        };
      }
      if (maxYear > 0 && countYear >= maxYear) {
        return {
          blocked: true,
          reason: `Limite anual de ${maxYear} atendimento(s) do tipo "${serviceType}" atingido (${countYear}/${maxYear}).`,
          clientMsg: `você atingiu o limite de ${maxYear} atendimento(s) de ${serviceType} neste ano.`,
        };
      }
    } catch (err) {
      logger.warn({ err }, "Falha ao verificar limite de regras de negócio");
    }
    return { blocked: false };
  }
}

export { Orchestrator };
