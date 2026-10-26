import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Badge } from '../ui.jsx';

const FILTERS = [
  ['all', 'Todas'],
  ['mine', 'Mías'],
  ['unassigned', 'Sin asignar'],
  ['bot', 'Bot'],
  ['open', 'Abiertas'],
  ['resolved', 'Resueltas'],
];
const STATUS = { pending: ['Bot atendiendo', '#7c3aed'], open: ['Abierta', '#16a34a'], resolved: ['Resuelta', '#64748b'], snoozed: ['Pospuesta', '#ca8a04'] };

const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' });
};

export default function Conversations() {
  const { user, isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = Number(params.get('c')) || null;
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [list, setList] = useState([]);
  const [agents, setAgents] = useState([]);
  const [detail, setDetail] = useState(null);
  const [text, setText] = useState('');
  const [priv, setPriv] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);
  const lastCount = useRef(0);

  const loadList = useCallback(async () => {
    try {
      setList(await api.get(`/api/conversations?filter=${filter}${q ? `&q=${encodeURIComponent(q)}` : ''}`));
    } catch (e) { setError(e.message); }
  }, [filter, q]);

  const loadDetail = useCallback(async () => {
    if (!selected) { setDetail(null); return; }
    try {
      setDetail(await api.get(`/api/conversations/${selected}`));
      setError('');
    } catch (e) { setError(e.message); setDetail(null); }
  }, [selected]);

  useEffect(() => { api.get('/api/conversations/agents').then(setAgents).catch(() => {}); }, []);
  useEffect(() => { const t = setTimeout(loadList, q ? 250 : 0); return () => clearTimeout(t); }, [loadList, q]);
  useEffect(() => { const t = setInterval(loadList, 5000); return () => clearInterval(t); }, [loadList]);
  useEffect(() => { lastCount.current = 0; loadDetail(); }, [loadDetail]);
  useEffect(() => { if (!selected) return undefined; const t = setInterval(loadDetail, 4000); return () => clearInterval(t); }, [selected, loadDetail]);
  useEffect(() => {
    const n = detail?.messages?.length || 0;
    if (n !== lastCount.current) { lastCount.current = n; endRef.current?.scrollIntoView({ block: 'end' }); }
  }, [detail]);

  const act = async (fn) => {
    setError('');
    try { await fn(); await Promise.all([loadDetail(), loadList()]); } catch (e) { setError(e.message); }
  };

  const send = async () => {
    const content = text.trim();
    if (!content || !selected) return;
    setSending(true);
    await act(async () => {
      await api.post(`/api/conversations/${selected}/messages`, { content, private: priv });
      setText('');
    });
    setSending(false);
  };

  const conv = detail?.conversation;
  const mine = conv?.assignee_id === user.id;
  const st = conv ? STATUS[conv.status] || [conv.status, '#64748b'] : null;

  return (
    <div className="inbox">
      <aside className="inbox-list">
        <div className="inbox-head">
          <h2>Conversaciones</h2>
          <input className="search" placeholder="Buscar cliente, correo o RUT…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chips">
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" className={`chip creator ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="inbox-rows">
          {list.map((c) => (
            <button key={c.id} type="button" className={`inbox-row ${selected === c.id ? 'sel' : ''}`} onClick={() => setParams({ c: String(c.id) })}>
              <div className="row between">
                <strong>{c.contact_name || c.contact_email || `Visitante #${c.id}`}</strong>
                <span className="muted small">{when(c.last_message_at || c.created_at)}</span>
              </div>
              <div className="muted small clip">{c.last_message_preview || '—'}</div>
              <div className="row between" style={{ marginTop: 4 }}>
                <span className="row" style={{ gap: 6 }}>
                  <Badge color={(STATUS[c.status] || [])[1]}>{(STATUS[c.status] || [c.status])[0]}</Badge>
                  <span className="muted small">{c.channel}</span>
                </span>
                <span className="muted small">{c.assignee_name ? `👤 ${c.assignee_name}` : 'Sin asignar'}</span>
              </div>
              {c.unread_count > 0 && <span className="unread">{c.unread_count}</span>}
            </button>
          ))}
          {!list.length && <div className="empty small">No hay conversaciones con este filtro.</div>}
        </div>
      </aside>

      <section className="inbox-chat">
        {!conv && <div className="empty">{selected ? 'Cargando…' : 'Selecciona una conversación'}<Alert>{error}</Alert></div>}
        {conv && (
          <>
            <div className="chat-head">
              <div>
                <strong>{conv.contact_name || conv.contact_email || `Visitante #${conv.id}`}</strong>
                <div className="muted small">{[conv.contact_rut && `RUT ${conv.contact_rut}`, conv.contact_email, conv.contact_phone, conv.channel].filter(Boolean).join(' · ')}</div>
                {conv.handoff_reason && <div className="muted small">Motivo de derivación: {conv.handoff_reason}</div>}
              </div>
              <div className="row">
                <Badge color={st[1]}>{st[0]}</Badge>
                {isAdmin ? (
                  <select value={conv.assignee_id || ''} onChange={(e) => act(() => api.post(`/api/conversations/${conv.id}/assign`, { user_id: e.target.value || null }))} aria-label="Asignar a">
                    <option value="">Sin asignar</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                ) : mine ? (
                  <button className="btn small" onClick={() => act(() => api.post(`/api/conversations/${conv.id}/assign`, { user_id: null }))}>Soltar</button>
                ) : !conv.assignee_id ? (
                  <button className="btn small primary" onClick={() => act(() => api.post(`/api/conversations/${conv.id}/assign`, { user_id: user.id }))}>Tomar</button>
                ) : null}
                {conv.status === 'resolved' ? (
                  <button className="btn small" onClick={() => act(() => api.post(`/api/conversations/${conv.id}/status`, { status: 'open' }))}>Reabrir</button>
                ) : (
                  <button className="btn small" onClick={() => act(() => api.post(`/api/conversations/${conv.id}/status`, { status: 'resolved' }))}>Resolver</button>
                )}
              </div>
            </div>
            <Alert>{error}</Alert>
            <div className="chat-msgs">
              {detail.messages.map((m) => {
                const kind = m.is_private ? 'note' : m.sender_type === 'contact' ? 'in' : m.sender_type === 'bot' ? 'bot' : 'out';
                return (
                  <div key={m.id} className={`bubble ${kind}`}>
                    <div className="bubble-meta">
                      {m.is_private ? '🔒 Nota privada' : m.sender_type === 'contact' ? m.sender_name || 'Cliente' : m.sender_type === 'bot' ? '🤖 Asistente' : m.sender_name || 'Ejecutivo'} · {when(m.created_at)}
                    </div>
                    <div>{m.content}</div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>
            <div className="chat-compose">
              <textarea
                rows={2}
                placeholder={priv ? 'Nota privada (solo la ve tu equipo)…' : 'Escribe tu respuesta al cliente…'}
                value={text}
                className={priv ? 'is-note' : ''}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}
              />
              <div className="row between">
                <label className="check"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Nota privada</label>
                <span className="row">
                  <span className="muted small">Ctrl+Enter para enviar</span>
                  <button className="btn primary" disabled={sending || !text.trim()} onClick={send}>{priv ? 'Guardar nota' : 'Enviar'}</button>
                </span>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
