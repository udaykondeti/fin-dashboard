// Centralized config + secret validation. Fails fast at import time when
// required secrets are missing, so we never silently fall back to a
// committed default in any environment.

const isProd = process.env.NODE_ENV === 'production';

function readJwtSecret() {
  const v = process.env.JWT_SECRET;
  if (!v || v.length < 32) {
    if (isProd) {
      throw new Error(
        'JWT_SECRET is required in production and must be at least 32 characters. ' +
        'Set it via the environment (do not use a committed default).'
      );
    }
    // Dev/test only: derive a stable per-process secret so tokens survive
    // hot reloads but the value is never reused across runs.
    const crypto = require('crypto');
    const ephemeral = crypto.randomBytes(48).toString('hex');
    console.warn(
      '[config] JWT_SECRET not set or too short — using an ephemeral dev secret. ' +
      'Set JWT_SECRET in .env for stable tokens across restarts.'
    );
    return ephemeral;
  }
  return v;
}

module.exports = {
  JWT_SECRET: readJwtSecret(),
  JWT_EXPIRY: '7d',
  isProd,
  CORS_ORIGIN: process.env.CORS_ORIGIN || null,
};
