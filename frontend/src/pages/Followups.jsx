import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Alert, Badge, Modal } from '../ui.jsx';
import { clp, fmtDate } from '../util.js';

const STAGES = ['Cotizado', 'Seguimiento 1', 'Seguimiento 2'];
const MODE = { manual: ['Manual', '#64748b'], auto: ['Automático', '#16a34a'], pausado: ['Pausado', '#b45309'] };
const STEP_LABEL = { s1: 'Seguimiento 1', s2: 'Seguimiento 2', close: 'Archivado', reply: 'Respuesta del cliente' };
const fmtDT = (t) => new Date(t).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });

export default function Followups() {
  const [data, setData] = useState(null);
  const [channel, setChannel] = useState('all');
  const [stage, setStage] = useState('Cotizado');
  const [sel, setSel] = useState(new Set());
  const [log, setLog] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // { preview, ids }
  const [results, setResults] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/followups?channel=${channel}`));
      if (stage === 'Historial') setLog(await api.get('/api/followups/log'));
    } catch (e) { setError(e.message); }
  }, [channel, stage]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSel(new Set()); }, [stage, channel]);

  const rows = useMemo(() => (data?.rows || []).filter((r) => r.state_name === stage), [data, stage]);
  const counts = useMemo(() => Object.fromEntries(STAGES.map((s) => [s, (data?.rows || []).filter((r) => r.state_name === s).length])), [data]);
  const allSel = rows.length > 0 && rows.every((r) => sel.has(r.lead_id));
  const toggle = (id) => setSel((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = [...sel];
  const next = rows[0]?.next_label;

  const openConfirm = async () => {
    setError(''); setMsg('');
    try {
      const first = rows.find((r) => sel.has(r.lead_id));
      setConfirm({ preview: await api.get(`/api/followups/preview/${first.lead_id}`), ids });
    } catch (e) { setError(e.message); }
  };
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/followups/send', { lead_ids: confirm.ids });
      setConfirm(null); setResults(r); setSel(new Set()); await load();
    } catch (e) { setError(e.message); setConfirm(null); } finally { setBusy(false); }
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

      <div className="seg" style={{ marginBottom: 12 }}>
        {STAGES.map((s) => <button key={s} className={stage === s ? 'on' : ''} onClick={() => setStage(s)}>{s} ({counts[s] ?? 0})</button>)}
        <button className={stage === 'Historial' ? 'on' : ''} onClick={() => setStage('Historial')}>Historial de envíos</button>
      </div>

      {stage !== 'Historial' && (
        <>
          <div className="row" style={{ marginBottom: 10, gap: 8 }}>
            <button className="btn primary" disabled={!ids.length || busy} onClick={openConfirm}>
              {stage === 'Seguimiento 2' ? `Archivar${data?.send_on_archive ? ' y avisar' : ''} (${ids.length})` : `Enviar ${next || 'seguimiento'} y avanzar (${ids.length})`}
            </button>
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
                <th>N°</th><th>Cliente</th><th>Contacto / correo</th><th className="num">Total c/IVA</th><th>En etapa</th><th>Toca</th><th>Modo</th><th>Último correo</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lead_id}>
                    <td><input type="checkbox" checked={sel.has(r.lead_id)} onChange={() => toggle(r.lead_id)} aria-label={`Seleccionar ${r.number}`} /></td>
                    <td><strong>{r.number}</strong><div className="muted small">{r.quote_date ? fmtDate(r.quote_date) : ''}</div>{!r.has_pdf && <Badge color="#64748b">sin PDF</Badge>}</td>
                    <td>{r.razon_social}</td>
                    <td>{r.contact}<div className="muted small">{r.email || '—'}</div>{r.problems.map((p) => <Badge key={p} color="#dc2626">{p}</Badge>)}</td>
                    <td className="num">{r.total > 0 ? clp(r.total) : '—'}</td>
                    <td>{r.days_in_state} d</td>
                    <td>{r.due ? <Badge color="#16a34a">ya toca</Badge> : <span className="muted">en {r.due_in_days} d</span>}</td>
                    <td><Badge color={MODE[r.follow_mode]?.[1]}>{MODE[r.follow_mode]?.[0] || r.follow_mode}</Badge></td>
                    <td className="small">{r.last_email ? <>{STEP_LABEL[r.last_email.step]} · {r.last_email.status}<br /><span className="muted">{fmtDT(r.last_email.created_at)}</span></> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
                {data && !rows.length && <tr><td colSpan="9" className="muted">No hay cotizaciones en «{stage}».</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {stage === 'Historial' && (
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
                  <td className="small">{l.trigger === 'auto' ? 'Automático' : l.sent_by_name || 'Manual'}</td>
                </tr>
              ))}
              {!log.length && <tr><td colSpan="7" className="muted">Aún no hay envíos.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {confirm && (
        <Modal title={confirm.preview.error ? 'No se puede avanzar' : `${confirm.preview.label}: ${confirm.ids.length} cotización(es)`} onClose={() => setConfirm(null)} wide>
          {confirm.preview.error ? <p>{confirm.preview.error}</p> : (
            <>
              <p>Cada cotización pasará de <strong>{stage}</strong> a <strong>{confirm.preview.to_state}</strong>{confirm.preview.sends_mail ? ', enviando el correo con su PDF adjunto' : ' (se archiva sin enviar correo; puedes activar el aviso en Admin)'}.</p>
              {confirm.preview.sends_mail && (
                <div className="panel" style={{ background: '#f8fafc' }}>
                  <div className="muted small">Vista previa con la cotización N° {confirm.preview.number} · Para: {confirm.preview.to || '—'} · Adjunto: {confirm.preview.attachment || 'sin adjunto (cotización antigua sin PDF registrado)'}</div>
                  <div style={{ margin: '6px 0' }}><strong>{confirm.preview.subject}</strong></div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{confirm.preview.text}</div>
                </div>
              )}
              <p className="muted small">Las plantillas se editan en Admin → Empresa y cotizador. Un paso ya enviado nunca se repite.</p>
              <div className="modal-actions">
                <button className="btn" onClick={() => setConfirm(null)}>Cancelar</button>
                <button className="btn primary" disabled={busy} onClick={send}>{busy ? 'Enviando…' : `Confirmar (${confirm.ids.length})`}</button>
              </div>
            </>
          )}
        </Modal>
      )}
      {results && (
        <Modal title={`Resultado: ${results.sent} listas, ${results.failed} con problemas`} onClose={() => setResults(null)}>
          <ul className="stack" style={{ paddingLeft: 18 }}>
            {results.results.map((r) => <li key={r.lead_id} style={{ color: r.ok ? '#166534' : '#b91c1c' }}>N° {r.number}: {r.message}</li>)}
          </ul>
          <div className="modal-actions"><button className="btn primary" onClick={() => setResults(null)}>Cerrar</button></div>
        </Modal>
      )}
    </div>
  );
}
