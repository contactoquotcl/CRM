import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Alert } from '../ui.jsx';
import CsvMapper from '../CsvMapper.jsx';

// Campos del CRM ← columnas de la base "Cotizaciones Quot 2026" de Notion (alias = nombres de columna de Notion)
const LEAD_FIELDS = [
  { key: 'client_name', label: 'Cliente', aliases: ['cliente', 'nombre', 'name'] },
  { key: 'razon_social', label: 'Razón social', aliases: ['razon social'] },
  { key: 'rut', label: 'RUT', aliases: ['rut'] },
  { key: 'email', label: 'Correo', aliases: ['correo', 'email', 'mail'] },
  { key: 'contact', label: 'Contacto', aliases: ['contacto'] },
  { key: 'phone', label: 'Teléfono', aliases: ['telefono', 'fono'] },
  { key: 'whatsapp', label: 'WhatsApp', aliases: ['whatsapp'] },
  { key: 'channel', label: 'Canal', aliases: ['canal'] },
  { key: 'state', label: 'Estado', aliases: ['estado', 'etapa', 'status'] },
  { key: 'state_date', label: 'Fecha del estado', aliases: ['fecha estado'] },
  { key: 'lead_date', label: 'Fecha', aliases: ['fecha', 'created time', 'fecha cotizacion'] },
  { key: 'quote_number', label: 'N° cotización', aliases: ['n cotizacion', 'n° cotizacion', 'numero cotizacion'] },
  { key: 'legacy_id', label: 'N° correlativo (ID Notion)', aliases: ['n correlativo', 'n° correlativo', 'correlativo', 'id'] },
  { key: 'client_quote_number', label: 'N° cotiz. cliente', aliases: ['n cotiz cliente', 'n° cotiz. cliente'] },
  { key: 'invoice_number', label: 'N° factura', aliases: ['n factura', 'n° factura', 'factura'] },
  { key: 'products_text', label: 'Productos', aliases: ['productos'] },
  { key: 'subtotal', label: 'Subtotal neto', aliases: ['subtotal neto', 'subtotal', 'neto'] },
  { key: 'iva', label: 'IVA', aliases: ['iva'] },
  { key: 'total', label: 'Total c/IVA', aliases: ['total c/iva', 'total civa', 'total'] },
  { key: 'requires_supplier_quote', label: 'Requiere cotiz. proveedor', aliases: ['requiere cotiz proveedor', 'requiere cotiz. proveedor'] },
  { key: 'comments', label: 'Comentarios', aliases: ['comentarios', 'notas'] },
];

export default function Import() {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const [createStates, setCreateStates] = useState(true);
  const [bumpCounter, setBumpCounter] = useState(true);

  const run = async (rows) => {
    setBusy(true);
    setError('');
    try {
      let acc = null;
      // En tandas de 500 para no exceder el límite de cada request.
      for (let i = 0; i < rows.length; i += 500) {
        const r = await api.post('/api/import/leads', { rows: rows.slice(i, i + 500), createStates, bumpCounter });
        acc = acc
          ? { created: acc.created + r.created, updated: acc.updated + r.updated, skipped: acc.skipped + r.skipped, statesCreated: [...new Set([...acc.statesCreated, ...r.statesCreated])], unknownStates: r.unknownStates, counterSetTo: r.counterSetTo ?? acc.counterSetTo }
          : r;
      }
      setRes(acc);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (res) {
    return (
      <div className="panel">
        <h2>Importación completada</h2>
        <Alert kind="ok">{res.created} leads creados · {res.updated} actualizados · {res.skipped} filas vacías omitidas.</Alert>
        {res.statesCreated.length > 0 && <p>Estados nuevos creados en el pipeline: <strong>{res.statesCreated.join(', ')}</strong></p>}
        {res.unknownStates.length > 0 && <Alert>Estados sin coincidencia (leads en estado inicial): {res.unknownStates.join(', ')}</Alert>}
        {res.counterSetTo && <p>El próximo N° de cotización del cotizador quedó en <strong>{res.counterSetTo}</strong>.</p>}
        <div className="row">
          <Link className="btn primary" to="/">Ver pipeline</Link>
          <button className="btn" onClick={() => setRes(null)}>Importar otro archivo</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="toolbar"><h2>Importar pipeline desde Notion</h2></div>
      <div className="panel stack">
        <ol className="steps">
          <li>En Notion abre la base <strong>Cotizaciones Quot 2026</strong> → menú <code>···</code> → <strong>Exportar</strong> → formato <strong>CSV</strong>.</li>
          <li>Sube el archivo aquí. Las columnas se reconocen automáticamente y puedes corregir el mapeo.</li>
          <li>Puedes reimportar cuando quieras: los leads ya importados se <em>actualizan</em> (no se duplican) usando el N° correlativo.</li>
        </ol>
        <Alert>{error}</Alert>
        <CsvMapper fields={LEAD_FIELDS} onRows={run} busy={busy} submitLabel="Importar al CRM">
          <label className="check"><input type="checkbox" checked={createStates} onChange={(e) => setCreateStates(e.target.checked)} /> Crear automáticamente los estados que no existan en el CRM</label>
          <label className="check"><input type="checkbox" checked={bumpCounter} onChange={(e) => setBumpCounter(e.target.checked)} /> Continuar el correlativo del cotizador después del mayor N° de cotización importado</label>
        </CsvMapper>
      </div>
    </div>
  );
}
