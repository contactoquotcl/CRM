import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Alert, Badge, Field } from '../ui.jsx';
import { clp, fmtDate } from '../util.js';
import { SupplierModal } from './Suppliers.jsx';
import { PO_STATUS_COLOR } from './PurchaseOrders.jsx';

export default function PurchaseOrderForm() {
  const { id } = useParams();
  const isNew = id === 'nueva';
  const nav = useNavigate();
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [settings, setSettings] = useState({ iva_rate: '19' });
  const [po, setPo] = useState(null);
  const [supplierId, setSupplierId] = useState('');
  const [items, setItems] = useState([]);
  const [f, setF] = useState({ delivery_date: '', delivery_address: '', payment_terms: '', notes: '' });
  const [search, setSearch] = useState('');
  const [showList, setShowList] = useState(false);
  const [newSup, setNewSup] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);

  const loadSuppliers = () => api.get('/api/suppliers').then(setSuppliers).catch((e) => setError(e.message));
  useEffect(() => {
    loadSuppliers();
    api.get('/api/settings').then(setSettings).catch(() => {});
    api.get('/api/products?active=1').then(setProducts).catch(() => {});
  }, []);
  useEffect(() => {
    if (isNew) return;
    api.get(`/api/purchase-orders/${id}`).then((p) => {
      setPo(p); setSupplierId(String(p.supplier_id || ''));
      setItems(p.items.map((i) => ({ product_id: i.product_id, sku: i.sku, description: i.description, qty: i.qty, cost: i.unit_cost })));
      setF({ delivery_date: p.delivery_date || '', delivery_address: p.delivery_address || '', payment_terms: p.payment_terms || '', notes: p.notes || '' });
    }).catch((e) => setError(e.message));
  }, [id, isNew]);
  useEffect(() => {
    const h = (e) => boxRef.current && !boxRef.current.contains(e.target) && setShowList(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const locked = po?.status === 'Anulada';
  const supplier = suppliers.find((s) => String(s.id) === supplierId);
  const masterCost = useMemo(() => Object.fromEntries(products.map((p) => [p.id, p.price])), [products]);
  const matches = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (s ? products.filter((p) => `${p.sku} ${p.name} ${p.description}`.toLowerCase().includes(s)) : products).slice(0, 8);
  }, [products, search]);
  const rate = Number(settings.iva_rate) || 19;
  const subtotal = items.reduce((a, i) => a + (Math.round(Number(i.qty)) || 0) * (Math.round(Number(i.cost)) || 0), 0);
  const iva = Math.round((subtotal * rate) / 100);
  const setItem = (i, k, v) => setItems(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  const setField = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const addProduct = (p) => { setItems([...items, { product_id: p.id, sku: p.sku, description: p.description ? `${p.name} — ${p.description}` : p.name, qty: 1, cost: p.price }]); setSearch(''); setShowList(false); };
  const pickSupplier = (v) => { setSupplierId(v); const s = suppliers.find((x) => String(x.id) === v); if (s && !f.payment_terms) setF((x) => ({ ...x, payment_terms: s.payment_terms || '' })); };

  const save = async () => {
    setError(''); setOk('');
    if (!supplierId) return setError('Selecciona un proveedor.');
    setBusy(true);
    try {
      const body = { supplier_id: Number(supplierId), items, ...f };
      if (isNew) { const r = await api.post('/api/purchase-orders', body); nav(`/ordenes-compra/${r.id}`, { replace: true }); }
      else { await api.put(`/api/purchase-orders/${id}`, body); setOk('Cambios guardados.'); setPo(await api.get(`/api/purchase-orders/${id}`)); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const setStatus = async (status) => { try { await api.patch(`/api/purchase-orders/${id}/status`, { status }); setPo({ ...po, status }); } catch (e) { setError(e.message); } };
  const send = async () => {
    setError(''); setOk('');
    try { const r = await api.post(`/api/purchase-orders/${id}/send`, {}); setOk(`Enviada a ${r.to}.`); setPo(await api.get(`/api/purchase-orders/${id}`)); } catch (e) { setError(e.message); }
  };

  return (
    <div>
      <div className="toolbar">
        <Link to="/ordenes-compra" className="btn small">← Órdenes</Link>
        <h2>{isNew ? 'Nueva orden de compra' : `Orden de compra N° ${po?.number ?? ''}`}</h2>
        {po && <Badge color={PO_STATUS_COLOR[po.status]}>{po.status}</Badge>}
        {po && <span className="muted small">{fmtDate(po.po_date)}{po.created_by_name ? ` · ${po.created_by_name}` : ''}</span>}
        {po && <button className="btn" onClick={() => api.openPdf(po.id, 'purchase-orders').catch((e) => setError(e.message))}>Abrir PDF</button>}
        {po && !locked && <button className="btn" onClick={send} title={`Envía el PDF a ${supplier?.email || po.email}`}>Enviar al proveedor</button>}
        {po && <select value={po.status} onChange={(e) => setStatus(e.target.value)}>{Object.keys(PO_STATUS_COLOR).map((s) => <option key={s}>{s}</option>)}</select>}
      </div>
      <Alert>{error}</Alert><Alert kind="ok">{ok}</Alert>

      <div className="panel">
        <h3>Proveedor</h3>
        <div className="row">
          <select value={supplierId} onChange={(e) => pickSupplier(e.target.value)} disabled={locked} style={{ maxWidth: 420 }}>
            <option value="">Selecciona un proveedor…</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.razon_social} — {s.rut}</option>)}
          </select>
          {!locked && <button className="btn small" onClick={() => setNewSup(true)}>+ Nuevo proveedor</button>}
        </div>
        {supplier && <p className="muted small">Contacto: {supplier.contact} · {supplier.email} · {supplier.phone}</p>}
      </div>

      <div className="panel">
        <div className="row between">
          <h3>Ítems</h3>
          {!locked && <button className="btn small" onClick={() => setItems([...items, { product_id: null, sku: '', description: '', qty: 1, cost: 0 }])}>+ Ítem libre</button>}
        </div>
        {!locked && (
          <div className="combo" ref={boxRef}>
            <input placeholder="Buscar en la maestra de productos (SKU, nombre…) y presionar para agregar" value={search} onChange={(e) => { setSearch(e.target.value); setShowList(true); }} onFocus={() => setShowList(true)} />
            {showList && (
              <div className="combo-list">
                {matches.map((p) => <button key={p.id} type="button" onClick={() => addProduct(p)}><span><code>{p.sku}</code> {p.name}</span><span className="muted">{clp(p.price)}</span></button>)}
                {!matches.length && <div className="empty small">Sin resultados. Usa “+ Ítem libre”.</div>}
              </div>
            )}
          </div>
        )}
        {items.length > 0 && (
          <div className="table-wrap">
            <table className="items">
              <thead><tr><th style={{ width: 110 }}>SKU</th><th>Descripción</th><th style={{ width: 80 }}>Cant.</th><th style={{ width: 150 }}>Costo unit. neto</th><th className="num" style={{ width: 120 }}>Total neto</th><th style={{ width: 36 }} /></tr></thead>
              <tbody>
                {items.map((it, i) => {
                  const m = it.product_id ? masterCost[it.product_id] : undefined;
                  const diff = m !== undefined && Number(it.cost) !== Number(m);
                  return (
                    <tr key={i}>
                      <td><input disabled={locked} value={it.sku} onChange={(e) => setItem(i, 'sku', e.target.value)} /></td>
                      <td><textarea disabled={locked} rows={2} value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} /></td>
                      <td><input disabled={locked} type="number" min="1" value={it.qty} onChange={(e) => setItem(i, 'qty', e.target.value)} /></td>
                      <td>
                        <input disabled={locked} type="number" min="0" value={it.cost} onChange={(e) => setItem(i, 'cost', e.target.value)} />
                        {m !== undefined && <div className={`muted small${diff ? ' warn' : ''}`} style={diff ? { color: '#b45309' } : undefined}>Maestra: {clp(m)}{diff ? ' (editado)' : ''}</div>}
                      </td>
                      <td className="num">{clp((Math.round(Number(it.qty)) || 0) * (Math.round(Number(it.cost)) || 0))}</td>
                      <td>{!locked && <button className="icon-btn" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Quitar">×</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!items.length && <div className="empty">Agrega productos desde la maestra o un ítem libre. El costo es editable: ingresa el que tenga el proveedor hoy.</div>}
        <div className="totals">
          <div><span>Subtotal neto</span><span>{clp(subtotal)}</span></div>
          <div><span>IVA ({rate}%)</span><span>{clp(iva)}</span></div>
          <div className="grand"><span>Total</span><span>{clp(subtotal + iva)}</span></div>
        </div>
      </div>

      <div className="panel">
        <div className="grid3">
          <Field label="Entrega requerida"><input type="date" disabled={locked} value={f.delivery_date} onChange={setField('delivery_date')} /></Field>
          <Field label="Condiciones de pago"><input disabled={locked} value={f.payment_terms} onChange={setField('payment_terms')} placeholder="Ej. 30 días" /></Field>
        </div>
        <Field label="Dirección de entrega"><input disabled={locked} value={f.delivery_address} onChange={setField('delivery_address')} /></Field>
        <Field label="Observaciones (aparecen en el PDF)"><textarea disabled={locked} rows={3} value={f.notes} onChange={setField('notes')} /></Field>
      </div>

      {!locked && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary big" disabled={busy || !items.length || !supplierId} onClick={save}>{busy ? 'Guardando…' : isNew ? 'Generar orden de compra' : 'Guardar cambios'}</button>
        </div>
      )}
      {newSup && <SupplierModal onClose={() => setNewSup(false)} onSaved={(s) => { setNewSup(false); loadSuppliers().then(() => pickSupplier(String(s.id))); }} />}
    </div>
  );
}
