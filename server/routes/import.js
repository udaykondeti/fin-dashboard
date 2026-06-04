// Import routes removed — all file ingestion now goes through /api/vault/upload.
const express = require('express');
const router = express.Router();
router.use((req, res) => res.status(410).json({ error: 'Import routes removed. Use /api/vault/upload instead.' }));
module.exports = router;
