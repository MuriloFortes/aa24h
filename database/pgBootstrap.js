/**
 * Inicialização do PostgreSQL (schema + seed mínimo).
 * Usado no boot quando DB_DRIVER=postgres ou quando /api/health verifica PG.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { logger } from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

let _pool = null;

export function getPgConfig() {
  return {
    host: process.env.PG_HOST || "localhost",
    port: Number.parseInt(String(process.env.PG_PORT || "5432"), 10) || 5432,
    database: process.env.PG_DATABASE || "reboque_inteligente",
    user: process.env.PG_USER || "postgres",
    password: process.env.PG_PASSWORD || "postgres",
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

export function getPgPool() {
  if (!_pool) _pool = new Pool(getPgConfig());
  return _pool;
}

export async function pingPostgres() {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    return { ok: true };
  } finally {
    client.release();
  }
}

export async function bootstrapPostgres() {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    const schemaPath = path.join(__dirname, "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf-8");
    await client.query(schema);
    logger.info("PostgreSQL: schema aplicado/verificado");
    return { ok: true };
  } catch (err) {
    logger.error({ err: err?.message }, "PostgreSQL: falha no bootstrap");
    return { ok: false, error: err?.message };
  } finally {
    client.release();
  }
}

export async function closePgPool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
