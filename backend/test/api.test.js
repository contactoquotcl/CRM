import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.cl';
process.env.ADMIN_PASSWORD = 'admin-pass-123';

const { initDb } = await import('../src/db.js');
const { seedAdmin } = await import('../src/auth.js');
const { createApp } = await import('../src/app.js');
const { validRut, parseDate, parseMoney, formatRut } = await import('../src/util.js');

let server, base, adminToken, userToken;

const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data };
};

before(async () => {
  await initDb();
  await seedAdmin();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('utilidades: RUT, fechas, montos', () => {
  assert.equal(validRut('76.086.428-5'), true);
  assert.equal(validRut('76.086.428-4'), false);
  assert.equal(formatRut('760864285'), '76086428-5');
  assert.equal(parseDate('3 de octubre de 2025'), '2025-10-03');
  assert.equal(parseDate('October 3, 2025'), '2025-10-03');
  assert.equal(parseDate('03/10/2025'), '2025-10-03');
  assert.equal(parseDate('2025-10-03'), '2025-10-03');
  assert.equal(parseMoney('1.725.488'), 1725488);
  assert.equal(parseMoney('$1,449,989.92'), 1449990);
  assert.equal(parseMoney(275498.08), 275498);
});

test('login, roles y usuarios', async () => {
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'admin@test.cl', password: 'mala' } })).status, 401);
  const a = await api('POST', '/api/auth/login', { body: { email: 'admin@test.cl', password: 'admin-pass-123' } });
  assert.equal(a.status, 200);
  adminToken = a.data.token;

  const c = await api('POST', '/api/users', { token: adminToken, body: { email: 'vendedor@test.cl', name: 'Vendedor', password: 'clave-segura-1', role: 'user' } });
  assert.equal(c.status, 201);
  const u = await api('POST', '/api/auth/login', { body: { email: 'vendedor@test.cl', password: 'clave-segura-1' } });
  userToken = u.data.token;

  assert.equal((await api('GET', '/api/users', { token: userToken })).status, 403);
  assert.equal((await api('GET', '/api/products')).status, 401);
  // no se puede dejar sin admins
  const me = await api('GET', '/api/auth/me', { token: adminToken });
  assert.equal((await api('PATCH', `/api/users/${me.data.user.id}`, { token: adminToken, body: { role: 'user' } })).status, 400);
});

test('maestra de productos: admin escribe, estándar lee', async () => {
  const p = await api('POST', '/api/products', { token: adminToken, body: { sku: 'ZD421-203', name: 'Impresora Zebra ZD421', description: 'Térmica directa 203 dpi', price: 289990 } });
  assert.equal(p.status, 201);
  assert.equal((await api('POST', '/api/products', { token: adminToken, body: { sku: 'zd421-203', name: 'dup', price: 1 } })).status, 409);
  assert.equal((await api('POST', '/api/products', { token: userToken, body: { sku: 'X', name: 'X', price: 1 } })).status, 403);
  const l = await api('GET', '/api/products?q=zebra', { token: userToken });
  assert.equal(l.data.length, 1);
  const imp = await api('POST', '/api/products/import', { token: adminToken, body: { rows: [{ sku: 'ZD421-203', name: 'Impresora Zebra ZD421 v2', price: '299.990' }, { sku: 'ETQ-100', name: 'Etiqueta 100x150', price: 12000 }, { sku: '', name: 'sin sku' }] } });
  assert.deepEqual(imp.data, { created: 1, updated: 1, skipped: 1 });
});

test('estados del pipeline configurables', async () => {
  const s = await api('GET', '/api/states', { token: userToken });
  assert.equal(s.data[0].name, 'Cotizado');
  assert.equal(s.data[0].is_initial, true);
  const n = await api('POST', '/api/states', { token: adminToken, body: { name: 'Negociación', color: '#0ea5e9' } });
  assert.equal(n.status, 201);
  assert.equal((await api('POST', '/api/states', { token: userToken, body: { name: 'Otro' } })).status, 403);
  assert.equal((await api('DELETE', `/api/states/${s.data[0].id}`, { token: adminToken })).status, 400); // inicial
});

test('cotizador: correlativo, lead "Cotizado" y PDF', async () => {
  const body = {
    client: { rut: '76.086.428-5', razon_social: 'Cliente Demo SpA', email: 'compras@demo.cl', contact: 'Ana Pérez', phone: '+56 9 1234 5678' },
    items: [{ sku: 'ZD421-203', description: 'Impresora Zebra ZD421', qty: 2, unit_price: 299990 }, { sku: 'ETQ-100', description: 'Etiqueta 100x150', qty: 10, unit_price: 12000 }],
    notes: 'Entrega en 5 días hábiles',
  };
  const bad = await api('POST', '/api/quotes', { token: userToken, body: { ...body, client: { ...body.client, rut: '76.086.428-4' } } });
  assert.equal(bad.status, 400);

  const q1 = await api('POST', '/api/quotes', { token: userToken, body });
  assert.equal(q1.status, 201);
  assert.equal(q1.data.number, 1);
  assert.equal(q1.data.subtotal, 719980);
  assert.equal(q1.data.iva, 136796);
  assert.equal(q1.data.total, 856776);
  const q2 = await api('POST', '/api/quotes', { token: userToken, body });
  assert.equal(q2.data.number, 2);

  const lead = await api('GET', `/api/leads/${q1.data.lead_id}`, { token: userToken });
  assert.equal(lead.data.state_name, 'Cotizado');
  assert.equal(lead.data.rut, '76086428-5');
  assert.equal(lead.data.razon_social, 'Cliente Demo SpA');
  assert.equal(lead.data.quotes.length, 1);

  // re-cotizar un lead existente no crea otro lead
  const q3 = await api('POST', '/api/quotes', { token: userToken, body: { ...body, lead_id: q1.data.lead_id } });
  assert.equal(q3.data.number, 3);
  assert.equal(q3.data.lead_id, q1.data.lead_id);

  const pdf = await api('GET', `/api/quotes/${q1.data.id}/pdf`, { token: userToken });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.data.length > 2000);
});

test('importación de pipeline desde Notion (CSV mapeado)', async () => {
  const rows = [
    { client_name: 'Hospital Puren / Franklin Díaz', rut: '61602224-5', state: 'Cotizado', lead_date: 'October 3, 2025', quote_number: 480, legacy_id: '28', subtotal: 1449989.92, iva: 275498.08, total: 1725488, channel: 'WhatsApp', comments: 'Fuera de plazo' },
    { client_name: 'Gustavo', state: 'Perdido', lead_date: '15/09/2025', legacy_id: '15', subtotal: 1135285.71, iva: 215704.29, total: 1350990, requires_supplier_quote: 'Yes' },
    { client_name: '', razon_social: '' },
  ];
  const r1 = await api('POST', '/api/import/leads', { token: adminToken, body: { rows } });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.created, 2);
  assert.equal(r1.data.skipped, 1);
  assert.deepEqual(r1.data.statesCreated, ['Perdido']);
  assert.equal(r1.data.counterSetTo, 481);

  const r2 = await api('POST', '/api/import/leads', { token: adminToken, body: { rows } });
  assert.equal(r2.data.created, 0);
  assert.equal(r2.data.updated, 2); // idempotente

  const all = await api('GET', '/api/leads?q=puren', { token: userToken });
  assert.equal(all.data.length, 1);
  assert.equal(all.data[0].lead_date, '2025-10-03');
  assert.equal(all.data[0].total, 1725488);

  assert.equal((await api('POST', '/api/import/leads', { token: userToken, body: { rows } })).status, 403);

  // el siguiente correlativo del cotizador continúa desde lo importado
  const body = { client: { rut: '76.086.428-5', razon_social: 'X SpA', email: 'x@x.cl', contact: 'X', phone: '1' }, items: [{ description: 'Algo', qty: 1, unit_price: 1000 }] };
  const q = await api('POST', '/api/quotes', { token: userToken, body });
  assert.equal(q.data.number, 481);
});
