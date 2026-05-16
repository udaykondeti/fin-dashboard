// Text extraction for vault files. Returns { text, kind, warnings } where:
//   - text:     extracted plain text (truncated to MAX_CHARS)
//   - kind:     'pdf' | 'csv' | 'text' | 'xml' | 'image' | 'unknown'
//   - warnings: array of strings (e.g., truncation, parse errors)
//
// Supported formats:
//   PDF  — pdf-parse
//   CSV / plain text — utf8 decode
//   XML  — xml2js (converted to JSON-ish text for LLM)
//   PNG / JPEG / GIF / BMP / TIFF / WEBP — Tesseract OCR
//   HEIC / HEIF — heic-convert → JPEG → Tesseract OCR

const MAX_CHARS = 30000;

function _detectKind(mimeType, filename) {
  const m = String(mimeType || '').toLowerCase();
  const n = String(filename  || '').toLowerCase();
  if (m.includes('pdf')   || n.endsWith('.pdf'))                        return 'pdf';
  if (m.includes('csv')   || n.endsWith('.csv') || n.endsWith('.tsv'))  return 'csv';
  if (m.includes('xml')   || n.endsWith('.xml'))                        return 'xml';
  if (n.endsWith('.heic') || n.endsWith('.heif'))                        return 'heic';
  if (m.startsWith('image/') || /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(n)) return 'image';
  if (m.startsWith('text/') || n.endsWith('.txt'))                      return 'text';
  return 'unknown';
}

async function _ocrBuffer(imgBuffer, warnings) {
  try {
    const { createWorker } = require('tesseract.js');
    const worker = await createWorker('eng', 1, { logger: () => {} });
    const { data: { text } } = await worker.recognize(imgBuffer);
    await worker.terminate();
    return text || '';
  } catch (e) {
    warnings.push(`OCR failed: ${e.message}`);
    return '';
  }
}

async function extractText(buffer, mimeType, filename) {
  const warnings = [];
  const kind = _detectKind(mimeType, filename);
  let text = '';

  if (kind === 'pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const result = await pdfParse(buffer);
      text = String(result.text || '');
    } catch (e) {
      warnings.push(`PDF parse failed: ${e.message}`);
    }

  } else if (kind === 'csv' || kind === 'text') {
    text = buffer.toString('utf8');

  } else if (kind === 'xml') {
    try {
      const xml2js = require('xml2js');
      const parsed = await xml2js.parseStringPromise(buffer.toString('utf8'), { explicitArray: false });
      text = JSON.stringify(parsed, null, 2);
    } catch (e) {
      // Fall back to raw text so the LLM still sees something
      text = buffer.toString('utf8');
      warnings.push(`XML parse warning: ${e.message} — using raw text`);
    }

  } else if (kind === 'heic') {
    try {
      const heicConvert = require('heic-convert');
      const jpegBuf = Buffer.from(
        await heicConvert({ buffer, format: 'JPEG', quality: 0.85 })
      );
      text = await _ocrBuffer(jpegBuf, warnings);
    } catch (e) {
      warnings.push(`HEIC convert failed: ${e.message}`);
      return { text: '', kind: 'unknown', warnings };
    }

  } else if (kind === 'image') {
    text = await _ocrBuffer(buffer, warnings);

  } else {
    return { text: '', kind: 'unknown', warnings: [`Unsupported type: ${mimeType || filename || '?'}`] };
  }

  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    warnings.push(`Text truncated to ${MAX_CHARS} chars`);
  }

  return { text, kind, warnings };
}

module.exports = { extractText, MAX_CHARS };
