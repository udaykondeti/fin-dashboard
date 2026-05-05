// Smoke test for server/services/textExtract.js
//   node scripts/test-text-extract.js
const fs = require('fs');
const extract = require('../server/services/textExtract');

function eq(label, actual, predicate) {
  const ok = predicate(actual);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log('  got:', JSON.stringify(actual).slice(0, 200)); process.exitCode = 1; }
}

(async () => {
  // Plain text passthrough
  const r1 = await extract.extractText(Buffer.from('hello world\nline two'), 'text/plain', 'note.txt');
  eq('plain text passthrough', r1, r => r.kind === 'text' && r.text === 'hello world\nline two');

  // CSV is treated as text
  const csv = 'Symbol,Quantity\nRELIANCE,10\nINFY,25';
  const r2 = await extract.extractText(Buffer.from(csv), 'text/csv', 'holdings.csv');
  eq('csv extraction returns text', r2, r => r.kind === 'csv' && r.text.includes('RELIANCE'));

  // Truncation
  const big = 'x'.repeat(50000);
  const r3 = await extract.extractText(Buffer.from(big), 'text/plain', 'big.txt');
  eq('truncation to 30000 chars', r3, r => r.text.length <= 30000 && r.warnings.some(w => /truncat/i.test(w)));

  // Unknown mime returns kind='unknown'
  const r4 = await extract.extractText(Buffer.from([0xff, 0xfe]), 'application/octet-stream', 'binary.bin');
  eq('unknown mime returns kind=unknown', r4, r => r.kind === 'unknown' && r.text === '');

  console.log('Done.');
})();
