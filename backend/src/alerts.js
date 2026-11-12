// Alertas por correo: avisa a contacto@quot.cl cuando una conversación derivada (o una tarea pendiente del bot)
// lleva varios minutos sin que un ejecutivo la atienda.
import { query, getSettings } from './db.js';
import { sendMail, mailEnabled } from './mailer.js';
import { crmPublicUrl } from './config.js';

const clip = (t, n = 200) => String(t || '').replace(/\s+/g, ' ').slice(0, n);

async function lastMessages(convId) {
  const { rows } = await query("SELECT sender_type, content FROM conversation_messages WHERE conversation_id=$1 AND NOT is_private ORDER BY id DESC LIMIT 6", [convId]);
  return rows.reverse().map((m) => `${m.sender_type === 'contact' ? 'Cliente' : m.sender_type === 'bot' ? 'Bot' : 'Ejecutivo'}: ${clip(m.content)}`).join('\n');
}

function body({ kind, c, mins, transcript }) {
  const base = crmPublicUrl();
  const cliente = [c.contact_company, c.contact_rut && `RUT ${c.contact_rut}`, c.contact_name, c.contact_email, c.contact_phone].filter(Boolean).join(' · ') || '(sin datos de contacto)';
  return [
    kind === 'derivada'
      ? `Una conversación fue derivada a un ejecutivo hace ${mins} min y nadie la ha atendido.`
      : `El bot dejó una tarea pendiente hace ${mins} min (pidió datos al cliente para derivarlo) y la conversación sigue sin resolverse.`,
    `Motivo: ${clip(c.handoff_reason || c.pending || '(sin motivo)', 300)}`,
    `Cliente: ${cliente}`,
    c.assignee ? `Asignada a: ${c.assignee}` : 'Sin ejecutivo asignado',
    transcript ? `Últimos mensajes:\n${transcript}` : '',
    base && c.id ? `Abrir en el CRM: ${base}/conversaciones?c=${c.id}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Revisa y envía las alertas vencidas. Devuelve la lista de alertas enviadas. */
export async function runAlerts() {
  const st = await getSettings();
  if (st.alert_enabled === '0') return [];
  const to = (st.alert_email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !mailEnabled()) return [];
  const mins = Math.max(1, Number(st.alert_minutes) || 3);
  const out = [];

  // 1) Derivadas sin respuesta de un ejecutivo (excluye posible spam).
  const derived = await query(
    `SELECT c.*, u.name AS assignee FROM conversations c LEFT JOIN users u ON u.id=c.assignee_id
      WHERE c.status IN ('open','pending') AND c.handoff_at IS NOT NULL AND c.alerted_at IS NULL
        AND c.handoff_at <= now() - ($1 || ' minutes')::interval AND c.labels NOT LIKE '%posible_spam%'
        AND NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id=c.id AND m.sender_type='agent' AND NOT m.is_private AND m.created_at >= c.handoff_at)`,
    [String(mins)]
  );
  for (const c of derived.rows) {
    const waited = Math.max(mins, Math.round((Date.now() - new Date(c.handoff_at)) / 60000));
    const who = c.contact_company || c.contact_name || `conversación #${c.id}`;
    try {
      await sendMail({ to, subject: `⚠️ Conversación requiere atención: ${who}`, text: body({ kind: 'derivada', c, mins: waited, transcript: await lastMessages(c.id) }) });
      await query('UPDATE conversations SET alerted_at=now() WHERE id=$1', [c.id]);
      out.push({ kind: 'derivada', conversation_id: c.id });
    } catch (e) { console.error('[alertas] no se pudo enviar:', e.message); }
  }

  // 2) Tareas pendientes del bot (pidió datos para derivar y el cliente no respondió).
  const pend = await query(
    `SELECT s.id AS sid, s.pending_handoff AS pending, s.pending_at, s.conversation_id,
            c.id, c.contact_name, c.contact_email, c.contact_phone, c.contact_rut, c.contact_company, c.handoff_reason, c.assignee_id, c.status
       FROM chat_sessions s LEFT JOIN conversations c ON c.id=s.conversation_id
      WHERE s.status='bot' AND s.pending_handoff <> '' AND s.pending_alerted_at IS NULL
        AND s.pending_at <= now() - ($1 || ' minutes')::interval`,
    [String(mins)]
  );
  for (const r of pend.rows) {
    const c = { ...r, contact_name: r.contact_name || '', handoff_reason: '' };
    const waited = Math.max(mins, Math.round((Date.now() - new Date(r.pending_at)) / 60000));
    const who = r.contact_company || r.contact_name || (r.id ? `conversación #${r.id}` : 'visitante del chat');
    try {
      await sendMail({ to, subject: `⚠️ Tarea pendiente del bot: ${who}`, text: body({ kind: 'pendiente', c, mins: waited, transcript: r.id ? await lastMessages(r.id) : '' }) });
      await query('UPDATE chat_sessions SET pending_alerted_at=now() WHERE id=$1', [r.sid]);
      out.push({ kind: 'pendiente', conversation_id: r.id });
    } catch (e) { console.error('[alertas] no se pudo enviar:', e.message); }
  }
  return out;
}
