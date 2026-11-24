import crypto from 'node:crypto';
import { wcConfig } from './config.js';

export const wcEnabled = () => {
  const c = wcConfig();
  return !!(c.baseUrl && c.key && c.secret);
};

async function wcGet(path, params = {}) {
  const c = wcConfig();
  if (!wcEnabled()) throw new Error('WooCommerce no está configurado (WC_BASE_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET)');
  const url = new URL(`${c.baseUrl}/wp-json/wc/v3${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${c.key}:${c.secret}`).toString('base64'), Accept: 'application/json' },
    signal: AbortSignal.timeout(c.timeoutMs),
  });
  if (!res.ok) throw new Error(`WooCommerce respondió ${res.status} en ${path}`);
  return { data: await res.json(), totalPages: Number(res.headers.get('x-wp-totalpages') || 1) };
}

/** Recorre todo el catálogo publicado; llama onPage(productos) por cada página. */
export async function wcListAll(onPage) {
  let page = 1;
  let totalPages = 1;
  do {
    const r = await wcGet('/products', { per_page: 100, page, status: 'publish' });
    totalPages = r.totalPages;
    await onPage(r.data);
    page++;
  } while (page <= totalPages && page <= 200);
}

export const wcGetProduct = async (id) => (await wcGet(`/products/${Number(id)}`)).data;

export async function wcFindBySku(sku) {
  const { data } = await wcGet('/products', { sku: String(sku), status: 'publish' });
  return data[0] || null;
}

export const wcVariations = async (id) => (await wcGet(`/products/${Number(id)}/variations`, { per_page: 50 })).data;

/** Firma de webhooks de WooCommerce: base64(HMAC-SHA256(cuerpo crudo, secreto)). */
export function wcSignatureProblem(rawBody, signature) {
  const secret = wcConfig().webhookSecret;
  if (!secret) return 'sin_secreto_en_el_crm';
  if (!signature) return 'sin_firma_en_la_peticion';
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(String(signature), 'base64');
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return null;
  return 'firma_no_coincide';
}
export const verifyWcSignature = (rawBody, signature) => wcSignatureProblem(rawBody, signature) === null;

/** Prueba de conexión: pide 1 producto con las credenciales actuales. */
export async function wcPing() {
  const r = await wcGet('/products', { per_page: 1, status: 'publish' });
  return { products_visible: Array.isArray(r.data) ? r.data.length : 0 };
}

/** Pedidos recientes de un cliente (por correo de facturación). Requiere permiso de lectura de pedidos en la clave. */
export async function wcOrdersByEmail(email) {
  const r = await wcGet('/orders', { search: email, per_page: 20, orderby: 'date', order: 'desc' });
  const e = String(email).toLowerCase();
  return (r.data || [])
    .filter((o) => String(o.billing?.email || '').toLowerCase() === e)
    .slice(0, 10)
    .map((o) => ({ id: o.id, number: o.number, status: o.status, total: Number(o.total) || 0, currency: o.currency, date: o.date_created, items: (o.line_items || []).map((i) => `${i.quantity}x ${i.name}`).join('; ').slice(0, 300) }));
}

const ORDER_STATUS = {
  pending: 'Pendiente de pago',
  processing: 'En preparación (pago recibido)',
  'on-hold': 'En espera (pago por confirmar)',
  completed: 'Completado',
  cancelled: 'Cancelado',
  refunded: 'Reembolsado',
  failed: 'Pago fallido',
};
const noHtml = (t) => String(t || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Estado de un pedido para el bot. Solo se entrega si el correo de facturación coincide con el informado;
 * si no coincide (o no existe) devuelve null sin distinguir los casos. Nunca expone dirección, teléfono ni RUT.
 */
export async function wcOrderStatus(number, email) {
  const n = String(number || '').replace(/\D/g, '');
  const mail = String(email || '').trim().toLowerCase();
  if (!n || !mail) return null;
  let o = null;
  try { o = (await wcGet(`/orders/${n}`)).data; } catch (e) { if (!/ 404 /.test(e.message)) throw e; }
  if (!o || !o.id) {
    const r = await wcGet('/orders', { search: n, per_page: 10 });
    o = (Array.isArray(r.data) ? r.data : []).find((x) => String(x.number) === n || String(x.id) === n) || null;
  }
  if (!o || o.status === 'checkout-draft') return null;
  if (String(o.number ?? o.id) !== n && String(o.id) !== n) return null;
  if (String(o.billing?.email || '').trim().toLowerCase() !== mail) return null;

  let notas = [];
  try {
    const r = await wcGet(`/orders/${o.id}/notes`, { type: 'customer' });
    notas = (Array.isArray(r.data) ? r.data : []).filter((x) => x.customer_note).slice(0, 3).map((x) => ({ fecha: String(x.date_created || '').slice(0, 10), texto: noHtml(x.note).slice(0, 300) }));
  } catch { /* sin permiso o sin notas: se ignora */ }
  const seguimiento = [];
  for (const m of o.meta_data || []) {
    if (/tracking/i.test(m.key) && Array.isArray(m.value)) {
      for (const t of m.value.slice(0, 3)) if (t?.tracking_number) seguimiento.push({ empresa: String(t.tracking_provider || t.custom_tracking_provider || '').slice(0, 60), numero: String(t.tracking_number).slice(0, 60) });
    }
  }
  return {
    numero: String(o.number ?? o.id),
    estado: ORDER_STATUS[o.status] || o.status,
    estado_codigo: o.status,
    fecha: String(o.date_created || '').slice(0, 10),
    ultima_actualizacion: String(o.date_modified || '').slice(0, 10),
    total: Math.round(Number(o.total) || 0),
    moneda: o.currency || 'CLP',
    productos: (o.line_items || []).slice(0, 20).map((i) => ({ nombre: String(i.name || '').slice(0, 120), cantidad: i.quantity })),
    envio: (o.shipping_lines || []).map((l) => l.method_title).filter(Boolean).join(', ').slice(0, 100),
    pago: String(o.payment_method_title || '').slice(0, 60),
    seguimiento,
    notas_para_el_cliente: notas,
  };
}
