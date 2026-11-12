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
process.env.GOOGLE_TOKEN_URL = `${fakes.url}/token`;
process.env.GMAIL_API_URL = fakes.url;
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
  const r = (await api('POST', '/api/followups/send', { body: { lead_ids: [q.lead_id] } })).data;
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
  const row = list.rows.find((r) => r.lead_id === q.lead_id);
  assert.equal(row.next_label, 'Seguimiento 1');
  assert.equal(list.configured, true);

  const p = (await api('GET', `/api/followups/preview/${q.lead_id}`)).data;
  assert.match(p.subject, new RegExp(`N° ${q.number}`));
  assert.match(p.text, /Marta/);
  assert.match(p.text, /no gracias/);

  let r = (await api('POST', '/api/followups/send', { body: { lead_ids: [q.lead_id] } })).data;
  assert.equal(r.sent, 1);
  assert.equal(await stateOf(q.lead_id), 'Seguimiento 1');
  const m = fakes.state.mails[0];
  assert.deepEqual(m.to, ['marta2@acme.cl']);
  assert.deepEqual(m.bcc, ['contacto@quot.cl']);
  assert.equal(m.reply_to, 'contacto@quot.cl');
  assert.equal(m.attachments[0].filename, `Cotizacion-${q.number}.pdf`);
  assert.ok(Buffer.from(m.attachments[0].content, 'base64').subarray(0, 4).toString() === '%PDF');

  r = (await api('POST', '/api/followups/send', { body: { lead_ids: [q.lead_id] } })).data;
  assert.equal(r.sent, 1);
  assert.equal(await stateOf(q.lead_id), 'Seguimiento 2');
  assert.match(fakes.state.mails[1].subject, /Recordatorio/);

  // Seguimiento 2 → Archivado: por defecto se archiva sin correo
  r = (await api('POST', '/api/followups/send', { body: { lead_ids: [q.lead_id] } })).data;
  assert.equal(r.sent, 1);
  assert.equal(fakes.state.mails.length, 2);
  assert.equal(await stateOf(q.lead_id), 'Archivado');

  const log = (await api('GET', `/api/followups/log?lead_id=${q.lead_id}`)).data;
  assert.deepEqual(log.map((x) => x.status).reverse(), ['enviado', 'enviado', 'movido']);
  const lead = (await query('SELECT comments FROM leads WHERE id=$1', [q.lead_id])).rows[0];
  assert.match(lead.comments, /"Seguimiento 1" enviado a marta2@acme\.cl/);
});

test('error del proveedor: no mueve la etapa y queda registrado; no se repite un paso enviado', async () => {
  const q = await mkQuote('marta3@acme.cl');
  fakes.state.mailFail = true;
  let r = (await api('POST', '/api/followups/send', { body: { lead_ids: [q.lead_id] } })).data;
  assert.equal(r.failed, 1);
  assert.match(r.results[0].message, /domain not verified/);
  assert.equal(await stateOf(q.lead_id), 'Cotizado');
  fakes.state.mailFail = false;
  r = (await api('POST', '/api/followups/send', { body: { lead_ids: [q.lead_id] } })).data;
  assert.equal(r.sent, 1);
  // Si alguien devuelve el lead a Cotizado, no se reenvía el mismo seguimiento
  const cot = (await query("SELECT id FROM pipeline_states WHERE name='Cotizado'")).rows[0].id;
  await query('UPDATE leads SET state_id=$1 WHERE id=$2', [cot, q.lead_id]);
  r = (await api('POST', '/api/followups/send', { body: { lead_ids: [q.lead_id] } })).data;
  assert.equal(r.sent, 0);
  assert.match(r.results[0].message, /ya se envió/);
  const log = (await api('GET', `/api/followups/log?lead_id=${q.lead_id}`)).data;
  assert.deepEqual(log.map((x) => x.status).reverse(), ['error', 'enviado']);
});

test('sin correo válido o pausada: no se envía; modo automático envía lo que ya toca', async () => {
  const sin = await mkQuote('x@y.cl');
  await query("UPDATE quotes SET email='' WHERE id=$1", [sin.id]); await query("UPDATE leads SET email='' WHERE id=$1", [sin.lead_id]);
  assert.match((await api('POST', '/api/followups/send', { body: { lead_ids: [sin.lead_id] } })).data.results[0].message, /correo válido/);
  const pa = await mkQuote('pausa@acme.cl');
  await api('POST', '/api/followups/mode', { body: { lead_ids: [pa.lead_id], mode: 'pausado' } });
  assert.match((await api('POST', '/api/followups/send', { body: { lead_ids: [pa.lead_id] } })).data.results[0].message, /pausado/);

  const au = await mkQuote('auto@acme.cl');
  const aun = await mkQuote('auto2@acme.cl');
  await api('POST', '/api/followups/mode', { body: { lead_ids: [au.lead_id, aun.lead_id], mode: 'auto' } });
  // au lleva 3 días en Cotizado (toca S1); aun es de hoy (aún no toca)
  await query("UPDATE leads SET state_date = CURRENT_DATE - 3 WHERE id=$1", [au.lead_id]);
  const before = fakes.state.mails.length;
  const run = (await api('POST', '/api/followups/run-auto')).data;
  assert.equal(run.sent, 1);
  assert.equal(fakes.state.mails.length, before + 1);
  assert.equal(await stateOf(au.lead_id), 'Seguimiento 1');
  assert.equal(await stateOf(aun.lead_id), 'Cotizado');
  assert.equal((await query('SELECT trigger FROM followup_emails WHERE lead_id=$1', [au.lead_id])).rows[0].trigger, 'auto');
});

test('el filtro "IA" solo lista cotizaciones del bot', async () => {
  const web = await mkQuote('manual@acme.cl', 'Cotizador');
  const ia = (await api('GET', '/api/followups?channel=ia')).data.rows.map((r) => r.lead_id);
  const all = (await api('GET', '/api/followups?channel=all')).data.rows.map((r) => r.lead_id);
  assert.ok(!ia.includes(web.lead_id));
  assert.ok(all.includes(web.lead_id));
});

test('Gmail de Quot: envía por la API con PDF, queda el hilo y si el cliente responde se pausa solo', async () => {
  await api('PUT', '/api/integrations', { body: { clear: ['RESEND_API_KEY'], values: { EMAIL_PROVIDER: 'gmail', GMAIL_CLIENT_ID: 'cid.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'GOCSPX-secret', GMAIL_REFRESH_TOKEN: 'rt_bad' } } });
  const bad = (await api('POST', '/api/integrations/test/email', { body: {} })).data;
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Google rechazó/);
  await api('PUT', '/api/integrations', { body: { values: { GMAIL_REFRESH_TOKEN: 'rt_ok' } } });
  const good = (await api('POST', '/api/integrations/test/email', { body: {} })).data;
  assert.equal(good.ok, true, good.message);
  assert.match(good.message, /contacto@quot\.cl/);

  const q = await mkQuote('marta@acme.cl');
  fakes.state.gmailSent.length = 0;
  let r = (await api('POST', '/api/followups/send', { body: { lead_ids: [q.lead_id] } })).data;
  assert.equal(r.sent, 1, JSON.stringify(r));
  const mime = fakes.state.gmailSent.at(-1);
  assert.match(mime, /To: marta@acme\.cl/);
  assert.match(mime, /Subject: =\?UTF-8\?Q\?Seguimiento_cotizaci/);
  assert.match(mime, /filename=Cotizacion-/);
  assert.match(mime, /Reply-To: contacto@quot\.cl/);
  assert.equal(await stateOf(q.lead_id), 'Seguimiento 1');
  const th = (await query("SELECT thread_id FROM followup_emails WHERE lead_id=$1 AND status='enviado'", [q.lead_id])).rows[0].thread_id;
  assert.ok(th);

  // Sin respuesta: no pasa nada. Con respuesta: se pausa y queda anotado.
  assert.equal((await api('POST', '/api/followups/check-replies')).data.count, 0);
  fakes.state.gmailReplies.add(th);
  const cr = (await api('POST', '/api/followups/check-replies')).data;
  assert.equal(cr.count, 1);
  assert.equal((await query('SELECT follow_mode FROM leads WHERE id=$1', [q.lead_id])).rows[0].follow_mode, 'pausado');
  assert.match((await query('SELECT comments FROM leads WHERE id=$1', [q.lead_id])).rows[0].comments, /cliente respondió/);
  assert.equal((await api('GET', `/api/followups/log?lead_id=${q.lead_id}`)).data[0].status, 'respuesta');
  r = (await api('POST', '/api/followups/send', { body: { lead_ids: [q.lead_id] } })).data;
  assert.match(r.results[0].message, /pausado/);
});

test('leads antiguos con N° de cotización (sin registro) entran al seguimiento, sin PDF y sin monto; las derivaciones sin cotizar no', async () => {
  const cot = (await query("SELECT id FROM pipeline_states WHERE name='Cotizado'")).rows[0].id;
  const mk = async (name, qn, email) => (await query(
    `INSERT INTO leads(client_name, razon_social, email, contact, state_id, state_date, lead_date, quote_number, channel) VALUES($1,$1,$2,'Pedro Pérez',$3, CURRENT_DATE, CURRENT_DATE, $4, 'Web') RETURNING id`, [name, email, cot, qn])).rows[0].id;
  const old = await mk('Antigua Ltda', 321, 'pedro@antigua.cl');
  const deriv = await mk('Derivación SpA', null, 'der@iv.cl');
  const list = (await api('GET', '/api/followups')).data;
  const row = list.rows.find((r) => r.lead_id === old);
  assert.equal(row.number, 321);
  assert.equal(row.has_pdf, false);
  assert.ok(!list.rows.some((r) => r.lead_id === deriv));
  assert.ok(list.hidden_without_quote >= 1);
  const p = (await api('GET', `/api/followups/preview/${old}`)).data;
  assert.equal(p.attachment, '');
  assert.doesNotMatch(p.text, /adjunt/);
  assert.doesNotMatch(p.text, /IVA incluido/);
  assert.match(p.text, /cotización N° 321/);
  fakes.state.mails.length = 0; fakes.state.gmailSent.length = 0;
  const r = (await api('POST', '/api/followups/send', { body: { lead_ids: [old] } })).data;
  assert.equal(r.sent, 1, JSON.stringify(r));
  assert.equal(await stateOf(old), 'Seguimiento 1');
  assert.equal((await api('POST', '/api/followups/send', { body: { lead_ids: [deriv] } })).data.sent, 0);
});

test('programar envíos manuales: se envían a su hora, se pueden cancelar y no salen si cambió la etapa', async () => {
  await api('PUT', '/api/integrations', { body: { values: { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_testkey' } } });
  const a = await mkQuote('prog1@acme.cl');
  const b = await mkQuote('prog2@acme.cl');
  const c = await mkQuote('prog3@acme.cl');
  const past = (await api('POST', '/api/followups/schedule', { body: { lead_ids: [a.lead_id], at: new Date(Date.now() - 3600000).toISOString() } }));
  assert.equal(past.status, 400);
  const at = new Date(Date.now() + 3600000).toISOString();
  const r = (await api('POST', '/api/followups/schedule', { body: { lead_ids: [a.lead_id, b.lead_id, c.lead_id], at } })).data;
  assert.equal(r.scheduled, 3);
  assert.ok((await api('GET', '/api/followups')).data.rows.find((x) => x.lead_id === a.lead_id).follow_sched_at);
  await api('POST', '/api/followups/unschedule', { body: { lead_ids: [c.lead_id] } });
  // aún no es la hora: no se envía nada
  const before = fakes.state.mails.length;
  await api('POST', '/api/followups/run-auto');
  assert.equal(fakes.state.mails.length, before);
  // llega la hora (a y c; b cambia de etapa a mano antes)
  await query("UPDATE leads SET follow_sched_at = now() - interval '1 minute' WHERE id = ANY($1)", [[a.lead_id, b.lead_id]]);
  const s1 = (await query("SELECT id FROM pipeline_states WHERE name='Seguimiento 2'")).rows[0].id;
  await query('UPDATE leads SET state_id=$1 WHERE id=$2', [s1, b.lead_id]);
  const run = (await api('POST', '/api/followups/run-auto')).data;
  assert.equal(run.sent, 1);
  assert.equal(await stateOf(a.lead_id), 'Seguimiento 1');
  assert.equal(await stateOf(b.lead_id), 'Seguimiento 2');
  assert.equal(await stateOf(c.lead_id), 'Cotizado');
  assert.equal((await query("SELECT trigger FROM followup_emails WHERE lead_id=$1 AND status='enviado'", [a.lead_id])).rows[0].trigger, 'programado');
  assert.equal((await query('SELECT follow_sched_at FROM leads WHERE id=$1', [b.lead_id])).rows[0].follow_sched_at, null);
});

test('alertas: conversación derivada sin atender envía correo a contacto; no repite ni alerta si respondieron', async () => {
  const { runAlerts } = await import('../src/alerts.js');
  await api('PUT', '/api/integrations', { body: { values: { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_testkey' } } });
  const mk = async (name, labels = 'derivado') => (await query("INSERT INTO conversations(status, contact_name, contact_company, handoff_reason, labels, handoff_at) VALUES('open',$1,$1,'cotizacion: necesita precio',$2, now() - interval '5 minutes') RETURNING id", [name, labels])).rows[0].id;
  const a = await mk('Alfa SpA');
  const b = await mk('Beta SpA');
  const sp = await mk('Spam SpA', 'derivado,posible_spam');
  const fresh = (await query("INSERT INTO conversations(status, contact_name, labels, handoff_at) VALUES('open','Nueva','derivado', now()) RETURNING id")).rows[0].id;
  await query("INSERT INTO conversation_messages(conversation_id, direction, sender_type, content) VALUES($1,'out','agent','Hola, te ayudo')", [b]);
  const before = fakes.state.mails.length;
  const r1 = await runAlerts();
  assert.deepEqual(r1.map((x) => x.conversation_id), [a]);
  const mail = fakes.state.mails[before];
  assert.match(JSON.stringify(mail), /contacto@quot\.cl/);
  assert.match(JSON.stringify(mail), /requiere atenci/);
  assert.equal((await runAlerts()).length, 0); // no repite
  // tarea pendiente del bot
  await query("INSERT INTO chat_sessions(id, status, pending_handoff, pending_at) VALUES('s-pend','bot','otro|quiere cotizar', now() - interval '4 minutes')");
  const r2 = await runAlerts();
  assert.deepEqual(r2.map((x) => x.kind), ['pendiente']);
  assert.equal((await runAlerts()).length, 0);
  // desactivadas
  await query("UPDATE conversations SET alerted_at=NULL WHERE id=$1", [a]);
  await api('PUT', '/api/settings', { body: { alert_enabled: '0' } });
  assert.equal((await runAlerts()).length, 0);
  await api('PUT', '/api/settings', { body: { alert_enabled: '1' } });
  void sp; void fresh;
});
