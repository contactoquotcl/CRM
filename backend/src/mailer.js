// Envío de correo: Resend (API HTTPS) o SMTP. Render gratis bloquea SMTP, por eso Resend es la opción recomendada.
import { mailConfig } from './config.js';

export function mailEnabled() {
  const c = mailConfig();
  if (c.provider === 'gmail') return !!c.gmailClientId && !!c.gmailClientSecret && !!c.gmailRefreshToken && !!c.fromEmail;
  if (c.provider === 'resend') return !!c.resendKey && !!c.fromEmail;
  if (c.provider === 'smtp') return !!c.smtpHost && !!c.fromEmail;
  return false;
}
export const mailLabel = () => ({ gmail: 'Gmail', resend: 'Resend', smtp: 'SMTP' }[mailConfig().provider] || 'sin configurar');

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const textToHtml = (t) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${String(t).split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;

// ---- Gmail API (OAuth con refresh token; solo HTTPS)
let gToken = { value: '', exp: 0, key: '' };
async function gmailAccessToken() {
  const c = mailConfig();
  const key = `${c.gmailClientId}|${c.gmailRefreshToken}`;
  if (gToken.key === key && gToken.exp > Date.now() + 60000) return gToken.value;
  const r = await fetch(c.googleTokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ client_id: c.gmailClientId, client_secret: c.gmailClientSecret, refresh_token: c.gmailRefreshToken, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google rechazó las credenciales (${j.error_description || j.error || r.status}). Revisa ID de cliente, secreto y refresh token.`);
  gToken = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, key };
  return gToken.value;
}
async function gmailFetch(path, init = {}) {
  const c = mailConfig();
  const r = await fetch(`${c.gmailApiUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${await gmailAccessToken()}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${j.error?.message || 'error'}`);
  return j;
}
/** ¿Respondió el cliente en el hilo? (algún mensaje que no sea de nuestra casilla) */
export async function gmailThreadHasReply(threadId) {
  const c = mailConfig();
  const j = await gmailFetch(`/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From`);
  return (j.messages || []).some((m) => {
    const from = ((m.payload?.headers || []).find((h) => h.name.toLowerCase() === 'from') || {}).value || '';
    return !from.toLowerCase().includes(c.fromEmail.toLowerCase()) && !(m.labelIds || []).includes('SENT');
  });
}

/** @param {{to:string, subject:string, text:string, attachments?:{filename:string, content:Buffer}[]}} m  @returns {Promise<{id:string, provider:string}>} */
export async function sendMail(m) {
  const c = mailConfig();
  if (!mailEnabled()) throw new Error('El correo no está configurado (Admin → Integraciones → Correo de seguimiento)');
  const from = `${c.fromName} <${c.fromEmail}>`;
  const bcc = c.bcc && c.bcc.toLowerCase() !== String(m.to).toLowerCase() ? [c.bcc] : [];
  if (c.provider === 'gmail') {
    const { default: MailComposer } = await import('nodemailer/lib/mail-composer/index.js');
    const raw = await new MailComposer({ from, to: m.to, replyTo: c.replyTo, subject: m.subject, text: m.text, html: textToHtml(m.text), attachments: m.attachments }).compile().build();
    const j = await gmailFetch('/gmail/v1/users/me/messages/send', { method: 'POST', body: JSON.stringify({ raw: raw.toString('base64url') }) });
    return { id: j.id || '', threadId: j.threadId || '', provider: 'gmail' };
  }
  if (c.provider === 'resend') {
    const r = await fetch(`${c.resendUrl}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [m.to], bcc, reply_to: c.replyTo, subject: m.subject, text: m.text, html: textToHtml(m.text),
        attachments: (m.attachments || []).map((a) => ({ filename: a.filename, content: a.content.toString('base64') })),
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend ${r.status}: ${j.message || j.error || 'error'}`);
    return { id: j.id || '', provider: 'resend' };
  }
  const { default: nodemailer } = await import('nodemailer');
  const tr = nodemailer.createTransport({
    host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465,
    auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
  });
  const info = await tr.sendMail({ from, to: m.to, bcc: bcc[0], replyTo: c.replyTo, subject: m.subject, text: m.text, html: textToHtml(m.text), attachments: m.attachments });
  return { id: String(info.messageId || ''), provider: 'smtp' };
}

/** Comprueba credenciales sin enviar nada (Resend: lista dominios; SMTP: verify). */
export async function mailPing() {
  const c = mailConfig();
  if (!mailEnabled()) throw new Error('Faltan datos del servicio de correo');
  if (c.provider === 'gmail') {
    const j = await gmailFetch('/gmail/v1/users/me/profile');
    return `Gmail conectado como ${j.emailAddress}.${j.emailAddress && j.emailAddress.toLowerCase() !== c.fromEmail.toLowerCase() ? ` Ojo: el remitente configurado (${c.fromEmail}) debe ser esta cuenta o un alias suyo.` : ''}`;
  }
  if (c.provider === 'resend') {
    const r = await fetch(`${c.resendUrl}/domains`, { headers: { Authorization: `Bearer ${c.resendKey}` }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403 && /invalid|api key/i.test(JSON.stringify(j))) throw new Error('Resend rechazó la API key');
    const dom = (j.data || []).map((d) => `${d.name}: ${d.status}`).join(', ');
    return `Resend responde correctamente.${dom ? ` Dominios: ${dom}.` : ' Aún no hay dominios verificados.'}`;
  }
  const { default: nodemailer } = await import('nodemailer');
  const tr = nodemailer.createTransport({ host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465, auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPass } : undefined, connectionTimeout: 10000 });
  await tr.verify();
  return `Conexión SMTP correcta con ${c.smtpHost}:${c.smtpPort}.`;
}
