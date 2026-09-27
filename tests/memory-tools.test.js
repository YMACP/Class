import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolManager } from '../src/tools.js';
import { toolDefinitions } from '../src/tool-contract.js';
import { memoryToolDefinitions, isMemoryTool } from '../src/memory-tools.js';
import { ModelProtocolClient } from '../src/model-protocol.js';
import { createStudent, createTeacher } from '../src/agents.js';

function managerFor(t, memory, extra = {}) {
  const manager = new ToolManager({ allowShell: false, memory, ...extra });
  t.after(() => manager.stopAll());
  return manager;
}
const provider = { protocol: 'messages', baseUrl: 'https://class-memory-test.invalid/v1', model: 'isolated-test', apiKey: 'test-provider-secret-value', timeoutMs: null };
function response(protocol, content, calls = [], hidden = false) {
  if (protocol === 'messages') return Response.json({ stop_reason: calls.length ? 'tool_use' : 'end_turn', content: [
    ...(hidden ? [{ type: 'thinking', thinking: 'HIDDEN-REASONING', signature: 'private-signature' }] : []),
    { type: 'text', text: content }, ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })),
  ] });
  if (protocol === 'responses') return Response.json({ status: 'completed', output: [
    ...(hidden ? [{ type: 'reasoning', encrypted_content: 'HIDDEN-REASONING' }] : []),
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] },
    ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) })),
  ] });
  return Response.json({ choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content,
    ...(hidden ? { reasoning_content: 'HIDDEN-REASONING' } : {}),
    ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}),
  } }] });
}

test('memory tools are opt-in, member-bound, bounded and require assessment after automatic saving', async t => {
  const absent = managerFor(t);
  assert.equal(toolDefinitions(absent).some(tool => isMemoryTool(tool.name)), false);
  const calls = [], memory = { async tool(name, args, context) { calls.push({ name, args, context }); return { id: 'memory-1', status: 'active', content: args.content, sourceRefs: args.sourceRefs }; } };
  const manager = managerFor(t, memory), registered = toolDefinitions(manager);
  for (const tool of memoryToolDefinitions) assert.ok(registered.some(entry => entry.name === tool.name));
  const result = await manager.execute('alice', { name: 'memory_propose', args: { content: 'A possible reusable observation.', kind: 'agent', sourceRefs: ['journal:test:1'] } });
  assert.equal(calls.length, 1); assert.equal(calls[0].context.studentId, 'alice'); assert.ok(calls[0].context.signal instanceof AbortSignal);
  const data = JSON.parse(result.output);
  assert.equal(data.status, 'active'); assert.equal(data.candidateOnly, undefined); assert.equal(data.currentEvidence, false);
  assert.equal(data.requiresAssessment, true); assert.ok(Number.isFinite(Date.parse(data.retrievedAt))); assert.deepEqual(data.sourceRefs, ['journal:test:1']);
  assert.match(data.assessmentGuide, /dates, applicability, original sources and current evidence/);
  assert.equal(manager.paused, false); assert.equal(manager.stopped, false);
  manager.maxOutputBytes = 80;
  const small = await manager.execute('alice', { name: 'memory_propose', args: { content: '内容'.repeat(2000), kind: 'agent' } });
  assert.ok(Buffer.byteLength(small.output) <= 80); JSON.parse(small.output); assert.equal(small.truncated, true);
});

test('memory_assess reports a member-scoped fallible judgment and rejects spoofed or invalid arguments', async t => {
  const calls = [], manager = managerFor(t, { tool(name, args, context) { calls.push({ name, args, context }); return { data: { id: args.id, status: 'active', sourceRefs: ['source:original'], assessment: { verdict: args.verdict, reason: args.reason } } }; } });
  const args = { id: 'memory-1', verdict: 'uncertain', reason: 'The source is old and the current configuration has not yet been checked.', sourceRefs: ['source:original'] };
  for (const invalid of [{ ...args, verdict: 'approved' }, { ...args, reason: '' }, { ...args, projectId: 'other' }, { ...args, sourceRefs: [3] }]) {
    await assert.rejects(manager.execute('alice', { name: 'memory_assess', args: invalid }), /tool argument/i);
  }
  assert.equal(calls.length, 0);
  const result = JSON.parse((await manager.execute('alice', { name: 'memory_assess', args })).output);
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'memory_assess'); assert.equal(calls[0].context.studentId, 'alice'); assert.deepEqual(calls[0].args, args);
  assert.equal(result.data.status, 'active'); assert.equal(result.data.assessment.verdict, 'uncertain'); assert.equal(result.requiresAssessment, false); assert.equal(result.currentEvidence, false); assert.equal(result.authority, 'reference_only');
});

test('memory arguments cannot override scope, approval or another member and invalid proposals never dispatch', async t => {
  let dispatched = 0;
  const manager = managerFor(t, { tool() { dispatched++; return {}; } });
  for (const key of ['projectId', 'scope', 'agentId', 'roleId', 'userId', 'studentId', 'approved', 'status', 'admin', 'profileWide']) {
    await assert.rejects(manager.execute('alice', { name: 'memory_propose', args: { content: 'x', kind: 'agent', [key]: 'other' } }), /Unknown memory tool argument/);
  }
  for (const args of [{}, { content: 'x' }, { content: '', kind: 'agent' }, ...['project', 'role', 'skill'].map(kind => ({ content: 'x', kind })), { content: 'x', kind: 'agent', sourceRefs: [4] }]) {
    await assert.rejects(manager.execute('alice', { name: 'memory_propose', args }), /tool argument/i);
  }
  await assert.rejects(manager.execute('alice', { name: 'session_get', args: {} }), /requires sessionId or reference/);
  assert.equal(dispatched, 0);
  for (const name of ['memory_search', 'memory_propose']) assert.deepEqual(memoryToolDefinitions.find(tool => tool.name === name).parameters.properties.kind.enum, ['user', 'agent']);
  assert.equal(memoryToolDefinitions.find(tool => tool.name === 'memory_propose').parameters.properties.scope, undefined);
});

test('large memory pages remain structured, retain complete source chunks and expose the next exact offset', async t => {
  const items = Array.from({ length: 8 }, (_, index) => ({ id: `record-${index}`, reference: `source-${index}`, text: `${index}:` + '完整原文'.repeat(1500), payload: { duplicate: 'payload'.repeat(20000) } }));
  const original = { success: true, data: { items, records: items, offset: 0, limit: 8, total: 12, hasMore: true, nextOffset: 8, anchorOffset: 3, anchorReference: 'source-3', session: { id: 'past-session', task: 'Archived task', projectId: 'project', status: 'completed', metadata: { events: 'large'.repeat(40000) } } } };
  const manager = managerFor(t, { tool: () => original });
  const result = await manager.execute('alice', { name: 'session_get', args: { reference: 'source-3' } });
  assert.equal(result.truncated, false); assert.ok(Buffer.byteLength(result.output) <= manager.maxOutputBytes);
  const output = JSON.parse(result.output), data = output.data;
  assert.equal(output.currentEvidence, false); assert.equal(data.session.id, 'past-session'); assert.equal(data.session.metadata, undefined); assert.equal(data.records, undefined);
  assert.equal(data.offset, 3); assert.equal(data.items[0].reference, 'source-3'); assert.ok(data.items.length > 0 && data.items.length < 5);
  assert.equal(data.nextOffset, data.offset + data.items.length); assert.equal(data.limit, data.items.length); assert.equal(data.hasMore, true);
  for (const item of data.items) { assert.equal(item.text, items.find(original => original.id === item.id).text); assert.equal(item.payload, undefined); }
  assert.equal(original.data.items.length, 8); assert.ok(original.data.session.metadata.events.length > 100000, 'Presentation cannot mutate stored/API data');
  const search = JSON.parse((await manager.execute('alice', { name: 'session_search', args: { query: 'source', offset: 0 } })).output).data;
  assert.equal(search.offset, 0); assert.equal(search.items[0].reference, 'source-0'); assert.equal(search.nextOffset, search.items.length);
});

test('session_get with a small reference page fetches the actual anchor and explicit offsets remain honored', async t => {
  const requests = [], items = Array.from({ length: 5 }, (_, index) => ({ reference: `source-${index}`, text: `full text ${index}` }));
  const manager = managerFor(t, { tool(name, args) {
    requests.push(args); const offset = args.offset ?? 1;
    return { data: { items: items.slice(offset, offset + 1), offset, limit: 1, total: 5, hasMore: true, anchorOffset: 4, anchorReference: 'source-4', session: { id: 'archive' } } };
  } });
  const anchored = JSON.parse((await manager.execute('alice', { name: 'session_get', args: { reference: 'source-4', limit: 1 } })).output).data;
  assert.equal(requests.length, 2); assert.equal(requests[1].offset, 4); assert.equal(anchored.items[0].reference, 'source-4');
  const explicit = JSON.parse((await manager.execute('alice', { name: 'session_get', args: { reference: 'source-4', limit: 1, offset: 0 } })).output).data;
  assert.equal(requests.length, 3); assert.equal(explicit.offset, 0); assert.equal(explicit.items[0].reference, 'source-0');
});

test('long Chinese memories provide searchable snippets and lossless character pages with provenance', async t => {
  const content = '原始记忆😀'.repeat(5000), entry = { id: 'long-memory', content, status: 'active', sourceRefs: ['conversation:original-source'], projectId: 'project', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-02-01T00:00:00.000Z', expiresAt: null };
  const manager = managerFor(t, { tool(name) { return name === 'memory_search' ? { data: { items: [entry], offset: 0, limit: 20, total: 1, hasMore: false, nextOffset: null } } : { data: entry }; } });
  const found = await manager.execute('alice', { name: 'memory_search', args: { query: '原始记忆' } });
  assert.equal(found.truncated, false);
  const hit = JSON.parse(found.output).data.items[0];
  assert.equal(hit.content, undefined); assert.equal(hit.contentTruncated, true); assert.equal(Array.from(hit.snippet).length, 1200);
  assert.equal(hit.totalChars, Array.from(content).length); assert.deepEqual(hit.sourceRefs, entry.sourceRefs); assert.deepEqual(hit.readWith, { name: 'memory_get', args: { id: entry.id } });
  let offset = 0, reconstructed = '', pages = 0;
  do {
    const result = await manager.execute('alice', { name: 'memory_get', args: { id: entry.id, offset, limit: 8000 } });
    assert.equal(result.truncated, false); assert.ok(Buffer.byteLength(result.output) <= manager.maxOutputBytes);
    const output = JSON.parse(result.output), page = output.data;
    assert.equal(output.currentEvidence, false); assert.equal(output.requiresAssessment, true); assert.equal(page.status, 'active'); assert.deepEqual(page.sourceRefs, entry.sourceRefs);
    assert.equal(page.createdAt, entry.createdAt); assert.equal(page.updatedAt, entry.updatedAt); assert.equal(page.expiresAt, entry.expiresAt);
    assert.equal(page.offset, offset); assert.equal(page.totalChars, Array.from(content).length); assert.ok(!/\uFFFD/.test(page.content));
    reconstructed += page.content; pages++;
    if (!page.hasMore) { assert.equal(page.nextOffset, null); break; }
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  } while (pages < 10);
  assert.ok(pages > 1); assert.equal(reconstructed, content); assert.equal(entry.content, content);
  await assert.rejects(manager.execute('alice', { name: 'memory_get', args: { id: entry.id, limit: 8001 } }), /tool argument/i);
});

test('memory failure remains an ordinary result and stopped tasks retain cancellation', async t => {
  const manager = managerFor(t, { tool() { throw Object.assign(Error('private backend details'), { fatalStorage: true, code: 'STORAGE_ERROR' }); } });
  const result = await manager.execute('teacher', { name: 'memory_search', args: { query: 'prior approach' } });
  assert.equal(result.success, false); assert.equal(result.code, 'memory_unavailable'); assert.equal(result.fatalStorage, undefined);
  assert.ok(!result.output.includes('private backend details')); assert.equal(manager.stopped, false);
  assert.ok((await manager.execute('teacher', { name: 'plan_read', args: {} })).output);
  const controller = new AbortController(); controller.abort(Error('cancelled by task'));
  await assert.rejects(manager.execute('teacher', { name: 'memory_search', args: { query: 'x' } }, { signal: controller.signal }), /cancelled by task/);
});

test('memory proposal repairs do not mutate the store before a valid native call', async t => {
  const saved = [], manager = managerFor(t, { tool(name, args) { saved.push({ name, args }); return { status: 'active' }; } });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).hostname, 'class-memory-test.invalid');
    requests++;
    if (requests === 1) return response('messages', '', [{ id: 'bad', name: 'memory_propose', args: { content: 'Do not activate', kind: 'agent', approved: true } }]);
    if (requests === 2) { assert.equal(saved.length, 0); return response('messages', '', [{ id: 'good', name: 'memory_propose', args: { content: 'Reviewed later', kind: 'agent' } }]); }
    return response('messages', '{"done":true}');
  });
  const client = new ModelProtocolClient(provider, provider.apiKey);
  const result = await client.json('test', { task: 'test' }, undefined, { tools: toolDefinitions(manager), executeTool: (name, args) => manager.execute('alice', { name, args }) });
  assert.equal(result.done, true); assert.equal(saved.length, 1); assert.equal(saved[0].args.content, 'Reviewed later');
});

for (const protocol of ['messages', 'responses', 'chat']) test(`${protocol} archives public conversation before trimming without secrets, hidden reasoning, binary, or observer failures`, async t => {
  const events = [], secret = provider.apiKey; let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).hostname, 'class-memory-test.invalid'); requests++;
    return requests === 1 ? response(protocol, 'Visible explanation ' + secret, [{ id: 'work-1', name: 'work', args: { value: 'visible argument', password: 'private-password' } }], true)
      : response(protocol, '{"done":true}', [], true);
  });
  const client = new ModelProtocolClient({ ...provider, protocol }, secret);
  const result = await client.json('PRIVATE-SYSTEM', { task: 'visible task', apiKey: secret, image: { type: 'base64', data: 'BINARY-PAYLOAD' } }, undefined, {
    tools: [{ name: 'work', description: 'test only', parameters: { type: 'object', properties: { value: { type: 'string' }, password: { type: 'string' } }, required: ['value'], additionalProperties: false } }],
    executeTool: () => ({ output: 'visible tool result ' + secret, media: [{ type: 'image', mimeType: 'image/png', data: 'BINARY-PAYLOAD', sha256: 'digest' }] }),
    onConversation(event) { events.push(event); return Promise.reject(Error('archive unavailable')); },
  });
  assert.equal(result.done, true); assert.equal(requests, 2);
  assert.deepEqual(events.map(event => event.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
  const archived = JSON.stringify(events);
  for (const hidden of [secret, 'private-password', 'HIDDEN-REASONING', 'PRIVATE-SYSTEM', 'private-signature', 'BINARY-PAYLOAD']) assert.ok(!archived.includes(hidden), hidden);
  for (const visible of ['visible task', 'Visible explanation', 'visible argument', 'visible tool result']) assert.ok(archived.includes(visible));
});

test('student and teacher fourth-argument observers include identity and operation without changing submission flow', async t => {
  const events = [], tools = managerFor(t, { tool: () => ({ items: [] }) });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, 'class-memory-test.invalid'); calls++;
    const body = JSON.parse(options.body); assert.match(body.system, /不可信的上下文线索/); assert.match(body.system, /当前日期、记录时间/); assert.match(body.system, /memory_assess/); assert.match(body.system, /模型评估也可能出错/); assert.match(body.system, /无须人工逐条确认/);
    assert.match(body.system, /user 用户画像/); assert.match(body.system, /agent Agent画像/); assert.match(body.system, /跨会话和工作目录/); assert.match(body.system, /不能把一次任务中的经验泛化为普遍事实/);
    return calls === 1 ? response('messages', 'Student visible progress', [{ id: 'answer-1', name: 'submit_answer', args: { content: 'candidate answer' } }])
      : response('messages', 'Teacher visible progress', [{ id: 'review-1', name: 'submit_review', args: { valid: false, report: 'Need current verification', gaps: ['current evidence'] } }]);
  });
  const observer = { onConversation(event) { events.push(event); throw Error('archive failed'); } };
  const student = createStudent({ id: 'alice', name: 'Alice' }, provider, tools, observer);
  const teacher = createTeacher({ id: 'teacher', name: 'Teacher' }, provider, tools, observer);
  const ctx = { task: 'original task', blackboard: [], checkpoint: async () => {} };
  const answer = await student.solve(ctx); assert.equal(answer.type, 'answer');
  const review = await teacher.judge(answer, ctx); assert.equal(review.valid, false);
  assert.ok(events.some(event => event.studentId === 'alice' && event.operation === 'solve' && event.role === 'assistant'));
  assert.ok(events.some(event => event.studentId === 'teacher' && event.operation === 'judge' && event.role === 'assistant'));
  assert.ok(events.some(event => event.toolName === 'submit_review' && event.role === 'tool'));
});

test('reused recovery state archives changed review input once and skips identical retries', async t => {
  const events = [], recoveryState = {}, client = new ModelProtocolClient(provider, provider.apiKey);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body), latest = events.filter(event => event.role === 'user').at(-1);
    assert.equal(latest.content, body.messages[0].content, 'Updated input must be archived before it is sent');
    return response('messages', '{"done":true}');
  });
  const options = { recoveryState, onConversation: event => events.push(event) };
  const input = { task: 'same task', feedbackVersion: 0, reviewSnapshot: { reviewId: 'review-1', observations: ['old observation'] } };
  await client.json('system', input, undefined, options);
  await client.json('system', structuredClone(input), undefined, options);
  await client.json('system', { ...input, feedbackVersion: 1, reviewSnapshot: { reviewId: 'review-2', observations: ['new observation'] } }, undefined, options);
  const archived = events.filter(event => event.role === 'user').map(event => JSON.parse(event.content));
  assert.equal(archived.length, 2); assert.deepEqual(archived.map(event => event.feedbackVersion), [0, 1]);
  assert.equal(archived[1].reviewSnapshot.reviewId, 'review-2');
});

test('in-loop teacher feedback updates archive the changed actual user content before the next model request', async t => {
  const events = [], client = new ModelProtocolClient(provider, provider.apiKey); let version = 0, requests = 0;
  const board = () => [{ content: version ? 'new current feedback' : 'initial observation', status: 'accepted' }];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests++; const input = JSON.parse(JSON.parse(options.body).messages[0].content);
    assert.equal(JSON.parse(events.filter(event => event.role === 'user').at(-1).content).feedbackVersion, input.feedbackVersion);
    return requests === 1 ? response('messages', '', [{ id: 'read-1', name: 'work', args: {} }]) : response('messages', '{"done":true}');
  });
  await client.json('system', { task: 'same task', feedbackVersion: 0, blackboard: board() }, undefined, {
    tools: [{ name: 'work', description: 'test', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
    executeTool() { version = 1; return { output: 'completed once' }; },
    readFeedbackVersion: () => version, readBlackboard: board, onConversation: event => events.push(event),
  });
  const inputs = events.filter(event => event.role === 'user').map(event => JSON.parse(event.content));
  assert.equal(requests, 2); assert.deepEqual(inputs.map(input => input.feedbackVersion), [0, 1]);
  assert.equal(inputs[1].blackboard[0].content, 'new current feedback');
});
