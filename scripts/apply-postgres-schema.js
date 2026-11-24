import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = process.argv[2] || process.env.DB_SCHEMA_PATH || path.resolve(root, '..', 'app-supervision-pp0018-db', 'db', '02_supervision_postgres.sql');
const sql = fs.readFileSync(schemaPath, 'utf8');
const client = new pg.Client({
  host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'datahis', user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || ''
});
await client.connect();
await client.query(sql);
await client.end();
console.log('Esquema PostgreSQL aplicado.');
