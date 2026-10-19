import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CTF_SOLVE_PROMPT } from '../src/ctf-solve-prompt.js';
import { normalizeTaskMode, normalizeTaskModeDefinition, taskModePrompt } from '../src/task-mode.js';
import { publicModes, normalizeModes } from '../src/mode-config.js';
import { buildModeExtensions, getModeExtensionPreset } from '../src/mode-extensions.js';
import { ensureBuiltinMcpPresets, normalizeExtensions } from '../src/extension-config.js';
import { ensureBuiltinSkillPresets } from '../src/builtin-skills.js';
import { createStudent, createTeacher, ModelClient } from '../src/agents.js';
import { ClassEngine } from '../src/engine.js';
import { PrincipalManager } from '../src/principal-manager.js';
import { createClassServer } from '../src/web-server.js';

const provider = { protocol: 'chat', model: 'fixture', apiKey: 'fixture-not-a-real-key', baseUrl: 'https://fixture.invalid/v1' };
const commonMcps = ['browser', 'burpsuite', 'wireshark', 'jadx'];
const platformMcps = { win32: ['cyberchef', 'ida', 'x64dbg'], linux: ['ghidra', 'gdb', 'sagemath', 'pwntools', 'zsteg', 'binwalk'] };
const ctfSkills = ['solve-challenge', 'ctf-web', 'ctf-pwn', 'ctf-reverse', 'ctf-crypto', 'ctf-forensics', 'ctf-misc', 'ctf-osint', 'ctf-malware', 'ctf-ai-ml', 'ctf-writeup'];
const roles = ['student', 'student_vote', 'teacher_criteria', 'teacher_merge', 'teacher_judge', 'teacher', 'principal'];
const team = [{ id: 'teacher', role: 'teacher' }, { id: 'alice', role: 'student' }, { id: 'principal', role: 'principal' }];
const sorted = values => [...values].sort();

async function temporaryDirectory(t, prefix) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, prefix));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(directory)), parent);
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('CTF is a protected built-in with the complete approved LF-normalized document in every role', () => {
  assert.equal(normalizeTaskMode('ctf_solve'), 'ctf_solve');
  assert.equal(CTF_SOLVE_PROMPT.length, 11758);
  assert.equal(createHash('sha256').update(CTF_SOLVE_PROMPT).digest('hex'), '9ce03d51cbfdde115871ccdd01409923ae2b0fa24e7efee92a13e19c28e4026f');
  assert.ok(!CTF_SOLVE_PROMPT.includes('\r'));
  const injected = { id: 'ctf_solve', name: 'Forged', prompt: 'FORGED_SYSTEM_INSTRUCTION', mcps: [], skills: [] };
  assert.equal(normalizeTaskModeDefinition('ctf_solve', injected), undefined);
  assert.throws(() => normalizeModes({ items: [injected] }), /内置模式/);
  const endings = [];
  for (const role of roles) {
    const suffix = taskModePrompt('ctf_solve', role, injected);
    assert.equal(suffix.split(CTF_SOLVE_PROMPT).length - 1, 1, role);
    assert.ok(!suffix.includes(injected.prompt));
    assert.equal(taskModePrompt('auto', role), '');
    endings.push(suffix.slice(suffix.indexOf(CTF_SOLVE_PROMPT) + CTF_SOLVE_PROMPT.length));
  }
  assert.equal(new Set(endings).size, roles.length);
  assert.throws(() => taskModePrompt('ctf_solve', 'unknown'), /未知任务模式角色/);
});

for (const platform of ['win32', 'linux']) test(`${platform}: a migrated profile activates only platform CTF defaults without widening grants or changing global settings`, () => {
  const profile = normalizeExtensions(ensureBuiltinSkillPresets(ensureBuiltinMcpPresets(ensureBuiltinMcpPresets({ revision: 7, mcps: [], skills: [] }, 'win32'), 'linux')));
  profile.mcps.find(item => item.builtin === 'burpsuite').agentIds = ['other-student'];
  profile.skills.find(item => item.builtin === 'ctf-web').agentIds = ['alice'];
  // A migrated, explicitly enabled tool from the other OS remains user-owned.
  const externalPlatformTool = profile.mcps.find(item => item.builtin === (platform === 'linux' ? 'x64dbg' : 'gdb'));
  externalPlatformTool.enabled = true; externalPlatformTool.agentIds = ['alice'];
  profile.mcps.push({ id: 'manual-mcp', name: 'manual', transport: 'http', url: 'http://127.0.0.1:1/mcp', skipTlsVerify: false, enabled: true, agentIds: ['alice'] });
  const before = structuredClone(profile), expected = { mcps: [...commonMcps, ...platformMcps[platform]], skills: ctfSkills };
  const preset = getModeExtensionPreset('ctf_solve', platform);
  assert.deepEqual(sorted(preset.mcps), sorted(expected.mcps)); assert.deepEqual(sorted(preset.skills), sorted(expected.skills));
  const snapshot = buildModeExtensions(profile, { taskMode: 'ctf_solve', platform, agents: team, grantModeDefaults: true });
  const noGrants = buildModeExtensions(profile, { taskMode: 'ctf_solve', platform, agents: team });
  for (const kind of ['mcps', 'skills']) for (const item of snapshot[kind]) {
    const original = before[kind].find(value => value.id === item.id);
    if (expected[kind].includes(item.builtin)) {
      assert.equal(item.enabled, true, item.id);
      assert.deepEqual(item.agentIds, original.agentIds.length ? original.agentIds : ['teacher', 'alice'], item.id);
    } else assert.deepEqual(item, original, item.id);
    assert.ok(!item.agentIds.includes('principal'), item.id);
    assert.deepEqual(noGrants[kind].find(value => value.id === item.id).agentIds, original.agentIds);
  }
  const catalogue = publicModes({}, profile, { platform }), ctf = catalogue.items.find(item => item.id === 'ctf_solve');
  assert.equal(ctf.prompt, CTF_SOLVE_PROMPT); assert.equal(ctf.builtin, true);
  for (const kind of ['mcps', 'skills']) assert.deepEqual(sorted(ctf[kind].map(id => profile[kind].find(item => item.id === id).builtin)), sorted(expected[kind]));
  assert.deepEqual(buildModeExtensions(profile, { taskMode: 'auto', platform, agents: team, grantModeDefaults: true }), before);
  assert.deepEqual(profile, before);
  assert.deepEqual(buildModeExtensions({}, { taskMode: 'ctf_solve', platform, agents: team, grantModeDefaults: true }), { revision: 0, mcps: [], skills: [] });
});

const stageFor = names => names.includes('submit_answer') ? 'student' : names.includes('vote') ? 'student_vote' : names.includes('define_acceptance') ? 'teacher_criteria' : names.includes('merge_discoveries') ? 'teacher_merge' : 'teacher_judge';
function resultFor(stage) {
  return stage === 'student' ? { type: 'continue', content: 'fixture' }
    : stage === 'student_vote' ? { approve: true, reason: 'fixture' }
    : stage === 'teacher_criteria' ? { criteria: [{ id: 'one', description: 'fixture', evidenceType: 'text' }] }
    : stage === 'teacher_merge' ? { groups: [{ content: 'fixture', proposerIds: ['s'] }] }
    : { valid: false, report: '仍需核验候选 flag' };
}

for (const protocol of ['chat', 'messages', 'responses']) test(`${protocol}: actual teacher/student requests retain original inputs and tools while carrying the entire CTF prompt`, async t => {
  let records = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, 'fixture.invalid');
    const body = JSON.parse(options.body), names = body.tools.map(tool => tool.name ?? tool.function.name), stage = stageFor(names);
    const system = protocol === 'messages' ? body.system : protocol === 'responses' ? body.instructions : body.messages[0].content;
    const input = protocol === 'responses' ? body.input[0].content : body.messages[protocol === 'chat' ? 1 : 0].content;
    records.push({ stage, system, input, names });
    const content = JSON.stringify(resultFor(stage));
    return Response.json(protocol === 'messages' ? { stop_reason: 'end_turn', content: [{ type: 'text', text: content }] }
      : protocol === 'responses' ? { id: 'fixture-response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }] }
      : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
  });
  let baseline;
  for (const taskMode of ['auto', 'ctf_solve']) {
    records = [];
    const model = { ...provider, protocol }, observer = { taskMode };
    const student = createStudent({ id: 's' }, model, undefined, observer), teacher = createTeacher({ id: 't' }, model, undefined, observer);
    const ctx = { task: '分析用户提供的隔离题目，验证 flag 并说明依据。', blackboard: [] };
    await student.solve({ ...ctx }); await student.vote({ content: 'fixture' }, { ...ctx });
    await teacher.extractCriteria(ctx.task, { ...ctx }); await teacher.merge([{ studentId: 's', content: 'fixture' }], { ...ctx }); await teacher.judge({ content: 'fixture' }, { ...ctx });
    assert.deepEqual(records.map(record => record.stage), roles.slice(0, 5));
    if (taskMode === 'auto') { baseline = records; continue; }
    for (const [index, record] of records.entries()) {
      const suffix = taskModePrompt(taskMode, record.stage);
      assert.equal(record.system.split(CTF_SOLVE_PROMPT).length - 1, 1, record.stage);
      assert.equal(record.system.replace(suffix, ''), baseline[index].system);
      assert.deepEqual(record.input, baseline[index].input);
      assert.deepEqual(record.names, baseline[index].names);
    }
  }
});

test('CTF engine checkpoints preserve the mode and refuse restoration under another mode', async () => {
  const seen = [], members = () => ({
    students: ['s', 's2'].map(id => ({ id, async solve(ctx) { seen.push(ctx.taskMode); return { type: 'answer', content: '4', evidence: '2 + 2 = 4' }; }, async vote() { return { approve: true }; } })),
    teacher: { id: 't', async extractCriteria(_task, ctx) { seen.push(ctx.taskMode); return [{ id: 'one', description: 'compute', evidenceType: 'text' }]; }, async merge(items) { return items; }, async judge(_answer, ctx) { seen.push(ctx.taskMode); return { valid: true, answer: '4', report: 'fixture' }; } },
  });
  let snapshot, engine;
  engine = new ClassEngine({ ...members(), taskMode: 'ctf_solve', taskTimeoutMs: 2000, onCheckpoint(state, { reason }) { snapshot = structuredClone(state); if (reason === 'task_ready') engine.stop('fixture'); } });
  assert.equal((await engine.run('2 + 2')).status, 'stopped'); assert.equal(snapshot.taskMode, 'ctf_solve');
  const resumed = new ClassEngine({ ...members(), taskMode: 'ctf_solve', taskTimeoutMs: 2000, resumeState: snapshot });
  assert.equal((await resumed.run('2 + 2')).status, 'completed'); assert.ok(seen.length >= 3); assert.ok(seen.every(mode => mode === 'ctf_solve'));
  const wrong = new ClassEngine({ ...members(), taskMode: 'auto', taskTimeoutMs: 2000, resumeState: snapshot });
  const rejected = await wrong.run('2 + 2'); assert.equal(rejected.status, 'failed'); assert.match(rejected.reason, /任务模式不匹配/);
});

test('CTF principal receives the full prompt with only frozen snapshot and own archive read tools', async t => {
  const directory = await temporaryDirectory(t, 'class-ctf-principal-');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const manager = new PrincipalManager({ historyDir: directory, beforeSnapshot: () => gate });
  const run = { id: `run-${randomUUID()}`, task: '原始题目', taskMode: 'ctf_solve', status: 'running', events: [], blackboard: [] };
  let calls = 0;
  t.mock.method(ModelClient.prototype, 'json', async (system, input, _signal, options) => {
    calls++;
    assert.equal(system.split(CTF_SOLVE_PROMPT).length - 1, 1);
    assert.ok(system.endsWith(taskModePrompt('ctf_solve', 'principal')));
    assert.deepEqual(options.tools.map(tool => tool.name), ['principal_list_context', 'principal_read_context', 'principal_search_context', 'context_read']);
    assert.deepEqual(options.acceptedTools, options.tools);
    await assert.rejects(options.executeTool('run_command', { command: 'must-not-run' }));
    const original = await options.executeTool('principal_read_context', { source: 'run', limit: 65536 });
    assert.match(original.output, /原始题目/); assert.ok(!original.output.includes('later mutation'));
    assert.equal(input.classroom.task, '原始题目'); return { answer: '仅报告已冻结记录中的依据。' };
  });
  try {
    const report = manager.ask(run, { id: 'p', name: '校长' }, provider, '当前证据如何？'), job = manager.jobs.get(run.id);
    run.task = 'later mutation'; run.taskMode = 'auto'; release(); await job.promise;
    assert.equal((await manager.get(run.id, report.id)).status, 'completed'); assert.equal(calls, 1);
    assert.equal(run.status, 'running'); assert.deepEqual(run.blackboard, []);
  } finally { release(); await manager.close(); }
});

test('isolated mode API protects CTF identity, returns its complete prompt and preserves historical mode after restart', { timeout: 15000 }, async t => {
  const directory = await temporaryDirectory(t, 'class-ctf-api-'), token = 'isolated-ctf-mode-token-123456789';
  let server = await createClassServer({ dataDir: directory, token });
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST', status = 200) => {
    const response = await fetch(new URL(route, server.url), { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  try {
    const catalogue = await request('/api/modes'), extensions = await request('/api/extensions');
    const ctf = catalogue.items.find(item => item.id === 'ctf_solve');
    assert.equal(ctf.name, 'CTF题目求解'); assert.equal(ctf.builtin, true); assert.equal(ctf.prompt, CTF_SOLVE_PROMPT);
    const metadata = (await request('/api/state')).modes.items.find(item => item.id === 'ctf_solve');
    assert.deepEqual(metadata, { id: 'ctf_solve', name: 'CTF题目求解', builtin: true });
    await request('/api/modes', { revision: catalogue.revision, ids: ['ctf_solve'] }, 'DELETE', 400);
    const proposed = { revision: catalogue.revision, extensionRevision: extensions.revision, name: 'forged', prompt: 'FORGED', mcps: [], skills: [] };
    for (const delta of [{ id: 'ctf_solve' }, { builtin: true }, { name: 'CTF题目求解' }]) await request('/api/modes', { ...proposed, ...delta }, 'POST', 400);
    assert.deepEqual(await request('/api/modes'), catalogue); assert.deepEqual(await request('/api/extensions'), extensions);
    const run = (await request('/api/runs', { demo: true, taskMode: 'ctf_solve' }, 'POST', 202)).run;
    assert.equal(run.taskMode, 'ctf_solve'); assert.equal(run.taskModeName, 'CTF题目求解');
    await request(`/api/runs/${run.id}`, { taskMode: 'auto' }, 'PUT', 400);
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await request('/api/state'); if (state.run.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(state.run.status, 'completed');
    await server.close(); server = await createClassServer({ dataDir: directory, token });
    const restored = await request('/api/state');
    assert.equal(restored.run.taskMode, 'ctf_solve'); assert.equal(restored.history.find(item => item.id === run.id).taskMode, 'ctf_solve');
    assert.deepEqual(await request('/api/modes'), catalogue); assert.deepEqual(await request('/api/extensions'), extensions);
  } finally { await server.close(); }
});
