import { llmConfig } from '../config.js';

export const llmEnabled = () => !!llmConfig().apiKey;

/** Llama a la API de Mensajes de Anthropic. Devuelve el JSON de la respuesta. */
export async function callClaude({ system, messages, tools }) {
  const c = llmConfig();
  if (!c.apiKey) throw new Error('ANTHROPIC_API_KEY no está configurada');
  const res = await fetch(`${c.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: c.model, max_tokens: c.maxTokens, system, messages, tools }),
    signal: AbortSignal.timeout(c.timeoutMs),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}
