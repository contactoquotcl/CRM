// ---------- RUT chileno ----------
export function cleanRut(input = '') {
  return String(input).replace(/[^0-9kK]/g, '').toUpperCase();
}

export function rutDv(body) {
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const r = 11 - (sum % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}

export function validRut(input) {
  const c = cleanRut(input);
  if (c.length < 2) return false;
  return rutDv(c.slice(0, -1)) === c.slice(-1);
}

// "76123456k" -> "76123456-K". Si no se puede normalizar devuelve el texto original.
export function formatRut(input = '') {
  const c = cleanRut(input);
  if (c.length < 2) return String(input).trim();
  return `${c.slice(0, -1)}-${c.slice(-1)}`;
}

// ---------- Números y fechas (para importar CSV de Notion) ----------
export function parseMoney(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Math.round(v);
  let s = String(v).replace(/[^\d,.\-]/g, '');
  if (!s) return 0;
  // 1.234.567 (miles con punto) o 1.234.567,89 (formato chileno)
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};

// Acepta: 2025-10-03, 03/10/2025, 3 de octubre de 2025, October 3, 2025, 2025-10-03T10:00
export function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/))) return iso(+m[3], +m[2], +m[1]); // dd/mm/yyyy
  if ((m = s.match(/^(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:de\s+)?(\d{4})/))) {
    const mo = MONTHS[m[2]];
    return mo ? iso(+m[3], mo, +m[1]) : null;
  }
  if ((m = s.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/))) {
    const mo = MONTHS[m[1]];
    return mo ? iso(+m[3], mo, +m[2]) : null;
  }
  return null;
}

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const toBool = (v) => ['true', 'yes', 'sí', 'si', '1', 'x', '__yes__'].includes(String(v).trim().toLowerCase());

export const clp = (n) => '$' + Math.round(n).toLocaleString('es-CL');

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
