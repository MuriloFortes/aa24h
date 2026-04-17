import { logger } from "../lib/logger.js";


class NotificationService {
  constructor(io, sendMessage) {
    this.io = io;
    this.sendMessage = sendMessage;
  }

  async notifyClientProviderAssigned(clientPhone, provider, eta, price) {
    const message =
      `🎉 *Prestador Confirmado!*\n\n` +
      `👤 ${provider.name}\n` +
      `📞 ${provider.phone || provider.whatsapp}\n` +
      `📏 Distância: ${provider.distance_km || "?"} km\n` +
      `⏱️ Tempo estimado: ${eta || "?"} min\n` +
      `💰 Valor: R$ ${price.toFixed(2)}\n\n` +
      `Acompanhe aqui. O prestador entrará em contato.`;

    await this._send(clientPhone, message);
    this.io.emit("notification:client", { phone: clientPhone, type: "provider_assigned" });
  }

  async notifyClientProviderEnRoute(clientPhone, providerName) {
    const message = `🚗 *${providerName}* está a caminho! Fique no local seguro.`;
    await this._send(clientPhone, message);
  }

  async notifyClientProviderArrived(clientPhone, providerName) {
    const message = `✅ *${providerName}* chegou ao local! Procure pelo veículo do prestador.`;
    await this._send(clientPhone, message);
  }

  async notifyClientServiceCompleted(clientPhone, serviceId) {
    const message =
      `✅ *Serviço Concluído!*\n\n` +
      `Obrigado por usar a SGA Assistência.\n` +
      `Avalie o atendimento respondendo de 1 a 5.`;
    await this._send(clientPhone, message);
  }

  async notifyProviderNewService(providerPhone, serviceData) {
    const message =
      `🔔 *Nova Solicitação*\n\n` +
      `🔧 ${serviceData.serviceType}\n` +
      `📍 ${serviceData.location}\n` +
      `🚗 ${serviceData.vehicleType || "N/I"} - ${serviceData.vehiclePlate || "N/I"}\n` +
      `💰 Valor: R$ ${serviceData.price.toFixed(2)}\n\n` +
      `Responda ACEITO, RECUSO ou VALOR XXX`;
    await this._send(providerPhone, message);
  }

  async notifyProviderRouteInfo(providerPhone, clientLocation) {
    const mapsLink = clientLocation.lat && clientLocation.lng
      ? `https://www.google.com/maps/dir/?api=1&destination=${clientLocation.lat},${clientLocation.lng}`
      : null;

    let message = `📍 *Dados do Cliente*\n\n${clientLocation.address || ""}`;
    if (mapsLink) {
      message += `\n\n🗺️ Rota: ${mapsLink}`;
    }
    await this._send(providerPhone, message);
  }

  async _send(phone, message) {
    if (!this.sendMessage || !phone) return;
    try {
      await this.sendMessage(phone, message);
      logger.info({ phone, msgLen: message.length }, "Notificação enviada");
    } catch (err) {
      logger.error({ err, phone }, "Erro ao enviar notificação");
    }
  }
}

async function calculateETA(originLat, originLng, destLat, destLng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    const distKm = haversineDistance(originLat, originLng, destLat, destLng);
    return Math.max(10, Math.round(distKm * 2.5));
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${originLat},${originLng}&destination=${destLat},${destLng}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.routes?.[0]?.legs?.[0]?.duration?.value) {
      return Math.ceil(data.routes[0].legs[0].duration.value / 60);
    }
  } catch {}

  const distKm = haversineDistance(originLat, originLng, destLat, destLng);
  return Math.max(10, Math.round(distKm * 2.5));
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export { NotificationService, calculateETA, haversineDistance };
