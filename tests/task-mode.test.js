import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ModelClient, createStudent, createTeacher } from '../src/agents.js';
import { normalizeTaskMode, taskModePrompt } from '../src/task-mode.js';
import { WEB_PENTEST_PROMPT } from '../src/web-pentest-prompt.js';
import { JudgmentLayer } from '../src/judgment-layer.js';

const provider = { protocol: 'chat', model: 'fixture', apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1' };
const task = '仅验证授权的本地测试站点，不修改业务数据；报告可复现证据及尚未验证的部分。';
// Captured from the pre-mode implementation, including its optional memory instructions.
const originalHashes = {
  base: { student: 'b66edf138e9608c577e915b4b0fafbe0376baa5fdf4d01e8f07d61c147e56c8e', student_vote: '4d49488073a578d77b4b02ed5ba498b5534e6926769d3469330d0e327da21b5b', teacher_criteria: '2b771c90008c3dedcf260864a3d5fccf1cd7e0ad3f6565e22c3ac73cfba47a3e', teacher_merge: '179039c0ab3da2139c6a2b0229afb972c1177f7e4d721df524115a32e40cee81', teacher_judge: 'b59b48d23b610f918e36f3e05f52ec49d2470ea082aa005c957d121cb3c2d87a' },
  memory: { student: '5c7a19f17a353354effc23ca976596fe66bdd19af110b6b4969283a65ae4994f', student_vote: '6cfb2b117c7392112c210d8056e1628bde1f74928ae09bde38b4e846914149ef', teacher_criteria: '2b771c90008c3dedcf260864a3d5fccf1cd7e0ad3f6565e22c3ac73cfba47a3e', teacher_merge: '86a8968f8fc2c0b2c9e60e2a87ccd1ea90f5ae2eb8cf4e81263589ac89d9853a', teacher_judge: '478b2fe1335240ea952a2eb5c125ba42c47ab6d3ad08910c0f4845e75d99fe01' },
};
const hash = text => createHash('sha256').update(text).digest('hex');

test('task modes accept only the supported modes, with old configurations defaulting to auto', () => {
  for (const value of [undefined, null, '', 'auto']) { assert.equal(normalizeTaskMode(value), 'auto'); assert.equal(taskModePrompt(value, 'student'), ''); }
  assert.equal(normalizeTaskMode('web_pentest'), 'web_pentest');
  for (const value of ['web', 'AUTO', ' auto ', 0, false, [], {}]) assert.throws(() => normalizeTaskMode(value), /任务模式/);
  assert.throws(() => createStudent({ id: 's' }, provider, undefined, { taskMode: 'unknown' }), /任务模式/);
  assert.throws(() => createTeacher({ id: 't' }, provider, undefined, { taskMode: 'unknown' }), /任务模式/);
});

test('every Web role receives the complete approved prompt once and a separate stage label', () => {
  assert.equal(hash(WEB_PENTEST_PROMPT), 'b479cec92f0933dd2a04dffec95b4d052de792ed397783551550d969449329d4');
  const labels = [];
  for (const role of ['student', 'student_vote', 'teacher_criteria', 'teacher_merge', 'teacher_judge', 'teacher', 'principal']) {
    assert.equal(taskModePrompt('auto', role), '');
    const suffix = taskModePrompt('web_pentest', role);
    assert.equal(suffix.split(WEB_PENTEST_PROMPT).length - 1, 1, `${role} must receive the full approved text exactly once`);
    const label = suffix.slice(suffix.indexOf(WEB_PENTEST_PROMPT) + WEB_PENTEST_PROMPT.length);
    assert.match(label, /本次调用角色与阶段：/);
    labels.push(label);
  }
  assert.equal(new Set(labels).size, labels.length, 'each role and stage must have a distinct label');
  assert.throws(() => taskModePrompt('web_pentest', 'unknown'), /未知任务模式角色/);
});

test('all teacher and student stages preserve auto prompts byte-for-byte and append the complete approved Web prompt', async t => {
  let records;
  t.mock.method(ModelClient.prototype, 'json', async function(system, input, signal, options) {
    const names = options.tools.map(item => item.name);
    const stage = names.includes('submit_answer') ? 'student' : names.includes('vote') ? 'student_vote' : names.includes('define_acceptance') ? 'teacher_criteria' : names.includes('merge_discoveries') ? 'teacher_merge' : 'teacher_judge';
    records.push({ stage, system, input, names });
    if (stage === 'student') return { type: 'continue', content: 'fixture' };
    if (stage === 'student_vote') return { approve: true, reason: 'fixture' };
    if (stage === 'teacher_criteria') return { criteria: [{ id: 'one', description: 'fixture', evidenceType: 'tool' }] };
    if (stage === 'teacher_merge') return { groups: [{ content: 'fixture', proposerIds: ['s'] }] };
    return { valid: false, report: 'fixture' };
  });
  for (const memory of [false, true]) {
    let base;
    for (const [mode, fromContext] of [['auto', false], ['web_pentest', false], ['web_pentest', true]]) {
      records = [];
      const tools = memory ? { memory: true } : undefined;
      const options = { taskMode: fromContext ? 'auto' : mode };
      const student = createStudent({ id: 's' }, provider, tools, options), teacher = createTeacher({ id: 't' }, provider, tools, options);
      const ctx = { task, blackboard: [], ...(fromContext ? { taskMode: mode } : {}) };
      await student.solve({ ...ctx }); await student.vote({ content: 'fixture' }, { ...ctx });
      await teacher.extractCriteria(task, { ...ctx }); await teacher.merge([{ studentId: 's', content: 'fixture' }], { ...ctx }); await teacher.judge({ content: 'fixture' }, { ...ctx });
      assert.deepEqual(records.map(item => item.stage), ['student', 'student_vote', 'teacher_criteria', 'teacher_merge', 'teacher_judge']);
      for (const record of records) {
        const suffix = taskModePrompt(mode, record.stage), original = suffix ? record.system.slice(0, -suffix.length) : record.system;
        assert.equal(hash(original), originalHashes[memory ? 'memory' : 'base'][record.stage]);
        assert.ok(record.system.endsWith(suffix)); assert.equal(record.input.task, task);
        if (mode === 'web_pentest') {
          assert.equal(record.system.split(WEB_PENTEST_PROMPT).length - 1, 1, `${record.stage} must receive the full approved text exactly once`);
        }
      }
      if (mode === 'auto') base = records;
      else for (let index = 0; index < records.length; index++) {
        assert.deepEqual(records[index].names, base[index].names, 'a mode cannot grant tools');
        assert.deepEqual(records[index].input, base[index].input, 'the task and evidence inputs must not change');
      }
    }
  }
});

for (const taskMode of ['web_pentest', 'ctf_solve', 'binary_audit', 'pentest']) test(`${taskMode} Jev guidance preserves original constraints, candidates and reproduction evidence without expanding requests`, async () => {
  const makeLayer = enabled => {
    const requests = [];
    const judge = { getStats: () => ({}), recordSavedChars() {}, async decide(point, input) { requests.push({ point, input }); return { applied: true, status: 'ok', answers: Object.fromEntries(Object.keys(input.questions).map(id => [id, { type: 'boolean', probability: 0.99 }])) }; } };
    const layer = new JudgmentLayer({ enabled, features: { taskDispatch: true, toolCalls: true, toolResults: true, submissionReview: true } }, { judge });
    return { layer, requests };
  };
  const prose = Array.from({ length: 9 }, (_, i) => `Unrelated ornament ${i} `.padEnd(1300, 'x') + '\n').join('');
  const protectedOutput = prose + '复现前提：仅授权测试账号；证据引用：evidence:local；待验证：另一权限角色。\n' + prose;
  const result = { output: protectedOutput, outputRef: 'output:local', evidenceRef: 'evidence:local', callId: 'local-call', success: true };
  const input = { task, acceptanceCriteria: [{ id: 'scope', description: task }], blackboard: [], answer: { content: '待验证', evidenceRefs: ['evidence:local'], remainingIssues: ['另一角色尚未复现'] }, reviewSnapshot: { students: [] } };
  for (const enabled of [false, true]) {
    const { layer, requests } = makeLayer(enabled), options = { taskMode };
    const dispatched = await layer.taskDispatch(input, options), reviewed = await layer.submissionReview(input, options);
    assert.equal(dispatched.task, task); assert.strictEqual(dispatched.acceptanceCriteria, input.acceptanceCriteria);
    assert.strictEqual(reviewed.answer, input.answer); assert.strictEqual(reviewed.reviewSnapshot, input.reviewSnapshot);
    const before = requests.length;
    assert.strictEqual(await layer.toolResult({ task, name: 'run_command', args: { command: 'fixture' }, result }, options), result);
    for (const evidence of ['GET /fixture HTTP/1.1\nHost: example.invalid\n', 'HTTP/1.1 200 OK\nContent-Type: text/plain\n', 'curl --head https://example.invalid/fixture\n', 'Authorization: [REDACTED]\n身份：低权限账号\n响应对比：对照响应与当前响应不同\n', 'PoC unconfirmed; baseline still required.\n']) {
      const raw = { ...result, output: prose + evidence + prose };
      assert.strictEqual(await layer.toolResult({ task, name: 'web_fetch', args: { url: 'https://example.invalid' }, result: raw }, options), raw);
    }
    if (taskMode === 'ctf_solve') for (const marker of ['flag: fixture-candidate\n', 'picoCTF{isolated_fixture}\n', 'n = 3233\ne = 17\nc = 2790\n', 'Offset: 72\nAddress: 0x401200\n', 'plaintext: sample\n', 'Platform accepted the fixture result\n', '候选答案：示例\n']) {
      const raw = { ...result, output: prose + marker + prose };
      assert.strictEqual(await layer.toolResult({ task, name: 'run_command', args: { command: 'fixture' }, result: raw }, options), raw);
    }
    const securityMarkers = taskMode === 'binary_audit'
      ? ['SIGSEGV in isolated fixture\n', 'rip = 0x401000\n', 'AddressSanitizer: heap-buffer-overflow\n', 'sha256: fixture-hash\n', '目标摘要：示例\n', '调用栈：示例\n']
      : taskMode === 'pentest' ? ['BloodHound candidate path\n', 'alice GenericAll fixture-object\n', '443/tcp open https\n', 'CVE-2020-12345 fixture-only\n', '对照账号：测试身份\n'] : [];
    for (const marker of securityMarkers) {
      const raw = { ...result, output: prose + marker + prose };
      assert.strictEqual(await layer.toolResult({ task, name: 'run_command', args: { command: 'fixture' }, result: raw }, options), raw);
    }
    assert.equal(requests.length, before, 'reproduction evidence and CTF answer material stay local and intact');
    await layer.beforeToolCall({ task, agentId: 's', name: 'run_command', args: { command: 'fixture' } }, options);
    if (!enabled) { assert.equal(requests.length, 0); continue; }
    const nuisance = { ...result, output: prose };
    const filtered = await layer.toolResult({ task, name: 'run_command', args: { command: 'fixture' }, result: nuisance }, options);
    assert.ok(filtered.output.length < prose.length); assert.deepEqual(filtered.judgeFilter.read.args.reference, result.outputRef);
    assert.deepEqual(new Set(requests.map(item => item.point)), new Set(['taskDispatch', 'submissionReview', 'toolCalls', 'toolResults']));
    const auto = makeLayer(true);
    await auto.layer.taskDispatch(input); await auto.layer.submissionReview(input); await auto.layer.beforeToolCall({ task, agentId: 's', name: 'run_command', args: { command: 'fixture' } });
    await auto.layer.toolResult({ task, name: 'run_command', args: { command: 'fixture' }, result: nuisance });
    assert.deepEqual(requests, auto.requests, 'the mode adds no new content to Jev requests');
  }
});

test('teacher and student tool execution pass the frozen mode locally to Jev without adding it to judge inputs', async t => {
  const calls = [], original = { output: 'HTTP/1.1 200 OK\n', outputRef: 'output:fixture', success: true };
  const judgment = Object.fromEntries(['taskDispatch', 'beforeToolCall', 'toolResult', 'submissionReview'].map(method => [method, async (input, options) => {
    calls.push({ method, input, options }); return method === 'beforeToolCall' ? undefined : method === 'toolResult' ? input.result : input;
  }]));
  const manager = { async execute(agentId, action) { assert.deepEqual(action, { name: 'web_fetch', args: { url: 'https://fixture.invalid' } }); return original; } };
  t.mock.method(ModelClient.prototype, 'json', async function(system, input, signal, options) {
    assert.strictEqual(await options.executeTool('web_fetch', { url: 'https://fixture.invalid' }), original);
    return options.operation === 'solve' ? { type: 'continue', content: 'fixture' } : { valid: false, report: 'fixture' };
  });
  const student = createStudent({ id: 's' }, provider, manager, { judgment, taskMode: 'web_pentest' });
  const teacher = createTeacher({ id: 't' }, provider, manager, { judgment });
  await student.solve({ task, blackboard: [] });
  await teacher.judge({ content: 'fixture' }, { task, blackboard: [], taskMode: 'web_pentest' });
  assert.deepEqual(calls.map(item => item.method), ['taskDispatch', 'beforeToolCall', 'toolResult', 'submissionReview', 'beforeToolCall', 'toolResult']);
  for (const call of calls) {
    assert.equal(call.options.taskMode, 'web_pentest'); assert.equal(call.input.task, task);
    assert.equal(Object.hasOwn(call.input, 'taskMode'), false);
  }
});
