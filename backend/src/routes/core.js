import { Router } from 'express';
import { query, tx, getSettings } from '../db.js';
import { authenticate, requireAdmin, checkPassword, hashPassword, signToken, publicUser } from '../auth.js';
import { HttpError, parseMoney } from '../util.js';

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// ------------------------------------------------------------------ AUTH
export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const email = str(req.body.email).toLowerCase();
  const { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
  const u = rows[0];
  if (!u || !u.active || !checkPassword(String(req.body.password || ''), u.password_hash)) {
    throw new HttpError(401, 'Correo o contraseña incorrectos');
  }
  res.json({ token: signToken(u), user: publicUser(u) });
});

authRouter.get('/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));

authRouter.post('/password', authenticate, async (req, res) => {
  const { current, next } = req.body;
  if (!next || String(next).length < 8) throw new HttpError(400, 'La nueva contraseña debe tener al menos 8 caracteres');
  if (!checkPassword(String(current || ''), req.user.password_hash)) throw new HttpError(400, 'Contraseña actual incorrecta');
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(String(next)), req.user.id]);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ USERS (admin)
export const usersRouter = Router();
usersRouter.use(authenticate, requireAdmin);

usersRouter.get('/', async (_req, res) => {
  const { rows } = await query('SELECT id,email,name,role,active,created_at FROM users ORDER BY id');
  res.json(rows);
});

usersRouter.post('/', async (req, res) => {
  const email = str(req.body.email).toLowerCase();
  const name = str(req.body.name);
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Correo inválido');
  if (!name) throw new HttpError(400, 'Nombre obligatorio');
  if (password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
  const dup = await query('SELECT 1 FROM users WHERE email=$1', [email]);
  if (dup.rows.length) throw new HttpError(409, 'Ya existe un usuario con ese correo');
  const { rows } = await query(
    'INSERT INTO users(email,name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,email,name,role,active',
    [email, name, hashPassword(password), role]
  );
  res.status(201).json(rows[0]);
});

usersRouter.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query('SELECT * FROM users WHERE id=$1', [id]);
  const u = rows[0];
  if (!u) throw new HttpError(404, 'Usuario no encontrado');
  const role = req.body.role === undefined ? u.role : req.body.role === 'admin' ? 'admin' : 'user';
  const active = req.body.active === undefined ? u.active : !!req.body.active;
  if ((u.role === 'admin' && (role !== 'admin' || !active))) {
    const { rows: a } = await query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND active AND id<>$1", [id]);
    if (a[0].n === 0) throw new HttpError(400, 'Debe quedar al menos un administrador activo');
  }
  let hash = u.password_hash;
  if (req.body.password) {
    if (String(req.body.password).length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
    hash = hashPassword(String(req.body.password));
  }
  const out = await query(
    'UPDATE users SET name=$1, role=$2, active=$3, password_hash=$4 WHERE id=$5 RETURNING id,email,name,role,active',
    [str(req.body.name) || u.name, role, active, hash, id]
  );
  res.json(out.rows[0]);
});

// ------------------------------------------------------------------ SETTINGS
export const settingsRouter = Router();
settingsRouter.use(authenticate);

settingsRouter.get('/', async (_req, res) => res.json(await getSettings()));

const EDITABLE = ['company_name', 'company_rut', 'company_address', 'company_email', 'company_phone', 'company_web', 'iva_rate', 'quote_next_number', 'quote_validity_days', 'quote_terms', 'bank_holder', 'bank_rut', 'bank_name', 'bank_account_type', 'bank_account_number', 'bank_email'];
settingsRouter.put('/', requireAdmin, async (req, res) => {
  const body = req.body || {};
  if (body.quote_next_number !== undefined) {
    const n = Number(body.quote_next_number);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'El próximo correlativo debe ser un entero ≥ 1');
    const { rows } = await query('SELECT COALESCE(MAX(number),0)::int AS m FROM quotes');
    if (n <= rows[0].m) throw new HttpError(400, `Ya existen cotizaciones hasta el N° ${rows[0].m}; el próximo debe ser mayor`);
  }
  for (const k of EDITABLE) {
    if (body[k] === undefined) continue;
    await query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, String(body[k])]);
  }
  res.json(await getSettings());
});

// ------------------------------------------------------------------ PRODUCTS
export const productsRouter = Router();
productsRouter.use(authenticate);

const PCOLS = 'id, sku, name, description, price, active, updated_at';

productsRouter.get('/', async (req, res) => {
  const q = str(req.query.q);
  const onlyActive = req.query.active === '1';
  const params = [];
  const where = [];
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(LOWER(sku) LIKE $${params.length} OR LOWER(name) LIKE $${params.length} OR LOWER(description) LIKE $${params.length})`);
  }
  if (onlyActive) where.push('active');
  const { rows } = await query(`SELECT ${PCOLS} FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name LIMIT 2000`, params);
  res.json(rows);
});

function productInput(b, partial = false) {
  const out = {};
  if (!partial || b.sku !== undefined) {
    out.sku = str(b.sku);
    if (!out.sku) throw new HttpError(400, 'El código SKU es obligatorio');
  }
  if (!partial || b.name !== undefined) {
    out.name = str(b.name);
    if (!out.name) throw new HttpError(400, 'El nombre es obligatorio');
  }
  if (b.description !== undefined) out.description = str(b.description);
  if (b.price !== undefined) {
    out.price = parseMoney(b.price);
    if (out.price < 0) throw new HttpError(400, 'El precio no puede ser negativo');
  }
  if (b.active !== undefined) out.active = !!b.active;
  return out;
}

productsRouter.post('/', requireAdmin, async (req, res) => {
  const p = productInput(req.body);
  const dup = await query('SELECT 1 FROM products WHERE LOWER(sku)=LOWER($1)', [p.sku]);
  if (dup.rows.length) throw new HttpError(409, `Ya existe un producto con SKU ${p.sku}`);
  const { rows } = await query(
    `INSERT INTO products(sku,name,description,price,active) VALUES($1,$2,$3,$4,$5) RETURNING ${PCOLS}`,
    [p.sku, p.name, p.description || '', p.price ?? 0, p.active ?? true]
  );
  res.status(201).json(rows[0]);
});

productsRouter.patch('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const p = productInput(req.body, true);
  const keys = Object.keys(p);
  if (!keys.length) throw new HttpError(400, 'Nada que actualizar');
  if (p.sku) {
    const dup = await query('SELECT 1 FROM products WHERE LOWER(sku)=LOWER($1) AND id<>$2', [p.sku, id]);
    if (dup.rows.length) throw new HttpError(409, `Ya existe un producto con SKU ${p.sku}`);
  }
  const sets = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
  const { rows } = await query(`UPDATE products SET ${sets}, updated_at=now() WHERE id=$${keys.length + 1} RETURNING ${PCOLS}`, [...keys.map((k) => p[k]), id]);
  if (!rows[0]) throw new HttpError(404, 'Producto no encontrado');
  res.json(rows[0]);
});

productsRouter.delete('/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM products WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// Importación masiva (CSV ya parseado en el navegador). Upsert por SKU.
productsRouter.post('/import', requireAdmin, async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) throw new HttpError(400, 'No hay filas para importar');
  let created = 0, updated = 0, skipped = 0;
  await tx(async (t) => {
    for (const r of rows) {
      const sku = str(r.sku), name = str(r.name);
      if (!sku || !name) { skipped++; continue; }
      const ex = await t.query('SELECT id FROM products WHERE LOWER(sku)=LOWER($1)', [sku]);
      if (ex.rows[0]) {
        await t.query('UPDATE products SET name=$1, description=$2, price=$3, updated_at=now() WHERE id=$4', [name, str(r.description), parseMoney(r.price), ex.rows[0].id]);
        updated++;
      } else {
        await t.query('INSERT INTO products(sku,name,description,price) VALUES($1,$2,$3,$4)', [sku, name, str(r.description), parseMoney(r.price)]);
        created++;
      }
    }
  });
  res.json({ created, updated, skipped });
});

// ------------------------------------------------------------------ PIPELINE STATES
export const statesRouter = Router();
statesRouter.use(authenticate);

statesRouter.get('/', async (_req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.name, s.position, s.color, s.is_initial, (SELECT COUNT(*)::int FROM leads l WHERE l.state_id=s.id) AS leads
     FROM pipeline_states s ORDER BY s.position, s.id`
  );
  res.json(rows);
});

const colorOk = (c) => /^#[0-9a-fA-F]{6}$/.test(c || '');

statesRouter.post('/', requireAdmin, async (req, res) => {
  const name = str(req.body.name);
  if (!name) throw new HttpError(400, 'El nombre es obligatorio');
  const dup = await query('SELECT 1 FROM pipeline_states WHERE LOWER(name)=LOWER($1)', [name]);
  if (dup.rows.length) throw new HttpError(409, 'Ya existe un estado con ese nombre');
  const { rows: m } = await query('SELECT COALESCE(MAX(position),-1)::int + 1 AS p FROM pipeline_states');
  const { rows } = await query('INSERT INTO pipeline_states(name,position,color) VALUES($1,$2,$3) RETURNING *', [name, m[0].p, colorOk(req.body.color) ? req.body.color : '#64748b']);
  res.status(201).json(rows[0]);
});

statesRouter.put('/reorder', requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  await tx(async (t) => {
    for (let i = 0; i < ids.length; i++) await t.query('UPDATE pipeline_states SET position=$1 WHERE id=$2', [i, ids[i]]);
  });
  res.json({ ok: true });
});

statesRouter.patch('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query('SELECT * FROM pipeline_states WHERE id=$1', [id]);
  const s = rows[0];
  if (!s) throw new HttpError(404, 'Estado no encontrado');
  const name = req.body.name === undefined ? s.name : str(req.body.name);
  if (!name) throw new HttpError(400, 'El nombre es obligatorio');
  const dup = await query('SELECT 1 FROM pipeline_states WHERE LOWER(name)=LOWER($1) AND id<>$2', [name, id]);
  if (dup.rows.length) throw new HttpError(409, 'Ya existe un estado con ese nombre');
  const color = colorOk(req.body.color) ? req.body.color : s.color;
  await tx(async (t) => {
    if (req.body.is_initial === true) await t.query('UPDATE pipeline_states SET is_initial=FALSE');
    await t.query('UPDATE pipeline_states SET name=$1, color=$2, is_initial=$3 WHERE id=$4', [name, color, req.body.is_initial === undefined ? s.is_initial : !!req.body.is_initial, id]);
  });
  const out = await query('SELECT * FROM pipeline_states WHERE id=$1', [id]);
  res.json(out.rows[0]);
});

statesRouter.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query('SELECT * FROM pipeline_states WHERE id=$1', [id]);
  const s = rows[0];
  if (!s) throw new HttpError(404, 'Estado no encontrado');
  if (s.is_initial) throw new HttpError(400, 'No se puede eliminar el estado inicial de las cotizaciones; define otro primero');
  const { rows: c } = await query('SELECT COUNT(*)::int AS n FROM leads WHERE state_id=$1', [id]);
  if (c[0].n > 0) {
    const moveTo = Number(req.query.moveTo);
    if (!moveTo || moveTo === id) throw new HttpError(409, `Hay ${c[0].n} leads en este estado; indica a qué estado moverlos (moveTo)`);
    await query('UPDATE leads SET state_id=$1 WHERE state_id=$2', [moveTo, id]);
  }
  await query('DELETE FROM pipeline_states WHERE id=$1', [id]);
  res.json({ ok: true });
});
