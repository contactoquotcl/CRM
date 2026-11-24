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
const { createQuote } = await import('../src/quoteService.js');
const { parseSii } = await import('../src/billing.js');

let server, base, admin;
const api = async (method, path, body, token = admin) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const H = ['TipoDTE', 'Folio', 'FechaEmision', 'RutEmisor', 'RazonSocialEmisor', 'RutReceptor', 'RazonSocialReceptor', 'Total-Neto', 'Total-Exento', 'Total-IVA', 'Total-MontoTotal'];
const html = (rows) => `<html><body><table>${[H, ...rows].map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></body></html>`;
const QUOT = '77.372.977-8';

before(async () => {
  await initDb(); await seedAdmin();
  server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
  admin = (await api('POST', '/api/auth/login', { email: 'admin@test.cl', password: 'admin-pass-123' }, null)).data.token;
});
after(() => server?.close());

const mk = async (rut, qty, price, date) => {
  const q = await createQuote({ client: { rut, razon_social: 'Cliente ' + rut, email: 'a@b.cl', contact: 'X', phone: '1' }, margin: 0, items: [{ sku: 'S', description: 'Item', qty, cost: price }] }, { channel: 'Cotizador' });
  if (q) await query('UPDATE quotes SET quote_date=$1 WHERE id=$2', [date, q.id]);
  return q;
};

test('parseSii: HTML del SII, ignora recibidas, DETALLE y guías', () => {
  const r = parseSii(html([
    ['33', '1001', '2026-11-05', QUOT, 'QUOT', '76.086.428-5', 'Acme SpA', '100000.0', '0', '19000.0', '119000.0'],
    ['DETALLE', '', '', '', '', '', '', '', '', '', ''],
    ['61', '55', '2026-11-06', QUOT, 'QUOT', '76.086.428-5', 'Acme SpA', '10000', '', '1900', '11900'],
    ['33', '77', '2026-11-06', '99.999.999-9', 'PROVEEDOR', QUOT, 'QUOT', '5000', '0', '950', '5950'],
    ['52', '9', '2026-11-06', QUOT, 'QUOT', '1-9', 'X', '0', '0', '0', '0'],
  ]));
  assert.equal(r.docs.length, 2);
  assert.equal(r.recibidas, 1);
  assert.equal(r.ignoradas, 1);
  assert.equal(r.docs[0].total, 119000);
  assert.equal(r.docs[0].rut, '760864285');
  assert.throws(() => parseSii('hola'));
});

test('subida, conciliación, conversión y reintento idempotente', async () => {
  const qa = await mk('76086428-5', 1, 100000, '2026-11-01'); // se factura
  const qb = await mk('11111111-1', 1, 50000, '2026-11-02'); // abierta
  const qc = await mk('76086428-5', 1, 300000, '2026-11-03'); // mismo cliente, otro monto: no factura
  assert.ok(qa && qb && qc);
  const file = html([
    ['33', '1001', '2026-11-05', QUOT, 'QUOT', '76.086.428-5', 'Acme SpA', '100000', '0', '19000', '119000'],
    ['33', '1002', '2026-11-06', QUOT, 'QUOT', '22.222.222-2', 'Sin cotización', '200000', '0', '38000', '238000'],
    ['61', '55', '2026-11-07', QUOT, 'QUOT', '76.086.428-5', 'Acme SpA', '10000', '0', '1900', '11900'],
  ]);
  const up = await api('POST', '/api/conversion/upload', { files: [{ name: 'DTE_DOWN.xls', text: file }] });
  assert.equal(up.status, 200);
  assert.equal(up.data.files[0].created, 3);
  assert.equal(up.data.matched, 1);
  const again = await api('POST', '/api/conversion/upload', { files: [{ name: 'DTE_DOWN.xls', text: file }] });
  assert.equal(again.data.files[0].created, 0);
  assert.equal(again.data.files[0].updated, 3);

  const m = (await api('GET', '/api/conversion?from=2026-11-01&to=2026-11-30&group=month')).data;
  assert.equal(m.kpis.quoted_count, 3);
  assert.equal(m.kpis.converted_count, 1);
  assert.equal(m.kpis.pct_count, 33.3);
  assert.equal(m.kpis.invoiced_net, 100000 + 200000 - 10000);
  assert.equal(m.kpis.invoiced_without_quote_count, 1);
  assert.equal(m.series[0].period, '2026-11');
  assert.equal(m.open.length, 2);
  assert.equal((await api('GET', '/api/conversion?group=day')).data.series.length >= 1, true);
});

test('vínculo manual, «sin cotización» y solo admin', async () => {
  const inv = (await query("SELECT id FROM invoices WHERE folio='1002'")).rows[0];
  const open = (await query("SELECT id FROM quotes WHERE rut='11111111-1' OR rut='11.111.111-1' LIMIT 1")).rows[0];
  const s = await api('GET', `/api/conversion/suggest/${inv.id}`);
  assert.equal(s.status, 200);
  const l = await api('POST', '/api/conversion/link', { invoice_id: inv.id, quote_id: open.id });
  assert.equal(l.status, 200);
  let m = (await api('GET', '/api/conversion?from=2026-11-01&to=2026-11-30')).data;
  assert.equal(m.kpis.converted_count, 2);
  await api('POST', '/api/conversion/reconcile');
  m = (await api('GET', '/api/conversion?from=2026-11-01&to=2026-11-30')).data;
  assert.equal(m.kpis.converted_count, 2, 'el vínculo manual se conserva');
  await api('POST', '/api/conversion/link', { invoice_id: inv.id, quote_id: null });
  m = (await api('GET', '/api/conversion?from=2026-11-01&to=2026-11-30')).data;
  assert.equal(m.kpis.converted_count, 1);
  assert.equal((await api('GET', '/api/conversion', null, null)).status, 401);
});
