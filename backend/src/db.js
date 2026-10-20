import pg from 'pg';

// Montos (CLP) e ids son INTEGER (int4) para que pg y PGlite devuelvan números JS.
// Fechas: se consultan con ::text para evitar problemas de zona horaria.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pipeline_states (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#64748b',
  is_initial BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  import_key TEXT UNIQUE,
  client_name TEXT NOT NULL DEFAULT '',
  rut TEXT NOT NULL DEFAULT '',
  razon_social TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  whatsapp TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  state_id INTEGER REFERENCES pipeline_states(id),
  state_date DATE,
  lead_date DATE,
  quote_number INTEGER,
  client_quote_number TEXT NOT NULL DEFAULT '',
  invoice_number TEXT NOT NULL DEFAULT '',
  products_text TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL DEFAULT 0,
  iva INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  requires_supplier_quote BOOLEAN NOT NULL DEFAULT FALSE,
  comments TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_state_idx ON leads(state_id);
CREATE INDEX IF NOT EXISTS leads_rut_idx ON leads(rut);

CREATE TABLE IF NOT EXISTS quotes (
  id SERIAL PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  quote_date DATE NOT NULL DEFAULT CURRENT_DATE,
  validity_days INTEGER NOT NULL DEFAULT 15,
  rut TEXT NOT NULL DEFAULT '',
  razon_social TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  iva_rate INTEGER NOT NULL DEFAULT 19,
  subtotal INTEGER NOT NULL DEFAULT 0,
  iva INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quote_items (
  id SERIAL PRIMARY KEY,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  sku TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL DEFAULT 0
);
`;

const DEFAULT_SETTINGS = {
  company_name: 'QUOT Marketplace Logístico SpA',
  company_rut: '',
  company_address: '',
  company_email: '',
  company_phone: '',
  company_web: 'www.quot.cl',
  iva_rate: '19',
  quote_next_number: '1',
  quote_validity_days: '15',
  quote_terms:
    'Valores netos en pesos chilenos (CLP), más IVA.\nForma de pago: según acuerdo comercial.\nDisponibilidad y plazos de entrega sujetos a stock al momento de la orden de compra.',
};

const DEFAULT_STATES = [
  ['Cotizado', '#2563eb', true],
  ['Seguimiento 1', '#ca8a04', false],
  ['Seguimiento 2', '#ea580c', false],
  ['Aceptado', '#16a34a', false],
  ['OC Enviada', '#92400e', false],
  ['Facturado', '#475569', false],
  ['Pagado', '#7c3aed', false],
  ['Archivado', '#9ca3af', false],
];

let impl;

export async function initDb() {
  if (process.env.DATABASE_URL) {
    pg.types.setTypeParser(20, (v) => parseInt(v, 10));
    pg.types.setTypeParser(1700, (v) => parseFloat(v));
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
    });
    impl = {
      query: (t, p) => pool.query(t, p),
      exec: (sql) => pool.query(sql),
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn({ query: (t, p) => c.query(t, p) });
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      },
    };
  } else {
    // Desarrollo local / tests: Postgres embebido (PGlite). En producción usar DATABASE_URL.
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite(process.env.PGLITE_DIR || './data/pglite');
    impl = {
      query: (t, p) => db.query(t, p),
      exec: (sql) => db.exec(sql),
      tx: (fn) => db.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) })),
    };
  }

  await impl.exec(SCHEMA);

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await impl.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
  const { rows } = await impl.query('SELECT COUNT(*)::int AS n FROM pipeline_states');
  if (rows[0].n === 0) {
    for (let i = 0; i < DEFAULT_STATES.length; i++) {
      const [name, color, initial] = DEFAULT_STATES[i];
      await impl.query(
        'INSERT INTO pipeline_states(name, position, color, is_initial) VALUES($1,$2,$3,$4)',
        [name, i, color, initial]
      );
    }
  }
}

export const query = (t, p) => impl.query(t, p);
export const tx = (fn) => impl.tx(fn);

export async function getSettings(q = query) {
  const { rows } = await q('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
