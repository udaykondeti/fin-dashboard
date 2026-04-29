const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const { JWT_SECRET, JWT_EXPIRY } = require('../config');

// Minimum password requirements: ≥12 chars, at least one letter, one digit,
// and one symbol or uppercase. Existing accounts are unaffected; this only
// kicks in on change-password.
function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 12) {
    return { ok: false, reason: 'Password must be at least 12 characters' };
  }
  if (!/[a-z]/.test(pw) || !/\d/.test(pw)) {
    return { ok: false, reason: 'Password must include at least one letter and one digit' };
  }
  if (!/[A-Z]/.test(pw) && !/[^A-Za-z0-9]/.test(pw)) {
    return { ok: false, reason: 'Password must include an uppercase letter or a symbol' };
  }
  return { ok: true };
}

// Limit login attempts per IP. Returns 429 once exceeded.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' }
});

/**
 * POST /api/auth/login
 * Authenticate user with email + password, return JWT
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user by email
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT
    const payload = {
      id: user.id,
      email: user.email,
      name: user.name
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        created_at: user.created_at
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed', message: err.message });
  }
});

/**
 * GET /api/auth/me
 * Return current authenticated user
 */
router.get('/me', authMiddleware, (req, res) => {
  try {
    const user = db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (err) {
    console.error('Get me error:', err);
    res.status(500).json({ error: 'Failed to fetch user', message: err.message });
  }
});

/**
 * POST /api/auth/change-password
 * Change password for authenticated user
 */
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }

    const policy = checkPasswordPolicy(new_password);
    if (!policy.ok) {
      return res.status(400).json({ error: policy.reason });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const isValid = await bcrypt.compare(current_password, user.password_hash);

    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(new_password, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password', message: err.message });
  }
});

module.exports = router;
