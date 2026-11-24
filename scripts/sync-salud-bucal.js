/** Recalcula únicamente Salud Bucal y conserva resultados de las demás estrategias. */
import { sincronizar, closePool } from '../services/engine.js';
const anio = Number(process.argv[2] || new Date().getFullYear());
sincronizar(anio, { soloEstrategia: 'SALUD_BUCAL' })
  .then((r) => { console.log(JSON.stringify(r, null, 2)); })
  .catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1; })
  .finally(async () => { await closePool(); process.exit(process.exitCode || 0); });
