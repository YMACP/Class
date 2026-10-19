import test from 'node:test';
import assert from 'node:assert/strict';
import { ClassEngine } from '../src/engine.js';
import { ModelProtocolClient } from '../src/model-protocol.js';
import { taskDigest, checkAcceptance, normalizeCriteria, decodeState, encodeState } from '../src/task-state.js';

const criteria = [{ id: 'result', description: 'Give a justified result', evidenceType: 'text' }];
const completeReview = reference => ({ valid: true, answer: '4', report: '2 + 2 = 4', criteriaResults: [{ criterionId: 'result', status: 'passed', reason: 'The explicit arithmetic derives the requested value.', evidenceKind: 'text', evidenceRefs: [reference] }] });
function members() {
  return { students: ['a','b'].map(id => ({ id, async solve() { return { type: 'answer', content: '4', evidence: '2 + 2 = 4' }; }, async vote() { return { approve: true }; } })),
    teacher: { id: 'teacher', acceptanceRequired: true, async extractCriteria() { return criteria; }, async merge(items) { return items; }, async judge(answer) { return completeReview(answer.submissionId); } } };
}

test('structured digest keeps facts, open work, feedback and original evidence separately and bounded', () => {
  let digest;
  for (let i = 0; i < 120; i++) digest = taskDigest({ previous: digest, blackboard: [{ id: `d-${i}`, accepted: true, content: 'verified finding ' + i }], history: [{ type: 'answer', content: 'claim ' + i, evidenceRecordRef: `journal:r:${i}` }], feedbackHistory: [{ feedbackVersion: i, report: 'continue', gaps: ['missing test'], verifiedFacts: ['known prerequisite'] }] });
  assert.equal(digest.facts.length, 10); assert.ok(digest.pending.some(item => item.status === 'candidate_not_verified'));
  assert.ok(digest.pending.some(item => item.references.includes('journal:r:119'))); assert.ok(digest.omitted > 0);
  assert.ok(JSON.stringify(digest).length < 45000); assert.equal(digest.version, 1);
});

test('valid cannot bypass missing criteria, forged citations or required tool proof', () => {
  assert.ok(checkAcceptance(criteria, { valid: true }).length);
  assert.ok(checkAcceptance(criteria, completeReview('invented')).length);
  assert.deepEqual(checkAcceptance(criteria, completeReview('submission-1'), { textReferences: new Set(['submission-1']) }), []);
  const toolCriteria = [{ ...criteria[0], evidenceType: 'tool' }];
  assert.ok(checkAcceptance(toolCriteria, completeReview('submission-1'), { textReferences: new Set(['submission-1']) }).length);
  assert.ok(checkAcceptance(criteria, completeReview('submission-1'), { textReferences: new Set(['submission-1']), inProgress: true }).length);
  assert.throws(() => normalizeCriteria([]));
});

test('engine restores the same task with extracted acceptance criteria and no external execution state', async () => {
  let snapshot, first;
  first = new ClassEngine({ ...members(), taskTimeoutMs: 2000, onCheckpoint(state, { reason }) { snapshot = JSON.parse(JSON.stringify(state)); if (reason === 'task_ready') first.stop('simulated_shutdown'); } });
  const stopped = await first.run('What is 2 + 2?');
  assert.equal(stopped.status, 'stopped'); assert.equal(snapshot.schemaVersion, 1);
  const restored = new ClassEngine({ ...members(), resumeState: snapshot, taskTimeoutMs: 2000 });
  const result = await restored.run('What is 2 + 2?');
  assert.equal(result.status, 'completed', result.reason); assert.equal(result.answer, '4');
  assert.ok(result.events.some(event => event.type === 'task.resumed'));
  assert.equal(restored.acceptanceCriteria[0].id, 'result');
});

test('engine rejects a boolean-only pass then accepts explicit text evidence without tools', async () => {
  const fixture = members(); let reviews = 0;
  for (const member of fixture.students) { let n = 0; member.solve = async () => ({ type: 'answer', content: '4 revision ' + ++n, evidence: '2 + 2 = 4' }); }
  fixture.teacher.judge = async answer => ++reviews === 1 ? { valid: true, answer: '4', report: 'Trust me' } : completeReview(answer.submissionId);
  const engine = new ClassEngine({ ...fixture, taskTimeoutMs: 2000 });
  const result = await engine.run('What is 2 + 2?');
  assert.equal(result.status, 'completed', result.reason); assert.ok(result.feedbackVersion >= 1);
  assert.ok(result.events.some(event => event.type === 'review.rejected'));
});

test('checkpoint failure is fatal before students begin', async () => {
  const fixture = members(); let calls = 0;
  fixture.students.forEach(member => { member.solve = async () => { calls++; return { type: 'answer', content: '4' }; }; });
  const engine = new ClassEngine({ ...fixture, onCheckpoint() { throw Error('disk full'); }, taskTimeoutMs: 2000 });
  const result = await engine.run('What is 2 + 2?');
  assert.equal(result.status, 'failed'); assert.equal(calls, 0); assert.equal(engine.fault.code, 'STORAGE_ERROR');
});

test('recovered unfinished work needs fresh read-only evidence before acceptance', async () => {
  let snapshot, initial;
  initial = new ClassEngine({ ...members(), onCheckpoint(state, { reason }) { snapshot = structuredClone(state); if (reason === 'task_ready') initial.stop('simulate exit'); }, taskTimeoutMs: 2000 });
  await initial.run('What is 2 + 2?');
  const state = decodeState(snapshot.engine);
  state.evidence.get('a').inProgress.set('old-write', { callId: 'old-write', action: { name: 'write_file' }, status: 'started' });
  snapshot.engine = encodeState(state);
  const fixture = members(); let reviews = 0, restored;
  for (const member of fixture.students) { let n = 0; member.solve = async () => ({ type: 'answer', content: '4 revision ' + ++n }); }
  fixture.teacher.judge = async (answer, ctx) => {
    const review = completeReview(answer.submissionId); reviews++;
    if (reviews > 1) {
      await restored.captureTool({ studentId: 'teacher', callId: 'fresh-inspection', action: { name: 'read_file', args: { path: 'result.txt' } }, type: 'completed', result: { success: true, output: '4' } });
      review.recoveryChecks = ctx.resumeWarnings.filter(warning => !warning.resolved).map(warning => ({ callId: warning.callId, status: 'verified', reason: 'The current file content was read and matches the completed result.', evidenceRefs: ['fresh-inspection'] }));
    }
    return review;
  };
  restored = new ClassEngine({ ...fixture, resumeState: snapshot, taskTimeoutMs: 2000 });
  const result = await restored.run('What is 2 + 2?');
  assert.equal(result.status, 'completed', result.reason); assert.ok(reviews >= 2);
  assert.ok(restored.resumeWarnings.every(item => item.resolved));
  assert.equal(restored.evidence.get('a').inProgress.size, 0);
});

test('working summaries do not share another student private history', async () => {
  const fixture = members(); let engine;
  engine = new ClassEngine({ ...fixture, onCheckpoint(_state, { reason }) { if (reason === 'task_ready') engine.stop('fixture'); } });
  await engine.run('What is 2 + 2?');
  engine.histories.get('a').push({ type: 'continue', content: 'private-a' });
  engine.histories.get('b').push({ type: 'continue', content: 'private-b' });
  const context = engine.context('a');
  assert.ok(JSON.stringify(context.taskSummary).includes('private-a'));
  assert.ok(!JSON.stringify(context.taskSummary).includes('private-b'));
});

function toolReply(protocol, id) {
  if (protocol === 'messages') return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'mutate', input: { value: 'x' } }] });
  if (protocol === 'responses') return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: id, name: 'mutate', arguments: '{"value":"x"}' }] });
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'mutate', arguments: '{"value":"x"}' } }] } }] });
}
const tool = { name: 'mutate', description: 'fixture side effect', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } };
for (const protocol of ['messages','responses','chat']) test(`${protocol}: durable uncertain receipt prevents replay after a new client imports the session`, async t => {
  const config = { baseUrl: 'https://model.invalid/v1', protocol, model: 'fixture', maxTokens: 1000 };
  const client = new ModelProtocolClient(config, 'private-provider-key'), recoveryState = {};
  let snapshot, effects = 0, request = 0;
  t.mock.method(globalThis, 'fetch', async () => toolReply(protocol, `call-${++request}`));
  await assert.rejects(client.json('fixture', { task: 'fixture' }, undefined, { recoveryState, tools: [tool],
    persistSession() { snapshot = JSON.parse(JSON.stringify(client.exportSession(recoveryState))); },
    executeTool() { effects++; throw Object.assign(Error('simulated crash after side effect'), { name: 'AbortError' }); },
  }), /simulated crash/);
  assert.equal(effects, 1); assert.ok(!JSON.stringify(snapshot).includes('private-provider-key'));
  const restored = new ModelProtocolClient(config, 'different-private-key');
  await assert.rejects(restored.json('fixture', { task: 'fixture' }, undefined, { recoveryState: restored.importSession(snapshot), tools: [tool], executeTool() { effects++; return {}; } }), error => error.memberRecoverable === true);
  assert.equal(effects, 1, 'uncertain operation must not be reexecuted under fresh provider IDs');
});

test('a failed pre-tool durable write prevents the side effect', async t => {
  const client = new ModelProtocolClient({ baseUrl: 'https://model.invalid/v1', protocol: 'chat', model: 'fixture' }, 'fixture-key'); let effects = 0;
  t.mock.method(globalThis, 'fetch', async () => toolReply('chat', 'one'));
  await assert.rejects(client.json('fixture', { task: 'fixture' }, undefined, { tools: [tool], persistSession() { throw Error('disk full'); }, executeTool() { effects++; } }), /disk full/);
  assert.equal(effects, 0);
});

test('confirmed effects remain protected after a successful solve releases its protocol history', async t => {
  const config = { baseUrl: 'https://model.invalid/v1', protocol: 'chat', model: 'fixture' };
  const client = new ModelProtocolClient(config, 'fixture-key'); let requests = 0, effects = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests % 2 ? toolReply('chat', `new-id-${requests}`) : Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"done":true}' } }] }));
  const options = { tools: [tool], executeTool() { effects++; return { success: true, output: 'saved' }; } };
  assert.deepEqual(await client.json('fixture', { task: 'fixture' }, undefined, options), { done: true });
  const restored = new ModelProtocolClient(config, 'replacement-key');
  const session = restored.importSession(JSON.parse(JSON.stringify(client.exportSession())));
  assert.deepEqual(await restored.json('fixture', { task: 'fixture' }, undefined, { ...options, recoveryState: session }), { done: true });
  assert.equal(effects, 1, 'fresh provider IDs must reuse the durable confirmed receipt');
});

test('newly discovered tools become callable within the same model turn', async t => {
  const client = new ModelProtocolClient({ baseUrl: 'https://model.invalid/v1', protocol: 'chat', model: 'fixture' }, 'fixture-key');
  const search = { name: 'search_tools', description: 'discover', parameters: { type: 'object', properties: {}, additionalProperties: false } };
  let unlocked = false, requests = 0, effects = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); requests++;
    if (requests === 1) { assert.ok(!body.tools.some(item => item.function.name === 'mutate')); return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'search', type: 'function', function: { name: 'search_tools', arguments: '{}' } }] } }] }); }
    if (requests === 2) { assert.ok(body.tools.some(item => item.function.name === 'mutate')); return toolReply('chat', 'unlocked'); }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"done":true}' } }] });
  });
  const definitions = () => unlocked ? [search, tool] : [search];
  const result = await client.json('fixture', { task: 'fixture' }, undefined, { tools: definitions(), readTools: definitions, readAcceptedTools: definitions, executeTool(name) { if (name === 'search_tools') unlocked = true; else effects++; return { success: true }; } });
  assert.deepEqual(result, { done: true }); assert.equal(effects, 1);
});
