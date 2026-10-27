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
  chatbot_enabled: '1',
  spam_detection: '1',
  bank_holder: 'Quot Marketplace Logístico SPA',
  bank_rut: '77372977-8',
  bank_name: 'Mercado Pago',
  bank_account_type: 'Cuenta Vista',
  bank_account_number: '1035865570',
  bank_email: 'contacto@quot.cl',
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

  // Migración: la maestra guarda COSTO (columna `price`); el precio de venta se calcula en cada cotización
  // con el margen que indica el vendedor: precio = costo / (1 - margen). El costo y el margen son internos.
  await impl.exec(`
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS margin_pct DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS cost INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS margin_pct DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
  `);

  // Orden manual dentro de cada etapa (sort_order ascendente; los leads nuevos entran con 0 = arriba).
  // Una sola vez: numera los leads existentes con el orden que ya tenían (fecha más reciente primero).
  const flag = await impl.query("SELECT 1 FROM settings WHERE key='leads_order_initialized'");
  if (!flag.rows.length) {
    await impl.exec(`
      UPDATE leads l SET sort_order = r.rn
      FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY state_id ORDER BY COALESCE(state_date, lead_date) DESC NULLS LAST, id DESC)::int AS rn FROM leads) r
      WHERE r.id = l.id;
    `);
    await impl.query("INSERT INTO settings(key,value) VALUES('leads_order_initialized','1') ON CONFLICT (key) DO NOTHING");
  }

  await impl.exec(`
    CREATE TABLE IF NOT EXISTS catalog_products (
      id SERIAL PRIMARY KEY,
      wc_id INTEGER UNIQUE,
      sku TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      short_description TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      price INTEGER NOT NULL DEFAULT 0,
      regular_price INTEGER NOT NULL DEFAULT 0,
      stock_status TEXT NOT NULL DEFAULT 'instock',
      stock_quantity INTEGER,
      permalink TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      categories TEXT NOT NULL DEFAULT '',
      attributes TEXT NOT NULL DEFAULT '',
      product_type TEXT NOT NULL DEFAULT 'simple',
      search_text TEXT NOT NULL DEFAULT '',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS catalog_sku_idx ON catalog_products(sku);

    CREATE TABLE IF NOT EXISTS integration_values (
      key TEXT PRIMARY KEY,
      value_enc TEXT NOT NULL,
      is_secret BOOLEAN NOT NULL DEFAULT TRUE,
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'bot' CHECK (status IN ('bot','handoff')),
      fail_count INTEGER NOT NULL DEFAULT 0,
      user_messages INTEGER NOT NULL DEFAULT 0,
      customer_name TEXT NOT NULL DEFAULT '',
      customer_email TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      customer_rut TEXT NOT NULL DEFAULT '',
      conversation_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','agent','system')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chat_messages_session_idx ON chat_messages(session_id, id);
    CREATE TABLE IF NOT EXISTS chat_tool_calls (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      ok BOOLEAN NOT NULL DEFAULT TRUE,
      ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      chatwoot_id INTEGER UNIQUE,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','open','resolved','snoozed')),
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      channel TEXT NOT NULL DEFAULT 'Chatbot',
      contact_name TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      contact_rut TEXT NOT NULL DEFAULT '',
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      labels TEXT NOT NULL DEFAULT '',
      handoff_reason TEXT NOT NULL DEFAULT '',
      unread_count INTEGER NOT NULL DEFAULT 0,
      last_message_at TIMESTAMPTZ,
      last_message_preview TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS conversations_assignee_idx ON conversations(assignee_id);
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      chatwoot_message_id INTEGER UNIQUE,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      sender_type TEXT NOT NULL CHECK (sender_type IN ('contact','bot','agent','system')),
      sender_name TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      is_private BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS conv_messages_conv_idx ON conversation_messages(conversation_id, id);

    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS customer_company TEXT NOT NULL DEFAULT '';
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS contact_company TEXT NOT NULL DEFAULT '';
  `);

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await impl.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
  await (await import('./secrets.js')).loadOverrides();
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
