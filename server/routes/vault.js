const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db/database');
const {
  isS3Configured,
  ensureBucketExists,
  getUploadPresignedUrl,
  getDownloadPresignedUrl,
  listFiles,
  deleteFile,
  getFYFolder,
  getCategoryPath
} = require('../services/s3');
const { classifyDocument } = require('../services/smartRouter');
const { assertProfileOwnership } = require('../middleware/profileGuard');

const BUCKET = process.env.S3_BUCKET_NAME || 'fin-kirakon-vault';

// ─── Helper: check S3 config and return 503 if missing ────────────────────────
function requireS3(res) {
  if (!isS3Configured()) {
    res.status(503).json({
      error: 'S3 not configured',
      message: 'AWS credentials are missing. Set AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and S3_BUCKET_NAME in your environment.'
    });
    return false;
  }
  return true;
}

// ─── Helper: wrap S3 errors ────────────────────────────────────────────────────
function handleS3Error(res, err, context) {
  console.error(`[vault] S3 error in ${context}:`, err.message);
  if (err.message && err.message.includes('not configured')) {
    return res.status(503).json({ error: 'S3 not configured', message: err.message });
  }
  return res.status(500).json({ error: 'S3 operation failed', message: err.message });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault/files
// Query: fy=FY2025-26, category=stocks, subcategory=nse-bse (all optional)
// Returns DB records for the authenticated user's files, enriched with metadata.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/files', (req, res) => {
  const userId = req.user.id;
  const { fy, category, subcategory, profile_id } = req.query;
  if (!assertProfileOwnership(req, res, profile_id)) return;

  let query = 'SELECT * FROM vault_files WHERE user_id = ?';
  const params = [userId];

  if (profile_id) {
    query += ' AND (profile_id = ? OR profile_id IS NULL)';
    params.push(profile_id);
  }
  if (fy) {
    query += ' AND financial_year = ?';
    params.push(fy);
  }
  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  if (subcategory) {
    query += ' AND subcategory = ?';
    params.push(subcategory);
  }

  query += ' ORDER BY upload_date DESC';

  try {
    const files = db.prepare(query).all(...params);
    res.json({ files, count: files.length });
  } catch (err) {
    console.error('[vault] DB error listing files:', err);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault/upload-url
// Body: { filename, contentType, category, subcategory, financialYear, description, linkedType, linkedId }
// Returns: { uploadUrl, s3Key, financialYear, category, subcategory }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload-url', async (req, res) => {
  if (!requireS3(res)) return;

  const userId = req.user.id;
  const {
    filename,
    contentType,
    category,
    subcategory,
    financialYear,
    description,
    linkedType,
    linkedId,
    profileId
  } = req.body;

  if (!filename || !contentType) {
    return res.status(400).json({ error: 'filename and contentType are required' });
  }
  if (!assertProfileOwnership(req, res, profileId)) return;

  try {
    // Determine FY
    const fy = financialYear || getFYFolder();

    // Determine category path (auto-classify if not provided)
    let cat = category;
    let subcat = subcategory;
    if (!cat) {
      const classified = classifyDocument(filename, description, linkedType, linkedId);
      cat = classified.category;
      subcat = classified.subcategory;
    }

    // Build S3 key: {userId}/{profileId}/{FY}/{category}/{subcategory}/{timestamp}-{filename}
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = Date.now();
    const categoryPath = getCategoryPath(cat, subcat);
    const profilePrefix = profileId ? `p${profileId}/` : '';
    const s3Key = `${userId}/${profilePrefix}${fy}/${categoryPath}${timestamp}-${safeFilename}`;

    // Ensure bucket exists (creates it if first time)
    await ensureBucketExists(BUCKET);

    // Generate presigned PUT URL
    const uploadUrl = await getUploadPresignedUrl(BUCKET, s3Key, contentType, 3600);

    res.json({
      uploadUrl,
      s3Key,
      financialYear: fy,
      category: cat,
      subcategory: subcat,
      profileId: profileId || null,
      bucket: BUCKET,
      expiresIn: 3600
    });
  } catch (err) {
    handleS3Error(res, err, 'upload-url');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault/confirm-upload
// Called after the client finishes uploading directly to S3.
// Body: { s3Key, originalFilename, displayName, fileSize, mimeType, financialYear,
//         category, subcategory, description, tags, linkedType, linkedId }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/confirm-upload', (req, res) => {
  const userId = req.user.id;
  const {
    s3Key,
    originalFilename,
    displayName,
    fileSize,
    mimeType,
    financialYear,
    category,
    subcategory,
    description,
    tags,
    linkedType,
    linkedId,
    profileId
  } = req.body;

  if (!s3Key || !originalFilename || !financialYear || !category) {
    return res.status(400).json({
      error: 'Missing required fields: s3Key, originalFilename, financialYear, category'
    });
  }
  if (!assertProfileOwnership(req, res, profileId)) return;

  try {
    const stmt = db.prepare(`
      INSERT INTO vault_files
        (user_id, profile_id, s3_key, original_filename, display_name, file_size, mime_type,
         financial_year, category, subcategory, linked_type, linked_id, description, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      userId,
      profileId || null,
      s3Key,
      originalFilename,
      displayName || originalFilename,
      fileSize || null,
      mimeType || null,
      financialYear,
      category,
      subcategory || null,
      linkedType || null,
      linkedId || null,
      description || null,
      tags ? (Array.isArray(tags) ? tags.join(',') : tags) : null
    );

    const file = db.prepare('SELECT * FROM vault_files WHERE id = ?').get(result.lastInsertRowid);

    // Fire-and-forget auto-processing. Failures are logged but don't block
    // the upload response.
    try {
      const vaultProcessor = require('../services/vaultProcessor');
      setImmediate(() => {
        vaultProcessor.enqueue(userId, () =>
          vaultProcessor.processUpload(file.id, userId)
        ).catch(err => console.error('[vault] processor error:', err));
      });
    } catch (e) {
      console.error('[vault] could not schedule processor:', e.message);
    }

    res.status(201).json({ message: 'File registered successfully', file });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'File with this S3 key already exists' });
    }
    console.error('[vault] DB error confirming upload:', err);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault/classify
// Body: { filename, description, linkedType, linkedId }
// Returns classification suggestion
// ─────────────────────────────────────────────────────────────────────────────
router.post('/classify', (req, res) => {
  const { filename, description, linkedType, linkedId } = req.body;

  if (!filename && !description) {
    return res.status(400).json({ error: 'Provide at least filename or description' });
  }

  const result = classifyDocument(filename, description, linkedType, linkedId);
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault/download/:fileId
// Returns a presigned download URL for the given file
// ─────────────────────────────────────────────────────────────────────────────
router.get('/download/:fileId', async (req, res) => {
  if (!requireS3(res)) return;

  const userId = req.user.id;
  const { fileId } = req.params;

  try {
    const file = db.prepare(
      'SELECT * FROM vault_files WHERE id = ? AND user_id = ?'
    ).get(fileId, userId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    const downloadUrl = await getDownloadPresignedUrl(BUCKET, file.s3_key, 3600);

    res.json({
      downloadUrl,
      filename: file.display_name || file.original_filename,
      mimeType: file.mime_type,
      expiresIn: 3600
    });
  } catch (err) {
    handleS3Error(res, err, 'download');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/vault/files/:fileId
// Deletes from S3 and removes DB record
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/files/:fileId', async (req, res) => {
  if (!requireS3(res)) return;

  const userId = req.user.id;
  const { fileId } = req.params;

  try {
    const file = db.prepare(
      'SELECT * FROM vault_files WHERE id = ? AND user_id = ?'
    ).get(fileId, userId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Delete from S3
    await deleteFile(BUCKET, file.s3_key);

    // Delete from DB
    db.prepare('DELETE FROM vault_files WHERE id = ?').run(fileId);

    res.json({ message: 'File deleted successfully', fileId: parseInt(fileId) });
  } catch (err) {
    handleS3Error(res, err, 'delete');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault/fy-summary
// Returns all financial years with file count and total size
// ─────────────────────────────────────────────────────────────────────────────
router.get('/fy-summary', (req, res) => {
  const userId = req.user.id;
  const { profile_id } = req.query;
  if (!assertProfileOwnership(req, res, profile_id)) return;

  try {
    let q = `
      SELECT
        financial_year,
        COUNT(*) as file_count,
        SUM(COALESCE(file_size, 0)) as total_size,
        MIN(upload_date) as first_upload,
        MAX(upload_date) as last_upload
      FROM vault_files
      WHERE user_id = ?`;
    const p = [userId];
    if (profile_id) { q += ' AND (profile_id = ? OR profile_id IS NULL)'; p.push(profile_id); }
    q += ' GROUP BY financial_year ORDER BY financial_year DESC';
    const rows = db.prepare(q).all(...p);

    res.json({ summary: rows, currentFY: getFYFolder() });
  } catch (err) {
    console.error('[vault] DB error fy-summary:', err);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vault/ca-access
// Body: { financialYear, categories, expiresInHours (default 48) }
// Generates a temporary CA access token stored in DB
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ca-access', (req, res) => {
  const userId = req.user.id;
  const { financialYear, categories, expiresInHours = 48, maxUses = 5 } = req.body;

  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
    const categoriesStr = Array.isArray(categories) ? categories.join(',') : (categories || null);
    const fy = financialYear || getFYFolder();
    const cappedUses = Math.max(1, Math.min(parseInt(maxUses, 10) || 5, 50));

    db.prepare(`
      INSERT INTO ca_access_tokens (user_id, token, financial_year, categories, expires_at, max_uses)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, token, fy, categoriesStr, expiresAt, cappedUses);

    const accessUrl = `${process.env.BASE_URL || ''}/api/vault/ca/${token}`;

    res.status(201).json({
      token,
      accessUrl,
      financialYear: fy,
      categories: categoriesStr,
      expiresAt,
      expiresInHours,
      maxUses: cappedUses
    });
  } catch (err) {
    console.error('[vault] Error generating CA token:', err);
    res.status(500).json({ error: 'Failed to generate CA access token', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault/stats
// Returns total files, total size, per-category breakdown for the user
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const userId = req.user.id;

  try {
    const totals = db.prepare(`
      SELECT
        COUNT(*) as total_files,
        SUM(COALESCE(file_size, 0)) as total_size
      FROM vault_files WHERE user_id = ?
    `).get(userId);

    const byCategory = db.prepare(`
      SELECT
        category,
        subcategory,
        COUNT(*) as file_count,
        SUM(COALESCE(file_size, 0)) as total_size
      FROM vault_files
      WHERE user_id = ?
      GROUP BY category, subcategory
      ORDER BY category, subcategory
    `).all(userId);

    const byFY = db.prepare(`
      SELECT
        financial_year,
        COUNT(*) as file_count,
        SUM(COALESCE(file_size, 0)) as total_size
      FROM vault_files
      WHERE user_id = ?
      GROUP BY financial_year
      ORDER BY financial_year DESC
    `).all(userId);

    res.json({
      totalFiles: totals.total_files,
      totalSize: totals.total_size,
      byCategory,
      byFY,
      currentFY: getFYFolder()
    });
  } catch (err) {
    console.error('[vault] DB error stats:', err);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vault/ca/:token  — PUBLIC, no auth middleware
// Resolves a CA token and returns presigned download URLs for the FY's files.
// This handler is exported separately to be mounted without authMiddleware.
// ─────────────────────────────────────────────────────────────────────────────
async function caAccess(req, res) {
  const { token } = req.params;

  if (!token || token.length < 32) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  try {
    const tokenRecord = db.prepare(
      'SELECT * FROM ca_access_tokens WHERE token = ?'
    ).get(token);

    if (!tokenRecord) {
      return res.status(404).json({ error: 'Access token not found' });
    }

    if (tokenRecord.revoked_at) {
      return res.status(410).json({ error: 'Access token has been revoked' });
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Access token has expired' });
    }

    // Atomically increment access_count, but only if we have not yet hit max_uses.
    // If max_uses is null (legacy rows) we leave behavior unchanged.
    const updateInfo = db.prepare(
      `UPDATE ca_access_tokens
         SET access_count = access_count + 1
       WHERE id = ?
         AND (max_uses IS NULL OR access_count < max_uses)`
    ).run(tokenRecord.id);

    if (updateInfo.changes === 0) {
      return res.status(410).json({ error: 'Access token has reached its usage limit' });
    }

    // Build file query
    let query = 'SELECT * FROM vault_files WHERE user_id = ? AND financial_year = ?';
    const params = [tokenRecord.user_id, tokenRecord.financial_year];

    if (tokenRecord.categories) {
      const cats = tokenRecord.categories.split(',').map(c => c.trim()).filter(Boolean);
      if (cats.length > 0) {
        const placeholders = cats.map(() => '?').join(', ');
        query += ` AND category IN (${placeholders})`;
        params.push(...cats);
      }
    }

    query += ' ORDER BY category, subcategory, upload_date DESC';
    const files = db.prepare(query).all(...params);

    // If S3 is not configured, return file metadata without presigned URLs
    if (!isS3Configured()) {
      return res.json({
        financialYear: tokenRecord.financial_year,
        categories: tokenRecord.categories ? tokenRecord.categories.split(',') : 'all',
        accessCount: tokenRecord.access_count + 1,
        expiresAt: tokenRecord.expires_at,
        files: files.map(f => ({
          id: f.id,
          filename: f.display_name || f.original_filename,
          category: f.category,
          subcategory: f.subcategory,
          fileSize: f.file_size,
          mimeType: f.mime_type,
          uploadDate: f.upload_date,
          description: f.description,
          downloadUrl: null,
          note: 'S3 not configured — download URLs unavailable'
        }))
      });
    }

    // Generate presigned download URLs for each file (valid 24 hours)
    const fileList = await Promise.all(
      files.map(async (f) => {
        let downloadUrl = null;
        try {
          downloadUrl = await getDownloadPresignedUrl(BUCKET, f.s3_key, 86400);
        } catch (urlErr) {
          console.error(`[vault] Could not generate presigned URL for key ${f.s3_key}:`, urlErr.message);
        }
        return {
          id: f.id,
          filename: f.display_name || f.original_filename,
          category: f.category,
          subcategory: f.subcategory,
          fileSize: f.file_size,
          mimeType: f.mime_type,
          uploadDate: f.upload_date,
          description: f.description,
          downloadUrl
        };
      })
    );

    res.json({
      financialYear: tokenRecord.financial_year,
      categories: tokenRecord.categories ? tokenRecord.categories.split(',') : 'all',
      accessCount: tokenRecord.access_count + 1,
      expiresAt: tokenRecord.expires_at,
      files: fileList
    });
  } catch (err) {
    console.error('[vault] Error in CA access:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

// Export the router and the standalone caAccess handler
router.caAccess = caAccess;
module.exports = router;
