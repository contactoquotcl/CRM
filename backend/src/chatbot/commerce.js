import crypto from 'node:crypto';
import { query, getSettings } from '../db.js';
import { botConfig, wcConfig, apiPublicUrl, chatbotTokenSecret } from '../config.js';
import { wcEnabled, wcGetProduct, wcFindBySku } from '../woo.js';
import { wcToRow, priceInfo } from '../catalog.js';
import { createQuote } from '../quoteService.js';
import { ensureConversation, getBotUserId } from '../inbox.js';
import { clp, priceFromCost } from '../util.js';

const fail = (error) => ({ ok: false, error });

/** Consulta EN VIVO cada ítem pedido y valida stock y límites. Devuelve { lines } o { error }. */
export async function resolveLines(items) {
  const cfg = botConfig();
  if (!wcEnabled()) return fail('No puedo consultar la tienda en este momento. No des precios; ofrece derivar a un ejecutivo.');
  if (!items.length) return fail('Indica al menos un producto');
  if (items.length > cfg.maxCartLines) return fail(`Máximo ${cfg.maxCartLines} productos distintos por carrito; deriva a un ejecutivo para pedidos más grandes`);
  const seen = new Set();
  const lines = [];
  for (const it of items) {
    const key = it.sku ? `s:${it.sku.toLowerCase()}` : `i:${it.id}`;
    if (seen.has(key)) return fail(`El producto ${it.sku || it.id} está repetido; indícalo una sola vez con la cantidad total`);
    seen.add(key);
    if (!Number.isInteger(it.cantidad) || it.cantidad < 1 || it.cantidad > cfg.maxLineQty) return fail(`Cantidad inválida para ${it.sku || it.id} (entre 1 y ${cfg.maxLineQty}); para volúmenes mayores deriva a un ejecutivo`);
    let p = null;
    try {
      let wcId = it.id;
      if (!wcId && it.sku) wcId = (await query('SELECT wc_id FROM catalog_products WHERE lower(sku)=lower($1) LIMIT 1', [it.sku])).rows[0]?.wc_id;
      p = wcId ? await wcGetProduct(wcId) : await wcFindBySku(it.sku);
    } catch {
      return fail('La tienda no respondió. No des precios; ofrece derivar a un ejecutivo.');
    }
    if (!p || (p.status && p.status !== 'publish')) return fail(`No encontré el producto ${it.sku || it.id} en la tienda`);
    if (p.type !== 'simple') return fail(`${p.name} tiene variantes u opciones: no puedo armarlo automáticamente; deriva a un ejecutivo`);
    const row = wcToRow(p);
    if (!(row.price > 0)) return fail(`${row.name} no tiene precio publicado: deriva a un ejecutivo`);
    if (row.stock_status === 'outofstock') return fail(`${row.name} está sin stock`);
    if (row.stock_quantity !== null && row.stock_quantity < it.cantidad && row.stock_status !== 'onbackorder') return fail(`De ${row.name} solo quedan ${row.stock_quantity} unidades`);
    const pr = priceInfo(row.price);
    lines.push({ wc_id: row.wc_id, sku: row.sku, nombre: row.name, cantidad: it.cantidad, unit_net: pr.precio_neto, unit_gross: pr.precio_con_iva, link: row.permalink });
  }
  const subtotal = lines.reduce((a, l) => a + l.unit_net * l.cantidad, 0);
  if (cfg.minOrderClp && subtotal < cfg.minOrderClp) return fail(`La compra mínima es de ${clp(cfg.minOrderClp)} neto; el pedido suma ${clp(subtotal)}. Informa al cliente o deriva a un ejecutivo`);
  if (subtotal > cfg.maxCartClp) return fail('El monto supera lo que puedo gestionar por chat: deriva a un ejecutivo');
  return { ok: true, lines, subtotal };
}

const iva = (net) => Math.round(net * 0.19);
const lineOut = (l) => ({ sku: l.sku, nombre: l.nombre, cantidad: l.cantidad, precio_neto_unitario: l.unit_net, precio_con_iva_unitario: l.unit_gross, subtotal_neto: l.unit_net * l.cantidad, link: l.link });

/** Link(s) de checkout de WooCommerce. 1 producto: nativo. Varios: plugin de Quot (?quot_cart) o un link por producto. */
export async function checkoutLinks(lines) {
  const base = wcConfig().baseUrl;
  const s = await getSettings();
  if (lines.length === 1) return { link_checkout: `${base}/checkout/?add-to-cart=${lines[0].wc_id}&quantity=${lines[0].cantidad}` };
  if (s.woo_cart_plugin === '1') return { link_checkout: `${base}/?quot_cart=${lines.map((l) => `${l.wc_id}:${l.cantidad}`).join(',')}` };
  return { links_por_producto: lines.map((l) => ({ sku: l.sku, nombre: l.nombre, link_agregar: `${base}/?add-to-cart=${l.wc_id}&quantity=${l.cantidad}` })), nota_links: 'Cada enlace agrega ese producto al carrito de la tienda; el cliente debe abrirlos uno a uno y luego pagar en el checkout.' };
}

export async function armarCarrito(args, ctx) {
  const r = await resolveLines(args.items);
  if (!r.ok) return r;
  const conv = await ensureConversation(ctx.session);
  await query("UPDATE carts SET status='replaced' WHERE session_id=$1 AND status='active'", [ctx.session.id]);
  const saved = await query('INSERT INTO carts(session_id, conversation_id, items, subtotal) VALUES($1,$2,$3,$4) RETURNING id', [ctx.session.id, conv?.id ?? null, JSON.stringify(r.lines), r.subtotal]);
  return {
    ok: true,
    carrito: saved.rows[0].id,
    lineas: r.lines.map(lineOut),
    subtotal_neto: r.subtotal,
    iva_clp: iva(r.subtotal),
    total_con_iva: r.subtotal + iva(r.subtotal),
    ...(await checkoutLinks(r.lines)),
    nota: 'Valores calculados por el sistema. El checkout de la tienda muestra el total final con despacho. Si el cliente prefiere una cotización formal (por transferencia), usa generar_cotizacion.',
  };
}

// Enlace corto al PDF: id + firma HMAC (no adivinable, fácil de copiar para el modelo; sin datos personales en la URL).
const pdfSig = (quoteId) => crypto.createHmac('sha256', chatbotTokenSecret()).update(`qpdf:${quoteId}`).digest('base64url').slice(0, 22);
export const pdfLinkParams = (quoteId) => `q=${quoteId}&s=${pdfSig(quoteId)}`;
export const verifyPdfSig = (quoteId, sig) => {
  const a = Buffer.from(pdfSig(Number(quoteId)));
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export async function generarCotizacion(args, ctx) {
  const cfg = botConfig();
  const c = args.cliente;
  const missing = [['rut', 'RUT de la empresa'], ['razon_social', 'razón social'], ['nombre', 'nombre de contacto'], ['correo', 'correo'], ['telefono', 'teléfono']].filter(([k]) => !c[k]).map(([, l]) => l);
  if (missing.length) return fail(`Antes de cotizar falta pedir al cliente: ${missing.join(', ')}. Pídelos en un solo mensaje.`);
  const done = (await query("SELECT COUNT(*)::int AS n FROM carts WHERE session_id=$1 AND status='quoted'", [ctx.session.id])).rows[0].n;
  if (done >= cfg.maxQuotesPerSession) return fail('Ya se generaron varias cotizaciones en esta conversación; deriva a un ejecutivo.');

  const r = await resolveLines(args.items);
  if (!r.ok) return r;
  const s = await getSettings();
  const margin = Number(String(s.bot_default_margin).replace(',', '.'));
  const m = Number.isFinite(margin) && margin >= 0 && margin < 100 ? margin : 25;
  const source = s.bot_price_source === 'margen' ? 'margen' : 'woocommerce';

  const items = [];
  for (const l of r.lines) {
    const master = (await query('SELECT id, price FROM products WHERE lower(sku)=lower($1) LIMIT 1', [l.sku])).rows[0];
    const hasCost = master && master.price > 0;
    const cost = hasCost ? master.price : Math.round(l.unit_net * (1 - m / 100)); // sin costo en la maestra: se estima con el margen por defecto
    const desc = l.nombre;
    items.push({ product_id: master?.id ?? null, sku: l.sku, description: desc, qty: l.cantidad, cost, ...(source === 'margen' && hasCost ? { margin: m } : { unit_price: l.unit_net }) });
  }
  const conv = await ensureConversation(ctx.session);
  const notes = [`Cotización generada por el asistente virtual de Quot.`, `Despacho: ${cfg.shippingText}.`, args.notas || ''].filter(Boolean).join('\n');
  // Reutiliza el lead de esta conversación (p. ej. el que dejó una derivación) o el último con el mismo RUT
  let leadId = conv?.lead_id || null;
  if (!leadId) leadId = (await query('SELECT id FROM leads WHERE rut=$1 ORDER BY id DESC LIMIT 1', [c.rut])).rows[0]?.id ?? null;
  const botId = await getBotUserId();
  const q = await createQuote(
    { client: { rut: c.rut, razon_social: c.razon_social, email: c.correo, contact: c.nombre, phone: c.telefono }, margin: m, items, validity_days: cfg.validityDays, notes, lead_id: leadId },
    { userId: botId, channel: 'Chatbot', conversationId: conv?.id ?? null }
  );
  await query('UPDATE conversations SET lead_id=$2 WHERE id=$1', [conv.id, q.lead_id]);
  await query("UPDATE carts SET status='replaced' WHERE session_id=$1 AND status='active'", [ctx.session.id]);
  await query("INSERT INTO carts(session_id, conversation_id, items, subtotal, status, quote_id) VALUES($1,$2,$3,$4,'quoted',$5)", [ctx.session.id, conv.id, JSON.stringify(r.lines), r.subtotal, q.id]);
  await ctx.saveContact({ customer_company: c.razon_social, customer_name: c.nombre, customer_email: c.correo, customer_phone: c.telefono, customer_rut: c.rut });

  const base = apiPublicUrl();
  const out = {
    ok: true,
    numero_cotizacion: q.number,
    validez_dias: q.validity_days,
    lineas: r.lines.map(lineOut),
    subtotal_neto: q.subtotal,
    iva_clp: q.iva,
    total_con_iva: q.total,
    despacho: cfg.shippingText,
    ...(base ? { link_pdf: `${base}/api/chatbot/quote-pdf?${pdfLinkParams(q.id)}` } : { nota_pdf: 'El PDF queda disponible para el ejecutivo; el cliente lo recibirá de él.' }),
    pago: 'El PDF incluye los datos para pagar por transferencia.',
  };
  // Monto sobre el umbral: se genera igual, pero se deriva a un ejecutivo para el seguimiento
  const threshold = Number(s.bot_quote_handoff_clp) || 0;
  if (threshold > 0 && q.total >= threshold) {
    await ctx.handoff({ motivo: 'cotizacion', resumen: `Cotización N° ${q.number} por ${clp(q.total)} con IVA (sobre el umbral de ${clp(threshold)}). Requiere seguimiento comercial.` });
    out.derivado = true;
    out.instruccion = 'Entrega los datos de la cotización e informa que, por el monto, un ejecutivo de Quot la revisará con el cliente y le responderá por este mismo chat.';
  }
  return out;
}
