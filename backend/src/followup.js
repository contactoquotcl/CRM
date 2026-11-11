// Seguimiento de cotizaciones por correo: Cotizado → Seguimiento 1 → Seguimiento 2 → Archivado.
// Cada envío queda en `followup_emails` (quién, cuándo, a quién, estado, error) y mueve el lead de etapa.
import { query, getSettings } from './db.js';
import { quotePdfBuffer } from './quoteService.js';
import { mailEnabled, sendMail, mailLabel } from './mailer.js';
import { clp, today } from './util.js';

export const STEPS = [
  { key: 's1', label: 'Seguimiento 1', from: 'Cotizado', to: 'Seguimiento 1', daysKey: 'followup_days_s1' },
  { key: 's2', label: 'Seguimiento 2', from: 'Seguimiento 1', to: 'Seguimiento 2', daysKey: 'followup_days_s2' },
  { key: 'close', label: 'Archivar', from: 'Seguimiento 2', to: 'Archivado', daysKey: 'followup_days_close' },
];
const FOOTER = '\n\n—\nSi ya no necesitas esta cotización, responde «no gracias» y no te escribiremos más.';
export const stepFrom = (stateName) => STEPS.find((s) => s.from.toLowerCase() === String(stateName || '').toLowerCase()) || null;

const fmtDate = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${dd}-${m}-${y}`; };
function addDays(d, n) { const t = new Date(`${String(d).slice(0, 10)}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
const fill = (tpl, v) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (v[k] !== undefined ? v[k] : `{${k}}`));

/** Quién recibe y cuál es la cotización más reciente de cada lead que está en una etapa de seguimiento. */
const ROWS_SQL = `
  SELECT DISTINCT ON (q.lead_id) q.id AS quote_id, q.number, q.lead_id, q.quote_date::text AS quote_date, q.validity_days, q.total, q.razon_social, q.contact,
         COALESCE(NULLIF(q.email,''), l.email) AS email, q.follow_mode, q.channel, c.name AS created_by_name,
         s.name AS state_name, l.state_date::text AS state_date,
         (SELECT COUNT(*)::int FROM followup_emails f WHERE f.quote_id=q.id AND f.status='enviado') AS sent_count,
         (SELECT row_to_json(x) FROM (SELECT step, status, error, created_at, trigger FROM followup_emails f WHERE f.quote_id=q.id ORDER BY f.id DESC LIMIT 1) x) AS last_email
    FROM quotes q JOIN leads l ON l.id = q.lead_id JOIN pipeline_states s ON s.id = l.state_id LEFT JOIN users c ON c.id = q.created_by
   WHERE lower(s.name) = ANY($1::text[]) %FILTER%
   ORDER BY q.lead_id, q.number DESC`;

export async function queue({ channel = 'ia' } = {}) {
  const st = await getSettings();
  const names = STEPS.map((s) => s.from.toLowerCase());
  const filter = channel === 'ia' ? "AND q.channel = 'Chatbot'" : '';
  const { rows } = await query(ROWS_SQL.replace('%FILTER%', filter), [names]);
  const now = today();
  const out = rows.map((r) => {
    const step = stepFrom(r.state_name);
    const days = r.state_date ? Math.max(0, Math.round((Date.parse(now) - Date.parse(r.state_date)) / 86400000)) : 0;
    const need = Number(st[step.daysKey]) || 0;
    const problems = [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email || '')) problems.push('sin correo válido');
    if (r.follow_mode === 'pausado') problems.push('pausada');
    return { ...r, step: step.key, next_label: step.label, to_state: step.to, days_in_state: days, due_in_days: Math.max(0, need - days), due: days >= need, problems };
  }).sort((a, b) => b.number - a.number);
  const sentToday = (await query("SELECT COUNT(*)::int n FROM followup_emails WHERE status='enviado' AND created_at::date = CURRENT_DATE")).rows[0].n;
  return { rows: out, sent_today: sentToday, daily_limit: Number(st.followup_daily_limit) || 0, configured: mailEnabled(), provider: mailLabel(), send_on_archive: st.followup_send_on_archive === '1' };
}

async function load(quoteId) {
  const { rows } = await query(
    `SELECT q.id AS quote_id, q.number, q.lead_id, q.quote_date::text AS quote_date, q.validity_days, q.total, q.razon_social, q.contact, q.follow_mode,
            COALESCE(NULLIF(q.email,''), l.email) AS email, s.name AS state_name, l.comments AS lead_comments
       FROM quotes q LEFT JOIN leads l ON l.id = q.lead_id LEFT JOIN pipeline_states s ON s.id = l.state_id WHERE q.id=$1`, [Number(quoteId)]);
  return rows[0] || null;
}

export function render(q, step, st) {
  const v = {
    contacto: (q.contact || '').split(/\s+/)[0] || q.razon_social || 'equipo', empresa: q.razon_social || '', numero: q.number,
    total: clp(q.total), fecha: fmtDate(q.quote_date), vence: fmtDate(addDays(q.quote_date, q.validity_days)),
  };
  const key = `followup_${step.key}`;
  return { subject: fill(st[`${key}_subject`], v), text: fill(st[`${key}_body`], v) + FOOTER };
}

export async function preview(quoteId) {
  const q = await load(quoteId);
  if (!q) return null;
  const step = stepFrom(q.state_name);
  if (!step) return { quote_id: q.quote_id, error: `La cotización está en "${q.state_name || 'sin etapa'}": no tiene un siguiente seguimiento.` };
  const st = await getSettings();
  const sendsMail = step.key !== 'close' || st.followup_send_on_archive === '1';
  return { quote_id: q.quote_id, number: q.number, to: q.email, step: step.key, label: step.label, to_state: step.to, sends_mail: sendsMail, ...render(q, step, st), attachment: `Cotizacion-${q.number}.pdf` };
}

/**
 * Envía el correo de la etapa actual y mueve el lead a la siguiente. Nunca repite un paso ya enviado.
 * @returns {Promise<{quote_id:number, ok:boolean, skipped?:boolean, message:string}>}
 */
export async function advance(quoteId, { userId = null, trigger = 'manual' } = {}) {
  const q = await load(quoteId);
  const res = (ok, message, extra = {}) => ({ quote_id: Number(quoteId), number: q?.number, ok, message, ...extra });
  if (!q) return res(false, 'Cotización no encontrada');
  if (!q.lead_id) return res(false, 'La cotización no tiene lead en el pipeline', { skipped: true });
  const step = stepFrom(q.state_name);
  if (!step) return res(false, `Está en "${q.state_name}": no hay siguiente seguimiento`, { skipped: true });
  if (q.follow_mode === 'pausado') return res(false, 'Seguimiento pausado', { skipped: true });
  const st = await getSettings();
  const wantsMail = step.key !== 'close' || st.followup_send_on_archive === '1';
  const stateId = (await query('SELECT id FROM pipeline_states WHERE lower(name)=lower($1) LIMIT 1', [step.to])).rows[0]?.id;
  if (!stateId) return res(false, `No existe la etapa "${step.to}" en el pipeline`);
  const log = (status, subject, error = '', pid = '', provider = '') => query(
    `INSERT INTO followup_emails(quote_id, lead_id, step, to_email, subject, status, error, provider, provider_id, trigger, from_state, to_state, sent_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [q.quote_id, q.lead_id, step.key, q.email || '', subject, status, error.slice(0, 500), provider, pid, trigger, step.from, step.to, userId]);
  const move = async (note) => {
    await query('UPDATE leads SET state_id=$1, state_date=$2, comments=$3, updated_at=now() WHERE id=$4',
      [stateId, today(), [q.lead_comments, `[${today()}] ${note}`].filter(Boolean).join('\n'), q.lead_id]);
    if (step.key === 'close') await query("UPDATE quotes SET follow_mode='manual' WHERE id=$1", [q.quote_id]);
  };
  if (wantsMail) {
    if ((await query("SELECT 1 FROM followup_emails WHERE quote_id=$1 AND step=$2 AND status='enviado'", [q.quote_id, step.key])).rows[0]) return res(false, 'Ese seguimiento ya se envió antes', { skipped: true });
    if (!mailEnabled()) return res(false, 'El correo no está configurado (Admin → Integraciones)');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.email || '')) return res(false, 'La cotización no tiene un correo válido', { skipped: true });
    const limit = Number(st.followup_daily_limit) || 0;
    if (limit && (await query("SELECT COUNT(*)::int n FROM followup_emails WHERE status='enviado' AND created_at::date = CURRENT_DATE")).rows[0].n >= limit) return res(false, `Límite diario de ${limit} correos alcanzado`, { skipped: true });
    const { subject, text } = render(q, step, st);
    try {
      const pdf = await quotePdfBuffer(q.quote_id);
      const r = await sendMail({ to: q.email, subject, text, attachments: pdf ? [{ filename: `Cotizacion-${pdf.number}.pdf`, content: pdf.buffer }] : [] });
      await log('enviado', subject, '', r.id, r.provider);
      await move(`Correo "${step.label}" enviado a ${q.email} (${trigger === 'auto' ? 'automático' : 'manual'}). Etapa: ${step.from} → ${step.to}.`);
      return res(true, `Enviado a ${q.email}; ahora en ${step.to}`, { to_state: step.to });
    } catch (e) {
      await log('error', subject, String(e.message || e));
      return res(false, `No se pudo enviar: ${String(e.message || e).slice(0, 200)}`);
    }
  }
  await log('movido', '(archivado sin correo)');
  await move(`Cotización archivada por falta de respuesta. Etapa: ${step.from} → ${step.to}.`);
  return res(true, `Archivada (${step.to})`, { to_state: step.to });
}

/** Zona horaria de Chile: lunes a viernes, 9:00–18:00. */
export function inBusinessHours(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((x) => [x.type, x.value]));
  return !['Sat', 'Sun'].includes(p.weekday) && Number(p.hour) >= 9 && Number(p.hour) < 18;
}

let running = false;
/** Envía los seguimientos automáticos que ya les toca (cotizaciones en modo "auto"). */
export async function runAuto({ force = false } = {}) {
  if (running || !mailEnabled()) return [];
  const st = await getSettings();
  if (!force && st.followup_business_hours !== '0' && !inBusinessHours()) return [];
  running = true;
  try {
    const { rows } = await queue({ channel: 'all' });
    const out = [];
    for (const r of rows) {
      if (r.follow_mode !== 'auto' || !r.due || r.problems.length) continue;
      const res = await advance(r.quote_id, { trigger: 'auto' });
      out.push(res);
      if (res.message.startsWith('Límite diario')) break;
    }
    return out;
  } finally { running = false; }
}

export async function history({ quoteId = null, limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT f.id, f.quote_id, q.number, q.razon_social, f.step, f.to_email, f.subject, f.status, f.error, f.trigger, f.from_state, f.to_state, f.provider, f.created_at, u.name AS sent_by_name
       FROM followup_emails f JOIN quotes q ON q.id=f.quote_id LEFT JOIN users u ON u.id=f.sent_by
      ${quoteId ? 'WHERE f.quote_id=$2' : ''} ORDER BY f.id DESC LIMIT $1`, quoteId ? [limit, Number(quoteId)] : [limit]);
  return rows;
}
