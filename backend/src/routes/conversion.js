import { Router } from 'express';
import { authenticate, requireAdmin } from '../auth.js';
import { HttpError } from '../util.js';
import { query } from '../db.js';
import { importFiles, metrics, reconcile, suggestions } from '../billing.js';

export const conversionRouter = Router();
conversionRouter.use(authenticate, requireAdmin);

const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');

conversionRouter.get('/', async (req, res) => {
  const group = ['day', 'month', 'year'].includes(req.query.group) ? req.query.group : 'month';
  res.json(await metrics({ from: date(req.query.from), to: date(req.query.to), group, channel: String(req.query.channel || ''), userId: Number(req.query.user) || 0, dedupe: req.query.dedupe !== '0' }));
});

// Carga de facturación: el navegador envía el texto de cada archivo (.xls/HTML del SII o CSV).
conversionRouter.post('/upload', async (req, res) => {
  const files = (Array.isArray(req.body?.files) ? req.body.files : []).slice(0, 12).filter((f) => f && typeof f.text === 'string' && f.text.length);
  if (!files.length) throw new HttpError(400, 'Adjunta al menos un archivo del SII');
  res.json(await importFiles(files, req.user.id));
});

conversionRouter.post('/reconcile', async (_req, res) => res.json({ matched: await reconcile() }));

conversionRouter.get('/suggest/:invoiceId', async (req, res) => {
  const r = await suggestions(Number(req.params.invoiceId));
  if (!r) throw new HttpError(404, 'Factura no encontrada');
  res.json(r);
});

// Vínculo manual factura ↔ cotización (quote_id null = «sin cotización», no se vuelve a conciliar sola)
conversionRouter.post('/link', async (req, res) => {
  const invId = Number(req.body?.invoice_id);
  const quoteId = req.body?.quote_id === null || req.body?.quote_id === undefined ? null : Number(req.body.quote_id);
  if (!Number.isInteger(invId)) throw new HttpError(400, 'invoice_id inválido');
  if (quoteId !== null) {
    if (!Number.isInteger(quoteId) || !(await query('SELECT 1 FROM quotes WHERE id=$1', [quoteId])).rows[0]) throw new HttpError(404, 'Cotización no encontrada');
    await query("UPDATE invoices SET quote_id=NULL, match='' WHERE quote_id=$1 AND id <> $2", [quoteId, invId]);
    await query("UPDATE invoices SET quote_id=$1, match='manual' WHERE id=$2", [quoteId, invId]);
  } else {
    await query("UPDATE invoices SET quote_id=NULL, match='none' WHERE id=$1", [invId]);
  }
  res.json({ ok: true });
});
