// Background processor for vault uploads. On every successful upload,
// routes/vault.js fires processUpload(fileId, userId) via setImmediate.
// We download the file, extract text, then run chatAgent.streamMessage()
// against the user's "Pending uploads" thread so the agent can propose
// adds via the existing propose_* tool flow.
//
// Per-user serial queue: two rapid uploads from the same user are
// processed sequentially. Cross-user uploads run in parallel.

const db = require('../db/database');
const s3 = require('./s3');
const textExtract = require('./textExtract');
const chatAgent = require('./chatAgent');

const PENDING_THREAD_KIND = 'upload_processor';
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
  const threadId = chatAgent.createThread({
    userId,
    agentKind: PENDING_THREAD_KIND,
    model: 'claude-sonnet-4-5'
  });
  db.prepare('UPDATE agent_threads SET title = ? WHERE id = ?').run(PENDING_THREAD_TITLE, threadId);
  return threadId;
}

// ────────────────────────────── Main entry ─────────────────────────────────

async function processUpload(fileId, userId) {
  const file = db.prepare('SELECT * FROM vault_files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) { console.warn(`[vaultProcessor] file ${fileId} not found`); return; }
  if (file.processed_at) { return; } // idempotency

  if (!chatAgent.isAgentConfigured()) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run('Anthropic API key not configured', fileId);
    return;
  }
  if (!s3.isS3Configured()) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run('S3 not configured', fileId);
    return;
  }

  let buffer;
  try {
    buffer = await s3.getObjectBuffer(process.env.S3_BUCKET, file.s3_key);
  } catch (e) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(`S3 download failed: ${e.message}`, fileId);
    return;
  }

  const extracted = await textExtract.extractText(buffer, file.mime_type, file.original_filename);
  const threadId = getOrCreatePendingThread(userId);

  // Short / unsupported text: write a single message and stop
  if (extracted.kind === 'unknown' || extracted.text.length < 50) {
    const reason = extracted.kind === 'unknown'
      ? `Unsupported file type for "${file.original_filename}". Only PDF and CSV are auto-processed.`
      : `Couldn't extract text from "${file.original_filename}". Looks like it may be a scanned image — try uploading a text-based PDF or a CSV export.`;
    db.prepare(
      `INSERT INTO agent_messages (thread_id, role, content, status) VALUES (?, 'assistant', ?, 'final')`
    ).run(threadId, reason);
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(reason, fileId);
    return;
  }

  // Build the synthetic user message that introduces the document.
  const userMessage =
    `New vault upload to process.\n` +
    `Filename: ${file.original_filename}\n` +
    `Category: ${file.category}${file.subcategory ? ' / ' + file.subcategory : ''}\n` +
    `Financial Year: ${file.financial_year}\n` +
    `Type: ${extracted.kind.toUpperCase()}\n` +
    (extracted.warnings.length ? `Warnings: ${extracted.warnings.join('; ')}\n` : '') +
    `\n--- DOCUMENT TEXT ---\n${extracted.text}\n--- END ---`;

  try {
    await chatAgent.streamMessage(
      { threadId, userId, content: userMessage },
      () => {} // no-op emit; we don't need SSE here
    );
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(fileId);
  } catch (e) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(`Agent processing failed: ${e.message}`, fileId);
    db.prepare(
      `INSERT INTO agent_messages (thread_id, role, content, status) VALUES (?, 'assistant', ?, 'final')`
    ).run(threadId, `Couldn't process "${file.original_filename}": ${e.message}`);
  }
}

module.exports = {
  enqueue,
  processUpload,
  PENDING_THREAD_KIND,
  PENDING_THREAD_TITLE
};
