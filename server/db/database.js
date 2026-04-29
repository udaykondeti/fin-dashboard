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
  // Check if admin user already exists
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get('kondetiudaykiran@gmail.com');
  if (existingUser) {
    console.log('Seed data already present, skipping.');
    return;
  }

  console.log('Seeding database with initial data...');

  // Create admin user
  const passwordHash = bcrypt.hashSync('Admin@123', 12);
  const insertUser = db.prepare(`
    INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)
  `);
  const userResult = insertUser.run('kondetiudaykiran@gmail.com', passwordHash, 'Kiran');
  const userId = userResult.lastInsertRowid;

  // Seed Indian stocks
  const insertStock = db.prepare(`
    INSERT INTO stocks (user_id, symbol, exchange, company_name, quantity, avg_buy_price, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertStock.run(userId, 'TCS', 'NSE', 'Tata Consultancy Services Ltd', 10, 3450.00, 'Core IT holding');
  insertStock.run(userId, 'INFY', 'NSE', 'Infosys Ltd', 25, 1420.00, 'Long term hold');
  insertStock.run(userId, 'RELIANCE', 'NSE', 'Reliance Industries Ltd', 8, 2600.00, 'Conglomerate play');
  insertStock.run(userId, 'HDFCBANK', 'NSE', 'HDFC Bank Ltd', 15, 1580.00, 'Banking sector');
  insertStock.run(userId, 'WIPRO', 'NSE', 'Wipro Ltd', 40, 420.00, 'IT sector diversification');

  // Seed mutual funds
  const insertMF = db.prepare(`
    INSERT INTO mutual_funds (user_id, fund_name, folio_number, units, avg_nav, fund_type, sip_amount, sip_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertMF.run(userId, 'Mirae Asset Large Cap Fund - Direct Growth', 'MIR123456', 285.432, 95.50, 'Equity - Large Cap', 5000, 5, 'Primary large cap fund');
  insertMF.run(userId, 'SBI Small Cap Fund - Direct Growth', 'SBI789012', 142.876, 128.75, 'Equity - Small Cap', 3000, 10, 'High risk, high reward');
  insertMF.run(userId, 'Axis Bluechip Fund - Direct Growth', 'AXS345678', 198.543, 52.30, 'Equity - Large Cap', 2000, 15, 'Blue chip exposure');

  // Seed fixed deposits
  const insertFD = db.prepare(`
    INSERT INTO fixed_deposits (user_id, bank_name, principal, interest_rate, start_date, maturity_date, fd_type, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertFD.run(userId, 'State Bank of India', 200000, 7.0, '2023-04-01', '2025-04-01', 'Cumulative', 'Emergency fund FD');
  insertFD.run(userId, 'HDFC Bank', 100000, 6.5, '2024-01-15', '2025-01-15', 'Cumulative', 'Short term savings');

  // Seed US stocks
  const insertUSStock = db.prepare(`
    INSERT INTO us_stocks (user_id, symbol, company_name, quantity, avg_buy_price_usd, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertUSStock.run(userId, 'GOOGL', 'Alphabet Inc.', 2, 138.50, 'US tech exposure via INDmoney');

  // Seed credit cards
  const insertCC = db.prepare(`
    INSERT INTO credit_cards (user_id, card_name, bank, card_limit, outstanding_balance, due_date, min_payment, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertCC.run(userId, 'HDFC Millennia Credit Card', 'HDFC Bank', 200000, 15000, '2026-05-05', 1500, 'Primary daily use card');

  // Seed loans
  const insertLoan = db.prepare(`
    INSERT INTO loans (user_id, loan_type, lender, principal_amount, outstanding_amount, interest_rate, emi_amount, emi_date, start_date, end_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertLoan.run(userId, 'Home Loan', 'State Bank of India', 6000000, 5000000, 8.5, 52000, 5, '2022-06-01', '2042-06-01', '20yr home loan for flat in Hyderabad');

  // Seed hand loans
  const insertHandLoan = db.prepare(`
    INSERT INTO hand_loans (user_id, person_name, phone, direction, amount, date, due_date, interest_rate, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertHandLoan.run(userId, 'Ravi', '9876543210', 'given', 50000, '2025-12-01', '2026-06-01', 0, 'active', 'Given to friend Ravi for his business');
  insertHandLoan.run(userId, 'Mom', null, 'taken', 20000, '2026-01-15', null, 0, 'active', 'Borrowed from Mom for home appliances');

  // Seed profiles
  const insertProfile = db.prepare(`INSERT INTO profiles (user_id, name, color, icon, is_default) VALUES (?,?,?,?,?)`);
  insertProfile.run(userId, 'Kiran', '#fbbf24', '👤', 1);
  insertProfile.run(userId, 'Joint', '#60a5fa', '🏠', 0);

  // Seed savings accounts
  const insertSav = db.prepare(`INSERT INTO savings_accounts (user_id, bank_name, account_type, balance, interest_rate, notes) VALUES (?,?,?,?,?,?)`);
  insertSav.run(userId, 'HDFC Bank', 'Savings', 85000, 3.5, 'Primary salary account');
  insertSav.run(userId, 'State Bank of India', 'Savings', 45000, 2.7, 'Secondary savings');

  // Seed insurance
  const insertIns = db.prepare(`INSERT INTO insurance_policies (user_id, policy_name, insurer, policy_type, premium_amount, premium_frequency, cover_amount, next_due_date, notes) VALUES (?,?,?,?,?,?,?,?,?)`);
  insertIns.run(userId, 'Term Plan - 1 Cr', 'HDFC Life', 'Term', 15000, 'Annual', 10000000, '2026-09-01', 'Pure term plan');
  insertIns.run(userId, 'Family Floater Health', 'Star Health', 'Health', 18000, 'Annual', 500000, '2026-08-15', '5L family floater cover');

  // Seed NPS
  db.prepare(`INSERT INTO nps_accounts (user_id, pran, tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct, notes) VALUES (?,?,?,?,?,?,?,?,?)`).run(userId, 'PRAN110000000001', 'Tier I', 150000, 175000, 75, 15, 10, 'NPS Tier I');

  // Seed scheduled payments
  const insertPay = db.prepare(`INSERT INTO scheduled_payments (user_id, name, amount, frequency, category, next_due_date, auto_debit, is_active, notes) VALUES (?,?,?,?,?,?,?,?,?)`);
  insertPay.run(userId, 'Home Loan EMI - SBI', 52000, 'Monthly', 'EMI', '2026-05-05', 1, 1, 'Home loan auto-debit');
  insertPay.run(userId, 'Mirae Asset SIP', 5000, 'Monthly', 'SIP', '2026-05-05', 1, 1, 'Monthly SIP');
  insertPay.run(userId, 'SBI Small Cap SIP', 3000, 'Monthly', 'SIP', '2026-05-10', 1, 1, 'Monthly SIP');
  insertPay.run(userId, 'Axis Bluechip SIP', 2000, 'Monthly', 'SIP', '2026-05-15', 1, 1, 'Monthly SIP');
  insertPay.run(userId, 'HDFC Life Term Plan', 15000, 'Annual', 'Insurance', '2026-09-01', 0, 1, 'Annual premium');
  insertPay.run(userId, 'Star Health Insurance', 18000, 'Annual', 'Insurance', '2026-08-15', 0, 1, 'Annual premium');
  insertPay.run(userId, 'Netflix', 649, 'Monthly', 'Subscription', '2026-05-07', 1, 1, 'Streaming');
  insertPay.run(userId, 'NPS Contribution', 5000, 'Monthly', 'NPS', '2026-05-01', 1, 1, 'Voluntary NPS Tier I');

  // Seed advance tax payments
  const insertAT = db.prepare(`INSERT INTO advance_tax_payments (user_id, assessment_year, installment, amount, date_paid, notes) VALUES (?,?,?,?,?,?)`);
  insertAT.run(userId, '2026-27', 'Q1 (15 Jun)', 25000, '2025-06-12', 'Q1 advance tax');
  insertAT.run(userId, '2026-27', 'Q2 (15 Sep)', 25000, '2025-09-10', 'Q2 advance tax');
  insertAT.run(userId, '2026-27', 'Q3 (15 Dec)', 25000, '2025-12-08', 'Q3 advance tax');

  // Seed earnings
  const insertEarn = db.prepare(`INSERT INTO earnings (user_id, source_name, source_type, amount, frequency, share_percentage, notes) VALUES (?,?,?,?,?,?,?)`);
  insertEarn.run(userId, 'Salary', 'Salary', 150000, 'Monthly', 100, 'Monthly take-home');
  insertEarn.run(userId, 'Rental Income - Flat', 'Rent', 25000, 'Monthly', 40, '40% share of rental income (co-owned with mother 60-40)');

  console.log('Seed data inserted successfully.');
  console.log(`Admin user: kondetiudaykiran@gmail.com / Admin@123`);
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
    // Profile identity fields
    { table: 'profiles', column: 'legal_name', sql: 'ALTER TABLE profiles ADD COLUMN legal_name TEXT' },
    { table: 'profiles', column: 'name_on_aadhaar', sql: 'ALTER TABLE profiles ADD COLUMN name_on_aadhaar TEXT' },
    { table: 'profiles', column: 'name_on_pan', sql: 'ALTER TABLE profiles ADD COLUMN name_on_pan TEXT' },
    { table: 'profiles', column: 'pan_number', sql: 'ALTER TABLE profiles ADD COLUMN pan_number TEXT' },
    // Only last 4 digits of Aadhaar are stored — UIDAI guidelines forbid storing the full 12-digit number.
    { table: 'profiles', column: 'aadhaar_last4', sql: 'ALTER TABLE profiles ADD COLUMN aadhaar_last4 TEXT' },
    { table: 'profiles', column: 'other_ids', sql: 'ALTER TABLE profiles ADD COLUMN other_ids TEXT' },
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
