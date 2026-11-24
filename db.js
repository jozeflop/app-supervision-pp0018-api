/** PostgreSQL data access layer for the PP0018 application. */
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Client } = pg;
const HOST = process.env.PGHOST || process.env.DB_HOST || 'localhost';
const PORT = Number(process.env.PGPORT || process.env.DB_PORT || 5432);
const DATABASE = process.env.PGDATABASE || process.env.DB_DATABASE || 'datahis';
const USER = process.env.PGUSER || process.env.DB_USER || 'postgres';
const PASSWORD = process.env.PGPASSWORD || process.env.DB_PASSWORD || '';

let clientPromise = null;

function normalizeSql(input) {
  let sql = String(input).replace(/\[([^\]]+)\]/g, '$1');
  sql = sql.replace(/\bBEGIN\s+TRANSACTION\b/gi, 'BEGIN');
  sql = sql.replace(/\bSYSUTCDATETIME\(\)/gi, 'CURRENT_TIMESTAMP');
  sql = sql.replace(/\bGETDATE\(\)/gi, 'CURRENT_TIMESTAMP');
  sql = sql.replace(/CAST\(YEAR\(CURRENT_TIMESTAMP\)\s+AS\s+INT\)/gi, 'EXTRACT(YEAR FROM CURRENT_TIMESTAMP)::int');
  sql = sql.replace(/\bISNULL\s*\(/gi, 'COALESCE(');
  sql = sql.replace(/\b[A-Za-z_][A-Za-z0-9_]*\.dbo\./gi, 'dbo.');
  sql = sql.replace(/\bTOP\s+\d+\b/gi, '');
  sql = sql.replace(/\b(activo|es_exclusion|es_requerido|solo_gestante|excluir_gestante|lab_min_incl|lab_max_incl)\s*=\s*([01])\b/gi,
    (_, column, value) => `${column} = ${value === '1' ? 'TRUE' : 'FALSE'}`);
  sql = sql.replace(/\bOUTPUT\s+INSERTED\.([A-Za-z_][A-Za-z0-9_]*)\s+(?=VALUES)/i, '');

  let param = 0;
  sql = sql.replace(/\?/g, () => `$${++param}`);

  const returning = String(input).match(/\bOUTPUT\s+INSERTED\.([A-Za-z_][A-Za-z0-9_]*)/i)?.[1];
  if (returning && /^\s*INSERT\s/i.test(sql)) {
    sql = sql.replace(/;\s*$/, '').trim() + ` RETURNING ${returning}`;
  }
  return sql;
}

async function getClient() {
  if (!clientPromise) {
    const client = new Client({ host: HOST, port: PORT, database: DATABASE, user: USER, password: PASSWORD });
    clientPromise = client.connect().then(() => client).catch((err) => {
      clientPromise = null;
      throw new Error(`No se pudo conectar a PostgreSQL (${HOST}:${PORT}/${DATABASE}): ${err?.message || err}`);
    });
  }
  return clientPromise;
}

export async function getConnection() {
  return getClient();
}

export async function query(sql, params = []) {
  const client = await getClient();
  try {
    const result = await client.query(normalizeSql(sql), params);
    return result.rows || [];
  } catch (err) {
    if (/connection|socket|closed|network|terminat/i.test(String(err?.message || ''))) {
      try { await client.end(); } catch { /* ignore */ }
      clientPromise = null;
    }
    throw err;
  }
}

export async function querySets(sql, params = []) {
  return [await query(sql, params)];
}

export async function execute(sql, params = []) {
  const client = await getClient();
  return client.query(normalizeSql(sql), params);
}

export async function ping() {
  const rows = await query('SELECT current_database() AS database_name, inet_server_addr()::text AS server_name');
  return rows[0];
}

export async function closePool() {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.end();
  } catch { /* ignore */ }
  clientPromise = null;
}

export { normalizeSql };
