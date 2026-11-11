import { Router } from 'express';
import { authenticate } from '../auth.js';
import { HttpError } from '../util.js';
import { query } from '../db.js';
import { queue, advance, preview, history, runAuto, checkReplies } from '../followup.js';

export const followupsRouter = Router();
followupsRouter.use(authenticate);

const ids = (b) => [...new Set((Array.isArray(b?.quote_ids) ? b.quote_ids : []).map(Number).filter(Number.isInteger))].slice(0, 200);

followupsRouter.get('/', async (req, res) => res.json(await queue({ channel: req.query.channel === 'all' ? 'all' : 'ia' })));
followupsRouter.get('/log', async (req, res) => res.json(await history({ quoteId: req.query.quote_id || null })));
followupsRouter.get('/preview/:quoteId', async (req, res) => {
  const p = await preview(req.params.quoteId);
  if (!p) throw new HttpError(404, 'Cotización no encontrada');
  res.json(p);
});

// Envía el seguimiento de la etapa actual y avanza la etapa, una por una (los resultados se informan por cotización).
followupsRouter.post('/send', async (req, res) => {
  const list = ids(req.body);
  if (!list.length) throw new HttpError(400, 'Selecciona al menos una cotización');
  const results = [];
  for (const id of list) results.push(await advance(id, { userId: req.user.id, trigger: 'manual' }));
  res.json({ results, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
});

// manual | auto (se envía solo al cumplirse los días de la etapa) | pausado (cliente respondió / no molestar)
followupsRouter.post('/mode', async (req, res) => {
  const mode = String(req.body?.mode || '');
  if (!['manual', 'auto', 'pausado'].includes(mode)) throw new HttpError(400, 'Modo inválido');
  const list = ids(req.body);
  if (!list.length) throw new HttpError(400, 'Selecciona al menos una cotización');
  await query('UPDATE quotes SET follow_mode=$1 WHERE id = ANY($2::int[])', [mode, list]);
  res.json({ ok: true, updated: list.length });
});

// Ejecuta ahora los automáticos que ya corresponden (también corre solo cada 15 min en horario hábil).
followupsRouter.post('/run-auto', async (_req, res) => {
  const results = await runAuto({ force: true });
  res.json({ results, sent: results.filter((r) => r.ok).length });
});

// Con Gmail conectado: revisa los hilos y pausa las cotizaciones cuyo cliente ya respondió.
followupsRouter.post('/check-replies', async (_req, res) => {
  const replied = await checkReplies();
  res.json({ replied, count: replied.length });
});
