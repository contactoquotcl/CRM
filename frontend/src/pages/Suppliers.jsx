import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Alert, Badge, Field, Modal } from '../ui.jsx';
import { formatRut, validRut } from '../util.js';

const empty = { rut: '', razon_social: '', contact: '', email: '', phone: '', address: '', payment_terms: '', notes: '' };

/** Formulario de proveedor (también se usa dentro de la orden de compra para crear uno al vuelo). */
export function SupplierModal({ supplier, onClose, onSaved }) {
  const [f, setF] = useState({ ...empty, ...(supplier || {}) });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setError('');
    if (!validRut(f.rut)) return setError('RUT inválido: revisa el dígito verificador.');
    setBusy(true);
    try {
      const r = supplier?.id ? await api.patch(`/api/suppliers/${supplier.id}`, f) : await api.post('/api/suppliers', f);
      onSaved(r);
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Modal title={supplier?.id ? 'Editar proveedor' : 'Nuevo proveedor'} onClose={onClose} wide>
      <Alert>{error}</Alert>
      <div className="grid3">
        <Field label="RUT *"><input value={f.rut} onChange={set('rut')} onBlur={() => f.rut && setF((x) => ({ ...x, rut: formatRut(x.rut) }))} placeholder="76123456-7" /></Field>
        <Field label="Razón social *"><input value={f.razon_social} onChange={set('razon_social')} /></Field>
        <Field label="Persona de contacto *"><input value={f.contact} onChange={set('contact')} /></Field>
        <Field label="Correo *"><input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Teléfono *"><input value={f.phone} onChange={set('phone')} placeholder="+56 9 …" /></Field>
        <Field label="Condiciones de pago" hint="Se precargan en sus órdenes de compra."><input value={f.payment_terms} onChange={set('payment_terms')} placeholder="Ej. 30 días" /></Field>
      </div>
      <Field label="Dirección"><input value={f.address} onChange={set('address')} /></Field>
      <Field label="Notas internas"><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Guardando…' : 'Guardar'}</button>
      </div>
    </Modal>
  );
}

export default function Suppliers() {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get(`/api/suppliers?all=${all ? 1 : 0}&q=${encodeURIComponent(q)}`).then(setRows).catch((e) => setError(e.message)), [q, all]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  const toggle = async (s) => { try { await api.patch(`/api/suppliers/${s.id}`, { active: !s.active }); load(); } catch (e) { setError(e.message); } };
  return (
    <div>
      <div className="toolbar">
        <h2>Proveedores</h2>
        <input placeholder="Buscar por razón social, RUT, contacto o correo…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
        <label className="muted"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Ver desactivados</label>
        <button className="btn primary" onClick={() => setEdit({})}>+ Nuevo proveedor</button>
      </div>
      <Alert>{error}</Alert>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Razón social</th><th>RUT</th><th>Contacto</th><th>Correo</th><th>Teléfono</th><th className="num">Órdenes</th><th /></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.razon_social} {!s.active && <Badge color="#9ca3af">Desactivado</Badge>}</td>
                <td>{s.rut}</td><td>{s.contact}</td><td>{s.email}</td><td>{s.phone}</td><td className="num">{s.po_count}</td>
                <td className="row"><button className="btn small" onClick={() => setEdit(s)}>Editar</button><button className="btn small" onClick={() => toggle(s)}>{s.active ? 'Desactivar' : 'Activar'}</button></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="7" className="muted">Sin proveedores. Crea el primero con «Nuevo proveedor».</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && <SupplierModal supplier={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}
