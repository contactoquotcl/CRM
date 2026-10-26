import { query } from './db.js';
import { wcConfig } from './config.js';
import { wcEnabled } from './woo.js';
import { syncAll } from './catalog.js';

// Carga inicial del catálogo (si está vacío) y reconciliación periódica con WooCommerce.
export function startBackgroundJobs() {
  if (!wcEnabled()) {
    console.log('[catalog] WooCommerce no configurado: sin sincronización de catálogo');
    return;
  }
  (async () => {
    const n = (await query('SELECT COUNT(*)::int AS n FROM catalog_products')).rows[0].n;
    const last = (await query("SELECT value FROM settings WHERE key='catalog_last_sync'")).rows[0]?.value;
    let lastAt = 0;
    try { lastAt = Date.parse(JSON.parse(last || '{}').at) || 0; } catch { /* sin datos */ }
    const stale = Date.now() - lastAt > Math.max(1, wcConfig().reconcileHours) * 3600 * 1000; // el plan gratis duerme: se reconcilia al despertar
    if (n === 0 || stale) await syncAll({ reason: n === 0 ? 'inicial' : 'reconciliacion' }).then((r) => console.log(`[catalog] sincronizado: ${r.count} productos`)).catch((e) => console.error('[catalog] carga inicial falló:', e.message));
  })();
  const every = Math.max(1, wcConfig().reconcileHours) * 3600 * 1000;
  setInterval(() => syncAll({ reason: 'reconciliacion' }).catch((e) => console.error('[catalog] reconciliación falló:', e.message)), every).unref();
}
