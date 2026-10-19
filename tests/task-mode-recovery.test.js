import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelClient, createStudent, createTeacher } from '../src/agents.js';
import { ModelProtocolClient } from '../src/model-protocol.js';
import { taskModePrompt } from '../src/task-mode.js';
import { legacyTaskModePrompt } from '../src/legacy-task-mode.js';
import { decodeState } from '../src/task-state.js';

const task = '验证授权的本地测试站点，并保留原始证据。';
const tool = { name: 'mutate', description: 'Fixture side effect; no real filesystem operation.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } };
const abort = () => Object.assign(Error('simulated interruption'), { name: 'AbortError' });
const clone = value => JSON.parse(JSON.stringify(value));
function toolReply(protocol, id) {
  if (protocol === 'messages') return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'mutate', input: { value: 'x' } }] });
  if (protocol === 'responses') return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: id, name: 'mutate', arguments: '{"value":"x"}' }] });
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'mutate', arguments: '{"value":"x"}' } }] } }] });
}
function finalReply(protocol, value) {
  const text = JSON.stringify(value);
  if (protocol === 'messages') return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
  if (protocol === 'responses') return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
  return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
}
function wireSystem(protocol, body) {
  return protocol === 'chat' ? body.messages[0].content : protocol === 'messages' ? body.system : body.instructions;
}
function memberSession(snapshot, role) {
  return role === 'student' ? snapshot.session : snapshot.operations[0][1].session;
}

async function legacyFixture(t, protocol, role, status) {
  const provider = { baseUrl: 'https://fixture.invalid/v1', protocol, model: 'fixture', apiKey: 'fixture-key', maxTokens: 1000 };
  const observations = { effects: 0, phase: 'old', requests: [], snapshots: [], currentSystem: '', previousSystem: '' };
  const oldController = new AbortController();
  const manager = { extensions: { definitionsFor: () => [tool], async prepareMember() {} }, execute() {
    observations.effects++;
    if (status === 'uncertain') { oldController.abort(abort()); throw oldController.signal.reason; }
    return { success: true, output: 'saved-once', outputRef: 'fixture:output' };
  } };
  const makeMember = (id = role === 'student' ? 'student-a' : 'teacher-a', config = provider) => role === 'student'
    ? createStudent({ id }, config, manager, { taskMode: 'web_pentest' })
    : createTeacher({ id }, config, manager, { taskMode: 'web_pentest' });
  const invoke = (member, extra = {}) => role === 'student'
    ? member.solve({ task, blackboard: [], ...extra })
    : member.judge({ content: 'candidate' }, { task, blackboard: [], ...extra });
  const json = ModelClient.prototype.json;
  const oldWire = t.mock.method(ModelClient.prototype, 'json', function(system, input, signal, options) {
    assert.equal(options.previousSystems.length, 1);
    assert.notEqual(system, options.previousSystems[0], 'the fixture must exercise a real prompt version change');
    observations.currentSystem = system; observations.previousSystem = options.previousSystems[0];
    const { previousSystems, ...oldOptions } = options;
    return json.call(this, previousSystems[0], input, signal, oldOptions);
  });
  let oldRequests = 0, resumedRequests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    observations.requests.push({ phase: observations.phase, body });
    if (observations.phase === 'old') {
      assert.ok(wireSystem(protocol, body).startsWith(observations.previousSystem));
      if (++oldRequests > 1) throw abort();
      return toolReply(protocol, 'old-call');
    }
    assert.ok(wireSystem(protocol, body).startsWith(observations.currentSystem), 'the resumed request must carry the new complete system prompt');
    if (status === 'uncertain' || ++resumedRequests === 1) return toolReply(protocol, `resumed-call-${observations.requests.length}`);
    return finalReply(protocol, role === 'student' ? { type: 'continue', content: 'retained result' } : { valid: false, report: 'retained result' });
  });
  const oldMember = makeMember();
  await assert.rejects(invoke(oldMember, { signal: oldController.signal, persistCheckpoint() { observations.snapshots.push(clone(oldMember.exportState())); } }), /simulated interruption/);
  oldWire.mock.restore();
  assert.equal(observations.effects, 1);
  const snapshot = observations.snapshots.at(-1);
  const session = memberSession(snapshot, role), state = decodeState(session.state);
  assert.equal(state.completed.size, 1);
  assert.equal([...decodeState(session.receipts).values()][0].uncertain, status === 'uncertain');
  if (status === 'completed') assert.ok(state.historyGroups.length > 0, 'a completed native tool/result pair must be retained');
  observations.phase = 'new';
  return { observations, provider, makeMember, invoke, snapshot, state, session };
}

for (const protocol of ['chat', 'messages', 'responses']) {
  for (const role of ['student', 'teacher_judge']) {
    for (const status of ['completed', 'uncertain']) {
      test(`${protocol} ${role}: legacy Web ${status} operation survives full-prompt migration without replay`, async t => {
        const fixture = await legacyFixture(t, protocol, role, status);
        const restored = fixture.makeMember(); restored.importState(fixture.snapshot);
        if (status === 'uncertain') {
          await assert.rejects(fixture.invoke(restored), error => error.memberRecoverable === true && error.reasonCode === 'TOOL_RESULT_UNCERTAIN');
        } else {
          const result = await fixture.invoke(restored);
          assert.equal(role === 'student' ? result.content : result.report, 'retained result');
        }
        assert.equal(fixture.observations.effects, 1, 'neither a completed nor an uncertain side effect may be repeated with fresh provider IDs');
        const first = fixture.observations.requests.find(item => item.phase === 'new').body;
        const history = protocol === 'responses' ? first.input : first.messages;
        const prior = fixture.state.history;
        if (protocol === 'chat') {
          assert.ok(history[0].content.startsWith(fixture.observations.currentSystem));
          assert.deepEqual(history.slice(2), prior.slice(2), 'migration must preserve existing native tool/result history');
        } else assert.deepEqual(history.slice(1), prior.slice(1), 'migration must preserve existing native tool/result history');
        if (status === 'uncertain') {
          const restoredState = decodeState(memberSession(restored.exportState(), role).state);
          assert.equal(restoredState.uncertain.size, fixture.state.uncertain.size);
          assert.deepEqual([...restoredState.uncertain], [...fixture.state.uncertain]);
          for (const [key, value] of fixture.state.completed) assert.deepEqual(restoredState.completed.get(key), value);
          assert.deepEqual(memberSession(restored.exportState(), role).receipts, fixture.session.receipts);
        }
      });
    }
  }
}

test('legacy Web migration rejects other tasks, students, models, protocols and unlisted prompts before requests', async t => {
  const fixture = await legacyFixture(t, 'chat', 'student', 'completed');
  const before = fixture.observations.requests.length;
  const otherTask = fixture.makeMember(); otherTask.importState(fixture.snapshot);
  await assert.rejects(fixture.invoke(otherTask, { task: task + ' different task' }), /different conversation/);
  const otherStudent = fixture.makeMember('student-b'); otherStudent.importState(fixture.snapshot);
  await assert.rejects(fixture.invoke(otherStudent), /different conversation/);
  assert.throws(() => fixture.makeMember('student-a', { ...fixture.provider, model: 'other-model' }).importState(fixture.snapshot), /does not match/);
  assert.throws(() => fixture.makeMember('student-a', { ...fixture.provider, protocol: 'responses' }).importState(fixture.snapshot), /does not match/);
  for (const previousSystems of [undefined, [], ['unlisted system']]) {
    const client = new ModelProtocolClient(fixture.provider, 'fixture-key');
    await assert.rejects(client.json(fixture.observations.currentSystem, { task, studentId: 'student-a' }, undefined,
      { recoveryState: client.importSession(fixture.session), previousSystems }), /different conversation/);
  }
  assert.equal(fixture.observations.requests.length, before);
  assert.equal(fixture.observations.effects, 1);
});

test('only Web stages provide the exact previous system prompt and auto keeps recovery options unchanged', async t => {
  const provider = { baseUrl: 'https://fixture.invalid/v1', protocol: 'chat', model: 'fixture', apiKey: 'fixture-key' };
  const records = [];
  t.mock.method(ModelClient.prototype, 'json', async function(system, input, _signal, options) {
    const names = options.tools.map(item => item.name);
    const role = names.includes('submit_answer') ? 'student' : names.includes('vote') ? 'student_vote' : names.includes('define_acceptance') ? 'teacher_criteria' : names.includes('merge_discoveries') ? 'teacher_merge' : 'teacher_judge';
    records.push({ role, system, options });
    if (role === 'student') return { type: 'continue', content: 'fixture' };
    if (role === 'student_vote') return { approve: true, reason: 'fixture' };
    if (role === 'teacher_criteria') return { criteria: [{ id: 'one', description: task, evidenceType: 'tool' }] };
    if (role === 'teacher_merge') return { groups: [{ content: 'fixture', proposerIds: ['s'] }] };
    return { valid: false, report: 'fixture' };
  });
  for (const memory of [false, true]) for (const mode of ['auto', 'web_pentest']) {
    records.length = 0;
    const manager = memory ? { memory: true } : undefined;
    const options = { taskMode: mode }, ctx = { task, blackboard: [] };
    const student = createStudent({ id: 's' }, provider, manager, options), teacher = createTeacher({ id: 't' }, provider, manager, options);
    await student.solve(ctx); await student.vote({ content: 'fixture' }, ctx);
    await teacher.extractCriteria(task, ctx); await teacher.merge([{ studentId: 's', content: 'fixture' }], ctx); await teacher.judge({ content: 'fixture' }, ctx);
    assert.equal(records.length, 5);
    for (const record of records) {
      if (mode === 'auto') assert.equal(Object.hasOwn(record.options, 'previousSystems'), false);
      else {
        const suffix = taskModePrompt(mode, record.role), base = record.system.slice(0, -suffix.length);
        assert.deepEqual(record.options.previousSystems, [base + legacyTaskModePrompt(mode, record.role)]);
      }
    }
  }
});
