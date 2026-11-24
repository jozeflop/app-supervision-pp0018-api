import { refreshStaging, calcular, closePool } from '../services/engine.js';
import { query } from '../db.js';

const anio = Number(process.argv[2] || 2026);

console.log('Refrescando staging', anio, '...');
let t = Date.now();
const filas = await refreshStaging(anio);
console.log(`Staging listo: ${filas} filas en ${((Date.now() - t) / 1000).toFixed(1)}s`);

console.log('\nMuestra staging:');
for (const r of await query('SELECT * FROM dbo.StgAtenciones LIMIT 5')) console.log(r);

console.log('\nCalculando reglas...');
t = Date.now();
const calc = await calcular(anio);
console.log(`Reglas: ${JSON.stringify(calc)} en ${((Date.now() - t) / 1000).toFixed(1)}s`);

console.log('\nTop resultados:');
for (const r of await query(`
  SELECT v.estrategia, v.subproducto, v.unidad_medida, SUM(r.valor) total
  FROM dbo.SupervisionResultados r JOIN dbo.vw_ReglasCompletas v ON v.id_regla = r.id_regla
  WHERE r.anio = ?
  GROUP BY v.estrategia, v.subproducto, v.unidad_medida
  ORDER BY total DESC LIMIT 10`, [anio])) {
  console.log(`  ${String(r.total).padStart(8)} | ${r.estrategia} | ${String(r.subproducto).slice(0, 60)}`);
}

await closePool();
process.exit(0);
