import { Router } from 'express';
import { authenticate, requireAdmin } from '../auth.js';
import { HttpError } from '../util.js';
import { describe, saveValues, validate } from '../secrets.js';
import { llmEnabled, callLLM, llmLabel } from '../chatbot/llm.js';
import { wcEnabled, wcPing } from '../woo.js';
import { mailEnabled, mailPing, mailLabel, sendMail } from '../mailer.js';
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
  email: async (req) => {
    if (!mailEnabled()) throw new HttpError(400, 'Faltan datos del servicio de correo (API key de Resend o servidor SMTP, y correo remitente)');
    const ping = await mailPing();
    const to = req.user?.email;
    if (to) {
      await sendMail({ to, subject: 'Prueba de correo – CRM Quot', text: `Este es un correo de prueba del CRM enviado con ${mailLabel()}. Si lo ves, los seguimientos de cotizaciones saldrán con este remitente.` });
      return `${ping} Te enviamos un correo de prueba a ${to}.`;
    }
    return ping;
  },
  llm: async () => {
    if (!llmEnabled()) throw new HttpError(400, `Falta la API key del proveedor activo (${llmLabel()})`);
    await callLLM({ system: 'Responde solo "ok".', messages: [{ role: 'user', content: 'ping' }], tools: undefined });
    return `${llmLabel()} respondió correctamente.`;
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
    res.json({ ok: true, message: await t(req) });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // El mensaje de error puede traer texto del servicio remoto, nunca la clave; igual se acota.
    res.json({ ok: false, message: String(e.message || e).slice(0, 300) });
  }
});
