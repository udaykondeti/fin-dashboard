// Property Search / Shortlist API. Separate from server/routes/properties.js
// which is for user-owned real estate. This one is for candidates the user
// is evaluating.
//
// Enrichment fields (amenities, healthcare, banks, schools, transit,
// groceries, worship, red_flags) are stored as JSON strings and hydrated
// to arrays/objects on read for the frontend.

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

const JSON_FIELDS = ['amenities', 'healthcare', 'banks', 'schools', 'transit', 'groceries', 'worship', 'red_flags'];

function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of JSON_FIELDS) {
    if (typeof out[f] === 'string' && out[f].length) {
      try { out[f] = JSON.parse(out[f]); } catch (_) { /* leave as string */ }
    } else if (out[f] == null) {
      out[f] = null;
    }
  }
  return out;
}

function serialise(body) {
  const out = { ...body };
  for (const f of JSON_FIELDS) {
    if (out[f] != null && typeof out[f] !== 'string') {
      try { out[f] = JSON.stringify(out[f]); } catch (_) { out[f] = null; }
    }
  }
  return out;
}

// ── GET /api/property-shortlist ────────────────────────────────────────────
router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM property_shortlist WHERE user_id = ?
     ORDER BY
       CASE status WHEN 'shortlist' THEN 0 WHEN 'visiting' THEN 1 WHEN 'offered' THEN 2 WHEN 'purchased' THEN 3 ELSE 4 END,
       COALESCE(rating, 0) DESC,
       created_at DESC`
  ).all(req.user.id);
  res.json({ properties: rows.map(hydrate) });
});

// ── GET /api/property-shortlist/:id ────────────────────────────────────────
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM property_shortlist WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ property: hydrate(row) });
});

// ── POST /api/property-shortlist ───────────────────────────────────────────
const COLS = [
  'project_name', 'locality', 'city', 'builder', 'address', 'maps_url', 'project_url',
  'size_sqft', 'carpet_sqft', 'loading_factor_pct', 'facing', 'floor', 'bhk',
  'ask_price', 'price_min', 'price_max',
  'project_status', 'total_units', 'total_towers', 'floors_per_tower', 'size_range', 'car_parks',
  'maintenance_per_sqft', 'maintenance_notes',
  'amenities', 'healthcare', 'banks', 'schools', 'transit', 'groceries', 'worship',
  'senior_fit_score', 'senior_notes', 'red_flags',
  'elevator_count', 'power_backup',
  'status', 'rating', 'notes', 'researched_at'
];

router.post('/', (req, res) => {
  const b = serialise(req.body || {});
  if (!b.project_name) return res.status(400).json({ error: 'project_name is required' });
  const cols = ['user_id', ...COLS];
  const values = [req.user.id, ...COLS.map(c => b[c] == null ? null : b[c])];
  const sql = `INSERT INTO property_shortlist (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const r = db.prepare(sql).run(...values);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

// ── PUT /api/property-shortlist/:id ────────────────────────────────────────
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM property_shortlist WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const b = serialise(req.body || {});
  const setCols = COLS.filter(c => b[c] !== undefined);
  if (!setCols.length) return res.json({ id: existing.id, updated: 0 });
  const sql = `UPDATE property_shortlist SET ${setCols.map(c => c + '=?').join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
  db.prepare(sql).run(...setCols.map(c => b[c]), existing.id);
  res.json({ id: existing.id, updated: setCols.length });
});

// ── DELETE /api/property-shortlist/:id ─────────────────────────────────────
router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM property_shortlist WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true });
});

module.exports = router;
