import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { normalizeTaskMode, normalizeTaskModeDefinition, taskModePrompt } from '../src/task-mode.js';
import { createStudent, createTeacher, ModelClient } from '../src/agents.js';
import { ClassEngine } from '../src/engine.js';
import { PrincipalManager } from '../src/principal-manager.js';
import { buildModeExtensions } from '../src/mode-extensions.js';
import { loadCLIExtensions } from '../src/cli-extensions.js';

const id = 'custom-11111111-2222-4333-8444-555555555555';
const prompt = '\n完整的自定义模式正文：保留缩进、`code` 和末尾换行。\n  分析所提供的本地资料，引用已有证据。\n';
const definition = () => ({ id, name: '资料分析', prompt, mcps: ['selected-mcp', 'deleted-mcp'], skills: ['selected-skill', 'restricted-skill'] });
const provider = { protocol: 'chat', model: 'fixture', apiKey: 'fixture-not-a-real-key', baseUrl: 'https://fixture.invalid/v1' };
const stageFor = names => names.includes('submit_answer') ? 'student' : names.includes('vote') ? 'student_vote' : names.includes('define_acceptance') ? 'teacher_criteria' : names.includes('merge_discoveries') ? 'teacher_merge' : 'teacher_judge';
function resultFor(stage) {
  return stage === 'student' ? { type: 'continue', content: 'fixture' }
    : stage === 'student_vote' ? { approve: true, reason: 'fixture' }
    : stage === 'teacher_criteria' ? { criteria: [{ id: 'one', description: 'fixture', evidenceType: 'text' }] }
    : stage === 'teacher_merge' ? { groups: [{ content: 'fixture', proposerIds: ['s'] }] }
    : { valid: false, report: '未完成独立验收' };
}

test('custom mode IDs and full definitions fail closed and never alter caller-owned objects', () => {
  assert.equal(normalizeTaskMode(id), id);
  for (const invalid of ['custom-anything', 'custom-../escape', id.toUpperCase()]) assert.throws(() => normalizeTaskMode(invalid), /任务模式/);
  assert.throws(() => normalizeTaskModeDefinition(id), /完整定义/);
  assert.throws(() => taskModePrompt(id, 'student'), /完整定义/);
  assert.throws(() => createStudent({ id: 's' }, provider, undefined, { taskMode: id }), /完整定义/);
  assert.throws(() => createTeacher({ id: 't' }, provider, undefined, { taskMode: id }), /完整定义/);
  for (const delta of [{ id: 'web_pentest' }, { name: 'name\nforged stage' }, { prompt: '  ' }, { mcps: ['../outside'] }, { skills: 'all' }]) {
    assert.throws(() => normalizeTaskModeDefinition(id, { ...definition(), ...delta }));
  }
  const original = definition(), frozen = normalizeTaskModeDefinition(id, original);
  assert.equal(frozen.prompt, prompt); original.prompt = 'mutated'; original.skills.push('later');
  assert.equal(frozen.prompt, prompt); assert.ok(!frozen.skills.includes('later'));
  assert.equal(normalizeTaskModeDefinition('auto', original), undefined);
  assert.equal(normalizeTaskModeDefinition('web_pentest', original), undefined);
});

for (const protocol of ['chat', 'messages', 'responses']) test(`${protocol}: custom instructions reach every teacher and student stage without changing roles or tool grants`, async t => {
  const records = [], configured = definition();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body), names = body.tools.map(tool => tool.name ?? tool.function.name), stage = stageFor(names);
    const system = protocol === 'messages' ? body.system : protocol === 'responses' ? body.instructions : body.messages[0].content;
    records.push({ stage, system, names });
    const content = JSON.stringify(resultFor(stage));
    return Response.json(protocol === 'messages' ? { stop_reason: 'end_turn', content: [{ type: 'text', text: content }] }
      : protocol === 'responses' ? { id: 'fixture-response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }] }
      : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
  });
  const options = { taskMode: id, taskModeDefinition: configured }, model = { ...provider, protocol };
  const student = createStudent({ id: 's' }, model, undefined, options), teacher = createTeacher({ id: 't' }, model, undefined, options);
  configured.prompt = 'mutation after start must not be applied';
  const ctx = { task: '分析本地资料', blackboard: [] };
  await student.solve({ ...ctx }); await student.vote({ content: 'fixture' }, { ...ctx });
  await teacher.extractCriteria(ctx.task, { ...ctx }); await teacher.merge([{ studentId: 's', content: 'fixture' }], { ...ctx }); await teacher.judge({ content: 'fixture' }, { ...ctx });
  assert.deepEqual(records.map(record => record.stage), ['student', 'student_vote', 'teacher_criteria', 'teacher_merge', 'teacher_judge']);
  const expectedTools = { student: ['publish_discovery', 'submit_answer'], student_vote: ['vote'], teacher_criteria: ['define_acceptance'], teacher_merge: ['merge_discoveries'], teacher_judge: ['submit_review'] };
  for (const record of records) {
    assert.equal(record.system.split(prompt).length - 1, 1);
    assert.ok(record.system.includes(taskModePrompt(id, record.stage, definition())));
    assert.ok(!record.system.includes(configured.prompt));
    assert.deepEqual(record.names, expectedTools[record.stage]);
  }
});

test('custom extension selection stays task-local, preserves explicit grants, merges enabled tools and skips deleted IDs', async () => {
  const team = [{ id: 't', role: 'teacher' }, { id: 's', role: 'student' }, { id: 'p', role: 'principal' }];
  const config = { revision: 3, mcps: [
    { id: 'selected-mcp', name: 'selected', transport: 'http', url: 'http://127.0.0.1:1/mcp', enabled: false, agentIds: [] },
    { id: 'manual-mcp', name: 'manual', transport: 'http', url: 'http://127.0.0.1:2/mcp', enabled: true, agentIds: ['s'] },
  ], skills: [
    { id: 'selected-skill', name: 'selected', content: 'fixture skill', enabled: false, agentIds: [] },
    { id: 'restricted-skill', name: 'restricted', content: 'fixture restricted', enabled: false, agentIds: ['s'] },
  ] };
  const before = structuredClone(config);
  const selected = buildModeExtensions(config, { taskMode: id, taskModeDefinition: definition(), agents: team, grantModeDefaults: true });
  assert.deepEqual(config, before); assert.equal(selected.mcps.length, 2);
  assert.deepEqual(selected.mcps[0].agentIds, ['t', 's']); assert.equal(selected.mcps[0].enabled, true);
  assert.deepEqual(selected.mcps[1].agentIds, ['s']); assert.equal(selected.mcps[1].enabled, true);
  assert.deepEqual(selected.skills[0].agentIds, ['t', 's']); assert.deepEqual(selected.skills[1].agentIds, ['s']);
  const noNewGrants = buildModeExtensions(config, { taskMode: id, taskModeDefinition: definition(), agents: team });
  assert.deepEqual(noNewGrants.mcps[0].agentIds, []);
  assert.deepEqual(buildModeExtensions({}, { taskMode: id, taskModeDefinition: definition(), agents: team, grantModeDefaults: true }).mcps, []);
  await assert.rejects(loadCLIExtensions({ taskMode: id, extensions: config }, { environment: {} }), /完整定义/);
  const cli = await loadCLIExtensions({ taskMode: id, taskModeDefinition: definition(), extensions: config, teacher: { id: 't' }, students: [{ id: 's' }] }, { environment: {} });
  assert.equal(cli.extensionConfig.mcps.length, 2, 'custom CLI mode must not seed unrelated builtins');
  assert.deepEqual(cli.extensionConfig.skills.map(skill => skill.id), ['selected-skill', 'restricted-skill']);
});

function members(seen = []) {
  const capture = ctx => { assert.deepEqual(ctx.taskModeDefinition, definition()); seen.push(ctx.taskModeDefinition); ctx.taskModeDefinition.prompt = 'local mutation'; };
  return { students: ['s', 's2'].map(id => ({ id, async solve(ctx) { capture(ctx); return { type: 'answer', content: '4', evidence: '2 + 2 = 4' }; }, async vote() { return { approve: true }; } })),
    teacher: { id: 't', async extractCriteria(_task, ctx) { capture(ctx); return [{ id: 'one', description: 'fixture', evidenceType: 'text' }]; }, async merge(items) { return items; }, async judge(_answer, ctx) { capture(ctx); return { valid: true, answer: '4', report: 'fixture' }; } } };
}

test('engine freezes custom definitions, resumes deleted-mode snapshots and rejects changed recovery instructions', async () => {
  let snapshot, first;
  const original = definition(), seen = [];
  first = new ClassEngine({ ...members(seen), taskMode: id, taskModeDefinition: original, taskTimeoutMs: 2000, onCheckpoint(state, { reason }) { snapshot = structuredClone(state); if (reason === 'task_ready') first.stop('fixture'); } });
  original.prompt = 'changed catalogue'; original.mcps.length = 0;
  assert.equal((await first.run('2 + 2')).status, 'stopped');
  assert.deepEqual(snapshot.taskModeDefinition, definition());
  const restored = new ClassEngine({ ...members(seen), taskMode: id, taskModeDefinition: snapshot.taskModeDefinition, resumeState: snapshot, taskTimeoutMs: 2000 });
  const result = await restored.run('2 + 2'); assert.equal(result.status, 'completed', result.reason);
  assert.deepEqual(restored.taskModeDefinition, definition()); assert.ok(seen.length >= 3);
  for (const delta of [{ prompt: 'different prompt' }, { skills: [] }, { name: 'different name' }]) {
    const wrong = new ClassEngine({ ...members(), taskMode: id, taskModeDefinition: { ...definition(), ...delta }, resumeState: snapshot, taskTimeoutMs: 2000 });
    const rejected = await wrong.run('2 + 2'); assert.equal(rejected.status, 'failed'); assert.match(rejected.reason, /模式定义不匹配/);
  }
});

test('principal freezes the full custom prompt with only frozen snapshot and own archive read tools', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-custom-mode-'));
  let release; const gate = new Promise(resolve => { release = resolve; });
  const manager = new PrincipalManager({ historyDir: root, secrets: ['fixture-private-value'], beforeSnapshot: () => gate });
  t.after(async () => { await manager.close(); assert.equal(path.dirname(await fs.realpath(root)), parent); assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(root, { recursive: true, force: true }); });
  const configured = { ...definition(), prompt: prompt + '示例请求头：Authorization: Bearer example-token\n显式说明中的示例值：fixture-private-value\n' };
  const run = { id: `run-${randomUUID()}`, task: '原始任务', taskMode: id, taskModeDefinition: structuredClone(configured), status: 'running', events: [], blackboard: [] };
  t.mock.method(ModelClient.prototype, 'json', async function(system, input, signal, options) {
    assert.ok(system.endsWith(taskModePrompt(id, 'principal', configured))); assert.equal(system.split(configured.prompt).length - 1, 1);
    assert.deepEqual(options.tools.map(tool => tool.name), ['principal_list_context', 'principal_read_context', 'principal_search_context', 'context_read']);
    await assert.rejects(options.executeTool('run_command', { command: 'forbidden' }));
    const archive = await options.executeTool('principal_read_context', { source: 'run', limit: 65536 });
    assert.ok(!archive.output.includes('fixture-private-value')); assert.ok(!archive.output.includes('Bearer example-token'));
    assert.equal(input.classroom.task, '原始任务'); return { answer: '仅汇报已保存的课堂记录。' };
  });
  const report = manager.ask(run, { id: 'p', name: '校长' }, provider, '进展如何？'), job = manager.jobs.get(run.id);
  run.taskModeDefinition.prompt = 'changed after question'; release(); await job.promise;
  assert.equal((await manager.get(run.id, report.id)).status, 'completed'); assert.equal(run.status, 'running'); assert.deepEqual(run.blackboard, []);
});

test('custom mode does not add prompt contents to Jev inputs or change auxiliary decisions', async t => {
  const calls = [], judgment = { async taskDispatch(input, options) { calls.push({ input, options }); return input; }, async submissionReview(input, options) { calls.push({ input, options }); return input; } };
  t.mock.method(ModelClient.prototype, 'json', async (_system, _input, _signal, options) => resultFor(options.operation === 'solve' ? 'student' : 'teacher_judge'));
  const observer = { judgment, taskMode: id, taskModeDefinition: definition() }, ctx = { task: '原始任务', blackboard: [] };
  await createStudent({ id: 's' }, provider, undefined, observer).solve({ ...ctx });
  await createTeacher({ id: 't' }, provider, undefined, observer).judge({ content: 'fixture' }, { ...ctx });
  assert.equal(calls.length, 2); for (const call of calls) { assert.equal(call.options.taskMode, id); assert.equal(call.input.task, ctx.task); assert.ok(!JSON.stringify(call.input).includes(prompt)); }
});
