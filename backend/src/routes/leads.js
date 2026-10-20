import { Router } from 'express';
import { query, tx } from '../db.js';
import { authenticate, requireAdmin } from '../auth.js';
import { HttpError, formatRut, parseDate, parseMoney, toBool, today } from '../util.js';

export const LEAD_SELECT = `
  SELECT l.id, l.import_key, l.client_name, l.rut, l.razon_social, l.email, l.contact, l.phone, l.whatsapp,
         l.channel, l.state_id, l.state_date::text AS state_date, l.lead_date::text AS lead_date,
         l.quote_number, l.client_quote_number, l.invoice_number, l.products_text,
         l.subtotal, l.iva, l.total, l.requires_supplier_quote, l.comments,
         l.created_by, l.created_at, l.updated_at,
         s.name AS state_name, s.color AS state_color, u.name AS owner_name
  FROM leads l
  LEFT JOIN pipeline_states s ON s.id = l.state_id
  LEFT JOIN users u ON u.id = l.created_by`;

const TEXT_FIELDS = ['client_name', 'razon_social', 'email', 'contact', 'phone', 'whatsapp', 'channel', 'client_quote_number', 'invoice_number', 'products_text', 'comments'];

function leadInput(b) {
  const out = {};
  for (const f of TEXT_FIELDS) if (b[f] !== undefined) out[f] = String(b[f] ?? '').trim();
  if (b.rut !== undefined) out.rut = b.rut ? formatRut(b.rut) : '';
  if (b.state_id !== undefined) out.state_id = Number(b.state_id) || null;
  if (b.lead_date !== undefined) out.lead_date = parseDate(b.lead_date);
  for (const f of ['subtotal', 'iva', 'total']) if (b[f] !== undefined) out[f] = parseMoney(b[f]);
  if (b.quote_number !== undefined) out.quote_number = b.quote_number === '' || b.quote_number === null ? null : parseMoney(b.quote_number);
  if (b.requires_supplier_quote !== undefined) out.requires_supplier_quote = !!b.requires_supplier_quote;
  return out;
}

export const leadsRouter = Router();
leadsRouter.use(authenticate);

leadsRouter.get('/', async (req, res) => {
  const params = [];
  const where = [];
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(`(LOWER(l.client_name) LIKE ${p} OR LOWER(l.razon_social) LIKE ${p} OR LOWER(l.rut) LIKE ${p} OR LOWER(l.email) LIKE ${p} OR LOWER(l.contact) LIKE ${p} OR CAST(l.quote_number AS TEXT) LIKE ${p})`);
  }
  if (req.query.state_id) {
    params.push(Number(req.query.state_id));
    where.push(`l.state_id = $${params.length}`);
  }
  const { rows } = await query(`${LEAD_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(l.state_date, l.lead_date) DESC NULLS LAST, l.id DESC LIMIT 3000`, params);
  res.json(rows);
});

leadsRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(`${LEAD_SELECT} WHERE l.id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Lead no encontrado');
  const q = await query('SELECT id, number, quote_date::text AS quote_date, total FROM quotes WHERE lead_id=$1 ORDER BY number DESC', [id]);
  res.json({ ...rows[0], quotes: q.rows });
});

leadsRouter.post('/', async (req, res) => {
  const l = leadInput(req.body);
  if (!l.client_name && !l.razon_social) throw new HttpError(400, 'Indica el cliente o la razón social');
  if (!l.state_id) {
    const { rows } = await query('SELECT id FROM pipeline_states WHERE is_initial LIMIT 1');
    l.state_id = rows[0]?.id ?? null;
  }
  const keys = Object.keys(l);
  const cols = [...keys, 'state_date', 'created_by'];
  const vals = [...keys.map((k) => l[k]), today(), req.user.id];
  const { rows } = await query(`INSERT INTO leads(${cols.join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals);
  const out = await query(`${LEAD_SELECT} WHERE l.id=$1`, [rows[0].id]);
  res.status(201).json(out.rows[0]);
});

leadsRouter.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const cur = await query('SELECT state_id FROM leads WHERE id=$1', [id]);
  if (!cur.rows[0]) throw new HttpError(404, 'Lead no encontrado');
  const l = leadInput(req.body);
  const keys = Object.keys(l);
  if (!keys.length) throw new HttpError(400, 'Nada que actualizar');
  const extra = [];
  if (l.state_id !== undefined && l.state_id !== cur.rows[0].state_id) extra.push(['state_date', today()]);
  const all = [...keys.map((k) => [k, l[k]]), ...extra];
  const sets = all.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  await query(`UPDATE leads SET ${sets}, updated_at=now() WHERE id=$${all.length + 1}`, [...all.map(([, v]) => v), id]);
  const out = await query(`${LEAD_SELECT} WHERE l.id=$1`, [id]);
  res.json(out.rows[0]);
});

leadsRouter.delete('/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM leads WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ IMPORTACIÓN (Notion CSV → CRM)
// El navegador parsea el CSV y mapea columnas → campos del CRM. Aquí se normaliza y se hace upsert.
export const importRouter = Router();
importRouter.use(authenticate, requireAdmin);

importRouter.post('/leads', async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const createStates = req.body.createStates !== false;
  const bumpCounter = req.body.bumpCounter !== false;
  if (!rows.length) throw new HttpError(400, 'No hay filas para importar');
  if (rows.length > 5000) throw new HttpError(400, 'Máximo 5000 filas por importación');

  const result = { created: 0, updated: 0, skipped: 0, statesCreated: [], unknownStates: [], maxQuoteNumber: 0, counterSetTo: null };

  await tx(async (t) => {
    const { rows: st } = await t.query('SELECT id, name, is_initial FROM pipeline_states');
    const byName = new Map(st.map((s) => [s.name.trim().toLowerCase(), s.id]));
    const initial = st.find((s) => s.is_initial)?.id ?? null;
    const { rows: pos } = await t.query('SELECT COALESCE(MAX(position),-1)::int AS p FROM pipeline_states');
    let nextPos = pos[0].p + 1;
    const unknown = new Set();

    for (const r of rows) {
      const name = String(r.client_name || '').trim();
      const razon = String(r.razon_social || '').trim();
      const rut = String(r.rut || '').trim();
      if (!name && !razon && !rut && !r.quote_number && !r.total) { result.skipped++; continue; }

      // Estado
      let stateId = initial;
      const sname = String(r.state || '').trim();
      if (sname) {
        const k = sname.toLowerCase();
        if (byName.has(k)) stateId = byName.get(k);
        else if (createStates) {
          const ins = await t.query('INSERT INTO pipeline_states(name,position) VALUES($1,$2) RETURNING id', [sname, nextPos++]);
          byName.set(k, ins.rows[0].id);
          stateId = ins.rows[0].id;
          result.statesCreated.push(sname);
        } else unknown.add(sname);
      }

      const quoteNumber = r.quote_number === '' || r.quote_number == null ? null : parseMoney(r.quote_number) || null;
      if (quoteNumber && quoteNumber > result.maxQuoteNumber) result.maxQuoteNumber = quoteNumber;
      const corr = String(r.legacy_id || '').trim();
      const importKey = corr ? `notion:${corr}` : quoteNumber ? `notion-q:${quoteNumber}` : null;

      let subtotal = parseMoney(r.subtotal), iva = parseMoney(r.iva), total = parseMoney(r.total);
      if (!subtotal && total) { subtotal = Math.round(total / 1.19); iva = total - subtotal; }
      if (!total && subtotal) { iva = iva || Math.round(subtotal * 0.19); total = subtotal + iva; }

      const rec = {
        client_name: name,
        rut: rut ? formatRut(rut) : '',
        razon_social: razon,
        email: String(r.email || '').trim(),
        contact: String(r.contact || '').trim(),
        phone: String(r.phone || '').trim(),
        whatsapp: String(r.whatsapp || '').trim(),
        channel: String(r.channel || '').trim(),
        state_id: stateId,
        state_date: parseDate(r.state_date),
        lead_date: parseDate(r.lead_date),
        quote_number: quoteNumber,
        client_quote_number: String(r.client_quote_number || '').trim(),
        invoice_number: String(r.invoice_number || '').trim(),
        products_text: String(r.products_text || '').trim(),
        subtotal, iva, total,
        requires_supplier_quote: toBool(r.requires_supplier_quote),
        comments: String(r.comments || '').trim(),
      };
      const keys = Object.keys(rec);

      const ex = importKey ? await t.query('SELECT id FROM leads WHERE import_key=$1', [importKey]) : { rows: [] };
      if (ex.rows[0]) {
        const sets = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
        await t.query(`UPDATE leads SET ${sets}, updated_at=now() WHERE id=$${keys.length + 1}`, [...keys.map((k) => rec[k]), ex.rows[0].id]);
        result.updated++;
      } else {
        const cols = [...keys, 'import_key', 'created_by'];
        await t.query(`INSERT INTO leads(${cols.join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')})`, [...keys.map((k) => rec[k]), importKey, req.user.id]);
        result.created++;
      }
    }
    result.unknownStates = [...unknown];

    if (bumpCounter && result.maxQuoteNumber > 0) {
      const { rows: cur } = await t.query("SELECT value FROM settings WHERE key='quote_next_number'");
      const { rows: mx } = await t.query('SELECT COALESCE(MAX(number),0)::int AS m FROM quotes');
      const want = Math.max(result.maxQuoteNumber, mx[0].m) + 1;
      if (want > Number(cur[0]?.value || 1)) {
        await t.query("UPDATE settings SET value=$1 WHERE key='quote_next_number'", [String(want)]);
        result.counterSetTo = want;
      }
    }
  });

  res.json(result);
});
