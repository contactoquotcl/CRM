import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.PDF_NO_COMPRESS = '1';
process.env.ADMIN_EMAIL = 'admin@test.cl';
process.env.ADMIN_PASSWORD = 'admin-pass-123';

const { initDb } = await import('../src/db.js');
const { seedAdmin } = await import('../src/auth.js');
const { createApp } = await import('../src/app.js');
const { validRut, parseDate, parseMoney, formatRut, priceFromCost, validMargin } = await import('../src/util.js');

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
  // precio = costo / (1 - margen)
  assert.equal(priceFromCost(800, 20), 1000);
  assert.equal(priceFromCost(1000, 0), 1000);
  assert.equal(priceFromCost(750, 25), 1000);
  assert.equal(priceFromCost(100000, 15), 117647); // 117.647,06 → redondeo CLP
  assert.equal(validMargin(0), true);
  assert.equal(validMargin(99.5), true);
  assert.equal(validMargin(100), false);
  assert.equal(validMargin(-1), false);
  assert.equal(validMargin(NaN), false);
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

test('cotizador: costo + margen, correlativo, lead "Cotizado" y PDF sin costo/margen', async () => {
  const body = {
    client: { rut: '76.086.428-5', razon_social: 'Cliente Demo SpA', email: 'compras@demo.cl', contact: 'Ana Pérez', phone: '+56 9 1234 5678' },
    margin: 20,
    items: [
      { sku: 'ZD421-203', description: 'Impresora Zebra ZD421', qty: 2, cost: 240000 }, // 240000/0,8 = 300000
      { sku: 'ETQ-100', description: 'Etiqueta 100x150', qty: 10, cost: 9000, margin: 10 }, // 9000/0,9 = 10000 (override)
    ],
    notes: 'Entrega en 5 días hábiles',
  };
  assert.equal((await api('POST', '/api/quotes', { token: userToken, body: { ...body, client: { ...body.client, rut: '76.086.428-4' } } })).status, 400);
  // el margen es obligatorio y debe ser válido
  const { margin: _m, ...sinMargen } = body;
  assert.equal((await api('POST', '/api/quotes', { token: userToken, body: sinMargen })).status, 400);
  assert.equal((await api('POST', '/api/quotes', { token: userToken, body: { ...body, margin: 100 } })).status, 400);
  assert.equal((await api('POST', '/api/quotes', { token: userToken, body: { ...body, margin: -5 } })).status, 400);
  assert.equal((await api('POST', '/api/quotes', { token: userToken, body: { ...body, items: [{ ...body.items[0], margin: 100 }] } })).status, 400);

  const q1 = await api('POST', '/api/quotes', { token: userToken, body });
  assert.equal(q1.status, 201);
  assert.equal(q1.data.number, 1);
  assert.equal(q1.data.subtotal, 700000); // 2×300000 + 10×10000
  assert.equal(q1.data.iva, 133000);
  assert.equal(q1.data.total, 833000);
  const q2 = await api('POST', '/api/quotes', { token: userToken, body });
  assert.equal(q2.data.number, 2);

  // el detalle interno conserva costo y margen
  const det = await api('GET', `/api/quotes/${q1.data.id}`, { token: userToken });
  assert.equal(det.data.margin_pct, 20);
  assert.deepEqual(det.data.items.map((i) => [i.cost, i.margin_pct, i.unit_price, i.line_total]), [[240000, 20, 300000, 600000], [9000, 10, 10000, 100000]]);

  const lead = await api('GET', `/api/leads/${q1.data.lead_id}`, { token: userToken });
  assert.equal(lead.data.state_name, 'Cotizado');
  assert.equal(lead.data.rut, '76086428-5');
  assert.equal(lead.data.razon_social, 'Cliente Demo SpA');
  assert.equal(lead.data.total, 833000);
  assert.equal(lead.data.quotes.length, 1);

  // re-cotizar un lead existente no crea otro lead
  const q3 = await api('POST', '/api/quotes', { token: userToken, body: { ...body, lead_id: q1.data.lead_id } });
  assert.equal(q3.data.number, 3);
  assert.equal(q3.data.lead_id, q1.data.lead_id);

  const pdf = await api('GET', `/api/quotes/${q1.data.id}/pdf`, { token: userToken });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');

  // Texto visible del PDF (pdfkit escribe el texto como cadenas hex en operadores TJ)
  const raw = pdf.data.toString('latin1');
  const text = [...raw.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join(' ').replace(/\s+/g, ''); // sin espacios: el kerning separa letras
  assert.match(text, /ImpresoraZebraZD421/);
  assert.match(text, /\$300\.000/); // precio de venta sí aparece
  assert.match(text, /\$833\.000/);
  assert.doesNotMatch(text, /240\.000/); // el costo no
  assert.doesNotMatch(text, /9\.000/);
  assert.doesNotMatch(text, /margen|costo/i);
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
  const body = { client: { rut: '76.086.428-5', razon_social: 'X SpA', email: 'x@x.cl', contact: 'X', phone: '1' }, margin: 25, items: [{ description: 'Algo', qty: 1, cost: 750 }] };
  const q = await api('POST', '/api/quotes', { token: userToken, body });
  assert.equal(q.data.number, 481);
});

test('pipeline: reordenar leads dentro y entre etapas, y filtrar por estado y fecha', async () => {
  const states = (await api('GET', '/api/states', { token: userToken })).data;
  const A = states[0].id, B = states[1].id;
  const mk = async (name, state_id, lead_date) =>
    (await api('POST', '/api/leads', { token: userToken, body: { client_name: name, state_id, lead_date } })).data;
  const a1 = await mk('Orden-A1', A, '2026-01-10');
  const a2 = await mk('Orden-A2', A, '2026-02-10');
  const a3 = await mk('Orden-A3', A, '2026-03-10');
  const names = async (qs = '') => (await api('GET', `/api/leads?q=orden-${qs}`, { token: userToken })).data.filter((l) => l.client_name.startsWith('Orden-'));
  const col = async (state) => (await names()).filter((l) => l.state_id === state).map((l) => l.client_name);

  // Los nuevos entran arriba (más reciente primero)
  assert.deepEqual(await col(A), ['Orden-A3', 'Orden-A2', 'Orden-A1']);

  // Subir A1 al primer lugar (antes de A3)
  assert.equal((await api('PUT', `/api/leads/${a1.id}/move`, { token: userToken, body: { state_id: A, before_id: a3.id } })).status, 200);
  assert.deepEqual(await col(A), ['Orden-A1', 'Orden-A3', 'Orden-A2']);

  // Dejar A1 después de A2 (al final)
  await api('PUT', `/api/leads/${a1.id}/move`, { token: userToken, body: { state_id: A, after_id: a2.id } });
  assert.deepEqual(await col(A), ['Orden-A3', 'Orden-A2', 'Orden-A1']);

  // Pasar A2 a otra etapa: cambia el estado y la fecha del estado, y queda en esa columna
  const moved = await api('PUT', `/api/leads/${a2.id}/move`, { token: userToken, body: { state_id: B } });
  assert.equal(moved.data.state_id, B);
  assert.match(moved.data.state_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(await col(A), ['Orden-A3', 'Orden-A1']);
  assert.deepEqual(await col(B), ['Orden-A2']);

  // Errores
  assert.equal((await api('PUT', `/api/leads/${a1.id}/move`, { token: userToken, body: { state_id: 99999 } })).status, 400);
  assert.equal((await api('PUT', `/api/leads/999999/move`, { token: userToken, body: { state_id: A } })).status, 404);

  // Filtros: por estado, por rango de fechas del lead y combinados
  const f1 = await api('GET', `/api/leads?q=orden-&state_ids=${B}`, { token: userToken });
  assert.deepEqual(f1.data.map((l) => l.client_name), ['Orden-A2']);
  const f2 = await api('GET', `/api/leads?q=orden-&state_ids=${A},${B}`, { token: userToken });
  assert.equal(f2.data.length, 3);
  const f3 = await api('GET', '/api/leads?q=orden-&date_field=lead&from=2026-02-01&to=2026-03-31', { token: userToken });
  assert.deepEqual(f3.data.map((l) => l.client_name).sort(), ['Orden-A2', 'Orden-A3']);
  const f4 = await api('GET', `/api/leads?q=orden-&date_field=lead&from=2026-02-01&state_ids=${A}`, { token: userToken });
  assert.deepEqual(f4.data.map((l) => l.client_name), ['Orden-A3']);
  const f5 = await api('GET', '/api/leads?q=orden-&date_field=lead&to=2026-01-31', { token: userToken });
  assert.deepEqual(f5.data.map((l) => l.client_name), ['Orden-A1']);
  // por fecha del estado: los tres cambiaron de estado/se crearon hoy
  const f6 = await api('GET', '/api/leads?q=orden-&from=2020-01-01&to=2020-12-31', { token: userToken });
  assert.equal(f6.data.length, 0);
  assert.equal((await api('GET', '/api/leads?from=nada', { token: userToken })).status, 400);
});

test('creador: la cotización registra quién la creó y el pipeline filtra por creador', async () => {
  const me = (await api('GET', '/api/auth/me', { token: userToken })).data;
  const meId = (me.user || me).id;
  const body = { client: { rut: '76.086.428-5', razon_social: 'Creador SpA', email: 'c@c.cl', contact: 'C', phone: '1' }, margin: 20, items: [{ description: 'Cosa', qty: 1, cost: 800 }] };
  const q = await api('POST', '/api/quotes', { token: userToken, body });
  assert.equal(q.status, 201);
  const det = await api('GET', `/api/quotes/${q.data.id}`, { token: adminToken });
  assert.equal(det.data.created_by, meId);
  assert.ok(det.data.created_by_name);
  const list = await api('GET', '/api/quotes?q=creador', { token: adminToken });
  assert.equal(list.data[0].created_by_name, det.data.created_by_name);

  const creators = await api('GET', '/api/leads/creators', { token: userToken });
  assert.ok(creators.data.some((c) => c.id === meId));
  const mine = await api('GET', `/api/leads?q=creador&created_by=${meId}`, { token: adminToken });
  assert.equal(mine.data.length, 1);
  assert.equal(mine.data[0].owner_name, det.data.created_by_name);
  const none = await api('GET', '/api/leads?q=creador&created_by=999999', { token: adminToken });
  assert.equal(none.data.length, 0);
});
