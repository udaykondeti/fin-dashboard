// Local filesystem vault — replaces S3 for file storage.
// Files live under VAULT_PATH (default ./data/vault) using the same
// {userId}/{profilePrefix}{FY}/{category}/{subcategory}/{timestamp}-{filename}
// key structure as the previous S3 implementation so DB records stay compatible.

const fs   = require('fs');
const path = require('path');

const VAULT_ROOT = process.env.VAULT_PATH || path.join(__dirname, '../../data/vault');

/** Always available — no credentials required. */
function isVaultConfigured() { return true; }

function getVaultRoot() { return VAULT_ROOT; }

function _ensureDir(dirPath) { fs.mkdirSync(dirPath, { recursive: true }); }

/**
 * Returns the Indian financial year folder string for a given date.
 * Apr 2025 – Mar 2026 → "FY2025-26"
 */
function getFYFolder(date) {
  const d = date instanceof Date ? date : new Date();
  const year  = d.getFullYear();
  const month = d.getMonth() + 1; // 1-based
  if (month >= 4) return `FY${year}-${String(year + 1).slice(2)}`;
  return `FY${year - 1}-${String(year).slice(2)}`;
}

/**
 * Normalises category/subcategory into a path segment.
 * getCategoryPath('stocks', 'nse-bse') → 'stocks/nse-bse/'
 */
function getCategoryPath(category, subcategory) {
  const cat = (category || 'receipts').replace(/[^a-zA-Z0-9-_]/g, '-');
  const sub = subcategory ? subcategory.replace(/[^a-zA-Z0-9-_]/g, '-') : null;
  return sub ? `${cat}/${sub}/` : `${cat}/`;
}

/**
 * Saves a buffer to the local vault at the given relative key.
 * Creates parent directories as needed. Returns the key.
 */
function saveFile(buffer, localKey) {
  const fullPath = getFilePath(localKey);
  _ensureDir(path.dirname(fullPath));
  fs.writeFileSync(fullPath, buffer);
  return localKey;
}

/** Asserts that a resolved path is inside VAULT_ROOT. Throws on traversal attempt. */
function _assertContained(resolvedPath) {
  const root = path.resolve(VAULT_ROOT) + path.sep;
  if (!resolvedPath.startsWith(root)) {
    throw new Error(`Path traversal blocked: ${resolvedPath}`);
  }
}

/** Returns the absolute path for a given relative key. Throws if key escapes vault root. */
function getFilePath(localKey) {
  const resolved = path.resolve(path.join(VAULT_ROOT, localKey));
  _assertContained(resolved);
  return resolved;
}

/** Reads a vault file and returns a Buffer. */
function getFileBuffer(localKey) {
  return fs.readFileSync(getFilePath(localKey));
}

/** Deletes a vault file. Silently ignores missing files. */
function deleteFile(localKey) {
  const fullPath = getFilePath(localKey);
  try { fs.unlinkSync(fullPath); } catch (_) {}
}

/**
 * Moves a vault file from one relative key to another. Creates the parent
 * directory of the destination as needed. Returns the new key. If the source
 * doesn't exist this is a no-op — callers may have already moved/deleted it.
 */
function moveFile(fromKey, toKey) {
  const src = getFilePath(fromKey);
  const dst = getFilePath(toKey);
  if (!fs.existsSync(src)) return toKey;
  _ensureDir(path.dirname(dst));
  fs.renameSync(src, dst);
  return toKey;
}

module.exports = {
  isVaultConfigured,
  getVaultRoot,
  getFYFolder,
  getCategoryPath,
  saveFile,
  getFilePath,
  getFileBuffer,
  deleteFile,
  moveFile
};
