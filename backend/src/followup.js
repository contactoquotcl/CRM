// Seguimiento de cotizaciones por correo: Cotizado → Seguimiento 1 → Seguimiento 2 → Archivado.
// Cada envío queda en `followup_emails` (quién, cuándo, a quién, estado, error) y mueve el lead de etapa.
import { query, getSettings } from './db.js';
import { quotePdfBuffer } from './quoteService.js';
import { mailEnabled, sendMail, mailLabel, gmailThreadHasReply } from './mailer.js';
import { mailConfig } from './config.js';
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

/**
 * El seguimiento se basa en los LEADS del pipeline (no solo en cotizaciones registradas): muchas cotizaciones antiguas solo existen
 * como lead con N° de cotización. Si hay cotización registrada se adjunta su PDF; si no, el correo sale sin adjunto.
 * Se incluyen los leads que tienen N° de cotización o cotización registrada (las derivaciones del bot sin cotizar no son «cotizadas»).
 */
const ROWS_SQL = `
  SELECT l.id AS lead_id, q.id AS quote_id, COALESCE(q.number, l.quote_number) AS number,
         COALESCE(NULLIF(q.razon_social,''), NULLIF(l.razon_social,''), l.client_name) AS razon_social,
         COALESCE(NULLIF(q.contact,''), l.contact) AS contact,
         COALESCE(NULLIF(q.email,''), l.email) AS email,
         COALESCE(q.total, NULLIF(l.total,0), 0) AS total,
         COALESCE(q.quote_date::text, l.lead_date::text, l.state_date::text) AS quote_date,
         COALESCE(q.validity_days, 30) AS validity_days,
         l.follow_mode, l.follow_sched_at, l.follow_sched_step, COALESCE(NULLIF(q.channel,''), l.channel) AS channel,
         s.name AS state_name, l.state_date::text AS state_date,
         (SELECT COUNT(*)::int FROM followup_emails f WHERE f.lead_id=l.id AND f.status='enviado') AS sent_count,
         (SELECT row_to_json(x) FROM (SELECT step, status, error, created_at, trigger FROM followup_emails f WHERE f.lead_id=l.id ORDER BY f.id DESC LIMIT 1) x) AS last_email
    FROM leads l JOIN pipeline_states s ON s.id = l.state_id
    LEFT JOIN LATERAL (SELECT * FROM quotes WHERE lead_id = l.id ORDER BY number DESC LIMIT 1) q ON true
   WHERE lower(s.name) = ANY($1::text[]) AND (q.id IS NOT NULL OR l.quote_number IS NOT NULL) %FILTER%
   ORDER BY COALESCE(q.number, l.quote_number) DESC`;

export async function queue({ channel = 'all' } = {}) {
  const st = await getSettings();
  const names = STEPS.map((s) => s.from.toLowerCase());
  const filter = channel === 'ia' ? "AND (q.channel = 'Chatbot')" : '';
  const { rows } = await query(ROWS_SQL.replace('%FILTER%', filter), [names]);
  const now = today();
  const out = rows.map((r) => {
    const step = stepFrom(r.state_name);
    const days = r.state_date ? Math.max(0, Math.round((Date.parse(now) - Date.parse(r.state_date)) / 86400000)) : 0;
    const need = Number(st[step.daysKey]) || 0;
    const problems = [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email || '')) problems.push('sin correo válido');
    if (r.follow_mode === 'pausado') problems.push('pausada');
    return { ...r, has_pdf: !!r.quote_id, step: step.key, next_label: step.label, to_state: step.to, days_in_state: days, due_in_days: Math.max(0, need - days), due: days >= need, problems };
  });
  const sentToday = (await query("SELECT COUNT(*)::int n FROM followup_emails WHERE status='enviado' AND step <> 'quote' AND created_at::date = CURRENT_DATE")).rows[0].n;
  const hidden = (await query(`SELECT COUNT(*)::int n FROM leads l JOIN pipeline_states s ON s.id=l.state_id WHERE lower(s.name)=ANY($1::text[]) AND l.quote_number IS NULL AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.lead_id=l.id)`, [names])).rows[0].n;
  return { rows: out, hidden_without_quote: hidden, sent_today: sentToday, daily_limit: Number(st.followup_daily_limit) || 0, configured: mailEnabled(), provider: mailLabel(), send_on_archive: st.followup_send_on_archive === '1' };
}

async function load(leadId) {
  const { rows } = await query(ROWS_SQL.replace('%FILTER%', 'AND l.id = $2'), [STEPS.map((s) => s.from.toLowerCase()), Number(leadId)]);
  if (rows[0]) return { ...rows[0], lead_comments: (await query('SELECT comments FROM leads WHERE id=$1', [leadId])).rows[0]?.comments || '' };
  // El lead existe pero no está en una etapa de seguimiento (o no tiene cotización): se informa el motivo
  const l = (await query('SELECT l.id AS lead_id, s.name AS state_name, l.quote_number FROM leads l JOIN pipeline_states s ON s.id=l.state_id WHERE l.id=$1', [Number(leadId)])).rows[0];
  return l ? { ...l, notfollow: true } : null;
}

export function render(q, step, st) {
  const hasTotal = Number(q.total) > 0;
  const v = {
    contacto: (q.contact || '').split(/\s+/)[0] || q.razon_social || 'equipo', empresa: q.razon_social || '', numero: q.number,
    total: hasTotal ? clp(q.total) : '', fecha: q.quote_date ? fmtDate(q.quote_date) : '', vence: q.quote_date ? fmtDate(addDays(q.quote_date, q.validity_days || 30)) : '',
  };
  const key = `followup_${step.key}`;
  let text = fill(st[`${key}_body`], v);
  let subject = fill(st[`${key}_subject`], v);
  // Cotizaciones antiguas sin monto o sin PDF registrado: se quitan las frases que dependen de ello
  if (!hasTotal) text = text.replace(/,?\s*por un total de\s+IVA incluido/g, '').replace(/\s*\(\s*IVA incluido\)/g, '');
  if (!q.quote_id) text = text.replace(/\s*\(adjunta\)/g, '').replace(/[^.\n]*\badjunto\b[^.\n]*\.\s*/g, '');
  if (!q.quote_date) text = text.replace(/,?\s*enviada el\s*\./g, '.').replace(/\s*vigente hasta el\s*(?=[,.])/g, '');
  subject = subject.replace(/\s+vigente hasta el\s*$/, '');
  return { subject, text: text + FOOTER };
}

export async function preview(leadId) {
  const q = await load(leadId);
  if (!q) return null;
  const step = stepFrom(q.state_name);
  if (!step || q.notfollow) return { lead_id: q.lead_id, error: q.notfollow && step ? 'Este lead no tiene cotización (es una derivación sin cotizar).' : `El lead está en "${q.state_name || 'sin etapa'}": no tiene un siguiente seguimiento.` };
  const st = await getSettings();
  const sendsMail = step.key !== 'close' || st.followup_send_on_archive === '1';
  return { lead_id: q.lead_id, number: q.number, to: q.email, step: step.key, label: step.label, to_state: step.to, sends_mail: sendsMail, ...render(q, step, st), attachment: q.quote_id ? `Cotizacion-${q.number}.pdf` : '' };
}

/**
 * Envía el correo de la etapa actual y mueve el lead a la siguiente. Nunca repite un paso ya enviado.
 * @returns {Promise<{lead_id:number, ok:boolean, skipped?:boolean, message:string}>}
 */
export async function advance(leadId, { userId = null, trigger = 'manual' } = {}) {
  const q = await load(leadId);
  const res = (ok, message, extra = {}) => ({ lead_id: Number(leadId), number: q?.number, ok, message, ...extra });
  if (!q) return res(false, 'Lead no encontrado');
  const step = stepFrom(q.state_name);
  if (!step || q.notfollow) return res(false, `Está en "${q.state_name}"${q.notfollow ? ' sin cotización' : ''}: no hay siguiente seguimiento`, { skipped: true });
  if (q.follow_mode === 'pausado') return res(false, 'Seguimiento pausado', { skipped: true });
  const st = await getSettings();
  const wantsMail = step.key !== 'close' || st.followup_send_on_archive === '1';
  const stateId = (await query('SELECT id FROM pipeline_states WHERE lower(name)=lower($1) LIMIT 1', [step.to])).rows[0]?.id;
  if (!stateId) return res(false, `No existe la etapa "${step.to}" en el pipeline`);
  const log = (status, subject, error = '', pid = '', provider = '', thread = '') => query(
    `INSERT INTO followup_emails(quote_id, lead_id, quote_number, step, to_email, subject, status, error, provider, provider_id, trigger, from_state, to_state, sent_by, thread_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [q.quote_id || null, q.lead_id, String(q.number ?? ''), step.key, q.email || '', subject, status, error.slice(0, 500), provider, pid, trigger, step.from, step.to, userId, thread]);
  const move = async (note) => {
    await query('UPDATE leads SET state_id=$1, state_date=$2, comments=$3, updated_at=now() WHERE id=$4',
      [stateId, today(), [q.lead_comments, `[${today()}] ${note}`].filter(Boolean).join('\n'), q.lead_id]);
    await query("UPDATE leads SET follow_sched_at=NULL, follow_sched_step='' WHERE id=$1", [q.lead_id]);
    if (step.key === 'close') await query("UPDATE leads SET follow_mode='manual' WHERE id=$1", [q.lead_id]);
  };
  if (wantsMail) {
    if ((await query("SELECT 1 FROM followup_emails WHERE lead_id=$1 AND step=$2 AND status='enviado'", [q.lead_id, step.key])).rows[0]) return res(false, 'Ese seguimiento ya se envió antes', { skipped: true });
    if (!mailEnabled()) return res(false, 'El correo no está configurado (Admin → Integraciones)');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.email || '')) return res(false, 'El lead no tiene un correo válido', { skipped: true });
    const limit = Number(st.followup_daily_limit) || 0;
    if (limit && (await query("SELECT COUNT(*)::int n FROM followup_emails WHERE status='enviado' AND step <> 'quote' AND created_at::date = CURRENT_DATE")).rows[0].n >= limit) return res(false, `Límite diario de ${limit} correos alcanzado`, { skipped: true });
    const { subject, text } = render(q, step, st);
    try {
      const pdf = q.quote_id ? await quotePdfBuffer(q.quote_id) : null;
      const r = await sendMail({ to: q.email, subject, text, attachments: pdf ? [{ filename: `Cotizacion-${pdf.number}.pdf`, content: pdf.buffer }] : [] });
      await log('enviado', subject, '', r.id, r.provider, r.threadId || '');
      await move(`Correo "${step.label}" enviado a ${q.email} (${{ auto: 'automático', programado: 'programado' }[trigger] || 'manual'}). Etapa: ${step.from} → ${step.to}.`);
      return res(true, `Enviado a ${q.email}${pdf ? '' : ' (sin PDF: cotización antigua sin registro)'}; ahora en ${step.to}`, { to_state: step.to });
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

/**
 * Con Gmail: si el cliente respondió en el hilo del correo de seguimiento, el lead pasa a «Pausado» solo,
 * queda registrado en el historial y en el lead. Sin Gmail no hace nada.
 */
export async function checkReplies() {
  if (mailConfig().provider !== 'gmail' || !mailEnabled()) return [];
  const { rows } = await query(
    `SELECT DISTINCT ON (l.id) l.id AS lead_id, f.quote_id, f.quote_number AS number, f.thread_id, l.comments, f.to_email
       FROM leads l JOIN pipeline_states s ON s.id=l.state_id
       JOIN followup_emails f ON f.lead_id=l.id AND f.status='enviado' AND f.thread_id <> ''
      WHERE l.follow_mode <> 'pausado' AND lower(s.name) IN ('seguimiento 1','seguimiento 2')
      ORDER BY l.id, f.id DESC LIMIT 100`);
  const out = [];
  for (const r of rows) {
    try {
      if (!(await gmailThreadHasReply(r.thread_id))) continue;
    } catch (e) { console.error('[seguimiento] revisión de respuestas falló:', e.message); break; }
    await query("UPDATE leads SET follow_mode='pausado' WHERE id=$1", [r.lead_id]);
    await query("INSERT INTO followup_emails(quote_id, lead_id, quote_number, step, to_email, subject, status, trigger, provider, thread_id) VALUES($1,$2,$3,'reply',$4,'El cliente respondió','respuesta','auto','gmail',$5)", [r.quote_id, r.lead_id, r.number || '', r.to_email || '', r.thread_id]);
    await query('UPDATE leads SET comments=$1, updated_at=now() WHERE id=$2', [[r.comments, `[${today()}] El cliente respondió el correo de seguimiento: seguimiento pausado. Revisar la casilla y contactarlo.`].filter(Boolean).join('\n'), r.lead_id]);
    out.push({ lead_id: r.lead_id, number: r.number });
  }
  return out;
}

/** Programa el envío de la etapa actual para una fecha/hora (solo manuales: el modo automático usa los días de cada etapa). */
export async function schedule(leadIds, at, userId) {
  const when = new Date(at);
  if (Number.isNaN(+when)) throw new Error('Fecha inválida');
  if (when.getTime() < Date.now() + 60 * 1000) throw new Error('La fecha debe ser futura');
  if (when.getTime() > Date.now() + 90 * 86400000) throw new Error('Máximo 90 días hacia adelante');
  const out = [];
  for (const id of leadIds) {
    const q = await load(id);
    const step = q && !q.notfollow ? stepFrom(q.state_name) : null;
    if (!step) { out.push({ lead_id: id, ok: false, message: 'No está en una etapa de seguimiento' }); continue; }
    if (q.follow_mode === 'pausado') { out.push({ lead_id: id, number: q.number, ok: false, message: 'Seguimiento pausado' }); continue; }
    if (step.key !== 'close' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.email || '')) { out.push({ lead_id: id, number: q.number, ok: false, message: 'Sin correo válido' }); continue; }
    await query('UPDATE leads SET follow_sched_at=$1, follow_sched_step=$2, follow_sched_by=$3 WHERE id=$4', [when.toISOString(), step.key, userId, id]);
    out.push({ lead_id: id, number: q.number, ok: true, message: `Programado (${step.label})` });
  }
  return out;
}
export async function unschedule(leadIds) {
  await query("UPDATE leads SET follow_sched_at=NULL, follow_sched_step='' WHERE id = ANY($1::int[])", [leadIds]);
}

/** Envía lo programado que ya llegó a su hora. Si cambió la etapa o se pausó, se cancela. Si se alcanzó el límite diario, queda para el siguiente ciclo. */
export async function runScheduled() {
  const { rows } = await query("SELECT id, follow_sched_step, follow_sched_by, follow_sched_at FROM leads WHERE follow_sched_at IS NOT NULL AND follow_sched_at <= now() ORDER BY follow_sched_at LIMIT 100");
  const out = [];
  for (const r of rows) {
    const q = await load(r.id);
    const step = q && !q.notfollow ? stepFrom(q.state_name) : null;
    if (!step || step.key !== r.follow_sched_step || q.follow_mode === 'pausado') {
      await query("UPDATE leads SET follow_sched_at=NULL, follow_sched_step='' WHERE id=$1", [r.id]);
      out.push({ lead_id: r.id, ok: false, message: 'Programación cancelada: cambió la etapa o está pausado' });
      continue;
    }
    const res = await advance(r.id, { userId: r.follow_sched_by, trigger: 'programado' });
    out.push(res);
    if (res.message.startsWith('Límite diario')) break; // se reintenta en el siguiente ciclo
    if (!res.ok) await query("UPDATE leads SET follow_sched_at=NULL, follow_sched_step='' WHERE id=$1", [r.id]);
  }
  return out;
}

let running = false;
/** Envía los seguimientos automáticos que ya les toca (leads en modo "auto"). */
export async function runAuto({ force = false } = {}) {
  if (running || !mailEnabled()) return [];
  await checkReplies().catch((e) => console.error('[seguimiento] respuestas:', e.message));
  const sched = await runScheduled().catch((e) => { console.error('[seguimiento] programados:', e.message); return []; });
  const st = await getSettings();
  if (!force && st.followup_business_hours !== '0' && !inBusinessHours()) return sched;
  running = true;
  try {
    const { rows } = await queue({ channel: 'all' });
    const out = [...sched];
    for (const r of rows) {
      if (r.follow_mode !== 'auto' || !r.due || r.problems.length) continue;
      const res = await advance(r.lead_id, { trigger: 'auto' });
      out.push(res);
      if (res.message.startsWith('Límite diario')) break;
    }
    return out;
  } finally { running = false; }
}

export async function history({ leadId = null, limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT f.id, f.lead_id, f.quote_number AS number, COALESCE(NULLIF(l.razon_social,''), l.client_name) AS razon_social, f.step, f.to_email, f.subject, f.status, f.error, f.trigger, f.from_state, f.to_state, f.provider, f.created_at, u.name AS sent_by_name
       FROM followup_emails f LEFT JOIN leads l ON l.id=f.lead_id LEFT JOIN users u ON u.id=f.sent_by
      ${leadId ? 'WHERE f.lead_id=$2' : ''} ORDER BY f.id DESC LIMIT $1`, leadId ? [limit, Number(leadId)] : [limit]);
  return rows;
}

/**
 * Envía al cliente, por correo y con el PDF adjunto, una cotización recién generada (p. ej. por el bot).
 * Nunca lanza: devuelve { ok, to?, message }. No repite el envío de una misma cotización.
 */
export async function sendQuoteEmail(quoteId, { trigger = 'bot' } = {}) {
  try {
    const st = await getSettings();
    if (st.quote_mail_enabled === '0') return { ok: false, message: 'Envío automático desactivado' };
    const q = (await query('SELECT id, number, lead_id, quote_date::text AS quote_date, validity_days, razon_social, contact, email, total FROM quotes WHERE id=$1', [Number(quoteId)])).rows[0];
    if (!q) return { ok: false, message: 'Cotización no encontrada' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.email || '')) return { ok: false, message: 'La cotización no tiene un correo válido' };
    if ((await query("SELECT 1 FROM followup_emails WHERE quote_id=$1 AND step='quote' AND status='enviado'", [q.id])).rows[0]) return { ok: false, skipped: true, message: 'Ya se envió' };
    const v = { contacto: (q.contact || '').split(/\s+/)[0] || q.razon_social || 'equipo', empresa: q.razon_social || '', numero: q.number, total: clp(q.total), fecha: fmtDate(q.quote_date), vence: fmtDate(addDays(q.quote_date, q.validity_days || 30)) };
    const subject = fill(st.quote_mail_subject, v);
    const text = fill(st.quote_mail_body, v);
    const log = (status, error = '', pid = '', provider = '', thread = '') => query(
      `INSERT INTO followup_emails(quote_id, lead_id, quote_number, step, to_email, subject, status, error, provider, provider_id, trigger, from_state, to_state, thread_id)
       VALUES($1,$2,$3,'quote',$4,$5,$6,$7,$8,$9,$10,'','',$11)`,
      [q.id, q.lead_id, String(q.number), q.email, subject, status, error.slice(0, 500), provider, pid, trigger, thread]);
    if (!mailEnabled()) { await log('error', 'El correo no está configurado (Admin → Integraciones)'); return { ok: false, message: 'Correo no configurado' }; }
    try {
      const pdf = await quotePdfBuffer(q.id);
      const r = await sendMail({ to: q.email, subject, text, attachments: pdf ? [{ filename: `Cotizacion-${pdf.number}.pdf`, content: pdf.buffer }] : [] });
      await log('enviado', '', r.id || '', r.provider || '', r.threadId || '');
      return { ok: true, to: q.email, message: 'Enviada' };
    } catch (e) {
      await log('error', e.message);
      return { ok: false, message: e.message };
    }
  } catch (e) {
    console.error('[cotización] envío por correo falló:', e.message);
    return { ok: false, message: e.message };
  }
}
