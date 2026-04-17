import { logger } from "../lib/logger.js";
import { v4 as uuidv4 } from "uuid";
import { findProvidersWithExpansionSqlite } from "../database/geoSqlite.js";


const PROVIDER_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONTACT_ATTEMPTS = 5;
const PRICE_DELTA_PERCENT = 15;

class Dispatcher {
  constructor(db, io, sendMessage) {
    this.db = db;
    this.io = io;
    this.sendMessage = sendMessage;
    this.activeDispatches = new Map();
  }

  /** Prestador sem lista de serviços ou CSV contendo o tipo (ex.: reboque). */
  providerMatchesService(provider, serviceType) {
    if (!serviceType) return true;
    if (!provider?.services || String(provider.services).trim() === "") return true;
    return String(provider.services).toLowerCase().includes(String(serviceType).toLowerCase());
  }

  formatTowingHuman(ta) {
    if (!ta || ta === "nao_aplicavel") return "—";
    const m = { facil: "fácil", dificil: "difícil", bloqueado: "bloqueado" };
    return m[ta] || ta;
  }

  /**
   * Mensagem única com dados do serviço para prestadores consultarem disponibilidade e preço.
   */
  buildProviderInquiryMessage(ticket, providerMeta = {}) {
    const dist =
      providerMeta.distanceKm != null ? `${Number(providerMeta.distanceKm).toFixed(1)} km` : "—";
    const price =
      providerMeta.offeredPrice != null ? `R$ ${Number(providerMeta.offeredPrice).toFixed(2)}` : "—";
    const tw = this.formatTowingHuman(ticket.towingAccess);
    const sid = ticket.protocol
      || (ticket.serviceId ? String(ticket.serviceId).slice(0, 8).toUpperCase() : "—");
    return (
      `🔔 *Nova solicitação — SGA Assistência*\n\n` +
      `📋 *Ref. serviço:* ${sid}\n` +
      `👤 *Cliente:* ${ticket.customerName || "—"}\n` +
      `📞 *Telefone:* ${ticket.phoneNumber || "—"}\n` +
      `📍 *Endereço / local:* ${ticket.location || "—"}\n` +
      `🚗 *Placa:* ${ticket.vehiclePlate || "—"}\n` +
      `🏷️ *Veículo:* ${ticket.vehicleType || "—"}\n` +
      `🔧 *Tipo de serviço:* ${ticket.serviceType || "—"}\n` +
      `📌 *Problema:* ${ticket.problemType || "—"}\n` +
      `⏱️ *Urgência:* ${ticket.urgency || "normal"}\n` +
      `🚚 *Acesso p/ reboque:* ${tw}\n` +
      `📏 *Distância (estimada):* ${dist}\n` +
      `💰 *Valor sugerido:* ${price}\n\n` +
      `*Pode atender este serviço? Informe disponibilidade e o valor que cobra.*\n` +
      `Responda:\n` +
      `✅ *ACEITO* — aceito o valor sugerido\n` +
      `💰 *VALOR 150* — sua proposta (use o valor em reais)\n` +
      `❌ *RECUSO* — não posso atender`
    );
  }

  async dispatch(ticket) {
    const { attendanceId, serviceId, location, problemType } = ticket;

    logger.info({ attendanceId, serviceId }, "Iniciando busca de prestador");

    let lat = ticket.locationLat;
    let lng = ticket.locationLng;

    if (!lat || !lng) {
      logger.warn({ attendanceId }, "Sem coordenadas GPS, busca geoespacial limitada");
      this.io.emit("dispatch:no_coords", { attendanceId, serviceId });
      return null;
    }

    const serviceType = this._mapProblemToService(problemType);

    const { providers, radiusKm } = findProvidersWithExpansionSqlite(this.db, {
      lat,
      lng,
      serviceType,
      minResults: 1,
    });

    if (providers.length === 0) {
      logger.warn({ attendanceId, serviceId }, "Nenhum prestador disponível");
      this.io.emit("dispatch:no_providers", { attendanceId, serviceId, radiusKm });
      await this._updateServiceStatus(serviceId, "no_provider");
      return null;
    }

    this.io.emit("dispatch:searching", {
      attendanceId, serviceId,
      providersFound: providers.length,
      radiusKm,
    });

    const dispatchState = {
      attendanceId,
      serviceId,
      ticket,
      providers,
      currentIndex: 0,
      negotiations: [],
      status: "searching",
      broadcastSent: !!ticket.broadcastProvidersNotified,
    };
    this.activeDispatches.set(serviceId, dispatchState);

    return this._contactNextProvider(serviceId);
  }

  async _contactNextProvider(serviceId) {
    const state = this.activeDispatches.get(serviceId);
    if (!state || state.currentIndex >= state.providers.length || state.currentIndex >= MAX_CONTACT_ATTEMPTS) {
      logger.warn({ serviceId }, "Todos os prestadores contatados sem aceitação");
      this.io.emit("dispatch:exhausted", { serviceId, attendanceId: state?.attendanceId });
      if (state) {
        await this._updateServiceStatus(serviceId, "no_provider");
        this.activeDispatches.delete(serviceId);
      }
      return null;
    }

    const provider = state.providers[state.currentIndex];
    const offeredPrice = provider.estimated_price;

    const negotiationId = uuidv4();

    try {
      await this.db.run(
        `INSERT INTO negotiations (id, service_id, provider_id, offered_price, status, contacted_at, timeout_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW() + INTERVAL '5 minutes')`,
        [negotiationId, serviceId, provider.id, offeredPrice]
      );
    } catch {
      // SQLite fallback
      this.db.prepare?.(
        "INSERT INTO negotiations (id, service_id, provider_id, offered_price, status, contacted_at) VALUES (?, ?, ?, ?, 'pending', datetime('now'))"
      )?.run(negotiationId, serviceId, provider.id, offeredPrice);
    }

    state.negotiations.push({ negotiationId, providerId: provider.id, offeredPrice });

    const message = this.buildProviderInquiryMessage(state.ticket, {
      offeredPrice,
      distanceKm: provider.distance_km,
    });

    try {
      const phone = provider.whatsapp || provider.phone;
      if (phone) {
        if (!(state.broadcastSent && state.currentIndex === 0)) {
          await this.sendMessage(phone, message);
          logger.info({ serviceId, providerId: provider.id, phone, offeredPrice }, "Prestador contatado");
        } else {
          logger.info(
            { serviceId, providerId: provider.id },
            "Mesmo conteúdo já enviado no broadcast — negociação ativa sem duplicar mensagem"
          );
        }
      }
    } catch (err) {
      logger.error({ err, serviceId, providerId: provider.id }, "Erro ao contatar prestador");
      state.currentIndex++;
      return this._contactNextProvider(serviceId);
    }

    this.io.emit("dispatch:contacted", {
      serviceId,
      attendanceId: state.attendanceId,
      providerId: provider.id,
      providerName: provider.name,
      offeredPrice,
      distance: provider.distance_km,
    });

    setTimeout(() => this._handleTimeout(serviceId, negotiationId), PROVIDER_RESPONSE_TIMEOUT_MS);

    return { negotiationId, provider, offeredPrice };
  }

  async handleProviderResponse(providerPhone, responseText) {
    const normalizedPhone = providerPhone.replace(/\D/g, "");
    const text = responseText.trim().toLowerCase();

    let serviceId = null;
    let state = null;

    for (const [sId, s] of this.activeDispatches) {
      const currentProvider = s.providers[s.currentIndex];
      const phone = (currentProvider?.whatsapp || currentProvider?.phone || "").replace(/\D/g, "");
      if (phone === normalizedPhone) {
        serviceId = sId;
        state = s;
        break;
      }
    }

    if (!serviceId || !state) return null;

    const lastNegotiation = state.negotiations[state.negotiations.length - 1];
    if (!lastNegotiation) return null;

    if (text === "aceito" || text === "aceitar" || text === "sim" || text === "ok") {
      return this._acceptProvider(serviceId, lastNegotiation, lastNegotiation.offeredPrice);
    }

    const priceMatch = text.match(/valor\s+(\d+(?:[.,]\d{1,2})?)/);
    if (priceMatch) {
      const counterPrice = parseFloat(priceMatch[1].replace(",", "."));
      return this._handleCounterOffer(serviceId, lastNegotiation, counterPrice);
    }

    if (text === "recuso" || text === "recusar" || text === "não" || text === "nao") {
      return this._rejectAndContactNext(serviceId, lastNegotiation);
    }

    return null;
  }

  async _acceptProvider(serviceId, negotiation, finalPrice) {
    const state = this.activeDispatches.get(serviceId);
    if (!state) return null;

    const provider = state.providers[state.currentIndex];

    try {
      await this.db.run(
        `UPDATE negotiations SET status = 'accepted', final_price = $1, responded_at = NOW() WHERE id = $2`,
        [finalPrice, negotiation.negotiationId]
      );
      await this.db.run(
        `UPDATE services SET provider_id = $1, provider_name = $2, price = $3, status = 'assigned' WHERE id = $4`,
        [provider.id, provider.name, finalPrice, serviceId]
      );
      await this.db.run(
        `UPDATE attendances SET status = 'assigned' WHERE id = $1`,
        [state.attendanceId]
      );
    } catch {
      // SQLite fallback handled in orchestrator
    }

    this.io.emit("provider:accepted", {
      serviceId,
      attendanceId: state.attendanceId,
      provider: {
        id: provider.id,
        name: provider.name,
        phone: provider.whatsapp || provider.phone,
        distance: provider.distance_km,
      },
      finalPrice,
    });

    this.activeDispatches.delete(serviceId);

    logger.info({
      serviceId, providerId: provider.id, finalPrice,
    }, "Prestador aceitou o serviço");

    return {
      accepted: true,
      provider,
      finalPrice,
      negotiationId: negotiation.negotiationId,
    };
  }

  async _handleCounterOffer(serviceId, negotiation, counterPrice) {
    const state = this.activeDispatches.get(serviceId);
    if (!state) return null;

    const maxAcceptable = negotiation.offeredPrice * (1 + PRICE_DELTA_PERCENT / 100);

    try {
      await this.db.run(
        `UPDATE negotiations SET counter_price = $1, responded_at = NOW() WHERE id = $2`,
        [counterPrice, negotiation.negotiationId]
      );
    } catch {}

    if (counterPrice <= maxAcceptable) {
      logger.info({ serviceId, counterPrice, maxAcceptable }, "Contraproposta dentro do delta, aceitando");
      return this._acceptProvider(serviceId, negotiation, counterPrice);
    }

    logger.info({ serviceId, counterPrice, maxAcceptable }, "Contraproposta acima do delta, recusando");

    const provider = state.providers[state.currentIndex];
    const phone = provider.whatsapp || provider.phone;
    if (phone) {
      try {
        await this.sendMessage(
          phone,
          `Obrigado pela resposta. Infelizmente o valor R$ ${counterPrice.toFixed(2)} está acima do nosso limite para este serviço. Estamos buscando outro prestador.`
        );
      } catch {}
    }

    return this._rejectAndContactNext(serviceId, negotiation);
  }

  async _rejectAndContactNext(serviceId, negotiation) {
    try {
      await this.db.run(
        `UPDATE negotiations SET status = 'rejected', responded_at = NOW() WHERE id = $1`,
        [negotiation.negotiationId]
      );
    } catch {}

    const state = this.activeDispatches.get(serviceId);
    if (state) {
      state.currentIndex++;
      return this._contactNextProvider(serviceId);
    }
    return null;
  }

  async _handleTimeout(serviceId, negotiationId) {
    const state = this.activeDispatches.get(serviceId);
    if (!state) return;

    const lastNeg = state.negotiations[state.negotiations.length - 1];
    if (!lastNeg || lastNeg.negotiationId !== negotiationId) return;

    try {
      await this.db.run(
        `UPDATE negotiations SET status = 'timeout' WHERE id = $1 AND status = 'pending'`,
        [negotiationId]
      );
    } catch {}

    logger.info({ serviceId, negotiationId }, "Timeout de resposta do prestador");

    const provider = state.providers[state.currentIndex];
    const phone = provider?.whatsapp || provider?.phone;
    if (phone) {
      try {
        await this.sendMessage(phone, "⏰ Tempo de resposta expirado. O serviço foi direcionado para outro prestador.");
      } catch {}
    }

    state.currentIndex++;
    this._contactNextProvider(serviceId);
  }

  async _updateServiceStatus(serviceId, status) {
    try {
      await this.db.run(`UPDATE services SET status = $1 WHERE id = $2`, [status, serviceId]);
    } catch {
      this.db.prepare?.("UPDATE services SET status = ? WHERE id = ?")?.run(status, serviceId);
    }
  }

  _mapProblemToService(problemType) {
    const map = {
      pane_mecanica: "reboque",
      pane_eletrica: "reboque",
      pneu_furado: "troca_pneu",
      acidente: "reboque",
      sem_combustivel: "combustivel",
      chave_trancada: "chaveiro",
      bateria_descarregada: "carga_bateria",
      reboque: "reboque",
    };
    return map[problemType] || "reboque";
  }

  getDispatchStatus(serviceId) {
    return this.activeDispatches.get(serviceId) || null;
  }
}

export { Dispatcher };
