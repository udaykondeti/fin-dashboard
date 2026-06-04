// Background processor for vault uploads. On every successful upload,
// routes/vault.js fires processUpload(fileId, userId) via setImmediate.
// We read the file from local storage, extract text, then run
// chatAgent.streamMessage() against the user's "Pending uploads" thread
// so the agent can propose adds via the existing propose_* tool flow.
//
// Per-user serial queue: two rapid uploads from the same user are
// processed sequentially. Cross-user uploads run in parallel.
//
// Dedup levels:
//   1. File hash  — SHA-256 of raw bytes. Blocks exact re-upload of the same file.
//   2. Text hash  — SHA-256 of extracted text. Blocks same content in a different
//      format (e.g. PDF statement + screenshot of the same statement).
//   3. source_ref — agent prompt instructs the LLM to use a normalised transaction
//      fingerprint as source_ref; the transactions UNIQUE(user_id, source, source_ref)
//      constraint silently discards cross-document duplicates at insert time.

const crypto      = require('crypto');
const db          = require('../db/database');
const localVault  = require('./localVault');
const textExtract = require('./textExtract');
const chatAgent   = require('./chatAgent');

const PENDING_THREAD_KIND  = 'upload_processor';
const PENDING_THREAD_TITLE = '📥 Pending uploads';

// ────────────────────────────── Per-user serial queue ──────────────────────

const queues = new Map();   // userId → tail Promise

function enqueue(userId, work) {
  const prev = queues.get(userId) || Promise.resolve();
  const next = prev.then(() => Promise.resolve().then(work)).catch(err => {
    console.error('[vaultProcessor] queue error:', err);
  });
  queues.set(userId, next);
  next.finally(() => {
    if (queues.get(userId) === next) queues.delete(userId);
  });
  return next;
}

// ────────────────────────────── Thread provisioning ────────────────────────

function getOrCreatePendingThread(userId) {
  const existing = db.prepare(
    `SELECT id FROM agent_threads WHERE user_id = ? AND agent_kind = ? ORDER BY id ASC LIMIT 1`
  ).get(userId, PENDING_THREAD_KIND);
  if (existing) return existing.id;
  // Use 'auto' so routeProvider picks Ollama when configured, Anthropic otherwise
  const threadId = chatAgent.createThread({
    userId,
    agentKind: PENDING_THREAD_KIND,
    model: 'auto'
  });
  db.prepare('UPDATE agent_threads SET title = ? WHERE id = ?').run(PENDING_THREAD_TITLE, threadId);
  return threadId;
}

// ────────────────────────────── Main entry ─────────────────────────────────

async function processUpload(fileId, userId) {
  const file = db.prepare('SELECT * FROM vault_files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) { console.warn(`[vaultProcessor] file ${fileId} not found`); return; }
  if (file.processed_at) return;  // idempotency

  if (!chatAgent.isAgentConfigured()) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run('No agent configured (set OLLAMA_BASE_URL or ANTHROPIC_API_KEY)', fileId);
    return;
  }

  // s3_key column holds the local relative path in the local-vault model
  const localKey = file.s3_key;
  let buffer;
  try {
    buffer = localVault.getFileBuffer(localKey);
  } catch (e) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(`File read failed: ${e.message}`, fileId);
    return;
  }

  // ── Dedup level 1: exact file bytes ─────────────────────────────────────
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  let dupByHash = null;
  try {
    dupByHash = db.prepare(
      `SELECT id, original_filename FROM vault_files
       WHERE user_id = ? AND file_hash = ? AND id != ? AND processed_at IS NOT NULL LIMIT 1`
    ).get(userId, fileHash, fileId);
  } catch (_) { /* file_hash column may not exist on older DBs — non-fatal */ }

  if (dupByHash) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(`Duplicate of already-processed file #${dupByHash.id} (${dupByHash.original_filename})`, fileId);
    console.log(`[vaultProcessor] file ${fileId} is a byte-exact duplicate of #${dupByHash.id} — skipped`);
    return;
  }
  // Store hash so future uploads of the same bytes are caught above.
  try { db.prepare('UPDATE vault_files SET file_hash = ? WHERE id = ?').run(fileHash, fileId); } catch (_) {}

  const extracted = await textExtract.extractText(buffer, file.mime_type, file.original_filename);
  const threadId  = getOrCreatePendingThread(userId);

  // Store threadId on the vault_files row so the status endpoint can surface it.
  try { db.prepare('UPDATE vault_files SET agent_thread_id = ? WHERE id = ?').run(threadId, fileId); } catch (_) {}

  // ── Dedup level 2: extracted text hash ──────────────────────────────────
  if (extracted.text.length >= 50) {
    const textHash = crypto.createHash('sha256').update(extracted.text.trim()).digest('hex');
    const dedupKey = `text:${textHash}`;
    let dupByText = null;
    try {
      dupByText = db.prepare(
        `SELECT vault_file_id FROM vault_dedup_keys WHERE user_id = ? AND dedup_key = ? LIMIT 1`
      ).get(userId, dedupKey);
    } catch (_) { /* table may not exist on older DBs — non-fatal */ }

    if (dupByText) {
      db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
        .run(`Duplicate content of vault file #${dupByText.vault_file_id} — same extracted text`, fileId);
      console.log(`[vaultProcessor] file ${fileId} content matches already-processed #${dupByText.vault_file_id} — skipped`);
      return;
    }
    // Register so future files with identical content are skipped.
    try {
      db.prepare(
        `INSERT OR IGNORE INTO vault_dedup_keys (user_id, dedup_key, vault_file_id) VALUES (?, ?, ?)`
      ).run(userId, dedupKey, fileId);
    } catch (_) {}
  }

  // Short / unsupported — write a status note and stop
  if (extracted.kind === 'unknown' || extracted.text.length < 50) {
    const reason = extracted.kind === 'unknown'
      ? `Unsupported file type for "${file.original_filename}". Supported: PDF, DOCX, XLSX/XLS, CSV, TXT, XML, PNG/JPEG/HEIC and other common image formats.`
      : `Couldn't extract meaningful text from "${file.original_filename}".`;
    db.prepare(`INSERT INTO agent_messages (thread_id, role, content, status) VALUES (?, 'assistant', ?, 'final')`)
      .run(threadId, reason);
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(reason, fileId);
    return;
  }

  // Build the synthetic user message that introduces the document to the agent.
  // The dedup instruction tells the LLM to emit a stable source_ref per transaction
  // so the transactions UNIQUE(user_id, source, source_ref) constraint silently
  // rejects duplicates when the same transaction appears in two different files.
  const userMessage =
    `New vault upload to process.\n` +
    `Filename: ${file.original_filename}\n` +
    `Category: ${file.category}${file.subcategory ? ' / ' + file.subcategory : ''}\n` +
    `Financial Year: ${file.financial_year}\n` +
    `Type: ${extracted.kind.toUpperCase()}\n` +
    (extracted.warnings.length ? `Warnings: ${extracted.warnings.join('; ')}\n` : '') +
    `\nDedup rule: when proposing transactions set source="vault" and ` +
    `source_ref=YYYYMMDD-{amount_in_paise}-{first20chars_of_description_lowercase_no_spaces}. ` +
    `The database will silently ignore any source_ref it has already seen for this user.\n` +
    `\n--- DOCUMENT TEXT ---\n${extracted.text}\n--- END ---`;

  try {
    await chatAgent.streamMessage(
      { threadId, userId, content: userMessage },
      () => {}  // no-op emit — no SSE needed here
    );
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(fileId);

    // Move the file under <userId>/processed/<rest> so the inbox stays tidy.
    try {
      const parts = localKey.split('/');
      let rest = parts.slice(1).join('/');
      if (rest.startsWith('processed/')) rest = rest.slice('processed/'.length);
      const newKey = `${parts[0]}/processed/${rest}`;
      if (newKey !== localKey) {
        localVault.moveFile(localKey, newKey);
        try {
          db.prepare('UPDATE vault_files SET s3_key = ? WHERE id = ?').run(newKey, fileId);
        } catch (dbErr) {
          try { localVault.moveFile(newKey, localKey); } catch (_) {}
          throw dbErr;
        }
      }
    } catch (mvErr) {
      console.error('[vaultProcessor] move-to-processed failed:', mvErr.message);
      // Non-fatal: the row is already marked processed; file stays in place.
    }
  } catch (e) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(`Agent processing failed: ${e.message}`, fileId);
    db.prepare(`INSERT INTO agent_messages (thread_id, role, content, status) VALUES (?, 'assistant', ?, 'final')`)
      .run(threadId, `Couldn't process "${file.original_filename}": ${e.message}`);
  }
}

module.exports = {
  enqueue,
  processUpload,
  PENDING_THREAD_KIND,
  PENDING_THREAD_TITLE
};
