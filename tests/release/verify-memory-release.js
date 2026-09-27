// Isolated release verification with a real HTTP model stub. No external model
// service is called. Usage: node tests/release/verify-memory-release.js [--node | --exe executable] [--report report.json] [--check-assets]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { getReleaseDirectory } from '../../scripts/release-paths.js';
import { verificationHost, verifyNativeExecutable, defaultVerificationExecutable } from './windows-verification.js';

const argv = process.argv.slice(2), options = {};
for (let index = 0; index < argv.length; index++) {
  const option = argv[index];
  if (option === '--node') { options.node = true; continue; }
  if (option === '--check-assets') { options.checkAssets = true; continue; }
  const value = argv[++index];
  if (!['--exe', '--report'].includes(option) || !value || value.startsWith('--')) throw Error('Usage: node tests/release/verify-memory-release.js [--node | --exe executable] [--report report.json]');
  options[option.slice(2)] = path.resolve(value);
}
if (options.node && options.exe) throw Error('--node and --exe cannot be combined');
if (!options.node && !options.exe) options.exe = defaultVerificationExecutable();
const temporaryRoot = await fs.realpath(os.tmpdir());
const directory = await fs.mkdtemp(path.join(temporaryRoot, 'class-memory-release-'));
const profile = path.join(directory, 'profile'), reportPath = options.report || path.join(directory, 'verification-report.json');
const marker = 'RECALL-' + randomUUID(), sourceText = 'Release archive beacon: ' + marker + '. The user prefers concise replies citing original sources. For historical identifier recall, retrieve the original record and cite its exact reference; verify applicability before reuse.';
const report = { startedAt: new Date().toISOString(), mode: options.exe ? 'exe' : 'source', executable: options.exe, host: verificationHost(), checks: {}, modelRequests: [], cleanup: {} };
let application, mockServer, phase = 1, sourceRun, sourceReference, memorySourceReference, aliceRequests = 0, reviewRequests = 0;
const memoryIds = {};
const modelErrors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, predicate, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs; let value;
  do { if (modelErrors.length) throw Error('Mock-model verification failed: ' + modelErrors.join('; ')); value = await read(); if (predicate(value)) return value; await sleep(35); } while (Date.now() < deadline);
  throw Error(label + ': ' + JSON.stringify(value?.run ? { status: value.run.status, phase: value.run.phase, failures: value.run.memberFailures } : value));
}
function send(res, value, status = 200) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
}
function submit(id, name, args, text = '') {
  return { stop_reason: 'tool_use', content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name, input: args }] };
}
function resultFor(body, id) {
  const block = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(item => item.type === 'tool_result' && item.tool_use_id === id);
  assert.ok(block, 'Missing native tool result: ' + id);
  const result = JSON.parse(block.content); assert.notEqual(result.success, false, 'Tool failed: ' + JSON.stringify(result));
  const output = JSON.parse(result.output);
  (report.toolResults ||= []).push({ id, truncated: result.truncated, bytes: Buffer.byteLength(result.output), keys: Object.keys(output), ...(result.truncated ? { preview: result.output.slice(0, 1200) } : {}) });
  assert.equal(result.truncated, false, 'Native result must be readable: ' + id); assert.equal(output.currentEvidence, false); return output;
}
async function startModelServer() {
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/messages');
      let text = ''; for await (const chunk of req) { text += chunk.toString(); if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw Error('Unexpectedly large mock-model request'); }
      const body = JSON.parse(text), input = JSON.parse(body.messages.find(message => message.role === 'user' && typeof message.content === 'string').content);
      report.modelRequests.push({ phase, model: body.model, operation: input.type || 'task', feedbackVersion: input.feedbackVersion, memoryTools: (body.tools || []).filter(tool => /^(memory_|session_)/.test(tool.name)).map(tool => tool.name) });
      if (['extract', 'reflect'].includes(input.type) && Array.isArray(input.sources)) {
        assert.equal(body.model, 'teacher');
        const source = input.sources.find(item => item.reference.includes(sourceRun) && item.content.includes(sourceText));
        if (source) memorySourceReference = source.reference;
        return send(res, { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ memories: source ? [
          { kind: 'user', category: 'preference', content: 'The user prefers concise replies citing original sources. Release archive beacon: ' + marker, sourceRefs: [source.reference] },
          { kind: 'agent', category: 'experience', content: 'For historical identifier recall, retrieve the original record and cite its exact reference; verify applicability before reuse. Release archive beacon: ' + marker, sourceRefs: [source.reference] },
        ] : [] }) }] });
      }
      if (body.model === 'bob') return; // Class cancels this owned in-flight request during teacher review.
      if (body.model === 'teacher') {
        reviewRequests++;
        if (phase === 1) return send(res, submit('archive-review', 'submit_review', { valid: true, report: 'The requested visible result has been archived.', answer: sourceText }));
        if (reviewRequests === 1) return send(res, submit('recall-rejected', 'submit_review', { valid: false, report: 'Clarify the historical source; this is a recalled record, not new external verification.', gaps: ['Explicit source attribution'], recommendations: ['Revise the answer using the original reference already retrieved.'] }));
        assert.equal(reviewRequests, 2); assert.ok(input.answer.content.includes(marker)); assert.ok(input.answer.content.includes(sourceReference));
        return send(res, submit('recall-accepted', 'submit_review', { valid: true, report: 'The revision accurately cites the original archive.', answer: input.answer.content }));
      }
      assert.equal(body.model, 'alice'); aliceRequests++;
      if (phase === 1) {
        if (aliceRequests === 1) return send(res, { stop_reason: 'end_turn', content: [{ type: 'text', text: sourceText }] });
        return send(res, submit('archive-answer', 'submit_answer', { content: sourceText }));
      }
      for (const name of ['memory_search', 'memory_get', 'memory_assess', 'session_search', 'session_get']) assert.ok(body.tools.some(tool => tool.name === name), 'Packaged app must declare ' + name);
      if (aliceRequests === 1) return send(res, submit('release-user-search', 'memory_search', { query: 'release archive beacon', kind: 'user' }));
      if ([2, 4].includes(aliceRequests)) {
        const kind = aliceRequests === 2 ? 'user' : 'agent';
        const result = resultFor(body, `release-${kind}-search`); assert.equal(result.requiresAssessment, true);
        const found = result.data.items.find(item => item.id === memoryIds[kind]); assert.ok(found, 'Both profiles must be accessible after changing the working directory');
        assert.equal(found.kind, kind); assert.equal(found.agentId, null); assert.equal(found.status, 'active'); assert.ok(found.snippet.includes(marker)); assert.deepEqual(found.sourceRefs, [memorySourceReference]); assert.ok(Number.isFinite(Date.parse(found.createdAt)));
        assert.ok(result.data.items.every(item => item.kind === kind));
        report.checks[kind === 'user' ? 'nativeUserProfileSearch' : 'nativeAgentProfileSearch'] = true;
        return send(res, submit(`release-${kind}-get`, 'memory_get', { id: memoryIds[kind] }));
      }
      if ([3, 5].includes(aliceRequests)) {
        const kind = aliceRequests === 3 ? 'user' : 'agent';
        const result = resultFor(body, `release-${kind}-get`); assert.equal(result.requiresAssessment, true); assert.equal(result.data.id, memoryIds[kind]); assert.equal(result.data.kind, kind);
        assert.ok(result.data.content.includes(marker)); assert.deepEqual(result.data.sourceRefs, [memorySourceReference]); assert.ok(Number.isFinite(Date.parse(result.data.updatedAt)));
        report.checks[kind === 'user' ? 'nativeUserProfileGet' : 'nativeAgentProfileGet'] = true;
        if (kind === 'user') return send(res, submit('release-agent-search', 'memory_search', { query: 'release archive beacon', kind: 'agent' }));
        return send(res, submit('release-search', 'session_search', { query: 'release archive beacon', sessionId: sourceRun, limit: 100 }));
      }
      if (aliceRequests === 6) {
        const result = resultFor(body, 'release-search');
        const hit = result.data.items.find(item => item.reference === memorySourceReference && item.text.includes(sourceText));
        assert.ok(hit, 'Original memory source must be found by the actual native history tool'); assert.equal(hit.sessionId, sourceRun);
        sourceReference = hit.reference; report.checks.nativeSessionSearch = true; report.sourceReference = sourceReference;
        return send(res, submit('release-get', 'session_get', { reference: sourceReference }));
      }
      if (aliceRequests === 7) {
        const result = resultFor(body, 'release-get'); assert.equal(result.data.session.id, sourceRun);
        assert.ok(result.data.items.some(record => record.reference === sourceReference && record.text.includes(marker)));
        report.checks.nativeSessionGet = true;
        return send(res, submit('release-user-assess', 'memory_assess', { id: memoryIds.user, verdict: 'usable', reason: 'The archived preference has a dated original source and fits this request for a concise cited answer; the workspace change alone does not invalidate it.', sourceRefs: [sourceReference] }));
      }
      if ([8, 9].includes(aliceRequests)) {
        const kind = aliceRequests === 8 ? 'user' : 'agent';
        const result = resultFor(body, `release-${kind}-assess`); assert.equal(result.requiresAssessment, false); assert.equal(result.currentEvidence, false);
        assert.equal(result.data.assessment.verdict, 'usable'); assert.equal(result.data.assessment.verifiedCurrentFact, false); assert.equal(result.data.assessment.appliedToMemory, false);
        if (kind === 'user') return send(res, submit('release-agent-assess', 'memory_assess', { id: memoryIds.agent, verdict: 'usable', reason: 'The source documents a retrieval-and-citation method whose assumptions match this historical recall task in the new workspace; this is not a universal factual claim or current external verification.', sourceRefs: [sourceReference] }));
        report.checks.nativeMemoryAssessment = true;
        return send(res, submit('recall-answer-one', 'submit_answer', { content: 'The previous identifier is ' + marker + '.' }));
      }
      assert.equal(aliceRequests, 10); assert.equal(input.feedbackVersion, 1);
      report.checks.studentResumedAfterRejection = true;
      return send(res, submit('recall-answer-two', 'submit_answer', { content: 'The identifier in the original archived conversation is ' + marker + '. Historical source: ' + sourceReference + '.' }));
    } catch (error) { modelErrors.push(error.message); send(res, { type: 'error', error: { type: 'mock_assertion', message: error.message } }, 500); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}
async function api(endpoint, method = 'GET', body) {
  const response = await fetch(application.url + endpoint, { method, headers: { Authorization: 'Bearer ' + application.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const value = await response.json(); assert.ok(response.ok, endpoint + ': ' + JSON.stringify(value)); return value;
}
async function startApplication() {
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  if (!options.exe) {
    const { createClassServer } = await import('../../src/web-server.js');
    const token = 'isolated-release-' + randomUUID(), app = await createClassServer({ dataDir: profile, token });
    return { url: app.url, token, close: () => app.close() };
  }
  const child = spawn(options.exe, ['--data-dir', profile, '--no-browser'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exit, error, output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-10000); });
  const exited = new Promise(resolve => { child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }); child.once('error', failure => { error = failure; resolve(); }); });
  async function close() {
    let acknowledged = false;
    if (!exit && !error) {
      try { const response = await fetch(application.url + '/api/shutdown', { method: 'POST', headers: { Authorization: 'Bearer ' + application.token }, signal: AbortSignal.timeout(10000) }); acknowledged = response.ok; } catch {}
      let timer;
      try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 15000); })]); }
      finally { clearTimeout(timer); }
      if (!exit && !error) { child.kill(); await exited; report.cleanup.forcedOwnedChildStop = true; }
    }
    (report.cleanup.processes ||= []).push({ pid: child.pid, shutdownAcknowledged: acknowledged, exit });
  }
  try {
    const instance = await waitFor(async () => {
      if (error) throw error;
      if (exit) throw Error('EXE exited before readiness: ' + JSON.stringify(exit) + ' ' + output);
      try { const value = JSON.parse(await fs.readFile(path.join(profile, 'instance.json'), 'utf8')); return value.pid === child.pid ? value : null; } catch (failure) { if (failure.code === 'ENOENT' || failure instanceof SyntaxError) return null; throw failure; }
    }, value => value?.url && value?.token, 'EXE readiness');
    return { url: instance.url.replace(/\/$/, ''), token: instance.token, close };
  } catch (failure) { if (!exit && !error) { child.kill(); await exited; } throw failure; }
}

try {
  if (options.exe) { const bytes = await fs.readFile(options.exe); report.artifact = verifyNativeExecutable(bytes, report.host); report.executableSha256 = createHash('sha256').update(bytes).digest('hex'); report.executableBytes = bytes.length; }
  mockServer = await startModelServer();
  application = await startApplication();
  if (options.checkAssets) {
    for (const [route, type] of [['/', 'text/html'], ['/app.js', 'javascript'], ['/style.css', 'text/css']]) {
      const asset = await fetch(application.url + route, { signal: AbortSignal.timeout(10000) });
      assert.equal(asset.status, 200, 'Copied application must serve embedded ' + route); assert.ok(asset.headers.get('content-type')?.includes(type));
      assert.ok((await asset.arrayBuffer()).byteLength > 200, 'Embedded asset must not be empty: ' + route);
    }
    report.assetsVerified = true;
  }
  const baseUrl = 'http://127.0.0.1:' + mockServer.address().port + '/v1';
  for (const [model, role] of [['teacher', 'teacher'], ['alice', 'student'], ['bob', 'student']]) await api('/api/agents', 'POST', { name: model, model, role, protocol: 'messages', baseUrl, apiKey: 'isolated-memory-release-fake-key' });
  const initialStatus = await api('/api/memory/status'); assert.equal(initialStatus.available, true); assert.equal(initialStatus.autoExtract, true);
  sourceRun = (await api('/api/runs', 'POST', { task: 'I prefer concise replies citing original sources. Demonstrate retrieving and citing an original record for historical identifier recall, and record a visible result for a later session.' })).run.id;
  const first = await waitFor(() => api('/api/state'), state => state.run?.id === sourceRun && !['running', 'stopping'].includes(state.run.status), 'first task completion');
  assert.equal(first.run.status, 'completed'); report.checks.firstTaskCompleted = true; report.sourceRun = sourceRun;
  const extracted = await waitFor(() => api('/api/memory/entries'), value => ['user', 'agent'].every(kind => value.items?.some(item => item.kind === kind && item.status === 'active' && item.content.includes(marker))), 'both automatic profile types without manual confirmation');
  for (const kind of ['user', 'agent']) {
    const memory = extracted.items.find(item => item.kind === kind && item.status === 'active' && item.content.includes(marker)); memoryIds[kind] = memory.id;
    assert.deepEqual(memory.sourceRefs, [memorySourceReference]); assert.equal(memory.agentId, null);
  }
  report.memoryIds = memoryIds; report.checks.automaticMemoryActivated = true;
  await application.close(); application = undefined;
  application = await startApplication(); phase = 2; aliceRequests = 0; reviewRequests = 0;
  const secondWorkspace = path.join(profile, 'different-workspace'); await fs.mkdir(secondWorkspace, { recursive: true });
  assert.notEqual(path.resolve(first.run.cwd), secondWorkspace);
  const changed = await api('/api/settings', 'PUT', { cwd: secondWorkspace }); assert.equal(changed.settings.cwd, secondWorkspace);
  report.checks.workingDirectoryChanged = true;
  await waitFor(() => api('/api/memory/sessions/search', 'POST', { query: 'release archive beacon', sessionId: sourceRun, kind: 'conversation', limit: 100 }), result => result.items?.some(item => item.role === 'assistant' && item.text.includes(sourceText)), 'restarted archive index');
  report.checks.visibleReplySurvivedRestart = true;
  const recallRun = (await api('/api/runs', 'POST', { task: 'Retrieve the earlier release archive beacon identifier and cite its exact historical source.' })).run.id;
  const second = await waitFor(() => api('/api/state'), state => state.run?.id === recallRun && !['running', 'stopping'].includes(state.run.status), 'recall task completion');
  assert.deepEqual(modelErrors, []); assert.equal(second.run.status, 'completed'); assert.equal(second.run.reviewRound, 2); assert.equal(second.run.feedbackVersion, 1);
  assert.equal(second.run.cwd, secondWorkspace); assert.equal(reviewRequests, 2); assert.equal(aliceRequests, 10); assert.ok(second.run.result.answer.includes(marker)); assert.ok(second.run.result.answer.includes(sourceReference));
  report.checks.teacherRejectedThenAcceptedRevision = true; report.recallRun = recallRun;
  const journal = (await fs.readFile(path.join(profile, 'history', recallRun, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const tools = journal.filter(record => record.kind === 'tool' && record.activity?.type === 'completed').map(record => record.activity.action.name);
  assert.deepEqual(tools, ['memory_search', 'memory_get', 'memory_search', 'memory_get', 'session_search', 'session_get', 'memory_assess', 'memory_assess']); report.checks.actualToolJournalVerified = true; report.completedTools = tools;
  report.passed = Object.values(report.checks).every(Boolean) && Object.keys(report.checks).length === 14;
} catch (error) { report.passed = false; report.error = error.stack || error.message; process.exitCode = 1; }
finally {
  try { await application?.close(); } catch (error) { report.cleanup.error = error.message; report.passed = false; process.exitCode = 1; }
  if (mockServer) { await new Promise(resolve => { mockServer.close(resolve); mockServer.closeAllConnections?.(); }); report.cleanup.mockServerClosed = true; }
  try {
    const parent = await fs.realpath(directory); assert.equal(path.dirname(parent), temporaryRoot); assert.ok(path.basename(parent).startsWith('class-memory-release-'));
    const ownedProfile = await fs.realpath(profile); assert.equal(path.dirname(ownedProfile), parent); assert.equal(path.basename(ownedProfile), 'profile');
    await fs.rm(ownedProfile, { recursive: true, force: true }); report.cleanup.isolatedProfileRemoved = true;
  } catch (error) { if (error.code !== 'ENOENT') { report.cleanup.error = error.message; report.passed = false; process.exitCode = 1; } }
  report.modelErrors = modelErrors; report.finishedAt = new Date().toISOString();
  if (report.cleanup.forcedOwnedChildStop) { report.passed = false; process.exitCode = 1; }
  await fs.mkdir(path.dirname(reportPath), { recursive: true }); await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, mode: report.mode, checks: report.checks, cleanup: report.cleanup, report: reportPath, ...(report.error ? { error: report.error } : {}) }, null, 2));
}
