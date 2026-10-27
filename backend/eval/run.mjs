// Evaluación del chatbot con 20 casos reales de Quot.
//   ANTHROPIC_API_KEY=sk-... node eval/run.mjs [--out eval/report.md] [--only 1,2,3] [--no-fail]
//   node eval/run.mjs --mock      → usa un "modelo" de reglas (solo valida que el arnés funciona; no mide calidad)
// WooCommerce y Chatwoot son simulados con el catálogo de test/fixtures/catalog.json (precios en vivo conocidos).
import { readFileSync, writeFileSync } from 'node:fs';
import { startFakes, ruleBasedLlm } from '../test/fakes.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const mock = flag('--mock');
const out = val('--out', new URL('./report.md', import.meta.url).pathname);
const only = val('--only', '') ? new Set(val('--only').split(',').map(Number)) : null;

const realKey = process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY;
if (!mock && !realKey) { console.error('Falta ANTHROPIC_API_KEY o GEMINI_API_KEY (o usa --mock para validar solo el arnés).'); process.exit(2); }

const fakes = await startFakes({ pageSize: 5 });
fakes.state.cwAgents = [];
Object.assign(process.env, {
  PGLITE_DIR: 'memory://', ADMIN_EMAIL: 'eval@quot.test', ADMIN_PASSWORD: 'eval-pass-123', JWT_SECRET: 'eval',
  WC_BASE_URL: fakes.url, WC_CONSUMER_KEY: 'ck', WC_CONSUMER_SECRET: 'cs',
  CHATWOOT_BASE_URL: fakes.url, CHATWOOT_ACCOUNT_ID: '1', CHATWOOT_API_TOKEN: 'cw-token', CHATWOOT_INBOX_ID: '7',
});
if (mock) {
  fakes.state.llmDefault = ruleBasedLlm;
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: fakes.url });
}

const { initDb, query } = await import('../src/db.js');
const { seedAdmin } = await import('../src/auth.js');
const { syncAll } = await import('../src/catalog.js');
const { createSession, sessionFromToken, handleUserMessage } = await import('../src/chatbot/engine.js');
await initDb();
await seedAdmin();
await syncAll({ reason: 'eval' });

const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')).filter((c) => !only || only.has(c.id));
const results = [];
for (const c of cases) {
  const { token } = await createSession();
  let session = await sessionFromToken(token);
  const replies = [];
  let error = null;
  try {
    for (const t of c.turns) {
      const r = await handleUserMessage(session, t);
      replies.push(...r.replies.map((x) => x.content));
      session = await sessionFromToken(token);
    }
  } catch (e) { error = e.message; }
  const tools = (await query('SELECT name FROM chat_tool_calls WHERE session_id=$1 ORDER BY id', [session.id])).rows.map((r) => r.name);
  const handoff = session.status === 'handoff';
  const text = replies.join('\n');
  const e = c.expect;
  const checks = [];
  const check = (ok, what) => checks.push({ ok, what });
  if (error) check(false, `sin errores (${error})`);
  for (const t of e.tools_include || []) check(tools.includes(t), `usa la herramienta ${t}`);
  for (const t of e.tools_exclude || []) check(!tools.includes(t), `NO usa la herramienta ${t}`);
  if (e.handoff !== undefined) check(handoff === e.handoff, e.handoff ? 'deriva a un ejecutivo' : 'no deriva a un ejecutivo');
  for (const re of e.reply_matches || []) check(new RegExp(re, 'i').test(text), `la respuesta menciona /${re}/`);
  for (const re of e.reply_not_matches || []) check(!new RegExp(re, 'i').test(text), `la respuesta NO contiene /${re}/`);
  results.push({ c, checks, tools, handoff, text, pass: checks.every((x) => x.ok) });
  process.stdout.write(results.at(-1).pass ? '.' : 'F');
}
console.log();

const passed = results.filter((r) => r.pass).length;
let md = `# Evaluación del chatbot de Quot\n\n- Fecha: ${new Date().toISOString()}\n- Modo: ${mock ? '**SIMULADO** (modelo de reglas; solo valida el arnés)' : `modelo real \`${process.env.CHATBOT_MODEL || 'claude-sonnet-5-5'}\``}\n- Resultado: **${passed}/${results.length}** casos aprobados\n\n| # | Caso | Resultado | Herramientas | Derivó |\n|---|---|---|---|---|\n`;
for (const r of results) md += `| ${r.c.id} | ${r.c.title} | ${r.pass ? '✅' : '❌'} | ${r.tools.join(', ') || '—'} | ${r.handoff ? 'sí' : 'no'} |\n`;
md += '\n## Detalle\n';
for (const r of results) {
  md += `\n### ${r.c.id}. ${r.c.title} ${r.pass ? '✅' : '❌'}\n**Cliente:** ${r.c.turns.join(' ➜ ')}\n\n**Bot:** ${r.text.replace(/\n/g, '\n> ') || '(sin respuesta)'}\n\n`;
  for (const k of r.checks) md += `- ${k.ok ? '✅' : '❌'} ${k.what}\n`;
}
writeFileSync(out, md);
console.log(`${passed}/${results.length} casos aprobados → ${out}`);
await fakes.stop();
process.exit(passed === results.length || flag('--no-fail') ? 0 : 1);
