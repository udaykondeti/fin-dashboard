const db = require('../db/database');

const ownsProfileStmt = db.prepare(
  'SELECT id FROM profiles WHERE id = ? AND user_id = ?'
);

// Returns true if profileId is owned by userId. null/undefined => true (no scoping requested).
function userOwnsProfile(userId, profileId) {
  if (profileId === null || profileId === undefined || profileId === '') return true;
  const id = parseInt(profileId, 10);
  if (!Number.isFinite(id)) return false;
  return !!ownsProfileStmt.get(id, userId);
}

// Express helper: validates an incoming profile_id (query or body) against req.user.
// Responds with 403 and returns false if the caller does not own the profile.
function assertProfileOwnership(req, res, profileId) {
  if (!userOwnsProfile(req.user.id, profileId)) {
    res.status(403).json({ error: 'profile_id is not owned by current user' });
    return false;
  }
  return true;
}

module.exports = { userOwnsProfile, assertProfileOwnership };
