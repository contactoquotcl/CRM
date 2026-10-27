import { tx, getSettings } from './db.js';
import { HttpError, formatRut, parseMoney, validRut, today, clp, priceFromCost, validMargin } from './util.js';

/**
 * Motor único de cotizaciones (lo usan el cotizador del CRM y el chatbot).
 * input: { client:{rut,razon_social,email,contact,phone}, margin (% global, obligatorio),
 *          items:[{product_id?,sku,description,qty,cost,margin? , unit_price? (solo bot: precio de venta fijado)}],
 *          validity_days?, notes?, lead_id? }
 * opts:  { userId, channel='Cotizador', conversationId? }
 * Precio unitario = costo / (1 - margen), salvo que el ítem traiga unit_price (entonces el margen del ítem se
 * deriva de costo y precio). Costo y margen son internos: nunca salen en el PDF.
 */
export async function createQuote(b, { userId, channel = 'Cotizador', conversationId = null } = {}) {
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

  const globalMargin = typeof b.margin === 'string' && b.margin.trim() !== '' ? Number(b.margin.replace(',', '.')) : b.margin;
  if (!validMargin(globalMargin)) throw new HttpError(400, 'Indica el margen de la cotización (un número entre 0 y 99,99 %)');

  const rawItems = Array.isArray(b.items) ? b.items : [];
  const items = rawItems
    .map((it, i) => {
      const qty = parseInt(it.qty, 10);
      const cost = parseMoney(it.cost);
      const fixed = it.unit_price !== undefined && it.unit_price !== null ? Math.round(Number(it.unit_price)) : null;
      const hasOwn = it.margin !== undefined && it.margin !== null && String(it.margin).trim() !== '';
      let margin = hasOwn ? Number(String(it.margin).replace(',', '.')) : globalMargin;
      if (fixed !== null) margin = fixed > 0 && cost <= fixed ? Math.round((1 - cost / fixed) * 10000) / 100 : 0;
      return { position: i, product_id: it.product_id ? Number(it.product_id) : null, sku: String(it.sku || '').trim(), description: String(it.description || '').trim(), qty, cost, margin, fixed };
    })
    .filter((it) => it.description || it.sku);
  if (!items.length) throw new HttpError(400, 'Agrega al menos un ítem');
  for (const it of items) {
    if (!it.description) throw new HttpError(400, `El ítem ${it.sku} necesita descripción`);
    if (!Number.isInteger(it.qty) || it.qty < 1) throw new HttpError(400, `Cantidad inválida en "${it.description}"`);
    if (it.cost < 0) throw new HttpError(400, `Costo inválido en "${it.description}"`);
    if (it.fixed !== null && !(it.fixed >= 0)) throw new HttpError(400, `Precio inválido en "${it.description}"`);
    if (!validMargin(it.margin)) throw new HttpError(400, `Margen inválido en "${it.description}" (debe estar entre 0 y 99,99 %)`);
    it.unit_price = it.fixed !== null ? it.fixed : priceFromCost(it.cost, it.margin);
    it.line_total = it.qty * it.unit_price;
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
           products_text=$8, subtotal=$9, iva=$10, total=$11, state_id=$12, state_date=$13, sort_order=0, updated_at=now() WHERE id=$14`,
        [client.razon_social, client.rut, client.razon_social, client.email, client.contact, client.phone, number, productsText, subtotal, iva, total, initialState, today(), leadId]
      );
    } else {
      const ins = await t.query(
        `INSERT INTO leads(client_name, rut, razon_social, email, contact, phone, channel, state_id, state_date, lead_date, quote_number,
           products_text, subtotal, iva, total, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$15,$7,$8,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [client.razon_social, client.rut, client.razon_social, client.email, client.contact, client.phone, initialState, today(), number, productsText, subtotal, iva, total, userId, channel]
      );
      leadId = ins.rows[0].id;
    }

    const q = await t.query(
      `INSERT INTO quotes(number, lead_id, quote_date, validity_days, rut, razon_social, email, contact, phone, notes, iva_rate, margin_pct, subtotal, iva, total, created_by, channel, conversation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [number, leadId, today(), validity, client.rut, client.razon_social, client.email, client.contact, client.phone, String(b.notes || '').trim(), rate, globalMargin, subtotal, iva, total, userId, channel, conversationId]
    );
    for (const it of items) {
      await t.query(
        'INSERT INTO quote_items(quote_id, position, product_id, sku, description, qty, cost, margin_pct, unit_price, line_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [q.rows[0].id, it.position, it.product_id, it.sku, it.description, it.qty, it.cost, it.margin, it.unit_price, it.line_total]
      );
    }
    return { id: q.rows[0].id, number, lead_id: leadId, subtotal, iva, total, validity_days: validity };
  });
  return { ...created, total_formatted: clp(created.total) };
}

/** PDF de una cotización (solo datos de venta: nunca costo ni margen). Devuelve null si no existe. */
export async function quotePdfBuffer(id) {
  const { query } = await import('./db.js');
  const { renderQuotePdf } = await import('./pdf.js');
  const { rows } = await query(
    `SELECT q.id, q.number, q.lead_id, q.quote_date::text AS quote_date, q.validity_days, q.rut, q.razon_social, q.email, q.contact, q.phone,
       q.notes, q.iva_rate, q.subtotal, q.iva, q.total FROM quotes q WHERE q.id=$1`, [Number(id)]);
  if (!rows[0]) return null;
  const items = await query('SELECT sku, description, qty, unit_price, line_total FROM quote_items WHERE quote_id=$1 ORDER BY position', [rows[0].id]);
  return { number: rows[0].number, buffer: await renderQuotePdf(rows[0], items.rows, await getSettings()) };
}
