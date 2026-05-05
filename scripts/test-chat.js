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

// chatAgent integration smoke (requires ANTHROPIC_API_KEY)
const chatAgent = require('../server/services/chatAgent');

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('SKIP chatAgent — no ANTHROPIC_API_KEY in env');
    return;
  }

  // Create a thread, send a message, expect a final assistant text and an audit row.
  const threadId = chatAgent.createThread({ userId: 1 });
  eq('createThread returns numeric id', threadId, x => Number.isInteger(x) && x > 0);

  const result = await chatAgent.sendMessage({
    threadId, userId: 1,
    content: 'In one short sentence, what number do I get if I add 2 and 3?'
  });
  eq('sendMessage returns final text',
    result,
    r => r && r.status === 'final' && typeof r.text === 'string' && r.text.length > 0);

  // Tool round-trip: ask a question that should trigger get_net_worth
  const result2 = await chatAgent.sendMessage({
    threadId, userId: 1,
    content: 'Use the get_net_worth tool and tell me the net worth number.'
  });
  eq('tool round-trip returns final text',
    result2,
    r => r && r.status === 'final');
})();

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const threadId = chatAgent.createThread({ userId: 1 });
  const events = [];
  await chatAgent.streamMessage(
    { threadId, userId: 1, content: 'Say hi in 3 words.' },
    (event, data) => events.push({ event, data })
  );
  eq('streamMessage emits assistant_start',
    events,
    e => e.some(x => x.event === 'assistant_start'));
  eq('streamMessage emits text deltas',
    events,
    e => e.some(x => x.event === 'text'));
  eq('streamMessage emits done',
    events,
    e => e.some(x => x.event === 'done'));
})();
