import { query, execute } from '../db.js';

const headerKey = (value) => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const first = source.split('\n').find((line) => line.trim()) || '';
  const delimiter = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '"' && quoted && next === '"') { cell += '"'; i += 1; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (!quoted && ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(headerKey);
  return rows.filter((r) => r.some((v) => String(v || '').trim())).map((r) => {
    const out = {};
    headers.forEach((h, index) => { out[h] = String(r[index] ?? '').trim(); });
    return out;
  });
}

const firstValue = (row, names) => {
  for (const name of names) if (row[name] !== undefined && row[name] !== '') return row[name];
  return null;
};

function numberOrNull(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function isoDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return match ? `${match[3]}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}` : null;
}

function ageMonths(row) {
  const value = numberOrNull(firstValue(row, ['EDAD_REG', 'EDAD', 'EDAD_VALOR']));
  if (value === null) return null;
  const type = String(firstValue(row, ['TIPO_EDAD', 'TIPO_DE_EDAD']) || 'A').toUpperCase();
  if (type === 'M') return Math.round(value);
  if (type === 'D') return Math.round(value / 30.4375);
  return Math.round(value * 12);
}

function mapRow(row) {
  const idPaciente = firstValue(row, ['ID_PACIENTE', 'PACIENTE_ID']);
  const idCita = firstValue(row, ['ID_CITA', 'CITA_ID']);
  const codigo = firstValue(row, ['CODIGO_ITEM', 'CODIGO', 'COD_ITEM']);
  const anio = numberOrNull(firstValue(row, ['ANIO', 'ANO', 'AÑO']));
  const mes = numberOrNull(firstValue(row, ['MES']));
  const idEst = numberOrNull(firstValue(row, ['ID_ESTABLECIMIENTO', 'ESTABLECIMIENTO_ID']));
  return {
    idPaciente: idPaciente ? String(idPaciente) : null,
    idCita: idCita ? String(idCita) : null,
    codigo: codigo ? String(codigo).trim().toUpperCase() : null,
    anio, mes, idEst,
    fecha: isoDate(firstValue(row, ['FECHA_ATENCION', 'FECHA'])),
    dni: firstValue(row, ['NUMERO_DOCUMENTO', 'DNI', 'DOCUMENTO']),
    tipoDocumento: firstValue(row, ['ID_TIPO_DOCUMENTO', 'TIPO_DOCUMENTO']),
    genero: firstValue(row, ['GENERO', 'SEXO']),
    edadMeses: ageMonths(row),
    tipoDx: firstValue(row, ['TIPO_DIAGNOSTICO', 'TIPO_DX']),
    valorLab: firstValue(row, ['VALOR_LAB', 'VALOR_LABORATORIO']),
    idUps: firstValue(row, ['ID_UPS', 'UPS']),
    condicionGestante: firstValue(row, ['CONDICION_GESTANTE', 'GESTANTE']),
    red: firstValue(row, ['RED']),
    microred: firstValue(row, ['MICRORED', 'MICRO_RED']),
    establecimiento: firstValue(row, ['NOMBRE_ESTABLECIMIENTO', 'ESTABLECIMIENTO']),
    categoria: firstValue(row, ['CATEGORIA']),
    codigoUnico: firstValue(row, ['CODIGO_UNICO'])
  };
}

export async function importarTramaHIS({ archivo, contenido, anio, mes }) {
  const rows = parseCsv(contenido);
  if (!rows.length) throw Object.assign(new Error('El CSV no contiene filas de datos'), { status: 400 });
  const mapped = rows.map(mapRow);
  const periodoAnio = Number(anio) || mapped.find((r) => r.anio)?.anio || new Date().getFullYear();
  const periodoMes = Number(mes) || mapped.find((r) => r.mes)?.mes || null;
  const importRows = await query(
    `INSERT INTO dbo.his_importaciones (archivo, anio, mes, filas_leidas)
     VALUES (?, ?, ?, ?) RETURNING id_importacion`,
    [archivo || 'trama.csv', periodoAnio, periodoMes, mapped.length]
  );
  const idImportacion = importRows[0].id_importacion;
  let insertadas = 0;
  let rechazadas = 0;
  for (let index = 0; index < mapped.length; index += 1) {
    const row = mapped[index];
    const reason = !row.idPaciente ? 'Falta ID_PACIENTE' : !row.idCita ? 'Falta ID_CITA' : !row.codigo ? 'Falta CODIGO_ITEM' : !row.mes && !periodoMes ? 'Falta MES' : null;
    if (reason) {
      rechazadas += 1;
      await execute('INSERT INTO dbo.his_rechazos (id_importacion, fila, motivo, datos_originales) VALUES (?, ?, ?, ?::jsonb)', [idImportacion, index + 2, reason, JSON.stringify(rows[index])]);
      continue;
    }
    const rowAnio = row.anio || periodoAnio;
    const rowMes = row.mes || periodoMes;
    if (row.idEst && row.establecimiento) {
      await execute(
        `INSERT INTO dbo.establecimientos (id_establecimiento, nombre_establecimiento, red, microred, categoria_establecimiento, codigo_unico)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id_establecimiento) DO UPDATE SET nombre_establecimiento=EXCLUDED.nombre_establecimiento, red=EXCLUDED.red, microred=EXCLUDED.microred, categoria_establecimiento=EXCLUDED.categoria_establecimiento, codigo_unico=EXCLUDED.codigo_unico`,
        [row.idEst, row.establecimiento, row.red, row.microred, row.categoria, row.codigoUnico]
      );
    }
    await execute(
      `INSERT INTO dbo.stgatenciones
       (anio, mes, id_cita, fecha_atencion, id_establecimiento, id_paciente, numero_documento, id_ups, edad_meses, genero, codigo_item, tipo_diagnostico, valor_lab, condicion_gestante)
       VALUES (?, ?, ?, NULLIF(?, '')::date, ?, ?, ?, NULLIF(?, '')::integer, ?, ?, ?, ?, ?, ?)`,
      [rowAnio, rowMes || 0, row.idCita, row.fecha || '', row.idEst, row.idPaciente, row.dni, row.idUps, row.edadMeses, row.genero, row.codigo, row.tipoDx, row.valorLab, row.condicionGestante]
    );
    insertadas += 1;
  }
  await execute(
    `UPDATE dbo.his_importaciones SET finalizada=CURRENT_TIMESTAMP, filas_insertadas=?, filas_rechazadas=?, estado=? WHERE id_importacion=?`,
    [insertadas, rechazadas, rechazadas ? 'CON_RECHAZOS' : 'OK', idImportacion]
  );
  return { id_importacion: idImportacion, archivo, anio: periodoAnio, mes: periodoMes, filas_leidas: mapped.length, filas_insertadas: insertadas, filas_rechazadas: rechazadas };
}

export async function listarImportacionesHIS() {
  return query(`SELECT id_importacion, archivo, anio, mes, iniciada, finalizada, filas_leidas, filas_insertadas, filas_rechazadas, estado FROM dbo.his_importaciones ORDER BY id_importacion DESC LIMIT 30`);
}

export async function listarIndicadoresNominales() {
  return query(`SELECT codigo, nombre, anio, subproducto_codigo, codigo_principal, tipo_diagnostico, valor_lab, granularidad, estado, observaciones FROM dbo.indicadores_nominales WHERE activo = TRUE ORDER BY anio, codigo`);
}

function normalizarCodigo(value) {
  return String(value || '').toUpperCase().replace(/[.\s\-/']/g, '');
}

/**
 * Busca una asociacion segura entre cada indicador SP y los codigos de sus reglas.
 * Solo se propone confirmacion automatica cuando hay exactamente un codigo de regla
 * presente en las tramas del periodo y un unico contexto de diagnostico/laboratorio.
 */
export async function analizarIndicadoresNominales(anio) {
  const periodo = Number(anio);
  if (!periodo) throw Object.assign(new Error('Debe indicar el año'), { status: 400 });

  const indicadores = await query(
    `SELECT id_indicador, codigo, nombre, subproducto_codigo, codigo_principal,
            tipo_diagnostico, valor_lab, estado
     FROM dbo.indicadores_nominales
     WHERE activo = TRUE
     ORDER BY codigo`
  );
  const his = await query(
    `SELECT codigo_norm, COUNT(1)::int AS filas
     FROM dbo.stgatenciones
     WHERE anio = ? AND codigo_norm IS NOT NULL
     GROUP BY codigo_norm`,
    [periodo]
  );
  const filasHis = new Map(his.map((row) => [normalizarCodigo(row.codigo_norm), Number(row.filas) || 0]));
  const reglas = await query(
    `SELECT s.codigo AS subproducto_codigo, rc.codigo, rc.codigo_norm, rc.tipo_codigo,
            r.tipo_dx, r.valor_lab
     FROM dbo.subproductos s
       INNER JOIN dbo.reglas r ON r.id_subproducto = s.id_subproducto AND r.activo = TRUE
       INNER JOIN dbo.reglacodigos rc ON rc.id_regla = r.id_regla
     WHERE s.activo = TRUE AND rc.es_exclusion = FALSE AND rc.es_requerido = FALSE`
  );

  const porSubproducto = new Map();
  for (const regla of reglas) {
    const key = String(regla.subproducto_codigo || '').trim();
    if (!porSubproducto.has(key)) porSubproducto.set(key, []);
    porSubproducto.get(key).push(regla);
  }

  const resultados = indicadores.map((indicador) => {
    const derivado = String(indicador.codigo || '').match(/^SP(.+)$/i)?.[1] || '';
    const subproducto = String(indicador.subproducto_codigo || derivado).trim();
    const reglasSubproducto = porSubproducto.get(subproducto) || [];
    const candidatos = [];
    for (const regla of reglasSubproducto) {
      const codigoRegla = normalizarCodigo(regla.codigo_norm || regla.codigo);
      if (!codigoRegla) continue;
      const presentes = [...filasHis.entries()].filter(([codigoHis]) =>
        regla.tipo_codigo === 'CIE10' ? codigoHis.startsWith(codigoRegla) : codigoHis === codigoRegla
      );
      const filas = presentes.reduce((total, [, cantidad]) => total + cantidad, 0);
      if (!filas) continue;
      const contexto = `${String(regla.tipo_dx || '')}|${String(regla.valor_lab || '')}`;
      candidatos.push({
        codigo: regla.codigo,
        codigo_norm: codigoRegla,
        tipo_codigo: regla.tipo_codigo,
        filas,
        tipo_diagnostico: regla.tipo_dx || null,
        valor_lab: regla.valor_lab || null,
        contexto
      });
    }
    const unicos = new Map();
    for (const candidato of candidatos) {
      const key = `${candidato.codigo_norm}|${candidato.contexto}`;
      if (!unicos.has(key)) unicos.set(key, candidato);
      else unicos.get(key).filas += candidato.filas;
    }
    const opciones = [...unicos.values()];
    const exacta = opciones.length === 1 ? opciones[0] : null;
    return {
      codigo: indicador.codigo,
      nombre: indicador.nombre,
      subproducto_codigo: subproducto || null,
      estado_actual: indicador.estado,
      estado_propuesto: exacta ? 'CONFIRMADA' : 'PENDIENTE_REVISION',
      motivo: exacta ? 'COINCIDENCIA_EXACTA' : (opciones.length ? 'AMBIGUA' : 'SIN_COINCIDENCIA'),
      propuesta: exacta ? {
        codigo_principal: exacta.codigo_norm,
        tipo_diagnostico: exacta.tipo_diagnostico,
        valor_lab: exacta.valor_lab,
        filas_his: exacta.filas
      } : null,
      candidatos: opciones.map(({ contexto, ...item }) => item)
    };
  });

  return {
    anio: periodo,
    total: resultados.length,
    exactas: resultados.filter((item) => item.motivo === 'COINCIDENCIA_EXACTA').length,
    ambiguas: resultados.filter((item) => item.motivo === 'AMBIGUA').length,
    sin_coincidencia: resultados.filter((item) => item.motivo === 'SIN_COINCIDENCIA').length,
    indicadores: resultados
  };
}

export async function aplicarAnalisisNominal(anio) {
  const analisis = await analizarIndicadoresNominales(anio);
  let actualizados = 0;
  for (const item of analisis.indicadores) {
    if (!item.propuesta) continue;
    await execute(
      `UPDATE dbo.indicadores_nominales
       SET subproducto_codigo=?, codigo_principal=?, tipo_diagnostico=?, valor_lab=?,
           estado='CONFIRMADA', observaciones=?, fecha_modificacion=CURRENT_TIMESTAMP
       WHERE codigo=?`,
      [item.subproducto_codigo, item.propuesta.codigo_principal, item.propuesta.tipo_diagnostico,
       item.propuesta.valor_lab, `Asociacion automatica exacta para ${anio}; ${item.propuesta.filas_his} filas HIS.`, item.codigo]
    );
    actualizados += 1;
  }
  return { ...analisis, actualizados };
}

export async function actualizarIndicador(codigo, cambios) {
  const estado = ['CONFIRMADA', 'PENDIENTE_REVISION', 'INACTIVA'].includes(cambios.estado) ? cambios.estado : 'PENDIENTE_REVISION';
  await execute(
    `UPDATE dbo.indicadores_nominales
     SET estado=?, codigo_principal=?, tipo_diagnostico=?, valor_lab=?, granularidad=?, observaciones=?, fecha_modificacion=CURRENT_TIMESTAMP
     WHERE codigo=?`,
    [estado, cambios.codigo_principal || null, cambios.tipo_diagnostico || null, cambios.valor_lab || null, cambios.granularidad || 'CITA', cambios.observaciones || null, codigo]
  );
  return (await query('SELECT * FROM dbo.indicadores_nominales WHERE codigo = ?', [codigo]))[0] || null;
}

export async function generarNominal({ anio, mes } = {}) {
  const periodo = Number(anio);
  if (!periodo) throw Object.assign(new Error('Debe indicar el año'), { status: 400 });
  const paramsFiltro = [periodo];
  const filtroMes = mes ? ' AND s.mes = ?' : '';
  if (mes) paramsFiltro.push(Number(mes));
  const indicators = await query(`SELECT * FROM dbo.indicadores_nominales WHERE activo=TRUE AND estado='CONFIRMADA' AND codigo_principal IS NOT NULL`);
  await execute('BEGIN');
  try {
    await execute(`DELETE FROM dbo.nominal_resultados WHERE anio=?${mes ? ' AND mes=?' : ''}`, mes ? [periodo, Number(mes)] : [periodo]);
    let filas = 0;
    for (const indicator of indicators) {
      const result = await execute(
        `INSERT INTO dbo.nominal_resultados
         (id_indicador, anio, mes, id_establecimiento, id_paciente, numero_documento, genero, edad, edad_meses, valor)
         SELECT ?, s.anio, s.mes, s.id_establecimiento, s.id_paciente, max(s.numero_documento) AS numero_documento,
                max(s.genero) AS genero, floor(max(s.edad_meses) / 12) AS edad, max(s.edad_meses) AS edad_meses, 1
         FROM dbo.stgatenciones s
         WHERE s.anio=?${filtroMes}
           AND s.codigo_norm = upper(translate(?, '. /-', ''))
           AND (CAST(? AS TEXT) IS NULL OR s.tipo_diagnostico = CAST(? AS TEXT))
           AND (CAST(? AS TEXT) IS NULL OR s.valor_lab = CAST(? AS TEXT))
         GROUP BY s.anio, s.mes, s.id_establecimiento, s.id_paciente
         ON CONFLICT (id_indicador, anio, mes, id_establecimiento, id_paciente)
         DO UPDATE SET valor=EXCLUDED.valor, lote_generado=CURRENT_TIMESTAMP`,
        [indicator.id_indicador, ...paramsFiltro, indicator.codigo_principal, indicator.tipo_diagnostico, indicator.tipo_diagnostico, indicator.valor_lab, indicator.valor_lab]
      );
      filas += result.rowCount || 0;
    }
    await execute('COMMIT');
    return { anio: periodo, mes: mes || null, indicadores: indicators.length, filas };
  } catch (error) {
    try { await execute('ROLLBACK'); } catch {}
    throw error;
  }
}

export async function resumenNominal({ anio, mes, idEstablecimiento, pagina, limite } = {}) {
  const params = [];
  const where = [];
  if (anio) { where.push('r.anio = ?'); params.push(anio); }
  if (mes) { where.push('r.mes = ?'); params.push(mes); }
  if (idEstablecimiento) { where.push('r.id_establecimiento = ?'); params.push(idEstablecimiento); }
  const condition = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, Math.trunc(Number(pagina) || 1));
  const pageSize = Math.min(200, Math.max(25, Math.trunc(Number(limite) || 100)));
  if (pagina !== undefined && pagina !== null && Number(pagina) > 0) {
    const rows = await query(`
      WITH page_keys AS (
        SELECT r.anio, r.mes, r.id_establecimiento, r.id_paciente, count(*) OVER() AS total_filas
        FROM dbo.nominal_resultados r
        ${condition}
        GROUP BY r.anio, r.mes, r.id_establecimiento, r.id_paciente
        ORDER BY r.anio, r.mes, r.id_establecimiento, max(r.numero_documento) NULLS LAST, r.id_paciente
        LIMIT ? OFFSET ?
      )
      SELECT r.anio, r.mes, r.id_establecimiento,
             COALESCE(e.nombre_establecimiento, CONCAT('EESS ', r.id_establecimiento)) AS establecimiento,
             r.id_paciente, r.numero_documento, r.tipo_documento, r.genero, r.edad,
             i.codigo AS indicador, i.nombre AS indicador_nombre, i.estado, r.valor, p.total_filas
      FROM page_keys p
      JOIN dbo.nominal_resultados r ON r.anio IS NOT DISTINCT FROM p.anio AND r.mes IS NOT DISTINCT FROM p.mes
        AND r.id_establecimiento IS NOT DISTINCT FROM p.id_establecimiento AND r.id_paciente IS NOT DISTINCT FROM p.id_paciente
      JOIN dbo.indicadores_nominales i ON i.id_indicador = r.id_indicador
      LEFT JOIN dbo.establecimientos e ON e.id_establecimiento = r.id_establecimiento
      ORDER BY p.anio, p.mes, e.nombre_establecimiento, r.numero_documento, i.codigo`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    return { rows, total: Number(rows[0]?.total_filas) || 0, pagina: page, limite: pageSize };
  }
  return query(`
    SELECT r.anio, r.mes, r.id_establecimiento,
           COALESCE(e.nombre_establecimiento, CONCAT('EESS ', r.id_establecimiento)) AS establecimiento,
           r.id_paciente, r.numero_documento, r.tipo_documento, r.genero, r.edad,
           i.codigo AS indicador, i.nombre AS indicador_nombre, i.estado, r.valor
    FROM dbo.nominal_resultados r
    JOIN dbo.indicadores_nominales i ON i.id_indicador = r.id_indicador
    LEFT JOIN dbo.establecimientos e ON e.id_establecimiento = r.id_establecimiento
    ${condition}
    ORDER BY r.anio, r.mes, e.nombre_establecimiento, r.numero_documento, i.codigo`, params);
}

