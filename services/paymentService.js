/**
 * Serviço de pagamento via Mercado Pago
 * Gera link de pagamento e verifica status
 */
import { logger } from "../lib/logger.js";
import axios from "axios";

export class PaymentService {
  constructor(db, sendMessage) {
    this.db = db;
    this.sendMessage = sendMessage;
  }

  _getAccessToken() {
    return process.env.MERCADOPAGO_ACCESS_TOKEN || "";
  }

  _getBaseUrl() {
    return "https://api.mercadopago.com";
  }

  isConfigured() {
    const token = this._getAccessToken();
    return !!token && token.length > 10;
  }

  async createPaymentLink(opts) {
    const { amount, description, email, phone, attendanceId, providerName } = opts;
    const token = this._getAccessToken();
    if (!token) {
      logger.error("Mercado Pago não configurado - MERCADOPAGO_ACCESS_TOKEN ausente");
      throw new Error("Pagamento não configurado no sistema");
    }

    const externalRef = `ATT_${attendanceId?.slice(0, 8) || "UNK"}`;

    const payload = {
      transaction_amount: Number(amount),
      description: description || "Serviço de reboque",
      payment_method_id: "pix",
      payer: {
        email: email || "cliente@email.com",
        first_name: providerName || "Cliente",
      },
      external_reference: externalRef,
      notification_url: process.env.MERCADOPAGO_WEBHOOK_URL || "",
    };

    const url = `${this._getBaseUrl()}/v1/payments`;
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    try {
      const response = await axios.post(url, payload, { headers, timeout: 30000 });
      const paymentData = response.data;

      // Salvar no banco para rastreamento
      if (attendanceId) {
        try {
          this.db.prepare(
            `INSERT OR REPLACE INTO payment_links 
             (id, attendance_id, mp_payment_id, amount, status, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`
          ).run(
            externalRef,
            attendanceId,
            paymentData.id,
            amount,
            paymentData.status
          );
        } catch (e) {
          logger.warn({ e }, "Falha ao salvar payment_link no banco");
        }
      }

      logger.info({ paymentId: paymentData.id, amount, status: paymentData.status }, "Payment link Mercado Pago criado");
      return {
        paymentId: paymentData.id,
        status: paymentData.status,
        pointOfInteractionUrl: paymentData.point_of_interaction?.url,
        ticketUrl: paymentData.ticket_url,
      };
    } catch (err) {
      logger.error({ err: err.response?.data || err.message }, "Erro ao criar payment link Mercado Pago");
      throw err;
    }
  }

  async checkPaymentStatus(paymentId) {
    const token = this._getAccessToken();
    if (!token) return { status: "not_configured" };

    const url = `${this._getBaseUrl()}/v1/payments/${paymentId}`;
    const headers = {
      Authorization: `Bearer ${token}`,
    };

    try {
      const response = await axios.get(url, { headers, timeout: 10000 });
      return {
        status: response.data.status,
        statusDetail: response.data.status_detail,
        dateApproved: response.data.date_approved,
        amount: response.data.transaction_amount,
      };
    } catch (err) {
      logger.warn({ err, paymentId }, "Erro ao verificar status pagamento");
      return { status: "error", error: err.message };
    }
  }

  async checkPaymentByExternalRef(externalRef) {
    const token = this._getAccessToken();
    if (!token) return { status: "not_configured" };

    // Primeiro tenta pelo banco
    const local = this.db.prepare(
      "SELECT mp_payment_id FROM payment_links WHERE id = ?"
    ).get(externalRef);

    if (local?.mp_payment_id) {
      return this.checkPaymentStatus(local.mp_payment_id);
    }

    // Se não encontrar local, busca na API
    const searchUrl = `${this._getBaseUrl()}/v1/payments/search`;
    const headers = { Authorization: `Bearer ${token}`;

    try {
      const response = await axios.get(searchUrl, {
        headers,
        params: { external_reference: externalRef },
        timeout: 10000,
      });

      const results = response.data?.results || [];
      if (results.length > 0) {
        const payment = results[0];
        return {
          status: payment.status,
          statusDetail: payment.status_detail,
          paymentId: payment.id,
        };
      }
      return { status: "not_found" };
    } catch (err) {
      logger.warn({ err, externalRef }, "Erro na busca de pagamento");
      return { status: "error" };
    }
  }
}