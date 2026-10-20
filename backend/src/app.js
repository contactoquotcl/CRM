import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authRouter, usersRouter, settingsRouter, productsRouter, statesRouter } from './routes/core.js';
import { leadsRouter, importRouter } from './routes/leads.js';
import { quotesRouter } from './routes/quotes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render está detrás de un proxy
  app.use(helmet());

  const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(
    cors({
      origin: origins.length ? origins : process.env.NODE_ENV === 'production' ? false : true,
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );
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
