const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

const PAN_REGEX = /^[A-Z]{5}\d{4}[A-Z]$/i;
const AADHAAR_LAST4_REGEX = /^\d{4}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeIdentityFields(body) {
  const out = {};

  if (body.email !== undefined) {
    if (body.email === null || body.email === '') {
      out.email = null;
    } else {
      const email = String(body.email).trim().toLowerCase();
      if (!EMAIL_REGEX.test(email)) {
        const err = new Error('Invalid email address');
        err.status = 400;
        throw err;
      }
      out.email = email;
    }
  }

  if (body.legal_name !== undefined) {
    out.legal_name = body.legal_name === null || body.legal_name === '' ? null : String(body.legal_name).trim();
  }
  if (body.name_on_aadhaar !== undefined) {
    out.name_on_aadhaar = body.name_on_aadhaar === null || body.name_on_aadhaar === '' ? null : String(body.name_on_aadhaar).trim();
  }
  if (body.name_on_pan !== undefined) {
    out.name_on_pan = body.name_on_pan === null || body.name_on_pan === '' ? null : String(body.name_on_pan).trim();
  }

  if (body.pan_number !== undefined) {
    if (body.pan_number === null || body.pan_number === '') {
      out.pan_number = null;
    } else {
      const pan = String(body.pan_number).trim();
      if (!PAN_REGEX.test(pan)) {
        const err = new Error('Invalid PAN number. Expected format: AAAAA9999A');
        err.status = 400;
        throw err;
      }
      out.pan_number = pan.toUpperCase();
    }
  }

  if (body.aadhaar_last4 !== undefined) {
    if (body.aadhaar_last4 === null || body.aadhaar_last4 === '') {
      out.aadhaar_last4 = null;
    } else {
      const last4 = String(body.aadhaar_last4).trim();
      if (!AADHAAR_LAST4_REGEX.test(last4)) {
        const err = new Error('Aadhaar last 4 must be exactly 4 digits');
        err.status = 400;
        throw err;
      }
      out.aadhaar_last4 = last4;
    }
  }

  if (body.other_ids !== undefined) {
    if (body.other_ids === null || body.other_ids === '') {
      out.other_ids = null;
    } else if (typeof body.other_ids === 'string') {
      try {
        JSON.parse(body.other_ids);
      } catch (e) {
        const err = new Error('other_ids must be valid JSON');
        err.status = 400;
        throw err;
      }
      out.other_ids = body.other_ids;
    } else if (typeof body.other_ids === 'object') {
      out.other_ids = JSON.stringify(body.other_ids);
    } else {
      const err = new Error('other_ids must be a JSON string or object');
      err.status = 400;
      throw err;
    }
  }

  return out;
}

router.get('/', (req, res) => {
  const profiles = db.prepare('SELECT * FROM profiles WHERE user_id = ? ORDER BY is_default DESC, name').all(req.user.id);
  res.json({ profiles });
});

router.post('/', (req, res) => {
  const { name, color, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  let identity;
  try {
    identity = normalizeIdentityFields(req.body);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  const r = db.prepare(`
    INSERT INTO profiles (user_id, name, color, icon, is_default, email, legal_name, name_on_aadhaar, name_on_pan, pan_number, aadhaar_last4, other_ids)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    name,
    color || '#94a3b8',
    icon || '👤',
    identity.email || null,
    identity.legal_name || null,
    identity.name_on_aadhaar || null,
    identity.name_on_pan || null,
    identity.pan_number || null,
    identity.aadhaar_last4 || null,
    identity.other_ids || null
  );

  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(r.lastInsertRowid);
  res.json(profile);
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM profiles WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { name, color, icon } = req.body;

  let identity;
  try {
    identity = normalizeIdentityFields(req.body);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  db.prepare(`
    UPDATE profiles SET
      name = COALESCE(?, name),
      color = COALESCE(?, color),
      icon = COALESCE(?, icon),
      email = COALESCE(?, email),
      legal_name = COALESCE(?, legal_name),
      name_on_aadhaar = COALESCE(?, name_on_aadhaar),
      name_on_pan = COALESCE(?, name_on_pan),
      pan_number = COALESCE(?, pan_number),
      aadhaar_last4 = COALESCE(?, aadhaar_last4),
      other_ids = COALESCE(?, other_ids)
    WHERE id = ? AND user_id = ?
  `).run(
    name || null,
    color || null,
    icon || null,
    identity.email === undefined ? null : identity.email,
    identity.legal_name === undefined ? null : identity.legal_name,
    identity.name_on_aadhaar === undefined ? null : identity.name_on_aadhaar,
    identity.name_on_pan === undefined ? null : identity.name_on_pan,
    identity.pan_number === undefined ? null : identity.pan_number,
    identity.aadhaar_last4 === undefined ? null : identity.aadhaar_last4,
    identity.other_ids === undefined ? null : identity.other_ids,
    req.params.id,
    req.user.id
  );

  const updated = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  res.json({ success: true, profile: updated });
});

router.delete('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.is_default) return res.status(400).json({ error: 'Cannot delete default profile' });
  db.prepare('DELETE FROM profiles WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
