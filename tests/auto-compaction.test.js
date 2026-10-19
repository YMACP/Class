import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProtocolClient } from '../src/model-protocol.js';
import { COMPACTION_PROMPT } from '../src/context-compaction.js';
import { contextInputBudget, contextWindowTokens, estimateContextTokens, planProtocolCompaction } from '../src/context-policy.js';
import { decodeState } from '../src/task-state.js';

const tool = { name: 'mutate', description: 'Mock work, with an execution receipt.', parameters: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'], additionalProperties: false } };
const input = { task: 'Keep the original requirements. Complete both A and B; preserve evidence.', acceptanceCriteria: ['A', 'B'], feedbackVersion: 7 };
const systemOf = (protocol, body) => protocol === 'chat' ? body.messages[0].content : body.system ?? body.instructions;
const wireOf = (protocol, body) => protocol === 'responses' ? body.input : body.messages;
function archiveFixture() {
  const records = [];
  return { records, async archiveContext(value) {
    records.push(structuredClone(value));
    const reference = 'owned-archive:' + records.length;
    return { reference, readWith: { name: 'context_read', args: { reference, offset: 0, limit: 16384 } } };
  } };
}
function answer(protocol, value) {
  const text = JSON.stringify(value);
  if (protocol === 'messages') return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
  if (protocol === 'responses') return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
  return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
}
function call(protocol, index, id = `call-${index}`) {
  if (protocol === 'messages') return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: tool.name, input: { index } }] });
  if (protocol === 'responses') return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: id, name: tool.name, arguments: JSON.stringify({ index }) }] });
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: tool.name, arguments: JSON.stringify({ index }) } }] } }] });
}
function assertPaired(protocol, body) {
  const calls = [], results = [];
  for (const item of wireOf(protocol, body)) {
    if (protocol === 'chat') { calls.push(...(item.tool_calls || []).map(call => call.id)); if (item.role === 'tool') results.push(item.tool_call_id); }
    if (protocol === 'responses') { if (item.type === 'function_call') calls.push(item.call_id); if (item.type === 'function_call_output') results.push(item.call_id); }
    if (protocol === 'messages' && Array.isArray(item.content)) for (const block of item.content) { if (block.type === 'tool_use') calls.push(block.id); if (block.type === 'tool_result') results.push(block.tool_use_id); }
  }
  assert.deepEqual(results, calls, 'all retained native calls must have exactly their result');
  assert.equal(new Set(calls).size, calls.length);
}

test('automatic thresholds account for output, tools, explicit capacity and the existing 1M option', () => {
  assert.equal(contextWindowTokens(), 128000);
  assert.equal(contextWindowTokens({ context1M: true }), 1000000);
  assert.equal(contextWindowTokens({ context1M: true, contextWindowTokens: 32000 }), 32000);
  assert.throws(() => contextWindowTokens({ contextWindowTokens: '128000' }));
  assert.ok(contextInputBudget({ outputTokens: 32000 }) < contextInputBudget({ outputTokens: 1000 }));
  const history = [{ role: 'user', content: 'original task' }], groups = [];
  for (let i = 0; i < 12; i++) { history.push({ role: 'assistant', content: 'x'.repeat(1000) }, { role: 'user', content: 'result'.repeat(1000) }); groups.push({ length: 2 }); }
  const plan = planProtocolCompaction(history, groups, 1, { contextWindowTokens: 16000, outputTokens: 1000 });
  assert.ok(plan.count > 0 && plan.count < groups.length);
  assert.equal(plan.end, 1 + plan.count * 2);
  assert.equal(planProtocolCompaction(history, groups, 1, { context1M: true }).count, 0);
  assert.equal(history[0].content, 'original task');
});

for (const protocol of ['chat', 'messages', 'responses']) test(`${protocol}: default compaction summarizes, checkpoints and resumes without replaying old work`, async t => {
  const config = { protocol, model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512, contextWindowTokens: 16000 };
  const client = new ModelProtocolClient(config, 'test-key'), recoveryState = {}, events = [], effects = [], archive = archiveFixture();
  let summaries = 0, requests = 0, snapshot, interrupted = false, latestInput, firstRemoved;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    if (systemOf(protocol, body).startsWith(COMPACTION_PROMPT)) {
      summaries++; assert.equal(body.tools, undefined); assert.equal(body.thinking, undefined); assert.equal(body.reasoning, undefined);
      assert.match(JSON.stringify(body), /evidence:0/);
      return answer(protocol, { summary: 'A is recorded at evidence:0; B remains pending. Preserve all original constraints.' });
    }
    requests++; assertPaired(protocol, body);
    latestInput = JSON.parse(wireOf(protocol, body).find(item => item.role === 'user' && typeof item.content === 'string').content);
    assert.equal(latestInput.task, input.task); assert.deepEqual(latestInput.acceptanceCriteria, input.acceptanceCriteria);
    if (interrupted) {
      assert.match(latestInput.compactedConversation.summary, /B remains pending/);
      if (firstRemoved === undefined) { firstRemoved = true; return call(protocol, 0, 'fresh-id-for-old-write'); }
      return answer(protocol, { done: true });
    }
    assert.ok(requests < 30, 'compaction must run before unbounded growth');
    return call(protocol, requests - 1);
  });
  const executeTool = (_name, { index }) => { effects.push(index); return { success: true, output: 'result-' + index + 'x'.repeat(7000), evidenceRef: 'evidence:' + index }; };
  await assert.rejects(client.json('Original system', input, undefined, { recoveryState, tools: [tool], executeTool, archiveContext: archive.archiveContext, onConversation: event => events.push(event), persistSession(reason) {
    if (reason === 'context_compacted') { snapshot = JSON.parse(JSON.stringify(client.exportSession(recoveryState))); interrupted = true; throw Object.assign(Error('test interruption after durable checkpoint'), { fatalStorage: true }); }
  } }), /test interruption/);
  assert.equal(summaries, 1);
  const before = [...effects], state = decodeState(snapshot.state);
  assert.equal(state.compactionCount, 1); assert.ok(state.historyGroups.length >= 1);
  assert.match(state.contextSummary.summary, /evidence:0/);
  assert.equal(state.contextSummary.readWith.name, 'context_read');
  assert.ok(archive.records[0].messages.length > 0);
  assert.equal(archive.records[0].input.task, input.task);
  assert.ok(events.some(event => event.role === 'tool' && event.content.includes('evidence:0')), 'original outputs were archived before compaction');
  assert.ok(!JSON.stringify(snapshot).includes('test-key'));
  const resumed = new ModelProtocolClient(config, 'replacement-key');
  assert.deepEqual(await resumed.json('Original system', input, undefined, { recoveryState: resumed.importSession(snapshot), tools: [tool], executeTool }), { done: true });
  assert.deepEqual(effects, before, 'a compacted side effect must not run again under a fresh provider call ID');
});

test('unavailable summarizer preserves every original group and isolates an oversized request', async t => {
  const client = new ModelProtocolClient({ protocol: 'chat', model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512, contextWindowTokens: 12000 }, 'key');
  const recoveryState = {}, archive = archiveFixture(); let calls = 0, summaries = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    if (systemOf('chat', body).startsWith(COMPACTION_PROMPT)) { summaries++; assert.equal(body.tools, undefined); return Response.json({ error: { code: 'unsupported' } }, { status: 400 }); }
    assertPaired('chat', body);
    assert.ok(calls < 20); return call('chat', calls++);
  });
  await assert.rejects(client.json('fixture', input, undefined, { recoveryState, tools: [tool], archiveContext: archive.archiveContext,
    executeTool: (_name, { index }) => ({ output: 'x'.repeat(8000), outputRef: 'original:' + index }) }), error => error.memberRecoverable && error.reasonCode === 'MODEL_CONTEXT_EXCEEDED');
  assert.ok(summaries >= 1); assert.equal(archive.records.length, 0);
  const state = decodeState(client.exportSession(recoveryState).state);
  assert.equal(state.historyGroups.length, calls); assert.equal(state.contextSummary, undefined); assert.equal(state.compactionCount, undefined);
  assert.match(JSON.stringify(state.history), /original:0/);
});

test('cancelling a summary preserves the unmodified full working history', async t => {
  const client = new ModelProtocolClient({ protocol: 'chat', model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512, contextWindowTokens: 12000 }, 'key');
  const recoveryState = {}, controller = new AbortController(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    if (systemOf('chat', body).startsWith(COMPACTION_PROMPT)) { controller.abort(Error('cancel compaction')); throw controller.signal.reason; }
    assert.ok(calls < 20); return call('chat', calls++);
  });
  await assert.rejects(client.json('fixture', input, controller.signal, { recoveryState, tools: [tool], archiveContext: archiveFixture().archiveContext, executeTool: () => ({ output: 'x'.repeat(8000) }) }), /cancel compaction/);
  const state = decodeState(client.exportSession(recoveryState).state);
  assert.equal(state.compactionCount, undefined); assert.equal(state.historyGroups.length, calls); assert.equal(state.contextSummary, undefined);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
for (const protocol of ['chat', 'messages', 'responses']) test(`${protocol}: a pause during summarization blocks the next request and refreshes feedback and tools`, async t => {
  const client = new ModelProtocolClient({ protocol, model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512, contextWindowTokens: 16000 }, 'key');
  const entered = deferred(), releaseSummary = deferred(), releasePause = deferred(), archive = archiveFixture();
  const extra = { name: 'newly_available', description: 'Added while summarizing', parameters: { type: 'object', properties: {}, additionalProperties: false } };
  let paused = false, version = 7, blackboard = [{ status: 'accepted', content: 'Earlier fact' }], requests = 0, summarized = false, latest;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    if (systemOf(protocol, body).startsWith(COMPACTION_PROMPT)) {
      entered.resolve(); await releaseSummary.promise;
      return answer(protocol, { summary: 'Completed work is archived; latest teacher feedback remains authoritative.' });
    }
    requests++; assertPaired(protocol, body);
    if (summarized) {
      latest = JSON.parse(wireOf(protocol, body).find(item => item.role === 'user' && typeof item.content === 'string').content);
      assert.ok(JSON.stringify(body.tools).includes('newly_available'));
      return answer(protocol, { done: true });
    }
    assert.ok(requests < 20); return call(protocol, requests - 1);
  });
  const completion = client.json('fixture', { ...input, blackboard }, undefined, { tools: [tool], readTools: () => version === 7 ? [tool] : [tool, extra],
    readAcceptedTools: () => version === 7 ? [tool] : [tool, extra], readFeedbackVersion: () => version, readBlackboard: () => blackboard,
    async checkpoint() { if (paused) await releasePause.promise; }, archiveContext: archive.archiveContext,
    onContextCompaction() { summarized = true; }, executeTool: (_name, { index }) => ({ output: 'x'.repeat(7000), evidenceRef: 'evidence:' + index }) });
  await entered.promise; const before = requests;
  paused = true; version = 8; blackboard = [{ type: 'teacher_feedback', feedbackVersion: 8, content: 'New condition; verify B again.' }];
  releaseSummary.resolve(); await turn(); await turn();
  assert.equal(requests, before, 'a paused task cannot dispatch another model request after its summary');
  paused = false; releasePause.resolve();
  assert.deepEqual(await completion, { done: true });
  assert.equal(latest.feedbackVersion, 8); assert.deepEqual(latest.blackboard, blackboard);
  assert.equal(latest.task, input.task); assert.equal(requests, before + 1);
});

for (const protocol of ['chat', 'messages', 'responses']) test(`${protocol}: oversized first input is archived and summarized without changing pinned requirements`, async t => {
  const config = { protocol, model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512, contextWindowTokens: 12000 };
  const client = new ModelProtocolClient(config, 'key'), archive = archiveFixture(); let summaries = 0, main = 0, finalInput;
  const original = { ...input, constraints: ['Only the owned fixture'], resumeWarnings: [{ callId: 'old-write', reason: 'inspect first' }],
    blackboard: [{ id: 'fact', status: 'accepted', content: 'Keep accepted fact exactly.' }],
    feedbackHistory: [{ feedbackVersion: 6, report: 'old'.repeat(4000) }, { feedbackVersion: 7, report: 'Verify pending B.' }],
    history: Array.from({ length: 30 }, (_, index) => ({ content: `entry-${index}:` + 'historical '.repeat(900) })) };
  const before = structuredClone(original);
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    if (systemOf(protocol, body).startsWith(COMPACTION_PROMPT)) { summaries++; return answer(protocol, { summary: 'Earlier work is available in the archived input. B still requires verification.' }); }
    main++; assertPaired(protocol, body);
    assert.ok(estimateContextTokens(body) <= contextInputBudget({ contextWindowTokens: 12000, outputTokens: 512 }));
    finalInput = JSON.parse(wireOf(protocol, body).find(item => item.role === 'user' && typeof item.content === 'string').content);
    return answer(protocol, { done: true });
  });
  assert.deepEqual(await client.json('fixture', original, undefined, { archiveContext: archive.archiveContext }), { done: true });
  assert.deepEqual(original, before); assert.equal(main, 1); assert.equal(summaries, 1); assert.equal(archive.records.length, 1);
  for (const key of ['task', 'constraints', 'acceptanceCriteria', 'feedbackVersion', 'blackboard', 'resumeWarnings']) assert.deepEqual(finalInput[key], before[key], key);
  assert.deepEqual(finalInput.feedbackHistory.at(-1), before.feedbackHistory.at(-1));
  assert.deepEqual(archive.records[0].input.history, original.history);
  assert.equal(finalInput.compactedConversation.readWith.args.reference, 'owned-archive:1');
});

test('without a readable archive no oversized prefix is discarded and no model is called', async t => {
  const config = { protocol: 'chat', model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512, contextWindowTokens: 8000 };
  const client = new ModelProtocolClient(config, 'key'), recoveryState = {}, original = { ...input, history: [{ content: 'large'.repeat(20000) }] };
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw Error('Unexpected model call'); });
  await assert.rejects(client.json('fixture', original, undefined, { recoveryState }), error => error.memberRecoverable && error.reasonCode === 'MODEL_CONTEXT_EXCEEDED');
  assert.equal(requests, 0); assert.equal(decodeState(client.exportSession(recoveryState).state).user.content, JSON.stringify(original));
});

test('failed archive commit leaves full native groups and receipts intact', async t => {
  const client = new ModelProtocolClient({ protocol: 'messages', model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512, contextWindowTokens: 12000 }, 'key');
  const recoveryState = {}; let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    if (systemOf('messages', body).startsWith(COMPACTION_PROMPT)) return answer('messages', { summary: 'The original work must remain retrievable.' });
    return call('messages', calls++);
  });
  await assert.rejects(client.json('fixture', input, undefined, { recoveryState, tools: [tool],
    archiveContext() { throw Error('owned archive unavailable'); }, executeTool: () => ({ output: 'x'.repeat(8000) }) }), error => error.fatalStorage && error.code === 'STORAGE_ERROR');
  const state = decodeState(client.exportSession(recoveryState).state);
  assert.equal(state.historyGroups.length, calls); assert.equal(state.completed.size, calls); assert.equal(state.contextSummary, undefined);
  assertPaired('messages', { messages: state.history });
});

for (const protocol of ['chat', 'messages', 'responses']) test(`${protocol}: a provider context-limit response compacts paired old rounds and retries without repeating tools`, async t => {
  const client = new ModelProtocolClient({ protocol, model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512 }, 'key');
  const archive = archiveFixture(), effects = []; let calls = 0, rejected = false, summaries = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    if (systemOf(protocol, body).startsWith(COMPACTION_PROMPT)) { summaries++; return answer(protocol, { summary: 'Four completed writes; verify their archived results, do not rerun them.' }); }
    assertPaired(protocol, body);
    if (calls < 4) return call(protocol, calls++);
    if (!rejected) { rejected = true; return Response.json({ error: { code: 'context_length_exceeded' } }, { status: 400 }); }
    const current = JSON.parse(wireOf(protocol, body).find(item => item.role === 'user' && typeof item.content === 'string').content);
    assert.equal(current.compactedConversation.readWith.name, 'context_read');
    return answer(protocol, { done: true });
  });
  assert.deepEqual(await client.json('fixture', input, undefined, { tools: [tool], archiveContext: archive.archiveContext,
    executeTool: (_name, { index }) => { effects.push(index); return { output: 'payload'.repeat(300), evidenceRef: 'source:' + index }; } }), { done: true });
  assert.deepEqual(effects, [0, 1, 2, 3]); assert.equal(summaries, 1); assert.equal(archive.records.length, 1);
});

test('1M capability rejection is never silently reduced into a smaller working window', async t => {
  const client = new ModelProtocolClient({ protocol: 'chat', model: 'mock', baseUrl: 'https://model.invalid/v1', context1M: true }, 'key');
  let requests = 0; const archive = archiveFixture();
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ error: { code: 'context_1m_unsupported' } }, { status: 400 }); });
  await assert.rejects(client.json('fixture', input, undefined, { archiveContext: archive.archiveContext }), error => error.reasonCode === 'MODEL_CONTEXT_1M_UNSUPPORTED');
  assert.equal(requests, 1); assert.equal(archive.records.length, 0);
});

test('a pinned task that cannot fit is preserved instead of being summarized away', async t => {
  const client = new ModelProtocolClient({ protocol: 'chat', model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512, contextWindowTokens: 8000 }, 'key');
  const original = { ...input, task: 'Mandatory requirement:'.repeat(4000), history: [{ content: 'optional'.repeat(6000) }] }, recoveryState = {}, archive = archiveFixture();
  let main = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.ok(systemOf('chat', body).startsWith(COMPACTION_PROMPT), 'the impossible main request must not be sent');
    return answer('chat', { summary: 'The original requirements must remain complete.' });
  });
  await assert.rejects(client.json('fixture', original, undefined, { recoveryState, archiveContext: archive.archiveContext }), error => error.memberRecoverable && error.reasonCode === 'MODEL_CONTEXT_EXCEEDED');
  assert.equal(main, 0); assert.equal(archive.records.length, 0);
  assert.equal(decodeState(client.exportSession(recoveryState).state).user.content, JSON.stringify(original));
});

test('an interruption after archiving but before commit leaves all original groups and is safely retryable', async t => {
  const config = { protocol: 'responses', model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512, contextWindowTokens: 12000 };
  const client = new ModelProtocolClient(config, 'key'), recoveryState = {}, controller = new AbortController();
  const archive = archiveFixture(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    if (systemOf('responses', body).startsWith(COMPACTION_PROMPT)) return answer('responses', { summary: 'Retain pending work and the old receipt identities.' });
    return call('responses', calls++);
  });
  await assert.rejects(client.json('fixture', input, controller.signal, { recoveryState, tools: [tool],
    async archiveContext(value) { const result = await archive.archiveContext(value); controller.abort(Error('stop after archive')); return result; },
    executeTool: () => ({ output: 'x'.repeat(8000) }) }), /stop after archive/);
  const state = decodeState(client.exportSession(recoveryState).state);
  assert.equal(archive.records.length, 1); assert.equal(state.compactionCount, undefined); assert.equal(state.historyGroups.length, calls);
  assertPaired('responses', { input: state.history });
});

for (const protocol of ['chat', 'messages', 'responses']) test(`${protocol}: resumed input reuses unchanged archived fields despite new summaries and refreshes changed sources`, async t => {
  const config = { protocol, model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512, contextWindowTokens: 12000 };
  const client = new ModelProtocolClient(config, 'key'), recoveryState = {}, archive = archiveFixture();
  const oldRecords = label => [{ content: label + ': ' + 'original history '.repeat(2200) }];
  const original = { ...input, histories: { student: oldRecords('classroom') }, toolHistory: oldRecords('teacher'),
    reviewSnapshot: { reviewId: 'review-1', students: [{ studentId: 'student', history: oldRecords('student'), tools: oldRecords('tools') }] },
    feedbackHistory: [{ feedbackVersion: 7, report: 'Latest original feedback.' }],
    blackboard: [{ id: 'accepted', status: 'accepted', content: 'Original accepted evidence.' }] };
  let summaries = 0, snapshot, projection, sent;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    if (systemOf(protocol, body).startsWith(COMPACTION_PROMPT)) { summaries++; return answer(protocol, { summary: 'Archived progress remains available; the current requirements still apply.' }); }
    sent = JSON.parse(wireOf(protocol, body).find(item => item.role === 'user' && typeof item.content === 'string').content);
    assert.ok(estimateContextTokens(body) <= contextInputBudget({ contextWindowTokens: 12000, outputTokens: 512 }));
    return answer(protocol, { done: true });
  });
  await assert.rejects(client.json('teacher fixture', original, undefined, { recoveryState, archiveContext: archive.archiveContext,
    onContextCompaction(event) { projection = event.input; },
    persistSession(reason) { if (reason === 'context_compacted') { snapshot = JSON.parse(JSON.stringify(client.exportSession(recoveryState))); throw Object.assign(Error('checkpoint saved'), { fatalStorage: true }); } }
  }), /checkpoint saved/);
  assert.equal(summaries, 1); assert.equal(archive.records.length, 1);
  const saved = decodeState(snapshot.state);
  assert.ok(saved.compactedInputFields.some(field => field.path === '/histories'));
  assert.ok(saved.compactedInputFields.some(field => field.path === '/reviewSnapshot/students/0/history'));
  assert.ok(saved.compactedInputFields.every(field => !Object.hasOwn(field, 'value')), 'only source fingerprints, never full raw duplicates');
  const changed = { ...structuredClone(original), toolHistory: [], compactedConversation: projection.compactedConversation };
  const resumed = new ModelProtocolClient(config, 'key'), restored = resumed.importSession(snapshot);
  assert.deepEqual(await resumed.json('teacher fixture', changed, undefined, { recoveryState: restored, archiveContext: archive.archiveContext }), { done: true });
  assert.equal(summaries, 1); assert.equal(archive.records.length, 1, 'unchanged archived teacher fields must not be summarized or archived again');
  assert.equal(sent.histories.contextCompacted, true);
  assert.equal(sent.reviewSnapshot.students[0].history.contextCompacted, true);
  assert.deepEqual(sent.toolHistory, []);

  changed.reviewSnapshot.students[0].history = oldRecords('actually-new-student-record');
  changed.feedbackVersion = 8;
  changed.feedbackHistory = [{ feedbackVersion: 8, report: 'New authoritative feedback.' }];
  changed.blackboard = [{ id: 'accepted-new', status: 'accepted', content: 'New accepted evidence.' }];
  assert.deepEqual(await resumed.json('teacher fixture', changed, undefined, { recoveryState: restored, archiveContext: archive.archiveContext }), { done: true });
  assert.equal(summaries, 2); assert.equal(archive.records.length, 2);
  assert.match(JSON.stringify(archive.records[1].input.reviewSnapshot.students[0].history), /actually-new-student-record/);
  assert.equal(archive.records[1].input.histories.contextCompacted, true, 'unchanged large input stays projected in subsequent archives');
  assert.equal(archive.records[1].input.compactedConversation.readWith.args.reference, 'owned-archive:1', 'latest archive chains to prior originals');
  assert.deepEqual(sent.feedbackHistory, changed.feedbackHistory); assert.deepEqual(sent.blackboard, changed.blackboard);
  assert.equal(sent.feedbackVersion, 8); assert.equal(sent.compactedConversation.readWith.args.reference, 'owned-archive:2');
});

test('feedback previously archived as old is restored in full if it becomes the latest feedback on resume', async t => {
  const config = { protocol: 'chat', model: 'mock', baseUrl: 'https://model.invalid/v1', maxTokens: 512, contextWindowTokens: 12000 };
  const client = new ModelProtocolClient(config, 'key'), recoveryState = {}, archive = archiveFixture();
  const old = { feedbackVersion: 6, report: 'Old feedback that later becomes current. '.repeat(1800) };
  const original = { ...input, feedbackHistory: [old, { feedbackVersion: 7, report: 'Latest feedback.' }] };
  let snapshot, summary, mainRequests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    if (systemOf('chat', body).startsWith(COMPACTION_PROMPT)) return answer('chat', { summary: 'Older feedback is archived; current feedback remains complete.' });
    mainRequests++; return answer('chat', { done: true });
  });
  await assert.rejects(client.json('fixture', original, undefined, { recoveryState, archiveContext: archive.archiveContext,
    onContextCompaction(event) { summary = event.summary; },
    persistSession(reason) { if (reason === 'context_compacted') { snapshot = JSON.parse(JSON.stringify(client.exportSession(recoveryState))); throw Object.assign(Error('saved'), { fatalStorage: true }); } }
  }), /saved/);
  assert.equal(decodeState(snapshot.state).compactedInput.feedbackHistory[0].contextCompacted, true);
  const resumed = new ModelProtocolClient(config, 'key'), restored = resumed.importSession(snapshot);
  await assert.rejects(resumed.json('fixture', { ...original, feedbackHistory: [old], compactedConversation: summary }, undefined,
    { recoveryState: restored, archiveContext: archive.archiveContext }), error => error.memberRecoverable && error.reasonCode === 'MODEL_CONTEXT_EXCEEDED');
  assert.equal(mainRequests, 0);
  const finalInput = JSON.parse(decodeState(resumed.exportSession(restored).state).user.content);
  assert.deepEqual(finalInput.feedbackHistory, [old], 'latest feedback remains complete even when it cannot fit');
});
