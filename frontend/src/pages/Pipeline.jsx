import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Badge, Field, Modal } from '../ui.jsx';
import { clp, fmtDate, formatRut } from '../util.js';

const EMPTY = { client_name: '', razon_social: '', rut: '', email: '', contact: '', phone: '', whatsapp: '', channel: '', state_id: '', client_quote_number: '', invoice_number: '', total: 0, products_text: '', comments: '', requires_supplier_quote: false };

export default function Pipeline() {
  const [states, setStates] = useState([]);
  const [leads, setLeads] = useState([]);
  const [q, setQ] = useState('');
  const [view, setView] = useState('board');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // lead id | 'new'
  const [dragId, setDragId] = useState(null);
  const [overState, setOverState] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([api.get('/api/states'), api.get('/api/leads' + (q ? `?q=${encodeURIComponent(q)}` : ''))]);
      setStates(s);
      setLeads(l);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [q]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const byState = useMemo(() => {
    const m = new Map(states.map((s) => [s.id, []]));
    for (const l of leads) (m.get(l.state_id) || m.set(l.state_id, []).get(l.state_id)).push(l);
    return m;
  }, [states, leads]);

  const move = async (leadId, stateId) => {
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.state_id === stateId) return;
    setLeads((ls) => ls.map((l) => (l.id === leadId ? { ...l, state_id: stateId } : l)));
    try {
      await api.patch(`/api/leads/${leadId}`, { state_id: stateId });
      load();
    } catch (e) {
      setError(e.message);
      load();
    }
  };

  const noState = byState.get(null) || byState.get(undefined) || [];

  return (
    <div>
      <div className="toolbar">
        <h2>Pipeline</h2>
        <input className="search" placeholder="Buscar cliente, RUT, correo o N° cotización…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Tablero</button>
          <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Tabla</button>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>+ Nuevo lead</button>
      </div>
      <Alert>{error}</Alert>

      {view === 'board' ? (
        <div className="board">
          {states.map((s) => {
            const list = byState.get(s.id) || [];
            const sum = list.reduce((a, l) => a + (l.total || 0), 0);
            return (
              <div
                key={s.id}
                className={`column ${overState === s.id ? 'over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setOverState(s.id); }}
                onDragLeave={() => setOverState((o) => (o === s.id ? null : o))}
                onDrop={() => { setOverState(null); if (dragId) move(dragId, s.id); setDragId(null); }}
              >
                <div className="column-head" style={{ borderTopColor: s.color }}>
                  <strong>{s.name}</strong>
                  <span className="muted small">{list.length} · {clp(sum)}</span>
                </div>
                <div className="cards">
                  {list.map((l) => (
                    <div key={l.id} className="card lead-card" draggable onDragStart={() => setDragId(l.id)} onDragEnd={() => setDragId(null)} onClick={() => setEditing(l.id)}>
                      <div className="card-title">{l.razon_social || l.client_name || '(sin nombre)'}</div>
                      <div className="muted small">{l.quote_number ? `Cotiz. N° ${l.quote_number}` : 'Sin cotización'}{l.contact ? ` · ${l.contact}` : ''}</div>
                      <div className="card-foot">
                        <strong>{l.total ? clp(l.total) : '—'}</strong>
                        <span className="muted small">{fmtDate(l.state_date || l.lead_date)}</span>
                      </div>
                    </div>
                  ))}
                  {!list.length && <div className="empty small">Sin leads</div>}
                </div>
              </div>
            );
          })}
          {noState.length > 0 && (
            <div className="column">
              <div className="column-head"><strong>Sin estado</strong><span className="muted small">{noState.length}</span></div>
              <div className="cards">
                {noState.map((l) => (
                  <div key={l.id} className="card lead-card" draggable onDragStart={() => setDragId(l.id)} onClick={() => setEditing(l.id)}>
                    <div className="card-title">{l.razon_social || l.client_name}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>N°</th><th>Cliente</th><th>RUT</th><th>Contacto</th><th>Estado</th><th>Fecha estado</th><th className="num">Total c/IVA</th></tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="clickable" onClick={() => setEditing(l.id)}>
                  <td>{l.quote_number || ''}</td>
                  <td>{l.razon_social || l.client_name}</td>
                  <td>{l.rut}</td>
                  <td>{l.contact}</td>
                  <td>{l.state_name ? <Badge color={l.state_color}>{l.state_name}</Badge> : ''}</td>
                  <td>{fmtDate(l.state_date || l.lead_date)}</td>
                  <td className="num">{l.total ? clp(l.total) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!leads.length && <div className="empty">No hay leads. Importa tu pipeline desde Notion o genera una cotización.</div>}
        </div>
      )}

      {editing && <LeadModal id={editing} states={states} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function LeadModal({ id, states, onClose, onSaved }) {
  const isNew = id === 'new';
  const { isAdmin } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState(isNew ? { ...EMPTY, state_id: states.find((s) => s.is_initial)?.id || states[0]?.id || '' } : null);
  const [quotes, setQuotes] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isNew) return;
    api.get(`/api/leads/${id}`).then((l) => { setQuotes(l.quotes || []); setF(l); }).catch((e) => setError(e.message));
  }, [id, isNew]);

  if (!f) return <Modal title="Lead" onClose={onClose}><Alert>{error}</Alert>{!error && <p className="muted">Cargando…</p>}</Modal>;

  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body = { ...f, state_id: Number(f.state_id) || null };
      if (isNew) await api.post('/api/leads', body);
      else await api.patch(`/api/leads/${id}`, body);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm('¿Eliminar este lead definitivamente?')) return;
    try {
      await api.del(`/api/leads/${id}`);
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <Modal title={isNew ? 'Nuevo lead' : `Lead${f.quote_number ? ` · Cotización N° ${f.quote_number}` : ''}`} onClose={onClose} wide>
      <Alert>{error}</Alert>
      <div className="grid2">
        <Field label="Razón social"><input value={f.razon_social || ''} onChange={set('razon_social')} /></Field>
        <Field label="Cliente / nombre comercial"><input value={f.client_name || ''} onChange={set('client_name')} /></Field>
        <Field label="RUT"><input value={f.rut || ''} onChange={set('rut')} onBlur={() => f.rut && setF({ ...f, rut: formatRut(f.rut) })} placeholder="76123456-7" /></Field>
        <Field label="Estado">
          <select value={f.state_id || ''} onChange={set('state_id')}>
            {states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Contacto"><input value={f.contact || ''} onChange={set('contact')} /></Field>
        <Field label="Correo"><input type="email" value={f.email || ''} onChange={set('email')} /></Field>
        <Field label="Teléfono"><input value={f.phone || ''} onChange={set('phone')} /></Field>
        <Field label="WhatsApp"><input value={f.whatsapp || ''} onChange={set('whatsapp')} /></Field>
        <Field label="Canal"><input value={f.channel || ''} onChange={set('channel')} placeholder="WhatsApp, WooCommerce, Manual…" /></Field>
        <Field label="N° cotización del cliente"><input value={f.client_quote_number || ''} onChange={set('client_quote_number')} /></Field>
        <Field label="N° factura"><input value={f.invoice_number || ''} onChange={set('invoice_number')} /></Field>
        <Field label="Total c/IVA (CLP)"><input type="number" min="0" value={f.total ?? 0} onChange={set('total')} /></Field>
      </div>
      <Field label="Productos"><textarea rows={2} value={f.products_text || ''} onChange={set('products_text')} /></Field>
      <Field label="Comentarios"><textarea rows={3} value={f.comments || ''} onChange={set('comments')} /></Field>
      <label className="check"><input type="checkbox" checked={!!f.requires_supplier_quote} onChange={set('requires_supplier_quote')} /> Requiere cotización a proveedor</label>

      {!isNew && (
        <div className="section">
          <div className="row between">
            <strong>Cotizaciones generadas</strong>
            <button className="btn" onClick={() => nav(`/cotizador?lead=${id}`)}>+ Nueva cotización para este lead</button>
          </div>
          {quotes.length ? (
            <ul className="plain">
              {quotes.map((qt) => (
                <li key={qt.id} className="row between">
                  <span>N° {qt.number} · {fmtDate(qt.quote_date)} · {clp(qt.total)}</span>
                  <button className="btn small" onClick={() => api.openPdf(qt.id).catch((e) => setError(e.message))}>Ver PDF</button>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">Aún no hay cotizaciones emitidas desde el CRM para este lead.</p>}
        </div>
      )}

      <div className="row between modal-actions">
        <div>{!isNew && isAdmin && <button className="btn danger" onClick={remove}>Eliminar</button>}</div>
        <div className="row">
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </div>
    </Modal>
  );
}
