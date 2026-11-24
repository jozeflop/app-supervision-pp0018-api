/**
 * crear-usuario.js - Crea o actualiza un usuario del aplicativo.
 * ------------------------------------------------------------------------------------------
 * Uso:
 *   node scripts/crear-usuario.js --usuario admin --nombre "Administrador" --rol ADMIN --password "MiClave2026!"
 *   node scripts/crear-usuario.js --usuario ocular --nombre "Coordinador Salud Ocular" --rol COORDINADOR --password "Ocular2026!" --estrategias SALUD_OCULAR
 *
 * Si el usuario ya existe, actualiza sus datos, contraseña y estrategias.
 */
import dotenv from 'dotenv';
import { query, execute, closePool } from '../db.js';
import { ROLES, hashPassword } from '../services/auth.js';

dotenv.config();

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    out[name] = value;
  }
  return out;
}

async function main() {
  const a = args();
  const usuario = String(a.usuario || '').trim();
  const nombre = String(a.nombre || '').trim();
  const rol = String(a.rol || ROLES.COORDINADOR).toUpperCase();
  const password = String(a.password || '');
  const activo = String(a.activo ?? '1') !== '0';
  const estrategias = String(a.estrategias || '')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

  if (!usuario || !/^[A-Za-z0-9._-]{3,60}$/.test(usuario)) {
    throw new Error('Indique --usuario valido (3-60: letras, numeros, punto, guion, guion bajo)');
  }
  if (!nombre) throw new Error('Indique --nombre');
  if (password.length < 8) throw new Error('Indique --password de al menos 8 caracteres');
  if (![ROLES.ADMIN, ROLES.COORDINADOR].includes(rol)) throw new Error('--rol debe ser ADMIN o COORDINADOR');

  if (rol === ROLES.COORDINADOR && !estrategias.length) {
    throw new Error('Un COORDINADOR requiere --estrategias (ej. SALUD_OCULAR o SALUD_OCULAR,NO_TRANSMISIBLE)');
  }

  if (estrategias.length) {
    const validas = await query(
      `SELECT codigo FROM dbo.Estrategias WHERE codigo IN (${estrategias.map(() => '?').join(',')})`,
      estrategias
    );
    const set = new Set(validas.map((r) => r.codigo));
    const invalidas = estrategias.filter((e) => !set.has(e));
    if (invalidas.length) throw new Error(`Estrategias invalidas: ${invalidas.join(', ')}`);
  }

  const existe = await query('SELECT id_usuario FROM dbo.Usuarios WHERE usuario = ?', [usuario]);
  const { hash, salt } = hashPassword(password);

  let idUsuario;
  if (existe.length) {
    idUsuario = existe[0].id_usuario;
    await execute(
      `UPDATE dbo.Usuarios
       SET nombre = ?, rol = ?, activo = ?, password_hash = ?, password_salt = ?,
           fecha_modificacion = SYSUTCDATETIME()
       WHERE id_usuario = ?`,
      [nombre, rol, activo ? 1 : 0, hash, salt, idUsuario]
    );
    await execute('DELETE FROM dbo.UsuarioEstrategias WHERE id_usuario = ?', [idUsuario]);
  } else {
    const rows = await query(
      `INSERT INTO dbo.Usuarios (usuario, nombre, password_hash, password_salt, rol, activo)
       OUTPUT INSERTED.id_usuario
       VALUES (?, ?, ?, ?, ?, ?)`,
      [usuario, nombre, hash, salt, rol, activo ? 1 : 0]
    );
    idUsuario = rows[0].id_usuario;
  }

  if (rol !== ROLES.ADMIN) {
    for (const codigo of estrategias) {
      await execute(
        'INSERT INTO dbo.UsuarioEstrategias (id_usuario, codigo_estrategia) VALUES (?, ?)',
        [idUsuario, codigo]
      );
    }
  }

  console.log(`Usuario ${existe.length ? 'actualizado' : 'creado'}: ${usuario} (${rol}) id=${idUsuario}`);
  if (rol === ROLES.ADMIN) console.log('  Estrategias: TODAS');
  else console.log(`  Estrategias: ${estrategias.join(', ')}`);
}

main()
  .then(async () => { await closePool(); process.exit(0); })
  .catch(async (err) => {
    console.error('ERROR:', err.message);
    try { await closePool(); } catch { /* ignore */ }
    process.exit(1);
  });
