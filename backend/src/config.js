// Configuración de integraciones, leída EN CADA USO. Prioridad: valor guardado desde Admin → Integraciones (cifrado en BD)
// y, si no hay, variable de entorno.
import { overrides } from './overrides.js';
const raw = (k) => (overrides.has(k) ? overrides.get(k) : process.env[k]);
const e = (k, d = '') => (raw(k) ?? d).toString().trim();
const num = (k, d) => {
  const v = raw(k);
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v !== undefined ? n : d;
};
// URL pública de esta API (para el enlace al PDF). Render la entrega sola en RENDER_EXTERNAL_URL.
export const apiPublicUrl = () => trimSlash(e('API_PUBLIC_URL') || process.env.RENDER_EXTERNAL_URL || '');
export const crmPublicUrl = () => trimSlash(e('CRM_PUBLIC_URL'));
function trimSlash(s) { return s.replace(/\/+$/, ''); }

export const wcConfig = () => ({
  baseUrl: trimSlash(e('WC_BASE_URL')),
  key: e('WC_CONSUMER_KEY'),
  secret: e('WC_CONSUMER_SECRET'),
  webhookSecret: e('WC_WEBHOOK_SECRET'),
  pricesIncludeTax: e('WC_PRICES_INCLUDE_TAX', 'false') === 'true',
  timeoutMs: num('WC_TIMEOUT_MS', 10000),
  reconcileHours: num('CATALOG_RECONCILE_HOURS', 24),
});

export const chatwootConfig = () => ({
  baseUrl: trimSlash(e('CHATWOOT_BASE_URL')),
  accountId: e('CHATWOOT_ACCOUNT_ID'),
  token: e('CHATWOOT_API_TOKEN'),
  inboxId: e('CHATWOOT_INBOX_ID'),
  webhookSecret: e('CHATWOOT_WEBHOOK_SECRET'),
  timeoutMs: num('CHATWOOT_TIMEOUT_MS', 10000),
});

export const llmConfig = () => {
  const apiKey = e('ANTHROPIC_API_KEY');
  const geminiKey = e('GEMINI_API_KEY');
  const chosen = e('LLM_PROVIDER').toLowerCase();
  // Proveedor activo: el elegido en Admin; si no hay elección, el que tenga clave (Claude primero).
  const provider = chosen === 'gemini' || chosen === 'anthropic' ? chosen : apiKey ? 'anthropic' : geminiKey ? 'gemini' : 'anthropic';
  return {
    provider,
    apiKey,
    baseUrl: trimSlash(e('ANTHROPIC_BASE_URL', 'https://api.anthropic.com')),
    model: e('CHATBOT_MODEL', 'claude-sonnet-5-5'),
    geminiKey,
    geminiBaseUrl: trimSlash(e('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com')),
    geminiModel: e('GEMINI_MODEL', 'gemini-2.5-flash'),
    maxTokens: num('CHATBOT_MAX_TOKENS', 1024),
    timeoutMs: num('CHATBOT_LLM_TIMEOUT_MS', 30000),
  };
};

export const botConfig = () => ({
  allowedOrigins: e('CHATBOT_ALLOWED_ORIGINS', 'https://quot.cl,https://www.quot.cl').split(',').map((s) => s.trim()).filter(Boolean),
  originsExplicit: !!e('CHATBOT_ALLOWED_ORIGINS'),
  tokenSecret: e('CHATBOT_TOKEN_SECRET'),
  sessionHours: num('CHATBOT_SESSION_HOURS', 24),
  maxFails: num('BOT_MAX_FAILS', 2),
  maxUserChars: num('BOT_MAX_USER_CHARS', 1000),
  maxUserMessages: num('BOT_MAX_USER_MESSAGES', 80),
  maxToolIterations: num('BOT_MAX_TOOL_ITERATIONS', 6),
  ipPerMinute: num('BOT_RATE_IP_PER_MIN', 40),
  sessionPerMinute: num('BOT_RATE_SESSION_PER_MIN', 12),
  sessionsPerIpHour: num('BOT_SESSIONS_PER_IP_HOUR', 20),
  // Reglas comerciales (una sola fuente de verdad; se inyectan al prompt y las usa el cotizador del bot en la Fase 2)
  validityDays: num('BOT_QUOTE_VALIDITY_DAYS', 30),
  deliveryText: e('BOT_DELIVERY_TEXT', 'inmediata'),
  shippingText: e('BOT_SHIPPING_TEXT', 'Despacho gratis en la Región Metropolitana; en otras regiones el despacho es por cuenta del comprador'),
  minOrderClp: num('BOT_MIN_ORDER_CLP', 0),
  maxCartClp: num('BOT_MAX_CART_CLP', 100000000),
  maxCartLines: num('BOT_MAX_CART_LINES', 20),
  maxLineQty: num('BOT_MAX_LINE_QTY', 999),
  maxQuotesPerSession: num('BOT_MAX_QUOTES_PER_SESSION', 5),
});

export const chatbotTokenSecret = () => {
  const c = botConfig().tokenSecret;
  if (c) return c;
  const j = process.env.JWT_SECRET;
  if (!j && process.env.NODE_ENV === 'production') throw new Error('Falta CHATBOT_TOKEN_SECRET o JWT_SECRET');
  return `chatbot:${j || 'dev-secret-no-usar-en-produccion'}`;
};
