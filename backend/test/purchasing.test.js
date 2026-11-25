import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.cl';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.JWT_SECRET = 'test-secret';
for (const k of ['WC_BASE_URL', 'CHATWOOT_BASE_URL', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'RESEND_API_KEY', 'SMTP_HOST']) delete process.env[k];

const { initDb, query } = await import('../src/db.js');
const { seedAdmin } = await import('../src/auth.js');
const { createApp } = await import('../src/app.js');

let server, base, admin, user;
const api = async (method, path, body, token = admin) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), ct };
};
const SUP = { rut: '76.086.428-5', razon_social: 'Proveedor Uno SpA', phone: '+56 9 1111 2222', email: 'ventas@uno.cl', contact: 'Marta Soto' };

before(async () => {
  await initDb(); await seedAdmin();
  server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
  admin = (await api('POST', '/api/auth/login', { email: 'admin@test.cl', password: 'admin-pass-123' }, null)).data.token;
});
after(() => server?.close());

test('proveedores: datos mínimos obligatorios, RUT válido y sin duplicados', async () => {
  let r = await api('POST', '/api/suppliers', { rut: '76086428-5', razon_social: 'X' });
  assert.equal(r.status, 400); assert.match(r.data.error, /teléfono, correo, persona de contacto/);
  assert.equal((await api('POST', '/api/suppliers', { ...SUP, rut: '76086428-1' })).status, 400);
  r = await api('POST', '/api/suppliers', SUP);
  assert.equal(r.status, 201);
  assert.equal(r.data.rut, '76.086.428-5');
  assert.equal((await api('POST', '/api/suppliers', { ...SUP, rut: '76086428-5' })).status, 409);
  const p = await api('PATCH', `/api/suppliers/${r.data.id}`, { contact: 'Pedro Pérez' });
  assert.equal(p.data.contact, 'Pedro Pérez');
});

test('orden de compra: correlativo desde 65, costo libre, totales, edición, PDF y estados', async () => {
  const sup = (await api('GET', '/api/suppliers')).data[0];
  await query("INSERT INTO products(sku, name, description, price, active) VALUES('ZB-1','Impresora Zebra','',100000,true) ON CONFLICT DO NOTHING").catch(() => {});
  const prod = (await query("SELECT id, price FROM products ORDER BY id LIMIT 1")).rows[0];
  const body = { supplier_id: sup.id, delivery_date: '2026-12-10', delivery_address: 'Bodega Quot', notes: 'Entregar con guía', items: [
    { product_id: prod?.id, sku: 'ZB-1', description: 'Impresora Zebra', qty: 3, cost: 85000 }, // costo distinto al de la maestra
    { sku: '', description: 'Flete', qty: 1, cost: 10000 },
  ] };
  const a = await api('POST', '/api/purchase-orders', body);
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(a.data.number, 65);
  assert.equal(a.data.subtotal, 265000);
  assert.equal(a.data.iva, 50350);
  assert.equal(a.data.total, 315350);
  const b = await api('POST', '/api/purchase-orders', { ...body, items: [{ sku: 'X', description: 'Otro', qty: 2, cost: 1000 }] });
  assert.equal(b.data.number, 66);
  if (prod) assert.equal((await query('SELECT price FROM products WHERE id=$1', [prod.id])).rows[0].price, prod.price, 'la maestra no cambia');

  // edición mantiene el número y recalcula
  const e = await api('PUT', `/api/purchase-orders/${a.data.id}`, { ...body, items: [{ sku: 'ZB-1', description: 'Impresora Zebra', qty: 1, cost: 90000 }] });
  assert.equal(e.status, 200);
  const g = (await api('GET', `/api/purchase-orders/${a.data.id}`)).data;
  assert.equal(g.number, 65); assert.equal(g.subtotal, 90000); assert.equal(g.items.length, 1); assert.equal(g.razon_social, 'Proveedor Uno SpA');

  const pdf = await api('GET', `/api/purchase-orders/${a.data.id}/pdf`);
  assert.equal(pdf.status, 200); assert.match(pdf.ct, /pdf/); assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');

  assert.equal((await api('PATCH', `/api/purchase-orders/${a.data.id}/status`, { status: 'Recibida' })).data.status, 'Recibida');
  await api('PATCH', `/api/purchase-orders/${b.data.id}/status`, { status: 'Anulada' });
  assert.equal((await api('PUT', `/api/purchase-orders/${b.data.id}`, body)).status, 400, 'anulada no se edita');
  assert.equal((await api('POST', '/api/purchase-orders', { ...body, items: [] })).status, 400);
  assert.equal((await api('POST', '/api/purchase-orders', { ...body, items: [{ description: 'x', qty: 0, cost: 1 }] })).status, 400);
  assert.equal((await api('GET', '/api/purchase-orders?q=proveedor')).data.length, 2);
});

test('permiso: el administrador siempre; los demás solo si se les habilita', async () => {
  const c = await api('POST', '/api/users', { email: 'ana@test.cl', name: 'Ana', password: 'ana-pass-1234', role: 'user' });
  assert.equal(c.status, 201);
  user = (await api('POST', '/api/auth/login', { email: 'ana@test.cl', password: 'ana-pass-1234' }, null)).data;
  assert.equal(user.user.perms.purchase_orders, false);
  assert.equal((await api('GET', '/api/purchase-orders', null, user.token)).status, 403);
  assert.equal((await api('GET', '/api/suppliers', null, user.token)).status, 403);
  assert.equal((await api('PATCH', `/api/users/${c.data.id}`, { can_purchase_orders: true })).data.can_purchase_orders, true);
  assert.equal((await api('GET', '/api/auth/me', null, user.token)).data.user.perms.purchase_orders, true);
  assert.equal((await api('GET', '/api/purchase-orders', null, user.token)).status, 200);
  assert.equal((await api('GET', '/api/auth/me')).data.user.perms.purchase_orders, true, 'admin siempre');
  await api('PATCH', `/api/users/${c.data.id}`, { can_purchase_orders: false });
  assert.equal((await api('GET', '/api/suppliers', null, user.token)).status, 403);
});
