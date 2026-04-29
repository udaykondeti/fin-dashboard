// Manual smoke harness for server/services/chatTools.js. Run:
//   node scripts/test-chat-tools.js
// Expects a real DB at server/db/data.db with at least one user (id=1) and
// some seeded data; uses the seeded admin from seedData().
const tools = require('../server/services/chatTools');

function eq(label, actual, predicate) {
  const ok = predicate(actual);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log('  got:', JSON.stringify(actual).slice(0, 200)); process.exitCode = 1; }
}

(async () => {
  // TOOLS array is well-formed
  eq('TOOLS array has both read + propose tools',
    tools.TOOLS,
    t => Array.isArray(t) && t.some(x => x.name === 'get_net_worth') && t.some(x => x.name.startsWith('propose_')));

  // get_net_worth returns object with assets/liabilities/net keys
  const nw = await tools.runReadTool('get_net_worth', {}, { userId: 1 });
  eq('get_net_worth returns numeric net_worth',
    nw,
    r => typeof r === 'object' && typeof r.net_worth === 'number');

  // query_holdings({category:'stocks'}) returns an array
  const stocks = await tools.runReadTool('query_holdings', { category: 'stocks' }, { userId: 1 });
  eq('query_holdings stocks returns array',
    stocks,
    r => Array.isArray(r));

  // Unknown tool throws
  let threw = false;
  try { await tools.runReadTool('does_not_exist', {}, { userId: 1 }); }
  catch (e) { threw = true; }
  eq('unknown read tool throws', threw, x => x === true);

  // propose_mark_handloan_status builds a proposal payload
  const prop = tools.buildProposal('propose_mark_handloan_status',
    { loan_id: 1, status: 'settled' }, { userId: 1 });
  eq('propose_mark_handloan_status builds mutation',
    prop,
    r => r && r.mutation && r.mutation.method === 'PUT' && typeof r.summary === 'string');

  console.log('Done.');
})();
