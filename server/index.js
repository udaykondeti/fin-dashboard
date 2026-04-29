require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

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

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
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

const authMiddleware = require('./middleware/auth');
const vaultRoutes = require('./routes/vault');
// Public CA-access route MUST be registered before the auth-protected mount;
// otherwise app.use('/api/vault', authMiddleware, ...) intercepts every
// /api/vault/* request and rejects the unauthenticated CA share link.
app.get('/api/vault/ca/:token', vaultRoutes.caAccess);
app.use('/api/vault', authMiddleware, vaultRoutes);

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

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

app.listen(PORT, () => {
  console.log(`fin.kirakon.com server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
