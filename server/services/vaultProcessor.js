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
//   3. Proposal-level — chatTools buildProposal() flags likely duplicates
//      (existing symbol / fund / payment name) on each propose_* payload.
//      (A source_ref-based transaction dedup would need a propose-transaction
//      tool whose schema carries source/source_ref — not implemented.)

const crypto      = require('crypto');
const jwt         = require('jsonwebtoken');
const db          = require('../db/database');
const localVault  = require('./localVault');
const textExtract = require('./textExtract');
const chatAgent   = require('./chatAgent');
const slack       = require('./slack');

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
  // Use INSERT OR IGNORE as the dedup operation itself. Whichever upload wins
  // the race writes the row and gets to continue; subsequent uploads with the
  // same text see changes=0 and bail out. Prior version did SELECT-then-INSERT,
  // which let two concurrent identical uploads both pass the SELECT and run
  // the agent loop in parallel, duplicating every row.
  if (extracted.text.length >= 50) {
    const textHash = crypto.createHash('sha256').update(extracted.text.trim()).digest('hex');
    const dedupKey = `text:${textHash}`;
    let wonRace = true;
    try {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO vault_dedup_keys (user_id, dedup_key, vault_file_id) VALUES (?, ?, ?)`
      ).run(userId, dedupKey, fileId);
      wonRace = ins.changes > 0;
    } catch (_) { /* table may not exist on older DBs — fall through */ }

    if (!wonRace) {
      const dup = db.prepare(
        `SELECT vault_file_id FROM vault_dedup_keys WHERE user_id = ? AND dedup_key = ? LIMIT 1`
      ).get(userId, dedupKey);
      const refId = dup ? dup.vault_file_id : '?';
      db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
        .run(`Duplicate content of vault file #${refId} — same extracted text`, fileId);
      console.log(`[vaultProcessor] file ${fileId} content matches already-processed #${refId} — skipped`);
      return;
    }
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
  // NOTE: no source_ref dedup instruction here — the propose_* tool schemas
  // (additionalProperties:false) carry no source/source_ref fields, so the
  // model cannot comply with one. Duplicate protection happens at the
  // proposal level (buildProposal's `duplicate` hint) and via the file/text
  // hash checks above.
  const userMessage =
    `New vault upload to process.\n` +
    `Filename: ${file.original_filename}\n` +
    `Category: ${file.category}${file.subcategory ? ' / ' + file.subcategory : ''}\n` +
    `Financial Year: ${file.financial_year}\n` +
    `Type: ${extracted.kind.toUpperCase()}\n` +
    (extracted.warnings.length ? `Warnings: ${extracted.warnings.join('; ')}\n` : '') +
    `\n--- DOCUMENT TEXT ---\n${extracted.text}\n--- END ---`;

  const port    = process.env.PORT || 3001;
  const secret  = process.env.JWT_SECRET || 'dev-secret-insecure';
  const selfTok = jwt.sign({ id: userId, email: '' }, secret, { expiresIn: '10m' });

  let msgContent     = userMessage;
  let appliedCount   = 0;
  let proposalCount  = 0;
  const confirmErrors = [];  // surfaced via processing_error if all confirms fail

  try {
    // Auto-confirm loop: stream → capture proposal → confirm → repeat (up to 10 rounds)
    for (let round = 0; round < 10; round++) {
      let proposal = null;
      await chatAgent.streamMessage(
        { threadId, userId, content: msgContent },
        (ev, data) => { if (ev === 'proposal') proposal = data; }
      );
      if (!proposal) break;  // agent finished with no more proposals
      proposalCount++;

      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/chat/threads/${threadId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${selfTok}` },
          body: JSON.stringify({
            tool_use_id: proposal.tool_use_id,
            message_id:  proposal.message_id,
            decision:    'confirm',
            mutation:    proposal.mutation
          })
        });
        const res = await r.json().catch(() => ({}));
        if (res.applied) {
          appliedCount++;
        } else {
          const why = `HTTP ${r.status}${res.error ? ' — ' + res.error : ''}`;
          confirmErrors.push(why);
          console.warn('[vaultProcessor] confirm returned applied=false:', why);
        }
      } catch (confirmErr) {
        confirmErrors.push(confirmErr.message);
        console.error('[vaultProcessor] auto-confirm error:', confirmErr.message);
      }

      msgContent = null;  // continue thread without inserting another user message
    }

    // Move file BEFORE flipping processed_at so a failed move leaves the row
    // pending — reprocess will pick it up cleanly. The old order set processed_at
    // first; if the rename then failed, the file sat in the original location
    // forever, marked done, with no way to retry.
    let processingError = null;
    if (proposalCount > 0 && appliedCount === 0) {
      processingError = `Agent proposed ${proposalCount} change(s) but none could be applied: ${confirmErrors.slice(0, 3).join('; ')}`;
    } else if (confirmErrors.length > 0) {
      processingError = `${appliedCount} of ${proposalCount} change(s) applied; failures: ${confirmErrors.slice(0, 3).join('; ')}`;
    }

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
      // Surface in processing_error so the file shows a warning pill, but still
      // mark processed_at — the agent work already ran, we don't want to redo it.
      const moveMsg = `Move to processed/ failed: ${mvErr.message}`;
      processingError = processingError ? `${processingError}; ${moveMsg}` : moveMsg;
      console.error('[vaultProcessor] move-to-processed failed:', mvErr.message);
    }

    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(processingError, fileId);
    console.log(`[vaultProcessor] ${file.original_filename}: ${appliedCount}/${proposalCount} applied${processingError ? ' (with errors)' : ''}`);

    const slackMsg = processingError
      ? `⚠️ *${file.original_filename}* — ${appliedCount}/${proposalCount} applied. ${processingError}`
      : (appliedCount > 0
          ? `✅ *${file.original_filename}* — ${appliedCount} entr${appliedCount === 1 ? 'y' : 'ies'} added to your dashboard automatically.`
          : `📄 *${file.original_filename}* processed — no new entries detected.`);
    slack.notify(slackMsg).catch(() => {});
  } catch (e) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(`Agent processing failed: ${e.message}`, fileId);
    db.prepare(`INSERT INTO agent_messages (thread_id, role, content, status) VALUES (?, 'assistant', ?, 'final')`)
      .run(threadId, `Couldn't process "${file.original_filename}": ${e.message}`);
    slack.notify(`⚠️ Failed to process *${file.original_filename}*: ${e.message}`).catch(() => {});
  }
}

module.exports = {
  enqueue,
  processUpload,
  PENDING_THREAD_KIND,
  PENDING_THREAD_TITLE
};
