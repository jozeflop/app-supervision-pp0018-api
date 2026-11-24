/**
 * auth.js - Autenticacion y autorizacion por roles.
 * ------------------------------------------------------------------------------------------
 * - Password: scrypt con sal aleatoria (sin dependencias externas).
 * - Sesion: token firmado con HMAC-SHA256 (Bearer token).
 * - Roles: ADMIN (todo) | COORDINADOR (solo estrategias asignadas, sin reporte).
 *
 * Variables de entorno:
 *   AUTH_SECRET        secreto para firmar tokens (obligatorio en produccion)
 *   AUTH_EXPIRA_HORAS  duracion del token, por defecto 12 horas
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';

import { query } from '../db.js';

dotenv.config();

const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const EXPIRA_HORAS = Number(process.env.AUTH_EXPIRA_HORAS || 12);

if (!process.env.AUTH_SECRET) {
  console.warn('AUTH_SECRET no definido: se genero un secreto temporal. Las sesiones se invalidaran al reiniciar.');
}

export const ROLES = {
  ADMIN: 'ADMIN',
  COORDINADOR: 'COORDINADOR'
};

/* Password -------------------------------------------------------------------------------- */

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  try {
    const esperado = Buffer.from(String(hash), 'hex');
    const calculado = crypto.scryptSync(String(password), String(salt), 64);
    return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
  } catch {
    return false;
  }
}

/* Token ----------------------------------------------------------------------------------- */

function firma(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}

export function firmarToken(idUsuario, horas = EXPIRA_HORAS) {
  const payload = Buffer.from(JSON.stringify({
    sub: Number(idUsuario),
    exp: Date.now() + horas * 60 * 60 * 1000
  })).toString('base64url');
  return `${payload}.${firma(payload)}`;
}

export function verificarToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const esperada = firma(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.sub || !data?.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

/* Usuario --------------------------------------------------------------------------------- */

export async function cargarUsuario(idUsuario) {
  const rows = await query(
    `SELECT id_usuario, usuario, nombre, rol, activo
     FROM dbo.Usuarios WHERE id_usuario = ?`,
    [Number(idUsuario)]
  );
  if (!rows.length || !rows[0].activo) return null;

  const user = rows[0];
  const asignadas = user.rol === ROLES.ADMIN
    ? await query('SELECT codigo FROM dbo.Estrategias WHERE activo = 1 ORDER BY orden')
    : await query(
        `SELECT e.codigo
         FROM dbo.UsuarioEstrategias ue
           INNER JOIN dbo.Estrategias e ON e.codigo = ue.codigo_estrategia
         WHERE ue.id_usuario = ? AND e.activo = 1
         ORDER BY e.orden`,
        [user.id_usuario]
      );

  return {
    id_usuario: user.id_usuario,
    usuario: user.usuario,
    nombre: user.nombre,
    rol: user.rol,
    estrategias: asignadas.map((r) => r.codigo)
  };
}

export function codigosPermitidos(usuario) {
  return (usuario?.estrategias || []).map((c) => String(c).toUpperCase());
}

export function tieneEstrategia(usuario, codigo) {
  if (!usuario) return false;
  if (usuario.rol === ROLES.ADMIN) return true;
  const buscado = String(codigo || '').toUpperCase();
  return codigosPermitidos(usuario).includes(buscado);
}

/* Middleware ------------------------------------------------------------------------------ */

export async function autenticar(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Sesion requerida' });

    const data = verificarToken(token);
    if (!data) return res.status(401).json({ error: 'Sesion invalida o expirada' });

    const usuario = await cargarUsuario(data.sub);
    if (!usuario) return res.status(401).json({ error: 'Usuario inactivo o inexistente' });

    req.usuario = usuario;
    next();
  } catch (err) {
    next(err);
  }
}

export function soloAdmin(req, res, next) {
  if (req.usuario?.rol !== ROLES.ADMIN) {
    return res.status(403).json({ error: 'Se requiere rol ADMIN' });
  }
  next();
}
