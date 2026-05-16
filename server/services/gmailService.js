// Gmail OAuth2 service.
// Handles token storage, refresh, and email fetching for the payment poller.
//
// Setup: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI in .env
// The redirect URI must be registered in Google Cloud Console.
// Example: https://fin.kirakon.com/api/gmail/callback

const { google } = require('googleapis');
const db = require('../db/database');

function isGmailConfigured() {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || 'http://localhost:3001/api/gmail/callback'
  );
}

/** Returns the OAuth2 consent URL for the given user. */
function getAuthUrl(userId) {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    state: String(userId)
  });
}

/** Exchanges an auth code for tokens and saves them to DB. */
async function handleCallback(code, userId) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  saveTokens(userId, tokens);
  return tokens;
}

function saveTokens(userId, tokens) {
  db.prepare(`
    INSERT INTO gmail_tokens (user_id, access_token, refresh_token, expiry_date, scope)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, refresh_token),
      expiry_date   = excluded.expiry_date,
      scope         = excluded.scope,
      updated_at    = CURRENT_TIMESTAMP
  `).run(
    userId,
    tokens.access_token,
    tokens.refresh_token || null,
    tokens.expiry_date   || null,
    tokens.scope         || null
  );
}

function getTokens(userId) {
  return db.prepare('SELECT * FROM gmail_tokens WHERE user_id = ?').get(userId);
}

function revokeTokens(userId) {
  db.prepare('DELETE FROM gmail_tokens WHERE user_id = ?').run(userId);
}

/** Returns an authenticated Gmail API client for the given user. */
async function getGmailClient(userId) {
  const row = getTokens(userId);
  if (!row) throw new Error('Gmail not connected for this user');

  const client = getOAuth2Client();
  client.setCredentials({
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    expiry_date:   row.expiry_date
  });

  // Auto-refresh if token is expired or about to expire
  client.on('tokens', (newTokens) => saveTokens(userId, newTokens));

  return google.gmail({ version: 'v1', auth: client });
}

/**
 * Fetches emails matching a query since a given date.
 * Returns array of { id, subject, from, date, snippet, body }.
 */
async function fetchEmails(userId, { query = '', sinceDate = null, maxResults = 50 } = {}) {
  const gmail  = await getGmailClient(userId);
  let q = query || 'subject:(bill OR invoice OR payment OR due OR receipt OR statement)';
  if (sinceDate) q += ` after:${Math.floor(sinceDate.getTime() / 1000)}`;

  const listRes = await gmail.users.messages.list({
    userId: 'me', q, maxResults
  });

  const messages = listRes.data.messages || [];
  const results  = [];

  for (const msg of messages) {
    try {
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'full'
      });
      const headers = detail.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const from    = headers.find(h => h.name === 'From')?.value    || '';
      const date    = headers.find(h => h.name === 'Date')?.value    || '';
      const snippet = detail.data.snippet || '';

      // Extract body text (plain text preferred, then HTML stripped)
      let body = '';
      const parts = detail.data.payload?.parts || [detail.data.payload];
      for (const part of parts) {
        if (part?.mimeType === 'text/plain' && part.body?.data) {
          body = Buffer.from(part.body.data, 'base64').toString('utf8');
          break;
        }
      }
      if (!body) {
        for (const part of parts) {
          if (part?.mimeType === 'text/html' && part.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf8')
              .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            break;
          }
        }
      }

      results.push({ id: msg.id, subject, from, date, snippet, body: body.slice(0, 3000) });
    } catch (e) {
      console.warn(`[gmail] could not fetch message ${msg.id}:`, e.message);
    }
  }

  return results;
}

module.exports = {
  isGmailConfigured,
  getAuthUrl,
  handleCallback,
  getTokens,
  revokeTokens,
  fetchEmails
};
