const express        = require('express');
const router         = express.Router();
const crypto         = require('crypto');
const multer         = require('multer');
const path           = require('path');
const db             = require('../db/database');
const vault          = require('../services/localVault');
const { classifyDocument } = require('../services/smartRouter');
const { assertProfileOwnership } = require('../middleware/profileGuard');
const vaultProcessor = require('../services/vaultProcessor');

const MAX_FILE_BYTES    = 50 * 1024 * 1024; // 50 MB
const CA_DEFAULT_MAX_USES = 50;

// ─── Multer: store in memory; we write to vault ourselves ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault/files
// ─────────────────────────────────────────────────────────────────────────────
router.get('/files', (req, res) => {
  const userId = req.user.id;
  const { fy, category, subcategory, profile_id } = req.query;
  if (!assertProfileOwnership(req, res, profile_id)) return;

  let query = 'SELECT * FROM vault_files WHERE user_id = ?';
  const params = [userId];
  if (profile_id) { query += ' AND (profile_id = ? OR profile_id IS NULL)'; params.push(profile_id); }
  if (fy)          { query += ' AND financial_year = ?';  params.push(fy); }
  if (category)    { query += ' AND category = ?';        params.push(category); }
  if (subcategory) { query += ' AND subcategory = ?';     params.push(subcategory); }
  query += ' ORDER BY upload_date DESC';

  try {
    const files = db.prepare(query).all(...params);
    res.json({ files, count: files.length });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault/upload  (multipart/form-data, field name: "file")
// Replaces the old two-step upload-url + confirm-upload flow.
// Body fields (form): category, subcategory, financialYear, description,
//                     linkedType, linkedId, profileId
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file attached (field name must be "file")' });
  }

  const userId = req.user.id;
  const {
    category,
    subcategory,
    financialYear,
    description,
    linkedType,
    linkedId,
    profileId
  } = req.body;

  if (!assertProfileOwnership(req, res, profileId)) return;

  const filename    = req.file.originalname;
  const mimeType    = req.file.mimetype || 'application/octet-stream';
  const fileSize    = req.file.size;
  const buffer      = req.file.buffer;

  // Classify if not provided
  let cat = category;
  let subcat = subcategory;
  if (!cat) {
    const classified = classifyDocument(filename, description, linkedType, linkedId);
    cat   = classified.category;
    subcat = classified.subcategory;
  }

  const fy             = financialYear || vault.getFYFolder();
  const safeFilename   = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const timestamp      = Date.now();
  const categoryPath   = vault.getCategoryPath(cat, subcat);
  const profilePrefix  = profileId ? `p${profileId}/` : '';
  const localKey       = `${userId}/${profilePrefix}${fy}/${categoryPath}${timestamp}-${safeFilename}`;

  // Write file to local vault
  try {
    vault.saveFile(buffer, localKey);
  } catch (err) {
    console.error('[vault] saveFile error:', err.message);
    return res.status(500).json({ error: 'Failed to save file' });
  }

  // Register in DB (s3_key column reused for the local relative path)
  let file;
  try {
    const result = db.prepare(`
      INSERT INTO vault_files
        (user_id, profile_id, s3_key, original_filename, display_name, file_size, mime_type,
         financial_year, category, subcategory, linked_type, linked_id, description, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      profileId || null,
      localKey,
      filename,
      filename,
      fileSize || null,
      mimeType,
      fy,
      cat,
      subcat || null,
      linkedType || null,
      linkedId   || null,
      description || null,
      null
    );
    file = db.prepare('SELECT * FROM vault_files WHERE id = ?').get(result.lastInsertRowid);
  } catch (err) {
    // Clean up the orphaned file
    vault.deleteFile(localKey);
    return res.status(500).json({ error: 'Database error' });
  }

  // Fire-and-forget: process with Ollama
  setImmediate(() =>
    vaultProcessor.enqueue(userId, () =>
      vaultProcessor.processUpload(file.id, userId)
    ).catch(err => console.error('[vault] processor error:', err))
  );

  res.status(201).json({ message: 'File uploaded successfully', file });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault/classify  — keyword classification hint
// ─────────────────────────────────────────────────────────────────────────────
router.post('/classify', (req, res) => {
  const { filename, description, linkedType, linkedId } = req.body;
  if (!filename && !description) {
    return res.status(400).json({ error: 'Provide at least filename or description' });
  }
  res.json(classifyDocument(filename, description, linkedType, linkedId));
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault/download/:fileId  — serves file directly
// ─────────────────────────────────────────────────────────────────────────────
router.get('/download/:fileId', (req, res) => {
  const userId   = req.user.id;
  const { fileId } = req.params;

  const file = db.prepare('SELECT * FROM vault_files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const filePath = vault.getFilePath(file.s3_key);
  const displayName = file.display_name || file.original_filename;

  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(displayName)}"`);
  res.sendFile(filePath, err => {
    if (err) {
      console.error('[vault] sendFile error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'File read error' });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/vault/files/:fileId
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/files/:fileId', (req, res) => {
  const userId   = req.user.id;
  const { fileId } = req.params;

  try {
    const file = db.prepare('SELECT * FROM vault_files WHERE id = ? AND user_id = ?').get(fileId, userId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    vault.deleteFile(file.s3_key);
    db.prepare('DELETE FROM vault_files WHERE id = ?').run(fileId);
    res.json({ message: 'File deleted', fileId: parseInt(fileId) });
  } catch (err) {
    console.error('[vault] delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault/files/:fileId/reprocess — re-run the agent on a file
// Resets processed_at + processing_error and enqueues the file again. Useful
// when the local model was unavailable or returned a bad extraction.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/files/:fileId/reprocess', (req, res) => {
  const userId = req.user.id;
  const { fileId } = req.params;
  const file = db.prepare('SELECT id FROM vault_files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  db.prepare('UPDATE vault_files SET processed_at = NULL, processing_error = NULL WHERE id = ?').run(file.id);

  setImmediate(() =>
    vaultProcessor.enqueue(userId, () => vaultProcessor.processUpload(file.id, userId))
      .catch(err => console.error('[vault] reprocess error:', err))
  );

  res.json({ message: 'Reprocess queued', fileId: parseInt(fileId) });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault/fy-summary
// ─────────────────────────────────────────────────────────────────────────────
router.get('/fy-summary', (req, res) => {
  const userId = req.user.id;
  const { profile_id } = req.query;
  if (!assertProfileOwnership(req, res, profile_id)) return;

  try {
    let q = `
      SELECT financial_year,
             COUNT(*) as file_count,
             SUM(COALESCE(file_size, 0)) as total_size,
             MIN(upload_date) as first_upload,
             MAX(upload_date) as last_upload
      FROM vault_files WHERE user_id = ?`;
    const p = [userId];
    if (profile_id) { q += ' AND (profile_id = ? OR profile_id IS NULL)'; p.push(profile_id); }
    q += ' GROUP BY financial_year ORDER BY financial_year DESC';
    const rows = db.prepare(q).all(...p);
    res.json({ summary: rows, currentFY: vault.getFYFolder() });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault/stats
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const userId = req.user.id;
  try {
    const totals = db.prepare(`
      SELECT COUNT(*) as total_files, SUM(COALESCE(file_size, 0)) as total_size
      FROM vault_files WHERE user_id = ?
    `).get(userId);
    const byCategory = db.prepare(`
      SELECT category, subcategory, COUNT(*) as file_count, SUM(COALESCE(file_size, 0)) as total_size
      FROM vault_files WHERE user_id = ?
      GROUP BY category, subcategory ORDER BY category, subcategory
    `).all(userId);
    const byFY = db.prepare(`
      SELECT financial_year, COUNT(*) as file_count, SUM(COALESCE(file_size, 0)) as total_size
      FROM vault_files WHERE user_id = ?
      GROUP BY financial_year ORDER BY financial_year DESC
    `).all(userId);
    res.json({ totalFiles: totals.total_files, totalSize: totals.total_size, byCategory, byFY, currentFY: vault.getFYFolder() });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault/ca-access  — generate temporary CA link
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ca-access', (req, res) => {
  if (!process.env.BASE_URL) {
    return res.status(500).json({ error: 'BASE_URL must be set to generate CA links' });
  }
  const userId = req.user.id;
  const { financialYear, categories, expiresInHours = 48, maxUses = 5 } = req.body;
  try {
    const token         = crypto.randomBytes(32).toString('hex');
    const expiresAt     = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
    const categoriesStr = Array.isArray(categories) ? categories.join(',') : (categories || null);
    const fy            = financialYear || vault.getFYFolder();
    const cappedUses    = Math.max(1, Math.min(parseInt(maxUses, 10) || 5, CA_DEFAULT_MAX_USES));

    db.prepare(`
      INSERT INTO ca_access_tokens (user_id, token, financial_year, categories, expires_at, max_uses)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, token, fy, categoriesStr, expiresAt, cappedUses);

    const accessUrl = `${process.env.BASE_URL}/api/vault/ca/${token}`;
    res.status(201).json({ token, accessUrl, financialYear: fy, categories: categoriesStr, expiresAt, expiresInHours, maxUses: cappedUses });
  } catch (err) {
    console.error('[vault] ca-access error:', err);
    res.status(500).json({ error: 'Failed to generate CA token' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault/ca/:token  — PUBLIC (no auth middleware), mounted in index.js
// ─────────────────────────────────────────────────────────────────────────────
async function caAccess(req, res) {
  const { token } = req.params;
  if (!token || token.length < 32) return res.status(400).json({ error: 'Invalid token' });

  try {
    const tokenRecord = db.prepare('SELECT * FROM ca_access_tokens WHERE token = ?').get(token);
    if (!tokenRecord)           return res.status(404).json({ error: 'Access token not found' });
    if (tokenRecord.revoked_at) return res.status(410).json({ error: 'Access token revoked' });
    if (new Date(tokenRecord.expires_at) < new Date()) return res.status(410).json({ error: 'Access token expired' });

    const updateInfo = db.prepare(
      `UPDATE ca_access_tokens SET access_count = access_count + 1
       WHERE id = ? AND (max_uses IS NULL OR access_count < max_uses)`
    ).run(tokenRecord.id);
    if (updateInfo.changes === 0) return res.status(410).json({ error: 'Access token usage limit reached' });

    let query = 'SELECT * FROM vault_files WHERE user_id = ? AND financial_year = ?';
    const params = [tokenRecord.user_id, tokenRecord.financial_year];
    if (tokenRecord.categories) {
      const cats = tokenRecord.categories.split(',').map(c => c.trim()).filter(Boolean);
      if (cats.length) {
        query += ` AND category IN (${cats.map(() => '?').join(', ')})`;
        params.push(...cats);
      }
    }
    query += ' ORDER BY category, subcategory, upload_date DESC';
    const files = db.prepare(query).all(...params);

    // Return file metadata + public download URLs (no auth required)
    const base = process.env.BASE_URL || '';
    res.json({
      financialYear: tokenRecord.financial_year,
      categories:    tokenRecord.categories ? tokenRecord.categories.split(',') : 'all',
      accessCount:   tokenRecord.access_count + 1,
      expiresAt:     tokenRecord.expires_at,
      files: files.map(f => ({
        id:          f.id,
        filename:    f.display_name || f.original_filename,
        category:    f.category,
        subcategory: f.subcategory,
        fileSize:    f.file_size,
        mimeType:    f.mime_type,
        uploadDate:  f.upload_date,
        description: f.description,
        downloadUrl: `${base}/api/vault/ca/${token}/download/${f.id}`
      }))
    });
  } catch (err) {
    console.error('[vault] caAccess error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault/ca/:token/download/:fileId  — PUBLIC, mounted in index.js
// CA users download individual files using the token as auth.
// ─────────────────────────────────────────────────────────────────────────────
async function caDownload(req, res) {
  const { token, fileId } = req.params;
  if (!token || token.length < 32) return res.status(400).json({ error: 'Invalid token' });

  try {
    const tokenRecord = db.prepare('SELECT * FROM ca_access_tokens WHERE token = ?').get(token);
    if (!tokenRecord)           return res.status(404).json({ error: 'Access token not found' });
    if (tokenRecord.revoked_at) return res.status(410).json({ error: 'Access token revoked' });
    if (new Date(tokenRecord.expires_at) < new Date()) return res.status(410).json({ error: 'Access token expired' });

    const file = db.prepare('SELECT * FROM vault_files WHERE id = ? AND user_id = ?').get(fileId, tokenRecord.user_id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    // Enforce category restriction if the token specifies categories
    if (tokenRecord.categories) {
      const cats = tokenRecord.categories.split(',').map(c => c.trim()).filter(Boolean);
      if (cats.length && !cats.includes(file.category)) {
        return res.status(403).json({ error: 'File not in token scope' });
      }
    }

    const filePath    = vault.getFilePath(file.s3_key);
    const displayName = file.display_name || file.original_filename;
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(displayName)}"`);
    res.sendFile(filePath, err => {
      if (err) {
        console.error('[vault] caDownload sendFile error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'File read error' });
      }
    });
  } catch (err) {
    console.error('[vault] caDownload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

router.caAccess   = caAccess;
router.caDownload = caDownload;
module.exports = router;
