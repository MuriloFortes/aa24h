import "dotenv/config";
import Database from "better-sqlite3";
import pg from "pg";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { Pool } = pg;

async function migrate() {
  console.log("=== Migração SQLite → PostgreSQL ===\n");

  const sqlitePath = path.join(__dirname, "..", "attendance.db");
  if (!fs.existsSync(sqlitePath)) {
    console.log("Banco SQLite não encontrado. Nada para migrar.");
    process.exit(0);
  }

  const sqlite = new Database(sqlitePath, { readonly: true });

  const pool = new Pool({
    host: process.env.PG_HOST || "localhost",
    port: parseInt(process.env.PG_PORT || "5432"),
    database: process.env.PG_DATABASE || "reboque_inteligente",
    user: process.env.PG_USER || "postgres",
    password: process.env.PG_PASSWORD || "postgres",
  });

  const client = await pool.connect();

  try {
    const schemaPath = path.join(__dirname, "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf-8");
    await client.query(schema);
    console.log("Schema PostgreSQL aplicado.\n");

    const attendances = sqlite.prepare("SELECT * FROM attendances").all();
    console.log(`Migrando ${attendances.length} atendimentos...`);
    for (const a of attendances) {
      await client.query(
        `INSERT INTO attendances (id, caller_id, customer_name, vehicle_plate, service_type, status, sga_response, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          a.id, a.caller_id, a.customer_name, a.vehicle_plate, a.service_type,
          a.status, a.sga_response || null, a.notes ? JSON.stringify(a.notes) : null,
          a.created_at, a.updated_at,
        ]
      );
    }

    const logs = sqlite.prepare("SELECT * FROM attendance_logs").all();
    console.log(`Migrando ${logs.length} logs de atendimento...`);
    for (const l of logs) {
      await client.query(
        `INSERT INTO attendance_logs (attendance_id, step, question, answer, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [l.attendance_id, l.step, l.question, l.answer, l.created_at]
      );
    }

    const services = sqlite.prepare("SELECT * FROM services").all();
    console.log(`Migrando ${services.length} serviços...`);
    for (const s of services) {
      await client.query(
        `INSERT INTO services (id, attendance_id, plate, service_type, customer_name, customer_phone, provider_name, status, price, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING`,
        [
          s.id, s.attendance_id, s.plate, s.service_type, s.customer_name,
          s.customer_phone, s.provider_name, s.status, s.price, s.notes,
          s.created_at, s.updated_at,
        ]
      );
    }

    const providers = sqlite.prepare("SELECT * FROM providers").all();
    console.log(`Migrando ${providers.length} prestadores...`);
    for (const p of providers) {
      await client.query(
        `INSERT INTO providers (id, name, phone, whatsapp, services, latitude, longitude, rating, active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          p.id, p.name, p.phone, p.whatsapp, p.services,
          p.latitude, p.longitude, p.rating, p.active === 1, p.created_at,
        ]
      );
    }

    const settings = sqlite.prepare("SELECT * FROM settings").all();
    console.log(`Migrando ${settings.length} configurações...`);
    for (const s of settings) {
      await client.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
        [s.key, s.value, s.updated_at]
      );
    }

    console.log("\nMigração concluída com sucesso!");
  } catch (err) {
    console.error("Erro na migração:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

migrate();
