import { Router } from 'express';
import { query } from '../db.js';
import { authenticate } from '../auth.js';
import { HttpError } from '../util.js';
import { assignConversation, getVisible, listConversations, sendAgentMessage, setConversationStatus, unreadCount } from '../inbox.js';

export const conversationsRouter = Router();
conversationsRouter.use(authenticate);

conversationsRouter.get('/', async (req, res) => {
  res.json(await listConversations(req.user, { filter: String(req.query.filter || 'all'), label: String(req.query.label || ''), q: String(req.query.q || '') }));
});

conversationsRouter.get('/unread', async (req, res) => res.json({ unread: await unreadCount(req.user) }));

// Usuarios a los que se puede asignar una conversación (visible para todos los roles)
conversationsRouter.get('/agents', async (_req, res) => {
  const { rows } = await query("SELECT id, name FROM users WHERE active AND role IN ('admin','user') ORDER BY name");
  res.json(rows);
});

conversationsRouter.get('/:id', async (req, res) => {
  const conv = await getVisible(req.user, req.params.id);
  const { rows } = await query('SELECT id, direction, sender_type, sender_name, content, is_private, created_at FROM conversation_messages WHERE conversation_id=$1 ORDER BY id', [conv.id]);
  // Al abrirla, la asignada a mí queda leída
  if (conv.assignee_id === req.user.id && conv.unread_count) await query('UPDATE conversations SET unread_count=0 WHERE id=$1', [conv.id]);
  res.json({ conversation: { ...conv, unread_count: conv.assignee_id === req.user.id ? 0 : conv.unread_count }, messages: rows });
});

conversationsRouter.post('/:id/messages', async (req, res) => {
  const conv = await getVisible(req.user, req.params.id);
  const msg = await sendAgentMessage(req.user, conv.id, { content: req.body?.content, isPrivate: !!req.body?.private });
  res.status(201).json(msg);
});

conversationsRouter.post('/:id/assign', async (req, res) => {
  const conv = await getVisible(req.user, req.params.id);
  let target = req.body?.user_id === null || req.body?.user_id === undefined || req.body?.user_id === '' ? null : Number(req.body.user_id);
  if (req.user.role !== 'admin') {
    // Un usuario estándar solo puede tomar una libre o devolver una suya, nunca reasignar a terceros
    if (target !== null && target !== req.user.id) throw new HttpError(403, 'Solo un administrador puede asignar a otro usuario');
    if (target === null && conv.assignee_id !== req.user.id) throw new HttpError(403, 'No puedes modificar esta conversación');
  }
  res.json(await assignConversation(conv.id, target));
});

conversationsRouter.post('/:id/status', async (req, res) => {
  const conv = await getVisible(req.user, req.params.id);
  res.json(await setConversationStatus(conv.id, String(req.body?.status || '')));
});
