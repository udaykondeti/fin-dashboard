// Gmail OAuth + polling routes.
// All routes require auth middleware (mounted under /api/gmail in index.js).
//
// GET  /api/gmail/status     — is Gmail connected for this user?
// GET  /api/gmail/connect    — redirect to Google OAuth consent
// GET  /api/gmail/callback   — OAuth callback (receives code from Google)
// POST /api/gmail/disconnect — revoke stored tokens
// POST /api/gmail/poll       — manually trigger a poll (also runs on cron)

const express = require('express');
const router  = express.Router();
const gmail   = require('../services/gmailService');

function requireGmailConfig(res) {
  if (!gmail.isGmailConfigured()) {
    res.status(503).json({
      error: 'Gmail not configured',
      message: 'Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REDIRECT_URI in .env'
    });
    return false;
  }
  return true;
}

// ─── GET /api/gmail/status ────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const configured = gmail.isGmailConfigured();
  const tokens     = configured ? gmail.getTokens(req.user.id) : null;
  res.json({
    configured,
    connected: !!tokens,
    connectedAt: tokens?.updated_at || null
  });
});

// ─── GET /api/gmail/connect ───────────────────────────────────────────────
// Redirects the browser to Google's consent page.
router.get('/connect', (req, res) => {
  if (!requireGmailConfig(res)) return;
  const url = gmail.getAuthUrl(req.user.id);
  res.redirect(url);
});

// ─── GET /api/gmail/callback ──────────────────────────────────────────────
// Google redirects here after consent. Exchanges code for tokens, then
// redirects the user back to the app's settings page.
router.get('/callback', async (req, res) => {
  if (!requireGmailConfig(res)) return;
  const { code, state: userId, error } = req.query;

  if (error) {
    return res.redirect('/#settings?gmailError=' + encodeURIComponent(error));
  }
  if (!code || !userId) {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  try {
    await gmail.handleCallback(code, Number(userId));
    res.redirect('/#settings?gmailConnected=1');
  } catch (err) {
    console.error('[gmail] callback error:', err.message);
    res.redirect('/#settings?gmailError=' + encodeURIComponent(err.message));
  }
});

// ─── POST /api/gmail/disconnect ───────────────────────────────────────────
router.post('/disconnect', (req, res) => {
  gmail.revokeTokens(req.user.id);
  res.json({ message: 'Gmail disconnected' });
});

// ─── POST /api/gmail/poll ─────────────────────────────────────────────────
// Manually trigger a poll. The cron script (scripts/gmail-poller.js) also
// calls the same underlying logic.
router.post('/poll', async (req, res) => {
  if (!requireGmailConfig(res)) return;
  const tokens = gmail.getTokens(req.user.id);
  if (!tokens) return res.status(400).json({ error: 'Gmail not connected' });

  try {
    const { runPollForUser } = require('../../scripts/gmail-poller');
    const result = await runPollForUser(req.user.id);
    res.json({ message: 'Poll complete', ...result });
  } catch (err) {
    res.status(500).json({ error: 'Poll failed', message: err.message });
  }
});

// Standalone handler for the public OAuth callback (no auth middleware).
// Mounted directly in server/index.js at GET /api/gmail/callback.
async function oauthCallback(req, res) {
  if (!requireGmailConfig(res)) return;
  const { code, state: userId, error } = req.query;
  if (error) return res.redirect('/#settings?gmailError=' + encodeURIComponent(error));
  if (!code || !userId) return res.status(400).json({ error: 'Missing code or state' });
  try {
    await gmail.handleCallback(code, Number(userId));
    res.redirect('/#settings?gmailConnected=1');
  } catch (err) {
    console.error('[gmail] callback error:', err.message);
    res.redirect('/#settings?gmailError=' + encodeURIComponent(err.message));
  }
}

router.oauthCallback = oauthCallback;
