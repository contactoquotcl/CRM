import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakes } from './fakes.js';

process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.cl';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.JWT_SECRET = 'test-secret';
for (const k of ['WC_BASE_URL', 'CHATWOOT_BASE_URL', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'RESEND_API_KEY', 'SMTP_HOST']) delete process.env[k];

const fakes = await startFakes({ pageSize: 5 });
process.env.RESEND_API_URL = fakes.url;
const { initDb, query } = await import('../src/db.js');
const { seedAdmin } = await import('../src/auth.js');
const { createApp } = await import('../src/app.js');
const { createQuote } = await import('../src/quoteService.js');

let server, base, admin;
const api = async (method, path, { token = admin, body } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const stateOf = async (leadId) => (await query('SELECT s.name FROM leads l JOIN pipeline_states s ON s.id=l.state_id WHERE l.id=$1', [leadId])).rows[0].name;
const mkQuote = async (email, channel = 'Chatbot') => {
  const q = await createQuote({ client: { rut: '76086428-5', razon_social: 'Acme SpA', email, contact: 'Marta Soto', phone: '+56911112222' }, margin: 25, items: [{ sku: 'X1', description: 'Etiqueta', qty: 2, cost: 1000 }] }, { channel });
  return q;
};

before(async () => {
  await initDb(); await seedAdmin();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await api('POST', '/api/auth/login', { token: null, body: { email: 'admin@test.cl', password: 'admin-pass-123' } })).data.token;
});
after(async () => { server.close(); await fakes.stop(); });

test('sin correo configurado no envía y avisa', async () => {
  const q = await mkQuote('marta@acme.cl');
  const r = (await api('POST', '/api/followups/send', { body: { quote_ids: [q.id] } })).data;
  assert.equal(r.sent, 0);
  assert.match(r.results[0].message, /no está configurado/);
  assert.equal(await stateOf(q.lead_id), 'Cotizado');
});

test('configurar Resend (probar), enviar S1 → S2 → archivar con historial y PDF adjunto', async () => {
  assert.equal((await api('PUT', '/api/integrations', { body: { values: { RESEND_API_KEY: 're_testkey', EMAIL_FROM: 'contacto@quot.cl' } } })).status, 200);
  const t = (await api('POST', '/api/integrations/test/email', { body: {} })).data;
  assert.equal(t.ok, true);
  assert.match(t.message, /quot\.cl: verified/);
  fakes.state.mails.length = 0;

  const q = await mkQuote('marta2@acme.cl');
  const list = (await api('GET', '/api/followups')).data;
  const row = list.rows.find((r) => r.quote_id === q.id);
  assert.equal(row.next_label, 'Seguimiento 1');
  assert.equal(list.configured, true);

  const p = (await api('GET', `/api/followups/preview/${q.id}`)).data;
  assert.match(p.subject, new RegExp(`N° ${q.number}`));
  assert.match(p.text, /Marta/);
  assert.match(p.text, /no gracias/);

  let r = (await api('POST', '/api/followups/send', { body: { quote_ids: [q.id] } })).data;
  assert.equal(r.sent, 1);
  assert.equal(await stateOf(q.lead_id), 'Seguimiento 1');
  const m = fakes.state.mails[0];
  assert.deepEqual(m.to, ['marta2@acme.cl']);
  assert.deepEqual(m.bcc, ['contacto@quot.cl']);
  assert.equal(m.reply_to, 'contacto@quot.cl');
  assert.equal(m.attachments[0].filename, `Cotizacion-${q.number}.pdf`);
  assert.ok(Buffer.from(m.attachments[0].content, 'base64').subarray(0, 4).toString() === '%PDF');

  r = (await api('POST', '/api/followups/send', { body: { quote_ids: [q.id] } })).data;
  assert.equal(r.sent, 1);
  assert.equal(await stateOf(q.lead_id), 'Seguimiento 2');
  assert.match(fakes.state.mails[1].subject, /Recordatorio/);

  // Seguimiento 2 → Archivado: por defecto se archiva sin correo
  r = (await api('POST', '/api/followups/send', { body: { quote_ids: [q.id] } })).data;
  assert.equal(r.sent, 1);
  assert.equal(fakes.state.mails.length, 2);
  assert.equal(await stateOf(q.lead_id), 'Archivado');

  const log = (await api('GET', `/api/followups/log?quote_id=${q.id}`)).data;
  assert.deepEqual(log.map((x) => x.status).reverse(), ['enviado', 'enviado', 'movido']);
  const lead = (await query('SELECT comments FROM leads WHERE id=$1', [q.lead_id])).rows[0];
  assert.match(lead.comments, /"Seguimiento 1" enviado a marta2@acme\.cl/);
});

test('error del proveedor: no mueve la etapa y queda registrado; no se repite un paso enviado', async () => {
  const q = await mkQuote('marta3@acme.cl');
  fakes.state.mailFail = true;
  let r = (await api('POST', '/api/followups/send', { body: { quote_ids: [q.id] } })).data;
  assert.equal(r.failed, 1);
  assert.match(r.results[0].message, /domain not verified/);
  assert.equal(await stateOf(q.lead_id), 'Cotizado');
  fakes.state.mailFail = false;
  r = (await api('POST', '/api/followups/send', { body: { quote_ids: [q.id] } })).data;
  assert.equal(r.sent, 1);
  // Si alguien devuelve el lead a Cotizado, no se reenvía el mismo seguimiento
  const cot = (await query("SELECT id FROM pipeline_states WHERE name='Cotizado'")).rows[0].id;
  await query('UPDATE leads SET state_id=$1 WHERE id=$2', [cot, q.lead_id]);
  r = (await api('POST', '/api/followups/send', { body: { quote_ids: [q.id] } })).data;
  assert.equal(r.sent, 0);
  assert.match(r.results[0].message, /ya se envió/);
  const log = (await api('GET', `/api/followups/log?quote_id=${q.id}`)).data;
  assert.deepEqual(log.map((x) => x.status).reverse(), ['error', 'enviado']);
});

test('sin correo válido o pausada: no se envía; modo automático envía lo que ya toca', async () => {
  const sin = await mkQuote('x@y.cl');
  await query("UPDATE quotes SET email='' WHERE id=$1", [sin.id]); await query("UPDATE leads SET email='' WHERE id=$1", [sin.lead_id]);
  assert.match((await api('POST', '/api/followups/send', { body: { quote_ids: [sin.id] } })).data.results[0].message, /correo válido/);
  const pa = await mkQuote('pausa@acme.cl');
  await api('POST', '/api/followups/mode', { body: { quote_ids: [pa.id], mode: 'pausado' } });
  assert.match((await api('POST', '/api/followups/send', { body: { quote_ids: [pa.id] } })).data.results[0].message, /pausado/);

  const au = await mkQuote('auto@acme.cl');
  const aun = await mkQuote('auto2@acme.cl');
  await api('POST', '/api/followups/mode', { body: { quote_ids: [au.id, aun.id], mode: 'auto' } });
  // au lleva 3 días en Cotizado (toca S1); aun es de hoy (aún no toca)
  await query("UPDATE leads SET state_date = CURRENT_DATE - 3 WHERE id=$1", [au.lead_id]);
  const before = fakes.state.mails.length;
  const run = (await api('POST', '/api/followups/run-auto')).data;
  assert.equal(run.sent, 1);
  assert.equal(fakes.state.mails.length, before + 1);
  assert.equal(await stateOf(au.lead_id), 'Seguimiento 1');
  assert.equal(await stateOf(aun.lead_id), 'Cotizado');
  assert.equal((await query('SELECT trigger FROM followup_emails WHERE quote_id=$1', [au.id])).rows[0].trigger, 'auto');
});

test('el filtro "IA" solo lista cotizaciones del bot', async () => {
  const web = await mkQuote('manual@acme.cl', 'Cotizador');
  const ia = (await api('GET', '/api/followups')).data.rows.map((r) => r.quote_id);
  const all = (await api('GET', '/api/followups?channel=all')).data.rows.map((r) => r.quote_id);
  assert.ok(!ia.includes(web.id));
  assert.ok(all.includes(web.id));
});
