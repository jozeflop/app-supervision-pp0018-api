import fs from 'node:fs';
import XLSX from 'xlsx';
import { query, execute, closePool } from '../db.js';
import { mapEstrategia, mapUnidad, normalizarRegla } from '../services/normalizer.js';

const filePath = process.argv[2] || process.env.MATRIZ_2027_PATH;

if (!filePath) throw new Error('Indica el archivo XLSX con MATRIZ_2027_PATH o como primer argumento.');

const text = (value) => String(value ?? '').trim();
const codePattern = /\b(?:[A-Z]\d{2,4}(?:\.\d{1,2})?|\d{5}(?:\.\d{1,2})?)\b/gi;

function codesFromCriterion(value) {
  const seen = new Set();
  return [...text(value).matchAll(codePattern)]
    .map((m) => m[0].toUpperCase())
    .filter((code) => {
      if (seen.has(code)) return false;
      seen.add(code);
      return true;
    });
}

function rowToSource(row, rowNumber) {
  const criterio = text(row['CRITERIO PARA DEFINIR EL AVANCE O CUMPLIMIENTO DE LA META FISICA, INCLUYE FUENTE.']);
  const codigoProducto = text(row.COD_PROD);
  const nombreProducto = text(row['NOMBRE DEL PRODUCTO']);
  const codigoSubproducto = text(row['COD_SUB PRODUCTO']);
  const nombreSubproducto = text(row['NOMBRE DEL SUBPRODUCTO']);
  const estrategia = text(row['NOMBRE DEL PROGRAMA']) || '0018 ENFERMEDADES NO TRANSMISIBLES';
  const unidad = text(row['UNIDAD DE MEDIDA_2']) || text(row['UNIDAD DE MEDIDA_1']) || text(row['UNIDAD DE MEDIDA']);
  const actividad = text(row['NOMBRE DE ACTIVIDAD']).slice(0, 150);
  const fuente = text(row['FUENTE DE INFORMACIÓN']).slice(0, 80);
  const definicion = text(row['DEFINICIÓN OPERACIONAL SUB PRODUCTO']);
  const programacion = text(row['CRITERIO DE PROGRAMACIÓN']);
  const reglaOriginal = [criterio, definicion, programacion].filter(Boolean).join('\n');
  const codigos = codesFromCriterion(criterio);

  return {
    rowNumber,
    estrategia,
    estrategiaCodigo: mapEstrategia(estrategia),
    codigoProducto,
    nombreProducto,
    codigoSubproducto,
    nombreSubproducto,
    unidad,
    actividad,
    fuente,
    criterio,
    reglaOriginal,
    codigos,
    raw: row
  };
}

async function getIdEstrategia(codigo, nombre) {
  const rows = await query('SELECT id_estrategia FROM dbo.Estrategias WHERE codigo = ?', [codigo]);
  if (rows[0]) return rows[0].id_estrategia;
  throw new Error(`Estrategia no encontrada: ${codigo} (${nombre})`);
}

async function getOrCreateProduct(source, idEstrategia) {
  const existing = await query(
    'SELECT id_producto FROM dbo.Productos WHERE id_estrategia = ? AND codigo = ? LIMIT 1',
    [idEstrategia, source.codigoProducto || null]
  );
  if (existing[0]) return existing[0].id_producto;
  const rows = await query(
    `INSERT INTO dbo.Productos (id_estrategia, codigo, nombre, tipo_atencion)
     VALUES (?, ?, ?, ?) RETURNING id_producto`,
    [idEstrategia, source.codigoProducto || null, source.nombreProducto || source.codigoProducto, source.unidad]
  );
  return rows[0].id_producto;
}

async function getOrCreateSubproduct(source, idEstrategia, idProducto) {
  const idUnidad = (await query('SELECT id_unidad FROM dbo.UnidadesMedida WHERE codigo = ?', [mapUnidad(source.unidad)]))[0]?.id_unidad;
  if (!idUnidad) throw new Error(`Unidad no encontrada para fila ${source.rowNumber}`);
  const existing = await query(
    'SELECT id_subproducto FROM dbo.Subproductos WHERE id_estrategia = ? AND codigo = ? LIMIT 1',
    [idEstrategia, source.codigoSubproducto || null]
  );
  if (existing[0]) {
    await execute(
      'UPDATE dbo.Subproductos SET id_producto = ?, nombre = ?, id_unidad = ?, activo = TRUE WHERE id_subproducto = ?',
      [idProducto, source.nombreSubproducto, idUnidad, existing[0].id_subproducto]
    );
    return existing[0].id_subproducto;
  }
  const rows = await query(
    `INSERT INTO dbo.Subproductos (id_producto, id_estrategia, codigo, nombre, id_unidad)
     VALUES (?, ?, ?, ?, ?) RETURNING id_subproducto`,
    [idProducto, idEstrategia, source.codigoSubproducto || null, source.nombreSubproducto, idUnidad]
  );
  return rows[0].id_subproducto;
}

async function insertRule(source, idSubproducto) {
  const normalized = normalizarRegla({
    estrategia: source.estrategia,
    subproducto: `${source.codigoSubproducto} ${source.nombreSubproducto}`,
    unidad_medida: source.unidad,
    fuente: source.fuente,
    proceso: source.actividad,
    regla_original: source.reglaOriginal,
    codigos: source.codigos.join(','),
    tipo_dx: source.criterio
  }, source.estrategiaCodigo);

  if (!normalized.inclusiones.length && !normalized.exclusiones.length) return null;
  const rows = await query(
    `INSERT INTO dbo.Reglas (
       codigo_origen, id_subproducto, fuente, proceso, tipo_dx, valor_lab, lab_modo,
       lab_min, lab_max, lab_min_incl, lab_max_incl, edad_min_meses, edad_max_meses,
       condicion_sexo, solo_gestante, excluir_gestante, id_financiador, id_ups,
       pab_op, pab_femenino, pab_masculino, id_unidad, restriccion, nivel_restriccion, regla_original
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id_regla`,
    [
      `matriz_2027_fila_${source.rowNumber}`, idSubproducto, normalized.fuente, normalized.proceso,
      normalized.tipo_dx, normalized.valor_lab, normalized.lab_modo, normalized.lab_min,
      normalized.lab_max, normalized.lab_min_incl, normalized.lab_max_incl, normalized.edad_min_meses,
      normalized.edad_max_meses, normalized.condicion_sexo, normalized.solo_gestante,
      normalized.excluir_gestante, normalized.id_financiador, normalized.id_ups, normalized.pab_op,
      normalized.pab_femenino, normalized.pab_masculino, null, normalized.restriccion,
      normalized.nivel_restriccion, normalized.regla_original
    ]
  );
  const idRegla = rows[0].id_regla;
  for (const item of normalized.inclusiones) {
    await execute('INSERT INTO dbo.ReglaCodigos (id_regla, codigo, tipo_codigo, es_exclusion) VALUES (?, ?, ?, FALSE)', [idRegla, item.code, item.tipo]);
  }
  for (const item of normalized.exclusiones) {
    await execute('INSERT INTO dbo.ReglaCodigos (id_regla, codigo, tipo_codigo, es_exclusion) VALUES (?, ?, ?, TRUE)', [idRegla, item, 'CPT']);
  }
  return idRegla;
}

async function main() {
  if (!fs.existsSync(filePath)) throw new Error(`No existe el archivo: ${filePath}`);
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = workbook.SheetNames.find((name) => name === '2027') || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false, range: 0 });
  const sources = rows.map((row, index) => rowToSource(row, index + 2)).filter((row) => row.codigoSubproducto && row.nombreSubproducto);

  await execute('BEGIN');
  let importId;
  try {
    const importRows = await query(
      `INSERT INTO dbo.matriz_importaciones (archivo, anio, hoja) VALUES (?, ?, ?) RETURNING id_importacion`,
      [path.basename(filePath), 2027, sheetName]
    );
    importId = importRows[0].id_importacion;
    await execute('DELETE FROM dbo.SupervisionResultados');
    await execute('DELETE FROM dbo.SyncEstado');
    await execute('DELETE FROM dbo.ReglaCodigos');
    await execute('DELETE FROM dbo.Reglas');
    await execute('DELETE FROM dbo.Subproductos');
    await execute('DELETE FROM dbo.Productos');

    const strategies = new Map();
    const products = new Map();
    const subs = new Map();
    let catalogRows = 0;
    let ruleRows = 0;
    let pendingRows = 0;

    for (const source of sources) {
      const idEstrategia = strategies.get(source.estrategiaCodigo) || await getIdEstrategia(source.estrategiaCodigo, source.estrategia);
      strategies.set(source.estrategiaCodigo, idEstrategia);
      const productKey = `${idEstrategia}|${source.codigoProducto}`;
      const idProducto = products.get(productKey) || await getOrCreateProduct(source, idEstrategia);
      products.set(productKey, idProducto);
      const subKey = `${idEstrategia}|${source.codigoSubproducto}`;
      const idSubproducto = subs.get(subKey) || await getOrCreateSubproduct(source, idEstrategia, idProducto);
      subs.set(subKey, idSubproducto);
      catalogRows++;

      const idRegla = await insertRule(source, idSubproducto);
      if (idRegla) {
        ruleRows++;
      } else {
        pendingRows++;
        await execute(
          `INSERT INTO dbo.matriz_pendientes
             (id_importacion, fila_excel, codigo_producto, codigo_subproducto, nombre_subproducto, motivo, detalle, datos_originales)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)`,
          [importId, source.rowNumber, source.codigoProducto, source.codigoSubproducto, source.nombreSubproducto,
            source.codigos.length ? 'REGLA_NO_GENERADA' : 'SIN_CODIGOS_EN_CRITERIO', source.criterio, JSON.stringify(source.raw)]
        );
      }
    }

    await execute(
      `UPDATE dbo.matriz_importaciones
       SET finalizada = CURRENT_TIMESTAMP, filas_leidas = ?, filas_catalogo = ?, filas_reglas = ?, filas_pendientes = ?, estado = 'OK'
       WHERE id_importacion = ?`,
       [rows.length, catalogRows, ruleRows, pendingRows, importId]
    );
    await execute('COMMIT');
    console.log(JSON.stringify({ archivo: filePath, hoja: sheetName, filasLeidas: rows.length, catalogo: catalogRows, reglas: ruleRows, pendientes: pendingRows }, null, 2));
  } catch (error) {
    try { await execute('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

main().catch((error) => {
  console.error('ERROR:', error.message);
  process.exitCode = 1;
}).finally(() => closePool());
