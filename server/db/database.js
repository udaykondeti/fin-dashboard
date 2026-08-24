const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'finance.db');

// Ensure the db directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      exchange TEXT DEFAULT 'NSE',
      company_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      avg_buy_price REAL NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mutual_funds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      fund_name TEXT NOT NULL,
      folio_number TEXT,
      units REAL NOT NULL,
      avg_nav REAL NOT NULL,
      fund_type TEXT DEFAULT 'Equity',
      sip_amount REAL DEFAULT 0,
      sip_date INTEGER,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS fixed_deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      bank_name TEXT NOT NULL,
      principal REAL NOT NULL,
      interest_rate REAL NOT NULL,
      start_date TEXT NOT NULL,
      maturity_date TEXT NOT NULL,
      fd_type TEXT DEFAULT 'Cumulative',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS us_stocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      company_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      avg_buy_price_usd REAL NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS credit_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      card_name TEXT NOT NULL,
      bank TEXT NOT NULL,
      card_limit REAL NOT NULL,
      outstanding_balance REAL DEFAULT 0,
      due_date TEXT,
      min_payment REAL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      loan_type TEXT NOT NULL,
      lender TEXT NOT NULL,
      principal_amount REAL NOT NULL,
      outstanding_amount REAL NOT NULL,
      interest_rate REAL NOT NULL,
      emi_amount REAL NOT NULL,
      emi_date INTEGER,
      start_date TEXT,
      end_date TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hand_loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      person_name TEXT NOT NULL,
      phone TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('given', 'taken')),
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      due_date TEXT,
      interest_rate REAL DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'settled', 'partial')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS vault_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      s3_key TEXT NOT NULL UNIQUE,
      original_filename TEXT NOT NULL,
      display_name TEXT,
      file_size INTEGER,
      mime_type TEXT,
      financial_year TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      linked_type TEXT,
      linked_id INTEGER,
      description TEXT,
      tags TEXT,
      upload_date TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ca_access_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      financial_year TEXT,
      categories TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#fbbf24',
      icon TEXT DEFAULT '👤',
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS savings_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      profile_id INTEGER,
      bank_name TEXT NOT NULL,
      account_type TEXT DEFAULT 'Savings',
      account_number TEXT,
      balance REAL NOT NULL DEFAULT 0,
      interest_rate REAL DEFAULT 3.5,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS insurance_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      profile_id INTEGER,
      policy_name TEXT NOT NULL,
      insurer TEXT NOT NULL,
      policy_type TEXT DEFAULT 'Term',
      premium_amount REAL NOT NULL,
      premium_frequency TEXT DEFAULT 'Annual',
      cover_amount REAL DEFAULT 0,
      start_date TEXT,
      maturity_date TEXT,
      next_due_date TEXT,
      nominee TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nps_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      profile_id INTEGER,
      pran TEXT,
      tier TEXT DEFAULT 'Tier I',
      total_invested REAL DEFAULT 0,
      current_value REAL DEFAULT 0,
      equity_pct REAL DEFAULT 75,
      bonds_pct REAL DEFAULT 15,
      govt_pct REAL DEFAULT 10,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scheduled_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      profile_id INTEGER,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      frequency TEXT DEFAULT 'Monthly',
      category TEXT DEFAULT 'Other',
      next_due_date TEXT,
      auto_debit INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS advance_tax_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      profile_id INTEGER,
      assessment_year TEXT NOT NULL,
      installment TEXT NOT NULL,
      amount REAL NOT NULL,
      date_paid TEXT NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS earnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      profile_id INTEGER,
      source_name TEXT NOT NULL,
      source_type TEXT DEFAULT 'Other',
      amount REAL NOT NULL,
      frequency TEXT DEFAULT 'Monthly',
      share_percentage REAL DEFAULT 100,
      is_auto INTEGER DEFAULT 0,
      linked_type TEXT,
      linked_id INTEGER,
      financial_year TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS earning_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      earning_id INTEGER NOT NULL,
      profile_id INTEGER NOT NULL,
      share_percentage REAL NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (earning_id) REFERENCES earnings(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
      UNIQUE(earning_id, profile_id)
    );

    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      profile_id INTEGER,
      name TEXT NOT NULL,
      property_type TEXT DEFAULT 'Flat' CHECK(property_type IN ('Flat','Plot','Land','Commercial','Villa','Other')),
      address TEXT,
      city TEXT,
      state TEXT,
      area REAL,
      area_unit TEXT DEFAULT 'sqft',
      purchase_price REAL,
      purchase_date TEXT,
      current_value REAL,
      ownership_percentage REAL DEFAULT 100,
      co_owner_name TEXT,
      registration_number TEXT,
      loan_outstanding REAL DEFAULT 0,
      loan_interest_rate REAL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rental_agreements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_name TEXT NOT NULL,
      tenant_phone TEXT,
      tenant_email TEXT,
      rent_amount REAL NOT NULL,
      security_deposit REAL DEFAULT 0,
      start_date TEXT NOT NULL,
      end_date TEXT,
      lock_in_months INTEGER DEFAULT 0,
      payment_day INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','expired','terminated')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS property_tax_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      assessment_year TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_date TEXT NOT NULL,
      receipt_number TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS property_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      expense_type TEXT DEFAULT 'Maintenance' CHECK(expense_type IN ('Maintenance','Repair','Legal','Society','Other')),
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      receipt_number TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      task_type TEXT NOT NULL,
      model TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      input_preview TEXT,
      output_preview TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      latency_ms INTEGER DEFAULT 0,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_calls_user_time ON agent_calls(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_calls_task_time ON agent_calls(task_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT 'New chat',
      agent_kind TEXT NOT NULL DEFAULT 'financial_advisor',
      model TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_threads_user ON agent_threads(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
      content TEXT,
      tool_uses TEXT,
      status TEXT NOT NULL DEFAULT 'final' CHECK(status IN ('streaming','final')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(thread_id, id);
  `);

  // Add thread_id link column for chat-driven calls. Idempotent: a second
  // run throws "duplicate column name", which we swallow.
  try { db.exec('ALTER TABLE agent_calls ADD COLUMN thread_id INTEGER'); }
  catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  console.log('Database tables initialized.');
  seedData();
}

function seedData() {
  // Only seed in non-production environments. In production, the first
  // admin must be created via a deliberate setup step (env-driven), never
  // from a hardcoded credential.
  if (process.env.NODE_ENV === 'production') {
    return;
  }

  const seedEmail = process.env.SEED_ADMIN_EMAIL || 'admin@local';
  const seedPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe!Local1';
  const seedName = process.env.SEED_ADMIN_NAME || 'Admin';

  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(seedEmail);
  if (existingUser) {
    return;
  }

  const passwordHash = bcrypt.hashSync(seedPassword, 12);
  const userResult = db.prepare(
    'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)'
  ).run(seedEmail, passwordHash, seedName);
  const userId = userResult.lastInsertRowid;

  db.prepare(
    'INSERT INTO profiles (user_id, name, color, icon, is_default) VALUES (?,?,?,?,?)'
  ).run(userId, seedName, '#fbbf24', '👤', 1);

  console.log(`Initialized dev admin user: ${seedEmail} (set SEED_ADMIN_* env vars to override)`);
}

// Versioned migrations. Each migration has a stable numeric `id` and a `run`
// function. We track applied IDs in `schema_migrations` so each one runs at
// most once, in order. Add new migrations by appending to the array; never
// renumber or edit a migration that has already shipped.
function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const addColumnIfMissing = (table, column, sql) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      db.prepare(sql).run();
    }
  };

  const migrations = [
    { id: 1,  name: 'vault_files.profile_id',         run: () => addColumnIfMissing('vault_files', 'profile_id', 'ALTER TABLE vault_files ADD COLUMN profile_id INTEGER') },
    { id: 2,  name: 'ca_access_tokens.profile_id',    run: () => addColumnIfMissing('ca_access_tokens', 'profile_id', 'ALTER TABLE ca_access_tokens ADD COLUMN profile_id INTEGER') },
    { id: 3,  name: 'stocks.current_price',           run: () => addColumnIfMissing('stocks', 'current_price', 'ALTER TABLE stocks ADD COLUMN current_price REAL') },
    { id: 4,  name: 'mutual_funds.current_nav',       run: () => addColumnIfMissing('mutual_funds', 'current_nav', 'ALTER TABLE mutual_funds ADD COLUMN current_nav REAL') },
    { id: 5,  name: 'us_stocks.current_price_usd',    run: () => addColumnIfMissing('us_stocks', 'current_price_usd', 'ALTER TABLE us_stocks ADD COLUMN current_price_usd REAL') },
    { id: 6,  name: 'credit_cards.last4',             run: () => addColumnIfMissing('credit_cards', 'last4', "ALTER TABLE credit_cards ADD COLUMN last4 TEXT DEFAULT '0000'") },
    { id: 7,  name: 'profiles.legal_name',            run: () => addColumnIfMissing('profiles', 'legal_name', 'ALTER TABLE profiles ADD COLUMN legal_name TEXT') },
    { id: 8,  name: 'profiles.name_on_aadhaar',       run: () => addColumnIfMissing('profiles', 'name_on_aadhaar', 'ALTER TABLE profiles ADD COLUMN name_on_aadhaar TEXT') },
    { id: 9,  name: 'profiles.name_on_pan',           run: () => addColumnIfMissing('profiles', 'name_on_pan', 'ALTER TABLE profiles ADD COLUMN name_on_pan TEXT') },
    { id: 10, name: 'profiles.pan_number',            run: () => addColumnIfMissing('profiles', 'pan_number', 'ALTER TABLE profiles ADD COLUMN pan_number TEXT') },
    // Only last 4 digits of Aadhaar are stored — UIDAI guidelines forbid storing the full 12-digit number.
    { id: 11, name: 'profiles.aadhaar_last4',         run: () => addColumnIfMissing('profiles', 'aadhaar_last4', 'ALTER TABLE profiles ADD COLUMN aadhaar_last4 TEXT') },
    { id: 12, name: 'profiles.other_ids',             run: () => addColumnIfMissing('profiles', 'other_ids', 'ALTER TABLE profiles ADD COLUMN other_ids TEXT') },
    // CA token usage limits — null = unlimited (legacy rows); new tokens default to a finite cap.
    { id: 13, name: 'ca_access_tokens.max_uses',      run: () => addColumnIfMissing('ca_access_tokens', 'max_uses', 'ALTER TABLE ca_access_tokens ADD COLUMN max_uses INTEGER') },
    { id: 14, name: 'ca_access_tokens.revoked_at',    run: () => addColumnIfMissing('ca_access_tokens', 'revoked_at', 'ALTER TABLE ca_access_tokens ADD COLUMN revoked_at TEXT') },
    { id: 15, name: 'users.is_admin',                 run: () => addColumnIfMissing('users', 'is_admin', 'ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0') },
    { id: 16, name: 'bootstrap_admin_from_env', run: () => {
      const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase().trim();
      if (!email) return;
      db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(email);
    } },
    { id: 17, name: 'create_networth_snapshots', run: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS networth_snapshots (
          user_id INTEGER NOT NULL,
          snapshot_date TEXT NOT NULL,
          total_assets REAL NOT NULL,
          total_liabilities REAL NOT NULL,
          net_worth REAL NOT NULL,
          PRIMARY KEY (user_id, snapshot_date),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_networth_snapshots_user_date
          ON networth_snapshots(user_id, snapshot_date DESC);
      `);
    } },
    { id: 18, name: 'create_activity_log_and_watcher_state', run: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS activity_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          source TEXT NOT NULL,
          summary TEXT NOT NULL,
          details TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_activity_log_user_time
          ON activity_log(user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS watcher_state (
          name TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          last_processed_at DATETIME NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (name, user_id)
        );
      `);
    } },
    { id: 19, name: 'vault_files.processed_at',     run: () => addColumnIfMissing('vault_files', 'processed_at',     'ALTER TABLE vault_files ADD COLUMN processed_at DATETIME') },
    { id: 20, name: 'vault_files.processing_error', run: () => addColumnIfMissing('vault_files', 'processing_error', 'ALTER TABLE vault_files ADD COLUMN processing_error TEXT') },
    { id: 23, name: 'stocks.yahoo_symbol',           run: () => addColumnIfMissing('stocks', 'yahoo_symbol', 'ALTER TABLE stocks ADD COLUMN yahoo_symbol TEXT') },
    { id: 24, name: 'earnings.tds_rate',             run: () => addColumnIfMissing('earnings', 'tds_rate', 'ALTER TABLE earnings ADD COLUMN tds_rate REAL') },
    { id: 25, name: 'earnings.actual_received',      run: () => addColumnIfMissing('earnings', 'actual_received', 'ALTER TABLE earnings ADD COLUMN actual_received REAL') },
    { id: 26, name: 'us_stocks.yahoo_symbol',        run: () => addColumnIfMissing('us_stocks', 'yahoo_symbol', 'ALTER TABLE us_stocks ADD COLUMN yahoo_symbol TEXT') },
    { id: 27, name: 'mutual_funds.scheme_code',      run: () => addColumnIfMissing('mutual_funds', 'scheme_code', 'ALTER TABLE mutual_funds ADD COLUMN scheme_code TEXT') },
    { id: 28, name: 'mutual_funds.yahoo_symbol',     run: () => addColumnIfMissing('mutual_funds', 'yahoo_symbol', 'ALTER TABLE mutual_funds ADD COLUMN yahoo_symbol TEXT') },
    { id: 29, name: 'create_transactions',           run: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          profile_id INTEGER,
          date DATE NOT NULL,
          description TEXT NOT NULL,
          amount REAL NOT NULL,
          direction TEXT NOT NULL DEFAULT 'debit',
          category TEXT,
          source TEXT NOT NULL DEFAULT 'manual',
          source_ref TEXT,
          linked_table TEXT,
          linked_id INTEGER,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(user_id, source, source_ref)
        );
        CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date DESC);
      `);
    } },
    { id: 22, name: 'rename_financial_advisor_to_assistant', run: () => {
      db.exec(`UPDATE agent_threads SET agent_kind = 'assistant' WHERE agent_kind = 'financial_advisor'`);
    } },
    { id: 21, name: 'create_agent_artifacts', run: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id INTEGER NOT NULL,
          message_id INTEGER,
          identifier TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'markdown',
          language TEXT,
          title TEXT NOT NULL DEFAULT 'Artifact',
          content TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'streaming' CHECK(status IN ('streaming','final')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_artifacts_thread ON agent_artifacts(thread_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_artifacts_thread_ident ON agent_artifacts(thread_id, identifier);
      `);
    } },
    { id: 30, name: 'create_gmail_tokens', run: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gmail_tokens (
          user_id      INTEGER PRIMARY KEY,
          access_token  TEXT NOT NULL,
          refresh_token TEXT,
          expiry_date   INTEGER,
          scope         TEXT,
          updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);
    } },
    { id: 31, name: 'scheduled_payments.source',     run: () => addColumnIfMissing('scheduled_payments', 'source',     "ALTER TABLE scheduled_payments ADD COLUMN source TEXT DEFAULT 'manual'") },
    { id: 32, name: 'scheduled_payments.updated_at', run: () => addColumnIfMissing('scheduled_payments', 'updated_at', 'ALTER TABLE scheduled_payments ADD COLUMN updated_at DATETIME') },
    { id: 33, name: 'vault_files.file_hash', run: () => {
      addColumnIfMissing('vault_files', 'file_hash', 'ALTER TABLE vault_files ADD COLUMN file_hash TEXT');
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_vault_files_file_hash ON vault_files(user_id, file_hash)'); } catch (_) {}
    } },
    { id: 34, name: 'create_vault_dedup_keys', run: () => {
      // Stores content fingerprints per user to prevent reprocessing the same
      // financial document even when uploaded in a different format (e.g. a PDF
      // statement and a screenshot of the same statement). dedup_key format:
      //   "text:<sha256_of_extracted_text>"  — content-level dedup
      db.exec(`
        CREATE TABLE IF NOT EXISTS vault_dedup_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          dedup_key TEXT NOT NULL,
          vault_file_id INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, dedup_key),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (vault_file_id) REFERENCES vault_files(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_vault_dedup_keys_user ON vault_dedup_keys(user_id, dedup_key);
      `);
    } },
    { id: 35, name: 'vault_files.agent_thread_id', run: () => addColumnIfMissing('vault_files', 'agent_thread_id', 'ALTER TABLE vault_files ADD COLUMN agent_thread_id INTEGER') },
    { id: 36, name: 'create_filevault_events', run: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS filevault_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id        TEXT NOT NULL UNIQUE,
          source_file     TEXT,
          payload_json    TEXT,
          received_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
          processed_at    DATETIME,
          items_total     INTEGER DEFAULT 0,
          items_applied   INTEGER DEFAULT 0,
          items_duplicate INTEGER DEFAULT 0,
          items_error     INTEGER DEFAULT 0,
          error_message   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_filevault_events_received ON filevault_events(received_at);
      `);
    } },
    { id: 37, name: 'profiles.email', run: () => addColumnIfMissing('profiles', 'email', 'ALTER TABLE profiles ADD COLUMN email TEXT') },
    // ── Profiles-are-logins: tax identity on the user + completion flag ──────
    { id: 38, name: 'users.profile_fields', run: () => {
      addColumnIfMissing('users', 'full_name',        'ALTER TABLE users ADD COLUMN full_name TEXT');
      addColumnIfMissing('users', 'pan_number',       'ALTER TABLE users ADD COLUMN pan_number TEXT');
      addColumnIfMissing('users', 'aadhaar_last4',    'ALTER TABLE users ADD COLUMN aadhaar_last4 TEXT');
      addColumnIfMissing('users', 'name_on_pan',      'ALTER TABLE users ADD COLUMN name_on_pan TEXT');
      addColumnIfMissing('users', 'name_on_aadhaar',  'ALTER TABLE users ADD COLUMN name_on_aadhaar TEXT');
      addColumnIfMissing('users', 'phone',            'ALTER TABLE users ADD COLUMN phone TEXT');
      addColumnIfMissing('users', 'dob',              'ALTER TABLE users ADD COLUMN dob TEXT');
      addColumnIfMissing('users', 'profile_completed','ALTER TABLE users ADD COLUMN profile_completed INTEGER DEFAULT 0');
    } },
    // ── Consent-based links between two real logins (household) ──────────────
    { id: 39, name: 'create_user_links', run: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          requester_id INTEGER NOT NULL,
          target_id    INTEGER NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
          relationship TEXT,                              -- spouse | parent | child | sibling | joint | other
          created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
          responded_at DATETIME,
          UNIQUE(requester_id, target_id),
          FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (target_id)    REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_user_links_target ON user_links(target_id, status);
        CREATE INDEX IF NOT EXISTS idx_user_links_requester ON user_links(requester_id, status);
      `);
    } },
    { id: 40, name: 'create_property_shortlist', run: () => {
      // Property SEARCH shortlist — distinct from the `properties` table which
      // is for user-owned real estate. This one is for candidates the user is
      // evaluating (e.g. a 3 BHK flat search). Enriched with locality research
      // (amenities, healthcare, banks, transit, groceries) so a user can
      // compare properties on more than just price/size.
      db.exec(`
        CREATE TABLE IF NOT EXISTS property_shortlist (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          -- Identity
          project_name  TEXT NOT NULL,
          locality      TEXT,
          city          TEXT DEFAULT 'Hyderabad',
          builder       TEXT,
          address       TEXT,
          maps_url      TEXT,        -- Google Maps deep link
          project_url   TEXT,        -- builder / listing page
          -- Unit specifics for THIS candidate
          size_sqft     REAL,
          facing        TEXT,        -- North / East / North-East / …
          floor         TEXT,        -- '4th', 'Unspecified', etc.
          bhk           INTEGER,     -- 2 / 3 / 4
          ask_price     REAL,        -- INR, nullable ('Ask' listings)
          -- Project-wide context
          project_status  TEXT,      -- 'Ready', 'Phase 1 handed over', etc.
          total_units     INTEGER,
          total_towers    INTEGER,
          floors_per_tower INTEGER,
          size_range      TEXT,      -- '1957-2235 sqft'
          -- Cost
          maintenance_per_sqft REAL, -- ₹/sqft/month
          maintenance_notes    TEXT,
          -- Enrichment (JSON arrays of objects; NULL until researched)
          amenities   TEXT,          -- JSON: ["clubhouse","gym","pool",...]
          healthcare  TEXT,          -- JSON: [{name,distance_km,type}]
          banks       TEXT,          -- JSON: [{name,distance_km}]
          schools     TEXT,          -- JSON: [{name,distance_km,type}]
          transit     TEXT,          -- JSON: {metro,bus,cab_availability,notes}
          groceries   TEXT,          -- JSON: [{name,distance_km,type}]
          worship     TEXT,          -- JSON: [{name,distance_km,type}]
          -- Senior fit (user is optimising for a couple aged 64 & 75)
          senior_fit_score INTEGER,        -- 0-100
          senior_notes     TEXT,           -- narrative summary
          red_flags        TEXT,           -- JSON array of strings
          elevator_count   INTEGER,
          power_backup     TEXT,
          -- Workflow
          status TEXT DEFAULT 'shortlist' CHECK(status IN ('shortlist','visiting','offered','rejected','purchased')),
          rating INTEGER,                  -- user's 0-5 star rating
          notes  TEXT,                     -- user's free-text notes
          researched_at DATETIME,          -- when enrichment was last refreshed
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_property_shortlist_user ON property_shortlist(user_id, status);
      `);
    } },

    // size_sqft on property_shortlist is SUPER BUILT-UP AREA (SBA) — that is how
    // Hyderabad builders quote. Carpet area is what is actually livable, and the
    // gap is large: typical loading is 30-38%, so a 2,150 sqft SBA flat is only
    // ~1,400 sqft carpet. Store carpet when it is known from RERA/the builder,
    // and the loading factor when that is known instead. The UI derives an
    // estimate from a default loading when neither is present, and labels it.
    { id: 41, name: 'property_shortlist_carpet_area', run: () => {
      const cols = db.prepare('PRAGMA table_info(property_shortlist)').all().map(c => c.name);
      if (!cols.includes('carpet_sqft')) {
        db.exec('ALTER TABLE property_shortlist ADD COLUMN carpet_sqft REAL');
      }
      if (!cols.includes('loading_factor_pct')) {
        db.exec('ALTER TABLE property_shortlist ADD COLUMN loading_factor_pct REAL');
      }
    } },
  ];

  const appliedIds = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id)
  );
  const recordStmt = db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)');

  for (const m of migrations.sort((a, b) => a.id - b.id)) {
    if (appliedIds.has(m.id)) continue;
    try {
      m.run();
      recordStmt.run(m.id, m.name);
      console.log(`Migration ${m.id} applied: ${m.name}`);
    } catch (err) {
      console.warn(`Migration ${m.id} (${m.name}) failed:`, err.message);
    }
  }
}

// Initialize on module load
initializeDatabase();
runMigrations();

module.exports = db;
