import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { Alert, Field } from '../ui.jsx';
import { clp, formatRut, validRut } from '../util.js';

const emptyClient = { rut: '', razon_social: '', email: '', contact: '', phone: '' };

export default function Quoter() {
  const [params] = useSearchParams();
  const leadId = params.get('lead');
  const [client, setClient] = useState(emptyClient);
  const [items, setItems] = useState([]);
  const [notes, setNotes] = useState('');
  const [validity, setValidity] = useState(15);
  const [settings, setSettings] = useState({ iva_rate: '19' });
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [showList, setShowList] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [prefillNote, setPrefillNote] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    api.get('/api/settings').then((s) => { setSettings(s); setValidity(Number(s.quote_validity_days) || 15); }).catch(() => {});
    api.get('/api/products?active=1').then(setProducts).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!leadId) return;
    api.get(`/api/leads/${leadId}`).then((l) => {
      setClient({ rut: l.rut || '', razon_social: l.razon_social || l.client_name || '', email: l.email || '', contact: l.contact || '', phone: l.phone || l.whatsapp || '' });
    }).catch((e) => setError(e.message));
  }, [leadId]);

  useEffect(() => {
    const h = (e) => boxRef.current && !boxRef.current.contains(e.target) && setShowList(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const matches = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = s ? products.filter((p) => `${p.sku} ${p.name} ${p.description}`.toLowerCase().includes(s)) : products;
    return list.slice(0, 8);
  }, [products, search]);

  const rate = Number(settings.iva_rate) || 19;
  const subtotal = items.reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
  const iva = Math.round((subtotal * rate) / 100);
  const total = subtotal + iva;

  const setC = (k) => (e) => setClient({ ...client, [k]: e.target.value });
  const setItem = (i, k, v) => setItems(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));

  const addProduct = (p) => {
    setItems([...items, { product_id: p.id, sku: p.sku, description: p.description ? `${p.name} — ${p.description}` : p.name, qty: 1, unit_price: p.price }]);
    setSearch('');
    setShowList(false);
  };

  // Al salir del RUT: normaliza y, si el cliente ya existe en el pipeline, autocompleta sus datos.
  const onRutBlur = async () => {
    if (!client.rut) return;
    const rut = formatRut(client.rut);
    setClient((c) => ({ ...c, rut }));
    if (!validRut(rut) || client.razon_social || leadId) return;
    try {
      const found = (await api.get(`/api/leads?q=${encodeURIComponent(rut)}`)).find((l) => l.rut === rut && l.razon_social);
      if (found) {
        setClient((c) => ({ ...c, razon_social: found.razon_social, email: c.email || found.email, contact: c.contact || found.contact, phone: c.phone || found.phone || found.whatsapp }));
        setPrefillNote('Datos autocompletados desde un lead existente con este RUT.');
      }
    } catch { /* silencioso */ }
  };

  const submit = async () => {
    setError('');
    if (!validRut(client.rut)) return setError('RUT inválido: revisa el dígito verificador.');
    setBusy(true);
    try {
      const r = await api.post('/api/quotes', { client, items, notes, validity_days: validity, lead_id: leadId ? Number(leadId) : undefined });
      setDone(r);
      api.openPdf(r.id).catch(() => {});
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => { setDone(null); setClient(emptyClient); setItems([]); setNotes(''); setPrefillNote(''); };

  if (done) {
    return (
      <div className="panel center">
        <h2>Cotización N° {done.number} generada</h2>
        <p>Total con IVA: <strong>{clp(done.total)}</strong></p>
        <p className="muted">El lead quedó registrado en el pipeline como <strong>Cotizado</strong>.</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn primary" onClick={() => api.openPdf(done.id)}>Abrir / descargar PDF</button>
          <Link className="btn" to="/">Ver pipeline</Link>
          <button className="btn" onClick={reset}>Nueva cotización</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="toolbar"><h2>Cotizador</h2>{leadId && <span className="muted small">Re-cotizando un lead existente</span>}</div>
      <Alert>{error}</Alert>

      <div className="panel">
        <h3>Datos del cliente</h3>
        <div className="grid3">
          <Field label="RUT *"><input value={client.rut} onChange={setC('rut')} onBlur={onRutBlur} placeholder="76123456-7" /></Field>
          <Field label="Razón social *"><input value={client.razon_social} onChange={setC('razon_social')} /></Field>
          <Field label="Contacto *"><input value={client.contact} onChange={setC('contact')} /></Field>
          <Field label="Correo *"><input type="email" value={client.email} onChange={setC('email')} /></Field>
          <Field label="Teléfono *"><input value={client.phone} onChange={setC('phone')} placeholder="+56 9 …" /></Field>
        </div>
        {prefillNote && <p className="muted small">{prefillNote}</p>}
      </div>

      <div className="panel">
        <div className="row between">
          <h3>Ítems</h3>
          <button className="btn small" onClick={() => setItems([...items, { product_id: null, sku: '', description: '', qty: 1, unit_price: 0 }])}>+ Ítem libre</button>
        </div>
        <div className="combo" ref={boxRef}>
          <input
            placeholder="Buscar en la maestra de productos (SKU, nombre…) y presionar para agregar"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShowList(true); }}
            onFocus={() => setShowList(true)}
          />
          {showList && (
            <div className="combo-list">
              {matches.map((p) => (
                <button key={p.id} type="button" onClick={() => addProduct(p)}>
                  <span><code>{p.sku}</code> {p.name}</span>
                  <span className="muted">{clp(p.price)}</span>
                </button>
              ))}
              {!matches.length && <div className="empty small">Sin resultados. Usa “+ Ítem libre” para escribirlo a mano.</div>}
            </div>
          )}
        </div>

        {items.length > 0 && (
          <div className="table-wrap">
            <table className="items">
              <thead><tr><th style={{ width: 120 }}>SKU</th><th>Descripción</th><th style={{ width: 80 }}>Cant.</th><th style={{ width: 130 }}>P. unit. neto</th><th className="num" style={{ width: 120 }}>Total neto</th><th style={{ width: 36 }} /></tr></thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td><input value={it.sku} onChange={(e) => setItem(i, 'sku', e.target.value)} /></td>
                    <td><textarea rows={2} value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} /></td>
                    <td><input type="number" min="1" value={it.qty} onChange={(e) => setItem(i, 'qty', e.target.value)} /></td>
                    <td><input type="number" min="0" value={it.unit_price} onChange={(e) => setItem(i, 'unit_price', e.target.value)} /></td>
                    <td className="num">{clp((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</td>
                    <td><button className="icon-btn" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Quitar">×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!items.length && <div className="empty">Agrega productos desde la maestra o un ítem libre.</div>}

        <div className="totals">
          <div><span>Subtotal neto</span><span>{clp(subtotal)}</span></div>
          <div><span>IVA ({rate}%)</span><span>{clp(iva)}</span></div>
          <div className="grand"><span>Total</span><span>{clp(total)}</span></div>
        </div>
      </div>

      <div className="panel">
        <div className="grid3">
          <Field label="Validez (días)"><input type="number" min="1" value={validity} onChange={(e) => setValidity(e.target.value)} /></Field>
        </div>
        <Field label="Observaciones (aparecen en el PDF)"><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary big" disabled={busy || !items.length} onClick={submit}>{busy ? 'Generando…' : 'Generar cotización y registrar lead'}</button>
      </div>
    </div>
  );
}
