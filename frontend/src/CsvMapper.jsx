import { useMemo, useState } from 'react';
import Papa from 'papaparse';
import { norm } from './util.js';
import { Alert } from './ui.jsx';

/**
 * Lee un CSV en el navegador y deja mapear sus columnas a los campos del CRM.
 * fields: [{ key, label, required?, aliases: [...] }]
 * onRows(rowsMapeadas) se llama al confirmar.
 */
export default function CsvMapper({ fields, onRows, busy, submitLabel = 'Importar', children }) {
  const [data, setData] = useState(null); // { headers, rows }
  const [map, setMap] = useState({});
  const [error, setError] = useState('');

  const onFile = (file) => {
    if (!file) return;
    setError('');
    Papa.parse(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.replace(/^﻿/, '').trim(),
      complete: (res) => {
        const headers = res.meta.fields || [];
        if (!headers.length || !res.data.length) return setError('El archivo no tiene filas o encabezados.');
        const normHeaders = headers.map((h) => [h, norm(h)]);
        const auto = {};
        for (const f of fields) {
          const wanted = [f.key, f.label, ...(f.aliases || [])].map(norm);
          const hit = normHeaders.find(([, n]) => wanted.includes(n));
          if (hit) auto[f.key] = hit[0];
        }
        setData({ headers, rows: res.data });
        setMap(auto);
      },
      error: (e) => setError(e.message),
    });
  };

  const mapped = useMemo(() => {
    if (!data) return [];
    return data.rows.map((r) => Object.fromEntries(fields.map((f) => [f.key, map[f.key] ? r[map[f.key]] ?? '' : ''])));
  }, [data, map, fields]);

  const missing = fields.filter((f) => f.required && !map[f.key]);
  const shown = fields.filter((f) => map[f.key]);

  return (
    <div className="stack">
      <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
      <Alert>{error}</Alert>
      {data && (
        <>
          <p className="muted">
            {data.rows.length} filas · {Object.keys(map).length} de {fields.length} campos mapeados automáticamente. Ajusta lo que haga falta:
          </p>
          <div className="map-grid">
            {fields.map((f) => (
              <label key={f.key} className="map-row">
                <span>{f.label}{f.required && ' *'}</span>
                <select value={map[f.key] || ''} onChange={(e) => setMap({ ...map, [f.key]: e.target.value || undefined })}>
                  <option value="">— no importar —</option>
                  {data.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>

          <div className="table-wrap" style={{ maxHeight: 220 }}>
            <table>
              <thead><tr>{shown.map((f) => <th key={f.key}>{f.label}</th>)}</tr></thead>
              <tbody>
                {mapped.slice(0, 5).map((r, i) => (
                  <tr key={i}>{shown.map((f) => <td key={f.key}>{String(r[f.key]).slice(0, 40)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Vista previa de las primeras 5 filas.</p>

          {children}
          {missing.length > 0 && <Alert>Falta mapear: {missing.map((f) => f.label).join(', ')}</Alert>}
          <div>
            <button className="btn primary" disabled={busy || missing.length > 0} onClick={() => onRows(mapped)}>
              {busy ? 'Importando…' : `${submitLabel} (${data.rows.length} filas)`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
