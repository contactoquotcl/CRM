import { Router } from 'express';
import { query } from '../db.js';
import { authenticate } from '../auth.js';
import { HttpError } from '../util.js';
import { wcEnabled, wcOrdersByEmail } from '../woo.js';
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

// Panel lateral del cliente: ficha, leads, cotizaciones, carrito del bot y compras de WooCommerce
conversationsRouter.get('/:id/customer', async (req, res) => {
  const conv = await getVisible(req.user, req.params.id);
  const rut = String(conv.contact_rut || '').replace(/[.\s]/g, '');
  const email = String(conv.contact_email || '').toLowerCase();
  const leads = (await query(
    `SELECT l.id, l.client_name, l.quote_number, l.total, l.channel, l.created_at, s.name AS state_name
       FROM leads l LEFT JOIN pipeline_states s ON s.id=l.state_id
      WHERE l.id = $1 OR ($2 <> '' AND replace(replace(l.rut,'.',''),' ','') = $2) OR ($3 <> '' AND lower(l.email) = $3)
      ORDER BY l.id DESC LIMIT 20`, [conv.lead_id || 0, rut, email])).rows;
  const quotes = (await query(
    `SELECT q.id, q.number, q.total, q.quote_date::text AS quote_date, q.channel, u.name AS created_by_name
       FROM quotes q LEFT JOIN users u ON u.id=q.created_by
      WHERE q.conversation_id = $1 OR ($2 <> '' AND replace(replace(q.rut,'.',''),' ','') = $2) OR ($3 <> '' AND lower(q.email) = $3)
      ORDER BY q.number DESC LIMIT 20`, [conv.id, rut, email])).rows;
  const cartRow = conv.session_id ? (await query("SELECT id, items, subtotal, status, quote_id, created_at FROM carts WHERE session_id=$1 ORDER BY id DESC LIMIT 1", [conv.session_id])).rows[0] : null;
  let cart = null;
  if (cartRow) { try { cart = { ...cartRow, items: JSON.parse(cartRow.items) }; } catch { cart = null; } }
  let purchases = null, purchases_error = '';
  if (email && wcEnabled()) {
    try { purchases = await wcOrdersByEmail(email); } catch (e) { purchases_error = 'No se pudieron leer los pedidos de WooCommerce (revisa que la clave tenga permiso de lectura de pedidos).'; }
  }
  res.json({
    contact: { name: conv.contact_name, company: conv.contact_company, rut: conv.contact_rut, email: conv.contact_email, phone: conv.contact_phone },
    leads, quotes, cart, purchases, purchases_error,
  });
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
