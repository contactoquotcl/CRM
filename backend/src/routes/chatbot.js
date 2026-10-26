import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../db.js';
import { botConfig } from '../config.js';
import { HttpError } from '../util.js';
import { WELCOME, createSession, handleUserMessage, messagesAfter, sessionFromToken } from '../chatbot/engine.js';

export const chatbotRouter = Router();

export const originAllowed = (origin) => {
  const c = botConfig();
  if (!origin) return true; // llamadas sin navegador (curl, tests): las cubre el rate limit
  if (!c.originsExplicit && process.env.NODE_ENV !== 'production') return true;
  return c.allowedOrigins.includes(origin);
};

chatbotRouter.use((req, _res, next) => {
  if (!originAllowed(req.get('origin'))) throw new HttpError(403, 'Origen no permitido');
  next();
});

const ipLimiter = rateLimit({ windowMs: 60 * 1000, limit: () => botConfig().ipPerMinute, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiadas solicitudes, espera un momento' } });
const newSessionLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: () => botConfig().sessionsPerIpHour, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiadas conversaciones nuevas desde tu conexión' } });
chatbotRouter.use(ipLimiter);

// Límite por sesión (en memoria): X mensajes por minuto
const hits = new Map();
function sessionLimit(sid) {
  const now = Date.now();
  const arr = (hits.get(sid) || []).filter((t) => now - t < 60_000);
  if (arr.length >= botConfig().sessionPerMinute) throw new HttpError(429, 'Estás escribiendo muy rápido, espera un momento');
  arr.push(now);
  hits.set(sid, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
}

const busy = new Set(); // un turno a la vez por sesión

async function chatEnabled() {
  const r = await query("SELECT value FROM settings WHERE key='chatbot_enabled'");
  return (r.rows[0]?.value ?? '1') !== '0';
}

async function auth(req, _res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Falta el token de sesión');
  req.chat = await sessionFromToken(h.slice(7));
  next();
}

chatbotRouter.post('/session', newSessionLimiter, async (_req, res) => {
  if (!(await chatEnabled())) throw new HttpError(503, 'El chat no está disponible en este momento');
  const s = await createSession();
  res.status(201).json({ token: s.token, status: 'bot', welcome: WELCOME });
});

chatbotRouter.get('/messages', auth, async (req, res) => {
  const msgs = await messagesAfter(req.chat.id, req.query.after);
  const s = await query('SELECT status FROM chat_sessions WHERE id=$1', [req.chat.id]);
  res.json({ status: s.rows[0]?.status || 'bot', messages: msgs });
});

chatbotRouter.post('/message', auth, async (req, res) => {
  if (!(await chatEnabled())) throw new HttpError(503, 'El chat no está disponible en este momento');
  const text = req.body?.text;
  if (typeof text !== 'string') throw new HttpError(400, 'Falta el texto del mensaje');
  sessionLimit(req.chat.id);
  if (busy.has(req.chat.id)) throw new HttpError(409, 'Espera la respuesta anterior');
  busy.add(req.chat.id);
  try {
    const session = (await query('SELECT * FROM chat_sessions WHERE id=$1', [req.chat.id])).rows[0];
    res.json(await handleUserMessage(session, text));
  } finally {
    busy.delete(req.chat.id);
  }
});
