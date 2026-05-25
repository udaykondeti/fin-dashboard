// Text extraction for vault files. Returns { text, kind, warnings } where:
//   - text:     extracted plain text (truncated to MAX_CHARS)
//   - kind:     'pdf' | 'csv' | 'text' | 'xml' | 'image' | 'docx' | 'xlsx' | 'unknown'
//   - warnings: array of strings (e.g., truncation, parse errors)
//
// Supported formats:
//   PDF  — pdf-parse
//   CSV / plain text — utf8 decode
//   XML  — xml2js (converted to JSON-ish text for LLM)
//   DOCX — mammoth (extracts raw text from Word documents)
//   XLSX / XLS — xlsx (SheetJS, each sheet rendered as CSV)
//   PNG / JPEG / GIF / BMP / TIFF / WEBP — Tesseract OCR
//   HEIC / HEIF — heic-convert → JPEG → Tesseract OCR

const MAX_CHARS = 30000;

// Singleton Tesseract worker — initialized on first use, kept alive for the
// process lifetime to avoid the 1–3 s WASM load on every OCR job.
let _tesseractWorker = null;
async function _getWorker() {
  if (_tesseractWorker) return _tesseractWorker;
  const { createWorker } = require('tesseract.js');
  _tesseractWorker = await createWorker('eng', 1, { logger: () => {} });
  return _tesseractWorker;
}

function _detectKind(mimeType, filename) {
  const m = String(mimeType || '').toLowerCase();
  const n = String(filename  || '').toLowerCase();
  if (m.includes('pdf')   || n.endsWith('.pdf'))                        return 'pdf';
  if (m.includes('csv')   || n.endsWith('.csv') || n.endsWith('.tsv'))  return 'csv';
  if (m.includes('xml')   || n.endsWith('.xml'))                        return 'xml';
  if (n.endsWith('.heic') || n.endsWith('.heif'))                        return 'heic';
  // Word: only .docx is reliably text-extractable; legacy .doc returns unknown.
  if (m.includes('officedocument.wordprocessingml') || n.endsWith('.docx')) return 'docx';
  // Excel: handles both modern .xlsx and legacy .xls via SheetJS.
  if (m.includes('officedocument.spreadsheetml') || m.includes('ms-excel')
      || n.endsWith('.xlsx') || n.endsWith('.xls')) return 'xlsx';
  if (m.startsWith('image/') || /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(n)) return 'image';
  if (m.startsWith('text/') || n.endsWith('.txt'))                      return 'text';
  return 'unknown';
}

async function _ocrBuffer(imgBuffer, warnings) {
  try {
    const worker = await _getWorker();
    const { data: { text } } = await worker.recognize(imgBuffer);
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

  } else if (kind === 'docx') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      text = String(result.value || '');
      if (result.messages && result.messages.length) {
        warnings.push(`DOCX parse notes: ${result.messages.slice(0, 3).map(m => m.message).join('; ')}`);
      }
    } catch (e) {
      warnings.push(`DOCX parse failed: ${e.message}`);
    }

  } else if (kind === 'xlsx') {
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const parts = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        if (csv.trim()) parts.push(`=== Sheet: ${sheetName} ===\n${csv}`);
      }
      text = parts.join('\n\n');
    } catch (e) {
      warnings.push(`Excel parse failed: ${e.message}`);
    }

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
