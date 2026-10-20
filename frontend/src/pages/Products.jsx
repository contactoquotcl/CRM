import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Badge, Field, Modal } from '../ui.jsx';
import { clp } from '../util.js';
import CsvMapper from '../CsvMapper.jsx';

const PRODUCT_FIELDS = [
  { key: 'sku', label: 'Código SKU', required: true, aliases: ['sku', 'codigo', 'code', 'part number', 'pn'] },
  { key: 'name', label: 'Nombre', required: true, aliases: ['nombre', 'producto', 'name', 'titulo'] },
  { key: 'description', label: 'Descripción', aliases: ['descripcion', 'description', 'detalle'] },
  { key: 'price', label: 'Precio neto (CLP)', aliases: ['precio', 'price', 'precio neto', 'valor'] },
];

export default function Products() {
  const { isAdmin } = useAuth();
  const [items, setItems] = useState([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [edit, setEdit] = useState(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api.get('/api/products' + (q ? `?q=${encodeURIComponent(q)}` : '')));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [q]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  return (
    <div>
      <div className="toolbar">
        <h2>Maestra de productos</h2>
        <input className="search" placeholder="Buscar por SKU, nombre o descripción…" value={q} onChange={(e) => setQ(e.target.value)} />
        {isAdmin && (
          <>
            <button className="btn" onClick={() => setImporting(true)}>Importar CSV</button>
            <button className="btn primary" onClick={() => setEdit({ sku: '', name: '', description: '', price: 0, active: true })}>+ Nuevo producto</button>
          </>
        )}
      </div>
      <Alert>{error}</Alert>
      {!isAdmin && <p className="muted small">Solo los administradores pueden modificar la maestra de productos.</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>SKU</th><th>Nombre</th><th>Descripción</th><th className="num">Precio neto</th><th>Estado</th></tr></thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className={isAdmin ? 'clickable' : ''} onClick={() => isAdmin && setEdit(p)}>
                <td><code>{p.sku}</code></td>
                <td>{p.name}</td>
                <td className="muted">{p.description}</td>
                <td className="num">{clp(p.price)}</td>
                <td>{p.active ? <Badge color="#16a34a">Activo</Badge> : <Badge color="#9ca3af">Inactivo</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <div className="empty">No hay productos{q ? ' que coincidan' : ' todavía'}.</div>}
      </div>

      {edit && <ProductModal product={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {importing && (
        <Modal title="Importar productos desde CSV" onClose={() => setImporting(false)} wide>
          <ImportProducts onDone={() => { setImporting(false); load(); }} />
        </Modal>
      )}
    </div>
  );
}

function ImportProducts({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const run = async (rows) => {
    setBusy(true);
    setError('');
    try {
      setRes(await api.post('/api/products/import', { rows }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (res) {
    return (
      <div className="stack">
        <Alert kind="ok">Listo: {res.created} creados, {res.updated} actualizados, {res.skipped} omitidos (sin SKU o nombre).</Alert>
        <button className="btn primary" onClick={onDone}>Cerrar</button>
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="muted small">Los productos con un SKU ya existente se actualizan (nombre, descripción y precio).</p>
      <Alert>{error}</Alert>
      <CsvMapper fields={PRODUCT_FIELDS} onRows={run} busy={busy} />
    </div>
  );
}

function ProductModal({ product, onClose, onSaved }) {
  const isNew = !product.id;
  const [f, setF] = useState(product);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const save = async () => {
    setError('');
    try {
      const body = { sku: f.sku, name: f.name, description: f.description, price: f.price, active: f.active };
      if (isNew) await api.post('/api/products', body);
      else await api.patch(`/api/products/${product.id}`, body);
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  };
  const remove = async () => {
    if (!confirm('¿Eliminar este producto? Las cotizaciones ya emitidas conservan su detalle.')) return;
    try {
      await api.del(`/api/products/${product.id}`);
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <Modal title={isNew ? 'Nuevo producto' : 'Editar producto'} onClose={onClose}>
      <Alert>{error}</Alert>
      <div className="grid2">
        <Field label="Código SKU"><input value={f.sku} onChange={set('sku')} /></Field>
        <Field label="Precio neto (CLP)"><input type="number" min="0" value={f.price} onChange={set('price')} /></Field>
      </div>
      <Field label="Nombre"><input value={f.name} onChange={set('name')} /></Field>
      <Field label="Descripción"><textarea rows={3} value={f.description} onChange={set('description')} /></Field>
      <label className="check"><input type="checkbox" checked={f.active} onChange={set('active')} /> Activo (disponible en el cotizador)</label>
      <div className="row between modal-actions">
        <div>{!isNew && <button className="btn danger" onClick={remove}>Eliminar</button>}</div>
        <div className="row">
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" onClick={save}>Guardar</button>
        </div>
      </div>
    </Modal>
  );
}
