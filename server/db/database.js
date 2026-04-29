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
  `);

  console.log('Database tables initialized.');
  seedData();
}

function seedData() {
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get('kondetiudaykiran@gmail.com');
  if (existingUser) {
    return;
  }

  const passwordHash = bcrypt.hashSync('Admin@123', 12);
  const userResult = db.prepare(
    'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)'
  ).run('kondetiudaykiran@gmail.com', passwordHash, 'Kiran');
  const userId = userResult.lastInsertRowid;

  db.prepare(
    'INSERT INTO profiles (user_id, name, color, icon, is_default) VALUES (?,?,?,?,?)'
  ).run(userId, 'Kiran', '#fbbf24', '👤', 1);

  console.log('Initialized admin user: kondetiudaykiran@gmail.com / Admin@123');
}

// Run migrations for columns added after initial schema
function runMigrations() {
  const migrations = [
    // Add profile_id to vault_files if missing
    { table: 'vault_files', column: 'profile_id', sql: 'ALTER TABLE vault_files ADD COLUMN profile_id INTEGER' },
    // Add profile_id to ca_access_tokens if missing
    { table: 'ca_access_tokens', column: 'profile_id', sql: 'ALTER TABLE ca_access_tokens ADD COLUMN profile_id INTEGER' },
    // Add current_price to stocks if missing
    { table: 'stocks', column: 'current_price', sql: 'ALTER TABLE stocks ADD COLUMN current_price REAL' },
    // Add current_nav to mutual_funds if missing
    { table: 'mutual_funds', column: 'current_nav', sql: 'ALTER TABLE mutual_funds ADD COLUMN current_nav REAL' },
    // Add current_price_usd to us_stocks if missing
    { table: 'us_stocks', column: 'current_price_usd', sql: 'ALTER TABLE us_stocks ADD COLUMN current_price_usd REAL' },
    // Add last4 to credit_cards if missing
    { table: 'credit_cards', column: 'last4', sql: "ALTER TABLE credit_cards ADD COLUMN last4 TEXT DEFAULT '0000'" },
  ];

  for (const m of migrations) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${m.table})`).all();
      const exists = cols.some(c => c.name === m.column);
      if (!exists) {
        db.prepare(m.sql).run();
        console.log(`Migration: added ${m.table}.${m.column}`);
      }
    } catch (err) {
      console.warn(`Migration skipped (${m.table}.${m.column}):`, err.message);
    }
  }
}

// Initialize on module load
initializeDatabase();
runMigrations();

module.exports = db;
