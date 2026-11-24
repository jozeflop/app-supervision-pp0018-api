/**
 * engine.js - Motor de supervision PP0018
 * ------------------------------------------------------------------------------------------
 * Flujo:
 *   1. refreshStaging(anio)  copia a dbo.StgAtenciones solo las filas del HIS cuyo
 *                            CODIGO_ITEM pertenece al universo de codigos de las reglas.
 *   2. calcular(anio)        evalua las 333 reglas contra el staging y guarda los totales
 *                            en dbo.SupervisionResultados (granularidad regla/mes/establecimiento).
 *   3. sincronizar(anio)     orquesta 1+2 y registra el proceso en dbo.SyncEstado.
 *
 * Interpretacion de las reglas (ver README.md):
 *   - codigos CIE10  -> diagnosticos, se buscan en la misma cita (ID_CITA).
 *   - codigos CPMS/CPT -> procedimientos.
 *   - tipo_dx         -> se aplica a la fila de diagnostico si la regla tiene CIE10.
 *   - valor_lab       -> se aplica a la fila principal (procedimiento o diagnostico).
 *   - edad            -> en meses, comparacion inclusiva.
 *   - gestante        -> CONDICION_GESTANTE de la fila principal.
 *   - exclusiones     -> la cita no debe contener ninguno de los codigos marcados.
 */
import { query, execute, closePool } from '../db.js';

const SOURCE_DB = process.env.DB_SOURCE_DATABASE || 'DataHIS';

function reportSyncProgress(onProgress, update) {
  if (typeof onProgress !== 'function') return;
  try { onProgress({ ...update, actualizado: new Date().toISOString() }); } catch { /* el reporte no debe interrumpir la sincronización */ }
}

/* ------------------------------------------------------------------------------------------ *
 * 1. Staging
 * ------------------------------------------------------------------------------------------ */
export async function refreshStaging(anio, onProgress = null) {
  const anioNum = Number(anio);
  if (!Number.isInteger(anioNum)) throw new Error('Año no válido para staging');
  reportSyncProgress(onProgress, { porcentaje: 2, etapa: 'his', mensaje: 'Preparando datos HIS', detalle: 'Buscando códigos del año seleccionado.' });
  await execute('BEGIN');
  try {
    await execute("CREATE TEMP TABLE pp0018_his_codes ON COMMIT DROP AS SELECT DISTINCT btrim(codigo_item) AS codigo_item, upper(regexp_replace(btrim(codigo_item), '[. /-]', '', 'g')) AS codigo_norm FROM dbo.his_nominal WHERE anio::integer = ?", [anioNum]);
    await execute('CREATE INDEX ON pp0018_his_codes (codigo_item)');
    reportSyncProgress(onProgress, { porcentaje: 7, etapa: 'his', mensaje: 'Preparando códigos HIS', detalle: 'Códigos del año identificados; construyendo los filtros de las reglas.' });
    await execute("CREATE TEMP TABLE pp0018_used_codes ON COMMIT DROP AS SELECT hc.codigo_item FROM pp0018_his_codes hc WHERE EXISTS (SELECT 1 FROM dbo.reglacodigos rc WHERE rc.tipo_codigo IN ('CPT','CPMS') AND hc.codigo_norm=rc.codigo_norm) OR EXISTS (SELECT 1 FROM dbo.reglacodigos rc WHERE rc.tipo_codigo='CIE10' AND hc.codigo_norm LIKE rc.codigo_norm || '%')");
    await execute('CREATE INDEX ON pp0018_used_codes (codigo_item)');
    reportSyncProgress(onProgress, { porcentaje: 12, etapa: 'his', mensaje: 'Filtrando atenciones', detalle: 'Aplicando los códigos que usan las reglas de supervisión.' });
    await execute('DELETE FROM dbo.StgAtenciones WHERE anio = ?', [anioNum]);
    reportSyncProgress(onProgress, { porcentaje: 15, etapa: 'his', mensaje: 'Cargando atenciones HIS', detalle: 'El servidor está consultando y guardando las atenciones del año.' });
    const insertSql = [
      "INSERT INTO dbo.StgAtenciones (anio,mes,id_cita,fecha_atencion,id_establecimiento,id_paciente,numero_documento,paciente_nombre,id_financiador,id_ups,edad_meses,genero,codigo_item,tipo_diagnostico,valor_lab,perimetro_abdominal,condicion_gestante,id_condicion_servicio)",
      "SELECT h.anio::integer,h.mes::integer,h.id_cita,h.fecha_atencion,h.id_establecimiento,h.id_paciente,p.numero_documento,btrim(concat_ws(' ',p.apellido_paterno_paciente,p.apellido_materno_paciente,p.nombres_paciente)),h.id_financiador,NULLIF(btrim(h.id_ups),'')::integer,CASE h.tipo_edad WHEN 'A' THEN h.edad_reg*12 WHEN 'M' THEN h.edad_reg WHEN 'D' THEN h.edad_reg/30 ELSE NULL END,p.genero,btrim(h.codigo_item),h.tipo_diagnostico,h.valor_lab,h.pac,h.condicion_gestante,h.id_condicion_servicio",
      "FROM dbo.his_nominal h JOIN pp0018_used_codes u ON u.codigo_item=btrim(h.codigo_item) LEFT JOIN dbo.paciente p ON p.id_paciente=h.id_paciente",
      "WHERE h.anio::integer=?"
    ].join('\n');
    await execute(insertSql, [anioNum]);
    await execute('COMMIT');
  } catch (error) {
    try { await execute('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
  const rows = await query('SELECT COUNT(*) AS filas FROM dbo.StgAtenciones WHERE anio = ?', [anioNum]);
  const filas = Number(rows[0]?.filas || 0);
  reportSyncProgress(onProgress, { porcentaje: 60, etapa: 'reglas', mensaje: 'Atenciones HIS cargadas', detalle: filas.toLocaleString('es-PE') + ' filas listas; ahora se evalúan las reglas.', filas_procesadas: filas, total_filas: filas });
  return filas;
}

/* ------------------------------------------------------------------------------------------ *
 * 2. Evaluacion de reglas
 * ------------------------------------------------------------------------------------------ */
function sqlIn(valores) {
  return valores.map(() => '?').join(', ');
}

function splitTipos(valor) {
  return String(valor || '')
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => /^[DPR]$/.test(t));
}

/** Normaliza un CIE10 igual que la columna calculada codigo_norm. */
function normCodigo(codigo) {
  return String(codigo || '')
    .toUpperCase()
    .replace(/[.\s\-/']/g, '');
}

/**
 * Condicion SQL para un codigo de regla.
 *   CIE10      -> prefijo sobre StgAtenciones.codigo_norm (cubre X y subcodigos).
 *   CPT/CPMS   -> coincidencia exacta conservando el punto.
 */
function matchCodigo(alias, c, codigosHis, exact = false) {
  const tipo = String(c.tipo_codigo || '').toUpperCase();
  if (tipo === 'CIE10') {
    const pref = c.codigo_norm || normCodigo(c.codigo);
    if (codigosHis) {
      const codes = codigosHis.norm || codigosHis;
      const coincidencias = [...codes].filter((n) => n.startsWith(pref));
      if (!coincidencias.length) return null;
      return { sql: alias + '.codigo_norm IN (' + sqlIn(coincidencias) + ')', params: coincidencias };
    }
    return { sql: alias + '.codigo_norm LIKE ?', params: [pref + '%'] };
  }
  const codigo = String(c.codigo || '').trim().toUpperCase();
  if (exact) {
    if (codigosHis && codigosHis.exact && !codigosHis.exact.has(codigo)) return null;
    return { sql: 'UPPER(BTRIM(' + alias + '.codigo_item)) = ?', params: [codigo] };
  }
  const norm = c.codigo_norm || normCodigo(c.codigo);
  if (codigosHis) {
    const codes = codigosHis.norm || codigosHis;
    if (!codes.has(norm)) return null;
    return { sql: alias + '.codigo_norm = ?', params: [norm] };
  }
  return { sql: alias + '.codigo_item = ?', params: [c.codigo] };
}

function matchCodigos(alias, lista, codigosHis, exact = false) {
  return lista.map((c) => matchCodigo(alias, c, codigosHis, exact)).filter(Boolean);
}

function numericLabSql(alias) {
  const value = 'btrim(' + alias + '.valor_lab)';
  const quote = String.fromCharCode(39);
  return 'CASE WHEN ' + value + ' ~ ' + quote + '^-{0,1}[0-9]+([.,][0-9]+){0,1}$' + quote + ' THEN replace(' + value + ', ' + quote + ',' + quote + ', ' + quote + '.' + quote + ')::numeric END';
}

export function compilarCondiciones(regla, codigos, anio, codigosHis = null) {
  const incl = codigos.filter((c) => !c.es_exclusion && !c.es_requerido);
  const req = codigos.filter((c) => !c.es_exclusion && c.es_requerido);
  const excl = codigos.filter((c) => c.es_exclusion);

  const proc = incl.filter((c) => c.tipo_codigo === 'CPMS' || c.tipo_codigo === 'CPT');
  const diag = incl.filter((c) => c.tipo_codigo === 'CIE10');

  if (proc.length === 0 && diag.length === 0) return null;

  const params = [];
  const where = [];
  const unseen = [];
  const tipos = splitTipos(regla.tipo_dx);

  // El staging puede contener varios anios: siempre se acota el periodo.
  if (anio !== undefined && anio !== null) {
    where.push('s.anio = ?');
    params.push(Number(anio));
  }

  // Fila principal: procedimiento si existe; si no, diagnostico.
  const exactCodes = regla.fuente === 'Sintaxis PPR';
  const primary = matchCodigos('s', proc.length ? proc : diag, codigosHis, exactCodes);
  if (!primary.length) return null;
  where.push(`(${primary.map((p) => p.sql).join(' OR ')})`);
  params.push(...primary.flatMap((p) => p.params));

  // Condiciones de la fila principal
  if (regla.id_financiador) {
    where.push('s.id_financiador = ?');
    params.push(String(regla.id_financiador));
  }

  // El tipo de diagnostico aplica a la fila principal, sea procedimiento o diagnostico.
  if (tipos.length) {
    where.push(`s.tipo_diagnostico IN (${sqlIn(tipos)})`);
    params.push(...tipos);
  }

  // Laboratorio de la fila principal
  if (regla.lab_modo === 'RANGO') {
    if (regla.lab_min !== null && regla.lab_min !== undefined) {
      where.push(numericLabSql('s') + ' ' + (regla.lab_min_incl ? '>=' : '>') + ' ?');
      params.push(Number(regla.lab_min));
    }
    if (regla.lab_max !== null && regla.lab_max !== undefined) {
      where.push(numericLabSql('s') + ' ' + (regla.lab_max_incl ? '<=' : '<') + ' ?');
      params.push(Number(regla.lab_max));
    }
  } else if (regla.lab_modo === 'NUMERO') {
    where.push(numericLabSql('s') + ' IS NOT NULL');
  } else if (regla.lab_modo && regla.valor_lab) {
    const valores = String(regla.valor_lab).split(',').map((v) => v.trim()).filter(Boolean);
    if (valores.length) {
      where.push(`s.valor_lab IN (${sqlIn(valores)})`);
      params.push(...valores);
    }
  }

  if (regla.edad_min_meses !== null && regla.edad_min_meses !== undefined) {
    where.push('s.edad_meses >= ?');
    params.push(Number(regla.edad_min_meses));
  }
  if (regla.edad_max_meses !== null && regla.edad_max_meses !== undefined) {
    where.push('s.edad_meses <= ?');
    params.push(Number(regla.edad_max_meses));
  }

  if (regla.condicion_sexo === 'Femenino') {
    where.push("s.genero = 'F'");
  } else if (regla.condicion_sexo === 'Masculino') {
    where.push("s.genero = 'M'");
  }

  if (regla.solo_gestante) {
    where.push("s.condicion_gestante = 'GESTANTE'");
  } else if (regla.excluir_gestante) {
    where.push("(s.condicion_gestante IS NULL OR s.condicion_gestante <> 'GESTANTE')");
  }

  // Perimetro abdominal con umbrales distintos por sexo (matriz No Transmisible).
  if (regla.pab_op && (regla.pab_femenino !== null || regla.pab_masculino !== null)) {
    const op = String(regla.pab_op).trim() === '>' ? '>' : '<=';
    const partes = [];
    if (regla.pab_femenino !== null && regla.pab_femenino !== undefined) {
      partes.push(`(s.genero = 'F' AND s.perimetro_abdominal ${op} ?)`);
      params.push(Number(regla.pab_femenino));
    }
    if (regla.pab_masculino !== null && regla.pab_masculino !== undefined) {
      partes.push(`(s.genero = 'M' AND s.perimetro_abdominal ${op} ?)`);
      params.push(Number(regla.pab_masculino));
    }
    if (partes.length) where.push(`(${partes.join(' OR ')})`);
  }

  // Filtro por unidad productora de servicios (ID_UPS).
  // id_ups = 0 / NULL significa "sin filtro": la columna tiene DEFAULT 0 en la tabla.
  const ups = String(regla.id_ups || '')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ups.length) {
    where.push(`s.id_ups IN (${sqlIn(ups)})`);
    params.push(...ups);
  }

  // Compatibilidad: si la regla combina procedimiento + CIE10 como codigos principales,
  // el diagnostico debe existir en la misma cita.
  if (proc.length && diag.length) {
    const diagMatch = matchCodigos('d', diag, codigosHis, exactCodes);
    if (!diagMatch.length) return null;
    unseen.push(`EXISTS (
        SELECT 1 FROM dbo.StgAtenciones d
        WHERE d.id_cita = s.id_cita AND d.anio = s.anio
          AND (${diagMatch.map((m) => m.sql).join(' OR ')})${tipos.length ? ` AND d.tipo_diagnostico IN (${sqlIn(tipos)})` : ''}
      )`);
    params.push(...diagMatch.flatMap((m) => m.params));
    if (tipos.length) params.push(...tipos);
  }

  // Codigos requeridos ("con"): dentro de un grupo basta uno; entre grupos se exigen todos.
  const grupos = new Map();
  for (const r of req) {
    const grupo = Number(r.grupo) || 1;
    if (!grupos.has(grupo)) grupos.set(grupo, []);
    grupos.get(grupo).push(r);
  }
  for (const [, items] of [...grupos.entries()].sort((a, b) => a[0] - b[0])) {
    const alternativas = [];
    for (const it of items) {
      const m = matchCodigo('d', it, codigosHis, exactCodes);
      if (!m) continue;
      const cond = [m.sql];
      const ps = [...m.params];
      const labReq = String(it.valor_lab || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (labReq.length) {
        cond.push(`d.valor_lab IN (${sqlIn(labReq)})`);
        ps.push(...labReq);
      }
      const tiposReq = it.tipo_dx ? splitTipos(it.tipo_dx) : [];
      if (tiposReq.length) {
        cond.push(`d.tipo_diagnostico IN (${sqlIn(tiposReq)})`);
        ps.push(...tiposReq);
      }
      alternativas.push(`(${cond.join(' AND ')})`);
      params.push(...ps);
    }
    if (!alternativas.length) return null;
    unseen.push(`EXISTS (
        SELECT 1 FROM dbo.StgAtenciones d
        WHERE d.id_cita = s.id_cita AND d.anio = s.anio AND (${alternativas.join(' OR ')})
      )`);
  }

  // Exclusiones: ningun codigo excluido en la cita
  if (excl.length) {
    const exclMatch = matchCodigos('x', excl, codigosHis, exactCodes);
    if (exclMatch.length) {
      unseen.push(`NOT EXISTS (
          SELECT 1 FROM dbo.StgAtenciones x
          WHERE x.id_cita = s.id_cita AND x.anio = s.anio
            AND (${exclMatch.map((m) => m.sql).join(' OR ')})
        )`);
      params.push(...exclMatch.flatMap((m) => m.params));
    }
  }

  // Agregacion
  let agregado;
  switch (regla.tipo_agregacion) {
    case 'COUNT_CITAS':
      agregado = 'COUNT(DISTINCT s.id_cita)';
      break;
    case 'COUNT_PACIENTES':
      agregado = 'COUNT(DISTINCT s.id_paciente)';
      break;
    case 'SUM_LAB':
      agregado = 'COALESCE(SUM(' + numericLabSql('s') + '), 0)::integer';
      where.push(numericLabSql('s') + ' IS NOT NULL');
      break;
    default:
      agregado = 'COUNT(*)';
  }

  const condiciones = [...where, ...unseen];
  return { condiciones, params, agregado };
}

/** Compila una regla al INSERT de SupervisionResultados (calculo de totales). */
function buildReglaSql(regla, codigos, anio) {
  const compilada = compilarCondiciones(regla, codigos, anio);
  if (!compilada) return null;

  const { condiciones, params, agregado } = compilada;

  const sql = `
    INSERT INTO dbo.SupervisionResultados (id_regla, anio, mes, id_establecimiento, valor)
    SELECT ?, s.anio, s.mes, s.id_establecimiento, ${agregado}
    FROM dbo.StgAtenciones s
    WHERE ${condiciones.map((w) => `(${w})`).join(' AND ')}
    GROUP BY s.anio, s.mes, s.id_establecimiento
    HAVING ${agregado} > 0`;

  return { sql, params: [regla.id_regla, ...params] };
}

export async function calcular(anio, codigoEstrategia = null, onProgress = null) {
  const filtroEstrategia = codigoEstrategia ? ' AND UPPER(e.codigo) = UPPER(?)' : '';
  const paramsEstrategia = codigoEstrategia ? [String(codigoEstrategia)] : [];
  const reglas = await query(`
    SELECT v.id_regla,v.fuente,v.tipo_dx,v.valor_lab,v.lab_modo,v.lab_min,v.lab_max,v.lab_min_incl,v.lab_max_incl,
           v.edad_min_meses,v.edad_max_meses,v.condicion_sexo,v.solo_gestante,v.excluir_gestante,
           v.id_financiador,v.id_ups,v.pab_op,v.pab_femenino,v.pab_masculino,v.tipo_agregacion,
           r.id_condicion_servicio,r.requiere_dni
    FROM dbo.vw_ReglasCompletas v JOIN dbo.Reglas r ON r.id_regla=v.id_regla
    JOIN dbo.Subproductos s ON s.id_subproducto=r.id_subproducto
    JOIN dbo.Estrategias e ON e.id_estrategia=s.id_estrategia
    WHERE v.activo = TRUE${filtroEstrategia}`, paramsEstrategia);

  const codigos = await query(
    `SELECT id_regla, codigo, codigo_norm, tipo_codigo, es_exclusion, es_requerido, grupo, valor_lab, tipo_dx
     FROM dbo.ReglaCodigos`
  );

  const porRegla = new Map();
  for (const c of codigos) {
    if (!porRegla.has(c.id_regla)) porRegla.set(c.id_regla, []);
    porRegla.get(c.id_regla).push(c);
  }

  let ejecutadas = 0;
  let omitidas = 0;
  let completadas = 0;
  reportSyncProgress(onProgress, { porcentaje: 61, etapa: 'reglas', mensaje: 'Aplicando reglas de supervisión', detalle: 'Preparadas ' + reglas.length + ' reglas para evaluar.', reglas_completadas: 0, reglas_totales: reglas.length });
  await execute('BEGIN');
  try {
    if (codigoEstrategia) {
      await execute(`DELETE FROM dbo.SupervisionResultados vr
        USING dbo.Reglas r, dbo.Subproductos s, dbo.Estrategias e
        WHERE vr.id_regla=r.id_regla AND r.id_subproducto=s.id_subproducto
          AND s.id_estrategia=e.id_estrategia AND vr.anio=? AND UPPER(e.codigo)=UPPER(?)`,
        [Number(anio), String(codigoEstrategia)]);
    } else {
      await execute('DELETE FROM dbo.SupervisionResultados WHERE anio = ?', [Number(anio)]);
    }
    for (const regla of reglas) {
      const compilada = buildReglaSql(regla, porRegla.get(regla.id_regla) || [], anio);
      if (!compilada) omitidas++;
      else {
        await execute(compilada.sql, compilada.params);
        ejecutadas++;
      }
      completadas++;
      const porcentaje = reglas.length ? Math.min(95, 62 + Math.round((completadas / reglas.length) * 33)) : 95;
      reportSyncProgress(onProgress, { porcentaje, etapa: 'reglas', mensaje: 'Aplicando reglas de supervisión', detalle: completadas + ' de ' + reglas.length + ' reglas evaluadas.', reglas_completadas: completadas, reglas_totales: reglas.length });
    }
    await execute('COMMIT');
  } catch (err) {
    try { await execute('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }

  reportSyncProgress(onProgress, { porcentaje: 96, etapa: 'resumen', mensaje: 'Reglas aplicadas', detalle: ejecutadas + ' reglas calculadas; preparando el resumen.', reglas_completadas: completadas, reglas_totales: reglas.length });
  return { ejecutadas, omitidas, total: reglas.length };
}

/* ------------------------------------------------------------------------------------------ *
 * 3. Orquestacion
 * ------------------------------------------------------------------------------------------ */
export async function sincronizar(anio, { soloEstrategia = null, onProgress = null } = {}) {
  const inicio = Date.now();
  reportSyncProgress(onProgress, { porcentaje: 1, etapa: 'his', mensaje: 'Iniciando sincronización', detalle: 'Preparando el procesamiento del año ' + Number(anio) + '.' });
  const syncRows = await query(
    `INSERT INTO dbo.SyncEstado (anio, estado) OUTPUT INSERTED.id_sync VALUES (?, 'EN_PROCESO')`,
    [Number(anio)]
  );
  const idSync = syncRows[0].id_sync;

  try {
    const filas = await refreshStaging(anio, onProgress);
    const calc = await calcular(anio, soloEstrategia, onProgress);
    const duracion = Date.now() - inicio;

    reportSyncProgress(onProgress, { porcentaje: 97, etapa: 'resumen', mensaje: 'Actualizando resumen', detalle: 'Las reglas terminaron; consolidando los resultados.' });
    await execute(
      `UPDATE dbo.SyncEstado
       SET filas_staging = ?, reglas_calculadas = ?, duracion_ms = ?,
           finalizado = SYSUTCDATETIME(), estado = 'OK'
       WHERE id_sync = ?`,
      [filas, calc.ejecutadas, duracion, idSync]
    );

    reportSyncProgress(onProgress, { porcentaje: 98, etapa: 'resumen', mensaje: 'Calculando totales', detalle: 'Actualizando las cifras del reporte.' });
    const valores = await query(
      'SELECT COUNT(*) AS filas, ISNULL(SUM(valor), 0) AS total FROM dbo.SupervisionResultados WHERE anio = ?',
      [Number(anio)]
    );

    // Refresca la cache de anios disponibles (HIS_Nominal ya esta en cache tras el staging).
    reportSyncProgress(onProgress, { porcentaje: 99, etapa: 'resumen', mensaje: 'Cerrando sincronización', detalle: 'Guardando el estado final del cálculo.' });
    try {
      await refrescarAniosFuente();
    } catch (e) {
      console.warn('No se pudo refrescar AniosFuente:', e.message);
    }

    return {
      ok: true,
      anio: Number(anio),
      filas_staging: filas,
      reglas_ejecutadas: calc.ejecutadas,
      reglas_omitidas: calc.omitidas,
      reglas_totales: calc.total,
      filas_resultado: valores[0]?.filas || 0,
      total_supervisado: valores[0]?.total || 0,
      duracion_ms: duracion
    };
  } catch (err) {
    await execute(
      `UPDATE dbo.SyncEstado
       SET finalizado = SYSUTCDATETIME(), estado = 'ERROR', mensaje = ?, duracion_ms = ?
       WHERE id_sync = ?`,
      [String(err.message || err).slice(0, 4000), Date.now() - inicio, idSync]
    );
    throw err;
  }
}

export async function ultimoSync(anio) {
  const rows = await query(
    `SELECT id_sync, anio, filas_staging, reglas_calculadas, duracion_ms,
            iniciado, finalizado, estado, mensaje
     FROM dbo.SyncEstado WHERE anio = ? ORDER BY id_sync DESC LIMIT 1`,
    [Number(anio)]
  );
  const estado = rows[0];
  if (!estado) return null;

  /*
   * El total no se guarda en SyncEstado: se calcula en vivo desde SupervisionResultados
   * para que la API nunca muestre una cifra anterior a un recalculo manual.
   * Mientras hay una sincronizacion en curso no se consulta: la transaccion del motor
   * mantiene bloqueada la tabla y la consulta dejaria sin respuesta al sondeo de la UI.
   */
  if (estado.estado === 'EN_PROCESO') return estado;

  const totales = await query(
    `SELECT COUNT(*) AS filas, ISNULL(SUM(valor), 0) AS total
     FROM dbo.SupervisionResultados WHERE anio = ?`,
    [Number(anio)]
  );

  return {
    ...estado,
    filas_resultado: totales[0]?.filas || 0,
    total_supervisado: totales[0]?.total || 0
  };
}

/**
 * Anios que la app puede ofrecer en el selector.
 * Se leen de cache (SupervisionResultados + AniosFuente + anio actual) para no escanear
 * HIS_Nominal en cada carga: ese escaneo tarda ~19s en frio y bloquea la unica conexion.
 */
export async function aniosDisponibles() {
  return query(`
    SELECT anio FROM (
      SELECT DISTINCT anio FROM dbo.SupervisionResultados
      UNION
      SELECT anio FROM dbo.AniosFuente
      UNION
      SELECT DISTINCT anio FROM dbo.SyncEstado
      UNION
      SELECT CAST(YEAR(SYSUTCDATETIME()) AS INT) AS anio
    ) x
    ORDER BY anio DESC`);
}

/**
 * Refresca dbo.AniosFuente con los anios presentes en el HIS.
 * Se ejecuta dentro de sincronizar(), cuando la tabla HIS_Nominal ya esta en cache.
 */
export async function refrescarAniosFuente() {
  return query(`
    INSERT INTO dbo.AniosFuente (anio, actualizado)
    SELECT DISTINCT CAST(ANIO AS INT), CURRENT_TIMESTAMP
    FROM [${SOURCE_DB}].[dbo].[HIS_Nominal]
    ON CONFLICT (anio) DO UPDATE SET actualizado = EXCLUDED.actualizado;`);
}

export { closePool };
