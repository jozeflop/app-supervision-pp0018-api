import fs from 'node:fs';
import { query, execute, closePool } from '../db.js';

const source = process.argv[2] || process.env.INDICADORES_SQL_PATH;
if (!source) throw new Error('Indica el archivo SQL con INDICADORES_SQL_PATH o como primer argumento.');
const text = fs.readFileSync(source, 'utf8');
const indicators = [];
for (const line of text.split(/\r?\n/)) {
  const match = line.match(/^\s*(SP\d+)\s*=\s*(.+)$/i);
  if (!match || indicators.some((item) => item.codigo === match[1].toUpperCase())) continue;
  indicators.push({ codigo: match[1].toUpperCase(), expresion: match[2].trim() });
}
if (!indicators.length) throw new Error(`No se encontraron indicadores SP en ${source}`);

for (const item of indicators) {
  await execute(
    `INSERT INTO dbo.indicadores_nominales (codigo, nombre, anio, estado, expresion_origen, observaciones)
     VALUES (?, ?, 2027, 'PENDIENTE_REVISION', ?, ?)
     ON CONFLICT (codigo) DO UPDATE SET expresion_origen=EXCLUDED.expresion_origen, fecha_modificacion=CURRENT_TIMESTAMP`,
    [item.codigo, item.codigo, item.expresion, 'Importado del script SQL del ingeniero; requiere confirmación antes de activar.']
  );
}
console.log(JSON.stringify({ archivo: source, indicadores: indicators.length, estado: 'PENDIENTE_REVISION' }, null, 2));
await closePool();
