// Inbox watcher: monitors VAULT_PATH/_inbox for new files and feeds them
// through the same pipeline as a UI upload. Lets the user drop documents
// onto the Mac (via Finder, scp, AirDrop into a synced folder, etc.) and
// have the local LLM process them automatically.
//
// Ownership: single-user app → first user in the `users` table owns
// dropped files (typically the seeded admin). When we add multi-user
// drop folders later, subdir convention `_inbox/<userId>/...` is the
// natural extension.

const fs    = require('fs');
const path  = require('path');
const db    = require('../db/database');
const vault = require('./localVault');
const { classifyDocument } = require('./smartRouter');
const vaultProcessor = require('./vaultProcessor');

const INBOX_DIRNAME = '_inbox';

function _getOwnerUserId() {
  const row = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  return row ? row.id : null;
}

// Wait for a file to stop growing (still being copied in). We poll size +
// mtime every 400ms and consider the file settled after two identical reads
// or 30 stable seconds — chokidar's `awaitWriteFinish` does the same job
// but we'd rather not pull the whole chokidar option surface into config.
async function _waitForStable(filePath) {
  let lastSize = -1, lastMtime = 0, stableTicks = 0;
  for (let i = 0; i < 75; i++) {
    let s;
    try { s = fs.statSync(filePath); }
    catch { return false; }
    if (s.size === lastSize && s.mtimeMs === lastMtime) {
      if (++stableTicks >= 2) return true;
    } else {
      stableTicks = 0;
      lastSize = s.size;
      lastMtime = s.mtimeMs;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return true; // 30s elapsed — best-effort, process anyway
}

async function _ingestOne(absPath) {
  const filename = path.basename(absPath);
  if (filename.startsWith('.')) return;  // ignore .DS_Store etc.

  const userId = _getOwnerUserId();
  if (!userId) {
    console.warn('[vaultWatcher] no users in DB — skipping', filename);
    return;
  }

  const ok = await _waitForStable(absPath);
  if (!ok) return;

  let buffer;
  try { buffer = fs.readFileSync(absPath); }
  catch (e) { console.error('[vaultWatcher] read failed:', e.message); return; }

  const { category, subcategory } = classifyDocument(filename, null, null, null);
  const fy = vault.getFYFolder();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const ts = Date.now();
  const catPath = vault.getCategoryPath(category, subcategory);
  const localKey = `${userId}/${fy}/${catPath}${ts}-${safe}`;

  try {
    vault.saveFile(buffer, localKey);
  } catch (e) {
    console.error('[vaultWatcher] save failed:', e.message);
    return;
  }

  const result = db.prepare(`
    INSERT INTO vault_files
      (user_id, profile_id, s3_key, original_filename, display_name, file_size,
       mime_type, financial_year, category, subcategory, description)
    VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    userId, localKey, filename, filename, buffer.length,
    fy, category, subcategory || null,
    'Auto-ingested from _inbox/'
  );
  const fileId = Number(result.lastInsertRowid);

  console.log(`[vaultWatcher] queued #${fileId} ${filename} → ${category}${subcategory ? '/' + subcategory : ''}`);

  vaultProcessor.enqueue(userId, () => vaultProcessor.processUpload(fileId, userId))
    .catch(err => console.error('[vaultWatcher] processor error:', err));
}

let started = false;

function start() {
  if (started) return;
  const inboxRoot = path.join(vault.getVaultRoot(), INBOX_DIRNAME);
  fs.mkdirSync(inboxRoot, { recursive: true });

  // chokidar handles cross-platform watching reliably (esp. on macOS where
  // fs.watch fires inconsistent events).
  const chokidar = require('chokidar');
  const watcher = chokidar.watch(inboxRoot, {
    ignored: /(^|[/\\])\../,   // skip dotfiles
    persistent: true,
    ignoreInitial: false,      // also pick up files dropped before boot
    depth: 5,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 }
  });

  watcher
    .on('add', p => { _ingestOne(p).catch(e => console.error('[vaultWatcher] ingest:', e)); })
    .on('error', e => console.error('[vaultWatcher] watch error:', e));

  console.log(`[vaultWatcher] watching ${inboxRoot}`);
  started = true;
}

module.exports = { start, INBOX_DIRNAME };
