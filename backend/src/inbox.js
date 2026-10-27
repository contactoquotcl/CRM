// Servicio de conversaciones: guarda todo en Postgres (fuente de la bandeja del CRM) y, si Chatwoot está
// configurado, lo refleja allí (motor de mensajería). Sin Chatwoot funciona en modo local.
import { query } from './db.js';
import { crmPublicUrl } from './config.js';
import * as cw from './chatwoot.js';
import { HttpError, formatRut, today, validRut, clp } from './util.js';
import { hashPassword } from './auth.js';
import crypto from 'node:crypto';

const warn = (...a) => console.warn('[inbox]', ...a);
const preview = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
const STATUSES = ['pending', 'open', 'resolved', 'snoozed'];

export async function getBotUserId() {
  const email = 'bot@quot.invalid';
  const ex = await query('SELECT id FROM users WHERE email=$1', [email]);
  if (ex.rows[0]) return ex.rows[0].id;
  // Usuario técnico: inactivo (no puede iniciar sesión ni recibe conversaciones) solo para atribuir lo que crea el bot.
  const r = await query("INSERT INTO users(email,name,password_hash,role,active) VALUES($1,'Bot',$2,'user',FALSE) RETURNING id", [email, hashPassword(crypto.randomBytes(24).toString('hex'))]);
  return r.rows[0].id;
}

export async function getConversation(id) {
  const { rows } = await query(CONV_SELECT + ' WHERE c.id=$1', [Number(id)]);
  return rows[0] || null;
}

export const CONV_SELECT = `
  SELECT c.id, c.chatwoot_id, c.session_id, c.status, c.assignee_id, c.channel, c.contact_name, c.contact_email,
         c.contact_phone, c.contact_rut, c.contact_company, c.lead_id, c.labels, c.handoff_reason, c.unread_count,
         c.last_message_at, c.last_message_preview, c.created_at, c.updated_at, u.name AS assignee_name
  FROM conversations c LEFT JOIN users u ON u.id = c.assignee_id`;

// ------------------------------------------------------------------ mensajes
export async function addMessage(convId, m) {
  const { rows } = await query(
    `INSERT INTO conversation_messages(conversation_id, chatwoot_message_id, direction, sender_type, sender_name, content, is_private, created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now())) RETURNING *`,
    [convId, m.chatwootMessageId ?? null, m.direction, m.senderType, m.senderName || '', String(m.content || ''), !!m.isPrivate, m.createdAt || null]
  );
  const unread = m.direction === 'in' && !m.isPrivate ? 1 : 0;
  await query('UPDATE conversations SET unread_count=unread_count+$2, updated_at=now() WHERE id=$1', [convId, unread]);
  if (!m.isPrivate) {
    await query('UPDATE conversations SET last_message_at=COALESCE($2::timestamptz, now()), last_message_preview=$3 WHERE id=$1', [convId, m.createdAt || null, preview(m.content)]);
  }
  return rows[0];
}

// Envía un mensaje ya guardado a Chatwoot. Marca el id de Chatwoot si sale bien.
async function pushToChatwoot(conv, msg) {
  if (!cw.chatwootEnabled() || !conv.chatwoot_id || msg.chatwoot_message_id) return false;
  const r = await cw.postMessage(conv.chatwoot_id, {
    content: msg.content,
    incoming: msg.direction === 'in',
    isPrivate: msg.is_private,
    sourceId: `crm:${msg.id}`,
  });
  if (r?.id) await query('UPDATE conversation_messages SET chatwoot_message_id=$1 WHERE id=$2 AND chatwoot_message_id IS NULL', [r.id, msg.id]).catch(() => {});
  return true;
}

// ------------------------------------------------------------------ conversación del bot ↔ Chatwoot
async function linkChatwoot(conv, session) {
  if (!cw.chatwootEnabled() || conv.chatwoot_id) return conv;
  try {
    const contact = await cw.createContact({
      name: session.customer_name || `Visitante web ${session.id.slice(0, 6)}`,
      email: session.customer_email || undefined,
      phone: session.customer_phone || undefined,
      identifier: `crm-session:${session.id}`,
      custom_attributes: { crm_session: session.id, rut: session.customer_rut || '', razon_social: session.customer_company || '' },
    });
    const c = await cw.createConversation({ contactId: contact.id, status: 'pending', additional_attributes: { crm_conversation_id: conv.id } });
    await query('UPDATE conversations SET chatwoot_id=$1 WHERE id=$2', [c.id, conv.id]);
    conv = { ...conv, chatwoot_id: c.id };
    // Reenvía lo que se guardó mientras Chatwoot no estaba enlazado
    const pend = await query('SELECT * FROM conversation_messages WHERE conversation_id=$1 AND chatwoot_message_id IS NULL ORDER BY id', [conv.id]);
    for (const m of pend.rows) await pushToChatwoot(conv, m).catch((e) => warn('no se pudo reenviar mensaje', e.message));
  } catch (e) {
    warn('no se pudo crear la conversación en Chatwoot:', e.message);
  }
  return conv;
}

export async function ensureConversation(session) {
  if (session.conversation_id) {
    let conv = await getConversation(session.conversation_id);
    if (conv && !conv.chatwoot_id) conv = await linkChatwoot(conv, session);
    return conv;
  }
  const { rows } = await query(
    `INSERT INTO conversations(session_id, status, channel, contact_name, contact_email, contact_phone, contact_rut, contact_company)
     VALUES($1,'pending','Chatbot',$2,$3,$4,$5,$6) RETURNING id`,
    [session.id, session.customer_name, session.customer_email, session.customer_phone, session.customer_rut, session.customer_company]
  );
  await query('UPDATE chat_sessions SET conversation_id=$1 WHERE id=$2', [rows[0].id, session.id]);
  session.conversation_id = rows[0].id;
  return linkChatwoot(await getConversation(rows[0].id), session);
}

/** Refleja un mensaje del widget (cliente o bot) en la bandeja y en Chatwoot. role: 'user' | 'assistant' */
export async function mirrorMessage(session, role, text) {
  const conv = await ensureConversation(session);
  const msg = await addMessage(conv.id, {
    direction: role === 'user' ? 'in' : 'out',
    senderType: role === 'user' ? 'contact' : 'bot',
    senderName: role === 'user' ? session.customer_name || 'Cliente' : 'Asistente Quot',
    content: text,
  });
  await pushToChatwoot(conv, msg).catch((e) => warn('Chatwoot no recibió el mensaje:', e.message));
  return conv;
}

// ------------------------------------------------------------------ derivación a ejecutivo
async function pickAgent() {
  const { rows } = await query("SELECT id, name, email FROM users WHERE active AND role IN ('admin','user') ORDER BY id");
  if (!rows.length) return null;
  const last = Number((await query("SELECT value FROM settings WHERE key='handoff_last_user_id'")).rows[0]?.value || 0);
  const next = rows.find((u) => u.id > last) || rows[0];
  await query("INSERT INTO settings(key,value) VALUES('handoff_last_user_id',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [String(next.id)]);
  return next;
}

async function upsertLead(session, conv, { motivo, resumen }) {
  const name = session.customer_company || session.customer_name || session.customer_email || session.customer_phone;
  if (!name) return null;
  const rut = session.customer_rut ? formatRut(session.customer_rut) : '';
  let lead = null;
  if (rut) lead = (await query('SELECT id, comments FROM leads WHERE rut=$1 ORDER BY id DESC LIMIT 1', [rut])).rows[0];
  if (!lead && session.customer_email) lead = (await query('SELECT id, comments FROM leads WHERE lower(email)=lower($1) ORDER BY id DESC LIMIT 1', [session.customer_email])).rows[0];
  const note = `[Chatbot ${today()}] Derivado a ejecutivo (${motivo}). ${resumen}`.trim();
  if (lead) {
    await query('UPDATE leads SET comments=$1, updated_at=now() WHERE id=$2', [[lead.comments, note].filter(Boolean).join('\n'), lead.id]);
    return lead.id;
  }
  // Estado del lead de una derivación: CHATBOT_HANDOFF_LEAD_STATE (por nombre) o, si no existe, el estado inicial.
  const wanted = (process.env.CHATBOT_HANDOFF_LEAD_STATE || '').trim();
  let st = wanted ? await query('SELECT id FROM pipeline_states WHERE lower(name)=lower($1) LIMIT 1', [wanted]) : { rows: [] };
  if (!st.rows[0]) st = await query('SELECT id FROM pipeline_states WHERE is_initial LIMIT 1');
  const botId = await getBotUserId();
  const r = await query(
    `INSERT INTO leads(client_name, rut, razon_social, email, contact, phone, channel, state_id, state_date, lead_date, comments, created_by)
     VALUES($1,$2,$10,$3,$4,$5,'Chatbot',$6,$7,$7,$8,$9) RETURNING id`,
    [name, rut, session.customer_email, session.customer_name, session.customer_phone, st.rows[0]?.id ?? null, today(), note, botId, session.customer_company]
  );
  return r.rows[0].id;
}

export async function handoff(session, { motivo = 'otro', resumen = '', transcript = [], spam = false } = {}) {
  const conv = await ensureConversation(session);
  await query("UPDATE chat_sessions SET status='handoff' WHERE id=$1", [session.id]);
  session.status = 'handoff';

  // Posible spam: no se asigna a nadie por turno (queda "sin asignar") y no se crea lead.
  const agent = spam ? null : await pickAgent();
  const leadId = spam ? null : await upsertLead(session, conv, { motivo, resumen });
  await query(
    `UPDATE conversations SET status='open', assignee_id=$2, lead_id=COALESCE($3, lead_id), handoff_reason=$4,
       labels = CASE WHEN labels LIKE '%derivado%' THEN labels ELSE trim(both ',' from labels || ',derivado') END || CASE WHEN $10::boolean AND labels NOT LIKE '%posible_spam%' THEN ',posible_spam' ELSE '' END,
       contact_name=$5, contact_email=$6, contact_phone=$7, contact_rut=$8, contact_company=$9,
       unread_count=GREATEST(unread_count,1), updated_at=now() WHERE id=$1`,
    [conv.id, agent?.id ?? null, leadId, `${motivo}: ${resumen}`.slice(0, 500), session.customer_name, session.customer_email, session.customer_phone, session.customer_rut, session.customer_company, spam]
  );

  // Carrito y cotización de esta conversación para la nota del ejecutivo
  const cartRow = (await query("SELECT items, subtotal, status, quote_id FROM carts WHERE session_id=$1 ORDER BY id DESC LIMIT 1", [session.id])).rows[0];
  const quoteRow = (await query('SELECT number, total FROM quotes WHERE conversation_id=$1 ORDER BY id DESC LIMIT 1', [conv.id])).rows[0];
  let cartLine = '';
  if (cartRow) {
    let its = [];
    try { its = JSON.parse(cartRow.items); } catch { /* ignorar */ }
    cartLine = `Carrito: ${its.map((i) => `${i.cantidad}x ${i.sku}`).join(', ') || '(vacío)'} · subtotal neto ${clp(cartRow.subtotal)}${cartRow.status === 'quoted' ? ' (cotizado)' : ''}`;
  }
  const base = crmPublicUrl();
  const lines = [
    spam ? '⚠️ Posible spam detectado por el chatbot' : '🤖➜👤 Derivación desde el chatbot',
    `Motivo: ${motivo}`,
    `Resumen: ${resumen || '(sin resumen)'}`,
    `Cliente: ${[session.customer_company, session.customer_rut && `RUT ${session.customer_rut}`, session.customer_name && `Contacto: ${session.customer_name}`, session.customer_email, session.customer_phone].filter(Boolean).join(' · ') || '(sin datos de contacto)'}`,
    cartLine,
    quoteRow ? `Cotización generada: N° ${quoteRow.number} por ${clp(quoteRow.total)} con IVA` : '',
    transcript.length ? '\nÚltimos mensajes:\n' + transcript.map((m) => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${preview(m.content)}`).join('\n') : '',
    base ? `\nCRM: ${base}/conversaciones?c=${conv.id}` : '',
  ].filter(Boolean);
  const note = await addMessage(conv.id, { direction: 'out', senderType: 'system', senderName: 'Sistema', content: lines.join('\n'), isPrivate: true });

  let chatwootSynced = !cw.chatwootEnabled() || !conv.chatwoot_id;
  if (cw.chatwootEnabled() && conv.chatwoot_id) {
    try {
      await cw.setStatus(conv.chatwoot_id, 'open');
      if (agent) {
        const agentId = await cw.findAgentIdByEmail(agent.email);
        if (agentId) await cw.assign(conv.chatwoot_id, agentId);
        else warn(`El usuario ${agent.email} no existe como agente en Chatwoot; asignado solo en el CRM`);
      }
      await pushToChatwoot(conv, note);
      await cw.setLabels(conv.chatwoot_id, spam ? ['derivado', 'posible_spam'] : ['derivado']).catch(() => {});
      chatwootSynced = true;
    } catch (e) {
      warn('derivación: fallo parcial en Chatwoot:', e.message);
    }
  }
  return { conversation_id: conv.id, lead_id: leadId, assignee: agent ? { id: agent.id, name: agent.name } : null, chatwoot_synced: chatwootSynced };
}

// ------------------------------------------------------------------ acciones del ejecutivo (bandeja del CRM)
export async function sendAgentMessage(user, convId, { content, isPrivate = false }) {
  const text = String(content || '').trim();
  if (!text) throw new HttpError(400, 'El mensaje está vacío');
  if (text.length > 4000) throw new HttpError(400, 'El mensaje es demasiado largo (máx. 4000)');
  const conv = await getConversation(convId);
  if (!conv) throw new HttpError(404, 'Conversación no encontrada');
  const msg = await addMessage(conv.id, { direction: 'out', senderType: 'agent', senderName: user.name, content: text, isPrivate });
  try {
    await pushToChatwoot(conv, msg);
  } catch (e) {
    await query('DELETE FROM conversation_messages WHERE id=$1', [msg.id]);
    throw new HttpError(502, `No se pudo enviar por Chatwoot: ${e.message}`);
  }
  if (!isPrivate) {
    if (conv.session_id) await query("INSERT INTO chat_messages(session_id, role, content) VALUES($1,'agent',$2)", [conv.session_id, text]);
    // Responder toma la conversación si estaba libre o con el bot
    if (!conv.assignee_id || conv.status === 'pending') {
      await query("UPDATE conversations SET status='open', assignee_id=COALESCE(assignee_id,$2), unread_count=0, updated_at=now() WHERE id=$1", [conv.id, user.id]);
      if (cw.chatwootEnabled() && conv.chatwoot_id && conv.status === 'pending') await cw.setStatus(conv.chatwoot_id, 'open').catch((e) => warn(e.message));
    }
  }
  return msg;
}

export async function assignConversation(convId, userId) {
  const conv = await getConversation(convId);
  if (!conv) throw new HttpError(404, 'Conversación no encontrada');
  let user = null;
  if (userId) {
    user = (await query('SELECT id, name, email, active FROM users WHERE id=$1', [Number(userId)])).rows[0];
    if (!user || !user.active) throw new HttpError(400, 'Usuario inválido o inactivo');
  }
  if (cw.chatwootEnabled() && conv.chatwoot_id) {
    try {
      const agentId = user ? await cw.findAgentIdByEmail(user.email) : null;
      if (!user || agentId) await cw.assign(conv.chatwoot_id, agentId);
    } catch (e) {
      throw new HttpError(502, `No se pudo asignar en Chatwoot: ${e.message}`);
    }
  }
  await query('UPDATE conversations SET assignee_id=$2, updated_at=now() WHERE id=$1', [conv.id, user?.id ?? null]);
  return getConversation(conv.id);
}

export async function setConversationStatus(convId, status) {
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Estado inválido');
  const conv = await getConversation(convId);
  if (!conv) throw new HttpError(404, 'Conversación no encontrada');
  if (cw.chatwootEnabled() && conv.chatwoot_id) {
    try { await cw.setStatus(conv.chatwoot_id, status); } catch (e) { throw new HttpError(502, `No se pudo cambiar el estado en Chatwoot: ${e.message}`); }
  }
  await query('UPDATE conversations SET status=$2, updated_at=now() WHERE id=$1', [conv.id, status]);
  return getConversation(conv.id);
}

// ------------------------------------------------------------------ webhooks de Chatwoot → CRM
const mapStatus = (s) => (STATUSES.includes(s) ? s : null);
const msgType = (t) => (t === 0 || t === 'incoming' ? 'incoming' : t === 1 || t === 'outgoing' ? 'outgoing' : 'other');

async function userIdByEmail(email) {
  if (!email) return null;
  return (await query('SELECT id FROM users WHERE lower(email)=lower($1) AND active', [email])).rows[0]?.id ?? null;
}

async function upsertFromChatwoot(c, inbox) {
  if (!c?.id) return null;
  const meta = c.meta || {};
  const status = mapStatus(c.status);
  const labels = Array.isArray(c.labels) ? c.labels.join(',') : null;
  const ex = (await query('SELECT id FROM conversations WHERE chatwoot_id=$1', [Number(c.id)])).rows[0];
  const sender = meta.sender || {};
  const assigneeKnown = 'assignee' in meta;
  const assigneeId = assigneeKnown ? await userIdByEmail(meta.assignee?.email) : undefined;
  if (ex) {
    const sets = [];
    const vals = [ex.id];
    const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (status) add('status', status);
    if (assigneeKnown) add('assignee_id', assigneeId ?? null);
    if (labels !== null) add('labels', labels);
    if (sender.name) add('contact_name', sender.name);
    if (sender.email) add('contact_email', sender.email);
    if (sender.phone_number) add('contact_phone', sender.phone_number);
    if (sets.length) await query(`UPDATE conversations SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, vals);
    return ex.id;
  }
  const r = await query(
    `INSERT INTO conversations(chatwoot_id, status, assignee_id, channel, contact_name, contact_email, contact_phone, labels)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [Number(c.id), status || 'open', assigneeId ?? null, inbox?.name || 'Chatwoot', sender.name || '', sender.email || '', sender.phone_number || '', labels || '']
  );
  return r.rows[0].id;
}

export async function handleChatwootEvent(evt) {
  const ev = evt?.event;
  if (ev === 'message_created') {
    const type = msgType(evt.message_type);
    if (type === 'other') return { ignored: 'activity' };
    const convId = await upsertFromChatwoot(evt.conversation, evt.inbox);
    if (!convId || !evt.id) return { ignored: 'sin conversación' };
    const dup = await query('SELECT id FROM conversation_messages WHERE chatwoot_message_id=$1', [Number(evt.id)]);
    if (dup.rows[0]) return { duplicate: true };
    const src = String(evt.source_id || '');
    if (src.startsWith('crm:')) { // eco de un mensaje que originó el CRM: solo enlaza el id
      await query('UPDATE conversation_messages SET chatwoot_message_id=$1 WHERE id=$2 AND conversation_id=$3 AND chatwoot_message_id IS NULL', [Number(evt.id), Number(src.slice(4)), convId]);
      return { echo: true };
    }
    const senderType = type === 'incoming' ? 'contact' : evt.sender?.type === 'agent_bot' ? 'bot' : 'agent';
    await addMessage(convId, {
      chatwootMessageId: Number(evt.id),
      direction: type === 'incoming' ? 'in' : 'out',
      senderType,
      senderName: evt.sender?.name || '',
      content: evt.content || '',
      isPrivate: !!evt.private,
      createdAt: evt.created_at && !Number.isNaN(Date.parse(evt.created_at)) ? evt.created_at : null,
    });
    if (type === 'outgoing' && !evt.private && senderType === 'agent') {
      const conv = await getConversation(convId);
      if (conv?.session_id && evt.content) await query("INSERT INTO chat_messages(session_id, role, content) VALUES($1,'agent',$2)", [conv.session_id, String(evt.content)]);
    }
    return { stored: true };
  }
  if (ev === 'conversation_created' || ev === 'conversation_updated' || ev === 'conversation_status_changed') {
    const id = await upsertFromChatwoot(evt, evt.inbox);
    return { conversation: id };
  }
  return { ignored: ev || 'sin evento' };
}

// ------------------------------------------------------------------ consultas con permisos
const visibility = (user, params) => {
  if (user.role === 'admin') return '';
  params.push(user.id);
  return ` AND (c.assignee_id = $${params.length} OR c.assignee_id IS NULL)`;
};

export async function listConversations(user, { filter = 'all', label = '', q = '' } = {}) {
  const params = [];
  let where = 'WHERE TRUE' + visibility(user, params);
  if (filter === 'mine') { params.push(user.id); where += ` AND c.assignee_id = $${params.length}`; }
  else if (filter === 'unassigned') where += " AND c.assignee_id IS NULL AND c.status <> 'resolved'";
  else if (filter === 'bot') where += " AND c.status = 'pending'";
  else if (filter === 'open') where += " AND c.status = 'open'";
  else if (filter === 'resolved') where += " AND c.status = 'resolved'";
  if (label) { params.push(`%${String(label).toLowerCase()}%`); where += ` AND lower(c.labels) LIKE $${params.length}`; }
  if (q) { params.push(`%${String(q).toLowerCase()}%`); where += ` AND (lower(c.contact_name) LIKE $${params.length} OR lower(c.contact_email) LIKE $${params.length} OR lower(c.contact_rut) LIKE $${params.length} OR lower(c.contact_company) LIKE $${params.length} OR lower(c.last_message_preview) LIKE $${params.length})`; }
  const { rows } = await query(`${CONV_SELECT} ${where} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT 300`, params);
  return rows;
}

export async function getVisible(user, id) {
  const conv = await getConversation(id);
  if (!conv) throw new HttpError(404, 'Conversación no encontrada');
  if (user.role !== 'admin' && conv.assignee_id && conv.assignee_id !== user.id) throw new HttpError(403, 'Esta conversación está asignada a otro ejecutivo');
  return conv;
}

export async function unreadCount(user) {
  const { rows } = await query("SELECT COUNT(*)::int AS n FROM conversations c WHERE c.unread_count > 0 AND c.status='open' AND (c.assignee_id = $1 OR c.assignee_id IS NULL)", [user.id]);
  return rows[0].n;
}
