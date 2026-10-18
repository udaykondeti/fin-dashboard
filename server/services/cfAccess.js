// Cloudflare Access verification — the basis for unified SSO.
//
// When all *.kirakon.com hostnames sit behind Cloudflare Access, every request
// that reaches the origin carries a `Cf-Access-Jwt-Assertion` header: a JWT
// SIGNED BY CLOUDFLARE. We verify that signature against Cloudflare's published
// keys, so the identity cannot be spoofed by hitting the origin directly (a
// forged header has no valid signature).
//
// Config (env, all optional — unset = feature disabled, app falls back to
// normal password login):
//   CF_ACCESS_TEAM_DOMAIN   e.g. kirakon.cloudflareaccess.com
//   CF_ACCESS_AUD           the Access application's Audience (AUD) tag
//
// Exposes:
//   isConfigured()          -> bool
//   verifyRequest(req)      -> { email, sub, payload } | null   (async)

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const TEAM_DOMAIN = (process.env.CF_ACCESS_TEAM_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
const AUD = (process.env.CF_ACCESS_AUD || '').trim();

function isConfigured() {
  return !!(TEAM_DOMAIN && AUD);
}

// ── JWKS (Cloudflare's signing keys), cached ────────────────────────────────
let _jwks = { keys: [], fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

async function getKeys() {
  if (_jwks.keys.length && Date.now() - _jwks.fetchedAt < JWKS_TTL_MS) {
    return _jwks.keys;
  }
  const url = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  _jwks = { keys: body.keys || [], fetchedAt: Date.now() };
  return _jwks.keys;
}

function jwkToPem(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Verify the Cloudflare Access JWT on a request.
 * Returns { email, sub, payload } when valid, or null otherwise.
 */
async function verifyRequest(req) {
  if (!isConfigured()) return null;
  const token =
    req.headers['cf-access-jwt-assertion'] ||
    (req.cookies && req.cookies.CF_Authorization);
  if (!token) return null;

  let header;
  try {
    header = JSON.parse(Buffer.from(token.split('.')[0], 'base64').toString('utf8'));
  } catch {
    return null;
  }

  try {
    const keys = await getKeys();
    const jwk = keys.find((k) => k.kid === header.kid) || keys[0];
    if (!jwk) return null;
    const pub = jwkToPem(jwk);
    const payload = jwt.verify(token, pub, {
      algorithms: ['RS256'],
      audience: AUD,
      issuer: `https://${TEAM_DOMAIN}`,
    });
    const email = (payload.email || payload.identity || '').toLowerCase();
    if (!email) return null;
    return { email, sub: payload.sub, payload };
  } catch (e) {
    // Signature/audience/issuer mismatch, expired, key rotation, etc.
    return null;
  }
}

module.exports = { isConfigured, verifyRequest };
