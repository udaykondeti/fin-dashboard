require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { isProd, CORS_ORIGIN } = require('./config');

const authRoutes = require('./routes/auth');
const investmentRoutes = require('./routes/investments');
const liabilityRoutes = require('./routes/liabilities');
const loanRoutes = require('./routes/loans');
const networthRoutes = require('./routes/networth');
const profileRoutes = require('./routes/profiles');
const savingsRoutes = require('./routes/savings');
const insuranceRoutes = require('./routes/insurance');
const npsRoutes = require('./routes/nps');
const paymentsRoutes = require('./routes/payments');
const taxRoutes = require('./routes/tax');
const earningsRoutes = require('./routes/earnings');
const propertiesRoutes = require('./routes/properties');

const app = express();
const PORT = process.env.PORT || 3001;

// In production we sit behind nginx, so trust X-Forwarded-* headers from the
// first proxy hop. Required for express-rate-limit to see real client IPs.
if (isProd) {
  app.set('trust proxy', 1);
}

// Security headers. CSP is intentionally permissive on inline because the
// frontend is a single-file index.html with inline scripts; tighten when the
// frontend is modularized.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS — explicit allowlist. Defaults to same-origin only. Production must
// set CORS_ORIGIN (comma-separated) if cross-origin clients are expected;
// "*" is no longer allowed silently.
const allowedOrigins = (CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (isProd && allowedOrigins.length === 0) {
  console.warn('[cors] CORS_ORIGIN not set in production — cross-origin requests will be blocked.');
}

app.use(cors({
  origin: (origin, cb) => {
    // Same-origin / non-browser requests have no Origin header.
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed by CORS policy'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/investments', investmentRoutes);
app.use('/api/investments/savings', savingsRoutes);
app.use('/api/investments/insurance', insuranceRoutes);
app.use('/api/investments/nps', npsRoutes);
app.use('/api/liabilities', liabilityRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/networth', networthRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/tax', taxRoutes);
app.use('/api/earnings', earningsRoutes);
app.use('/api/properties', propertiesRoutes);

const authMiddleware = require('./middleware/auth');
const vaultRoutes = require('./routes/vault');
const adminRoutes = require('./routes/admin');
const requireAdmin = require('./middleware/requireAdmin');
// Public CA download endpoint must be registered BEFORE the authenticated
// /api/vault router; otherwise Express's first-match routing sends it
// through authMiddleware and the public link is unreachable.
app.get('/api/vault/ca/:token', vaultRoutes.caAccess);
app.use('/api/vault', authMiddleware, vaultRoutes);
app.use('/api/admin', authMiddleware, requireAdmin, adminRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'fin.kirakon.com', timestamp: new Date().toISOString() });
});

// Catch-all: serve the frontend for any non-API route
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '../public/index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'Not found' });
    }
  });
});

// Global error handler. Don't leak err.message to clients in production.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const body = { error: 'Internal server error' };
  if (!isProd) body.message = err.message;
  res.status(500).json(body);
});

app.listen(PORT, () => {
  console.log(`fin.kirakon.com server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
