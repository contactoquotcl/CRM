import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Alert, Badge, Field, Modal } from '../ui.jsx';

export default function Admin() {
  const [tab, setTab] = useState('states');
  return (
    <div>
      <div className="toolbar">
        <h2>Administración</h2>
        <div className="seg">
          <button className={tab === 'states' ? 'on' : ''} onClick={() => setTab('states')}>Estados del pipeline</button>
          <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>Usuarios</button>
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Empresa y cotizador</button>
        </div>
      </div>
      {tab === 'states' && <States />}
      {tab === 'users' && <Users />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}

function States() {
  const [rows, setRows] = useState([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#0ea5e9');
  const [error, setError] = useState('');
  const [dragIdx, setDragIdx] = useState(null);

  const load = useCallback(() => api.get('/api/states').then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const wrap = async (fn) => {
    setError('');
    try { await fn(); await load(); } catch (e) { setError(e.message); }
  };

  const drop = (to) => {
    if (dragIdx === null || dragIdx === to) return;
    const next = [...rows];
    const [m] = next.splice(dragIdx, 1);
    next.splice(to, 0, m);
    setRows(next);
    setDragIdx(null);
    wrap(() => api.put('/api/states/reorder', { ids: next.map((s) => s.id) }));
  };

  const remove = (s) => wrap(async () => {
    if (s.leads > 0) {
      const target = prompt(`Hay ${s.leads} leads en "${s.name}". Escribe el nombre del estado al que moverlos:`);
      const dest = rows.find((r) => r.id !== s.id && r.name.toLowerCase() === (target || '').trim().toLowerCase());
      if (!dest) throw new Error('Estado de destino no encontrado; no se eliminó nada.');
      await api.del(`/api/states/${s.id}?moveTo=${dest.id}`);
    } else if (confirm(`¿Eliminar el estado "${s.name}"?`)) {
      await api.del(`/api/states/${s.id}`);
    }
  });

  return (
    <div className="panel stack">
      <p className="muted">Arrastra para reordenar las columnas del tablero. El estado <strong>inicial</strong> es el que reciben los leads nuevos creados por el cotizador.</p>
      <Alert>{error}</Alert>
      <ul className="plain sortable">
        {rows.map((s, i) => (
          <li key={s.id} draggable onDragStart={() => setDragIdx(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(i)} className="row between">
            <div className="row">
              <span className="grip">⠿</span>
              <input type="color" value={s.color} onChange={(e) => wrap(() => api.patch(`/api/states/${s.id}`, { color: e.target.value }))} />
              <input defaultValue={s.name} onBlur={(e) => e.target.value !== s.name && wrap(() => api.patch(`/api/states/${s.id}`, { name: e.target.value }))} />
              {s.is_initial && <Badge color="#2563eb">Inicial</Badge>}
              <span className="muted small">{s.leads} leads</span>
            </div>
            <div className="row">
              {!s.is_initial && <button className="btn small" onClick={() => wrap(() => api.patch(`/api/states/${s.id}`, { is_initial: true }))}>Hacer inicial</button>}
              {!s.is_initial && <button className="btn small danger" onClick={() => remove(s)}>Eliminar</button>}
            </div>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; wrap(async () => { await api.post('/api/states', { name, color }); setName(''); }); }}>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <input placeholder="Nuevo estado (ej. Negociación)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary">Agregar estado</button>
      </form>
    </div>
  );
}

function Users() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState(null);
  const load = useCallback(() => api.get('/api/users').then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const patch = async (id, body) => {
    setError('');
    try { await api.patch(`/api/users/${id}`, body); await load(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="panel stack">
      <div className="row between">
        <p className="muted">Administrador: todo, incluida la maestra de productos, estados, usuarios e importación. Estándar: pipeline y cotizador; consulta productos.</p>
        <button className="btn primary" onClick={() => setCreating(true)}>+ Nuevo usuario</button>
      </div>
      <Alert>{error}</Alert>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>
                    <option value="admin">Administrador</option>
                    <option value="user">Estándar</option>
                  </select>
                </td>
                <td>{u.active ? <Badge color="#16a34a">Activo</Badge> : <Badge color="#9ca3af">Desactivado</Badge>}</td>
                <td className="row">
                  <button className="btn small" onClick={() => setResetFor(u)}>Restablecer clave</button>
                  <button className="btn small" onClick={() => patch(u.id, { active: !u.active })}>{u.active ? 'Desactivar' : 'Activar'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <NewUser onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
      {resetFor && <ResetPw user={resetFor} onClose={() => setResetFor(null)} />}
    </div>
  );
}

function NewUser({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'user' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try { await api.post('/api/users', f); onSaved(); } catch (e) { setError(e.message); }
  };
  return (
    <Modal title="Nuevo usuario" onClose={onClose}>
      <Alert>{error}</Alert>
      <Field label="Nombre"><input value={f.name} onChange={set('name')} /></Field>
      <Field label="Correo"><input type="email" value={f.email} onChange={set('email')} /></Field>
      <Field label="Contraseña inicial" hint="Mínimo 8 caracteres"><input type="text" value={f.password} onChange={set('password')} /></Field>
      <Field label="Rol">
        <select value={f.role} onChange={set('role')}><option value="user">Estándar</option><option value="admin">Administrador</option></select>
      </Field>
      <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" onClick={save}>Crear usuario</button>
      </div>
    </Modal>
  );
}

function ResetPw({ user, onClose }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const save = async () => {
    try { await api.patch(`/api/users/${user.id}`, { password: pw }); setOk(true); } catch (e) { setError(e.message); }
  };
  return (
    <Modal title={`Restablecer clave · ${user.name}`} onClose={onClose}>
      <Alert>{error}</Alert>
      <Alert kind="ok">{ok ? 'Contraseña actualizada.' : ''}</Alert>
      {!ok && <Field label="Nueva contraseña" hint="Mínimo 8 caracteres"><input type="text" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>}
      <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>{ok ? 'Cerrar' : 'Cancelar'}</button>
        {!ok && <button className="btn primary" onClick={save}>Guardar</button>}
      </div>
    </Modal>
  );
}

function Settings() {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  useEffect(() => { api.get('/api/settings').then(setS).catch((e) => setError(e.message)); }, []);
  if (!s) return <Alert>{error}</Alert>;
  const set = (k) => (e) => { setOk(false); setS({ ...s, [k]: e.target.value }); };
  const save = async () => {
    setError('');
    try { setS(await api.put('/api/settings', s)); setOk(true); } catch (e) { setError(e.message); }
  };
  return (
    <div className="panel stack">
      <p className="muted">Estos datos aparecen en el encabezado de los PDF de cotización.</p>
      <Alert>{error}</Alert>
      <Alert kind="ok">{ok ? 'Configuración guardada.' : ''}</Alert>
      <div className="grid2">
        <Field label="Razón social de la empresa"><input value={s.company_name} onChange={set('company_name')} /></Field>
        <Field label="RUT de la empresa"><input value={s.company_rut} onChange={set('company_rut')} /></Field>
        <Field label="Dirección"><input value={s.company_address} onChange={set('company_address')} /></Field>
        <Field label="Sitio web"><input value={s.company_web} onChange={set('company_web')} /></Field>
        <Field label="Correo"><input value={s.company_email} onChange={set('company_email')} /></Field>
        <Field label="Teléfono"><input value={s.company_phone} onChange={set('company_phone')} /></Field>
        <Field label="IVA (%)"><input type="number" value={s.iva_rate} onChange={set('iva_rate')} /></Field>
        <Field label="Validez por defecto (días)"><input type="number" value={s.quote_validity_days} onChange={set('quote_validity_days')} /></Field>
        <Field label="Próximo N° de cotización" hint="Correlativo: la siguiente cotización usará este número"><input type="number" min="1" value={s.quote_next_number} onChange={set('quote_next_number')} /></Field>
      </div>
      <h3 style={{ marginTop: 8 }}>Datos para transferencia (aparecen en el PDF)</h3>
      <div className="grid3">
        <Field label="Nombre / titular"><input value={s.bank_holder || ''} onChange={set('bank_holder')} /></Field>
        <Field label="RUT"><input value={s.bank_rut || ''} onChange={set('bank_rut')} /></Field>
        <Field label="Banco"><input value={s.bank_name || ''} onChange={set('bank_name')} /></Field>
        <Field label="Tipo de cuenta"><input value={s.bank_account_type || ''} onChange={set('bank_account_type')} /></Field>
        <Field label="N° de cuenta"><input value={s.bank_account_number || ''} onChange={set('bank_account_number')} /></Field>
        <Field label="Correo"><input value={s.bank_email || ''} onChange={set('bank_email')} /></Field>
      </div>
      <Field label="Condiciones comerciales (pie del PDF)"><textarea rows={5} value={s.quote_terms} onChange={set('quote_terms')} /></Field>
      <div><button className="btn primary" onClick={save}>Guardar configuración</button></div>
    </div>
  );
}
