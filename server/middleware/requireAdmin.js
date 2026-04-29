const db = require('../db/database');

const isAdminStmt = db.prepare('SELECT is_admin FROM users WHERE id = ?');

// Express middleware. Must be mounted *after* authMiddleware so req.user is set.
// 403 if the authenticated user is not flagged as admin.
function requireAdmin(req, res, next) {
  const row = req.user && req.user.id ? isAdminStmt.get(req.user.id) : null;
  if (!row || !row.is_admin) {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
}

module.exports = requireAdmin;
