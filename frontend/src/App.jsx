import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { api } from './api.js';
import { Alert, Field, Modal } from './ui.jsx';
import Pipeline from './pages/Pipeline.jsx';
import Products from './pages/Products.jsx';
import Quoter from './pages/Quoter.jsx';
import Quotes from './pages/Quotes.jsx';
import Followups from './pages/Followups.jsx';
import Conversion from './pages/Conversion.jsx';
import Import from './pages/Import.jsx';
import Admin from './pages/Admin.jsx';
import Conversations from './pages/Conversations.jsx';

function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div className="brand big">Quot <span>CRM</span></div>
        <Alert>{error}</Alert>
        <Field label="Correo"><input type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Contraseña"><input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <button className="btn primary big" disabled={busy}>{busy ? 'Ingresando…' : 'Ingresar'}</button>
      </form>
    </div>
  );
}

function Account({ onClose }) {
  const [f, setF] = useState({ current: '', next: '' });
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const save = async () => {
    setError('');
    try { await api.post('/api/auth/password', f); setOk(true); } catch (e) { setError(e.message); }
  };
  return (
    <Modal title="Cambiar mi contraseña" onClose={onClose}>
      <Alert>{error}</Alert>
      <Alert kind="ok">{ok ? 'Contraseña actualizada.' : ''}</Alert>
      {!ok && (
        <>
          <Field label="Contraseña actual"><input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
          <Field label="Nueva contraseña" hint="Mínimo 8 caracteres"><input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        </>
      )}
      <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>{ok ? 'Cerrar' : 'Cancelar'}</button>
        {!ok && <button className="btn primary" onClick={save}>Guardar</button>}
      </div>
    </Modal>
  );
}

const ICONS = {
  pipeline: 'M4 4h4v16H4z M10 4h4v10h-4z M16 4h4v13h-4z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  quoter: 'M6 3h12v18H6z M9 7h6 M9 12h.01 M12 12h.01 M15 12h.01 M9 16h.01 M12 16h.01 M15 16h.01',
  quotes: 'M7 3h8l4 4v14H7z M15 3v4h4 M10 12h6 M10 16h6',
  mail: 'M3 6h18v12H3z M3 7l9 6 9-6',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
  chart: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
  sliders: 'M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M20 18h0 M14 4v4 M10 10v4 M18 16v4',
};
const Icon = ({ name }) => (
  <svg className="ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>
);

function Shell() {
  const { user, logout, isAdmin } = useAuth();
  const [account, setAccount] = useState(false);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false); // menú lateral en móvil
  const { pathname } = useLocation();
  useEffect(() => {
    const load = () => api.get('/api/conversations/unread').then((r) => setUnread(r.unread)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    document.body.classList.toggle('menu-open', open);
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('menu-open'); };
  }, [open]);
  const Item = ({ to, icon, end, children }) => <NavLink to={to} end={end}><Icon name={icon} /><span>{children}</span></NavLink>;
  return (
    <div className="app">
      <div className="mobilebar">
        <button className="burger" onClick={() => setOpen(true)} aria-label="Abrir menú" aria-expanded={open}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          {unread > 0 && <span className="nav-badge dot">{unread}</span>}
        </button>
        <div className="brand">Quot <span>CRM</span></div>
      </div>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Menú principal">
        <div className="sidebar-head">
          <div className="brand">Quot <span>CRM</span></div>
          <button className="sidebar-close" onClick={() => setOpen(false)} aria-label="Cerrar menú">×</button>
        </div>
        <nav>
          <Item to="/" end icon="pipeline">Pipeline</Item>
          <NavLink to="/conversaciones"><Icon name="chat" /><span>Conversaciones</span>{unread > 0 && <span className="nav-badge">{unread}</span>}</NavLink>
          <Item to="/cotizador" icon="quoter">Cotizador</Item>
          <Item to="/cotizaciones" icon="quotes">Cotizaciones</Item>
          <Item to="/seguimiento" icon="mail">Seguimiento</Item>
          <Item to="/productos" icon="box">Productos</Item>
          {isAdmin && <div className="nav-section">Administración</div>}
          {isAdmin && <Item to="/conversion" icon="chart">Conversión</Item>}
          {isAdmin && <Item to="/importar" icon="upload">Importar</Item>}
          {isAdmin && <Item to="/admin" icon="sliders">Admin</Item>}
        </nav>
        <div className="who">
          <button className="link" onClick={() => setAccount(true)} title="Mi cuenta">{user.name}{isAdmin ? ' · admin' : ''}</button>
          <button className="btn small" onClick={logout}>Salir</button>
        </div>
      </aside>
      <div className="content">
        <main>
          <Routes>
            <Route path="/" element={<Pipeline />} />
            <Route path="/conversaciones" element={<Conversations />} />
            <Route path="/cotizador" element={<Quoter />} />
            <Route path="/cotizaciones" element={<Quotes />} />
            <Route path="/seguimiento" element={<Followups />} />
            <Route path="/productos" element={<Products />} />
            <Route path="/conversion" element={isAdmin ? <Conversion /> : <Navigate to="/" />} />
            <Route path="/importar" element={isAdmin ? <Import /> : <Navigate to="/" />} />
            <Route path="/admin" element={isAdmin ? <Admin /> : <Navigate to="/" />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
      {account && <Account onClose={() => setAccount(false)} />}
    </div>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="login-wrap"><p className="muted">Cargando…</p></div>;
  return user ? <Shell /> : <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </AuthProvider>
  );
}
