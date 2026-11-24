/**
 * server.js - API de supervision PP0018
 * ------------------------------------------------------------------------------------------
 * Endpoints:
 *   GET    /api/health
 *   POST   /api/auth/login
 *   GET    /api/auth/me
 *   POST   /api/auth/password
 *   GET    /api/usuarios                      (ADMIN)
 *   POST   /api/usuarios                      (ADMIN)
 *   PUT    /api/usuarios/:id                  (ADMIN)
 *   GET    /api/estrategias
 *   GET    /api/anios
 *   GET    /api/establecimientos
 *   GET    /api/reglas?estrategia=&buscar=&anio=&mes=&id_establecimiento=
 *   GET    /api/reglas/:id
 *   POST   /api/reglas                        (ADMIN)
 *   PUT    /api/reglas/:id                    (ADMIN)
 *   DELETE /api/reglas/:id                    (ADMIN)
 *   GET    /api/resumen?anio=&mes=&estrategia=&id_establecimiento=  (ADMIN)
 *   GET    /api/sync/estado?anio=
 *   POST   /api/sync            { anio }      (ADMIN)
 */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { query, execute, ping, closePool } from './db.js';
import { normalizarRegla, mapEstrategia, mapUnidad } from './services/normalizer.js';
import { importarReglas } from './services/importer.js';
import { sincronizar, ultimoSync, aniosDisponibles } from './services/engine.js';
import { listarActividades, obtenerActividad, listarPacientes } from './services/nominal.js';
import { importarTramaHIS, listarImportacionesHIS, listarIndicadoresNominales, analizarIndicadoresNominales, aplicarAnalisisNominal, actualizarIndicador, generarNominal, resumenNominal } from './services/nominal-reporte.js';
import {
  ROLES,
  hashPassword,
  verifyPassword,
  firmarToken,
  cargarUsuario,
  autenticar,
  verificarToken,
  soloAdmin,
  tieneEstrategia
} from './services/auth.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 4000);
const CATALOG_DB = process.env.DB_CATALOG_DATABASE || 'OGESSBM';

app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));

/* Sesion: todo /api exige token salvo health y login. */
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/auth/login') return next();
  if (req.path === '/sync/estado' && sincronizando) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Sesion requerida' });
    const sesion = verificarToken(token);
    if (!sesion) return res.status(401).json({ error: 'Sesion invalida o expirada' });
    req.usuario = { id_usuario: sesion.sub };
    return next();
  }
  return autenticar(req, res, next);
});

/* Utilidades ------------------------------------------------------------------------------ */

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function texto(value, max = 500) {
  if (value === undefined || value === null) return null;
  const t = String(value).trim();
  return t ? t.slice(0, max) : null;
}

/** Devuelve la estrategia a partir de su codigo o de su nombre visible. */
async function resolverEstrategia(entrada) {
  const valor = texto(entrada, 60);
  if (!valor) return null;
  const rows = await query(
    `SELECT id_estrategia, codigo, nombre FROM dbo.Estrategias
     WHERE codigo = ? OR nombre = ?`,
    [valor.toUpperCase(), valor]
  );
  if (rows.length) return rows[0];
  const codigo = mapEstrategia(valor);
  const alt = await query('SELECT id_estrategia, codigo, nombre FROM dbo.Estrategias WHERE codigo = ?', [codigo]);
  return alt[0] || null;
}

/** Busca o crea el subproducto (la unidad se actualiza si viene informada). */
async function upsertSubproducto(idEstrategia, nombre, codigo, unidadCodigo) {
  const existente = await query(
    'SELECT id_subproducto FROM dbo.Subproductos WHERE id_estrategia = ? AND nombre = ? LIMIT 1',
    [idEstrategia, nombre]
  );

  const unidad = await query('SELECT id_unidad FROM dbo.UnidadesMedida WHERE codigo = ?', [unidadCodigo]);
  const idUnidad = unidad[0]?.id_unidad;
  if (!idUnidad) throw new Error(`Unidad de medida no valida: ${unidadCodigo}`);

  if (existente.length) {
    await execute('UPDATE dbo.Subproductos SET id_unidad = ? WHERE id_subproducto = ?', [idUnidad, existente[0].id_subproducto]);
    return { idSubproducto: existente[0].id_subproducto, idUnidad };
  }

  const rows = await query(
    `INSERT INTO dbo.Subproductos (id_estrategia, codigo, nombre, id_unidad)
     OUTPUT INSERTED.id_subproducto VALUES (?, ?, ?, ?)`,
    [idEstrategia, codigo, nombre, idUnidad]
  );
  return { idSubproducto: rows[0].id_subproducto, idUnidad };
}

function mapReglaApi(r) {
  return {
    id: r.id_regla,
    id_regla: r.id_regla,
    codigo_origen: r.codigo_origen,
    estrategia: r.estrategia,
    estrategia_codigo: r.estrategia_codigo,
    id_producto: r.id_producto ?? null,
    producto: r.producto || null,
    id_subproducto: r.id_subproducto ?? null,
    codigo_subproducto: r.subproducto_codigo || null,
    subproducto: r.subproducto,
    unidad_medida: r.unidad_medida,
    tipo_agregacion: r.tipo_agregacion,
    fuente: r.fuente,
    proceso: r.proceso,
    codigos: r.codigos_inclusion || '',
    codigos_exclusion: r.codigos_exclusion || '',
    codigos_requeridos: r.codigos_requeridos || '',
    tipo_dx: r.tipo_dx,
    valor_lab: r.valor_lab,
    lab_modo: r.lab_modo,
    lab_min: r.lab_min,
    lab_max: r.lab_max,
    lab_min_incl: r.lab_min_incl,
    lab_max_incl: r.lab_max_incl,
    rango_edad: formatearEdad(r.edad_min_meses, r.edad_max_meses),
    edad_min_meses: r.edad_min_meses,
    edad_max_meses: r.edad_max_meses,
    condicion_sexo: r.condicion_sexo || 'Ambos',
    solo_gestante: !!r.solo_gestante,
    excluir_gestante: !!r.excluir_gestante,
    id_ups: r.id_ups || '',
    pab_op: r.pab_op || '',
    pab_femenino: r.pab_femenino,
    pab_masculino: r.pab_masculino,
    restriccion: r.restriccion,
    nivel_restriccion: r.nivel_restriccion,
    regla_original: r.regla_original,
    activo: !!r.activo,
    ...(r.valor !== undefined ? { valor: r.valor } : {})
  };
}

function formatearEdad(min, max) {
  if (min === null && max === null) return '';
  if (max !== null && min === null) return max < 12 ? `<= ${max} meses` : `<= ${Math.floor(max / 12)} años`;
  if (min !== null && max === null) return `>= ${Math.floor(min / 12)} años`;
  return `${Math.floor(min / 12)} - ${Math.floor(max / 12)} años`;
}

/* Health ----------------------------------------------------------------------------------- */

app.get('/api/health', asyncHandler(async (_req, res) => {
  const info = await ping();
  res.json({
    status: 'ok',
    database: info.database_name,
    server: info.server_name,
    fuente: process.env.DB_SOURCE_DATABASE || 'DataHIS',
    timestamp: new Date().toISOString()
  });
}));

/* Autenticacion --------------------------------------------------------------------------- */

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const usuario = texto(req.body?.usuario, 60);
  const password = String(req.body?.password || '');
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son obligatorios' });
  }

  const rows = await query(
    `SELECT id_usuario, usuario, password_hash, password_salt, activo
     FROM dbo.Usuarios WHERE usuario = ?`,
    [usuario]
  );
  const row = rows[0];
  if (!row || !row.activo || !verifyPassword(password, row.password_hash, row.password_salt)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  await execute('UPDATE dbo.Usuarios SET ultimo_acceso = SYSUTCDATETIME() WHERE id_usuario = ?', [row.id_usuario]);
  const sesion = await cargarUsuario(row.id_usuario);
  res.json({ token: firmarToken(row.id_usuario), usuario: sesion });
}));

app.get('/api/auth/me', asyncHandler(async (req, res) => {
  res.json({ usuario: req.usuario });
}));

app.post('/api/auth/password', asyncHandler(async (req, res) => {
  const actual = String(req.body?.actual || '');
  const nueva = String(req.body?.nueva || '');
  if (nueva.length < 8) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
  }

  const rows = await query(
    'SELECT password_hash, password_salt FROM dbo.Usuarios WHERE id_usuario = ?',
    [req.usuario.id_usuario]
  );
  if (!rows.length || !verifyPassword(actual, rows[0].password_hash, rows[0].password_salt)) {
    return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  }

  const { hash, salt } = hashPassword(nueva);
  await execute(
    'UPDATE dbo.Usuarios SET password_hash = ?, password_salt = ?, fecha_modificacion = SYSUTCDATETIME() WHERE id_usuario = ?',
    [hash, salt, req.usuario.id_usuario]
  );
  res.json({ ok: true });
}));

/* Usuarios (solo ADMIN) ------------------------------------------------------------------- */

function mapUsuarioApi(u) {
  return {
    id_usuario: u.id_usuario,
    usuario: u.usuario,
    nombre: u.nombre,
    rol: u.rol,
    activo: !!u.activo,
    estrategias: u.estrategias ? String(u.estrategias).split(',').filter(Boolean) : [],
    fecha_creacion: u.fecha_creacion,
    ultimo_acceso: u.ultimo_acceso
  };
}

async function normalizarEstrategias(entrada) {
  const lista = Array.isArray(entrada) ? entrada : String(entrada || '').split(',');
  const codigos = [...new Set(lista.map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
  if (!codigos.length) return [];
  const rows = await query(
    `SELECT codigo FROM dbo.Estrategias WHERE codigo IN (${codigos.map(() => '?').join(',')})`,
    codigos
  );
  return rows.map((r) => r.codigo);
}

async function contarOtrosAdmins(idExcluir) {
  const rows = await query(
    `SELECT COUNT(*) AS n FROM dbo.Usuarios
     WHERE rol = 'ADMIN' AND activo = 1 AND id_usuario <> ?`,
    [Number(idExcluir)]
  );
  return rows[0]?.n || 0;
}

app.get('/api/usuarios', soloAdmin, asyncHandler(async (_req, res) => {
  const rows = await query(`
    SELECT u.id_usuario, u.usuario, u.nombre, u.rol, u.activo, u.fecha_creacion, u.ultimo_acceso,
           (SELECT string_agg(ue.codigo_estrategia, ',' ORDER BY ue.codigo_estrategia)
              FROM dbo.UsuarioEstrategias ue WHERE ue.id_usuario = u.id_usuario) AS estrategias
    FROM dbo.Usuarios u
    ORDER BY u.nombre, u.usuario`);
  res.json({ usuarios: rows.map(mapUsuarioApi) });
}));

app.post('/api/usuarios', soloAdmin, asyncHandler(async (req, res) => {
  const usuario = texto(req.body?.usuario, 60);
  const nombre = texto(req.body?.nombre, 150);
  const password = String(req.body?.password || '');
  const rol = String(req.body?.rol || ROLES.COORDINADOR).toUpperCase();

  if (!usuario || !/^[A-Za-z0-9._-]{3,60}$/.test(usuario)) {
    return res.status(400).json({ error: 'Usuario inválido (3-60 caracteres: letras, números, punto, guion o guion bajo)' });
  }
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  if (![ROLES.ADMIN, ROLES.COORDINADOR].includes(rol)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }

  const existe = await query('SELECT 1 AS x FROM dbo.Usuarios WHERE usuario = ?', [usuario]);
  if (existe.length) return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });

  const estrategias = rol === ROLES.ADMIN ? [] : await normalizarEstrategias(req.body?.estrategias);
  if (rol !== ROLES.ADMIN && !estrategias.length) {
    return res.status(400).json({ error: 'Asigne al menos una estrategia al coordinador' });
  }

  const { hash, salt } = hashPassword(password);
  await execute('BEGIN TRANSACTION');
  try {
    const rows = await query(
      `INSERT INTO dbo.Usuarios (usuario, nombre, password_hash, password_salt, rol, activo)
       OUTPUT INSERTED.id_usuario
       VALUES (?, ?, ?, ?, ?, ?)`,
      [usuario, nombre, hash, salt, rol, req.body?.activo === false ? 0 : 1]
    );
    const id = rows[0].id_usuario;
    for (const codigo of estrategias) {
      await execute(
        'INSERT INTO dbo.UsuarioEstrategias (id_usuario, codigo_estrategia) VALUES (?, ?)',
        [id, codigo]
      );
    }
    await execute('COMMIT');
    res.status(201).json({ ok: true, usuario: await cargarUsuario(id) });
  } catch (err) {
    try { await execute('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}));

app.put('/api/usuarios/:id', soloAdmin, asyncHandler(async (req, res) => {
  const id = num(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id inválido' });

  const actual = await query(
    'SELECT id_usuario, usuario, rol, activo FROM dbo.Usuarios WHERE id_usuario = ?',
    [id]
  );
  if (!actual.length) return res.status(404).json({ error: 'Usuario no encontrado' });

  const usuario = texto(req.body?.usuario, 60) || actual[0].usuario;
  const nombre = texto(req.body?.nombre, 150);
  const rol = String(req.body?.rol || actual[0].rol).toUpperCase();
  const activo = req.body?.activo === false ? 0 : 1;
  const password = req.body?.password ? String(req.body.password) : '';

  if (!/^[A-Za-z0-9._-]{3,60}$/.test(usuario)) {
    return res.status(400).json({ error: 'Usuario inválido' });
  }
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  if (![ROLES.ADMIN, ROLES.COORDINADOR].includes(rol)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }
  if (password && password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }

  const duplicado = await query('SELECT 1 AS x FROM dbo.Usuarios WHERE usuario = ? AND id_usuario <> ?', [usuario, id]);
  if (duplicado.length) return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });

  if (id === req.usuario.id_usuario && (rol !== ROLES.ADMIN || !activo)) {
    return res.status(400).json({ error: 'No puedes quitarte el rol ADMIN ni desactivar tu propio usuario' });
  }
  if (actual[0].rol === ROLES.ADMIN && (rol !== ROLES.ADMIN || !activo)) {
    if (await contarOtrosAdmins(id) === 0) {
      return res.status(400).json({ error: 'Debe existir al menos un administrador activo' });
    }
  }

  const estrategias = rol === ROLES.ADMIN ? [] : await normalizarEstrategias(req.body?.estrategias);
  if (rol !== ROLES.ADMIN && !estrategias.length) {
    return res.status(400).json({ error: 'Asigne al menos una estrategia al coordinador' });
  }

  await execute('BEGIN TRANSACTION');
  try {
    if (password) {
      const { hash, salt } = hashPassword(password);
      await execute(
        `UPDATE dbo.Usuarios SET usuario = ?, nombre = ?, rol = ?, activo = ?,
                password_hash = ?, password_salt = ?, fecha_modificacion = SYSUTCDATETIME()
         WHERE id_usuario = ?`,
        [usuario, nombre, rol, activo, hash, salt, id]
      );
    } else {
      await execute(
        `UPDATE dbo.Usuarios SET usuario = ?, nombre = ?, rol = ?, activo = ?,
                fecha_modificacion = SYSUTCDATETIME()
         WHERE id_usuario = ?`,
        [usuario, nombre, rol, activo, id]
      );
    }

    await execute('DELETE FROM dbo.UsuarioEstrategias WHERE id_usuario = ?', [id]);
    for (const codigo of estrategias) {
      await execute(
        'INSERT INTO dbo.UsuarioEstrategias (id_usuario, codigo_estrategia) VALUES (?, ?)',
        [id, codigo]
      );
    }
    await execute('COMMIT');
    res.json({ ok: true, usuario: await cargarUsuario(id) });
  } catch (err) {
    try { await execute('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}));

/* Catalogos -------------------------------------------------------------------------------- */

app.get('/api/estrategias', asyncHandler(async (req, res) => {
  const rows = await query(`
    SELECT e.id_estrategia, e.codigo, e.nombre, e.orden,
           COUNT(DISTINCT r.id_regla) AS reglas,
           COUNT(DISTINCT CASE WHEN r.activo = 1 THEN r.id_regla END) AS reglas_activas
    FROM dbo.Estrategias e
      LEFT JOIN dbo.Subproductos s ON s.id_estrategia = e.id_estrategia
      LEFT JOIN dbo.Reglas r ON r.id_subproducto = s.id_subproducto
    WHERE e.activo = 1
    GROUP BY e.id_estrategia, e.codigo, e.nombre, e.orden
    ORDER BY e.orden`);

  const visibles = req.usuario.rol === ROLES.ADMIN
    ? rows
    : rows.filter((e) => tieneEstrategia(req.usuario, e.codigo));
  res.json(visibles);
}));

app.get('/api/anios', asyncHandler(async (_req, res) => {
  const rows = await aniosDisponibles();
  res.json(rows.map((r) => r.anio));
}));

app.get('/api/establecimientos', asyncHandler(async (_req, res) => {
  const rows = await query(`
    SELECT id_establecimiento AS id, nombre_establecimiento AS nombre,
           red, microred, categoria_establecimiento AS categoria,
           descripcion_sector, departamento, codigo_unico
    FROM dbo.establecimientos
    WHERE UPPER(TRIM(COALESCE(descripcion_sector, ''))) = 'GOBIERNO REGIONAL'
      AND UPPER(TRIM(COALESCE(departamento, ''))) = 'SAN MARTIN'
      AND UPPER(TRIM(COALESCE(red, ''))) IN ('EL DORADO', 'LAMAS', 'PICOTA', 'SAN MARTIN')
    ORDER BY nombre_establecimiento`);
  res.json(rows);
}));

/* Reporte nominal PostgreSQL -------------------------------------------------------------- */

app.get('/api/nominal/importaciones', asyncHandler(async (_req, res) => {
  res.json(await listarImportacionesHIS());
}));

app.post('/api/nominal/importaciones', soloAdmin, asyncHandler(async (req, res) => {
  const archivo = texto(req.body?.archivo, 260) || 'trama.csv';
  const contenido = String(req.body?.contenido || '');
  if (!contenido.trim()) return res.status(400).json({ error: 'Debe enviar el contenido del CSV' });
  const resultado = await importarTramaHIS({ archivo, contenido, anio: num(req.body?.anio), mes: num(req.body?.mes) });
  res.status(201).json({ ok: true, ...resultado });
}));

app.get('/api/nominal/indicadores', asyncHandler(async (_req, res) => {
  res.json(await listarIndicadoresNominales());
}));

app.get('/api/nominal/indicadores/analisis', asyncHandler(async (req, res) => {
  const anio = num(req.query.anio);
  if (!anio) return res.status(400).json({ error: 'Debe indicar el año' });
  res.json(await analizarIndicadoresNominales(anio));
}));

app.post('/api/nominal/indicadores/aplicar-analisis', soloAdmin, asyncHandler(async (req, res) => {
  const anio = num(req.body?.anio);
  if (!anio) return res.status(400).json({ error: 'Debe indicar el año' });
  res.json({ ok: true, ...(await aplicarAnalisisNominal(anio)) });
}));

app.put('/api/nominal/indicadores/:codigo', soloAdmin, asyncHandler(async (req, res) => {
  const codigo = texto(req.params.codigo, 30);
  if (!codigo) return res.status(400).json({ error: 'Código de indicador inválido' });
  const indicador = await actualizarIndicador(codigo, req.body || {});
  if (!indicador) return res.status(404).json({ error: 'Indicador no encontrado' });
  res.json(indicador);
}));

app.post('/api/nominal/generar', soloAdmin, asyncHandler(async (req, res) => {
  res.json({ ok: true, ...(await generarNominal({ anio: num(req.body?.anio), mes: num(req.body?.mes) })) });
}));

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

app.get('/api/nominal/reporte', asyncHandler(async (req, res) => {
  const formato = String(req.query.formato || '').toLowerCase();
  const paginaSolicitada = formato !== 'csv' && num(req.query.pagina) > 0;
  const pagina = paginaSolicitada ? num(req.query.pagina) : undefined;
  const limite = paginaSolicitada ? Math.min(200, Math.max(25, num(req.query.limite) || 100)) : undefined;
  const resultado = await resumenNominal({
    anio: num(req.query.anio),
    mes: num(req.query.mes),
    idEstablecimiento: num(req.query.id_establecimiento),
    pagina,
    limite
  });
  const rows = Array.isArray(resultado) ? resultado : resultado.rows;
  const indicators = await listarIndicadoresNominales();
  const grouped = new Map();
  for (const row of rows) {
    const key = [row.anio, row.mes, row.id_establecimiento, row.id_paciente].join('|');
    if (!grouped.has(key)) grouped.set(key, { ...row, indicadores_marcados: 0 });
    const item = grouped.get(key);
    item[row.indicador] = row.estado === 'CONFIRMADA' ? Number(row.valor) || 0 : null;
    if (row.estado === 'CONFIRMADA') item.indicadores_marcados += Number(row.valor) || 0;
  }
  const data = [...grouped.values()].map((item) => {
    const output = {
      DNI: item.numero_documento, Tipo_Doc: item.tipo_documento, Genero: item.genero,
      Edad: item.edad, Establecimiento: item.establecimiento, Anio: item.anio, Mes: item.mes,
      Indicadores_Marcados: item.indicadores_marcados
    };
    for (const indicator of indicators) output[indicator.codigo] = item[indicator.codigo] ?? null;
    return output;
  });
  if (formato === 'csv') {
    const columns = ['DNI', 'Tipo_Doc', 'Genero', 'Edad', 'Establecimiento', 'Anio', 'Mes', ...indicators.map((i) => i.codigo), 'Indicadores_Marcados'];
    const csv = [columns.join(';'), ...data.map((row) => columns.map((column) => csvCell(row[column])).join(';'))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="reporte_nominal_pp0018.csv"');
    return res.send(`\uFEFF${csv}`);
  }
  const total = Array.isArray(resultado) ? data.length : resultado.total;
  res.json({ indicadores: indicators, total, pagina: resultado.pagina || null, limite: resultado.limite || null, filas: data });
}));

/* Reporte nominal -------------------------------------------------------------------------- */

app.get('/api/nominal/actividades', asyncHandler(async (req, res) => {
  const estrategia = texto(req.query.estrategia, 60);
  const anio = num(req.query.anio);
  const filtros = {
    mes: num(req.query.mes) || null,
    red: texto(req.query.red, 80),
    microred: texto(req.query.microred, 100),
    idEstablecimiento: num(req.query.id_establecimiento) || null
  };

  if (!estrategia) return res.status(400).json({ error: 'Debe indicar la estrategia' });
  if (!anio) return res.status(400).json({ error: 'Debe indicar el año' });
  if (!tieneEstrategia(req.usuario, estrategia)) {
    return res.status(403).json({ error: 'No tiene acceso a esta estrategia' });
  }

  const data = await listarActividades(estrategia, anio, filtros);
  if (!data) return res.status(404).json({ error: 'Estrategia no encontrada' });
  res.json(data);
}));

app.get('/api/nominal/pacientes', asyncHandler(async (req, res) => {
  const idSubproducto = num(req.query.id_subproducto);
  const anio = num(req.query.anio);
  const mes = num(req.query.mes);
  const idEstablecimiento = num(req.query.id_establecimiento);
  const red = texto(req.query.red, 80);
  const microred = texto(req.query.microred, 100);
  const buscar = texto(req.query.buscar, 80);
  const page = Math.max(1, num(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, num(req.query.pageSize) || 50));

  if (!idSubproducto) return res.status(400).json({ error: 'Debe indicar la actividad' });
  if (!anio) return res.status(400).json({ error: 'Debe indicar el año' });

  const actividad = await obtenerActividad(idSubproducto);
  if (!actividad) return res.status(404).json({ error: 'Actividad no encontrada' });
  if (!tieneEstrategia(req.usuario, actividad.estrategia_codigo)) {
    return res.status(403).json({ error: 'No tiene acceso a esta estrategia' });
  }

  const data = await listarPacientes(actividad, {
    anio, mes, red, microred, idEstablecimiento, buscar, page, pageSize
  });
  res.json(data);
}));

/* Reglas ----------------------------------------------------------------------------------- */

app.get('/api/reglas', asyncHandler(async (req, res) => {
  const { estrategia, buscar } = req.query;
  const anio = num(req.query.anio);
  const mes = num(req.query.mes);
  const idEst = num(req.query.id_establecimiento);
  const soloActivas = String(req.query.activo || '') === '1';

  const where = [];
  const params = [];

  if (estrategia && estrategia !== 'Todas') {
    if (!tieneEstrategia(req.usuario, estrategia)) {
      return res.status(403).json({ error: 'No tiene acceso a esta estrategia' });
    }
    where.push('(v.estrategia_codigo = ? OR v.estrategia = ?)');
    params.push(String(estrategia).toUpperCase(), String(estrategia));
  } else if (req.usuario.rol !== ROLES.ADMIN) {
    const permitidas = (req.usuario.estrategias || []).map((c) => String(c).toUpperCase());
    if (!permitidas.length) return res.json({ total: 0, reglas: [] });
    where.push(`v.estrategia_codigo IN (${permitidas.map(() => '?').join(',')})`);
    params.push(...permitidas);
  }
  if (buscar) {
    where.push('(v.subproducto LIKE ? OR v.regla_original LIKE ? OR v.codigos_inclusion LIKE ? OR v.proceso LIKE ?)');
    const like = `%${buscar}%`;
    params.push(like, like, like, like);
  }
  if (soloActivas) where.push('v.activo = 1');

  let valorSelect = '';
  let valorJoin = '';
  const valorParams = [];
  if (anio) {
    let filtro = 'vr.anio = ?';
    valorParams.push(anio);
    if (mes) { filtro += ' AND vr.mes = ?'; valorParams.push(mes); }
    if (idEst) { filtro += ' AND vr.id_establecimiento = ?'; valorParams.push(idEst); }
    valorSelect = ', ISNULL(val.valor, 0) AS valor';
    valorJoin = `LEFT JOIN (
        SELECT id_regla, SUM(valor) AS valor FROM dbo.SupervisionResultados vr
        WHERE ${filtro} GROUP BY id_regla
      ) val ON val.id_regla = v.id_regla`;
  }

  const sql = `
    SELECT v.*, s.id_producto, p.nombre AS producto${valorSelect}
    FROM dbo.vw_ReglasCompletas v
      LEFT JOIN dbo.Subproductos s ON s.id_subproducto = v.id_subproducto
      LEFT JOIN dbo.Productos p ON p.id_producto = s.id_producto
    ${valorJoin}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY v.estrategia, v.subproducto, v.id_regla`;

  // El orden de los parametros sigue el orden textual del SQL: JOIN primero, WHERE despues.
  const rows = await query(sql, [...valorParams, ...params]);
  res.json({ total: rows.length, reglas: rows.map(mapReglaApi) });
}));

app.get('/api/reglas/:id', asyncHandler(async (req, res) => {
  const id = num(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id invalido' });

  const rows = await query('SELECT * FROM dbo.vw_ReglasCompletas WHERE id_regla = ?', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Regla no encontrada' });
  if (!tieneEstrategia(req.usuario, rows[0].estrategia_codigo)) {
    return res.status(403).json({ error: 'No tiene acceso a esta estrategia' });
  }

  const codigos = await query(
    `SELECT codigo, tipo_codigo, es_exclusion, es_requerido, grupo, valor_lab, tipo_dx
     FROM dbo.ReglaCodigos WHERE id_regla = ?
     ORDER BY es_exclusion, es_requerido, grupo, tipo_codigo, codigo`,
    [id]
  );
  res.json({ ...mapReglaApi(rows[0]), detalle_codigos: codigos });
}));

app.post('/api/reglas', soloAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const estrategia = await resolverEstrategia(body.estrategia_codigo || body.estrategia);
  if (!estrategia) return res.status(400).json({ error: 'Estrategia no valida' });

  const subproducto = texto(body.subproducto, 500);
  if (!subproducto) return res.status(400).json({ error: 'El subproducto es obligatorio' });

  const n = normalizarRegla(body, estrategia.codigo);

  await execute('BEGIN TRANSACTION');
  try {
    const { idSubproducto, idUnidad } = await upsertSubproducto(
      estrategia.id_estrategia,
      subproducto,
      n.subproducto.codigo,
      n.subproducto.unidadCodigo
    );

    const rows = await query(
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
        n.codigo_origen || body.codigo_origen || null,
        idSubproducto, n.fuente, n.proceso, n.tipo_dx, n.valor_lab, n.lab_modo,
        n.lab_min, n.lab_max, n.lab_min_incl, n.lab_max_incl,
        n.edad_min_meses, n.edad_max_meses, n.condicion_sexo, n.solo_gestante,
        n.excluir_gestante, n.id_financiador,
        n.id_ups, n.pab_op, n.pab_femenino, n.pab_masculino,
        idUnidad, n.restriccion, n.nivel_restriccion, n.regla_original
      ]
    );
    const idRegla = rows[0].id_regla;

    for (const inc of n.inclusiones) {
      await execute(
        'INSERT INTO dbo.ReglaCodigos (id_regla, codigo, tipo_codigo, es_exclusion) VALUES (?, ?, ?, 0)',
        [idRegla, inc.code, inc.tipo]
      );
    }
    for (const exc of n.exclusiones) {
      await execute(
        'INSERT INTO dbo.ReglaCodigos (id_regla, codigo, tipo_codigo, es_exclusion) VALUES (?, ?, ?, 1)',
        [idRegla, exc, 'CPT']
      );
    }
    for (const req of n.requeridos) {
      await execute(
        `INSERT INTO dbo.ReglaCodigos
           (id_regla, codigo, tipo_codigo, es_exclusion, es_requerido, grupo, valor_lab, tipo_dx)
         VALUES (?, ?, ?, 0, 1, ?, ?, ?)`,
        [idRegla, req.codigo, req.tipo, req.grupo, req.valor_lab, req.tipo_dx]
      );
    }

    await execute('COMMIT');
    res.status(201).json({ ok: true, id_regla: idRegla, recalcular: true });
  } catch (err) {
    try { await execute('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}));

app.put('/api/reglas/:id', soloAdmin, asyncHandler(async (req, res) => {
  const id = num(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id invalido' });

  const existente = await query('SELECT id_regla FROM dbo.Reglas WHERE id_regla = ?', [id]);
  if (!existente.length) return res.status(404).json({ error: 'Regla no encontrada' });

  const body = req.body || {};
  const estrategia = await resolverEstrategia(body.estrategia_codigo || body.estrategia);
  if (!estrategia) return res.status(400).json({ error: 'Estrategia no valida' });

  const subproducto = texto(body.subproducto, 500);
  if (!subproducto) return res.status(400).json({ error: 'El subproducto es obligatorio' });

  const n = normalizarRegla(body, estrategia.codigo);

  await execute('BEGIN TRANSACTION');
  try {
    const { idSubproducto, idUnidad } = await upsertSubproducto(
      estrategia.id_estrategia,
      subproducto,
      n.subproducto.codigo,
      n.subproducto.unidadCodigo
    );

    await execute(
      `UPDATE dbo.Reglas SET
          id_subproducto = ?, fuente = ?, proceso = ?, tipo_dx = ?, valor_lab = ?, lab_modo = ?,
          lab_min = ?, lab_max = ?, lab_min_incl = ?, lab_max_incl = ?,
          edad_min_meses = ?, edad_max_meses = ?, condicion_sexo = ?, solo_gestante = ?,
          excluir_gestante = ?, id_financiador = ?, id_ups = ?, pab_op = ?, pab_femenino = ?,
          pab_masculino = ?, id_unidad = ?, restriccion = ?, nivel_restriccion = ?,
          regla_original = ?, fecha_modificacion = SYSUTCDATETIME()
       WHERE id_regla = ?`,
      [
        idSubproducto, n.fuente, n.proceso, n.tipo_dx, n.valor_lab, n.lab_modo,
        n.lab_min, n.lab_max, n.lab_min_incl, n.lab_max_incl,
        n.edad_min_meses, n.edad_max_meses, n.condicion_sexo, n.solo_gestante,
        n.excluir_gestante, n.id_financiador, n.id_ups, n.pab_op, n.pab_femenino,
        n.pab_masculino, idUnidad, n.restriccion, n.nivel_restriccion, n.regla_original, id
      ]
    );

    await execute('DELETE FROM dbo.ReglaCodigos WHERE id_regla = ?', [id]);
    for (const inc of n.inclusiones) {
      await execute(
        'INSERT INTO dbo.ReglaCodigos (id_regla, codigo, tipo_codigo, es_exclusion) VALUES (?, ?, ?, 0)',
        [id, inc.code, inc.tipo]
      );
    }
    for (const exc of n.exclusiones) {
      await execute(
        'INSERT INTO dbo.ReglaCodigos (id_regla, codigo, tipo_codigo, es_exclusion) VALUES (?, ?, ?, 1)',
        [id, exc, 'CPT']
      );
    }
    for (const req of n.requeridos) {
      await execute(
        `INSERT INTO dbo.ReglaCodigos
           (id_regla, codigo, tipo_codigo, es_exclusion, es_requerido, grupo, valor_lab, tipo_dx)
         VALUES (?, ?, ?, 0, 1, ?, ?, ?)`,
        [id, req.codigo, req.tipo, req.grupo, req.valor_lab, req.tipo_dx]
      );
    }

    // Los resultados previos de esta regla quedan obsoletos.
    await execute('DELETE FROM dbo.SupervisionResultados WHERE id_regla = ?', [id]);

    await execute('COMMIT');
    res.json({ ok: true, id_regla: id, recalcular: true });
  } catch (err) {
    try { await execute('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}));

app.delete('/api/reglas/:id', soloAdmin, asyncHandler(async (req, res) => {
  const id = num(req.params.id);
  if (!id) return res.status(400).json({ error: 'Id invalido' });
  const result = await execute('DELETE FROM dbo.Reglas WHERE id_regla = ?', [id]);
  // Limpia subproductos que quedaron sin reglas (los que crea el formulario).
  await execute(`
    DELETE FROM dbo.Subproductos
    WHERE NOT EXISTS (SELECT 1 FROM dbo.Reglas r WHERE r.id_subproducto = dbo.Subproductos.id_subproducto)`);
  res.json({ ok: true, id_regla: id, affected: result?.rowCount ?? null });
}));

/* Importación masiva ---------------------------------------------------------------------- */

app.post('/api/importar', soloAdmin, asyncHandler(async (req, res) => {
  const lista = req.body?.reglas;
  if (!Array.isArray(lista) || lista.length === 0) {
    return res.status(400).json({ error: 'Debe enviar un arreglo "reglas" con al menos una regla' });
  }
  const stats = await importarReglas(lista, { reemplazar: true });
  res.json({ ok: true, ...stats, recalcular: true });
}));

/* Resumen / dashboard ---------------------------------------------------------------------- */

app.get('/api/resumen', soloAdmin, asyncHandler(async (req, res) => {
  const anio = num(req.query.anio);
  const mes = num(req.query.mes);
  const idEst = num(req.query.id_establecimiento);
  const red = String(req.query.red || '').trim();
  const microred = String(req.query.microred || '').trim();
  const estrategia = req.query.estrategia;
  const usarEstrategia = estrategia && estrategia !== 'Todas';

  const filtros = [];
  const params = [];
  if (anio) { filtros.push('r.anio = ?'); params.push(anio); }
  if (mes) { filtros.push('r.mes = ?'); params.push(mes); }
  if (idEst) { filtros.push('r.id_establecimiento = ?'); params.push(idEst); }
  if (red) {
    filtros.push(`EXISTS (SELECT 1 FROM dbo.establecimientos e WHERE e.id_establecimiento = r.id_establecimiento AND LOWER(COALESCE(e.red, '')) = LOWER(?))`);
    params.push(red);
  }
  if (microred) {
    filtros.push(`EXISTS (SELECT 1 FROM dbo.establecimientos e WHERE e.id_establecimiento = r.id_establecimiento AND LOWER(COALESCE(e.microred, '')) = LOWER(?))`);
    params.push(microred);
  }
  const whereRes = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

  const whereEst = usarEstrategia ? 'AND (v.estrategia_codigo = ? OR v.estrategia = ?)' : '';
  const paramsEst = usarEstrategia ? [String(estrategia).toUpperCase(), String(estrategia)] : [];

  const [kpis] = await query(`
    WITH agg AS (
      SELECT r.id_regla, SUM(r.valor) AS total
      FROM dbo.SupervisionResultados r
      ${whereRes}
      GROUP BY r.id_regla
    )
    SELECT
      COUNT(*) AS reglas_con_datos,
      ISNULL(SUM(CASE WHEN v.tipo_agregacion = 'SUM_LAB' THEN 0 ELSE a.total END), 0) AS total_registros,
      ISNULL(SUM(CASE WHEN v.tipo_agregacion = 'SUM_LAB' THEN a.total ELSE 0 END), 0) AS total_piezas
    FROM agg a
      JOIN dbo.vw_ReglasCompletas v ON v.id_regla = a.id_regla
    WHERE 1 = 1 ${whereEst}`,
    [...params, ...paramsEst]);

  const [reglas] = await query(`
    SELECT COUNT(*) AS reglas_totales
    FROM dbo.vw_ReglasCompletas v
    WHERE v.activo = 1 ${whereEst}`,
    [...paramsEst]);

  const porMes = await query(`
    SELECT r.mes,
           ISNULL(SUM(CASE WHEN v.tipo_agregacion = 'SUM_LAB' THEN 0 ELSE r.valor END), 0) AS total,
           COUNT(DISTINCT r.id_regla) AS reglas
    FROM dbo.SupervisionResultados r
      JOIN dbo.vw_ReglasCompletas v ON v.id_regla = r.id_regla
    ${whereRes} ${whereEst}
    GROUP BY r.mes ORDER BY r.mes`,
    [...params, ...paramsEst]);

  const porEstrategia = await query(`
    SELECT v.estrategia_codigo, v.estrategia,
           ISNULL(SUM(CASE WHEN v.tipo_agregacion = 'SUM_LAB' THEN 0 ELSE r.valor END), 0) AS total,
           COUNT(DISTINCT r.id_regla) AS reglas
    FROM dbo.SupervisionResultados r
      JOIN dbo.vw_ReglasCompletas v ON v.id_regla = r.id_regla
    ${whereRes} ${whereEst}
    GROUP BY v.estrategia_codigo, v.estrategia
    ORDER BY total DESC`,
    [...params, ...paramsEst]);

  const topSubproductos = await query(`
    SELECT v.estrategia, v.subproducto, v.unidad_medida, v.tipo_agregacion,
           SUM(r.valor) AS total
    FROM dbo.SupervisionResultados r
      JOIN dbo.vw_ReglasCompletas v ON v.id_regla = r.id_regla
    ${whereRes} ${whereEst}
    GROUP BY v.estrategia, v.subproducto, v.unidad_medida, v.tipo_agregacion
    ORDER BY total DESC
    LIMIT 15`,
    [...params, ...paramsEst]);

  const porEstablecimiento = await query(`
    SELECT r.id_establecimiento,
           ISNULL(e.Nombre_Establecimiento, CONCAT('EESS ', r.id_establecimiento)) AS establecimiento,
           ISNULL(SUM(CASE WHEN v.tipo_agregacion = 'SUM_LAB' THEN 0 ELSE r.valor END), 0) AS total
    FROM dbo.SupervisionResultados r
      JOIN dbo.vw_ReglasCompletas v ON v.id_regla = r.id_regla
      LEFT JOIN [${CATALOG_DB}].[dbo].[Establecimientos] e ON e.Id_Establecimiento = r.id_establecimiento
    ${whereRes} ${whereEst}
    GROUP BY r.id_establecimiento, e.Nombre_Establecimiento
    ORDER BY total DESC`,
    [...params, ...paramsEst]);

  res.json({
    filtros: { anio, mes, estrategia: usarEstrategia ? estrategia : null, red: red || null, microred: microred || null, id_establecimiento: idEst },
    kpis: {
      reglas_totales: reglas?.reglas_totales || 0,
      reglas_con_datos: kpis?.reglas_con_datos || 0,
      total_registros: kpis?.total_registros || 0,
      total_piezas: kpis?.total_piezas || 0
    },
    porMes,
    porEstrategia,
    topSubproductos,
    porEstablecimiento
  });
}));

/* Sincronizacion --------------------------------------------------------------------------- */

let sincronizando = false;
let progresoSync = null;

app.get('/api/sync/estado', asyncHandler(async (req, res) => {
  const anio = num(req.query.anio) || new Date().getFullYear();
  if (sincronizando && progresoSync) {
    return res.json({ anio, en_proceso: true, estado: null, progreso: progresoSync });
  }
  const estado = await ultimoSync(anio);
  const progreso = progresoSync?.anio === anio ? progresoSync : null;
  res.json({ anio, en_proceso: false, estado, progreso });
}));

app.post('/api/sync', soloAdmin, asyncHandler(async (req, res) => {
  if (sincronizando) {
    return res.status(409).json({ error: 'Ya hay una sincronizacion en curso' });
  }
  let anio = num(req.body?.anio);
  if (!anio) {
    const rows = await query(`
      SELECT MAX(anio) AS anio FROM (
        SELECT CAST(ANIO AS INT) AS anio FROM [${process.env.DB_SOURCE_DATABASE || 'DataHIS'}].[dbo].[HIS_Nominal]
      ) t`);
    anio = rows[0]?.anio || new Date().getFullYear();
  }

  sincronizando = true;
  progresoSync = {
    anio, porcentaje: 1, etapa: 'his', mensaje: 'Iniciando sincronización',
    detalle: 'Preparando el procesamiento del año seleccionado.',
    filas_procesadas: 0, reglas_completadas: 0, reglas_totales: 0,
    en_proceso: true, actualizado: new Date().toISOString()
  };
  res.status(202).json({ ok: true, anio, estado: 'EN_PROCESO' });

  // Se difiere para que la respuesta 202 salga antes de que el motor acapare el event loop.
  setImmediate(() => {
    sincronizar(anio, {
      onProgress: (avance) => {
        progresoSync = { ...progresoSync, ...avance, anio, en_proceso: true, actualizado: new Date().toISOString() };
      }
    })
      .then((resultado) => {
        console.log('Sincronizacion OK:', JSON.stringify(resultado));
        progresoSync = {
          ...progresoSync, porcentaje: 99, etapa: 'resumen', mensaje: 'Sincronización finalizada',
          detalle: 'Datos calculados; el reporte está actualizando sus resultados.',
          filas_procesadas: resultado.filas_staging,
          reglas_completadas: resultado.reglas_ejecutadas, reglas_totales: resultado.reglas_totales,
          en_proceso: false, actualizado: new Date().toISOString()
        };
      })
      .catch((error) => {
        console.error('Sincronizacion ERROR:', error.message);
        progresoSync = {
          ...progresoSync, etapa: 'error', mensaje: 'La sincronización no se pudo completar',
          detalle: String(error.message || error), error: true, en_proceso: false,
          actualizado: new Date().toISOString()
        };
      })
      .finally(() => {
        sincronizando = false;
        if (progresoSync) progresoSync.en_proceso = false;
      });
  });
}));

/* Frontend compilado (produccion) ---------------------------------------------------------- */

const distPath = path.resolve(__dirname, '..', 'client', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

/* Manejo de errores ------------------------------------------------------------------------ */

app.use((err, _req, res, _next) => {
  console.error('API ERROR:', err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Error interno del servidor' });
});

/* Arranque --------------------------------------------------------------------------------- */

const server = app.listen(PORT, async () => {
  console.log(`API PP0018 escuchando en http://localhost:${PORT}`);
  try {
    const info = await ping();
    console.log(`PostgreSQL OK -> ${info.server_name || 'localhost'} / ${info.database_name}`);
  } catch (err) {
    console.error('No se pudo conectar a PostgreSQL:', err.message);
  }
});

async function shutdown(signal) {
  console.log(`\n${signal} recibido, cerrando...`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app };
