import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Alert, Badge, Modal } from '../ui.jsx';
import { clp, fmtDate } from '../util.js';

const iso = (d) => d.toISOString().slice(0, 10);
const PRESETS = {
  month: () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), 1)), iso(n), 'day']; },
  prev: () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), iso(new Date(n.getFullYear(), n.getMonth(), 0)), 'day']; },
  q90: () => { const n = new Date(); return [iso(new Date(n.getTime() - 89 * 864e5)), iso(n), 'month']; },
  year: () => { const n = new Date(); return [`${n.getFullYear()}-01-01`, iso(n), 'month']; },
  all: () => ['', '', 'year'],
};
const pctTxt = (v) => `${String(v ?? 0).replace('.', ',')}%`;
const short = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1).replace('.', ',')}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`);

function Kpi({ label, value, sub, color }) {
  return (
    <div className="kpi" style={{ borderTopColor: color }}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// Barras agrupadas SVG: cotizado vs convertido (neto) por período
function Bars({ series }) {
  if (!series.length) return <p className="muted">Sin datos en el período.</p>;
  const W = Math.max(520, series.length * 54), H = 220, pad = { l: 46, r: 8, t: 10, b: 36 };
  const max = Math.max(...series.map((s) => Math.max(s.quoted_net, s.invoiced_net)), 1);
  const bw = (W - pad.l - pad.r) / series.length;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={W} height={H} role="img" aria-label="Cotizado versus facturado por período">
        {[0, 0.5, 1].map((t) => (
          <g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(max * t)} y2={y(max * t)} stroke="#e2e8f0" /><text x={pad.l - 6} y={y(max * t) + 4} fontSize="10" textAnchor="end" fill="#64748b">{short(max * t)}</text></g>
        ))}
        {series.map((s, i) => {
          const x = pad.l + i * bw;
          const w = Math.min(18, bw / 3);
          return (
            <g key={s.period}>
              <title>{`${s.period}\nCotizado: ${clp(s.quoted_net)} (${s.quoted_count})\nConvertido: ${clp(s.converted_net)} (${s.converted_count}, ${pctTxt(s.pct_count)})\nFacturado: ${clp(s.invoiced_net)}`}</title>
              <rect x={x + bw / 2 - w - 1} y={y(s.quoted_net)} width={w} height={H - pad.b - y(s.quoted_net)} fill="#93c5fd" rx="2" />
              <rect x={x + bw / 2 + 1} y={y(Math.max(s.invoiced_net, 0))} width={w} height={H - pad.b - y(Math.max(s.invoiced_net, 0))} fill="#16a34a" rx="2" />
              <text x={x + bw / 2} y={H - 20} fontSize="10" textAnchor="middle" fill="#334155">{s.period.length > 7 ? s.period.slice(5) : s.period}</text>
              <text x={x + bw / 2} y={H - 8} fontSize="10" textAnchor="middle" fill="#1d4ed8" fontWeight="600">{s.quoted_count ? pctTxt(s.pct_count) : ''}</text>
            </g>
          );
        })}
      </svg>
      <div className="muted" style={{ fontSize: 12 }}><span style={{ color: '#60a5fa' }}>■</span> Cotizado (neto) &nbsp; <span style={{ color: '#16a34a' }}>■</span> Facturado (neto, menos NC) &nbsp; <b style={{ color: '#1d4ed8' }}>%</b> = cotizaciones convertidas</div>
    </div>
  );
}

function Breakdown({ title, rows }) {
  return (
    <div className="table-wrap" style={{ marginBottom: 16 }}>
      <table>
        <thead><tr><th>{title}</th><th className="num">Cotiz.</th><th className="num">Convert.</th><th className="num">% cant.</th><th className="num">Cotizado neto</th><th className="num">% monto</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="num">{r.quoted_count}</td><td className="num">{r.converted_count}</td><td className="num"><b>{pctTxt(r.pct_count)}</b></td><td className="num">{clp(r.quoted_net)}</td><td className="num">{pctTxt(r.pct_amount)}</td></tr>)}
          {!rows.length && <tr><td colSpan="6" className="muted">Sin datos</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function Conversion() {
  const init = PRESETS.q90();
  const [from, setFrom] = useState(init[0]);
  const [to, setTo] = useState(init[1]);
  const [group, setGroup] = useState(init[2]);
  const [channel, setChannel] = useState('');
  const [dedupe, setDedupe] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [link, setLink] = useState(null); // { invoice, quotes }
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ group, dedupe: dedupe ? '1' : '0' });
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (channel) qs.set('channel', channel);
      setData(await api.get(`/api/conversion?${qs}`));
      setError('');
    } catch (e) { setError(e.message); }
  }, [from, to, group, channel, dedupe]);
  useEffect(() => { load(); }, [load]);

  const preset = (k) => { const [a, b, g] = PRESETS[k](); setFrom(a); setTo(b); setGroup(g); };

  const upload = async (list) => {
    const files = [...list];
    if (!files.length) return;
    setBusy(true); setReport(null);
    try {
      const payload = [];
      for (const f of files) payload.push({ name: f.name, text: await f.text() });
      setReport(await api.post('/api/conversion/upload', { files: payload }));
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const openLink = async (inv) => { try { setLink(await api.get(`/api/conversion/suggest/${inv.id}`)); } catch (e) { setError(e.message); } };
  const doLink = async (invoice_id, quote_id) => {
    try { await api.post('/api/conversion/link', { invoice_id, quote_id }); setLink(null); await load(); } catch (e) { setError(e.message); }
  };

  const k = data?.kpis;
  const cov = data?.coverage;
  const stale = cov && cov.last_invoice_date && to && cov.last_invoice_date < to;

  return (
    <div>
      <div className="toolbar">
        <h2>Conversión de cotizaciones</h2>
        <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Procesando…' : 'Subir facturación del SII'}</button>
        <input ref={fileRef} type="file" multiple accept=".xls,.html,.htm,.csv,.txt" style={{ display: 'none' }} onChange={(e) => upload(e.target.files)} />
      </div>
      <Alert>{error}</Alert>

      {report && (
        <div className="alert ok" style={{ marginBottom: 12 }}>
          {report.files.map((f) => (
            <div key={f.name}>{f.ok ? `✔ ${f.name}: ${f.documents} documentos emitidos (${f.created} nuevos, ${f.updated} actualizados)${f.recibidas_ignoradas ? ` · ${f.recibidas_ignoradas} recibidos ignorados` : ''}` : `✖ ${f.name}: ${f.error}`}</div>
          ))}
          <div>Cotizaciones conciliadas automáticamente: {report.matched}</div>
        </div>
      )}

      <div className="toolbar">
        <button className="btn small" onClick={() => preset('month')}>Este mes</button>
        <button className="btn small" onClick={() => preset('prev')}>Mes anterior</button>
        <button className="btn small" onClick={() => preset('q90')}>90 días</button>
        <button className="btn small" onClick={() => preset('year')}>Este año</button>
        <button className="btn small" onClick={() => preset('all')}>Todo</button>
        <label className="muted">Desde <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} /></label>
        <label className="muted">Hasta <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} /></label>
        <select value={group} onChange={(e) => setGroup(e.target.value)}><option value="day">Por día</option><option value="month">Por mes</option><option value="year">Por año</option></select>
        <select value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">Todos los canales</option><option value="Cotizador">Cotizador</option><option value="Chatbot">Chatbot</option></select>
        <label className="muted" title="Cotizaciones del mismo cliente y monto con menos de 30 días entre sí cuentan como una sola oportunidad"><input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} /> Agrupar repetidas</label>
      </div>

      {data && cov.invoices === 0 && <Alert kind="info">Aún no hay facturación cargada. Descarga desde el SII (Facturación → Documentos emitidos) el archivo <b>DTE_DOWN…xls</b> del mes y súbelo aquí; también acepta el CSV del libro de ventas. Puedes volver a subir meses ya cargados sin duplicar.</Alert>}
      {stale && <Alert kind="info">La facturación cargada llega hasta el {fmtDate(cov.last_invoice_date)}; el % de conversión de cotizaciones posteriores está subestimado hasta que subas más facturas.</Alert>}

      {k && (
        <>
          <div className="kpis">
            <Kpi label="% conversión (cantidad)" value={pctTxt(k.pct_count)} sub={`${k.converted_count} de ${k.quoted_count} cotizaciones${k.raw_quotes !== k.quoted_count ? ` (${k.raw_quotes} emitidas, repetidas agrupadas)` : ''}`} color="#1d4ed8" />
            <Kpi label="% conversión (monto)" value={pctTxt(k.pct_amount)} sub={`${clp(k.converted_net)} de ${clp(k.quoted_net)} neto`} color="#7c3aed" />
            <Kpi label="Cotizado (neto)" value={clp(k.quoted_net)} sub={`${k.quoted_count} oportunidades`} color="#60a5fa" />
            <Kpi label="Facturado (neto)" value={clp(k.invoiced_net)} sub={`${k.invoiced_count} facturas${k.nc_net ? ` · NC ${clp(k.nc_net)}` : ''}`} color="#16a34a" />
            <Kpi label="Facturación con cotización" value={pctTxt(k.pct_invoiced_from_quotes)} sub={`${clp(k.invoiced_from_quotes_net)} · sin cotización ${clp(k.invoiced_without_quote_net)}`} color="#f59e0b" />
            <Kpi label="Días cotización → factura" value={k.avg_days_to_invoice ?? '—'} sub={`ticket promedio ${clp(k.avg_invoice_net)}`} color="#0ea5e9" />
          </div>

          <h3>Cotizado vs facturado</h3>
          <div className="panel"><Bars series={data.series} /></div>

          <div className="two-col">
            <div><h3>Por canal</h3><Breakdown title="Canal" rows={data.by_channel} /></div>
            <div><h3>Por ejecutivo</h3><Breakdown title="Ejecutivo" rows={data.by_user} /></div>
          </div>

          <h3>Facturas sin cotización asociada</h3>
          <p className="muted" style={{ marginTop: -6 }}>Si corresponden a una cotización (distinto RUT o monto), vincúlalas a mano; así entran a la conversión.</p>
          <div className="table-wrap" style={{ marginBottom: 16 }}>
            <table>
              <thead><tr><th>Fecha</th><th>Doc.</th><th>Cliente</th><th className="num">Neto</th><th /></tr></thead>
              <tbody>
                {data.unmatched_invoices.map((i) => (
                  <tr key={i.id}><td>{fmtDate(i.fecha)}</td><td>{i.tipo === 34 ? 'Exenta' : 'Factura'} {i.folio}</td><td>{i.razon || i.rut}</td><td className="num">{clp(i.neto)}</td>
                    <td className="num"><button className="btn small" onClick={() => openLink(i)}>Vincular</button> <button className="btn small" title="Marcar como venta sin cotización" onClick={() => doLink(i.id, null)}>Sin cotización</button></td></tr>
                ))}
                {!data.unmatched_invoices.length && <tr><td colSpan="5" className="muted">Todas las facturas del período tienen cotización</td></tr>}
              </tbody>
            </table>
          </div>

          <h3>Cotizaciones abiertas más grandes</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>N°</th><th>Fecha</th><th>Cliente</th><th>Canal</th><th>Ejecutivo</th><th className="num">Neto</th><th className="num">Antigüedad</th></tr></thead>
              <tbody>
                {data.open.map((o) => <tr key={o.id}><td>{o.number}</td><td>{fmtDate(o.date)}</td><td>{o.client}</td><td><Badge>{o.channel || 'Cotizador'}</Badge></td><td>{o.user}</td><td className="num">{clp(o.net)}</td><td className="num">{o.age_days} d</td></tr>)}
                {!data.open.length && <tr><td colSpan="7" className="muted">Sin cotizaciones abiertas</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Una cotización cuenta como convertida cuando existe una factura del mismo RUT, emitida después y dentro de la ventana configurada (Admin), por el mismo monto (±1 %). Facturación cargada: {cov.invoices} documentos{cov.last_invoice_date ? `, hasta el ${fmtDate(cov.last_invoice_date)}` : ''}.</p>
        </>
      )}

      {link && (
        <Modal title={`Vincular ${link.invoice.fecha ? fmtDate(link.invoice.fecha) : ''} · ${clp(link.invoice.total)}`} onClose={() => setLink(null)}>
          {link.quotes.length ? (
            <table>
              <thead><tr><th>N°</th><th>Fecha</th><th>Cliente</th><th className="num">Total</th><th /></tr></thead>
              <tbody>{link.quotes.map((q) => <tr key={q.id}><td>{q.number}</td><td>{fmtDate(q.date)}</td><td>{q.razon_social}{q.linked_folio ? <div className="muted">ya vinculada a folio {q.linked_folio}</div> : null}</td><td className="num">{clp(q.total)}</td><td><button className="btn small primary" onClick={() => doLink(link.invoice.id, q.id)}>Vincular</button></td></tr>)}</tbody>
            </table>
          ) : <p className="muted">No hay cotizaciones de ese RUT dentro de la ventana. Si la cotización se hizo a otro RUT, impórtala o créala desde Cotizaciones.</p>}
        </Modal>
      )}
    </div>
  );
}
