import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Alert, Badge } from '../ui.jsx';
import { clp, fmtDate } from '../util.js';

export const PO_STATUS_COLOR = { Emitida: '#2563eb', Enviada: '#f59e0b', Recibida: '#16a34a', Anulada: '#9ca3af' };

export default function PurchaseOrders() {
  const nav = useNavigate();
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => api.get(`/api/purchase-orders?q=${encodeURIComponent(q)}&status=${status}`).then(setRows).catch((e) => setError(e.message)), [q, status]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  return (
    <div>
      <div className="toolbar">
        <h2>Órdenes de compra</h2>
        <input placeholder="Buscar por N°, proveedor o RUT…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos los estados</option>{Object.keys(PO_STATUS_COLOR).map((s) => <option key={s}>{s}</option>)}</select>
        <Link className="btn" to="/proveedores">Proveedores</Link>
        <button className="btn primary" onClick={() => nav('/ordenes-compra/nueva')}>+ Nueva orden de compra</button>
      </div>
      <Alert>{error}</Alert>
      <div className="table-wrap">
        <table>
          <thead><tr><th>N°</th><th>Fecha</th><th>Proveedor</th><th>Estado</th><th className="num">Neto</th><th className="num">Total</th><th>Creada por</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/ordenes-compra/${r.id}`}><strong>{r.number}</strong></Link></td>
                <td>{fmtDate(r.po_date)}</td><td>{r.razon_social}<div className="muted small">{r.rut}</div></td>
                <td><Badge color={PO_STATUS_COLOR[r.status]}>{r.status}</Badge></td>
                <td className="num">{clp(r.subtotal)}</td><td className="num">{clp(r.total)}</td><td>{r.created_by_name || '—'}</td>
                <td className="row"><Link className="btn small" to={`/ordenes-compra/${r.id}`}>Abrir</Link><button className="btn small" onClick={() => api.openPdf(r.id, 'purchase-orders').catch((e) => setError(e.message))}>PDF</button></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="8" className="muted">Aún no hay órdenes de compra. La primera partirá con el N° 65.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
