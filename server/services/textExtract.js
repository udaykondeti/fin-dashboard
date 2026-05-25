// Text extraction for vault files. Returns { text, kind, warnings } where:
//   - text: extracted plain text (truncated to MAX_CHARS)
//   - kind: 'pdf' | 'csv' | 'text' | 'unknown'
//   - warnings: array of strings (e.g., truncation, parse errors)
const MAX_CHARS = 30000;

async function extractText(buffer, mimeType, filename) {
  const warnings = [];
  const lcName = String(filename || '').toLowerCase();
  const lcMime = String(mimeType || '').toLowerCase();

  // Detect kind by mime first, then filename extension as fallback.
  let kind = 'unknown';
  if (lcMime.includes('pdf') || lcName.endsWith('.pdf')) kind = 'pdf';
  else if (lcMime.includes('csv') || lcName.endsWith('.csv') || lcName.endsWith('.tsv')) kind = 'csv';
  else if (lcMime.startsWith('text/') || lcName.endsWith('.txt')) kind = 'text';

  let text = '';
  if (kind === 'pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const result = await pdfParse(buffer);
      text = String(result.text || '');
    } catch (e) {
      warnings.push(`PDF parse failed: ${e.message}`);
      text = '';
    }
  } else if (kind === 'csv' || kind === 'text') {
    text = buffer.toString('utf8');
  } else {
    return { text: '', kind: 'unknown', warnings: ['Unsupported mime type: ' + (mimeType || '?')] };
  }

  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    warnings.push(`Text truncated to ${MAX_CHARS} chars`);
  }

  return { text, kind, warnings };
}

module.exports = { extractText, MAX_CHARS };
