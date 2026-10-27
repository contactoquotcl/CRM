import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakes } from './fakes.js';

process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.cl';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.JWT_SECRET = 'test-secret';
for (const k of ['WC_BASE_URL', 'WC_CONSUMER_KEY', 'WC_CONSUMER_SECRET', 'CHATWOOT_BASE_URL', 'CHATWOOT_API_TOKEN', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) delete process.env[k];

const fakes = await startFakes({ pageSize: 5 });
const { initDb, query } = await import('../src/db.js');
const { seedAdmin } = await import('../src/auth.js');
const { createApp } = await import('../src/app.js');
const { wcConfig } = await import('../src/config.js');
const { loadOverrides } = await import('../src/secrets.js');

let server, base, admin, user;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, text: await r.clone().text(), data: await r.json().catch(() => null) };
};
const login = async (email, password) => (await api('POST', '/api/auth/login', { body: { email, password } })).data.token;

before(async () => {
  await initDb();
  await seedAdmin();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@test.cl', 'admin-pass-123');
  await api('POST', '/api/users', { token: admin, body: { email: 'u@test.cl', name: 'U', password: 'user-pass-123', role: 'user' } });
  user = await login('u@test.cl', 'user-pass-123');
});
after(async () => { server.close(); await fakes.stop(); });

test('solo admin accede a integraciones', async () => {
  assert.equal((await api('GET', '/api/integrations')).status, 401);
  assert.equal((await api('GET', '/api/integrations', { token: user })).status, 403);
  assert.equal((await api('PUT', '/api/integrations', { token: user, body: { values: { WC_BASE_URL: 'https://x.cl' } } })).status, 403);
  assert.equal((await api('GET', '/api/integrations', { token: admin })).status, 200);
});

test('guardar claves: cifradas en BD, activas en config y nunca devueltas', async () => {
  assert.equal(wcConfig().key, '');
  const SECRET = 'ck_SUPERSECRETO_1234567890';
  const r = await api('PUT', '/api/integrations', { token: admin, body: { values: { WC_BASE_URL: fakes.url, WC_CONSUMER_KEY: SECRET, WC_CONSUMER_SECRET: 'cs_otro_secreto_9999' } } });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('SUPERSECRETO') && !r.text.includes('otro_secreto'), 'la respuesta no debe contener secretos');
  const g = await api('GET', '/api/integrations', { token: admin });
  assert.ok(!g.text.includes('SUPERSECRETO'));
  const woo = g.data.groups.find((x) => x.id === 'woocommerce');
  const key = woo.fields.find((f) => f.key === 'WC_CONSUMER_KEY');
  assert.equal(key.configured, true);
  assert.equal(key.source, 'crm');
  assert.equal(key.hint, '…7890');
  assert.equal(key.value, undefined);
  assert.equal(woo.fields.find((f) => f.key === 'WC_BASE_URL').value, fakes.url);
  // cifrado en reposo
  const row = (await query("SELECT value_enc FROM integration_values WHERE key='WC_CONSUMER_KEY'")).rows[0];
  assert.ok(row.value_enc.startsWith('v1:') && !row.value_enc.includes('SUPERSECRETO'));
  // la config lo usa de inmediato y sobrevive a un reinicio (recarga desde BD)
  assert.equal(wcConfig().key, SECRET);
  await loadOverrides();
  assert.equal(wcConfig().key, SECRET);
  // webhooks listos para copiar
  assert.match(g.data.webhooks.woo.url, /\/api\/woo\/webhook$/);
});

test('campo vacío no pisa el secreto; clear lo borra y vuelve a la variable de entorno', async () => {
  await api('PUT', '/api/integrations', { token: admin, body: { values: { WC_CONSUMER_KEY: '' } } });
  assert.equal(wcConfig().key, 'ck_SUPERSECRETO_1234567890');
  process.env.WC_CONSUMER_KEY = 'ck_env';
  assert.equal(wcConfig().key, 'ck_SUPERSECRETO_1234567890', 'lo guardado en el CRM tiene prioridad');
  await api('PUT', '/api/integrations', { token: admin, body: { clear: ['WC_CONSUMER_KEY'] } });
  assert.equal(wcConfig().key, 'ck_env');
  const g = await api('GET', '/api/integrations', { token: admin });
  assert.equal(g.data.groups.find((x) => x.id === 'woocommerce').fields.find((f) => f.key === 'WC_CONSUMER_KEY').source, 'env');
  delete process.env.WC_CONSUMER_KEY;
});

test('validación de campos', async () => {
  assert.equal((await api('PUT', '/api/integrations', { token: admin, body: { values: { WC_BASE_URL: 'no-es-url' } } })).status, 400);
  assert.equal((await api('PUT', '/api/integrations', { token: admin, body: { values: { CHATWOOT_INBOX_ID: 'abc' } } })).status, 400);
  assert.equal((await api('PUT', '/api/integrations', { token: admin, body: { values: { JWT_SECRET: 'x' } } })).status, 400, 'solo campos conocidos');
});

test('probar conexión: WooCommerce y Chatwoot contra los fakes; Claude sin clave falla claro', async () => {
  await api('PUT', '/api/integrations', { token: admin, body: { values: { WC_CONSUMER_KEY: 'ck', WC_CONSUMER_SECRET: 'cs', CHATWOOT_BASE_URL: fakes.url, CHATWOOT_ACCOUNT_ID: '1', CHATWOOT_API_TOKEN: 'cw-token', CHATWOOT_INBOX_ID: '7' } } });
  const w = await api('POST', '/api/integrations/test/woocommerce', { token: admin });
  assert.equal(w.data.ok, true);
  const c = await api('POST', '/api/integrations/test/chatwoot', { token: admin });
  assert.equal(c.data.ok, true);
  assert.match(c.data.message, /Web Quot/);
  assert.equal((await api('POST', '/api/integrations/test/llm', { token: admin })).status, 400);
  await api('PUT', '/api/integrations', { token: admin, body: { values: { CHATWOOT_API_TOKEN: 'token-malo' } } });
  const bad = await api('POST', '/api/integrations/test/chatwoot', { token: admin });
  assert.equal(bad.data.ok, false);
  assert.ok(!bad.text.includes('token-malo'));
});

test('proveedor de IA: Gemini configurable y probable desde el CRM', async () => {
  assert.equal((await api('PUT', '/api/integrations', { token: admin, body: { values: { LLM_PROVIDER: 'openai' } } })).status, 400);
  await api('PUT', '/api/integrations', { token: admin, body: { values: { LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'gem-key', GEMINI_MODEL: 'gemini-2.5-flash' } } });
  process.env.GEMINI_BASE_URL = fakes.url;
  const ok = await api('POST', '/api/integrations/test/llm', { token: admin });
  assert.equal(ok.data.ok, true);
  assert.match(ok.data.message, /Gemini/);
  await api('PUT', '/api/integrations', { token: admin, body: { values: { GEMINI_API_KEY: 'gem-mala' } } });
  const bad = await api('POST', '/api/integrations/test/llm', { token: admin });
  assert.equal(bad.data.ok, false);
  assert.ok(!bad.text.includes('gem-mala'));
  delete process.env.GEMINI_BASE_URL;
});
