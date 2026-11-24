/**
 * seed-rules.js
 * ---------------------------------------------------------------------------------
 * Carga las reglas de extracción PP0018 en el esquema normalizado de
 * BD_SUPERVISION_PP0018. Por defecto usa Reglas_Extraccion_PP0018_TODAS.json
 * (333 base + 39 No Transmisible/Hipertensión); si no existe, el JSON base.
 *
 * Uso:  node scripts/seed-rules.js [ruta-al-json]
 *
 * La lógica de importación vive en services/importer.js (compartida con la API).
 */
import fs from 'node:fs';
import { query, closePool } from '../db.js';
import { importarReglas } from '../services/importer.js';

const JSON_PATH = process.argv[2] || process.env.RULES_JSON_PATH;

async function main() {
  if (!JSON_PATH) throw new Error('Indica el archivo JSON con RULES_JSON_PATH o como primer argumento.');
  console.log('Leyendo', JSON_PATH);
  const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  console.log(`Reglas encontradas: ${raw.length}`);

  const stats = await importarReglas(raw, { reemplazar: true });

  console.log('---------------------------------------------');
  console.log(`Reglas insertadas      : ${stats.insertadas}`);
  console.log(`Codigos inclusion      : ${stats.inclusiones}`);
  console.log(`Codigos requeridos     : ${stats.requeridos}`);
  console.log(`Codigos exclusion      : ${stats.exclusiones}`);
  console.log(`Subproductos creados   : ${stats.subproductos}`);
  console.log(`Reglas sin codigos     : ${stats.sin_codigos}`);
  console.log('---------------------------------------------');

  const porEstrategia = await query(`
    SELECT e.nombre AS estrategia,
           COUNT(DISTINCT r.id_regla) AS reglas,
           SUM(CASE WHEN rc.es_exclusion = 0 AND rc.es_requerido = 0 THEN 1 ELSE 0 END) AS inclusiones,
           SUM(CASE WHEN rc.es_requerido = 1 THEN 1 ELSE 0 END) AS requeridos,
           SUM(CASE WHEN rc.es_exclusion = 1 THEN 1 ELSE 0 END) AS exclusiones
    FROM dbo.Reglas r
      JOIN dbo.Subproductos s ON s.id_subproducto = r.id_subproducto
      JOIN dbo.Estrategias e  ON e.id_estrategia = s.id_estrategia
      LEFT JOIN dbo.ReglaCodigos rc ON rc.id_regla = r.id_regla
    GROUP BY e.nombre ORDER BY e.nombre`);

  for (const row of porEstrategia) {
    console.log(`  ${String(row.estrategia).padEnd(18)} reglas=${String(row.reglas).padStart(4)}  incl=${String(row.inclusiones || 0).padStart(5)}  req=${String(row.requeridos || 0).padStart(4)}  excl=${String(row.exclusiones || 0).padStart(4)}`);
  }
  console.log('\nSeed completado.');
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('ERROR:', err.message);
    await closePool().catch(() => {});
    process.exit(1);
  });
