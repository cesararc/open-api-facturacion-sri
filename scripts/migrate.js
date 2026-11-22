#!/usr/bin/env node
/**
 * Aplica las migraciones de database/migrations en orden.
 *
 *   npm run db:migrate              aplica las pendientes
 *   npm run db:migrate -- --dry-run solo lista las pendientes
 *
 * Lleva el registro en la tabla schema_migrations. Cada archivo corre en su
 * propia transacción: si falla, no queda a medias ni se registra.
 *
 * Conexión: las mismas variables que usa la API (DB_HOST, DB_PORT, DB_NAME,
 * DB_USER, DB_PASSWORD, DB_SSL, DB_SSL_CA, DB_SSL_REJECT_UNAUTHORIZED). Si no
 * están en el entorno, se leen de .env.<NODE_ENV> (por defecto development).
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');

function listMigrationFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

/**
 * @param {object} opts
 * @param {(sql: string, params?: unknown[]) => Promise<{ rows: any[] }>} opts.query
 * @param {string} [opts.dir]
 * @param {boolean} [opts.dryRun]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ applied: string[], pending: string[], skipped: string[] }>}
 */
async function runMigrations({
  query,
  dir = MIGRATIONS_DIR,
  dryRun = false,
  log = console.log,
}) {
  const files = listMigrationFiles(dir);

  const tabla = await query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS existe`,
  );
  const existeTabla = tabla.rows[0].existe === true;

  let aplicadas = new Set();
  if (existeTabla) {
    const res = await query('SELECT name FROM public.schema_migrations');
    aplicadas = new Set(res.rows.map((r) => r.name));
  }

  const pending = files.filter((f) => !aplicadas.has(f));
  const skipped = files.filter((f) => aplicadas.has(f));

  if (dryRun) {
    if (pending.length === 0) log('Sin migraciones pendientes.');
    for (const f of pending) log(`pendiente  ${f}`);
    return { applied: [], pending, skipped };
  }

  if (!existeTabla) {
    await query(
      `CREATE TABLE IF NOT EXISTS public.schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
  }

  const applied = [];
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await query('BEGIN');
    try {
      await query(sql);
      await query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [
        file,
      ]);
      await query('COMMIT');
    } catch (error) {
      await query('ROLLBACK');
      throw new Error(`Falló ${file}: ${error.message}`);
    }
    applied.push(file);
    log(`aplicada   ${file}`);
  }

  if (applied.length === 0) log('Sin migraciones pendientes.');
  return { applied, pending: [], skipped };
}

function loadEnvFile() {
  if (process.env.DB_HOST) return;
  const envFile = path.join(
    __dirname,
    '..',
    `.env.${process.env.NODE_ENV || 'development'}`,
  );
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envFile);
  }
}

function buildSslOptions(env) {
  if (env.DB_SSL !== 'true') return undefined;
  const ssl = { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' };
  const ca = (env.DB_SSL_CA || '').trim();
  if (ca) {
    if (ca.includes('-----BEGIN')) {
      ssl.ca = ca.replace(/\\n/g, '\n');
    } else if (fs.existsSync(ca)) {
      ssl.ca = fs.readFileSync(ca, 'utf8');
    } else {
      throw new Error(`DB_SSL_CA apunta a un archivo que no existe: ${ca}`);
    }
  }
  return ssl;
}

async function main() {
  loadEnvFile();
  const env = process.env;
  const faltantes = ['DB_HOST', 'DB_NAME', 'DB_USER'].filter((k) => !env[k]);
  if (faltantes.length > 0) {
    throw new Error(`Faltan variables de entorno: ${faltantes.join(', ')}`);
  }

  const { Client } = require('pg');
  const client = new Client({
    host: env.DB_HOST,
    port: parseInt(env.DB_PORT || '5432', 10),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: buildSslOptions(env),
  });

  await client.connect();
  try {
    console.log(`Base de datos: ${env.DB_NAME} en ${env.DB_HOST}`);
    await runMigrations({
      query: (sql, params) => client.query(sql, params),
      dryRun: process.argv.includes('--dry-run'),
    });
  } finally {
    await client.end();
  }
}

module.exports = { runMigrations, listMigrationFiles, buildSslOptions };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
