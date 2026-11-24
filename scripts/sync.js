/**
 * sync.js - Recalcula el staging y los resultados de supervision.
 * Uso: node scripts/sync.js [anio]
 */
import { sincronizar, closePool } from '../services/engine.js';

const anio = Number(process.argv[2] || new Date().getFullYear());

console.log(`Sincronizando supervision PP0018 - anio ${anio} ...`);
const t = Date.now();

sincronizar(anio)
  .then((r) => {
    console.log('\nResultado:');
    for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(20)} ${v}`);
    console.log(`\nTiempo total: ${((Date.now() - t) / 1000).toFixed(1)}s`);
  })
  .catch((e) => {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
    process.exit(process.exitCode || 0);
  });
