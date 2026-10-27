import { query } from '../db.js';
import { searchCatalog, priceInfo, wcToRow } from '../catalog.js';
import { wcEnabled, wcGetProduct, wcFindBySku, wcVariations } from '../woo.js';
import { formatRut, validRut } from '../util.js';
import { armarCarrito, generarCotizacion } from './commerce.js';

export const TOOLS = [
  {
    name: 'buscar_productos',
    description: 'Busca productos en el catálogo de Quot por texto libre (nombre, tipo, marca, medida, SKU). No devuelve precios ni stock: para eso usa ver_producto.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto de búsqueda, ej. "etiquetas térmicas 100x150 zebra"' },
        categoria: { type: 'string', description: 'Filtro opcional por categoría' },
        solo_con_stock: { type: 'boolean', description: 'Si es true, solo productos que el catálogo marca con stock' },
        precio_min: { type: 'integer', description: 'Precio mínimo en CLP (referencial)' },
        precio_max: { type: 'integer', description: 'Precio máximo en CLP (referencial)' },
        limite: { type: 'integer', description: 'Cantidad de resultados (1 a 8, por defecto 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ver_producto',
    description: 'Ficha de un producto con precio, stock y variantes consultados EN VIVO en la tienda. Indica el id o el sku (de buscar_productos).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'ID del producto' },
        sku: { type: 'string', description: 'SKU del producto' },
      },
    },
  },
  {
    name: 'derivar_ejecutivo',
    description: 'Deriva la conversación a un ejecutivo humano de Quot. Úsala cuando el cliente lo pida, quiera cotizar/comprar, tenga un reclamo o no puedas resolver su consulta.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', enum: ['cliente_solicita', 'cotizacion', 'reclamo', 'consulta_tecnica', 'otro'] },
        resumen: { type: 'string', description: 'Resumen breve de lo que necesita el cliente (productos, cantidades, contexto)' },
        razon_social: { type: 'string', description: 'Razón social de la empresa del cliente si la entregó' },
        nombre: { type: 'string', description: 'Nombre de la persona de contacto si lo entregó' },
        correo: { type: 'string', description: 'Correo del cliente si lo entregó' },
        telefono: { type: 'string', description: 'Teléfono del cliente si lo entregó' },
        rut: { type: 'string', description: 'RUT de la empresa del cliente si lo entregó' },
      },
      required: ['motivo', 'resumen'],
    },
  },
  {
    name: 'armar_carrito',
    description: 'Arma el carrito del cliente con productos y cantidades (verifica precio y stock en vivo) y entrega el enlace de checkout de la tienda para que pague en línea. Los totales los calcula el sistema.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Productos del carrito',
          items: { type: 'object', properties: { sku: { type: 'string' }, id: { type: 'integer' }, cantidad: { type: 'integer', description: 'Unidades (entero ≥ 1)' } }, required: ['cantidad'] },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'generar_cotizacion',
    description: 'Genera una cotización formal (con número, PDF y datos de transferencia) para una empresa. Solo úsala cuando ya tengas los 5 datos del cliente (RUT de la empresa, razón social, nombre de contacto, correo y teléfono) y el cliente haya confirmado productos y cantidades. No hay descuentos ni márgenes que negociar.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: {
          type: 'object',
          properties: { rut: { type: 'string', description: 'RUT de la empresa' }, razon_social: { type: 'string' }, nombre: { type: 'string', description: 'Nombre de la persona de contacto' }, correo: { type: 'string' }, telefono: { type: 'string' } },
          required: ['rut', 'razon_social', 'nombre', 'correo', 'telefono'],
        },
        items: {
          type: 'array',
          items: { type: 'object', properties: { sku: { type: 'string' }, id: { type: 'integer' }, cantidad: { type: 'integer' } }, required: ['cantidad'] },
        },
        notas: { type: 'string', description: 'Observación opcional del cliente para la cotización (máx. 300 caracteres)' },
      },
      required: ['cliente', 'items'],
    },
  },
];

const MOTIVOS = ['cliente_solicita', 'cotizacion', 'reclamo', 'consulta_tecnica', 'otro'];
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const optInt = (v) => (v === undefined || v === null ? undefined : Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const PHONE = /^[+\d][\d\s().-]{6,19}$/;

/** Validación estricta de los argumentos que propone el modelo. */
export function validateArgs(name, input) {
  const a = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (name === 'buscar_productos') {
    const q = str(a.query, 200);
    if (!q) return { ok: false, error: 'query es obligatorio' };
    const pmin = optInt(a.precio_min), pmax = optInt(a.precio_max), lim = optInt(a.limite);
    if (Number.isNaN(pmin) || Number.isNaN(pmax) || Number.isNaN(lim)) return { ok: false, error: 'precio_min, precio_max y limite deben ser enteros' };
    return { ok: true, args: { query: q, category: str(a.categoria, 80) || undefined, in_stock_only: a.solo_con_stock === true, min_price: pmin, max_price: pmax, limit: lim ?? 5 } };
  }
  if (name === 'ver_producto') {
    const id = optInt(a.id);
    const sku = str(a.sku, 80);
    if ((id === undefined || Number.isNaN(id) || id <= 0) && !sku) return { ok: false, error: 'Indica id (entero) o sku' };
    return { ok: true, args: { id: id > 0 ? id : undefined, sku: sku || undefined } };
  }
  if (name === 'derivar_ejecutivo') {
    if (!MOTIVOS.includes(a.motivo)) return { ok: false, error: `motivo debe ser uno de: ${MOTIVOS.join(', ')}` };
    const out = { motivo: a.motivo, resumen: str(a.resumen, 1200) };
    if (!out.resumen) return { ok: false, error: 'resumen es obligatorio' };
    const correo = str(a.correo, 254);
    if (correo && !EMAIL.test(correo)) return { ok: false, error: 'El correo no es válido: pídeselo de nuevo al cliente (o no lo incluyas)' };
    const tel = str(a.telefono, 20);
    if (tel && !PHONE.test(tel)) return { ok: false, error: 'El teléfono no es válido: pídeselo de nuevo al cliente (o no lo incluyas)' };
    const rut = str(a.rut, 14);
    if (rut && !validRut(rut)) return { ok: false, error: 'El RUT no es válido (dígito verificador): pídeselo de nuevo al cliente (o no lo incluyas)' };
    Object.assign(out, { razon_social: str(a.razon_social, 160), nombre: str(a.nombre, 120), correo, telefono: tel, rut: rut ? formatRut(rut) : '' });
    return { ok: true, args: out };
  }
  if (name === 'armar_carrito' || name === 'generar_cotizacion') {
    const rawItems = Array.isArray(a.items) ? a.items.slice(0, 50) : [];
    const items = [];
    for (const it of rawItems) {
      const o = it && typeof it === 'object' ? it : {};
      const cantidad = optInt(o.cantidad);
      const sku = str(o.sku, 80);
      const id = optInt(o.id);
      if (Number.isNaN(cantidad) || cantidad === undefined) return { ok: false, error: 'Cada producto necesita una cantidad entera' };
      if (!sku && !(id > 0)) return { ok: false, error: 'Cada producto necesita sku o id (los entrega buscar_productos)' };
      items.push({ sku: sku || undefined, id: id > 0 ? id : undefined, cantidad });
    }
    if (!items.length) return { ok: false, error: 'Indica al menos un producto' };
    if (name === 'armar_carrito') return { ok: true, args: { items } };
    const c = a.cliente && typeof a.cliente === 'object' ? a.cliente : {};
    const correo = str(c.correo, 254);
    if (correo && !EMAIL.test(correo)) return { ok: false, error: 'El correo no es válido: pídeselo de nuevo al cliente' };
    const tel = str(c.telefono, 20);
    if (tel && !PHONE.test(tel)) return { ok: false, error: 'El teléfono no es válido: pídeselo de nuevo al cliente' };
    const rut = str(c.rut, 14);
    if (rut && !validRut(rut)) return { ok: false, error: 'El RUT no es válido (dígito verificador): pídeselo de nuevo al cliente' };
    return { ok: true, args: { items, notas: str(a.notas, 300), cliente: { rut: rut ? formatRut(rut) : '', razon_social: str(c.razon_social, 160), nombre: str(c.nombre, 120), correo, telefono: tel } } };
  }
  return { ok: false, error: `Herramienta desconocida: ${name}` };
}

const disponibilidad = (s) => (s === 'instock' ? 'en stock' : s === 'onbackorder' ? 'disponible por pedido' : 'sin stock');
const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

function productCard(p, variants) {
  const row = wcToRow(p);
  const pr = row.price > 0 ? priceInfo(row.price) : null;
  const card = {
    id: row.wc_id,
    sku: row.sku,
    nombre: row.name,
    categorias: row.categories,
    descripcion: short(row.short_description || row.description, 600),
    ficha_tecnica: short(row.attributes, 500),
    disponibilidad: disponibilidad(row.stock_status),
    ...(row.stock_quantity != null ? { unidades_en_stock: row.stock_quantity } : {}),
    link: row.permalink,
    moneda: 'CLP',
  };
  if (pr) Object.assign(card, { precio_neto: pr.precio_neto, precio_con_iva: pr.precio_con_iva, nota_precio: 'Valores unitarios; el IVA es 19%' });
  else card.precio = 'No disponible: consultar con un ejecutivo';
  if (variants?.length) {
    card.variantes = variants.slice(0, 10).map((v) => {
      const vp = Number(v.price) > 0 ? priceInfo(Math.round(Number(v.price))) : null;
      return { sku: v.sku, atributos: (v.attributes || []).map((x) => `${x.name}: ${x.option}`).join(', '), disponibilidad: disponibilidad(v.stock_status), ...(vp || { precio: 'consultar' }) };
    });
  }
  return card;
}

/**
 * Ejecuta una herramienta ya validada. ctx = { session, handoff(args) }.
 * Devuelve siempre un objeto serializable; los errores van como { ok:false, error }.
 */
export async function runTool(name, args, ctx) {
  if (name === 'buscar_productos') {
    const rows = await searchCatalog(args);
    return {
      ok: true,
      total: rows.length,
      resultados: rows.map((r) => ({ id: r.wc_id, sku: r.sku, nombre: r.name, categorias: r.categories, resumen: short(r.short_description, 200), link: r.permalink })),
      nota: rows.length ? 'Para precio y stock llama a ver_producto.' : 'Sin resultados. Prueba otros términos o deriva a un ejecutivo.',
    };
  }
  if (name === 'ver_producto') {
    if (!wcEnabled()) return { ok: false, error: 'No puedo consultar precio y stock en vivo en este momento. No des precios; ofrece derivar a un ejecutivo.' };
    let wcId = args.id;
    if (!wcId && args.sku) {
      const r = await query('SELECT wc_id FROM catalog_products WHERE lower(sku)=lower($1) LIMIT 1', [args.sku]);
      wcId = r.rows[0]?.wc_id;
    }
    let p = null;
    try {
      p = wcId ? await wcGetProduct(wcId) : await wcFindBySku(args.sku);
    } catch (e) {
      return { ok: false, error: 'La tienda no respondió. No des precios; ofrece derivar a un ejecutivo.' , detalle: e.message.slice(0, 120) };
    }
    if (!p || (p.status && p.status !== 'publish')) return { ok: false, error: 'Producto no encontrado o no disponible.' };
    let variants = [];
    if (p.type === 'variable') variants = await wcVariations(p.id).catch(() => []);
    return { ok: true, ...productCard(p, variants) };
  }
  if (name === 'armar_carrito') return armarCarrito(args, ctx);
  if (name === 'generar_cotizacion') return generarCotizacion(args, ctx);
  if (name === 'derivar_ejecutivo') {
    const r = await ctx.handoff(args);
    return { ok: true, derivado: true, instruccion: 'Informa al cliente, en una o dos frases, que un ejecutivo de Quot le responderá por este mismo chat.', asignado: !!r.assignee };
  }
  return { ok: false, error: 'Herramienta desconocida' };
}
