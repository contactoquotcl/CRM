// Servidor falso que imita WooCommerce, la API de Anthropic y Chatwoot. Lo usan los tests de integración,
// el smoke test de Playwright y el script de evaluación del bot.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const FIXTURE = new URL('./fixtures/catalog.json', import.meta.url);
export const loadFixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

export async function startFakes({ pageSize = 5 } = {}) {
  const state = {
    wooProducts: loadFixture(),
    wooLive: {}, // id → override de campos "en vivo" (ej. price) sin tocar el catálogo
    llmQueue: [], // respuestas del "modelo": objeto o función(body) → objeto | { __status, __body }
    llmRequests: [],
    cwCalls: [],
    cwAgents: [],
    cwFail: new Set(), // rutas (substring) que deben fallar con 500
    nextId: 1000,
  };
  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* sin cuerpo JSON */ }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // ---- WooCommerce
    if (p.startsWith('/wp-json/wc/v3/')) {
      if (!String(req.headers.authorization || '').startsWith('Basic ')) return json(res, 401, { code: 'woocommerce_rest_cannot_view' });
      const live = (pr) => ({ ...pr, ...(state.wooLive[pr.id] || {}) });
      const rest = p.slice('/wp-json/wc/v3'.length);
      let m;
      if (rest === '/products') {
        const sku = url.searchParams.get('sku');
        if (sku) return json(res, 200, state.wooProducts.filter((x) => x.sku === sku).map(live));
        const page = Number(url.searchParams.get('page') || 1);
        const total = Math.max(1, Math.ceil(state.wooProducts.length / pageSize));
        return json(res, 200, state.wooProducts.slice((page - 1) * pageSize, page * pageSize).map(live), { 'x-wp-totalpages': String(total) });
      }
      if ((m = rest.match(/^\/products\/(\d+)$/))) {
        const pr = state.wooProducts.find((x) => x.id === Number(m[1]));
        return pr ? json(res, 200, live(pr)) : json(res, 404, { code: 'woocommerce_rest_product_invalid_id' });
      }
      if ((m = rest.match(/^\/products\/(\d+)\/variations$/))) return json(res, 200, state.wooVariations?.[m[1]] || []);
      return json(res, 404, {});
    }

    // ---- Anthropic
    if (p === '/v1/messages' && req.method === 'POST') {
      state.llmRequests.push(body);
      if (req.headers['x-api-key'] !== 'test-key') return json(res, 401, { error: { message: 'invalid x-api-key' } });
      let next = state.llmQueue.shift();
      if (typeof next === 'function') next = next(body);
      if (!next && state.llmDefault) next = state.llmDefault(body);
      if (!next) next = { content: [{ type: 'text', text: 'Respuesta de prueba sin guion.' }], stop_reason: 'end_turn' };
      if (next.__status) return json(res, next.__status, next.__body || { error: { message: 'error simulado' } });
      return json(res, 200, { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, ...next });
    }

    // ---- Chatwoot
    let m;
    if ((m = p.match(/^\/api\/v1\/accounts\/(\d+)(\/.*)$/))) {
      const rest = m[2];
      state.cwCalls.push({ method: req.method, path: rest, body, token: req.headers.api_access_token });
      if (req.headers.api_access_token !== 'cw-token') return json(res, 401, { error: 'unauthorized' });
      for (const f of state.cwFail) if (rest.includes(f)) return json(res, 500, { error: 'falla simulada' });
      if (req.method === 'GET' && rest === '/agents') return json(res, 200, state.cwAgents);
      if (req.method === 'POST' && rest === '/contacts') return json(res, 200, { payload: { contact: { id: state.nextId++, name: body.name } } });
      if (req.method === 'PUT' && rest.startsWith('/contacts/')) return json(res, 200, {});
      if (req.method === 'POST' && rest === '/conversations') return json(res, 200, { id: state.nextId++, status: body.status });
      if (req.method === 'POST' && /\/conversations\/\d+\/messages$/.test(rest)) return json(res, 200, { id: state.nextId++, content: body.content });
      if (req.method === 'POST' && /\/conversations\/\d+\/(toggle_status|assignments|labels)$/.test(rest)) return json(res, 200, { ok: true });
      return json(res, 404, {});
    }
    json(res, 404, { error: 'no encontrado en fakes' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { state, url, stop: () => new Promise((r) => server.close(r)) };
}

// Ayudas para armar respuestas del "modelo"
export const llmText = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
export const llmTool = (name, input, id = 'tu_' + Math.random().toString(36).slice(2, 8)) => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });

// "Modelo" de reglas para el smoke test y el modo simulado de la evaluación: busca, consulta ficha y responde con datos reales.
export function ruleBasedLlm(body) {
  const last = body.messages[body.messages.length - 1];
  if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
    const r = JSON.parse(last.content[0].content);
    if (r.resultados) {
      const first = r.resultados[0];
      return first ? llmTool('ver_producto', { sku: first.sku }) : llmText('No encontré productos con esa búsqueda. ¿Quieres que te derive con un ejecutivo?');
    }
    if (r.sku && r.precio_neto) return llmText(`${r.nombre} (SKU ${r.sku}): $${r.precio_neto.toLocaleString('es-CL')} neto + IVA, ${r.disponibilidad}. ${r.link}`);
    if (r.derivado) return llmText('Listo, un ejecutivo te responderá por este chat.');
    return llmText('Prefiero derivarte con un ejecutivo para esto.');
  }
  const text = (typeof last.content === 'string' ? last.content : '').toLowerCase();
  if (/(etiqueta|impresora|lector|stretch|zebra)/.test(text)) return llmTool('buscar_productos', { query: text.slice(0, 100) });
  if (/cotiz/.test(text)) return llmTool('derivar_ejecutivo', { motivo: 'cotizacion', resumen: text.slice(0, 300) });
  return llmText('Soy el asistente de Quot. Puedo ayudarte con productos Zebra, etiquetas, lectores y stretch film.');
}
