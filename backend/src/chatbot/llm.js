import { llmConfig } from '../config.js';

export const llmProvider = () => llmConfig().provider;
export const llmEnabled = () => {
  const c = llmConfig();
  return c.provider === 'gemini' ? !!c.geminiKey : !!c.apiKey;
};
export const llmLabel = () => (llmProvider() === 'gemini' ? 'Gemini' : 'Claude');

/**
 * Llama al modelo del proveedor activo. El motor del chatbot habla siempre "formato Anthropic"
 * (bloques text / tool_use / tool_result); para Gemini se traduce aquí en la entrada y en la salida.
 */
export async function callLLM({ system, messages, tools }) {
  return llmConfig().provider === 'gemini' ? callGemini({ system, messages, tools }) : callAnthropic({ system, messages, tools });
}
export const callClaude = callLLM; // compatibilidad con el nombre anterior

async function callAnthropic({ system, messages, tools }) {
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

// ---------------------------------------------------------------- Gemini
const SCHEMA_KEYS = ['type', 'description', 'enum', 'properties', 'required', 'items', 'format'];
function geminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const k of SCHEMA_KEYS) {
    if (s[k] === undefined) continue;
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(s.properties).map(([n, v]) => [n, geminiSchema(v)]));
    else if (k === 'items') out.items = geminiSchema(s.items);
    else out[k] = s[k];
  }
  return out;
}

export function toGeminiRequest({ system, messages, tools }, c) {
  const names = new Map(); // tool_use_id → nombre de la herramienta
  const contents = [];
  for (const m of messages) {
    const parts = [];
    if (typeof m.content === 'string') parts.push({ text: m.content });
    else {
      for (const b of m.content || []) {
        if (b.type === 'text') parts.push({ text: b.text });
        else if (b.type === 'tool_use') {
          names.set(b.id, b.name);
          parts.push({ functionCall: { name: b.name, args: b.input || {} }, ...(b._thoughtSignature ? { thoughtSignature: b._thoughtSignature } : {}) });
        } else if (b.type === 'tool_result') {
          let resp;
          try { resp = JSON.parse(b.content); } catch { resp = { result: String(b.content) }; }
          if (!resp || typeof resp !== 'object' || Array.isArray(resp)) resp = { result: resp };
          parts.push({ functionResponse: { name: names.get(b.tool_use_id) || 'herramienta', response: resp } });
        }
      }
    }
    if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    ...(tools?.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.input_schema) })) }] } : {}),
    // Los modelos con "thinking" gastan parte del límite pensando: se da margen para que no se corte la respuesta.
    generationConfig: { maxOutputTokens: Math.max(c.maxTokens, 2048) },
  };
}

export function fromGeminiResponse(data) {
  const cand = data?.candidates?.[0];
  if (!cand) throw new Error(`Gemini no devolvió respuesta${data?.promptFeedback?.blockReason ? ` (bloqueado: ${data.promptFeedback.blockReason})` : ''}`);
  const content = [];
  let n = 0;
  for (const p of cand.content?.parts || []) {
    if (p.thought) continue;
    if (typeof p.text === 'string' && p.text) content.push({ type: 'text', text: p.text });
    else if (p.functionCall) content.push({ type: 'tool_use', id: `gem_${Date.now().toString(36)}_${n++}`, name: p.functionCall.name, input: p.functionCall.args || {}, ...(p.thoughtSignature ? { _thoughtSignature: p.thoughtSignature } : {}) });
  }
  const hasTool = content.some((b) => b.type === 'tool_use');
  return { content, stop_reason: hasTool ? 'tool_use' : 'end_turn' };
}

async function callGemini({ system, messages, tools }) {
  const c = llmConfig();
  if (!c.geminiKey) throw new Error('GEMINI_API_KEY no está configurada');
  const res = await fetch(`${c.geminiBaseUrl}/v1beta/models/${encodeURIComponent(c.geminiModel)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': c.geminiKey, 'content-type': 'application/json' },
    body: JSON.stringify(toGeminiRequest({ system, messages, tools }, c)),
    signal: AbortSignal.timeout(c.timeoutMs),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 200)}`);
  }
  return fromGeminiResponse(await res.json());
}
