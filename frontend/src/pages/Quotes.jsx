import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Alert } from '../ui.jsx';
import { clp, fmtDate } from '../util.js';

export default function Quotes() {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => api.get('/api/quotes' + (q ? `?q=${encodeURIComponent(q)}` : '')).then(setRows).catch((e) => setError(e.message)), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div>
      <div className="toolbar">
        <h2>Cotizaciones emitidas</h2>
        <input className="search" placeholder="Buscar por N°, cliente, RUT o contacto…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Alert>{error}</Alert>
      <div className="table-wrap">
        <table>
          <thead><tr><th>N°</th><th>Fecha</th><th>Razón social</th><th>RUT</th><th>Contacto</th><th className="num">Total c/IVA</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.number}</strong></td>
                <td>{fmtDate(r.quote_date)}</td>
                <td>{r.razon_social}</td>
                <td>{r.rut}</td>
                <td>{r.contact}</td>
                <td className="num">{clp(r.total)}</td>
                <td><button className="btn small" onClick={() => api.openPdf(r.id).catch((e) => setError(e.message))}>PDF</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty">Aún no hay cotizaciones emitidas.</div>}
      </div>
    </div>
  );
}
