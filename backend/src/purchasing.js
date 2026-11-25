// Órdenes de compra y proveedores.
import { query, tx, getSettings } from './db.js';
import { HttpError, today } from './util.js';
import { renderPurchaseOrderPdf } from './pdf.js';

export const STATUSES = ['Emitida', 'Enviada', 'Recibida', 'Anulada'];
export const rutKey = (v = '') => String(v).replace(/[^0-9kK]/g, '').toUpperCase();
export function validRut(v) {
  const k = rutKey(v);
  if (k.length < 2) return false;
  const body = k.slice(0, -1); const dv = k.slice(-1);
  let sum = 0, m = 2;
  for (const d of body.split('').reverse()) { sum += Number(d) * m; m = m === 7 ? 2 : m + 1; }
  const r = 11 - (sum % 11);
  return dv === (r === 11 ? '0' : r === 10 ? 'K' : String(r));
}
export function formatRut(v) {
  const k = rutKey(v);
  return k.length < 2 ? k : `${k.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${k.slice(-1)}`;
}
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** Valida y normaliza a un proveedor (los 5 datos mínimos son obligatorios). */
export function cleanSupplier(b = {}) {
  const s = { rut: formatRut(b.rut), razon_social: str(b.razon_social), phone: str(b.phone), email: str(b.email).toLowerCase(), contact: str(b.contact), address: str(b.address), payment_terms: str(b.payment_terms), notes: str(b.notes) };
  const faltan = [['rut', 'RUT'], ['razon_social', 'razón social'], ['phone', 'teléfono'], ['email', 'correo'], ['contact', 'persona de contacto']].filter(([k]) => !s[k]).map(([, l]) => l);
  if (faltan.length) throw new HttpError(400, `Faltan datos del proveedor: ${faltan.join(', ')}`);
  if (!validRut(s.rut)) throw new HttpError(400, 'RUT inválido: revisa el dígito verificador');
  if (!/^\S+@\S+\.\S+$/.test(s.email)) throw new HttpError(400, 'Correo del proveedor inválido');
  return s;
}

const PO_COLS = `po.id, po.number, po.po_date::text AS po_date, po.supplier_id, po.rut, po.razon_social, po.email, po.contact, po.phone, po.status,
  po.delivery_date::text AS delivery_date, po.delivery_address, po.payment_terms, po.notes, po.iva_rate, po.subtotal, po.iva, po.total, po.created_by, po.sent_at, po.created_at, u.name AS created_by_name`;
export const PO_SELECT = `SELECT ${PO_COLS} FROM purchase_orders po LEFT JOIN users u ON u.id = po.created_by`;

function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Agrega al menos un ítem');
  return items.map((it, i) => {
    const qty = Math.round(Number(it.qty));
    const cost = Math.round(Number(it.cost ?? it.unit_cost));
    if (!Number.isFinite(qty) || qty < 1) throw new HttpError(400, `Ítem ${i + 1}: cantidad inválida`);
    if (!Number.isFinite(cost) || cost < 0) throw new HttpError(400, `Ítem ${i + 1}: costo inválido`);
    const description = str(it.description);
    if (!description && !str(it.sku)) throw new HttpError(400, `Ítem ${i + 1}: falta la descripción`);
    return { product_id: Number(it.product_id) || null, sku: str(it.sku), description, qty, cost, line: qty * cost };
  });
}
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : null);

async function saveItems(t, poId, items) {
  await t.query('DELETE FROM purchase_order_items WHERE po_id=$1', [poId]);
  let pos = 0;
  for (const it of items) {
    await t.query('INSERT INTO purchase_order_items(po_id, position, product_id, sku, description, qty, unit_cost, line_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [poId, pos++, it.product_id, it.sku, it.description, it.qty, it.cost, it.line]);
  }
}

/** Crea la OC con el siguiente correlativo (parte en 65) o, con `id`, reemplaza sus datos e ítems manteniendo el número. */
export async function savePurchaseOrder(b, userId, id = null) {
  const items = cleanItems(b.items);
  const sup = (await query('SELECT * FROM suppliers WHERE id=$1', [Number(b.supplier_id)])).rows[0];
  if (!sup) throw new HttpError(400, 'Selecciona un proveedor');
  const settings = await getSettings();
  const rate = Number(settings.iva_rate) || 19;
  const subtotal = items.reduce((a, i) => a + i.line, 0);
  const iva = Math.round((subtotal * rate) / 100);
  const total = subtotal + iva;
  const f = { delivery_date: dateOrNull(b.delivery_date), delivery_address: str(b.delivery_address), payment_terms: str(b.payment_terms) || sup.payment_terms, notes: str(b.notes) };
  return tx(async (t) => {
    if (id) {
      const cur = (await t.query('SELECT status FROM purchase_orders WHERE id=$1', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'Orden de compra no encontrada');
      if (cur.status === 'Anulada') throw new HttpError(400, 'Una orden anulada no se puede modificar');
      await t.query(
        `UPDATE purchase_orders SET supplier_id=$1, rut=$2, razon_social=$3, email=$4, contact=$5, phone=$6, delivery_date=$7, delivery_address=$8, payment_terms=$9, notes=$10,
           iva_rate=$11, subtotal=$12, iva=$13, total=$14, updated_at=now() WHERE id=$15`,
        [sup.id, sup.rut, sup.razon_social, sup.email, sup.contact, sup.phone, f.delivery_date, f.delivery_address, f.payment_terms, f.notes, rate, subtotal, iva, total, id]);
      await saveItems(t, id, items);
      return { id, subtotal, iva, total };
    }
    const n = await t.query("UPDATE settings SET value = (value::int + 1)::text WHERE key='po_next_number' RETURNING (value::int - 1) AS number");
    const number = n.rows[0].number;
    const r = await t.query(
      `INSERT INTO purchase_orders(number, po_date, supplier_id, rut, razon_social, email, contact, phone, delivery_date, delivery_address, payment_terms, notes, iva_rate, subtotal, iva, total, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [number, today(), sup.id, sup.rut, sup.razon_social, sup.email, sup.contact, sup.phone, f.delivery_date, f.delivery_address, f.payment_terms, f.notes, rate, subtotal, iva, total, userId]);
    await saveItems(t, r.rows[0].id, items);
    return { id: r.rows[0].id, number, subtotal, iva, total };
  });
}

export async function purchaseOrderPdf(id) {
  const po = (await query(`${PO_SELECT} WHERE po.id=$1`, [id])).rows[0];
  if (!po) throw new HttpError(404, 'Orden de compra no encontrada');
  const items = (await query('SELECT sku, description, qty, unit_cost, line_total FROM purchase_order_items WHERE po_id=$1 ORDER BY position', [id])).rows;
  return { number: po.number, po, buffer: await renderPurchaseOrderPdf(po, items, await getSettings()) };
}
