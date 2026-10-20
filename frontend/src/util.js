export const clp = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');

export function cleanRut(v = '') {
  return String(v).replace(/[^0-9kK]/g, '').toUpperCase();
}
export function validRut(v) {
  const c = cleanRut(v);
  if (c.length < 2) return false;
  const body = c.slice(0, -1);
  let sum = 0, mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const r = 11 - (sum % 11);
  return (r === 11 ? '0' : r === 10 ? 'K' : String(r)) === c.slice(-1);
}
export function formatRut(v = '') {
  const c = cleanRut(v);
  if (c.length < 2) return String(v).trim();
  return `${c.slice(0, -1)}-${c.slice(-1)}`;
}

export const norm = (s = '') =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
};

// Precio de venta neto = costo / (1 - margen), con margen en % sobre la venta. null si el margen no es válido.
export function priceFromCost(cost, marginPct) {
  const m = Number(marginPct);
  if (marginPct === '' || marginPct === null || marginPct === undefined || !Number.isFinite(m) || m < 0 || m >= 100) return null;
  return Math.round((Number(cost) || 0) / (1 - m / 100));
}
export const parseMargin = (v) => (String(v).trim() === '' ? NaN : Number(String(v).replace(',', '.')));
