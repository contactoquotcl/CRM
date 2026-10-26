import { Router } from 'express';
import { authenticate, requireAdmin } from '../auth.js';
import { HttpError } from '../util.js';
import { describe, saveValues, validate } from '../secrets.js';
import { llmEnabled, callClaude } from '../chatbot/llm.js';
import { wcEnabled, wcPing } from '../woo.js';
import { chatwootEnabled, chatwootPing } from '../chatwoot.js';

export const integrationsRouter = Router();
integrationsRouter.use(authenticate, requireAdmin);

const apiBase = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.get('host')).split(',')[0];
  return `${proto}://${host}`;
};

integrationsRouter.get('/', async (req, res) => {
  const base = apiBase(req);
  res.json({
    groups: await describe(),
    webhooks: {
      woo: { url: `${base}/api/woo/webhook`, topics: ['product.created', 'product.updated', 'product.deleted'], note: 'WooCommerce → Ajustes → Avanzado → Webhooks → Añadir. Estado: Activo, versión API WP REST v3, y el mismo secreto de arriba.' },
      chatwoot: { url: `${base}/api/chatwoot/webhook`, events: ['message_created', 'conversation_status_changed', 'conversation_updated'], note: 'Chatwoot → Configuración → Integraciones → Webhooks. Si tu versión no firma los eventos, usa la URL con ?token=<secreto>.' },
      widget: `<script src="${base}/widget.js" data-api="${base}" async></script>`,
    },
  });
});

integrationsRouter.put('/', async (req, res) => {
  const values = req.body?.values && typeof req.body.values === 'object' ? req.body.values : {};
  const clear = Array.isArray(req.body?.clear) ? req.body.clear.map(String) : [];
  const err = validate(values);
  if (err) throw new HttpError(400, err);
  await saveValues(values, clear, req.user.id);
  res.json({ ok: true, groups: await describe() });
});

const TESTS = {
  anthropic: async () => {
    if (!llmEnabled()) throw new HttpError(400, 'Falta la API key de Anthropic');
    await callClaude({ system: 'Responde solo "ok".', messages: [{ role: 'user', content: 'ping' }], tools: undefined });
    return 'Claude respondió correctamente.';
  },
  woocommerce: async () => {
    if (!wcEnabled()) throw new HttpError(400, 'Faltan URL, consumer key o consumer secret');
    await wcPing();
    return 'Conexión con WooCommerce correcta (lectura del catálogo).';
  },
  chatwoot: async () => {
    if (!chatwootEnabled()) throw new HttpError(400, 'Faltan URL, ID de cuenta, token o ID de bandeja');
    const r = await chatwootPing();
    return `Conexión con Chatwoot correcta (bandeja "${r.inbox}").`;
  },
};

integrationsRouter.post('/test/:name', async (req, res) => {
  const t = TESTS[req.params.name];
  if (!t) throw new HttpError(404, 'Prueba desconocida');
  try {
    res.json({ ok: true, message: await t() });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // El mensaje de error puede traer texto del servicio remoto, nunca la clave; igual se acota.
    res.json({ ok: false, message: String(e.message || e).slice(0, 300) });
  }
});
