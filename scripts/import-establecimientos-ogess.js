import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { closePool, execute } from '../db.js';

const NETWORKS_OGESS = new Set(['EL DORADO', 'LAMAS', 'PICOTA', 'SAN MARTIN']);
const ARCHIVE_MEMBER = 'MaestrosHisCsv/MAESTRO_HIS_ESTABLECIMIENTO.csv';

function key(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function normalizedValue(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toUpperCase().replace(/\s+/g, ' ');
}

function parsePipeCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"' && quoted && next === '"') { cell += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && character === '|') { row.push(cell); cell = ''; continue; }
    if (!quoted && character === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += character;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];

  const headers = rows.shift().map(key);
  return rows.filter((values) => values.some((value) => String(value || '').trim()))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? '').trim()])));
}

function integer(value) {
  if (!String(value || '').trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadSource(filePath) {
  if (/\.rar$/i.test(filePath)) {
    const result = spawnSync('tar.exe', ['-xOf', filePath, ARCHIVE_MEMBER], { maxBuffer: 128 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr?.toString() || 'No se pudo leer el catálogo desde el RAR.');
    return result.stdout;
  }
  return readFile(filePath);
}

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('Uso: node scripts/import-establecimientos-ogess.js <MaestrosHisCsv.rar | MAESTRO_HIS_ESTABLECIMIENTO.csv>');
  process.exitCode = 1;
} else {
  try {
    const bytes = await loadSource(sourcePath);
    const text = new TextDecoder('windows-1252').decode(bytes);
    const allRecords = parsePipeCsv(text);
    const records = allRecords.filter((record) =>
      normalizedValue(record.DESCRIPCION_SECTOR) === 'GOBIERNO REGIONAL' &&
      normalizedValue(record.DEPARTAMENTO) === 'SAN MARTIN' &&
      NETWORKS_OGESS.has(normalizedValue(record.RED))
    );

    if (!records.length) {
      const sample = allRecords[0] || {};
      throw new Error(`El catálogo no contiene filas compatibles (filas=${allRecords.length}, campos=${Object.keys(sample).join(',')}, sector=${sample.DESCRIPCION_SECTOR || ''}, departamento=${sample.DEPARTAMENTO || ''}).`);
    }

    await execute('BEGIN');
    for (const record of records) {
      const values = [
        integer(record.ID_ESTABLECIMIENTO), record.NOMBRE_ESTABLECIMIENTO || null,
        record.UBIGUEO_ESTABLECIMIENTO || null, integer(record.CODIGO_DISA),
        record.DISA || null, record.CODIGO_RED || null, record.RED || null,
        record.CODIGO_MICRORED || null, record.MICRORED || null,
        record.CODIGO_UNICO || null, integer(record.CODIGO_SECTOR),
        record.DESCRIPCION_SECTOR || null, record.DEPARTAMENTO || null,
        record.PROVINCIA || null, record.DISTRITO || null,
        record.CATEGORIA_ESTABLECIMIENTO || null
      ];
      const updated = await execute(`
        UPDATE dbo.establecimientos SET
          nombre_establecimiento = ?, ubigueo_establecimiento = ?, codigo_disa = ?, disa = ?,
          codigo_red = ?, red = ?, codigo_microred = ?, microred = ?, codigo_unico = ?,
          codigo_sector = ?, descripcion_sector = ?, departamento = ?, provincia = ?,
          distrito = ?, categoria_establecimiento = ?
        WHERE id_establecimiento = ?
      `, [...values.slice(1), values[0]]);

      if (updated.rowCount === 0) {
      await execute(`
        INSERT INTO dbo.establecimientos (
          id_establecimiento, nombre_establecimiento, ubigueo_establecimiento,
          codigo_disa, disa, codigo_red, red, codigo_microred, microred,
          codigo_unico, codigo_sector, descripcion_sector, departamento,
          provincia, distrito, categoria_establecimiento
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, values);
      }
    }
    await execute('COMMIT');
    console.log(`Catálogo OGESS actualizado: ${records.length} establecimientos de Gobierno Regional en ${NETWORKS_OGESS.size} redes.`);
  } catch (error) {
    try { await execute('ROLLBACK'); } catch { /* no hay transacción abierta */ }
    console.error(`No se pudo importar el catálogo: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
