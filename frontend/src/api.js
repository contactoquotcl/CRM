const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const KEY = 'quot_crm_token';

export const getToken = () => localStorage.getItem(KEY);
export const setToken = (t) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

async function request(method, path, body, { raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    setToken(null);
    window.dispatchEvent(new Event('quot-logout'));
  }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* sin cuerpo JSON */
    }
    throw new Error(msg);
  }
  return raw ? res : res.json();
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b ?? {}),
  patch: (p, b) => request('PATCH', p, b ?? {}),
  del: (p) => request('DELETE', p),
  // Abre un PDF protegido (necesita el token) en una pestaña nueva.
  async openPdf(quoteId) {
    const win = window.open('', '_blank');
    try {
      const res = await request('GET', `/api/quotes/${quoteId}/pdf`, undefined, { raw: true });
      const url = URL.createObjectURL(await res.blob());
      if (win) win.location.href = url;
      else window.location.href = url;
    } catch (e) {
      win?.close();
      throw e;
    }
  },
};
