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
let activeWatcher = null;
let inboxRoot = null;

// Walk _inbox/ once and ingest any files we find. Acts as both the periodic
// safety-net (for cases where chokidar silently detached over virtiofs on
// docker bind-mounts) AND the bootstrap pickup. _ingestOne removes the
// source file once it lands in the canonical key, so re-scans don't re-queue.
async function _rescan() {
  if (!inboxRoot) return;
  let entries;
  try { entries = fs.readdirSync(inboxRoot, { withFileTypes: true }); }
  catch (e) { console.error('[vaultWatcher] rescan readdir failed:', e.message); return; }
  for (const dirent of entries) {
    if (dirent.isFile() && !dirent.name.startsWith('.')) {
      const abs = path.join(inboxRoot, dirent.name);
      try { await _ingestOne(abs); }
      catch (e) { console.error('[vaultWatcher] rescan ingest:', e.message); }
    }
  }
}

function _createWatcher() {
  const chokidar = require('chokidar');
  const w = chokidar.watch(inboxRoot, {
    ignored: /(^|[/\\])\../,
    persistent: true,
    ignoreInitial: false,
    depth: 5,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 }
  });
  w.on('add', p => { _ingestOne(p).catch(e => console.error('[vaultWatcher] ingest:', e)); })
   .on('error', async (e) => {
     // chokidar sometimes silently stops firing 'add' after an error on
     // virtiofs (EACCES, EBUSY). Tear it down and recreate — cheaper than
     // letting files sit in _inbox/ unprocessed.
     console.error('[vaultWatcher] watch error — recreating watcher:', e && e.message);
     try { await w.close(); } catch (_) {}
     setTimeout(() => { activeWatcher = _createWatcher(); }, 1000);
   });
  return w;
}

function start() {
  if (started) return;
  inboxRoot = path.join(vault.getVaultRoot(), INBOX_DIRNAME);
  fs.mkdirSync(inboxRoot, { recursive: true });

  activeWatcher = _createWatcher();
  console.log(`[vaultWatcher] watching ${inboxRoot}`);

  // Periodic safety-net rescan. Catches files chokidar missed (silent
  // virtiofs hiccups, watcher recreate race, file dropped during restart).
  // _ingestOne is idempotent because it deletes the inbox copy after
  // saving to the canonical key.
  setInterval(() => { _rescan().catch(e => console.error('[vaultWatcher] periodic rescan:', e.message)); }, 60_000);

  started = true;
}

module.exports = { start, INBOX_DIRNAME };
