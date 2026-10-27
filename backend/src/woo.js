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
