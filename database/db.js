import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { Pool } = pg;

const pool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: parseInt(process.env.PG_PORT || "5432"),
  database: process.env.PG_DATABASE || "reboque_inteligente",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  logger.error({ err }, "Erro inesperado no pool PostgreSQL");
});

async function initDatabase() {
  const client = await pool.connect();
  try {
    const schemaPath = path.join(__dirname, "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf-8");
    await client.query(schema);
    logger.info("Schema PostgreSQL aplicado com sucesso");

    const defaults = [
      ["whatsapp_connected", "false"],
      ["whatsapp_number", ""],
      [
        "welcome_message",
        "Olá! Tudo bem? Sou a assistente virtual do SGA Assistência. Como posso te ajudar hoje?",
      ],
    ];
    for (const [key, value] of defaults) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }

    logger.info("Seed PostgreSQL aplicado");
  } catch (err) {
    logger.error({ err }, "Erro ao inicializar banco PostgreSQL");
    throw err;
  } finally {
    client.release();
  }
}

const db = {
  async query(text, params) {
    const start = Date.now();
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn({ text: text.slice(0, 100), duration }, "Query lenta detectada");
    }
    return result;
  },

  async getOne(text, params) {
    const result = await this.query(text, params);
    return result.rows[0] || null;
  },

  async getAll(text, params) {
    const result = await this.query(text, params);
    return result.rows;
  },

  async run(text, params) {
    const result = await this.query(text, params);
    return { rowCount: result.rowCount };
  },

  async transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },
};

export { pool, db, initDatabase };
