import { Router } from 'express';
import { query, tx, getSettings } from '../db.js';
import { authenticate } from '../auth.js';
import { HttpError } from '../util.js';
import { createQuote } from '../quoteService.js';
import { renderQuotePdf } from '../pdf.js';

export const quotesRouter = Router();
quotesRouter.use(authenticate);

const QUOTE_SELECT = `SELECT q.id, q.number, q.lead_id, q.quote_date::text AS quote_date, q.validity_days, q.rut, q.razon_social, q.email, q.contact, q.phone,
  q.notes, q.iva_rate, q.margin_pct, q.subtotal, q.iva, q.total, q.created_by, q.created_at, q.channel, q.conversation_id, u.name AS created_by_name
  FROM quotes q LEFT JOIN users u ON u.id = q.created_by`;

quotesRouter.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const params = [];
  let where = '';
  if (q) {
    params.push(`%${q}%`);
    where = `WHERE LOWER(q.razon_social) LIKE $1 OR LOWER(q.rut) LIKE $1 OR CAST(q.number AS TEXT) LIKE $1 OR LOWER(q.contact) LIKE $1 OR LOWER(u.name) LIKE $1`;
  }
  const { rows } = await query(`${QUOTE_SELECT} ${where} ORDER BY q.number DESC LIMIT 500`, params);
  res.json(rows);
});

quotesRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`${QUOTE_SELECT} WHERE q.id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Cotización no encontrada');
  const items = await query('SELECT id, position, product_id, sku, description, qty, cost, margin_pct, unit_price, line_total FROM quote_items WHERE quote_id=$1 ORDER BY position', [id]);
  res.json({ ...rows[0], items: items.rows });
});

quotesRouter.get('/:id/pdf', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`${QUOTE_SELECT} WHERE q.id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Cotización no encontrada');
  const items = await query('SELECT sku, description, qty, unit_price, line_total FROM quote_items WHERE quote_id=$1 ORDER BY position', [id]);
  // El PDF es para el cliente: solo recibe datos de venta (nunca costo ni margen).
  const { margin_pct: _internal, ...publicQuote } = rows[0];
  const pdf = await renderQuotePdf(publicQuote, items.rows, await getSettings());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Cotizacion-${rows[0].number}.pdf"`);
  res.send(pdf);
});

/**
 * Crea la cotización con el siguiente correlativo y registra el lead en estado inicial ("Cotizado").
 * Body: { client:{rut,razon_social,email,contact,phone}, margin (% sobre la venta, obligatorio),
 *         items:[{product_id?,sku,description,qty,cost,margin? (override por ítem)}],
 *         validity_days?, notes?, lead_id? (re-cotizar un lead existente) }
 * Precio de venta unitario = costo / (1 - margen). Costo y margen son internos: no salen en el PDF.
 */
quotesRouter.post('/', async (req, res) => {
  const created = await createQuote(req.body || {}, { userId: req.user.id, channel: 'Cotizador' });
  res.status(201).json(created);
});
