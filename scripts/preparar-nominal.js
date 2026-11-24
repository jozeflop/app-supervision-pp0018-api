/**
 * preparar-nominal.js - Prepara el staging del reporte nominal.
 * ------------------------------------------------------------------------------------------
 * refreshStaging() reemplaza solo el anio solicitado, por lo que el staging puede contener
 * varios anios a la vez. Ejecutar despues de importar reglas nuevas o de cambiar el HIS.
 *
 * Uso:
 *   node scripts/preparar-nominal.js             # anio actual y anterior
 *   node scripts/preparar-nominal.js 2025 2026   # anios explicitos
 */
import { refreshStaging, refrescarAniosFuente, closePool } from '../services/engine.js';

const hoy = new Date().getFullYear();
const solicitados = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 2000);
const anios = solicitados.length ? [...new Set(solicitados)] : [hoy, hoy - 1];

try {
  for (const anio of anios) {
    const inicio = Date.now();
    process.stdout.write(`Preparando staging nominal ${anio} ... `);
    const filas = await refreshStaging(anio);
    console.log(`${filas} filas en ${((Date.now() - inicio) / 1000).toFixed(1)}s`);
  }

  await refrescarAniosFuente();
  console.log('Cache de anios actualizada.');
} catch (err) {
  console.error('\nERROR:', err.message);
  process.exitCode = 1;
} finally {
  await closePool();
  process.exit(process.exitCode || 0);
}
