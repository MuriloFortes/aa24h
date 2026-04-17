import { logger } from "../lib/logger.js";


const SLA_DEFAULTS = {
  max_eta_minutes: 45,
  min_provider_rating: 3.5,
  max_price_multiplier: 2.0,
  max_complaints: 3,
};

class Analyst {
  constructor(db) {
    this.db = db;
    this.slaConfig = { ...SLA_DEFAULTS };
  }

  validateDispatch(provider, negotiation, ticket) {
    const checks = [];

    checks.push(this._checkProviderRating(provider));
    checks.push(this._checkPricePolicy(negotiation, provider));
    checks.push(this._checkProviderHistory(provider));

    const failed = checks.filter((c) => !c.passed);
    const approved = failed.length === 0;

    const result = {
      approved,
      checks,
      failedChecks: failed.map((c) => c.name),
      timestamp: new Date().toISOString(),
    };

    this._logAudit("dispatch_validation", ticket.serviceId, result);

    if (approved) {
      logger.info({ serviceId: ticket.serviceId, providerId: provider.id }, "Despacho aprovado pelo Analista");
    } else {
      logger.warn({ serviceId: ticket.serviceId, failed: result.failedChecks }, "Despacho rejeitado pelo Analista");
    }

    return result;
  }

  _checkProviderRating(provider) {
    const rating = parseFloat(provider.rating) || 0;
    const passed = rating >= this.slaConfig.min_provider_rating;
    return {
      name: "provider_rating",
      passed,
      value: rating,
      threshold: this.slaConfig.min_provider_rating,
      message: passed
        ? `Rating ${rating} acima do mínimo`
        : `Rating ${rating} abaixo do mínimo de ${this.slaConfig.min_provider_rating}`,
    };
  }

  _checkPricePolicy(negotiation, provider) {
    const finalPrice = negotiation.final_price || negotiation.offered_price;
    const basePrice = parseFloat(provider.price_base) || 100;
    const maxPrice = basePrice * this.slaConfig.max_price_multiplier;
    const passed = finalPrice <= maxPrice;
    return {
      name: "price_policy",
      passed,
      value: finalPrice,
      threshold: maxPrice,
      message: passed
        ? `Preço R$${finalPrice} dentro do limite`
        : `Preço R$${finalPrice} excede o máximo de R$${maxPrice}`,
    };
  }

  _checkProviderHistory(provider) {
    let complaintCount = 0;
    try {
      const result = this.db.prepare(
        "SELECT COUNT(*) as n FROM audit_logs WHERE entity_id = ? AND event_type = 'complaint'"
      ).get(provider.id);
      complaintCount = result?.n || 0;
    } catch {}

    const passed = complaintCount < this.slaConfig.max_complaints;
    return {
      name: "provider_history",
      passed,
      value: complaintCount,
      threshold: this.slaConfig.max_complaints,
      message: passed
        ? `${complaintCount} reclamação(ões), dentro do limite`
        : `${complaintCount} reclamação(ões), excede o limite de ${this.slaConfig.max_complaints}`,
    };
  }

  validateETA(etaMinutes) {
    const passed = etaMinutes <= this.slaConfig.max_eta_minutes;
    return {
      name: "eta_check",
      passed,
      value: etaMinutes,
      threshold: this.slaConfig.max_eta_minutes,
      message: passed
        ? `ETA ${etaMinutes}min dentro do SLA`
        : `ETA ${etaMinutes}min excede o SLA de ${this.slaConfig.max_eta_minutes}min`,
    };
  }

  processRating(serviceId, providerId, rating) {
    try {
      const provider = this.db.prepare("SELECT * FROM providers WHERE id = ?").get(providerId);
      if (!provider) return;

      const totalRatings = (provider.total_ratings || 0) + 1;
      const currentRating = parseFloat(provider.rating) || 5.0;
      const newRating = ((currentRating * (totalRatings - 1)) + rating) / totalRatings;

      this.db.prepare(
        "UPDATE providers SET rating = ?, total_ratings = ? WHERE id = ?"
      ).run(Math.round(newRating * 100) / 100, totalRatings, providerId);

      this._logAudit("provider_rated", providerId, {
        serviceId, rating, previousRating: currentRating, newRating, totalRatings,
      });

      logger.info({ providerId, rating, newRating }, "Avaliação processada");
    } catch (err) {
      logger.error({ err, providerId }, "Erro ao processar avaliação");
    }
  }

  _logAudit(eventType, entityId, data) {
    try {
      this.db.prepare(
        "INSERT INTO audit_logs (event_type, entity_type, entity_id, data) VALUES (?, 'analyst', ?, ?)"
      ).run(eventType, entityId, JSON.stringify(data));
    } catch {}
  }

  updateSLAConfig(config) {
    Object.assign(this.slaConfig, config);
    logger.info({ slaConfig: this.slaConfig }, "Configuração SLA atualizada");
  }
}

export { Analyst, SLA_DEFAULTS };
