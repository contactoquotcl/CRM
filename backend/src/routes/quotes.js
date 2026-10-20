import { Router } from 'express';
import { query, tx, getSettings } from '../db.js';
import { authenticate } from '../auth.js';
import { HttpError, formatRut, parseMoney, validRut, today, clp } from '../util.js';
import { renderQuotePdf } from '../pdf.js';

export const quotesRouter = Router();
quotesRouter.use(authenticate);

const QUOTE_SELECT = `SELECT id, number, lead_id, quote_date::text AS quote_date, validity_days, rut, razon_social, email, contact, phone,
  notes, iva_rate, subtotal, iva, total, created_by, created_at FROM quotes`;

quotesRouter.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const params = [];
  let where = '';
  if (q) {
    params.push(`%${q}%`);
    where = `WHERE LOWER(razon_social) LIKE $1 OR LOWER(rut) LIKE $1 OR CAST(number AS TEXT) LIKE $1 OR LOWER(contact) LIKE $1`;
  }
  const { rows } = await query(`${QUOTE_SELECT} ${where} ORDER BY number DESC LIMIT 500`, params);
  res.json(rows);
});

quotesRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`${QUOTE_SELECT} WHERE id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Cotización no encontrada');
  const items = await query('SELECT id, position, product_id, sku, description, qty, unit_price, line_total FROM quote_items WHERE quote_id=$1 ORDER BY position', [id]);
  res.json({ ...rows[0], items: items.rows });
});

quotesRouter.get('/:id/pdf', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`${QUOTE_SELECT} WHERE id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Cotización no encontrada');
  const items = await query('SELECT sku, description, qty, unit_price, line_total FROM quote_items WHERE quote_id=$1 ORDER BY position', [id]);
  const pdf = await renderQuotePdf(rows[0], items.rows, await getSettings());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Cotizacion-${rows[0].number}.pdf"`);
  res.send(pdf);
});

/**
 * Crea la cotización con el siguiente correlativo y registra el lead en estado inicial ("Cotizado").
 * Body: { client:{rut,razon_social,email,contact,phone}, items:[{product_id?,sku,description,qty,unit_price}],
 *         validity_days?, notes?, lead_id? (re-cotizar un lead existente) }
 */
quotesRouter.post('/', async (req, res) => {
  const b = req.body || {};
  const c = b.client || {};
  const client = {
    rut: String(c.rut || '').trim(),
    razon_social: String(c.razon_social || '').trim(),
    email: String(c.email || '').trim(),
    contact: String(c.contact || '').trim(),
    phone: String(c.phone || '').trim(),
  };
  if (!client.rut || !validRut(client.rut)) throw new HttpError(400, 'RUT inválido (revisa el dígito verificador)');
  client.rut = formatRut(client.rut);
  if (!client.razon_social) throw new HttpError(400, 'La razón social es obligatoria');
  if (!/^\S+@\S+\.\S+$/.test(client.email)) throw new HttpError(400, 'Correo inválido');
  if (!client.contact) throw new HttpError(400, 'El contacto es obligatorio');
  if (!client.phone) throw new HttpError(400, 'El teléfono es obligatorio');

  const rawItems = Array.isArray(b.items) ? b.items : [];
  const items = rawItems
    .map((it, i) => {
      const qty = parseInt(it.qty, 10);
      const unit = parseMoney(it.unit_price);
      return {
        position: i,
        product_id: it.product_id ? Number(it.product_id) : null,
        sku: String(it.sku || '').trim(),
        description: String(it.description || '').trim(),
        qty,
        unit_price: unit,
        line_total: qty * unit,
      };
    })
    .filter((it) => it.description || it.sku);
  if (!items.length) throw new HttpError(400, 'Agrega al menos un ítem');
  for (const it of items) {
    if (!it.description) throw new HttpError(400, `El ítem ${it.sku} necesita descripción`);
    if (!Number.isInteger(it.qty) || it.qty < 1) throw new HttpError(400, `Cantidad inválida en "${it.description}"`);
    if (it.unit_price < 0) throw new HttpError(400, `Precio inválido en "${it.description}"`);
  }

  const created = await tx(async (t) => {
    const s = await getSettings(t.query);
    const ivaRate = parseInt(s.iva_rate, 10);
    const rate = Number.isFinite(ivaRate) ? ivaRate : 19;
    const validity = parseInt(b.validity_days, 10) > 0 ? parseInt(b.validity_days, 10) : parseInt(s.quote_validity_days, 10) || 15;

    // Correlativo atómico: lee y avanza el contador en una sola sentencia.
    const num = await t.query(`UPDATE settings SET value = (value::int + 1)::text WHERE key='quote_next_number' RETURNING (value::int - 1) AS number`);
    const number = num.rows[0].number;

    const subtotal = items.reduce((a, it) => a + it.line_total, 0);
    const iva = Math.round((subtotal * rate) / 100);
    const total = subtotal + iva;

    // Lead: existente (re-cotización) o nuevo en el estado inicial.
    let leadId = b.lead_id ? Number(b.lead_id) : null;
    const productsText = items.map((it) => `${it.qty}x ${it.description}`).join('; ');
    if (leadId) {
      const ex = await t.query('SELECT id FROM leads WHERE id=$1', [leadId]);
      if (!ex.rows[0]) throw new HttpError(404, 'El lead indicado no existe');
    }
    const st = await t.query('SELECT id FROM pipeline_states WHERE is_initial LIMIT 1');
    const initialState = st.rows[0]?.id ?? null;
    if (leadId) {
      await t.query(
        `UPDATE leads SET client_name=$1, rut=$2, razon_social=$3, email=$4, contact=$5, phone=$6, quote_number=$7,
           products_text=$8, subtotal=$9, iva=$10, total=$11, state_id=$12, state_date=$13, updated_at=now() WHERE id=$14`,
        [client.razon_social, client.rut, client.razon_social, client.email, client.contact, client.phone, number, productsText, subtotal, iva, total, initialState, today(), leadId]
      );
    } else {
      const ins = await t.query(
        `INSERT INTO leads(client_name, rut, razon_social, email, contact, phone, channel, state_id, state_date, lead_date, quote_number,
           products_text, subtotal, iva, total, created_by)
         VALUES($1,$2,$3,$4,$5,$6,'Cotizador',$7,$8,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [client.razon_social, client.rut, client.razon_social, client.email, client.contact, client.phone, initialState, today(), number, productsText, subtotal, iva, total, req.user.id]
      );
      leadId = ins.rows[0].id;
    }

    const q = await t.query(
      `INSERT INTO quotes(number, lead_id, quote_date, validity_days, rut, razon_social, email, contact, phone, notes, iva_rate, subtotal, iva, total, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [number, leadId, today(), validity, client.rut, client.razon_social, client.email, client.contact, client.phone, String(b.notes || '').trim(), rate, subtotal, iva, total, req.user.id]
    );
    for (const it of items) {
      await t.query(
        'INSERT INTO quote_items(quote_id, position, product_id, sku, description, qty, unit_price, line_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [q.rows[0].id, it.position, it.product_id, it.sku, it.description, it.qty, it.unit_price, it.line_total]
      );
    }
    return { id: q.rows[0].id, number, lead_id: leadId, subtotal, iva, total };
  });

  res.status(201).json({ ...created, total_formatted: clp(created.total) });
});
