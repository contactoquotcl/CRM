import express, { Router } from 'express';
import { authenticate, requireAdmin } from '../auth.js';
import { HttpError } from '../util.js';
import { verifyWcSignature, wcEnabled } from '../woo.js';
import { catalogStatus, deleteByWcId, syncAll, upsertProduct } from '../catalog.js';

// Webhook público de WooCommerce (firmado). Usa cuerpo crudo para validar la firma.
export const wooWebhookRouter = Router();
wooWebhookRouter.post('/', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyWcSignature(raw, req.get('x-wc-webhook-signature'))) throw new HttpError(401, 'Firma inválida');
  const topic = req.get('x-wc-webhook-topic');
  if (!topic) return res.json({ ok: true, ping: true }); // ping al crear el webhook
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
  if (topic === 'product.created' || topic === 'product.updated' || topic === 'product.restored') {
    if (payload?.id) await upsertProduct(payload);
  } else if (topic === 'product.deleted') {
    if (payload?.id) await deleteByWcId(payload.id);
  }
  // order.* se procesa en la Fase 3
  res.json({ ok: true, topic });
});

export const catalogRouter = Router();
catalogRouter.use(authenticate, requireAdmin);

catalogRouter.get('/status', async (_req, res) => res.json(await catalogStatus()));

catalogRouter.post('/sync', async (_req, res) => {
  if (!wcEnabled()) throw new HttpError(400, 'WooCommerce no está configurado en el servidor (WC_BASE_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET)');
  // En segundo plano: con miles de productos tarda más que el timeout de un request.
  syncAll({ reason: 'manual' }).catch((e) => console.error('[catalog] sync falló:', e.message));
  res.status(202).json({ ok: true, started: true });
});
