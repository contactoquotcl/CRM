import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authRouter, usersRouter, settingsRouter, productsRouter, statesRouter } from './routes/core.js';
import { leadsRouter, importRouter } from './routes/leads.js';
import { quotesRouter } from './routes/quotes.js';
import { wooWebhookRouter, catalogRouter } from './routes/woo.js';
import { chatwootWebhookRouter } from './routes/chatwoot.js';
import { chatbotRouter } from './routes/chatbot.js';
import { conversationsRouter } from './routes/conversations.js';
import { integrationsRouter } from './routes/integrations.js';
import { botConfig } from './config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render está detrás de un proxy
  app.use(helmet());

  const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const crmCors = cors({
    origin: origins.length ? origins : process.env.NODE_ENV === 'production' ? false : true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  // El endpoint público del bot solo acepta peticiones desde quot.cl (CHATBOT_ALLOWED_ORIGINS); el resto, desde el CRM.
  const botCors = cors({
    origin: (origin, cb) => {
      const c = botConfig();
      cb(null, !origin || (!c.originsExplicit && process.env.NODE_ENV !== 'production') || c.allowedOrigins.includes(origin));
    },
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.use((req, res, next) => (req.path.startsWith('/api/chatbot') ? botCors(req, res, next) : crmCors(req, res, next)));

  // Webhooks firmados: necesitan el cuerpo crudo, por eso van antes de express.json()
  app.use('/api/woo/webhook', wooWebhookRouter);
  app.use('/api/chatwoot/webhook', chatwootWebhookRouter);

  // Widget embebible (se carga como <script> desde otro dominio)
  app.get('/widget.js', (_req, res) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(PUBLIC_DIR, 'widget.js'));
  });

  app.use(express.json({ limit: '5mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
  app.use('/api/auth/login', loginLimiter);

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/states', statesRouter);
  app.use('/api/leads', leadsRouter);
  app.use('/api/quotes', quotesRouter);
  app.use('/api/import', importRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/chatbot', chatbotRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/integrations', integrationsRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Archivo demasiado grande' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  return app;
}
