import crypto from 'node:crypto';
import { query } from './db.js';
import { overrides } from './overrides.js';

/**
 * Catálogo de campos editables desde Admin → Integraciones.
 * secret=true: se guarda cifrado y NUNCA se devuelve al navegador (solo "configurado" + últimos 4 caracteres).
 */
export const GROUPS = [
  {
    id: 'llm', title: 'IA del chatbot (Claude o Gemini)', test: true,
    help: 'Elige qué IA responde en el chat y carga la clave de ese proveedor. Claude: console.anthropic.com → API Keys. Gemini: aistudio.google.com/apikey. Puedes dejar cargadas las dos y cambiar de proveedor cuando quieras.',
    fields: [
      { key: 'LLM_PROVIDER', label: 'Proveedor activo', type: 'select', options: [['', 'Automático (el que tenga clave; Claude primero)'], ['anthropic', 'Claude (Anthropic)'], ['gemini', 'Gemini (Google)']] },
      { key: 'ANTHROPIC_API_KEY', label: 'API key de Claude (Anthropic)', secret: true, placeholder: 'sk-ant-…' },
      { key: 'CHATBOT_MODEL', label: 'Modelo de Claude', placeholder: 'claude-sonnet-5-5', help: 'Opcional. Vacío = modelo por defecto.' },
      { key: 'GEMINI_API_KEY', label: 'API key de Gemini (Google)', secret: true, placeholder: 'AIza…' },
      { key: 'GEMINI_MODEL', label: 'Modelo de Gemini', placeholder: 'gemini-2.5-flash', help: 'Opcional. Vacío = gemini-2.5-flash.' },
    ],
  },
  {
    id: 'woocommerce', title: 'WooCommerce (catálogo)', test: true,
    help: 'En WordPress: WooCommerce → Ajustes → Avanzado → API REST → Añadir clave, permisos "Solo lectura".',
    fields: [
      { key: 'WC_BASE_URL', label: 'URL de la tienda', type: 'url', placeholder: 'https://quot.cl' },
      { key: 'WC_CONSUMER_KEY', label: 'Consumer key', secret: true, placeholder: 'ck_…' },
      { key: 'WC_CONSUMER_SECRET', label: 'Consumer secret', secret: true, placeholder: 'cs_…' },
      { key: 'WC_WEBHOOK_SECRET', label: 'Secreto del webhook', secret: true, generate: true, help: 'Invéntalo (botón Generar) y pégalo igual en el campo "Secreto" del webhook en WooCommerce.' },
      { key: 'WC_PRICES_INCLUDE_TAX', label: 'Los precios de la tienda incluyen IVA', type: 'bool' },
    ],
    webhook: 'woo',
  },
  {
    id: 'chatwoot', title: 'Chatwoot (bandeja de conversaciones)', test: true,
    help: 'Chatwoot → Configuración → Bandejas → crea una bandeja tipo "API". El token está en tu Perfil → Token de acceso.',
    fields: [
      { key: 'CHATWOOT_BASE_URL', label: 'URL de Chatwoot', type: 'url', placeholder: 'https://chat.quot.cl' },
      { key: 'CHATWOOT_ACCOUNT_ID', label: 'ID de cuenta', placeholder: '1' },
      { key: 'CHATWOOT_API_TOKEN', label: 'Token de acceso', secret: true },
      { key: 'CHATWOOT_INBOX_ID', label: 'ID de la bandeja', placeholder: '1' },
      { key: 'CHATWOOT_WEBHOOK_SECRET', label: 'Secreto del webhook', secret: true, generate: true, help: 'Se usa para verificar que los eventos vienen de Chatwoot (firma HMAC o ?token= en la URL).' },
    ],
    webhook: 'chatwoot',
  },
  {
    id: 'general', title: 'General',
    help: '',
    fields: [
      { key: 'CRM_PUBLIC_URL', label: 'URL pública del CRM (frontend)', type: 'url', placeholder: 'https://crm-ten-mu-45.vercel.app', help: 'Se usa para los enlaces "Abrir en el CRM" dentro de Chatwoot.' },
      { key: 'API_PUBLIC_URL', label: 'URL pública de esta API', type: 'url', placeholder: 'https://quot-crm-api.onrender.com', help: 'Se usa en el enlace al PDF de las cotizaciones del bot. En Render se detecta sola; solo cámbiala si usas un dominio propio.' },
      { key: 'CHATBOT_ALLOWED_ORIGINS', label: 'Sitios donde puede cargarse el chat', placeholder: 'https://quot.cl,https://www.quot.cl', help: 'Separados por coma.' },
    ],
  },
];

export const FIELDS = new Map(GROUPS.flatMap((g) => g.fields.map((f) => [f.key, { ...f, group: g.id }])));

// ---------------------------------------------------------------- cifrado AES-256-GCM
function encKey() {
  const base = process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret-no-usar-en-produccion');
  if (!base) throw new Error('Falta SETTINGS_ENCRYPTION_KEY o JWT_SECRET para cifrar las integraciones');
  return crypto.createHash('sha256').update(`quot-crm:integrations:${base}`).digest();
}
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
export function decrypt(blob) {
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') throw new Error('formato desconocido');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/** Carga a memoria los valores guardados (se llama al iniciar y tras cada cambio). */
export async function loadOverrides() {
  const { rows } = await query('SELECT key, value_enc FROM integration_values');
  overrides.clear();
  for (const r of rows) {
    if (!FIELDS.has(r.key)) continue;
    try {
      overrides.set(r.key, decrypt(r.value_enc));
    } catch {
      // Cambió la clave de cifrado (JWT_SECRET / SETTINGS_ENCRYPTION_KEY): se ignora y se cae a la variable de entorno.
      console.error(`[integraciones] no se pudo descifrar ${r.key}; se usa la variable de entorno si existe`);
    }
  }
}

export async function saveValues(values, clear, userId) {
  for (const [k, v] of Object.entries(values || {})) {
    const f = FIELDS.get(k);
    if (!f) continue;
    const val = String(v ?? '').trim();
    if (!val) continue; // vacío = no cambiar
    await query(
      `INSERT INTO integration_values(key, value_enc, is_secret, updated_by, updated_at) VALUES($1,$2,$3,$4,now())
       ON CONFLICT (key) DO UPDATE SET value_enc=EXCLUDED.value_enc, is_secret=EXCLUDED.is_secret, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [k, encrypt(val), !!f.secret, userId]
    );
  }
  for (const k of clear || []) if (FIELDS.has(k)) await query('DELETE FROM integration_values WHERE key=$1', [k]);
  await loadOverrides();
}

export function validate(values) {
  for (const [k, v] of Object.entries(values || {})) {
    const f = FIELDS.get(k);
    if (!f) return `Campo desconocido: ${k}`;
    const val = String(v ?? '').trim();
    if (!val) continue;
    if (val.length > 2000) return `${f.label}: valor demasiado largo`;
    if (f.type === 'url' && !/^https?:\/\/[^\s/]+\.[^\s]+$|^https?:\/\/localhost(:\d+)?/i.test(val)) return `${f.label}: debe ser una URL que empiece con https://`;
    if (f.type === 'select' && !f.options.some(([o]) => o === val)) return `${f.label}: opción inválida`;
    if (f.type === 'bool' && !['true', 'false'].includes(val)) return `${f.label}: valor inválido`;
    if (['CHATWOOT_ACCOUNT_ID', 'CHATWOOT_INBOX_ID'].includes(k) && !/^\d+$/.test(val)) return `${f.label}: debe ser un número`;
  }
  return null;
}

/** Estado de cada campo para el navegador: los secretos nunca viajan. */
export async function describe() {
  const { rows } = await query('SELECT key, is_secret, updated_at FROM integration_values');
  const stored = new Map(rows.map((r) => [r.key, r]));
  return GROUPS.map((g) => ({
    id: g.id, title: g.title, help: g.help, test: !!g.test, webhook: g.webhook || null,
    fields: g.fields.map((f) => {
      const inDb = stored.has(f.key) && overrides.has(f.key);
      const envVal = (process.env[f.key] || '').trim();
      const cur = inDb ? overrides.get(f.key) : envVal;
      const out = {
        options: f.options, key: f.key, label: f.label, secret: !!f.secret, type: f.type || 'text', placeholder: f.placeholder || '', help: f.help || '', generate: !!f.generate,
        configured: !!cur, source: inDb ? 'crm' : envVal ? 'env' : null,
        updated_at: inDb ? stored.get(f.key).updated_at : null,
      };
      if (f.secret) out.hint = cur && cur.length >= 12 ? `…${cur.slice(-4)}` : '';
      else out.value = cur;
      return out;
    }),
  }));
}
