// Isolated native executable acceptance. No paid service or real profile is used.
// Usage: node tests/release/verify-jev-release.js [Class.exe | /path/Class | --node]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { verifyNativeExecutable } from './windows-verification.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = process.argv[2] === '--node';
const executable = source ? process.execPath : path.resolve(process.argv[2]);
if (!source) verifyNativeExecutable(await fs.readFile(executable));
const parent = await fs.realpath(os.tmpdir());
const directory = await fs.mkdtemp(path.join(parent, 'class-jev-native-'));
const profile = path.join(directory, 'profile'), workspace = path.join(directory, 'workspace');
const original = 'EVIDENCE START: the requested value is 42.\n' + Array.from({ length: 90 }, (_, i) => `Unrelated announcement ${i}: ${'decorative background text '.repeat(4)}\n`).join('') + 'EVIDENCE END: verification value is 42.\n';
let child, exited, instance, failure, mockFailure, state, expectedJudgeKey;
let connectionChecks = 0;
const results = [], sockets = new Set();
const reply = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const tool = (res, id, name, input) => reply(res, { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const toolResult = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'tool_result').at(-1);
const inputFor = body => JSON.parse(body.messages.find(m => m.role === 'user' && typeof m.content === 'string').content);
const mock = http.createServer(async (req, res) => {
  try {
    const pieces = []; for await (const piece of req) pieces.push(piece);
    const body = JSON.parse(Buffer.concat(pieces));
    if (req.url === '/v1/systemone') {
      assert.equal(req.headers.authorization, 'Bearer ' + expectedJudgeKey);
      assert.equal(body.model, 'jev-latest');
      assert.equal(Object.hasOwn(body, 'messages'), false, 'Jev must use the native System One payload');
      assert.ok(body.state && body.questions, 'Jev must send state and questions');
      if (body.questions.ready) {
        connectionChecks++;
        reply(res, { answers: { ready: { type: 'noul', noul: 0.99 } } });
        return;
      }
      state.judgeCalls++;
      assert.ok(state.enabled && Object.values(state.features).some(Boolean), 'disabled or unselected points must not call Jev');
      if (state.scenario === 'submission-only') assert.ok(body.state.candidates, 'unselected points must not contact Jev');
      if (state.scenario === 'fault') { res.writeHead(429); res.end(); return; }
      reply(res, { answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: /^(chunk_|verification$|traceable$)/.test(id) ? 0.99 : 0.01 }])) });
      return;
    }
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['x-api-key'], 'native-fixture-model');
    const input = inputFor(body);
    assert.equal(input.task, 'Read report.txt, verify the value 42, and cite its recorded evidence.');
    if(body.tools?.some(item=>item.name==='define_acceptance')) {tool(res,'criteria','define_acceptance',{criteria:[{id:'value',description:'Read report.txt, verify value 42 and cite recorded evidence.',evidenceType:'tool'}]});return;}
    if (body.model === 'bob') return; // Class must cancel this unfinished member on final acceptance.
    if (body.model === 'alice') {
      state.studentCalls++;
      if (state.studentCalls === 1) {
        const command = process.platform === 'win32' ? "Get-Content -LiteralPath 'report.txt'" : "cat 'report.txt'";
        tool(res, 'read-report', 'run_command', { command }); return;
      }
      assert.equal(state.studentCalls, 2, 'The command must not be repeated');
      const result = JSON.parse(toolResult(body).content);
      state.result = result;
      const normalize = value => value.replace(/\r\n/g, '\n');
      if (state.applies('toolResults')) {
        assert.ok(result.output.length < original.length);
        assert.ok(result.judgeFilter && result.output.includes('EVIDENCE START') && result.output.includes('EVIDENCE END'));
      } else assert.equal(normalize(result.output), original);
      tool(res, 'candidate', 'submit_answer', { content: 'The verified value is 42.', evidence: 'See the saved command output.', evidenceRefs: [result.outputRef, result.evidenceRef], completionClaims: ['Read and verify value 42'], remainingIssues: [] });
      return;
    }
    assert.equal(body.model, 'teacher');
    assert.equal(input.reviewSnapshot.students.length, 2);
    assert.equal(input.answer.content, 'The verified value is 42.');
    if (state.applies('submissionReview')) assert.ok(input.judgeChecklist);
    else assert.equal(input.judgeChecklist, undefined);
    state.teacherCalls++;
    if (state.teacherCalls === 1) {
      tool(res, 'full-evidence', 'read_evidence', { reference: state.result.outputRef, byteOffset: 0, maxBytes: 65536 }); return;
    }
    assert.equal(state.teacherCalls, 2);
    const result = JSON.parse(toolResult(body).content);
    assert.ok(JSON.stringify(result).includes('Unrelated announcement 45'), 'The teacher can recover omitted original evidence');
    state.originalRecovered = true;
    tool(res, 'accepted', 'submit_review', { valid: true, criteriaResults:[{criterionId:'value',status:'passed',reason:'The actual saved command output was recovered and verified.',evidenceKind:'tool',evidenceRefs:[state.result.outputRef]}], answer: 'The verified value is 42.', report: 'Verified the original saved output.', evidenceRefs: [state.result.outputRef] });
  } catch (error) { mockFailure = error; if (!res.headersSent) res.writeHead(500); res.end(); }
});
mock.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
async function api(route, body, method = body === undefined ? 'GET' : 'POST', expectedStatus) {
  if (mockFailure) throw mockFailure;
  const response = await fetch(new URL(route, instance.url), { method, headers: { authorization: `Bearer ${instance.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const value = await response.json();
  if (expectedStatus === undefined) assert.ok(response.ok, route + ': ' + JSON.stringify(value));
  else assert.equal(response.status, expectedStatus, route + ': ' + JSON.stringify(value));
  return value;
}
try {
  await Promise.all([workspace, profile].map(folder => fs.mkdir(folder, { mode: 0o700 }))); await fs.writeFile(path.join(workspace, 'report.txt'), original);
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + mock.address().port;
  // Old profiles may still contain the now-removed Jev choices. Loading them
  // must select System One + jev-latest without changing the API address.
  await fs.writeFile(path.join(profile, 'profiles.json'), JSON.stringify({ version: 1, agents: [], settings: { cwd: workspace },
    judge: { enabled: false, protocol: 'openai', model: 'legacy-custom-judge', baseUrl: origin + '/v1' } }), { mode: 0o600 });
  child = spawn(executable, [...(source ? [path.join(root, 'src', 'desktop.js')] : []), '--data-dir', profile, '--no-browser'], { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError; child.stdout.resume(); child.stderr.resume();
  exited = new Promise(resolve => { child.once('error', error => { spawnError = error; resolve({ error }); }); child.once('exit', code => resolve({ code })); });
  for (let attempt = 0; attempt < 200 && !instance; attempt++) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, 'Owned application stopped before startup');
    try { instance = JSON.parse(await fs.readFile(path.join(profile, 'instance.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!instance) await delay(100);
  }
  assert.equal(instance?.pid, child.pid);
  assert.equal(new URL(instance.url).hostname, '127.0.0.1');
  assert.equal((await api('/health')).version, '1.2.0');
  const initial = await api('/api/state'); assert.equal(initial.agents.length, 0); assert.equal(initial.judge.enabled, false);
  assert.equal(Object.hasOwn(initial.judge, 'mode'), false);
  assert.equal(initial.judge.protocol, 'system-one'); assert.equal(initial.judge.model, 'jev-latest');
  assert.equal(initial.judge.baseUrl, origin + '/v1');
  assert.equal(await fs.realpath(initial.dataDir), await fs.realpath(profile));
  for (const body of [{}, { enabled: true }, { enabled: false }, { enabled: false, apiKey: ' \t' }]) {
    assert.equal((await api('/api/judge', body, 'PUT', 400)).error, '尚未配置Jev密钥');
    assert.equal((await api('/api/judge')).judge.hasApiKey, false);
  }
  async function checkSavedKey(draft = {}) {
    const before = connectionChecks;
    assert.equal((await api('/api/judge/check', draft)).ok, true);
    assert.equal(connectionChecks, before + 1);
  }
  expectedJudgeKey = 'native-fixture-initial-judge';
  const normalized = await api('/api/judge', { enabled: false, protocol: 'openai', model: 'legacy-api-custom-judge', baseUrl: origin + '/v1', apiKey: expectedJudgeKey }, 'PUT');
  assert.equal(normalized.judge.protocol, 'system-one'); assert.equal(normalized.judge.model, 'jev-latest');
  await checkSavedKey();
  await checkSavedKey({ protocol: 'openai', model: 'legacy-unsaved-custom-judge', baseUrl: origin });
  assert.equal((await api('/api/judge')).judge.baseUrl, origin + '/v1', 'connection checks must not save draft settings');
  expectedJudgeKey = 'native-fixture-replaced-judge';
  await api('/api/judge', { apiKey: ' ' + expectedJudgeKey + ' ' }, 'PUT');
  await checkSavedKey();
  for (const body of [{}, { apiKey: '' }, { apiKey: ' \t\r\n' }]) {
    assert.equal((await api('/api/judge', body, 'PUT')).judge.hasApiKey, true);
    await checkSavedKey();
  }
  assert.equal((await api('/api/judge', { enabled: false, clearKey: true }, 'PUT', 400)).error, '尚未配置Jev密钥');
  assert.equal((await api('/api/judge')).judge.hasApiKey, true);
  await checkSavedKey();
  for (const model of ['teacher', 'alice', 'bob']) await api('/api/agents', { name: model, role: model === 'teacher' ? 'teacher' : 'student', model, protocol: 'messages', baseUrl: origin + '/v1', apiKey: 'native-fixture-model' });
  const savedMembers = (await api('/api/state')).agents;
  await api('/api/settings', { cwd: workspace }, 'PUT');
  // No post-run model summarization is needed for this isolated acceptance.
  await api('/api/memory/settings', { enabled: false }, 'PUT');
  for (const scenario of ['disabled', 'legacy-shadow', 'enabled', 'select-none', 'submission-only', 'fault']) {
    const allFeatures = { taskDispatch: true, toolCalls: true, toolResults: true, submissionReview: true };
    const features = scenario === 'select-none' ? Object.fromEntries(Object.keys(allFeatures).map(name => [name, false]))
      : scenario === 'submission-only' ? { taskDispatch: false, toolCalls: false, toolResults: false, submissionReview: true } : allFeatures;
    const enabled = scenario !== 'disabled';
    state = { scenario, enabled, features, applies: point => enabled && scenario !== 'fault' && features[point], studentCalls: 0, teacherCalls: 0, judgeCalls: 0 };
    const saved = await api('/api/judge', { enabled, ...(scenario === 'legacy-shadow' ? { mode: 'shadow', protocol: 'openai', model: 'legacy-scenario-judge' } : {}), baseUrl: origin + '/v1/systemone', timeoutMs: 1500, features }, 'PUT');
    assert.equal(saved.judge.hasApiKey, true); assert.equal(saved.judge.apiKey, undefined);
    assert.equal(Object.hasOwn(saved.judge, 'mode'), false);
    assert.equal(saved.judge.protocol, 'system-one'); assert.equal(saved.judge.model, 'jev-latest');
    assert.deepEqual(saved.judge.features, features);
    assert.deepEqual((await api('/api/state')).agents, savedMembers);
    const diskConfig = JSON.parse(await fs.readFile(path.join(profile, 'profiles.json'), 'utf8'));
    assert.equal(Object.hasOwn(diskConfig.judge, 'mode'), false, 'legacy mode must not persist after a settings save');
    assert.equal(diskConfig.judge.protocol, 'system-one'); assert.equal(diskConfig.judge.model, 'jev-latest');
    assert.deepEqual(diskConfig.agents.map(({ id, protocol, model }) => ({ id, protocol, model })), savedMembers.map(({ id, protocol, model }) => ({ id, protocol, model })));
    assert.equal(JSON.stringify(diskConfig).includes(expectedJudgeKey), false);
    assert.equal(JSON.stringify(diskConfig).includes('native-fixture-initial-judge'), false);
    const id = (await api('/api/runs', { task: 'Read report.txt, verify the value 42, and cite its recorded evidence.' })).run.id;
    let run;
    for (let attempt = 0; attempt < 400; attempt++) {
      run = (await api('/api/runs/' + id)).run;
      assert.equal(run.memberFailures?.length || 0, 0);
      if (!['running', 'stopping'].includes(run.status)) break;
      await delay(100);
    }
    assert.equal(run.status, 'completed', JSON.stringify(run.result));
    assert.equal(run.result.answer, 'The verified value is 42.');
    assert.ok(state.originalRecovered);
    assert.equal(state.studentCalls, 2);
    if (['disabled', 'select-none'].includes(scenario)) assert.equal(state.judgeCalls, 0);
    else assert.ok(state.judgeCalls > 0);
    assert.equal(run.judgeStats.savedChars > 0, state.applies('toolResults'));
    assert.equal(Object.hasOwn(run.judgeStats, 'mode'), false);
    assert.equal(Object.hasOwn(run.judgeStats, 'potentialSavedChars'), false);
    if (scenario === 'fault') assert.ok(run.judgeStats.rateLimited > 0);
    const evidence = await api('/api/runs/' + id + '/evidence?kind=tool&limit=100');
    const completed = evidence.records.filter(record => record.activity?.type === 'completed');
    assert.equal(completed.filter(record => record.activity.action.name === 'run_command').length, 1);
    assert.ok(JSON.stringify(completed).includes('Unrelated announcement 45'));
    assert.ok(!JSON.stringify(run).includes(expectedJudgeKey));
    results.push({ scenario, completed: true, originalRecovered: true, judgeRequests: state.judgeCalls, savedChars: run.judgeStats.savedChars });
  }
} catch (error) { failure = error; }
finally {
  mockFailure = undefined;
  if (child && child.exitCode === null && instance) try { await api('/api/shutdown', {}); } catch (error) { failure ??= error; }
  if (exited) {
    const result = await Promise.race([exited, delay(20000, null, { ref: false })]);
    if (!result) { child.kill(); failure ??= Error('Owned fixture failed to stop cleanly'); await exited; }
    else if (result.code !== 0) failure ??= Error('Owned fixture exited with an error');
  }
  for (const socket of sockets) socket.destroy();
  if (mock.listening) await new Promise(resolve => mock.close(resolve));
  const actual = await fs.realpath(directory);
  assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('class-jev-native-'));
  assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
  await fs.rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (failure) throw failure;
console.log(JSON.stringify({ version: '1.2.0', platform: process.platform, architecture: process.arch, target: source ? 'source' : path.basename(executable), fixedJudge: { protocol: 'system-one', model: 'jev-latest', legacyProfileNormalized: true, legacyApiNormalized: true, memberProtocolsPreserved: true }, keySettings: { missingKeyRejected: true, replacementUsed: true, emptyAndOmittedRetained: true, rejectedClearPreserved: true, connectionChecks }, results, cleanShutdown: true, temporaryDataRemoved: true }, null, 2));
