import { v4 as uuidv4 } from "uuid";
import { logger } from "../lib/logger.js";


function generatePixCode(amount, description, merchantName = "SGA Assistencia") {
  const payload = buildPixPayload({
    pixKey: process.env.PIX_KEY || "00000000000",
    merchantName: merchantName.slice(0, 25),
    merchantCity: process.env.PIX_CITY || "SAO PAULO",
    amount: amount.toFixed(2),
    description: description.slice(0, 40),
    txId: uuidv4().replace(/-/g, "").slice(0, 25),
  });

  return payload;
}

function buildPixPayload({ pixKey, merchantName, merchantCity, amount, description, txId }) {
  const emv = (id, value) => {
    const len = value.length.toString().padStart(2, "0");
    return `${id}${len}${value}`;
  };

  const gui = emv("00", "br.gov.bcb.pix");
  const key = emv("01", pixKey);
  const desc = description ? emv("02", description) : "";
  const mai = emv("26", gui + key + desc);

  const mcc = emv("52", "0000");
  const currency = emv("53", "986");
  const amountField = amount ? emv("54", amount) : "";
  const country = emv("58", "BR");
  const name = emv("59", merchantName);
  const city = emv("60", merchantCity);
  const txIdField = emv("62", emv("05", txId));

  const payloadWithoutCRC = emv("00", "01") + mai + mcc + currency + amountField + country + name + city + txIdField + "6304";

  const crc = crc16ccitt(payloadWithoutCRC);
  return payloadWithoutCRC + crc;
}

function crc16ccitt(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
    }
    crc &= 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

class PaymentService {
  constructor(db, sendMessage) {
    this.db = db;
    this.sendMessage = sendMessage;
  }

  async createPayment(serviceId, amount, method = "pix") {
    const paymentId = uuidv4();
    let pixCode = null;

    if (method === "pix") {
      pixCode = generatePixCode(amount, `Reboque #${serviceId.slice(0, 8)}`);
    }

    try {
      this.db.prepare(
        `INSERT INTO payments (id, service_id, amount, method, status, pix_code, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, datetime('now'))`
      ).run(paymentId, serviceId, amount, method, pixCode);
    } catch {
      logger.warn("Tabela payments pode não existir ainda no SQLite");
    }

    this.db.prepare(
      "INSERT INTO audit_logs (event_type, entity_type, entity_id, data) VALUES ('payment_created', 'payment', ?, ?)"
    ).run(paymentId, JSON.stringify({ serviceId, amount, method }));

    logger.info({ paymentId, serviceId, amount, method }, "Pagamento criado");

    return { paymentId, amount, method, pixCode, status: "pending" };
  }

  async sendPaymentLink(phone, payment) {
    if (!this.sendMessage) return;

    let message = `💳 *Pagamento do Serviço*\n\n`;
    message += `💰 Valor: R$ ${payment.amount.toFixed(2)}\n`;
    message += `📋 Método: ${payment.method.toUpperCase()}\n\n`;

    if (payment.method === "pix" && payment.pixCode) {
      message += `Para pagar via PIX, copie o código abaixo:\n\n`;
      message += `\`\`\`${payment.pixCode}\`\`\`\n\n`;
      message += `Ou use o PIX Copia e Cola no app do seu banco.`;
    } else {
      message += `Aguardando processamento...`;
    }

    try {
      await this.sendMessage(phone, message);
      logger.info({ phone, paymentId: payment.paymentId }, "Link de pagamento enviado");
    } catch (err) {
      logger.error({ err, phone }, "Erro ao enviar link de pagamento");
    }
  }

  async confirmPayment(paymentId) {
    try {
      this.db.prepare(
        "UPDATE payments SET status = 'confirmed', paid_at = datetime('now') WHERE id = ?"
      ).run(paymentId);
    } catch {}

    this.db.prepare(
      "INSERT INTO audit_logs (event_type, entity_type, entity_id, data) VALUES ('payment_confirmed', 'payment', ?, ?)"
    ).run(paymentId, JSON.stringify({ confirmedAt: new Date().toISOString() }));

    logger.info({ paymentId }, "Pagamento confirmado");
    return { paymentId, status: "confirmed" };
  }

  async getPaymentByService(serviceId) {
    try {
      return this.db.prepare("SELECT * FROM payments WHERE service_id = ? ORDER BY created_at DESC LIMIT 1").get(serviceId);
    } catch {
      return null;
    }
  }
}

export { PaymentService, generatePixCode };
