/**
 * importer.js
 * ---------------------------------------------------------------------------------------------
 * Inserta un lote de reglas (JSON crudo de la matriz o payload de la API) en el esquema
 * normalizado. Se usa desde scripts/seed-rules.js y desde POST /api/importar.
 */
import { query, execute } from '../db.js';
import { normalizarRegla, mapEstrategia } from './normalizer.js';

async function cargarCatalogos() {
  const estrategias = new Map();
  (await query('SELECT id_estrategia, codigo FROM dbo.Estrategias'))
    .forEach((r) => estrategias.set(r.codigo, r.id_estrategia));

  const unidades = new Map();
  (await query('SELECT id_unidad, codigo FROM dbo.UnidadesMedida'))
    .forEach((r) => unidades.set(r.codigo, r.id_unidad));

  return { estrategias, unidades };
}

/**
 * @param {Array<object>} lista Reglas en formato original (o formulario).
 * @param {{reemplazar?: boolean}} opciones
 */
export async function importarReglas(lista, { reemplazar = true } = {}) {
  if (!Array.isArray(lista) || lista.length === 0) {
    throw Object.assign(new Error('La lista de reglas está vacía'), { status: 400 });
  }

  const { estrategias, unidades } = await cargarCatalogos();
  const stats = {
    insertadas: 0,
    inclusiones: 0,
    exclusiones: 0,
    requeridos: 0,
    subproductos: 0,
    sin_codigos: 0
  };

  await execute('BEGIN TRANSACTION');
  try {
    if (reemplazar) {
      await execute('DELETE FROM dbo.SupervisionResultados');
      await execute('DELETE FROM dbo.SyncEstado');
      await execute('DELETE FROM dbo.ReglaCodigos');
      await execute('DELETE FROM dbo.Reglas');
      await execute('DELETE FROM dbo.Subproductos');
      await execute('DELETE FROM dbo.Productos');
    }

    const subproductos = new Map();

    for (const item of lista) {
      const estrategiaCodigo = mapEstrategia(item.estrategia || item.estrategia_codigo);
      const idEstrategia = estrategias.get(estrategiaCodigo);
      if (!idEstrategia) throw new Error(`Estrategia no encontrada: ${estrategiaCodigo}`);

      const n = normalizarRegla(item, estrategiaCodigo);
      const idUnidad = unidades.get(n.subproducto.unidadCodigo) || unidades.get('ATENCION');

      const subKey = `${idEstrategia}|${n.subproducto.nombre}`;
      let idSubproducto = subproductos.get(subKey);
      if (!idSubproducto) {
        const rows = await query(
          `INSERT INTO dbo.Subproductos (id_estrategia, codigo, nombre, id_unidad)
           OUTPUT INSERTED.id_subproducto
           VALUES (?, ?, ?, ?)`,
          [idEstrategia, n.subproducto.codigo, n.subproducto.nombre, idUnidad]
        );
        idSubproducto = rows[0].id_subproducto;
        subproductos.set(subKey, idSubproducto);
        stats.subproductos++;
      }

      const reglaRows = await query(
        `INSERT INTO dbo.Reglas (
            codigo_origen, id_subproducto, fuente, proceso, tipo_dx, valor_lab, lab_modo,
            lab_min, lab_max, lab_min_incl, lab_max_incl,
            edad_min_meses, edad_max_meses, condicion_sexo, solo_gestante, excluir_gestante,
            id_financiador, id_ups, pab_op, pab_femenino, pab_masculino,
            id_unidad, restriccion, nivel_restriccion, regla_original
         )
         OUTPUT INSERTED.id_regla
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id || item.codigo_origen || null,
          idSubproducto,
          n.fuente,
          n.proceso,
          n.tipo_dx,
          n.valor_lab,
          n.lab_modo,
          n.lab_min,
          n.lab_max,
          n.lab_min_incl,
          n.lab_max_incl,
          n.edad_min_meses,
          n.edad_max_meses,
          n.condicion_sexo,
          n.solo_gestante,
          n.excluir_gestante,
          n.id_financiador,
          n.id_ups,
          n.pab_op,
          n.pab_femenino,
          n.pab_masculino,
          unidades.get(n.subproducto.unidadCodigo) || idUnidad,
          n.restriccion,
          n.nivel_restriccion,
          n.regla_original
        ]
      );
      const idRegla = reglaRows[0].id_regla;
      stats.insertadas++;

      if (n.inclusiones.length === 0 && n.exclusiones.length === 0) stats.sin_codigos++;

      for (const inc of n.inclusiones) {
        await execute(
          'INSERT INTO dbo.ReglaCodigos (id_regla, codigo, tipo_codigo, es_exclusion) VALUES (?, ?, ?, 0)',
          [idRegla, inc.code, inc.tipo]
        );
        stats.inclusiones++;
      }
      for (const exc of n.exclusiones) {
        await execute(
          'INSERT INTO dbo.ReglaCodigos (id_regla, codigo, tipo_codigo, es_exclusion) VALUES (?, ?, ?, 1)',
          [idRegla, exc, 'CPT']
        );
        stats.exclusiones++;
      }
      for (const req of n.requeridos) {
        await execute(
          `INSERT INTO dbo.ReglaCodigos
             (id_regla, codigo, tipo_codigo, es_exclusion, es_requerido, grupo, valor_lab, tipo_dx)
           VALUES (?, ?, ?, 0, 1, ?, ?, ?)`,
          [idRegla, req.codigo, req.tipo, req.grupo, req.valor_lab, req.tipo_dx]
        );
        stats.requeridos++;
      }
    }

    await execute('COMMIT');
    return stats;
  } catch (err) {
    try { await execute('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}
