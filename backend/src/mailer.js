// Envío de correo: Resend (API HTTPS) o SMTP. Render gratis bloquea SMTP, por eso Resend es la opción recomendada.
import { mailConfig } from './config.js';

export function mailEnabled() {
  const c = mailConfig();
  if (c.provider === 'resend') return !!c.resendKey && !!c.fromEmail;
  if (c.provider === 'smtp') return !!c.smtpHost && !!c.fromEmail;
  return false;
}
export const mailLabel = () => ({ resend: 'Resend', smtp: 'SMTP' }[mailConfig().provider] || 'sin configurar');

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const textToHtml = (t) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${String(t).split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;

/** @param {{to:string, subject:string, text:string, attachments?:{filename:string, content:Buffer}[]}} m  @returns {Promise<{id:string, provider:string}>} */
export async function sendMail(m) {
  const c = mailConfig();
  if (!mailEnabled()) throw new Error('El correo no está configurado (Admin → Integraciones → Correo de seguimiento)');
  const from = `${c.fromName} <${c.fromEmail}>`;
  const bcc = c.bcc && c.bcc.toLowerCase() !== String(m.to).toLowerCase() ? [c.bcc] : [];
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
