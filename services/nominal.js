/**
 * nominal.js - Reporte nominal (pacientes atendidos por actividad)
 * ------------------------------------------------------------------------------------------
 * Reutiliza el compilador de condiciones del motor (engine.js) para que el listado nominal
 * coincida exactamente con los totales de SupervisionResultados.
 *
 * Granularidad: una fila por cita (id_cita). Si varias reglas de la misma actividad
 * coinciden, sus condiciones se unen con OR y la cita se cuenta una sola vez.
 *
 * Fuente: dbo.StgAtenciones (enriquecido en refreshStaging con fecha, DNI y nombre).
 * Los datos de Red/MicroRed/Establecimiento se resuelven contra el catalogo OGESSBM.
 */
import { query } from '../db.js';
import { compilarCondiciones } from './engine.js';

const CATALOG_DB = process.env.DB_CATALOG_DATABASE || 'OGESSBM';

// SQL Server admite 2100 parametros por consulta; se deja margen para los identificadores.
const MAX_PARAMS_LOTE = 1500;
const MAX_ACTIVIDADES_LOTE = 30;

/* ------------------------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------------------------ */

function sqlIn(valores) {
  return valores.map(() => '?').join(', ');
}

/**
 * Codigos normalizados realmente presentes en el staging del anio.
 * Permite expandir los prefijos CIE a listas IN indexadas (evita LIKE masivos).
 */
async function cargarCodigosHis(anio) {
  const filas = await query(
    'SELECT DISTINCT codigo_norm, UPPER(BTRIM(codigo_item)) AS codigo_item FROM dbo.StgAtenciones WHERE anio = ? AND codigo_norm IS NOT NULL',
    [Number(anio)]
  );
  return { norm: new Set(filas.map((f) => f.codigo_norm)), exact: new Set(filas.map((f) => f.codigo_item)) };
}

function actividadCompilada(reglas, anio, codigosHis) {
  const condiciones = [];
  const params = [];

  for (const { regla, codigos } of reglas) {
    const compilada = compilarCondiciones(regla, codigos, anio, codigosHis);
    if (!compilada) continue;
    condiciones.push(`(${compilada.condiciones.map((w) => `(${w})`).join(' AND ')})`);
    params.push(...compilada.params);
  }

  if (!condiciones.length) return null;
  return { filtro: condiciones.join(' OR '), params };
}

function filtrosNominales(alias, opciones) {
  const condiciones = [];
  const params = [];
  if (opciones.mes) {
    condiciones.push(alias + ".mes = ?");
    params.push(Number(opciones.mes));
  }
  if (opciones.idEstablecimiento) {
    condiciones.push(alias + ".id_establecimiento = ?");
    params.push(Number(opciones.idEstablecimiento));
  }
  if (opciones.red) {
    condiciones.push("EXISTS (SELECT 1 FROM [" + CATALOG_DB + "].[dbo].[Establecimientos] er WHERE er.Id_Establecimiento = " + alias + ".id_establecimiento AND LOWER(BTRIM(er.Red)) = LOWER(?))");
    params.push(String(opciones.red).trim());
  }
  if (opciones.microred) {
    condiciones.push("EXISTS (SELECT 1 FROM [" + CATALOG_DB + "].[dbo].[Establecimientos] em WHERE em.Id_Establecimiento = " + alias + ".id_establecimiento AND LOWER(BTRIM(em.MicroRed)) = LOWER(?))");
    params.push(String(opciones.microred).trim());
  }
  return { sql: condiciones.length ? condiciones.join(" AND ") : "1 = 1", params };
}

async function cargarReglas(idsSubproducto) {
  const mapa = new Map();
  if (!idsSubproducto.length) return mapa;

  const marcas = sqlIn(idsSubproducto);
  const reglasSql = [
    "SELECT v.id_regla,v.id_subproducto,v.fuente,v.tipo_dx,v.valor_lab,v.lab_modo,v.lab_min,v.lab_max,v.lab_min_incl,v.lab_max_incl,v.edad_min_meses,v.edad_max_meses,v.condicion_sexo,v.solo_gestante,v.excluir_gestante,v.id_financiador,v.id_ups,v.pab_op,v.pab_femenino,v.pab_masculino,v.tipo_agregacion,r.id_condicion_servicio,r.requiere_dni",
    "FROM dbo.vw_ReglasCompletas v JOIN dbo.Reglas r ON r.id_regla=v.id_regla WHERE v.activo=TRUE AND v.id_subproducto IN (" + marcas + ")"
  ].join(" ");
  const reglas = await query(reglasSql, idsSubproducto);

  const codigos = await query(
    `SELECT rc.id_regla, rc.codigo, rc.codigo_norm, rc.es_categoria, rc.tipo_codigo,
            rc.es_exclusion, rc.es_requerido, rc.grupo, rc.valor_lab, rc.tipo_dx
     FROM dbo.ReglaCodigos rc
       INNER JOIN dbo.Reglas r ON r.id_regla = rc.id_regla
     WHERE r.id_subproducto IN (${marcas})`,
    idsSubproducto
  );

  const codigosPorRegla = new Map();
  for (const c of codigos) {
    if (!codigosPorRegla.has(c.id_regla)) codigosPorRegla.set(c.id_regla, []);
    codigosPorRegla.get(c.id_regla).push(c);
  }

  for (const regla of reglas) {
    if (!mapa.has(regla.id_subproducto)) mapa.set(regla.id_subproducto, []);
    mapa.get(regla.id_subproducto).push({
      regla,
      codigos: codigosPorRegla.get(regla.id_regla) || []
    });
  }

  return mapa;
}

/* ------------------------------------------------------------------------------------------ *
 * Actividades de una estrategia
 * ------------------------------------------------------------------------------------------ */

export async function listarActividades(estrategia, anio, opciones = {}) {
  const filtrosStaging = filtrosNominales('s', opciones);
  const codigo = String(estrategia || '').trim().toUpperCase();
  const est = await query(
    `SELECT id_estrategia, codigo, nombre
     FROM dbo.Estrategias
     WHERE UPPER(codigo) = ? AND activo = 1`,
    [codigo]
  );
  if (!est.length) return null;

  const subproductos = await query(
    `SELECT s.id_subproducto, s.id_producto, p.nombre AS producto, s.codigo, s.nombre,
            u.codigo AS unidad, u.tipo_agregacion
     FROM dbo.Subproductos s
       LEFT JOIN dbo.Productos p ON p.id_producto = s.id_producto
       LEFT JOIN dbo.UnidadesMedida u ON u.id_unidad = s.id_unidad
     WHERE s.id_estrategia = ? AND s.activo = 1
     ORDER BY s.nombre`,
    [est[0].id_estrategia]
  );

  const reglas = await cargarReglas(subproductos.map((s) => s.id_subproducto));
  const codigosHis = await cargarCodigosHis(anio);

  const compiladas = new Map();
  for (const s of subproductos) {
    const compilada = actividadCompilada(reglas.get(s.id_subproducto) || [], anio, codigosHis);
    if (compilada) compiladas.set(s.id_subproducto, compilada);
  }

  // Conteo de citas por actividad en lotes (una sola pasada por lote).
  const totales = new Map();
  const pendientes = [...compiladas.entries()];
  let indice = 0;

  while (indice < pendientes.length) {
    const partes = [];
    const params = [];
    let enLote = 0;

    while (indice < pendientes.length) {
      const [idSubproducto, compilada] = pendientes[indice];
      const peso = 1 + compilada.params.length + filtrosStaging.params.length;
      if (partes.length && (enLote >= MAX_ACTIVIDADES_LOTE || params.length + peso > MAX_PARAMS_LOTE)) break;

      partes.push(
        `SELECT CAST(? AS INT) AS id_subproducto, s.id_cita
         FROM dbo.StgAtenciones s
         WHERE (${compilada.filtro}) AND (${filtrosStaging.sql})`
      );
      params.push(idSubproducto, ...compilada.params, ...filtrosStaging.params);
      enLote += 1;
      indice += 1;
    }

    const filas = await query(
      `SELECT t.id_subproducto, COUNT(DISTINCT t.id_cita) AS total
       FROM (${partes.join(' UNION ALL ')}) t
       GROUP BY t.id_subproducto`,
      params
    );
    for (const fila of filas) totales.set(fila.id_subproducto, fila.total || 0);
  }

  /*
   * Total oficial: se toma de SupervisionResultados, la misma fuente que alimenta la
   * columna "Resultado" de ESTRATEGIAS. Asi el reporte nominal y la supervision muestran
   * exactamente el mismo numero, aunque la lista de atenciones se pagine por cita.
   */
  const filtrosOficiales = filtrosNominales('vr', opciones);
  const oficiales = await query(
    `SELECT r.id_subproducto, ISNULL(SUM(vr.valor), 0) AS total
     FROM dbo.SupervisionResultados vr
       INNER JOIN dbo.Reglas r ON r.id_regla = vr.id_regla
       INNER JOIN dbo.Subproductos s ON s.id_subproducto = r.id_subproducto
     WHERE vr.anio = ? AND s.id_estrategia = ? AND s.activo = 1 AND r.activo = 1
       AND (${filtrosOficiales.sql})
     GROUP BY r.id_subproducto`,
    [Number(anio), est[0].id_estrategia, ...filtrosOficiales.params]
  );
  const totalOficial = new Map(oficiales.map((f) => [f.id_subproducto, f.total || 0]));

  return {
    estrategia: { codigo: est[0].codigo, nombre: est[0].nombre },
    anio: Number(anio),
    actividades: subproductos.map((s) => ({
      id_subproducto: s.id_subproducto,
      id_producto: s.id_producto || null,
      producto: s.producto || null,
      codigo: s.codigo,
      nombre: s.nombre,
      unidad: s.unidad || null,
      tipo_agregacion: s.tipo_agregacion || null,
      reglas: (reglas.get(s.id_subproducto) || []).length,
      reglas_compiladas: compiladas.has(s.id_subproducto) ? 1 : 0,
      estado_sintaxis: !(reglas.get(s.id_subproducto) || []).length ? 'PENDIENTE_SINTAXIS' : compiladas.has(s.id_subproducto) ? 'CONFIRMADA' : 'SIN_COINCIDENCIAS_EN_FUENTE',
      total_oficial: (reglas.get(s.id_subproducto) || []).length ? (totalOficial.get(s.id_subproducto) || 0) : null,
      total: (reglas.get(s.id_subproducto) || []).length ? (totalOficial.has(s.id_subproducto) ? (totalOficial.get(s.id_subproducto) || 0) : (totales.get(s.id_subproducto) || 0)) : null,
      total_citas: (reglas.get(s.id_subproducto) || []).length ? (totales.get(s.id_subproducto) || 0) : null
    }))
  };
}

/* ------------------------------------------------------------------------------------------ *
 * Actividad + estrategia (para validar permisos antes de listar pacientes)
 * ------------------------------------------------------------------------------------------ */

export async function obtenerActividad(idSubproducto) {
  const filas = await query(
    `SELECT s.id_subproducto, s.codigo, s.nombre,
            e.codigo AS estrategia_codigo, e.nombre AS estrategia,
            u.codigo AS unidad, u.tipo_agregacion
     FROM dbo.Subproductos s
       INNER JOIN dbo.Estrategias e ON e.id_estrategia = s.id_estrategia
       LEFT JOIN dbo.UnidadesMedida u ON u.id_unidad = s.id_unidad
     WHERE s.id_subproducto = ?`,
    [Number(idSubproducto)]
  );
  return filas[0] || null;
}

/* ------------------------------------------------------------------------------------------ *
 * Pacientes (atenciones) de una actividad
 * ------------------------------------------------------------------------------------------ */

export async function listarPacientes(actividad, opciones) {
  const {
    anio,
    mes = null,
    red = null,
    microred = null,
    idEstablecimiento = null,
    buscar = null,
    page = 1,
    pageSize = 50
  } = opciones;

  const reglas = await cargarReglas([actividad.id_subproducto]);
  const codigosHis = await cargarCodigosHis(anio);
  const compilada = actividadCompilada(reglas.get(actividad.id_subproducto) || [], anio, codigosHis);

  const base = {
    actividad: {
      id_subproducto: actividad.id_subproducto,
      codigo: actividad.codigo,
      nombre: actividad.nombre,
      estrategia: actividad.estrategia,
      estrategia_codigo: actividad.estrategia_codigo,
      unidad: actividad.unidad || null,
      tipo_agregacion: actividad.tipo_agregacion || null
    },
    anio: Number(anio),
    page: Number(page),
    pageSize: Number(pageSize)
  };

  if (!compilada) {
    return { ...base, total: 0, total_oficial: 0, pacientes: [] };
  }

  const condiciones = [compilada.filtro];
  const params = [...compilada.params];

  if (mes) {
    condiciones.push('s.mes = ?');
    params.push(Number(mes));
  }
  if (idEstablecimiento) {
    condiciones.push('s.id_establecimiento = ?');
    params.push(Number(idEstablecimiento));
  }
  if (red) {
    condiciones.push(`EXISTS (SELECT 1 FROM [${CATALOG_DB}].[dbo].[Establecimientos] er WHERE er.Id_Establecimiento = s.id_establecimiento AND LOWER(LTRIM(RTRIM(COALESCE(er.Red, '')))) = LOWER(?))`);
    params.push(String(red).trim());
  }
  if (microred) {
    condiciones.push(`EXISTS (SELECT 1 FROM [${CATALOG_DB}].[dbo].[Establecimientos] em WHERE em.Id_Establecimiento = s.id_establecimiento AND LOWER(LTRIM(RTRIM(COALESCE(em.MicroRed, '')))) = LOWER(?))`);
    params.push(String(microred).trim());
  }

  const whereStaging = condiciones.map((c) => `(${c})`).join(' AND ');
  const textoBusqueda = buscar ? String(buscar).trim() : '';

  const filtroBusqueda = textoBusqueda
    ? `(c.paciente_nombre LIKE ? OR c.numero_documento LIKE ?
        OR e.Nombre_Establecimiento LIKE ? OR e.Red LIKE ? OR e.MicroRed LIKE ?)`
    : '1 = 1';
  const paramsBusqueda = textoBusqueda ? Array(5).fill(`%${textoBusqueda}%`) : [];

  const cte = `
    WITH citas AS (
      SELECT s.id_cita,
             MAX(s.fecha_atencion)     AS fecha_atencion,
             MAX(s.id_establecimiento) AS id_establecimiento,
             MAX(s.id_paciente)        AS id_paciente,
             MAX(s.numero_documento)   AS numero_documento,
             MAX(s.paciente_nombre)    AS paciente_nombre,
             MAX(s.edad_meses)         AS edad_meses,
             MAX(s.genero)             AS genero
      FROM dbo.StgAtenciones s
      WHERE ${whereStaging}
      GROUP BY s.id_cita
    )`;

  const desde = `
    FROM citas c
      LEFT JOIN [${CATALOG_DB}].[dbo].[Establecimientos] e
        ON e.Id_Establecimiento = c.id_establecimiento`;

  const totalRows = await query(
    `${cte}
     SELECT COUNT(*) AS total
     ${desde}
     WHERE ${filtroBusqueda}`,
    [...params, ...paramsBusqueda]
  );

  /*
   * Resultado oficial con la misma agregacion del motor (mes + establecimiento + unidad).
   * La lista paginada sigue mostrando una fila por cita; este total es el que debe
   * coincidir con la columna "Resultado" de ESTRATEGIAS.
   */
  const paramsOficial = [Number(anio), actividad.id_subproducto];
  let filtroOficial = 'vr.anio = ? AND r.id_subproducto = ? AND r.activo = 1';
  if (mes) { filtroOficial += ' AND vr.mes = ?'; paramsOficial.push(Number(mes)); }
  if (idEstablecimiento) { filtroOficial += ' AND vr.id_establecimiento = ?'; paramsOficial.push(Number(idEstablecimiento)); }
  if (red) {
    filtroOficial += ` AND EXISTS (SELECT 1 FROM [${CATALOG_DB}].[dbo].[Establecimientos] er WHERE er.Id_Establecimiento = vr.id_establecimiento AND LOWER(LTRIM(RTRIM(COALESCE(er.Red, '')))) = LOWER(?))`;
    paramsOficial.push(String(red).trim());
  }
  if (microred) {
    filtroOficial += ` AND EXISTS (SELECT 1 FROM [${CATALOG_DB}].[dbo].[Establecimientos] em WHERE em.Id_Establecimiento = vr.id_establecimiento AND LOWER(LTRIM(RTRIM(COALESCE(em.MicroRed, '')))) = LOWER(?))`;
    paramsOficial.push(String(microred).trim());
  }
  const oficialRows = await query(
    `SELECT ISNULL(SUM(vr.valor), 0) AS total
     FROM dbo.SupervisionResultados vr
       INNER JOIN dbo.Reglas r ON r.id_regla = vr.id_regla
     WHERE ${filtroOficial}`,
    paramsOficial
  );

  const offset = (Number(page) - 1) * Number(pageSize);
  const filas = await query(
    `${cte}
     SELECT c.id_cita,
            to_char(c.fecha_atencion, 'YYYY-MM-DD') AS fecha_atencion,
            c.id_establecimiento,
            e.Red                   AS red,
            e.MicroRed              AS microred,
            COALESCE(e.Nombre_Establecimiento, CONCAT('EESS ', c.id_establecimiento)) AS establecimiento,
            c.numero_documento      AS dni,
            c.paciente_nombre       AS paciente,
            c.edad_meses,
            CASE WHEN c.edad_meses IS NULL THEN NULL ELSE c.edad_meses / 12 END AS edad,
            CASE c.genero WHEN 'F' THEN 'Femenino' WHEN 'M' THEN 'Masculino' ELSE NULL END AS sexo
     ${desde}
     WHERE ${filtroBusqueda}
     ORDER BY c.fecha_atencion DESC, c.paciente_nombre ASC
     OFFSET ? LIMIT ?`,
    [...params, ...paramsBusqueda, offset, Number(pageSize)]
  );

  return {
    ...base,
    total: totalRows[0]?.total || 0,
    total_oficial: oficialRows[0]?.total || 0,
    pacientes: filas
  };
}
