import PDFDocument from 'pdfkit';
import { clp } from './util.js';

const INK = '#0f172a';
const MUTED = '#64748b';
const ACCENT = '#1d4ed8';
const LINE = '#e2e8f0';

const fmtDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
};

function addDays(iso, days) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Devuelve un Buffer con el PDF de la cotización. */
export function renderQuotePdf(quote, items, settings) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, compress: process.env.PDF_NO_COMPRESS !== '1', info: { Title: `Cotización N° ${quote.number}`, Author: settings.company_name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 40;
    const R = doc.page.width - 40;
    const W = R - L;

    // Encabezado
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(26).text('QUOT', L, 40);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5);
    const co = [settings.company_name, settings.company_rut && `RUT ${settings.company_rut}`, settings.company_address, [settings.company_email, settings.company_phone].filter(Boolean).join(' · '), settings.company_web].filter(Boolean);
    doc.text(co.join('\n'), L, 70, { width: 280, lineGap: 1 });

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text('COTIZACIÓN', 330, 42, { width: R - 330, align: 'right' });
    doc.fontSize(12).fillColor(ACCENT).text(`N° ${quote.number}`, 330, 62, { width: R - 330, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    doc.text(`Fecha: ${fmtDate(quote.quote_date)}`, 330, 82, { width: R - 330, align: 'right' });
    doc.text(`Válida hasta: ${fmtDate(addDays(quote.quote_date, quote.validity_days))}`, 330, 95, { width: R - 330, align: 'right' });

    // Datos cliente
    let y = 132;
    doc.roundedRect(L, y, W, 74, 4).fillAndStroke('#f8fafc', LINE);
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('CLIENTE', L + 12, y + 9);
    const col = (label, value, x, yy) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label, x, yy);
      doc.fillColor(INK).font('Helvetica').fontSize(10).text(value || '—', x, yy + 10, { width: W / 2 - 24 });
    };
    col('Razón social', quote.razon_social, L + 12, y + 24);
    col('RUT', quote.rut, L + 12, y + 50 - 2);
    col('Contacto', quote.contact, L + W / 2, y + 24);
    col('Correo / Teléfono', [quote.email, quote.phone].filter(Boolean).join('  ·  '), L + W / 2, y + 48);

    // Tabla
    y = 226;
    const cols = { sku: L + 8, desc: L + 88, qty: L + 330, unit: L + 372, total: L + 450 };
    const header = () => {
      doc.rect(L, y, W, 22).fill(INK);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5);
      doc.text('SKU', cols.sku, y + 7);
      doc.text('DESCRIPCIÓN', cols.desc, y + 7);
      doc.text('CANT.', cols.qty, y + 7, { width: 36, align: 'right' });
      doc.text('P. UNIT. NETO', cols.unit, y + 7, { width: 70, align: 'right' });
      doc.text('TOTAL NETO', cols.total, y + 7, { width: W - (cols.total - L) - 8, align: 'right' });
      y += 22;
    };
    header();

    doc.font('Helvetica').fontSize(9);
    items.forEach((it, i) => {
      const descH = doc.heightOfString(it.description || '', { width: 232 });
      const rowH = Math.max(24, descH + 12);
      if (y + rowH > doc.page.height - 190) {
        doc.addPage();
        y = 40;
        header();
      }
      if (i % 2 === 1) doc.rect(L, y, W, rowH).fill('#f8fafc');
      doc.fillColor(INK).font('Helvetica').fontSize(9);
      doc.text(it.sku || '', cols.sku, y + 6, { width: 76 });
      doc.text(it.description || '', cols.desc, y + 6, { width: 232 });
      doc.text(String(it.qty), cols.qty, y + 6, { width: 36, align: 'right' });
      doc.text(clp(it.unit_price), cols.unit, y + 6, { width: 70, align: 'right' });
      doc.text(clp(it.line_total), cols.total, y + 6, { width: W - (cols.total - L) - 8, align: 'right' });
      y += rowH;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(0.5).stroke();
    });

    // Totales
    if (y > doc.page.height - 200) {
      doc.addPage();
      y = 40;
    }
    y += 14;
    const tx = L + W - 220;
    const totalRow = (label, value, bold) => {
      doc.fillColor(bold ? INK : MUTED).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10);
      doc.text(label, tx, y, { width: 110 });
      doc.fillColor(INK).text(clp(value), tx + 110, y, { width: 110, align: 'right' });
      y += bold ? 20 : 16;
    };
    totalRow('Subtotal neto', quote.subtotal);
    totalRow(`IVA (${quote.iva_rate}%)`, quote.iva);
    doc.moveTo(tx, y).lineTo(R, y).strokeColor(INK).lineWidth(1).stroke();
    y += 6;
    totalRow('TOTAL', quote.total, true);

    // Notas y condiciones
    y += 8;
    const block = (title, text) => {
      if (!text) return;
      const h = doc.heightOfString(text, { width: W, lineGap: 2 }) + 20;
      if (y + h > doc.page.height - 50) {
        doc.addPage();
        y = 40;
      }
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text(title, L, y);
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(text, L, y + 12, { width: W, lineGap: 2 });
      y += h + 4;
    };
    block('OBSERVACIONES', quote.notes);
    block('CONDICIONES COMERCIALES', settings.quote_terms);

    doc.end();
  });
}
