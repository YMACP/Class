// Native Linux platform acceptance against a disposable profile and HTTP stub.
// Closes only the zenity/kdialog window owned by the isolated application.
// Usage: node tests/release/verify-linux-platform.js [--node | --exe executable] [--report file]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getReleaseDirectory } from '../../scripts/release-paths.js';
import { verificationHost, verifyNativeExecutable, defaultVerificationExecutable } from './windows-verification.js';
import { linuxProcess, linuxDirectChildren, captureLinuxChild, stopLinuxOwnedTree } from './linux-process.js';
import { loadSecrets } from '../../src/secret-store.js';
import { verifyConcurrentInitialCredentialSaves, verifyUnsafeCredentialPermissions, verifyCredentialSymlinkRejection } from '../helpers/linux-secret-scenarios.js';
import { linuxMigrationScenarios } from '../helpers/linux-migration-scenarios.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--node') { options.node = true; continue; }
  const key = args[i], value = args[++i];
  if (!['--exe', '--report'].includes(key) || !value || value.startsWith('--')) throw Error('Usage: node tests/release/verify-linux-platform.js [--node | --exe executable] [--report file]');
  options[key.slice(2)] = path.resolve(value);
}
assert.ok(!(options.node && options.exe), '--node and --exe cannot be combined');
const executable = options.node ? process.execPath : options.exe || defaultVerificationExecutable();
const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-linux-platform-'));
const anchor = path.join(directory, 'profile'), childTemp = path.join(directory, 'tmp'), destination = path.join(directory, 'moved-profile');
const credentialScenarios = path.join(directory, 'credential-scenarios');
const reportFile = options.report || path.join(directory, 'verification-report.json');
const report = { startedAt: new Date().toISOString(), mode: options.node ? 'source' : 'exe', executable, host: verificationHost(), freshVm: false, checks: {}, cleanup: {}, modelRequests: 0 };
const fakeKey = 'class-platform-local-fixture-key';
let profile = anchor, application, mock, modelFailure, mode = 'pause', aliceRequest, reviewRequest, bobCalls = 0, bobCompleted = false, reviews = 0, commandSequence = 0;
const shQuote = text => "'" + text.replaceAll("'", "'\"'\"'") + "'";
const inside = (root, target) => { const rel = path.relative(root, target); return !rel || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
async function waitFor(read, predicate, label, timeout = 30000) {
  const end = Date.now() + timeout; let value;
  do { if (modelFailure) throw modelFailure; value = await read(); if (predicate(value)) return value; await delay(50); } while (Date.now() < end);
  throw Error('Timed out: ' + label);
}
async function api(route, method = 'GET', body, signal) {
  const response = await fetch(application.url + route, { method, headers: { Authorization: 'Bearer ' + application.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal || AbortSignal.timeout(30000) });
  const value = await response.json(); assert.ok(response.ok, route + ': HTTP ' + response.status + ' ' + JSON.stringify(value)); return value;
}
function answer(response, name, input) {
  assert.ok(response && !response.destroyed && !response.writableEnded, 'Expected a live owned model request');
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: 'platform-' + ++commandSequence, type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call-' + commandSequence, name, input }] }));
}
function textAnswer(response, value) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }] })); }
function candidate(response, revised = false) { answer(response, 'submit_answer', { content: revised ? 'The owned command resumed and completed after review.' : 'The owned command is running; verify suspension before accepting.', evidence: 'Disposable local shell heartbeat.', completionClaims: [], remainingIssues: [] }); }
function judgement(valid) { const pending = reviewRequest; reviewRequest = undefined; answer(pending, 'submit_review', { valid, ...(valid ? { answer: 'The owned command resumed and completed after review.' } : {}), report: valid ? 'Resumed command completion verified.' : 'Wait for command completion, then revise the final answer.', verifiedFacts: ['The command was paused during review.'], gaps: valid ? [] : ['Command has not finished.'], recommendations: valid ? [] : ['Resume and wait for the existing command.'], evidenceRefs: [] }); }
async function size(filename) { try { return (await fs.stat(filename)).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } }
async function readJournal(runId) { return (await fs.readFile(path.join(profile, 'history', runId, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
async function runLocal(command, argv, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', diagnostic = '', failure;
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); }); child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); }); child.once('error', error => { failure = error; });
    const timer = setTimeout(() => { failure = Error('Owned Linux test helper timed out'); child.kill('SIGKILL'); }, timeout);
    child.once('close', code => { clearTimeout(timer); if (failure || code !== 0) reject(failure || Object.assign(Error(command + ' failed: ' + diagnostic), { exitCode: code })); else resolve(output.trim()); });
  });
}
async function startApplication() {
  const child = spawn(executable, [...(options.node ? [path.join(sourceRoot, 'src', 'desktop.js')] : []), '--data-dir', anchor, '--no-browser'], { cwd: directory, env: { ...process.env, TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp }, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exit, error, output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
  const exited = new Promise(resolve => { child.once('error', failure => { error = failure; resolve(); }); child.once('close', (code, signal) => { exit = { code, signal }; resolve(exit); }); });
  const app = { child, exited, get exit() { return exit; } }; application = app;
  const instance = await waitFor(async () => {
    if (error) throw error; if (exit) throw Error('Owned application exited before readiness: ' + JSON.stringify(exit) + ' ' + output);
    try { const record = JSON.parse(await fs.readFile(path.join(profile, 'instance.json'), 'utf8')); return record.pid === child.pid ? record : null; } catch (failure) { if (failure.code === 'ENOENT' || failure instanceof SyntaxError) return null; throw failure; }
  }, value => value?.url && value?.token, 'application readiness');
  const url = new URL(instance.url); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
  Object.assign(app, { url: instance.url.replace(/\/$/, ''), token: instance.token, identity: await captureLinuxChild(child) });
  assert.equal(await fs.realpath((await api('/api/state')).dataDir), await fs.realpath(profile));
}
async function closeApplication() {
  const app = application; if (!app) return;
  let acknowledged = false;
  try {
    if (!app.exit && app.url) acknowledged = (await api('/api/shutdown', 'POST')).readyToExit === true;
    let timer; try { await Promise.race([app.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned application did not exit')), 20000); })]); } finally { clearTimeout(timer); }
  } finally {
    if (!app.exit) {
      await stopLinuxOwnedTree(app.identity);
      await app.exited; report.cleanup.forcedOwnedProcessStop = true;
    }
    (report.cleanup.processes ||= []).push({ pid: app.child.pid, shutdownAcknowledged: acknowledged, exit: app.exit }); application = undefined;
  }
  assert.equal(acknowledged, true); assert.deepEqual(app.exit, { code: 0, signal: null });
}
async function verifyPicker(workspace) {
  assert.ok(process.env.DISPLAY, 'Linux native dialog acceptance requires an X11 desktop/Xvfb; do not skip this check');
  const controller = new AbortController(); let pickerFailure;
  const pending = api('/api/directories/pick', 'POST', { initialPath: workspace }, controller.signal); pending.catch(error => { pickerFailure = error; });
  try {
    const picker = await waitFor(async () => {
      if (pickerFailure) throw pickerFailure;
      for (const child of await linuxDirectChildren(application.child.pid)) {
        try { if (['zenity', 'kdialog'].includes(path.basename(await fs.readlink('/proc/' + child.pid + '/exe')))) return child; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return null;
    }, Boolean, 'owned zenity/kdialog child');
    const windowId = await waitFor(async () => {
      if (pickerFailure) throw pickerFailure;
      try { return (await runLocal('xdotool', ['search', '--all', '--onlyvisible', '--pid', String(picker.pid), '--name', '^Class - Select directory$'])).split(/\s+/)[0]; }
      catch (error) { if (error.exitCode === 1) return null; throw error; }
    }, value => /^\d+$/.test(value || ''), 'visible owned native dialog');
    assert.equal(Number(await runLocal('xdotool', ['getwindowpid', windowId])), picker.pid);
    const current = await linuxProcess(picker.pid); assert.equal(current?.started, picker.started); assert.equal(current?.parent, application.child.pid);
    // windowclose destroys the X window and can crash GTK during rendering.
    // Deliver a normal Cancel key only to the verified owned dialog instead.
    await runLocal('xdotool', ['key', '--window', windowId, 'Escape']);
    assert.deepEqual(await pending, { cancelled: true });
    report.directoryPicker = { opened: true, cancelled: true, cancelMethod: 'xdotool Escape to verified owned PID/window', pid: picker.pid };
    report.checks.nativeDirectoryDialogOpenedAndCancelled = true;
  } finally { controller.abort(); await pending.catch(() => {}); }
}
async function privateCredentials(directory) {
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  for (const name of ['credentials.key', 'credentials.aesgcm.json']) {
    const stat = await fs.lstat(path.join(directory, name)); assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.uid, process.geteuid()); assert.equal(stat.nlink, 1);
  }
  const key = await fs.readFile(path.join(directory, 'credentials.key')); assert.equal(key.length, 32); return key;
}


try {
  assert.equal(process.platform, 'linux', 'Linux platform acceptance requires Linux');
  if (!options.node) report.artifact = verifyNativeExecutable(await fs.readFile(executable), report.host);
  await fs.mkdir(credentialScenarios, { mode: 0o700 });
  await verifyConcurrentInitialCredentialSaves(credentialScenarios); report.checks.concurrentInitialCredentialSaves = true;
  await verifyUnsafeCredentialPermissions(credentialScenarios); report.checks.unsafeCredentialPermissionsRejected = true;
  await verifyCredentialSymlinkRejection(credentialScenarios); report.checks.credentialSymlinksRejected = true;
  report.directoryPermissionChecks = {};
  for (const scenario of linuxMigrationScenarios) {
    await scenario.run(credentialScenarios);
    report.directoryPermissionChecks[scenario.name] = true;
  }
  assert.equal(Object.keys(report.directoryPermissionChecks).length, 8);
  await fs.mkdir(childTemp); await fs.mkdir(anchor, { mode: 0o700 }); await startApplication();
  const initial = await api('/api/state'), workspace = initial.settings.cwd;
  assert.ok(inside(anchor, workspace));
  await verifyPicker(workspace);
  mock = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/messages');
      assert.equal(request.headers['x-api-key'], fakeKey, 'Persisted credential did not reach the local stub'); report.modelRequests++;
      const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body.tools?.length) {
        const input = (body.messages || []).filter(item => item.role === 'user' && typeof item.content === 'string').map(item => { try { return JSON.parse(item.content); } catch { return null; } }).find(item => item?.check || ['extract', 'reflect'].includes(item?.type));
        assert.ok(input); textAnswer(response, input.check ? { ok: true } : { memories: [] }); return;
      }
      if (body.model === 'platform-alice') { assert.ok(!aliceRequest, 'Duplicate pending Alice request'); aliceRequest = response; return; }
      if (body.model === 'platform-teacher') { assert.ok(!reviewRequest); reviews++; reviewRequest = response; return; }
      assert.equal(body.model, 'platform-bob');
      if (bobCalls++ === 0) {
        const ticks = path.join(workspace, mode + '-ticks.txt'), finish = path.join(workspace, 'finish.txt');
        const childScript = `printf '%s' "$$" > ${shQuote(path.join(workspace, mode + '-child-pid.txt'))}; while ${mode === 'pause' ? `[ ! -f ${shQuote(finish)} ]` : 'true'}; do printf x >> ${shQuote(ticks)}; /bin/sleep 0.1; done`;
        const script = `printf '%s' "$$" > ${shQuote(path.join(workspace, mode + '-pid.txt'))}\nbash --noprofile --norc -c ${shQuote(childScript)}\nprintf 'owned-command-completed'`;
        answer(response, 'run_command', { command: script, shell: 'bash', cwd: '.' }); return;
      }
      const resultBlock = body.messages.flatMap(item => Array.isArray(item.content) ? item.content : []).find(item => item.type === 'tool_result');
      assert.ok(resultBlock && !resultBlock.is_error, 'Owned command must return a successful native tool result');
      const resultText = typeof resultBlock.content === 'string' ? resultBlock.content : resultBlock.content.find(item => item.type === 'text').text;
      const result = JSON.parse(resultText); assert.equal(result.success, true); assert.equal(result.executionStatus, 'completed'); assert.match(result.output, /owned-command-completed/); bobCompleted = true;
      // Keep Bob's next request pending. Only Alice submits the revised candidate.
    } catch (error) { modelFailure = error; if (!response.headersSent) response.writeHead(500); response.end('Local platform fixture failed'); }
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + mock.address().port + '/v1', agents = [];
  for (const [name, role] of [['teacher', 'teacher'], ['alice', 'student'], ['bob', 'student']]) agents.push((await api('/api/agents', 'POST', { name, model: 'platform-' + name, role, baseUrl, protocol: 'messages', apiKey: fakeKey })).agent);
  const envelope = await fs.readFile(path.join(profile, 'credentials.aesgcm.json'), 'utf8');
  assert.equal(JSON.parse(envelope).version, 1); assert.equal(JSON.parse(envelope).protection, 'local-key-aes-256-gcm'); const originalKey = await privateCredentials(profile); assert.ok(JSON.parse(envelope).blob.length > 40); assert.ok(!envelope.includes(fakeKey));
  assert.ok(!(await fs.readFile(path.join(profile, 'profiles.json'), 'utf8')).includes(fakeKey)); report.checks.credentialsStoredAsPrivateAesGcmEnvelope = true;
  await closeApplication(); await startApplication();
  for (const agent of agents) assert.equal((await api('/api/agents/' + agent.id + '/check', 'POST')).ok, true);
  report.checks.credentialsDecryptAfterRestart = true;
  const runId = (await api('/api/runs', 'POST', { task: 'Verify the owned shell heartbeat pauses during review and resumes after rejection.' })).run.id;
  const ticks = path.join(workspace, 'pause-ticks.txt');
  await waitFor(() => size(ticks), bytes => bytes >= 3, 'owned shell heartbeat');
  await waitFor(() => aliceRequest, Boolean, 'Alice candidate request'); candidate(aliceRequest); aliceRequest = undefined;
  await waitFor(() => reviewRequest, Boolean, 'teacher review after pause');
  await delay(200); const pausedSize = await size(ticks); await delay(700); assert.equal(await size(ticks), pausedSize, 'Shell must be frozen while the teacher is reviewing'); const pausedRootPid = Number(await fs.readFile(path.join(workspace, 'pause-pid.txt'), 'utf8')), pausedChildPid = Number(await fs.readFile(path.join(workspace, 'pause-child-pid.txt'), 'utf8'));
  assert.notEqual(pausedRootPid, pausedChildPid); const pausedRoot = await linuxProcess(pausedRootPid), pausedChild = await linuxProcess(pausedChildPid);
  assert.equal(pausedRoot?.state, 'T'); assert.equal(pausedChild?.state, 'T'); assert.equal(pausedRoot.group, pausedRootPid); assert.equal(pausedChild.group, pausedRootPid);
  report.checks.shellPausedDuringReview = true;
  judgement(false);
  await waitFor(() => size(ticks), bytes => bytes > pausedSize, 'shell resumes after rejection'); report.checks.shellResumedAfterRejection = true;
  await fs.writeFile(path.join(workspace, 'finish.txt'), 'finish');
  await waitFor(() => bobCompleted, Boolean, 'original command completion after resume');
  await waitFor(() => aliceRequest, Boolean, 'Alice revision request'); candidate(aliceRequest, true); aliceRequest = undefined;
  await waitFor(() => reviewRequest, Boolean, 'second teacher review'); judgement(true);
  const finished = await waitFor(() => api('/api/runs/' + runId), value => !['running', 'stopping'].includes(value.run.status), 'reviewed task completion');
  assert.equal(finished.run.status, 'completed'); assert.equal(reviews, 2); assert.equal(finished.run.reviewRound, 2);
  const pauseJournal = await readJournal(runId);
  assert.equal(pauseJournal.filter(row => row.kind === 'tool' && row.activity?.type === 'spawned' && row.activity.action?.name === 'run_command').length, 1, 'Review must resume the same command without spawning a replacement');
  report.checks.originalShellCommandCompletedOnce = true;
  mode = 'cancel'; bobCalls = 0; bobCompleted = false; aliceRequest = undefined; reviewRequest = undefined;
  const cancelRun = (await api('/api/runs', 'POST', { task: 'Run an owned heartbeat until this isolated task is stopped.' })).run.id;
  const cancelTicks = path.join(workspace, 'cancel-ticks.txt'); await waitFor(() => size(cancelTicks), bytes => bytes >= 3, 'cancellable shell heartbeat');
  await api('/api/runs/' + cancelRun + '/stop', 'POST');
  const stopped = await waitFor(() => api('/api/runs/' + cancelRun), value => !['running', 'stopping'].includes(value.run.status), 'task stop'); assert.equal(stopped.run.status, 'stopped');
  const stoppedSize = await size(cancelTicks); await delay(700); assert.equal(await size(cancelTicks), stoppedSize, 'Stopped command must no longer write');
  const cancellationJournal = await readJournal(cancelRun); assert.ok(cancellationJournal.some(row => row.kind === 'tool' && (row.activity?.executionStatus === 'cancelled' || row.activity?.result?.executionStatus === 'cancelled')));
  const cancelledPid = Number(await fs.readFile(path.join(workspace, 'cancel-pid.txt'), 'utf8')); assert.ok(Number.isSafeInteger(cancelledPid) && cancelledPid > 0);
  const cancelledChild = Number(await fs.readFile(path.join(workspace, 'cancel-child-pid.txt'), 'utf8'));
  await waitFor(async () => [await linuxProcess(cancelledPid), await linuxProcess(cancelledChild)], states => states.every(state => !state), 'cancelled process group exit and reap');
  report.checks.shellStopCancelsAndReapsProcess = true;
  const before = await fs.readFile(path.join(profile, 'history', runId, 'journal.jsonl'));
  // A directory chosen in the desktop picker already exists. Reproduce an
  // ordinary user-created directory instead of only testing a missing path.
  await fs.mkdir(destination, { mode: 0o755 }); await fs.chmod(destination, 0o755);
  assert.deepEqual(await fs.readdir(destination), []);
  const destinationBefore = await fs.lstat(destination);
  assert.equal(destinationBefore.mode & 0o777, 0o755); assert.equal(destinationBefore.uid, process.geteuid());
  const moved = await api('/api/data-directory', 'PUT', { path: destination }); assert.equal(moved.dataDir, destination); profile = destination;
  assert.equal(moved.settings.cwd, path.join(destination, 'workspace')); assert.deepEqual(await privateCredentials(profile), originalKey);
  report.migrationTarget = { existedBeforeMigration: true, emptyBeforeMigration: true, modeBefore: '0755', modeAfter: '0700' };
  assert.deepEqual(await fs.readFile(path.join(profile, 'history', runId, 'journal.jsonl')), before);
  assert.deepEqual(await fs.readFile(path.join(anchor, 'history', runId, 'journal.jsonl')), before, 'Migration must preserve source data');
  const expectedSecrets = Object.fromEntries(agents.map(agent => [agent.id, fakeKey]));
  assert.deepEqual(await loadSecrets(anchor), expectedSecrets, 'Migration must preserve independently decryptable source credentials');
  assert.deepEqual(await loadSecrets(profile), expectedSecrets, 'Migration destination must independently decrypt the same fixture credentials');
  report.checks.migrationSourceCredentialsPreserved = true;
  await closeApplication(); await startApplication();
  assert.equal((await api('/api/runs/' + runId)).run.status, 'completed');
  assert.equal((await api('/api/agents/' + agents[0].id + '/check', 'POST')).ok, true);
  await waitFor(() => api('/api/memory/sessions'), value => value.items?.some(item => item.id === runId), 'migrated memory source index');
  assert.equal((await fs.readFile(path.join(profile, 'memory', 'memory.sqlite'))).subarray(0, 16).toString(), 'SQLite format 3\0'); report.checks.sqlitePersistenceAcrossRestart = true;
  report.checks.migrationPreservesArchiveAndCredentials = true;
  report.checks.originalAnchorRestartsMigratedProfile = true;
  assert.equal(Object.keys(report.checks).length, 14);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack || error.message; process.exitCode = 1; }
finally {
  try { await closeApplication(); } catch (error) { report.cleanup.error = error.message; report.passed = false; process.exitCode = 1; }
  if (mock) { await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections?.(); }); report.cleanup.mockServerClosed = true; }
  try {
    const resolved = await fs.realpath(directory); assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('class-linux-platform-')); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    for (const target of [anchor, destination, childTemp, credentialScenarios]) {
      try { const actual = await fs.realpath(target); assert.equal(path.dirname(actual), resolved); assert.equal((await fs.lstat(target)).isSymbolicLink(), false); await fs.rm(actual, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    report.cleanup.isolatedFilesRemoved = true;
  } catch (error) { report.cleanup.error = error.message; report.passed = false; process.exitCode = 1; }
  if (report.cleanup.forcedOwnedProcessStop) { report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await fs.mkdir(path.dirname(reportFile), { recursive: true }); await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, host: report.host, checks: report.checks, directoryPermissionChecks: report.directoryPermissionChecks, migrationTarget: report.migrationTarget, cleanup: report.cleanup, report: reportFile, ...(report.error ? { error: report.error } : {}) }, null, 2));
}
