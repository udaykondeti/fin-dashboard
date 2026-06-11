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
const transactionsRoutes = require('./routes/transactions');
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

// Caching policy — disabled across the board. Browser, Cloudflare edge,
// and any intermediary proxy must revalidate every response. Trade-off:
// repeat visits re-download static assets (~250 KB). Worth it while we're
// hunting consistency bugs and serving live financial data — turn the
// cleaner static-asset caching back on once the deploy / data layer is
// stable.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  // Cloudflare-specific: stops the edge from caching even on 200 OK with no
  // Cache-Control opinion from origin. CDN-Cache-Control overrides
  // Cache-Control just for Cloudflare; Surrogate-Control is the widely-
  // honoured reverse-proxy equivalent.
  res.setHeader('CDN-Cache-Control',  'no-store');
  res.setHeader('Surrogate-Control', 'no-store');
  // Ensures cached responses don't get re-served when Authorization or
  // Origin changes (different user, different browser).
  res.setHeader('Vary', 'Authorization, Cookie, Origin');
  next();
});

// Serve static files from the public directory.
app.use(express.static(path.join(__dirname, '../public')));

// v2 React app (built by `cd client && npm run build` → client/dist).
// Mounted at /v2/*; SPA fallback below sends every /v2/* path to v2 index.html
// so client-side routing works on hard refresh. Falls through to v1 if dist
// hasn't been built yet, so production never 404s the static asset.
const v2Dist = path.join(__dirname, '../client/dist');
const fs = require('fs');
const v2Built = fs.existsSync(path.join(v2Dist, 'index.html'));
if (v2Built) {
  app.use('/v2', express.static(v2Dist));
}

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
app.use('/api/transactions', transactionsRoutes);
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

const gmailRoutes = require('./routes/gmail');
// The OAuth callback is public — Google redirects the browser here and
// there is no Bearer token in the redirect. Register it before the
// auth-protected /api/gmail sub-tree so Express matches it first.
app.get('/api/gmail/callback', gmailRoutes.oauthCallback);
app.use('/api/gmail', authMiddleware, gmailRoutes);

// FileVault sync — external Mac mini app posts processed transactions here.
// The router uses express.raw() internally so the HMAC signature can be
// verified against the unmodified request body, which is why we don't apply
// the global JSON parser to this prefix. The /webhook path is intentionally
// unauthenticated (signature-based); /events stays behind authMiddleware.
const filevaultSyncRoutes = require('./routes/filevaultSync');
app.use('/api/filevault', (req, res, next) => {
  if (req.path === '/webhook') return next();
  return authMiddleware(req, res, next);
}, filevaultSyncRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'fin.kirakon.com', timestamp: new Date().toISOString() });
});

// Config diagnostic — reports which optional integrations are reachable
// from inside the running process. Returns booleans only, never secrets.
// Useful for verifying env-var propagation through pm2 / ecosystem.config.
app.get('/api/health/config', (req, res) => {
  res.json({
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    groq: !!process.env.GROQ_API_KEY,
    local: !!process.env.OLLAMA_BASE_URL,
    local_model: process.env.OLLAMA_MODEL || null,
    s3: {
      bucket: !!process.env.S3_BUCKET,
      access_key: !!process.env.AWS_ACCESS_KEY_ID,
      secret_key: !!process.env.AWS_SECRET_ACCESS_KEY
    },
    cors_origin_set: !!CORS_ORIGIN,
    node_env: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// v2 SPA fallback — any /v2/* deep link returns client/dist/index.html so
// React Router can resolve the route. Registered above the v1 catch-all.
if (v2Built) {
  app.get('/v2/*', (req, res) => {
    res.sendFile(path.join(v2Dist, 'index.html'), (err) => {
      if (err) res.status(404).json({ error: 'Not found' });
    });
  });
}

// Catch-all: serve the v1 frontend for any non-API route. The global no-cache
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

  // Start watching <VAULT_PATH>/_inbox for files dropped outside the UI.
  // Wrapped in try/catch so a bad watcher init can't keep the server from
  // serving regular traffic.
  try {
    require('./services/vaultWatcher').start();
  } catch (e) {
    console.error('[startup] vaultWatcher failed to start:', e.message);
  }

  // Daily net-worth report to Slack (no-op when SLACK_WEBHOOK_URL is unset).
  try {
    require('./services/dailyReport').startScheduler();
  } catch (e) {
    console.error('[startup] dailyReport failed to start:', e.message);
  }
});

module.exports = app;
