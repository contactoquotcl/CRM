// Conversión de cotizaciones: carga de facturación emitida (SII) y conciliación contra las cotizaciones del CRM.
import { query, tx } from './db.js';

export const OUR_RUT = () => cleanRut(process.env.QUOT_RUT || '77372977-8');
export const cleanRut = (v = '') => String(v).replace(/[^0-9kK]/g, '').toUpperCase();

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú', '&ntilde;': 'ñ', '&Ntilde;': 'Ñ' };
const decode = (s) => String(s).replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, g) => (ENT[m] ?? (g[0] === '#' ? String.fromCodePoint(g[1] === 'x' ? parseInt(g.slice(2), 16) : Number(g.slice(1))) : m)));

/** Número de una celda del SII: «119000.0», «1.234.567», «1234567,0». */
export function num(v) {
  const s = String(v ?? '').trim();
  if (!s) return 0;
  let t = s;
  if (/^-?\d+(\.\d+)?$/.test(s)) t = s;
  else t = s.replace(/\./g, '').replace(',', '.');
  const f = Number(t.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(f) ? Math.round(f) : 0;
}

/** Fecha del SII a YYYY-MM-DD (acepta aaaa-mm-dd, dd-mm-aaaa, dd/mm/aaaa y números de serie de Excel). */
export function isoDate(v) {
  const s = String(v ?? '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) return new Date(Math.round((Number(s) - 25569) * 86400000)).toISOString().slice(0, 10);
  return '';
}

function rowsFromHtml(text) {
  const rows = [];
  for (const tr of String(text).match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => decode(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim());
    if (cells.some((c) => c !== '')) rows.push(cells);
  }
  return rows;
}
function rowsFromCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  return lines.map((l) => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; });
}

const ALIAS = {
  tipo: ['tipodte', 'tipodoc', 'tipodocumento', 'tipo'],
  folio: ['folio'],
  fecha: ['fechaemision', 'fechadocto', 'fechadocumento', 'fecha'],
  rutEmisor: ['rutemisor'],
  rutReceptor: ['rutreceptor', 'rutcliente', 'rut'],
  razon: ['razonsocialreceptor', 'razonsocial', 'cliente', 'receptor'],
  neto: ['totalneto', 'montoneto', 'neto'],
  exento: ['totalexento', 'montoexento', 'exento'],
  iva: ['totaliva', 'montoiva', 'iva'],
  total: ['totalmontototal', 'montototal', 'total'],
};
const key = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

const TIPOS = new Set([33, 34, 39, 41, 56, 61]);

/** Lee un export del SII (DTE_DOWN .xls = HTML, o CSV del RCV de ventas) y devuelve los documentos emitidos por Quot. */
export function parseSii(text) {
  const rows = /<table|<tr/i.test(text) ? rowsFromHtml(text) : rowsFromCsv(text);
  const hi = rows.findIndex((r) => { const k = r.map(key); return k.some((x) => ALIAS.folio.includes(x)) && k.some((x) => ALIAS.tipo.includes(x)); });
  if (hi < 0) throw new Error('No reconocí el formato: se espera el export de facturas del SII (DTE_DOWN .xls) o el CSV del libro de ventas, con columnas TipoDTE y Folio.');
  const head = rows[hi].map(key);
  const col = {};
  for (const [f, names] of Object.entries(ALIAS)) col[f] = head.findIndex((h) => names.includes(h));
  const docs = []; const out = { docs, recibidas: 0, ignoradas: 0 };
  const mine = OUR_RUT();
  for (const r of rows.slice(hi + 1)) {
    const tipoRaw = String(r[col.tipo] ?? '').trim();
    if (!/^\d+$/.test(tipoRaw)) continue; // filas «DETALLE» y separadores
    const tipo = Number(tipoRaw);
    if (col.rutEmisor >= 0 && r[col.rutEmisor] && cleanRut(r[col.rutEmisor]) !== mine) { out.recibidas++; continue; }
    if (!TIPOS.has(tipo)) { out.ignoradas++; continue; }
    const fecha = isoDate(r[col.fecha]);
    const folio = String(r[col.folio] ?? '').trim().replace(/\.0$/, '');
    if (!folio || !fecha) { out.ignoradas++; continue; }
    const neto = num(r[col.neto]); const exento = num(r[col.exento]); const iva = num(r[col.iva]);
    let total = num(r[col.total]);
    if (!total) total = neto + exento + iva;
    docs.push({ tipo, folio, fecha, rut: cleanRut(r[col.rutReceptor]), razon: String(r[col.razon] ?? '').slice(0, 200), neto, exento, iva, total });
  }
  return out;
}

export async function importFiles(files, userId) {
  const summary = [];
  for (const f of files) {
    const name = String(f.name || 'archivo').slice(0, 200);
    try {
      const p = parseSii(String(f.text || ''));
      let created = 0, updated = 0;
      await tx(async (t) => {
        for (const d of p.docs) {
          const r = await t.query(
            `INSERT INTO invoices(tipo, folio, fecha, rut, razon, neto, exento, iva, total, source, uploaded_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (tipo, folio) DO UPDATE SET fecha=EXCLUDED.fecha, rut=EXCLUDED.rut, razon=EXCLUDED.razon, neto=EXCLUDED.neto, exento=EXCLUDED.exento, iva=EXCLUDED.iva, total=EXCLUDED.total, source=EXCLUDED.source, uploaded_by=EXCLUDED.uploaded_by, uploaded_at=now()
             RETURNING (xmax = 0) AS inserted`,
            [d.tipo, d.folio, d.fecha, d.rut, d.razon, d.neto, d.exento, d.iva, d.total, name, userId]);
          if (r.rows[0].inserted) created++; else updated++;
        }
      });
      summary.push({ name, ok: true, documents: p.docs.length, created, updated, recibidas_ignoradas: p.recibidas, otros_ignorados: p.ignoradas });
    } catch (e) { summary.push({ name, ok: false, error: e.message }); }
  }
  const matched = await reconcile();
  return { files: summary, matched };
}

const near = (a, b) => b > 0 && Math.abs(a - b) <= Math.max(1000, b * 0.01);

/** Concilia facturas con cotizaciones: mismo RUT, cotización anterior a la factura (ventana configurable) y monto igual (±1 %). Conserva los vínculos manuales. */
export async function reconcile() {
  const win = Number((await query("SELECT value FROM settings WHERE key='conversion_window_days'")).rows[0]?.value) || 120;
  await query("UPDATE invoices SET quote_id=NULL, match='' WHERE match='auto'");
  const invs = (await query("SELECT id, rut, fecha::text AS fecha, neto, total FROM invoices WHERE tipo IN (33,34) AND quote_id IS NULL AND match <> 'none' ORDER BY fecha, id")).rows;
  const taken = new Set((await query('SELECT quote_id FROM invoices WHERE quote_id IS NOT NULL')).rows.map((r) => r.quote_id));
  const quotes = (await query("SELECT id, regexp_replace(upper(rut), '[^0-9K]', '', 'g') AS rut, quote_date::text AS d, subtotal, total FROM quotes WHERE total > 0")).rows;
  const byRut = new Map();
  for (const q of quotes) { if (!q.rut) continue; (byRut.get(q.rut) || byRut.set(q.rut, []).get(q.rut)).push(q); }
  const day = (s) => Math.floor(new Date(s + 'T00:00:00Z').getTime() / 86400000);
  let n = 0;
  for (const inv of invs) {
    const cands = (byRut.get(inv.rut) || []).filter((q) => !taken.has(q.id) && day(q.d) <= day(inv.fecha) && day(inv.fecha) - day(q.d) <= win && (near(inv.total, q.total) || near(inv.neto, q.subtotal)));
    if (!cands.length) continue;
    cands.sort((a, b) => (near(inv.total, b.total) ? 1 : 0) - (near(inv.total, a.total) ? 1 : 0) || day(b.d) - day(a.d)); // monto exacto y la más reciente
    const q = cands[0];
    taken.add(q.id);
    await query("UPDATE invoices SET quote_id=$1, match='auto' WHERE id=$2", [q.id, inv.id]);
    n++;
  }
  return n;
}

const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const bucket = (d, group) => (group === 'year' ? d.slice(0, 4) : group === 'day' ? d : d.slice(0, 7));

/**
 * Métricas de conversión. «Cotizado»: cotizaciones del período (las repetidas del mismo cliente, mismo monto y a ≤30 días se cuentan una vez).
 * «Convertida»: tiene una factura conciliada. «Facturado»: facturas del período (menos notas de crédito).
 */
export async function metrics({ from, to, group = 'month', channel = '', userId = 0, dedupe = true } = {}) {
  const f = from || '1900-01-01'; const t = to || '2999-12-31';
  const quotes = (await query(
    `SELECT q.id, q.number, q.quote_date::text AS d, q.rut, q.razon_social, q.subtotal, q.total, q.channel, q.created_by, (SELECT COALESCE(SUM(i.cost * i.qty), 0)::int FROM quote_items i WHERE i.quote_id = q.id) AS cost_total, COALESCE(u.name, CASE WHEN q.channel='Chatbot' THEN 'Chatbot' ELSE '(sin usuario)' END) AS user_name
       FROM quotes q LEFT JOIN users u ON u.id=q.created_by WHERE q.total > 0 ORDER BY q.quote_date, q.id`)).rows;
  const invs = (await query('SELECT id, tipo, folio, fecha::text AS fecha, rut, razon, neto, total, quote_id, match FROM invoices ORDER BY fecha, id')).rows;
  const byQuote = new Map(invs.filter((i) => i.quote_id).map((i) => [i.quote_id, i]));

  // Oportunidades: agrupa cotizaciones repetidas
  const opps = [];
  const seen = new Map();
  for (const q of quotes) {
    const rut = cleanRut(q.rut);
    const k = rut ? `${rut}|${q.total}` : `id${q.id}`;
    const prev = dedupe ? seen.get(k) : null;
    if (prev && dayDiff(prev.last, q.d) <= 30) { prev.members.push(q); prev.last = q.d; continue; }
    const o = { ...q, members: [q], last: q.d };
    opps.push(o); if (dedupe) seen.set(k, o);
  }
  for (const o of opps) {
    const hit = o.members.map((m) => byQuote.get(m.id)).filter(Boolean).sort((a, b) => a.fecha.localeCompare(b.fecha))[0];
    o.invoice = hit || null;
  }
  const mgn = (list) => { const k = list.filter((o) => o.cost_total > 0); const net = k.reduce((a, o) => a + o.subtotal, 0); const m = k.reduce((a, o) => a + (o.subtotal - o.cost_total), 0); return { margin_net: m, margin_pct: net > 0 ? Math.round((m / net) * 1000) / 10 : null, margin_base_net: net, margin_count: k.length }; };
  const inQ = (o) => o.d >= f && o.d <= t && (!channel || o.channel === channel) && (!userId || o.created_by === userId);
  const sel = opps.filter(inQ);
  const conv = sel.filter((o) => o.invoice);

  const invSel = invs.filter((i) => i.fecha >= f && i.fecha <= t);
  const sales = invSel.filter((i) => [33, 34, 39, 41, 56].includes(i.tipo));
  const ncs = invSel.filter((i) => i.tipo === 61);
  const sum = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
  const fromQuotes = sales.filter((i) => i.quote_id);
  const noQuote = sales.filter((i) => !i.quote_id && [33, 34].includes(i.tipo));
  const days = conv.map((o) => dayDiff(o.d, o.invoice.fecha));
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

  const series = new Map();
  const slot = (p) => series.get(p) || series.set(p, { period: p, quoted_count: 0, quoted_net: 0, quoted_margin_net: 0, quoted_margin_base: 0, converted_count: 0, converted_net: 0, invoiced_net: 0, invoiced_from_quotes_net: 0 }).get(p);
  for (const o of sel) { const s = slot(bucket(o.d, group)); s.quoted_count++; s.quoted_net += o.subtotal; if (o.cost_total > 0) { s.quoted_margin_net += o.subtotal - o.cost_total; s.quoted_margin_base += o.subtotal; } if (o.invoice) { s.converted_count++; s.converted_net += o.subtotal; } }
  for (const i of sales) { const s = slot(bucket(i.fecha, group)); s.invoiced_net += i.neto + (i.tipo === 34 ? sum([i], 'total') - i.neto : 0); if (i.quote_id) s.invoiced_from_quotes_net += i.neto; }
  for (const i of ncs) { slot(bucket(i.fecha, group)).invoiced_net -= i.neto; }
  const groupBy = (keyFn) => {
    const m = new Map();
    for (const o of sel) { const k = keyFn(o); const r = m.get(k) || m.set(k, { name: k, quoted_count: 0, quoted_net: 0, converted_count: 0, converted_net: 0, _mn: 0, _mb: 0 }).get(k); r.quoted_count++; r.quoted_net += o.subtotal; if (o.cost_total > 0) { r._mn += o.subtotal - o.cost_total; r._mb += o.subtotal; } if (o.invoice) { r.converted_count++; r.converted_net += o.subtotal; } }
    return [...m.values()].map(({ _mn, _mb, ...r }) => ({ ...r, margin_net: _mn, margin_pct: _mb > 0 ? Math.round((_mn / _mb) * 1000) / 10 : null, pct_count: pct(r.converted_count, r.quoted_count), pct_amount: pct(r.converted_net, r.quoted_net) })).sort((a, b) => b.quoted_net - a.quoted_net);
  };
  const today = new Date().toISOString().slice(0, 10);
  const lastInv = invs.length ? invs[invs.length - 1].fecha : null;
  const meta = (await query('SELECT MAX(uploaded_at) AS last_upload, COUNT(*)::int AS n FROM invoices')).rows[0];
  return {
    range: { from: f, to: t, group },
    kpis: {
      quoted_count: sel.length, quoted_net: sum(sel, 'subtotal'),
      quoted_margin_net: mgn(sel).margin_net, quoted_margin_pct: mgn(sel).margin_pct, quoted_margin_base_net: mgn(sel).margin_base_net, quoted_margin_count: mgn(sel).margin_count,
      converted_margin_net: mgn(conv).margin_net, converted_margin_pct: mgn(conv).margin_pct,
      converted_count: conv.length, converted_net: sum(conv, 'subtotal'), invoiced_for_converted_net: conv.reduce((s, o) => s + o.invoice.neto, 0),
      pct_count: pct(conv.length, sel.length), pct_amount: pct(sum(conv, 'subtotal'), sum(sel, 'subtotal')),
      invoiced_net: sum(sales, 'neto') - sum(ncs, 'neto'), invoiced_count: sales.length, nc_net: sum(ncs, 'neto'),
      invoiced_from_quotes_net: sum(fromQuotes, 'neto'), invoiced_without_quote_net: sum(noQuote, 'neto'), invoiced_without_quote_count: noQuote.length,
      pct_invoiced_from_quotes: pct(sum(fromQuotes, 'neto'), sum(sales, 'neto')),
      avg_days_to_invoice: days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null,
      avg_invoice_net: sales.length ? Math.round(sum(sales, 'neto') / sales.length) : 0,
      raw_quotes: quotes.filter((q) => q.d >= f && q.d <= t && (!channel || q.channel === channel) && (!userId || q.created_by === userId)).length,
    },
    series: [...series.values()].sort((a, b) => a.period.localeCompare(b.period)).map((s) => ({ ...s, pct_count: pct(s.converted_count, s.quoted_count), margin_pct: s.quoted_margin_base > 0 ? Math.round((s.quoted_margin_net / s.quoted_margin_base) * 1000) / 10 : null })),
    by_user: groupBy((o) => o.user_name),
    by_channel: groupBy((o) => o.channel || 'Cotizador'),
    open: sel.filter((o) => !o.invoice).sort((a, b) => b.subtotal - a.subtotal).slice(0, 15).map((o) => ({ id: o.id, number: o.number, date: o.d, client: o.razon_social, net: o.subtotal, margin_pct: o.cost_total > 0 && o.subtotal > 0 ? Math.round(((o.subtotal - o.cost_total) / o.subtotal) * 1000) / 10 : null, total: o.total, channel: o.channel, user: o.user_name, age_days: dayDiff(o.d, today) })),
    unmatched_invoices: noQuote.sort((a, b) => b.neto - a.neto).slice(0, 15).map((i) => ({ id: i.id, tipo: i.tipo, folio: i.folio, fecha: i.fecha, rut: i.rut, razon: i.razon, neto: i.neto, total: i.total })),
    coverage: { invoices: meta.n, last_invoice_date: lastInv, last_upload: meta.last_upload, today },
  };
}

/** Cotizaciones candidatas para vincular a mano una factura: mismo RUT dentro de la ventana, sin otra factura. */
export async function suggestions(invoiceId) {
  const inv = (await query('SELECT id, rut, fecha::text AS fecha, total FROM invoices WHERE id=$1', [invoiceId])).rows[0];
  if (!inv) return null;
  const win = Number((await query("SELECT value FROM settings WHERE key='conversion_window_days'")).rows[0]?.value) || 120;
  const rows = (await query(
    `SELECT q.id, q.number, q.quote_date::text AS date, q.razon_social, q.subtotal, q.total,
            (SELECT i.folio FROM invoices i WHERE i.quote_id=q.id LIMIT 1) AS linked_folio
       FROM quotes q
      WHERE regexp_replace(upper(q.rut), '[^0-9K]', '', 'g') = $1 AND q.total > 0
        AND q.quote_date <= $2::date AND q.quote_date >= $2::date - ($3 || ' days')::interval
      ORDER BY q.quote_date DESC LIMIT 20`, [inv.rut, inv.fecha, String(win)])).rows;
  return { invoice: inv, quotes: rows };
}
