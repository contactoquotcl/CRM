import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Alert, Badge, Modal } from '../ui.jsx';
import { clp, fmtDate } from '../util.js';

const STAGES = ['Cotizado', 'Seguimiento 1', 'Seguimiento 2'];
const STAGE_COLOR = { Cotizado: '#2563eb', 'Seguimiento 1': '#d97706', 'Seguimiento 2': '#ea580c' };
const MODE = { manual: ['Manual', '#64748b'], auto: ['Automático', '#16a34a'], pausado: ['Pausado', '#b45309'] };
const STEP_LABEL = { s1: 'Seguimiento 1', s2: 'Seguimiento 2', close: 'Archivado', reply: 'Respuesta del cliente', quote: 'Cotización enviada' };
const fmtDT = (t) => new Date(t).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });

export default function Followups() {
  const [data, setData] = useState(null);
  const [channel, setChannel] = useState('all');
  const [view, setView] = useState('lista'); // lista | historial
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState(new Set());
  const [log, setLog] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // { preview, ids }
  const [results, setResults] = useState(null);
  const [sched, setSched] = useState(null); // { ids, at }

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/followups?channel=${channel}`));
      if (view === 'historial') setLog(await api.get('/api/followups/log'));
    } catch (e) { setError(e.message); }
  }, [channel, view]);
  useEffect(() => { load(); }, [load]);
  // El pipeline manda: se refresca solo y al volver a la pestaña para reflejar movimientos manuales de etapa
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(); }, 45000);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);
  useEffect(() => { setSel(new Set()); }, [view, channel]);

  // Una sola tabla con todos los clientes en seguimiento: primero los que ya tocan (más días en la etapa arriba)
  const rows = useMemo(() => {
    const t = search.trim().toLowerCase();
    return (data?.rows || [])
      .filter((r) => !t || `${r.number} ${r.razon_social} ${r.contact} ${r.email} ${(r.created_by_names || []).join(' ')}`.toLowerCase().includes(t))
      .sort((a, b) => Number(b.due && !b.problems.length) - Number(a.due && !a.problems.length) || b.days_in_state - a.days_in_state);
  }, [data, search]);
  const counts = useMemo(() => Object.fromEntries(STAGES.map((s) => [s, (data?.rows || []).filter((r) => r.state_name === s).length])), [data]);
  const dueCount = useMemo(() => (data?.rows || []).filter((r) => r.due && !r.problems.length).length, [data]);
  const allSel = rows.length > 0 && rows.every((r) => sel.has(r.lead_id));
  const toggle = (id) => setSel((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = [...sel];

  const openConfirm = async () => {
    setError(''); setMsg('');
    try {
      // Los seleccionados pueden estar en distintas etapas: una vista previa por cada paso distinto
      const chosen = rows.filter((r) => sel.has(r.lead_id));
      const groups = [];
      for (const st of STAGES) {
        const inStage = chosen.filter((r) => r.state_name === st);
        if (inStage.length) groups.push({ state: st, count: inStage.length, preview: await api.get(`/api/followups/preview/${inStage[0].lead_id}`) });
      }
      setConfirm({ groups, ids });
    } catch (e) { setError(e.message); }
  };
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/followups/send', { lead_ids: confirm.ids });
      setConfirm(null); setResults(r); setSel(new Set()); await load();
    } catch (e) { setError(e.message); setConfirm(null); } finally { setBusy(false); }
  };
  const openSched = () => {
    const d = new Date(Date.now() + 86400000); d.setHours(9, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    setSched({ ids, at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` });
  };
  const doSched = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post('/api/followups/schedule', { lead_ids: sched.ids, at: new Date(sched.at).toISOString() });
      setSched(null); setSel(new Set()); setResults({ sent: r.scheduled, failed: r.failed, results: r.results, scheduled: true }); await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const unsched = async () => {
    setError(''); setMsg('');
    try { await api.post('/api/followups/unschedule', { lead_ids: ids }); setMsg('Programación cancelada.'); setSel(new Set()); await load(); } catch (e) { setError(e.message); }
  };
  const setMode = async (mode) => {
    setError(''); setMsg('');
    try { await api.post('/api/followups/mode', { lead_ids: ids, mode }); setMsg(`${ids.length} cotización(es) en modo ${MODE[mode][0].toLowerCase()}.`); setSel(new Set()); await load(); } catch (e) { setError(e.message); }
  };
  const checkReplies = async () => {
    setError(''); setMsg(''); setBusy(true);
    try { const r = await api.post('/api/followups/check-replies'); setMsg(r.count ? `Clientes que respondieron (pausados): ${r.replied.map((x) => 'N° ' + x.number).join(', ')}.` : 'Nadie ha respondido todavía.'); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const runAuto = async () => {
    setError(''); setMsg(''); setBusy(true);
    try { const r = await api.post('/api/followups/run-auto'); setMsg(`Seguimientos automáticos enviados ahora: ${r.sent}.`); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="toolbar">
        <h2>Seguimiento de cotizaciones</h2>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Origen">
          <option value="all">Todas las cotizaciones</option>
          <option value="ia">Solo cotizaciones del bot (IA)</option>
        </select>
      </div>
      {data && !data.configured && <Alert>El envío de correos aún no está configurado. Ve a <Link to="/admin">Admin → Integraciones (claves) → Correo de seguimiento</Link> y carga la clave del servicio.</Alert>}
      <Alert>{error}</Alert>
      <Alert kind="ok">{msg}</Alert>
      {data?.hidden_without_quote > 0 && <p className="muted small">Hay {data.hidden_without_quote} leads en etapas de cotización sin N° de cotización (derivaciones del chat sin cotizar): no se incluyen aquí.</p>}
      {data && <p className="muted small">Correos enviados hoy: <strong>{data.sent_today}</strong>{data.daily_limit ? ` de ${data.daily_limit} permitidos` : ''} · Servicio: {data.provider} · Cada correo lleva el PDF adjunto cuando la cotización está registrada y responde a contacto@quot.cl.{data.provider === 'Gmail' ? ' Si el cliente responde, la cotización se pausa sola.' : ''}</p>}

      <div className="row" style={{ marginBottom: 12, gap: 10, flexWrap: 'wrap' }}>
        <div className="seg">
          <button className={view === 'lista' ? 'on' : ''} onClick={() => setView('lista')}>Clientes en seguimiento ({data?.rows?.length ?? 0})</button>
          <button className={view === 'historial' ? 'on' : ''} onClick={() => setView('historial')}>Historial de envíos</button>
        </div>
        {view === 'lista' && <input className="search" placeholder="Buscar por N°, cliente, contacto o creador…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 340 }} />}
        {view === 'lista' && data && <span className="muted small">{STAGES.map((st) => `${st}: ${counts[st] ?? 0}`).join(' · ')} · <strong>Ya tocan: {dueCount}</strong></span>}
      </div>

      {view === 'lista' && (
        <>
          <div className="row" style={{ marginBottom: 10, gap: 8 }}>
            <button className="btn primary" disabled={!ids.length || busy} onClick={openConfirm} title="Cada cliente recibe el siguiente paso según su estado y avanza en el pipeline">
              {`Enviar siguiente paso y avanzar (${ids.length})`}
            </button>
            <button className="btn" disabled={!ids.length || busy} onClick={openSched} title="Elige fecha y hora; se envía solo y avanza de etapa">Programar envío</button>
            <button className="btn" disabled={!ids.length} onClick={unsched}>Cancelar programación</button>
            <button className="btn" disabled={!ids.length} onClick={() => setMode('auto')}>Activar automático</button>
            <button className="btn" disabled={!ids.length} onClick={() => setMode('pausado')}>Pausar (cliente respondió)</button>
            <button className="btn" disabled={!ids.length} onClick={() => setMode('manual')}>Volver a manual</button>
            {data?.provider === 'Gmail' && <button className="btn" disabled={busy} onClick={checkReplies} title="Revisa en Gmail si los clientes respondieron y pausa esas cotizaciones">Revisar respuestas</button>}
            <button className="btn" disabled={busy} onClick={runAuto} title="Envía ahora los automáticos que ya cumplieron los días">Ejecutar automáticos ahora</button>
            <button className="btn small" onClick={() => setSel(new Set(rows.filter((r) => r.due && !r.problems.length).map((r) => r.lead_id)))}>Seleccionar las que ya tocan</button>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th><input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map((r) => r.lead_id)))} aria-label="Seleccionar todas" /></th>
                <th>N°</th><th>Cliente</th><th>Creada por</th><th>Contacto / correo</th><th className="num">Total c/IVA</th><th>Estado en el pipeline</th><th>Siguiente paso</th><th>Modo</th><th>Último correo</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lead_id}>
                    <td><input type="checkbox" checked={sel.has(r.lead_id)} onChange={() => toggle(r.lead_id)} aria-label={`Seleccionar ${r.number}`} /></td>
                    <td><strong>{r.number}</strong><div className="muted small">{r.quote_date ? fmtDate(r.quote_date) : ''}</div>{r.quote_count > 1 && <Badge color="#0ea5e9">{r.quote_count} cotizaciones del cliente</Badge>}{!r.has_pdf && <Badge color="#64748b">sin PDF</Badge>}</td>
                    <td>{r.razon_social}</td>
                    <td>{r.created_by_names?.length ? r.created_by_names.join(', ') : <span className="muted">—</span>}</td>
                    <td>{r.contact}<div className="muted small">{r.email || '—'}</div>{r.problems.map((p) => <Badge key={p} color="#dc2626">{p}</Badge>)}</td>
                    <td className="num">{r.total > 0 ? clp(r.total) : '—'}{r.quote_count > 1 && <div className="muted small">suma de {r.quote_count}</div>}</td>
                    <td><Badge color={STAGE_COLOR[r.state_name]}>{r.state_name}</Badge><div className="muted small">{r.days_in_state} d en esta etapa</div></td>
                    <td><div className="small">{r.state_name === 'Seguimiento 2' ? 'Archivar' : `Enviar ${r.next_label}`}</div>{r.due ? <Badge color="#16a34a">ya toca</Badge> : <span className="muted">en {r.due_in_days} d</span>}{r.follow_sched_at && <div><Badge color="#7c3aed">Programado</Badge><div className="small">{fmtDT(r.follow_sched_at)}</div></div>}</td>
                    <td><Badge color={MODE[r.follow_mode]?.[1]}>{MODE[r.follow_mode]?.[0] || r.follow_mode}</Badge></td>
                    <td className="small">{r.last_email ? <>{STEP_LABEL[r.last_email.step]} · {r.last_email.status}<br /><span className="muted">{fmtDT(r.last_email.created_at)}</span></> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
                {data && !rows.length && <tr><td colSpan="10" className="muted">{search ? 'Sin resultados para la búsqueda.' : 'No hay clientes en seguimiento.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === 'historial' && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Fecha</th><th>Cotización</th><th>Paso</th><th>Para</th><th>Asunto</th><th>Resultado</th><th>Origen</th></tr></thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.id}>
                  <td>{fmtDT(l.created_at)}</td>
                  <td>{l.number ? `N° ${l.number}` : '—'}<div className="muted small">{l.razon_social}</div></td>
                  <td>{l.from_state} → {l.to_state}</td>
                  <td>{l.to_email || '—'}</td>
                  <td className="small">{l.subject}</td>
                  <td><Badge color={l.status === 'enviado' ? '#16a34a' : l.status === 'error' ? '#dc2626' : '#64748b'}>{l.status}</Badge>{l.error && <div className="small" style={{ color: '#dc2626' }}>{l.error}</div>}</td>
                  <td className="small">{l.trigger === 'auto' ? 'Automático' : l.trigger === 'bot' ? 'Bot (al cotizar)' : l.trigger === 'programado' ? 'Programado' : l.sent_by_name || 'Manual'}</td>
                </tr>
              ))}
              {!log.length && <tr><td colSpan="7" className="muted">Aún no hay envíos.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {confirm && (
        <Modal title={`Enviar siguiente paso: ${confirm.ids.length} cliente(s)`} onClose={() => setConfirm(null)} wide>
          <p>Cada cliente recibe el paso que le corresponde según su estado y avanza en el pipeline:</p>
          {confirm.groups.map((g) => (
            <div key={g.state} className="panel" style={{ background: '#f8fafc' }}>
              <p style={{ margin: 0 }}><Badge color={STAGE_COLOR[g.state]}>{g.state}</Badge> → <strong>{g.preview.to_state || '—'}</strong> · {g.count} cliente(s){g.preview.error ? '' : g.preview.sends_mail ? ', con correo y PDF adjunto' : ' (se archiva sin enviar correo; puedes activar el aviso en Admin)'}</p>
              {g.preview.error ? <p className="err">{g.preview.error}</p> : g.preview.sends_mail && (
                <>
                  <div className="muted small" style={{ marginTop: 6 }}>Vista previa con la cotización N° {g.preview.number} · Para: {g.preview.to || '—'} · Adjunto: {g.preview.attachment || 'sin adjunto (cotización antigua sin PDF registrado)'}</div>
                  <div style={{ margin: '6px 0' }}><strong>{g.preview.subject}</strong></div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{g.preview.text}</div>
                </>
              )}
            </div>
          ))}
          <p className="muted small">Las plantillas se editan en Admin → Empresa y cotizador. Un paso ya enviado nunca se repite.</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirm(null)}>Cancelar</button>
            <button className="btn primary" disabled={busy} onClick={send}>{busy ? 'Enviando…' : `Confirmar (${confirm.ids.length})`}</button>
          </div>
        </Modal>
      )}
      {sched && (
        <Modal title={`Programar envío (${sched.ids.length})`} onClose={() => setSched(null)}>
          <p>Se enviará a esa hora el siguiente paso de cada cliente seleccionado (según su estado), con su PDF, y avanzará de etapa automáticamente.</p>
          <label className="field"><span>Fecha y hora</span><input type="datetime-local" value={sched.at} onChange={(e) => setSched({ ...sched, at: e.target.value })} /></label>
          <p className="muted small">El envío sale dentro de ~15 min de la hora elegida y solo si el servidor está activo. Se cancela si cambias la etapa o pausas la cotización; respeta el límite diario.</p>
          <div className="modal-actions"><button className="btn" onClick={() => setSched(null)}>Cancelar</button><button className="btn primary" disabled={busy || !sched.at} onClick={doSched}>Programar</button></div>
        </Modal>
      )}
      {results && (
        <Modal title={`${results.scheduled ? 'Programadas' : 'Resultado'}: ${results.sent} ${results.scheduled ? '' : 'listas'}, ${results.failed} con problemas`} onClose={() => setResults(null)}>
          <ul className="stack" style={{ paddingLeft: 18 }}>
            {results.results.map((r) => <li key={r.lead_id} style={{ color: r.ok ? '#166534' : '#b91c1c' }}>N° {r.number}: {r.message}</li>)}
          </ul>
          <div className="modal-actions"><button className="btn primary" onClick={() => setResults(null)}>Cerrar</button></div>
        </Modal>
      )}
    </div>
  );
}
