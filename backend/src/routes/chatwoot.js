import express, { Router } from 'express';
import { HttpError } from '../util.js';
import { verifyChatwootWebhook } from '../chatwoot.js';
import { handleChatwootEvent } from '../inbox.js';

// Webhook público de Chatwoot (firmado). Cuerpo crudo para validar la firma.
export const chatwootWebhookRouter = Router();
chatwootWebhookRouter.post('/', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyChatwootWebhook({ rawBody: raw, headers: req.headers, query: req.query })) throw new HttpError(401, 'Firma o token inválido');
  let evt;
  try {
    evt = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
  res.json({ ok: true, ...(await handleChatwootEvent(evt)) });
});
