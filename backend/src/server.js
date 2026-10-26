import { initDb } from './db.js';
import { seedAdmin } from './auth.js';
import { createApp } from './app.js';
import { startBackgroundJobs } from './jobs.js';

await initDb();
await seedAdmin();

const port = Number(process.env.PORT) || 4000;
createApp().listen(port, () => console.log(`Quot CRM API escuchando en :${port}`));
startBackgroundJobs();
