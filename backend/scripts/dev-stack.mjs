// Levanta el CRM completo contra servidores FALSOS de WooCommerce, Chatwoot y Anthropic (sin credenciales reales).
// Sirve para el smoke test de Playwright y para probar la bandeja/widget localmente.
//   node scripts/dev-stack.mjs            → API en http://127.0.0.1:4000
import { startFakes, ruleBasedLlm } from '../test/fakes.js';

const fakes = await startFakes({ pageSize: 5 });
fakes.state.llmDefault = ruleBasedLlm;
fakes.state.cwAgents = [{ id: 11, email: 'ana@quot.test' }];
Object.assign(process.env, {
  PGLITE_DIR: 'memory://', ADMIN_EMAIL: 'admin@quot.test', ADMIN_PASSWORD: 'admin-pass-123', JWT_SECRET: 'dev-stack',
  WC_BASE_URL: fakes.url, WC_CONSUMER_KEY: 'ck', WC_CONSUMER_SECRET: 'cs', WC_WEBHOOK_SECRET: 'wc-hook',
  CHATWOOT_BASE_URL: fakes.url, CHATWOOT_ACCOUNT_ID: '1', CHATWOOT_API_TOKEN: 'cw-token', CHATWOOT_INBOX_ID: '7', CHATWOOT_WEBHOOK_SECRET: 'cw-hook',
  ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: fakes.url,
});
const { initDb, query } = await import('../src/db.js');
const { seedAdmin, hashPassword } = await import('../src/auth.js');
const { createApp } = await import('../src/app.js');
const { syncAll } = await import('../src/catalog.js');
await initDb();
await seedAdmin();
await query("INSERT INTO users(email,name,password_hash,role) VALUES('ana@quot.test','Ana',$1,'user')", [hashPassword('clave-segura-1')]);
await syncAll({ reason: 'dev-stack' });
createApp().listen(Number(process.env.PORT) || 4000, '127.0.0.1', () => console.log('READY'));
