import { query } from './db.js';
import { wcConfig } from './config.js';
import { wcEnabled, wcListAll } from './woo.js';

// ---------- Normalización y sinónimos (búsqueda full-text en español, sin extensiones) ----------
export const norm = (s = '') =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s.x-]/g, ' ').replace(/\s+/g, ' ').trim();

export const stripHtml = (s = '') =>
  String(s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// Cada fila es un grupo de términos equivalentes (ya normalizados).
const SYNONYMS = [
  ['etiqueta', 'etiquetas', 'label', 'labels', 'rotulo'],
  ['termica', 'termico', 'thermal', 'transferencia'],
  ['impresora', 'impresoras', 'printer', 'printers'],
  ['lector', 'lectores', 'escaner', 'scanner', 'pistola', 'barcode'],
  ['codigo', 'codigos', 'barra', 'barras'],
  ['stretch', 'film', 'strech', 'embalaje', 'envoltorio'],
  ['cinta', 'ribbon', 'cintas'],
  ['pos', 'punto', 'venta', 'caja'],
  ['inalambrico', 'wireless', 'bluetooth'],
  ['movil', 'mobile', 'handheld', 'terminal', 'pda'],
  ['zebra', 'zbr'],
];
const SYN_INDEX = new Map();
for (const g of SYNONYMS) for (const t of g) SYN_INDEX.set(t, g);
const STOP = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'para', 'por', 'con', 'que', 'y', 'o', 'en', 'a', 'quiero', 'busco', 'necesito', 'tienen', 'hay', 'me', 'mi', 'cotizar', 'precio', 'valor', 'cuanto', 'cuesta']);

export function buildSearchText(p) {
  return norm([p.name, p.sku, p.categories, p.attributes, p.short_description, p.description].filter(Boolean).join(' ')).slice(0, 20000);
}

/** Convierte una consulta libre en { and, or } para to_tsquery('spanish', ...). Solo [a-z0-9] (sin sintaxis inyectable). */
export function buildTsQueries(q) {
  const tokens = norm(q).split(' ').map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 2 && !STOP.has(t)).slice(0, 8);
  if (!tokens.length) return null;
  const groups = tokens.map((t) => [...new Set(SYN_INDEX.get(t) || [t])].map((x) => x.replace(/[^a-z0-9]/g, '')).filter(Boolean));
  const grp = (g) => '(' + g.join(' | ') + ')';
  return { and: groups.map(grp).join(' & '), or: groups.map(grp).join(' | '), tokens };
}

// ---------- Mapeo WooCommerce → fila local ----------
const toInt = (v) => {
  const n = Math.round(Number(String(v ?? '').replace(',', '.')));
  return Number.isFinite(n) ? n : 0;
};

export function wcToRow(p) {
  const row = {
    wc_id: Number(p.id),
    sku: String(p.sku || '').trim(),
    name: stripHtml(p.name || '(sin nombre)'),
    short_description: stripHtml(p.short_description || '').slice(0, 1500),
    description: stripHtml(p.description || '').slice(0, 6000),
    price: toInt(p.price),
    regular_price: toInt(p.regular_price || p.price),
    stock_status: String(p.stock_status || 'instock'),
    stock_quantity: p.stock_quantity === null || p.stock_quantity === undefined ? null : toInt(p.stock_quantity),
    permalink: String(p.permalink || ''),
    image: String(p.images?.[0]?.src || ''),
    categories: (p.categories || []).map((c) => stripHtml(c.name)).join(' > '),
    attributes: (p.attributes || []).map((a) => `${stripHtml(a.name)}: ${(a.options || []).map(stripHtml).join(', ')}`).join('; '),
    product_type: String(p.type || 'simple'),
  };
  row.search_text = buildSearchText(row);
  return row;
}

const COLS = ['wc_id', 'sku', 'name', 'short_description', 'description', 'price', 'regular_price', 'stock_status', 'stock_quantity', 'permalink', 'image', 'categories', 'attributes', 'product_type', 'search_text'];

export async function upsertProduct(wcProduct, q = query) {
  const status = wcProduct.status || 'publish';
  if (status !== 'publish') return deleteByWcId(wcProduct.id, q); // borradores/privados no se ofrecen al cliente
  const r = wcToRow(wcProduct);
  await q(
    `INSERT INTO catalog_products(${COLS.join(',')}, synced_at) VALUES(${COLS.map((_, i) => `$${i + 1}`).join(',')}, now())
     ON CONFLICT (wc_id) DO UPDATE SET ${COLS.filter((c) => c !== 'wc_id').map((c) => `${c}=EXCLUDED.${c}`).join(', ')}, synced_at=now()`,
    COLS.map((c) => r[c])
  );
  return r;
}

export async function deleteByWcId(id, q = query) {
  await q('DELETE FROM catalog_products WHERE wc_id=$1', [Number(id)]);
}

// ---------- Sincronización completa (carga inicial y reconciliación diaria) ----------
let running = null;

export async function syncAll({ reason = 'manual' } = {}) {
  if (running) return running;
  running = (async () => {
    const started = new Date().toISOString();
    const seen = [];
    try {
      await wcListAll(async (page) => {
        for (const p of page) {
          await upsertProduct(p);
          if ((p.status || 'publish') === 'publish') seen.push(Number(p.id));
        }
      });
      // Reconciliación: lo que ya no existe (o no está publicado) en WooCommerce sale del catálogo local.
      let removed = 0;
      if (seen.length) {
        const r = await query('DELETE FROM catalog_products WHERE wc_id IS NOT NULL AND NOT (wc_id = ANY($1::int[]))', [seen]);
        removed = r.rowCount ?? 0;
      }
      const result = { at: started, reason, ok: true, count: seen.length, removed };
      await saveStatus(result);
      return result;
    } catch (e) {
      const result = { at: started, reason, ok: false, error: e.message };
      await saveStatus(result);
      throw e;
    } finally {
      running = null;
    }
  })();
  return running;
}

async function saveStatus(result) {
  await query("INSERT INTO settings(key,value) VALUES('catalog_last_sync',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(result)]);
}

export async function catalogStatus() {
  const n = await query('SELECT COUNT(*)::int AS n FROM catalog_products');
  const s = await query("SELECT value FROM settings WHERE key='catalog_last_sync'");
  let last = null;
  try { last = s.rows[0] ? JSON.parse(s.rows[0].value) : null; } catch { /* sin datos */ }
  return { products: n.rows[0].n, last_sync: last, woocommerce_configured: wcEnabled() };
}

// ---------- Búsqueda ----------
export async function searchCatalog({ query: text, category, in_stock_only, min_price, max_price, limit = 5 } = {}) {
  const tq = buildTsQueries(text || '');
  const lim = Math.min(Math.max(Number(limit) || 5, 1), 8);
  const params = [];
  const where = [];
  let rankExpr = '0';
  if (tq) {
    params.push(tq.or, tq.and);
    const ts = "to_tsvector('spanish', search_text)";
    where.push(`${ts} @@ to_tsquery('spanish', $1)`);
    // SKU exacto > coincidencia de todos los términos > ranking de texto
    const exact = norm(text || '').replace(/\s+/g, '');
    params.push(exact);
    rankExpr = `(CASE WHEN lower(replace(sku,' ','')) = $3 THEN 10 ELSE 0 END) + (CASE WHEN ${ts} @@ to_tsquery('spanish', $2) THEN 2 ELSE 0 END) + ts_rank_cd(${ts}, to_tsquery('spanish', $1))`;
    // Una consulta que es literalmente un SKU debe encontrarlo aunque el tokenizador lo parta
    where[0] = `(${where[0]} OR lower(replace(sku,' ','')) = $3)`;
  }
  if (category) { params.push(`%${norm(category)}%`); where.push(`lower(search_text) LIKE $${params.length}`); }
  if (in_stock_only) where.push("stock_status = 'instock'");
  if (Number.isFinite(Number(min_price)) && min_price != null) { params.push(Math.round(Number(min_price))); where.push(`price >= $${params.length}`); }
  if (Number.isFinite(Number(max_price)) && max_price != null) { params.push(Math.round(Number(max_price))); where.push(`price <= $${params.length} AND price > 0`); }
  if (!tq && !category && !where.length) return [];
  const sql = `SELECT wc_id, sku, name, short_description, categories, stock_status, permalink, product_type, ${rankExpr} AS score
               FROM catalog_products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY score DESC, name ASC LIMIT ${lim}`;
  const { rows } = await query(sql, params);
  return rows;
}

export const priceInfo = (net) => {
  const includes = wcConfig().pricesIncludeTax;
  const base = Math.round(Number(net) || 0);
  return includes
    ? { precio_neto: Math.round(base / 1.19), precio_con_iva: base }
    : { precio_neto: base, precio_con_iva: Math.round(base * 1.19) };
};
