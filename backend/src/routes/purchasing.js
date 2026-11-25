import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, requirePurchasing } from '../auth.js';
import { HttpError } from '../util.js';
import { sendMail, mailEnabled } from '../mailer.js';
import { getSettings } from '../db.js';
import { STATUSES, PO_SELECT, cleanSupplier, rutKey, savePurchaseOrder, purchaseOrderPdf } from '../purchasing.js';

// ---------------------------------------------------------------- Proveedores
export const suppliersRouter = Router();
suppliersRouter.use(authenticate, requirePurchasing);

suppliersRouter.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const all = req.query.all === '1';
  const params = []; const where = [];
  if (!all) where.push('active');
  if (q) { params.push(`%${q}%`); where.push(`(LOWER(razon_social) LIKE $${params.length} OR LOWER(rut) LIKE $${params.length} OR LOWER(contact) LIKE $${params.length} OR LOWER(email) LIKE $${params.length})`); }
  const { rows } = await query(`SELECT *, (SELECT COUNT(*)::int FROM purchase_orders p WHERE p.supplier_id=suppliers.id) AS po_count FROM suppliers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY razon_social LIMIT 1000`, params);
  res.json(rows);
});

suppliersRouter.post('/', async (req, res) => {
  const s = cleanSupplier(req.body);
  if ((await query('SELECT 1 FROM suppliers WHERE rut_key=$1', [rutKey(s.rut)])).rows[0]) throw new HttpError(409, 'Ya existe un proveedor con ese RUT');
  const { rows } = await query('INSERT INTO suppliers(rut, rut_key, razon_social, phone, email, contact, address, payment_terms, notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [s.rut, rutKey(s.rut), s.razon_social, s.phone, s.email, s.contact, s.address, s.payment_terms, s.notes]);
  res.status(201).json(rows[0]);
});

suppliersRouter.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await query('SELECT * FROM suppliers WHERE id=$1', [id])).rows[0];
  if (!cur) throw new HttpError(404, 'Proveedor no encontrado');
  if (req.body.active !== undefined && Object.keys(req.body).length === 1) {
    return res.json((await query('UPDATE suppliers SET active=$1 WHERE id=$2 RETURNING *', [!!req.body.active, id])).rows[0]);
  }
  const s = cleanSupplier({ ...cur, ...req.body });
  const dup = (await query('SELECT 1 FROM suppliers WHERE rut_key=$1 AND id<>$2', [rutKey(s.rut), id])).rows[0];
  if (dup) throw new HttpError(409, 'Ya existe otro proveedor con ese RUT');
  const { rows } = await query('UPDATE suppliers SET rut=$1, rut_key=$2, razon_social=$3, phone=$4, email=$5, contact=$6, address=$7, payment_terms=$8, notes=$9, active=$10 WHERE id=$11 RETURNING *',
    [s.rut, rutKey(s.rut), s.razon_social, s.phone, s.email, s.contact, s.address, s.payment_terms, s.notes, req.body.active === undefined ? cur.active : !!req.body.active, id]);
  res.json(rows[0]);
});

// ---------------------------------------------------------------- Órdenes de compra
export const purchaseOrdersRouter = Router();
purchaseOrdersRouter.use(authenticate, requirePurchasing);

purchaseOrdersRouter.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const params = []; const where = [];
  if (q) { params.push(`%${q}%`); where.push(`(LOWER(po.razon_social) LIKE $1 OR LOWER(po.rut) LIKE $1 OR CAST(po.number AS TEXT) LIKE $1)`); }
  if (STATUSES.includes(req.query.status)) { params.push(req.query.status); where.push(`po.status = $${params.length}`); }
  const { rows } = await query(`${PO_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY po.number DESC LIMIT 500`, params);
  res.json(rows);
});

purchaseOrdersRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const po = (await query(`${PO_SELECT} WHERE po.id=$1`, [id])).rows[0];
  if (!po) throw new HttpError(404, 'Orden de compra no encontrada');
  const items = (await query('SELECT id, position, product_id, sku, description, qty, unit_cost, line_total FROM purchase_order_items WHERE po_id=$1 ORDER BY position', [id])).rows;
  res.json({ ...po, items });
});

purchaseOrdersRouter.post('/', async (req, res) => res.status(201).json(await savePurchaseOrder(req.body || {}, req.user.id)));
purchaseOrdersRouter.put('/:id', async (req, res) => res.json(await savePurchaseOrder(req.body || {}, req.user.id, Number(req.params.id))));

purchaseOrdersRouter.patch('/:id/status', async (req, res) => {
  const status = String(req.body?.status || '');
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Estado inválido');
  const { rows } = await query('UPDATE purchase_orders SET status=$1, updated_at=now() WHERE id=$2 RETURNING id, status', [status, Number(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, 'Orden de compra no encontrada');
  res.json(rows[0]);
});

purchaseOrdersRouter.get('/:id/pdf', async (req, res) => {
  const { number, buffer } = await purchaseOrderPdf(Number(req.params.id));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="OrdenCompra-${number}.pdf"`);
  res.send(buffer);
});

// Envía la OC (PDF adjunto) al correo del proveedor y la marca como «Enviada»
purchaseOrdersRouter.post('/:id/send', async (req, res) => {
  if (!mailEnabled()) throw new HttpError(400, 'El correo no está configurado (Admin → Integraciones → Correo de seguimiento)');
  const { number, po, buffer } = await purchaseOrderPdf(Number(req.params.id));
  if (po.status === 'Anulada') throw new HttpError(400, 'La orden está anulada');
  const to = String(req.body?.to || po.email).trim();
  if (!/^\S+@\S+\.\S+$/.test(to)) throw new HttpError(400, 'Correo del proveedor inválido');
  const s = await getSettings();
  const first = (po.contact || '').split(/\s+/)[0] || 'equipo';
  const text = `Hola ${first},\n\nAdjuntamos la orden de compra N° ${number} de ${s.company_name}. Por favor confirma su recepción y la fecha de entrega.\n\nSaludos cordiales,\n${s.company_name}${s.company_phone ? `\n${s.company_phone}` : ''}`;
  await sendMail({ to, subject: `Orden de compra N° ${number} — ${s.company_name}`, text, attachments: [{ filename: `OrdenCompra-${number}.pdf`, content: buffer }] });
  await query("UPDATE purchase_orders SET status = CASE WHEN status='Emitida' THEN 'Enviada' ELSE status END, sent_at=now(), updated_at=now() WHERE id=$1", [po.id]);
  res.json({ ok: true, to });
});
