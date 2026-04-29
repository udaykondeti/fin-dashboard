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
const activityRoutes = require('./routes/activity');
const importRoutes = require('./routes/import');
const chatRoutes = require('./routes/chat');

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

// CORS — explicit allowlist for cross-origin clients, plus an automatic
// same-origin pass for browser POSTs that include an Origin header pointing
// at our own host. Production should still set CORS_ORIGIN if any external
// origins need access; "*" is no longer allowed silently.
const allowedOrigins = (CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (isProd && allowedOrigins.length === 0) {
  console.warn('[cors] CORS_ORIGIN not set — using same-origin only (Origin must equal request Host).');
}

// Use the request-aware form of cors() so the origin callback can compare
// the incoming Origin header against the request's own Host. Browsers send
// Origin on POSTs even for same-origin requests, which the previous config
// (which only allowed missing-Origin requests) was rejecting.
app.use(cors((req, callback) => {
  callback(null, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const originHost = origin.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (originHost === req.headers.host) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed by CORS policy'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
  });
}));

// Body parsing middleware
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// No browser caching anywhere in the app. Every refresh must hit the server
// and re-query — both for HTML/static assets AND for API JSON responses.
// This is intentional: the dashboard surfaces live financial data and we
// never want a stale page or stale net-worth figures behind a cached
// response.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Serve static files from the public directory.
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
app.use('/api/activity', activityRoutes);
app.use('/api/import', importRoutes);
app.use('/api/chat', chatRoutes);

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

// Catch-all: serve the frontend for any non-API route. The global no-cache
// middleware above applies, so this path also instructs the browser to
// revalidate on every refresh.
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
