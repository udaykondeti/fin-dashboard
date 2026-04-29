// Smoke test for server/services/vaultProcessor.js
//   node scripts/test-vault-processor.js
const vp = require('../server/services/vaultProcessor');

function eq(label, actual, predicate) {
  const ok = predicate(actual);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log('  got:', JSON.stringify(actual).slice(0, 200)); process.exitCode = 1; }
}

(async () => {
  // The exports must include enqueue + processUpload
  eq('exports enqueue', typeof vp.enqueue, t => t === 'function');
  eq('exports processUpload', typeof vp.processUpload, t => t === 'function');

  // enqueue serialises per user. Run two tasks; second must not start
  // until first finishes.
  const order = [];
  const p1 = vp.enqueue(1, () => new Promise(r => setTimeout(() => { order.push('a'); r(); }, 80)));
  const p2 = vp.enqueue(1, () => new Promise(r => setTimeout(() => { order.push('b'); r(); }, 10)));
  await Promise.all([p1, p2]);
  eq('per-user queue is serial', order, o => o.join(',') === 'a,b');

  // Different users run in parallel (fast user finishes first)
  const order2 = [];
  const pa = vp.enqueue(1, () => new Promise(r => setTimeout(() => { order2.push('slow'); r(); }, 60)));
  const pb = vp.enqueue(2, () => new Promise(r => setTimeout(() => { order2.push('fast'); r(); }, 10)));
  await Promise.all([pa, pb]);
  eq('cross-user queues are independent', order2, o => o[0] === 'fast');

  console.log('Done.');
})();
