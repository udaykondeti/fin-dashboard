// Profile & household-linking routes. A "profile" is the logged-in user.
// Every login completes their own profile once (first-login gate), then users
// link to each other by email — each link needs the OTHER person's approval —
// to form a household whose shared assets/income can be split for tax.
//
// Mounted at /api/profile behind authMiddleware.

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

const PAN_REGEX = /^[A-Z]{5}\d{4}[A-Z]$/i;
const AADHAAR_LAST4_REGEX = /^\d{4}$/;
const RELATIONSHIPS = new Set(['spouse', 'parent', 'child', 'sibling', 'joint', 'other']);

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name,
    full_name: u.full_name || null,
    pan_number: u.pan_number || null,
    aadhaar_last4: u.aadhaar_last4 || null,
    name_on_pan: u.name_on_pan || null,
    name_on_aadhaar: u.name_on_aadhaar || null,
    phone: u.phone || null,
    dob: u.dob || null,
    profile_completed: !!u.profile_completed,
    is_admin: !!u.is_admin,
  };
}

// ── GET /api/profile/me ──────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ profile: publicUser(u) });
});

// ── PUT /api/profile/me ──────────────────────────────────────────────────────
// Completes / updates the caller's own profile. full_name is required to mark
// the profile complete; PAN/Aadhaar are validated when present.
router.put('/me', (req, res) => {
  const b = req.body || {};
  const full_name = (b.full_name == null ? '' : String(b.full_name)).trim();
  if (!full_name) return res.status(400).json({ error: 'Full name is required' });

  let pan = b.pan_number == null ? '' : String(b.pan_number).trim();
  if (pan) {
    if (!PAN_REGEX.test(pan)) return res.status(400).json({ error: 'Invalid PAN. Expected format: AAAAA9999A' });
    pan = pan.toUpperCase();
  }
  const aadhaar = b.aadhaar_last4 == null ? '' : String(b.aadhaar_last4).trim();
  if (aadhaar && !AADHAAR_LAST4_REGEX.test(aadhaar)) {
    return res.status(400).json({ error: 'Aadhaar must be exactly the last 4 digits' });
  }

  db.prepare(`
    UPDATE users SET
      full_name = ?, pan_number = ?, aadhaar_last4 = ?,
      name_on_pan = ?, name_on_aadhaar = ?, phone = ?, dob = ?,
      profile_completed = 1
    WHERE id = ?
  `).run(
    full_name,
    pan || null,
    aadhaar || null,
    (b.name_on_pan == null || b.name_on_pan === '') ? null : String(b.name_on_pan).trim(),
    (b.name_on_aadhaar == null || b.name_on_aadhaar === '') ? null : String(b.name_on_aadhaar).trim(),
    (b.phone == null || b.phone === '') ? null : String(b.phone).trim(),
    (b.dob == null || b.dob === '') ? null : String(b.dob).trim(),
    req.user.id
  );

  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ success: true, profile: publicUser(u) });
});

// ── GET /api/profile/links ───────────────────────────────────────────────────
// Returns the caller's household links, split by state and direction, each with
// the *other* person's basic info.
router.get('/links', (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`
    SELECT l.*,
           ru.email AS requester_email, ru.name AS requester_name, ru.full_name AS requester_full,
           tu.email AS target_email,    tu.name AS target_name,    tu.full_name AS target_full
    FROM user_links l
    JOIN users ru ON ru.id = l.requester_id
    JOIN users tu ON tu.id = l.target_id
    WHERE l.requester_id = ? OR l.target_id = ?
    ORDER BY l.created_at DESC
  `).all(me, me);

  const shape = (l) => {
    const iAmRequester = l.requester_id === me;
    const other = iAmRequester
      ? { id: l.target_id, email: l.target_email, name: l.target_full || l.target_name }
      : { id: l.requester_id, email: l.requester_email, name: l.requester_full || l.requester_name };
    return { id: l.id, status: l.status, relationship: l.relationship, direction: iAmRequester ? 'outgoing' : 'incoming', person: other, created_at: l.created_at };
  };

  const all = rows.map(shape);
  res.json({
    approved: all.filter(l => l.status === 'approved'),
    incoming: all.filter(l => l.status === 'pending' && l.direction === 'incoming'),
    outgoing: all.filter(l => l.status === 'pending' && l.direction === 'outgoing'),
  });
});

// ── POST /api/profile/links ──────────────────────────────────────────────────
// Request a link to another user by email. Needs their approval before active.
router.post('/links', (req, res) => {
  const me = req.user.id;
  const email = (req.body && req.body.email ? String(req.body.email) : '').trim().toLowerCase();
  const relationship = (req.body && req.body.relationship ? String(req.body.relationship) : '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email is required' });
  if (relationship && !RELATIONSHIPS.has(relationship)) {
    return res.status(400).json({ error: 'Invalid relationship' });
  }

  const target = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!target) return res.status(404).json({ error: 'No account exists with that email. Ask them to sign up first.' });
  if (target.id === me) return res.status(400).json({ error: 'You cannot link to yourself' });

  // Any existing link between the two (either direction)?
  const existing = db.prepare(`
    SELECT * FROM user_links
    WHERE (requester_id = ? AND target_id = ?) OR (requester_id = ? AND target_id = ?)
  `).get(me, target.id, target.id, me);
  if (existing) {
    if (existing.status === 'approved') return res.status(409).json({ error: 'Already linked' });
    if (existing.status === 'pending')  return res.status(409).json({ error: 'A request is already pending between you two' });
    // rejected → allow a fresh request by resetting it to pending from me
    db.prepare('UPDATE user_links SET requester_id=?, target_id=?, status=?, relationship=?, created_at=CURRENT_TIMESTAMP, responded_at=NULL WHERE id=?')
      .run(me, target.id, 'pending', relationship || null, existing.id);
    return res.json({ success: true, status: 'pending', id: existing.id });
  }

  const r = db.prepare('INSERT INTO user_links (requester_id, target_id, status, relationship) VALUES (?, ?, ?, ?)')
    .run(me, target.id, 'pending', relationship || null);
  res.json({ success: true, status: 'pending', id: r.lastInsertRowid });
});

// ── POST /api/profile/links/:id/respond ──────────────────────────────────────
// Only the TARGET of a pending request may approve/reject it.
router.post('/links/:id/respond', (req, res) => {
  const me = req.user.id;
  const action = (req.body && req.body.action ? String(req.body.action) : '').trim().toLowerCase();
  if (action !== 'approve' && action !== 'reject') {
    return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
  }
  const link = db.prepare('SELECT * FROM user_links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  if (link.target_id !== me) return res.status(403).json({ error: 'Only the invited person can respond to this request' });
  if (link.status !== 'pending') return res.status(409).json({ error: 'This request has already been answered' });

  db.prepare('UPDATE user_links SET status = ?, responded_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(action === 'approve' ? 'approved' : 'rejected', link.id);
  res.json({ success: true, status: action === 'approve' ? 'approved' : 'rejected' });
});

// ── DELETE /api/profile/links/:id ────────────────────────────────────────────
// Either party may remove a link (unlink, or cancel a pending request).
router.delete('/links/:id', (req, res) => {
  const me = req.user.id;
  const link = db.prepare('SELECT * FROM user_links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  if (link.requester_id !== me && link.target_id !== me) {
    return res.status(403).json({ error: 'Not your link' });
  }
  db.prepare('DELETE FROM user_links WHERE id = ?').run(link.id);
  res.json({ success: true });
});

module.exports = router;
