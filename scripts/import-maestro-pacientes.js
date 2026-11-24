import fs from 'node:fs';
import readline from 'node:readline';
import { query, execute, closePool } from '../db.js';

const archivos = process.argv.slice(2);
if (!archivos.length) {
  throw new Error('Uso: node scripts/import-maestro-pacientes.js <MaestroPaciente.csv> [<MaestroPaciente.csv> ...]');
}

function headerKey(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function parseLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"' && quoted) { cell += '"'; i += 1; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { cells.push(cell.trim()); cell = ''; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

async function leerMaestro(archivo, idsObjetivo, encontrados) {
  const stream = fs.createReadStream(archivo, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  let leidas = 0;
  for await (const linea of rl) {
    if (!linea.trim()) continue;
    const cells = parseLine(linea);
    if (!headers) { headers = cells.map(headerKey); continue; }
    const row = Object.fromEntries(headers.map((key, i) => [key, cells[i] ?? '']));
    const id = String(row.ID_PACIENTE || '').trim();
    if (!id || !idsObjetivo.has(id)) continue;
    leidas += 1;
    const anterior = encontrados.get(id) || {};
    encontrados.set(id, {
      id_paciente: id,
      id_tipo_documento: row.ID_TIPO_DOCUMENTO || anterior.id_tipo_documento || null,
      numero_documento: row.NUMERO_DOCUMENTO || anterior.numero_documento || null,
      apellido_paterno: row.APELLIDO_PATERNO_PACIENTE || anterior.apellido_paterno || null,
      apellido_materno: row.APELLIDO_MATERNO_PACIENTE || anterior.apellido_materno || null,
      nombres: row.NOMBRES_PACIENTE || anterior.nombres || null,
      genero: row.GENERO || anterior.genero || null,
      id_establecimiento: row.ID_ESTABLECIMIENTO || anterior.id_establecimiento || null
    });
  }
  return leidas;
}

async function upsertBatch(rows) {
  if (!rows.length) return;
  const params = [];
  const values = rows.map((row) => {
    const offset = params.length;
    params.push(row.id_paciente, row.id_tipo_documento, row.numero_documento, row.apellido_paterno,
      row.apellido_materno, row.nombres, row.genero, row.id_establecimiento);
    return `(${Array.from({ length: 8 }, (_, i) => `?`).join(', ')})`;
  });
  await execute(
    `INSERT INTO dbo.his_pacientes
      (id_paciente, id_tipo_documento, numero_documento, apellido_paterno, apellido_materno, nombres, genero, id_establecimiento)
     VALUES ${values.join(', ')}
     ON CONFLICT (id_paciente) DO UPDATE SET
       id_tipo_documento=COALESCE(EXCLUDED.id_tipo_documento, dbo.his_pacientes.id_tipo_documento),
       numero_documento=COALESCE(EXCLUDED.numero_documento, dbo.his_pacientes.numero_documento),
       apellido_paterno=COALESCE(EXCLUDED.apellido_paterno, dbo.his_pacientes.apellido_paterno),
       apellido_materno=COALESCE(EXCLUDED.apellido_materno, dbo.his_pacientes.apellido_materno),
       nombres=COALESCE(EXCLUDED.nombres, dbo.his_pacientes.nombres),
       genero=COALESCE(EXCLUDED.genero, dbo.his_pacientes.genero),
       id_establecimiento=COALESCE(EXCLUDED.id_establecimiento, dbo.his_pacientes.id_establecimiento),
       fecha_modificacion=CURRENT_TIMESTAMP`,
    params
  );
}

try {
  await execute(`CREATE TABLE IF NOT EXISTS dbo.his_pacientes (
    id_paciente varchar(50) PRIMARY KEY,
    id_tipo_documento varchar(10),
    numero_documento varchar(20),
    apellido_paterno varchar(120),
    apellido_materno varchar(120),
    nombres varchar(160),
    genero varchar(10),
    id_establecimiento integer,
    fecha_modificacion timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  const ids = await query('SELECT DISTINCT id_paciente FROM dbo.stgatenciones WHERE anio=2026 AND id_paciente IS NOT NULL');
  const idsObjetivo = new Set(ids.map((row) => String(row.id_paciente)));
  const encontrados = new Map();
  let leidas = 0;
  for (const archivo of archivos) leidas += await leerMaestro(archivo, idsObjetivo, encontrados);

  await execute('BEGIN');
  try {
    const rows = [...encontrados.values()];
    for (let i = 0; i < rows.length; i += 400) await upsertBatch(rows.slice(i, i + 400));
    await execute(`UPDATE dbo.stgatenciones s SET
      numero_documento=COALESCE(s.numero_documento, p.numero_documento),
      genero=COALESCE(s.genero, p.genero),
      paciente_nombre=COALESCE(NULLIF(s.paciente_nombre, ''), NULLIF(CONCAT_WS(' ', p.apellido_paterno, p.apellido_materno, p.nombres), ''))
      FROM dbo.his_pacientes p WHERE p.id_paciente=s.id_paciente AND s.anio=2026`);
    await execute(`UPDATE dbo.nominal_resultados r SET
      numero_documento=COALESCE(r.numero_documento, p.numero_documento),
      tipo_documento=COALESCE(r.tipo_documento, p.id_tipo_documento),
      genero=COALESCE(r.genero, p.genero)
      FROM dbo.his_pacientes p WHERE p.id_paciente=r.id_paciente AND r.anio=2026`);
    await execute('COMMIT');
    console.log(JSON.stringify({ archivos, ids_atenciones: idsObjetivo.size, filas_maestro_encontradas: encontrados.size, filas_leidas: leidas }, null, 2));
  } catch (error) {
    await execute('ROLLBACK');
    throw error;
  }
} finally {
  await closePool();
}
