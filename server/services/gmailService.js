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

/**
 * Best-effort validity check of a user's stored Gmail tokens. Returns:
 *   { connected: false }                      — no tokens saved
 *   { connected: true, valid: true }          — token usable (refreshed if needed)
 *   { connected: true, valid: false, reason } — refresh failed: the refresh
 *       token was revoked, the OAuth client was deleted (deleted_client), the
 *       consent was withdrawn, etc.
 * Lets the UI distinguish "never connected" from "connected but broken" without
 * a full message-list call. Note: a still-valid (unexpired) access token is
 * accepted without contacting Google, so a client deletion surfaces on the next
 * hourly expiry rather than instantly — good enough for a status banner.
 */
async function checkCredentials(userId) {
  const row = getTokens(userId);
  if (!row) return { connected: false };

  const client = getOAuth2Client();
  client.setCredentials({
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    expiry_date:   row.expiry_date
  });
  client.on('tokens', (t) => saveTokens(userId, t));

  try {
    // Refreshes when the access token is expired; validates the refresh token
    // and the OAuth client itself against Google.
    await client.getAccessToken();
    return { connected: true, valid: true };
  } catch (err) {
    const reason = err?.response?.data?.error || err?.message || 'unknown';
    return { connected: true, valid: false, reason };
  }
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
 * Recursively walks a Gmail message payload, collecting the best body text
 * (text/plain preferred, HTML stripped as fallback) and any file attachments.
 * Real-world bills nest parts (multipart/mixed → multipart/alternative → …),
 * so a flat scan of the top level misses both nested bodies and attachments.
 */
function _walkPayload(node, acc) {
  if (!node) return;
  const { mimeType, filename, body, parts } = node;
  if (filename && body?.attachmentId) {
    acc.attachments.push({
      filename,
      mimeType: mimeType || 'application/octet-stream',
      attachmentId: body.attachmentId,
      size: body.size || 0,
    });
  } else if (mimeType === 'text/plain' && body?.data && !acc.plain) {
    acc.plain = Buffer.from(body.data, 'base64').toString('utf8');
  } else if (mimeType === 'text/html' && body?.data && !acc.html) {
    acc.html = Buffer.from(body.data, 'base64').toString('utf8')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  for (const p of parts || []) _walkPayload(p, acc);
}

/**
 * Fetches emails matching a query since a given date.
 * Returns array of { id, subject, from, date, snippet, body, attachments }
 * where attachments is [{ filename, mimeType, attachmentId, size }] (metadata
 * only — call downloadAttachmentText() to pull and extract text from one).
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

      const acc = { plain: '', html: '', attachments: [] };
      _walkPayload(detail.data.payload, acc);
      const body = acc.plain || acc.html || '';

      results.push({
        id: msg.id, subject, from, date, snippet,
        body: body.slice(0, 3000),
        attachments: acc.attachments,
      });
    } catch (e) {
      console.warn(`[gmail] could not fetch message ${msg.id}:`, e.message);
    }
  }

  return results;
}

/** Parse a full-format Gmail message resource into our normalized shape. */
function _parseMessage(detail) {
  const headers = detail.data.payload?.headers || [];
  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const from    = headers.find(h => h.name === 'From')?.value    || '';
  const date    = headers.find(h => h.name === 'Date')?.value    || '';
  const snippet = detail.data.snippet || '';
  const acc = { plain: '', html: '', attachments: [] };
  _walkPayload(detail.data.payload, acc);
  return {
    id: detail.data.id,
    subject, from, date, snippet,
    body: (acc.plain || acc.html || ''),
    attachments: acc.attachments,
  };
}

/**
 * Fetches one message by its Gmail id (not an rfc822 Message-Id — the opaque id
 * returned in search results). Returns the same shape as fetchEmails items,
 * with the body NOT truncated so the caller sees the full content.
 */
async function getMessageById(userId, messageId) {
  const gmail = await getGmailClient(userId);
  const detail = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  return _parseMessage(detail);
}

/**
 * Downloads one attachment and runs it through the shared text extractor
 * (PDF, images w/ OCR, DOCX, XLSX, CSV, …). Returns { text, kind, warnings }.
 */
async function downloadAttachmentText(userId, { messageId, attachmentId, mimeType, filename }) {
  const gmail = await getGmailClient(userId);
  const res = await gmail.users.messages.attachments.get({
    userId: 'me', messageId, id: attachmentId,
  });
  const data = res.data?.data;
  if (!data) return { text: '', kind: 'unknown', warnings: ['Attachment had no data'] };
  const buffer = Buffer.from(data, 'base64');
  const { extractText } = require('./textExtract');
  return extractText(buffer, mimeType, filename);
}

module.exports = {
  isGmailConfigured,
  getAuthUrl,
  handleCallback,
  getTokens,
  revokeTokens,
  checkCredentials,
  fetchEmails,
  getMessageById,
  downloadAttachmentText
};
