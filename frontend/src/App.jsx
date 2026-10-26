import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { api } from './api.js';
import { Alert, Field, Modal } from './ui.jsx';
import Pipeline from './pages/Pipeline.jsx';
import Products from './pages/Products.jsx';
import Quoter from './pages/Quoter.jsx';
import Quotes from './pages/Quotes.jsx';
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

function Shell() {
  const { user, logout, isAdmin } = useAuth();
  const [account, setAccount] = useState(false);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const load = () => api.get('/api/conversations/unread').then((r) => setUnread(r.unread)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Quot <span>CRM</span></div>
        <nav>
          <NavLink to="/" end>Pipeline</NavLink>
          <NavLink to="/conversaciones">Conversaciones{unread > 0 && <span className="nav-badge">{unread}</span>}</NavLink>
          <NavLink to="/cotizador">Cotizador</NavLink>
          <NavLink to="/cotizaciones">Cotizaciones</NavLink>
          <NavLink to="/productos">Productos</NavLink>
          {isAdmin && <NavLink to="/importar">Importar</NavLink>}
          {isAdmin && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="who">
          <button className="link" onClick={() => setAccount(true)}>{user.name}{isAdmin ? ' · admin' : ''}</button>
          <button className="btn small" onClick={logout}>Salir</button>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Pipeline />} />
          <Route path="/conversaciones" element={<Conversations />} />
          <Route path="/cotizador" element={<Quoter />} />
          <Route path="/cotizaciones" element={<Quotes />} />
          <Route path="/productos" element={<Products />} />
          <Route path="/importar" element={isAdmin ? <Import /> : <Navigate to="/" />} />
          <Route path="/admin" element={isAdmin ? <Admin /> : <Navigate to="/" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
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
