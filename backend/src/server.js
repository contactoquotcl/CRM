import http from 'node:http';
import { initDb } from './db.js';
import { seedAdmin } from './auth.js';
import { createApp } from './app.js';
import { startBackgroundJobs } from './jobs.js';

const port = Number(process.env.PORT) || 4000;
let app = null;

// El servidor abre el puerto de inmediato: si la base de datos aún no responde (reinicio o mantención de Render)
// contesta 503 en vez de caerse y entrar en un ciclo de reinicios.
http
  .createServer((req, res) => {
    if (app) return app(req, res);
    res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Retry-After': '10' });
    res.end(JSON.stringify({ error: 'El servicio está iniciando, intenta de nuevo en unos segundos' }));
  })
  .listen(port, () => console.log(`Quot CRM API escuchando en :${port}`));

// La base de datos se reintenta durante ~10 min antes de rendirse (Render puede tardar en reiniciar Postgres).
const MAX_TRIES = Number(process.env.DB_CONNECT_TRIES) || 60;
for (let i = 1; ; i++) {
  try {
    await initDb();
    await seedAdmin();
    break;
  } catch (e) {
    console.error(`[db] intento ${i}/${MAX_TRIES} falló: ${e.message}`);
    if (i >= MAX_TRIES) process.exit(1);
    await new Promise((r) => setTimeout(r, 10000));
  }
}
app = createApp();
console.log('Base de datos lista');
startBackgroundJobs();
