const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', (req, res) => {
  const profiles = db.prepare('SELECT * FROM profiles WHERE user_id = ? ORDER BY is_default DESC, name').all(req.user.id);
  res.json({ profiles });
});

router.post('/', (req, res) => {
  const { name, color, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO profiles (user_id, name, color, icon, is_default) VALUES (?,?,?,?,0)').run(req.user.id, name, color || '#94a3b8', icon || '👤');
  res.json({ id: r.lastInsertRowid, name, color, icon });
});

router.put('/:id', (req, res) => {
  const { name, color, icon } = req.body;
  db.prepare('UPDATE profiles SET name=?, color=?, icon=? WHERE id=? AND user_id=?').run(name, color, icon, req.params.id, req.user.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.is_default) return res.status(400).json({ error: 'Cannot delete default profile' });
  db.prepare('DELETE FROM profiles WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
