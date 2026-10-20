import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from './db.js';
import { HttpError } from './util.js';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET es obligatorio en producción');
    return 'dev-secret-no-usar-en-produccion';
  }
  return s;
}

export const hashPassword = (p) => bcrypt.hashSync(p, 10);
export const checkPassword = (p, h) => bcrypt.compareSync(p, h);

export const signToken = (user) =>
  jwt.sign({ sub: user.id }, secret(), { expiresIn: process.env.JWT_EXPIRES || '12h' });

export const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active });

export async function authenticate(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw new HttpError(401, 'No autenticado');
  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch {
    throw new HttpError(401, 'Sesión inválida o expirada');
  }
  const { rows } = await query('SELECT * FROM users WHERE id=$1', [payload.sub]);
  const user = rows[0];
  if (!user || !user.active) throw new HttpError(401, 'Usuario inactivo o inexistente');
  req.user = user;
  next();
}

export function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') throw new HttpError(403, 'Requiere rol administrador');
  next();
}

// Crea el primer admin si no hay usuarios (ADMIN_EMAIL / ADMIN_PASSWORD).
export async function seedAdmin() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  const prod = process.env.NODE_ENV === 'production';
  const email = (process.env.ADMIN_EMAIL || (prod ? '' : 'admin@quot.cl')).toLowerCase();
  const password = process.env.ADMIN_PASSWORD || (prod ? '' : 'cambiar123');
  if (!email || !password) {
    console.warn('[seed] No hay usuarios y faltan ADMIN_EMAIL/ADMIN_PASSWORD: no se creó admin.');
    return;
  }
  await query('INSERT INTO users(email,name,password_hash,role) VALUES($1,$2,$3,$4)', [
    email,
    process.env.ADMIN_NAME || 'Administrador',
    hashPassword(password),
    'admin',
  ]);
  console.log(`[seed] Admin creado: ${email}${process.env.ADMIN_PASSWORD ? '' : ' (clave de desarrollo: cambiar123)'}`);
}
