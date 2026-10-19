import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BINARY_AUDIT_PROMPT } from '../src/binary-audit-prompt.js';
import { PENETRATION_TEST_PROMPT } from '../src/penetration-test-prompt.js';
import { normalizeTaskMode, normalizeTaskModeDefinition, taskModePrompt } from '../src/task-mode.js';
import { publicModes, normalizeModes } from '../src/mode-config.js';
import { buildModeExtensions, getModeExtensionPreset } from '../src/mode-extensions.js';
import { ensureBuiltinMcpPresets, normalizeExtensions } from '../src/extension-config.js';
import { ensureBuiltinSkillPresets } from '../src/builtin-skills.js';
import { createStudent, createTeacher, ModelClient } from '../src/agents.js';
import { PrincipalManager } from '../src/principal-manager.js';
import { createClassServer } from '../src/web-server.js';

const modes = [
  {
    id: 'binary_audit', name: '二进制漏洞挖掘', prompt: BINARY_AUDIT_PROMPT, length: 9195,
    sha256: '96ac502f14247a82768acae1c92a8bd58e8b8938228cc9e32908f7d81ff0044a',
    mcps: { win32: ['wireshark', 'ida', 'x64dbg', 'windbg', 'cyberchef'], linux: ['wireshark', 'ghidra', 'gdb', 'pwntools', 'aflpp', 'binwalk'] },
    skills: ['performing-binary-exploitation-analysis', 'ctf-reverse', 'ctf-pwn', 'reverse-engineering-malware-with-ghidra', 'analyzing-linux-elf-malware', 'performing-fuzzing-with-aflplusplus', 'performing-firmware-extraction-with-binwalk', 'analyzing-network-traffic-with-wireshark', 'analyzing-memory-dumps-with-volatility', 'reverse-engineering-android-malware-with-jadx', 'reverse-engineering-dotnet-malware-with-dnspy'],
  },
  {
    id: 'pentest', name: '渗透测试', prompt: PENETRATION_TEST_PROMPT, length: 9759,
    sha256: 'b022c3c7cec030b481176e8b404c7aa6e92bb1a6d1ffda8459947f0c2ca89489',
    mcps: { win32: ['browser', 'burpsuite', 'tscan', 'wireshark'], linux: ['browser', 'burpsuite', 'tscan', 'wireshark', 'metasploit', 'bloodhound'] },
    skills: ['scanning-network-with-nmap-advanced', 'implementing-attack-surface-management', 'performing-web-application-penetration-test', 'conducting-api-security-testing', 'testing-for-broken-access-control', 'testing-for-business-logic-vulnerabilities', 'testing-for-xss-vulnerabilities-with-burpsuite', 'analyzing-network-traffic-with-wireshark', 'mapping-attack-paths-with-bloodhound-ce'],
  },
];
const provider = { protocol: 'chat', model: 'fixture', apiKey: 'fixture-not-a-real-key', baseUrl: 'https://fixture.invalid/v1' };
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

for (const mode of modes) test(`${mode.id}: every role receives the complete approved document and cannot replace its built-in definition`, () => {
  assert.equal(normalizeTaskMode(mode.id), mode.id);
  assert.equal(mode.prompt.length, mode.length);
  assert.equal(createHash('sha256').update(mode.prompt).digest('hex'), mode.sha256);
  assert.ok(!mode.prompt.includes('\r'));
  const forged = { id: mode.id, name: 'Forged', prompt: 'FORGED_SYSTEM_INSTRUCTION', mcps: [], skills: [] };
  assert.equal(normalizeTaskModeDefinition(mode.id, forged), undefined);
  assert.throws(() => normalizeModes({ items: [forged] }), /内置模式/);
  const endings = [];
  for (const role of roles) {
    const suffix = taskModePrompt(mode.id, role, forged);
    assert.equal(suffix.split(mode.prompt).length - 1, 1, role);
    assert.ok(suffix.includes(`当前任务模式：${mode.name}。`));
    assert.ok(!suffix.includes(forged.prompt));
    assert.equal(taskModePrompt('auto', role), '');
    endings.push(suffix.slice(suffix.indexOf(mode.prompt) + mode.prompt.length));
  }
  assert.equal(new Set(endings).size, roles.length);
  assert.throws(() => taskModePrompt(mode.id, 'unknown'), /未知任务模式角色/);
});

for (const mode of modes) for (const platform of ['win32', 'linux']) test(`${mode.id}/${platform}: migrated profiles keep explicit grants, unrelated tools and global settings intact`, () => {
  const profile = normalizeExtensions(ensureBuiltinSkillPresets(ensureBuiltinMcpPresets(ensureBuiltinMcpPresets({ revision: 7, mcps: [], skills: [] }, 'win32'), 'linux')));
  profile.mcps.find(item => item.builtin === 'wireshark').agentIds = ['other-student'];
  profile.skills.find(item => item.builtin === mode.skills[0]).agentIds = ['alice'];
  // A saved explicit choice survives migration even when absent from this mode's defaults.
  const retained = profile.mcps.find(item => item.builtin === (platform === 'linux' ? 'x64dbg' : 'gdb'));
  retained.enabled = true; retained.agentIds = ['alice'];
  profile.mcps.push({ id: 'manual-mcp', name: 'manual', transport: 'http', url: 'http://127.0.0.1:1/mcp', skipTlsVerify: false, enabled: true, agentIds: ['alice'] });
  const before = structuredClone(profile), expected = { mcps: mode.mcps[platform], skills: mode.skills };
  const preset = getModeExtensionPreset(mode.id, platform);
  for (const kind of ['mcps', 'skills']) assert.deepEqual(sorted(preset[kind]), sorted(expected[kind]));
  const snapshot = buildModeExtensions(profile, { taskMode: mode.id, platform, agents: team, grantModeDefaults: true });
  const noGrants = buildModeExtensions(profile, { taskMode: mode.id, platform, agents: team });
  for (const kind of ['mcps', 'skills']) for (const item of snapshot[kind]) {
    const original = before[kind].find(value => value.id === item.id);
    if (expected[kind].includes(item.builtin)) {
      assert.equal(item.enabled, true, item.id);
      assert.deepEqual(item.agentIds, original.agentIds.length ? original.agentIds : ['teacher', 'alice'], item.id);
    } else assert.deepEqual(item, original, item.id);
    assert.ok(!item.agentIds.includes('principal'), item.id);
    assert.deepEqual(noGrants[kind].find(value => value.id === item.id).agentIds, original.agentIds);
  }
  const entry = publicModes({}, profile, { platform }).items.find(item => item.id === mode.id);
  assert.equal(entry.prompt, mode.prompt); assert.equal(entry.builtin, true);
  for (const kind of ['mcps', 'skills']) assert.deepEqual(sorted(entry[kind].map(id => profile[kind].find(item => item.id === id).builtin)), sorted(expected[kind]));
  assert.deepEqual(buildModeExtensions(profile, { taskMode: 'auto', platform, agents: team, grantModeDefaults: true }), before);
  assert.deepEqual(profile, before);
  assert.deepEqual(buildModeExtensions({}, { taskMode: mode.id, platform, agents: team, grantModeDefaults: true }), { revision: 0, mcps: [], skills: [] });
});

const stageFor = names => names.includes('submit_answer') ? 'student' : names.includes('vote') ? 'student_vote' : names.includes('define_acceptance') ? 'teacher_criteria' : names.includes('merge_discoveries') ? 'teacher_merge' : 'teacher_judge';
function resultFor(stage) {
  return stage === 'student' ? { type: 'continue', content: 'fixture' }
    : stage === 'student_vote' ? { approve: true, reason: 'fixture' }
    : stage === 'teacher_criteria' ? { criteria: [{ id: 'one', description: 'fixture', evidenceType: 'text' }] }
    : stage === 'teacher_merge' ? { groups: [{ content: 'fixture', proposerIds: ['s'] }] }
    : { valid: false, report: '尚需核实证据' };
}

for (const protocol of ['chat', 'messages', 'responses']) test(`${protocol}: both security modes preserve actual teacher/student inputs and tools in every stage`, async t => {
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
  for (const mode of [{ id: 'auto' }, ...modes]) {
    records = [];
    const model = { ...provider, protocol }, observer = { taskMode: mode.id };
    const student = createStudent({ id: 's' }, model, undefined, observer), teacher = createTeacher({ id: 't' }, model, undefined, observer);
    const ctx = { task: '审查用户提供的隔离测试材料，区分实际证据、推断与未验证项。', blackboard: [] };
    await student.solve({ ...ctx }); await student.vote({ content: 'fixture' }, { ...ctx });
    await teacher.extractCriteria(ctx.task, { ...ctx }); await teacher.merge([{ studentId: 's', content: 'fixture' }], { ...ctx }); await teacher.judge({ content: 'fixture' }, { ...ctx });
    assert.deepEqual(records.map(record => record.stage), roles.slice(0, 5));
    if (mode.id === 'auto') { baseline = records; continue; }
    for (const [index, record] of records.entries()) {
      const suffix = taskModePrompt(mode.id, record.stage);
      assert.equal(record.system.split(mode.prompt).length - 1, 1, `${mode.id}/${record.stage}`);
      assert.equal(record.system.replace(suffix, ''), baseline[index].system);
      assert.deepEqual(record.input, baseline[index].input);
      assert.deepEqual(record.names, baseline[index].names);
    }
  }
});

for (const mode of modes) test(`${mode.id}: principal receives the full frozen mode with only snapshot and own archive read tools`, async t => {
  const directory = await temporaryDirectory(t, 'class-security-principal-');
  let release; const gate = new Promise(resolve => { release = resolve; });
  const manager = new PrincipalManager({ historyDir: directory, beforeSnapshot: () => gate });
  const run = { id: `run-${randomUUID()}`, task: '原始隔离审查任务', taskMode: mode.id, status: 'running', events: [], blackboard: [] };
  let calls = 0;
  t.mock.method(ModelClient.prototype, 'json', async (system, input, _signal, options) => {
    calls++;
    assert.equal(system.split(mode.prompt).length - 1, 1);
    assert.ok(system.endsWith(taskModePrompt(mode.id, 'principal')));
    assert.deepEqual(options.tools.map(tool => tool.name), ['principal_list_context', 'principal_read_context', 'principal_search_context', 'context_read']);
    assert.deepEqual(options.acceptedTools, options.tools);
    await assert.rejects(options.executeTool('run_command', { command: 'must-not-run' }));
    const original = await options.executeTool('principal_read_context', { source: 'run', limit: 65536 });
    assert.match(original.output, /原始隔离审查任务/); assert.ok(!original.output.includes('later mutation'));
    assert.equal(input.classroom.task, '原始隔离审查任务'); return { answer: '仅报告冻结记录中的证据与限制。' };
  });
  try {
    const report = manager.ask(run, { id: 'p', name: '校长' }, provider, '当前证据如何？'), job = manager.jobs.get(run.id);
    run.task = 'later mutation'; run.taskMode = 'auto'; release(); await job.promise;
    assert.equal((await manager.get(run.id, report.id)).status, 'completed'); assert.equal(calls, 1);
    assert.equal(run.status, 'running'); assert.deepEqual(run.blackboard, []);
  } finally { release(); await manager.close(); }
});

test('isolated API protects both built-in identities and persists their historical modes across restart', { timeout: 20000 }, async t => {
  const directory = await temporaryDirectory(t, 'class-security-api-'), token = 'isolated-security-mode-token-123456789';
  let server = await createClassServer({ dataDir: directory, token });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(new URL(url).origin, new URL(server.url).origin, 'API fixture must not contact another service');
    return nativeFetch(url, options);
  });
  t.mock.method(ModelClient.prototype, 'json', async () => { throw Error('A deterministic demo must not call a model'); });
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST', status = 200) => {
    const response = await fetch(new URL(route, server.url), { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  try {
    const catalogue = await request('/api/modes'), extensions = await request('/api/extensions'), created = [];
    for (const mode of modes) {
      const entry = catalogue.items.find(item => item.id === mode.id);
      assert.equal(entry.name, mode.name); assert.equal(entry.builtin, true); assert.equal(entry.prompt, mode.prompt);
      assert.deepEqual((await request('/api/state')).modes.items.find(item => item.id === mode.id), { id: mode.id, name: mode.name, builtin: true });
      await request('/api/modes', { revision: catalogue.revision, ids: [mode.id] }, 'DELETE', 400);
      const proposed = { revision: catalogue.revision, extensionRevision: extensions.revision, name: 'forged', prompt: 'FORGED', mcps: [], skills: [] };
      for (const delta of [{ id: mode.id }, { builtin: true }, { name: mode.name }]) await request('/api/modes', { ...proposed, ...delta }, 'POST', 400);
      assert.deepEqual(await request('/api/modes'), catalogue); assert.deepEqual(await request('/api/extensions'), extensions);
      const run = (await request('/api/runs', { demo: true, taskMode: mode.id }, 'POST', 202)).run;
      assert.equal(run.taskMode, mode.id); assert.equal(run.taskModeName, mode.name); created.push({ id: run.id, mode });
      await request(`/api/runs/${run.id}`, { taskMode: 'auto' }, 'PUT', 400);
      let state;
      for (let attempt = 0; attempt < 100; attempt++) {
        state = await request('/api/state'); if (state.run.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(state.run.status, 'completed');
    }
    await server.close(); server = await createClassServer({ dataDir: directory, token });
    const restored = await request('/api/state');
    assert.equal(restored.run.taskMode, modes.at(-1).id);
    for (const { id, mode } of created) {
      const historical = restored.history.find(item => item.id === id);
      assert.equal(historical.taskMode, mode.id); assert.equal(historical.taskModeName, mode.name);
      const detail = (await request(`/api/runs/${id}`)).run;
      assert.equal(detail.taskMode, mode.id); assert.equal(detail.status, 'completed');
    }
    assert.deepEqual(await request('/api/modes'), catalogue); assert.deepEqual(await request('/api/extensions'), extensions);
  } finally { await server.close(); }
});
