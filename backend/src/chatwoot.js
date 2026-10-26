import crypto from 'node:crypto';
import { chatwootConfig } from './config.js';

export const chatwootEnabled = () => {
  const c = chatwootConfig();
  return !!(c.baseUrl && c.accountId && c.token && c.inboxId);
};

async function cw(method, path, body) {
  const c = chatwootConfig();
  const res = await fetch(`${c.baseUrl}/api/v1/accounts/${c.accountId}${path}`, {
    method,
    headers: { api_access_token: c.token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(c.timeoutMs),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Chatwoot ${method} ${path} → ${res.status} ${t.slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export async function createContact({ name, email, phone, identifier, custom_attributes }) {
  const c = chatwootConfig();
  const body = { inbox_id: Number(c.inboxId), name: name || 'Visitante web', identifier, custom_attributes };
  if (email) body.email = email;
  if (phone) body.phone_number = phone.startsWith('+') ? phone : undefined;
  const r = await cw('POST', '/contacts', body);
  return r.payload?.contact || r.contact || r; // distintas versiones devuelven formas distintas
}

export async function updateContact(id, fields) {
  return cw('PUT', `/contacts/${Number(id)}`, fields);
}

export async function createConversation({ contactId, status = 'pending', additional_attributes }) {
  const c = chatwootConfig();
  return cw('POST', '/conversations', { inbox_id: Number(c.inboxId), contact_id: Number(contactId), status, additional_attributes });
}

export async function postMessage(conversationId, { content, incoming = false, isPrivate = false, sourceId }) {
  return cw('POST', `/conversations/${Number(conversationId)}/messages`, {
    content,
    message_type: incoming ? 'incoming' : 'outgoing',
    private: !!isPrivate,
    ...(sourceId ? { source_id: sourceId } : {}),
  });
}

export const setStatus = (conversationId, status) => cw('POST', `/conversations/${Number(conversationId)}/toggle_status`, { status });
export const assign = (conversationId, agentId) => cw('POST', `/conversations/${Number(conversationId)}/assignments`, { assignee_id: agentId ? Number(agentId) : null });
export const setLabels = (conversationId, labels) => cw('POST', `/conversations/${Number(conversationId)}/labels`, { labels });

let agentCache = { at: 0, list: [] };
export async function findAgentIdByEmail(email) {
  if (!email) return null;
  if (Date.now() - agentCache.at > 5 * 60 * 1000) {
    const list = await cw('GET', '/agents');
    agentCache = { at: Date.now(), list: Array.isArray(list) ? list : list.payload || [] };
  }
  return agentCache.list.find((a) => String(a.email || '').toLowerCase() === String(email).toLowerCase())?.id ?? null;
}
export const resetAgentCache = () => { agentCache = { at: 0, list: [] }; };

const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Verifica un webhook de Chatwoot. Acepta:
 *  - Firma HMAC (Chatwoot ≥ 4.x): X-Chatwoot-Signature = "sha256=" + HMAC(secret, "<X-Chatwoot-Timestamp>.<cuerpo>") con ventana de 5 min.
 *  - Token en la URL (?token=SECRETO) para versiones sin firma.
 * Si no hay secreto configurado, rechaza todo (falla cerrado).
 */
export function verifyChatwootWebhook({ rawBody, headers, query }) {
  const secret = chatwootConfig().webhookSecret;
  if (!secret) return false;
  const sig = headers['x-chatwoot-signature'];
  const ts = headers['x-chatwoot-timestamp'];
  if (sig && ts) {
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex');
    return safeEq(sig, expected);
  }
  return !!query?.token && safeEq(query.token, secret);
}

/** Prueba de conexión: lee la bandeja configurada. */
export async function chatwootPing() {
  const c = chatwootConfig();
  const r = await cw('GET', `/inboxes/${encodeURIComponent(c.inboxId)}`);
  return { inbox: r.name || r.payload?.name || `#${c.inboxId}`, channel: r.channel_type || '' };
}
