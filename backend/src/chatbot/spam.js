import { query } from '../db.js';
import { norm } from '../catalog.js';

// Detección determinista de spam (sin IA, para no gastar tokens en ello). Conservadora: prefiere dejar pasar
// un mensaje dudoso antes que derivar a un cliente real.
const SPAM_WORDS = /\b(casino|viagra|cialis|porn\w*|xxx|forex|criptomonedas?|bitcoin|apuestas?|tragamonedas|gana(?:r)? dinero (?:rapido|facil|desde casa)|prestamos? (?:rapidos?|inmediatos?)|seo barato|posicionamiento web garantizado|haz click aqui|click aqui para ganar|ganaste un premio)\b/;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;

export const spamEnabled = async () => {
  const r = await query("SELECT value FROM settings WHERE key='spam_detection'");
  return r.rows[0]?.value !== '0';
};

/** Devuelve el motivo (texto corto) si el mensaje parece spam; si no, null. */
export async function detectSpam(session, text) {
  const n = norm(text);
  const urls = text.match(URL_RE) || [];
  if (urls.length >= 3) return 'tres o más enlaces en un mensaje';
  if (SPAM_WORDS.test(n)) return 'texto típico de spam';
  if (urls.length >= 1 && /\b(gratis|oferta|premio|gana\w*|urgente|suscri\w+|promocion)\b/.test(n) && n.replace(URL_RE, '').trim().length < 80) return 'enlace promocional';

  // Gibberish: mucho texto casi sin vocales ("asdfghjkl…") o un mismo carácter repetido
  const letters = n.replace(/[^a-z]/g, '');
  if (letters.length >= 15 && (letters.match(/[aeiou]/g) || []).length / letters.length < 0.15) return 'texto sin sentido';
  if (/(.)\1{11,}/.test(text)) return 'caracteres repetidos';

  // Repetición y ráfagas: se miran los últimos mensajes del cliente en esta sesión
  const { rows } = await query("SELECT content, created_at FROM chat_messages WHERE session_id=$1 AND role='user' ORDER BY id DESC LIMIT 8", [session.id]);
  const same = rows.filter((r) => norm(r.content) === n).length; // incluye el mensaje actual
  if (n.length >= 3 && same >= 3) return 'mismo mensaje repetido 3 veces';
  const recent = rows.filter((r) => Date.now() - new Date(r.created_at).getTime() < 30000).length;
  if (recent >= 7) return 'ráfaga de mensajes (7 en 30 segundos)';
  return null;
}
