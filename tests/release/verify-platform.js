// Native Windows platform acceptance against a disposable profile and HTTP stub.
// Opens and cancels only the folder dialog owned by this verifier's application.
// Usage: node tests/release/verify-platform.js [--node | --exe executable] [--report file]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getReleaseDirectory } from '../../scripts/release-paths.js';
import { verificationHost, verifyNativeExecutable } from './windows-verification.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--node') { options.node = true; continue; }
  const key = args[i], value = args[++i];
  if (!['--exe', '--report'].includes(key) || !value || value.startsWith('--')) throw Error('Usage: node tests/release/verify-platform.js [--node | --exe executable] [--report file]');
  options[key.slice(2)] = path.resolve(value);
}
assert.ok(!(options.node && options.exe), '--node and --exe cannot be combined');
const executable = options.node ? process.execPath : options.exe || path.join(getReleaseDirectory(), 'Class.exe');
const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-platform-release-'));
const anchor = path.join(directory, 'profile'), childTemp = path.join(directory, 'tmp'), destination = path.join(directory, 'moved-profile');
const reportFile = options.report || path.join(directory, 'verification-report.json');
const report = { startedAt: new Date().toISOString(), mode: options.node ? 'source' : 'exe', executable, host: verificationHost(), freshVm: false, checks: {}, cleanup: {}, modelRequests: 0 };
const fakeKey = 'class-platform-local-fixture-key';
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
let profile = anchor, application, mock, modelFailure, mode = 'pause', aliceRequest, reviewRequest, bobCalls = 0, bobCompleted = false, reviews = 0, commandSequence = 0;
const psQuote = text => "'" + text.replaceAll("'", "''") + "'";
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
async function runPowerShell(script, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from("$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new();\n" + script, 'utf16le').toString('base64');
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errorOutput = '', failure;
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); }); child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-2000); });
    child.once('error', error => { failure = error; });
    const timer = setTimeout(() => { failure = Error('Owned Windows verification helper timed out'); child.kill(); }, timeout);
    child.once('close', code => { clearTimeout(timer); if (failure || code !== 0) reject(failure || Error('Windows helper failed: ' + errorOutput)); else resolve(output.trim()); });
  });
}
async function startApplication() {
  const child = spawn(executable, [...(options.node ? [path.join(sourceRoot, 'src', 'desktop.js')] : []), '--data-dir', anchor, '--no-browser'], { cwd: directory, env: { ...process.env, TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exit, error, output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
  const exited = new Promise(resolve => { child.once('error', failure => { error = failure; resolve(); }); child.once('close', (code, signal) => { exit = { code, signal }; resolve(exit); }); });
  const app = { child, exited, get exit() { return exit; } }; application = app;
  const instance = await waitFor(async () => {
    if (error) throw error; if (exit) throw Error('Owned application exited before readiness: ' + JSON.stringify(exit) + ' ' + output);
    try { const record = JSON.parse(await fs.readFile(path.join(profile, 'instance.json'), 'utf8')); return record.pid === child.pid ? record : null; } catch (failure) { if (failure.code === 'ENOENT' || failure instanceof SyntaxError) return null; throw failure; }
  }, value => value?.url && value?.token, 'application readiness');
  const url = new URL(instance.url); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
  Object.assign(app, { url: instance.url.replace(/\/$/, ''), token: instance.token });
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
      // Recheck parent and the unique profile argument before forced cleanup;
      // a reused process ID must never authorize stopping unrelated work.
      await runPowerShell(`$ErrorActionPreference='Stop'; $owned=Get-CimInstance Win32_Process -Filter "ProcessId = ${app.child.pid}"; if($owned) { if($owned.ParentProcessId -ne ${process.pid} -or -not $owned.CommandLine.Contains(${psQuote(anchor)})) { throw 'Owned application identity changed; refusing forced cleanup' }; & "$env:SystemRoot\\System32\\taskkill.exe" /PID $owned.ProcessId /T /F | Out-Null }`);
      await app.exited; report.cleanup.forcedOwnedProcessStop = true;
    }
    (report.cleanup.processes ||= []).push({ pid: app.child.pid, shutdownAcknowledged: acknowledged, exit: app.exit }); application = undefined;
  }
  assert.equal(acknowledged, true); assert.deepEqual(app.exit, { code: 0, signal: null });
}
async function verifyPicker(workspace) {
  const controller = new AbortController();
  const pending = api('/api/directories/pick', 'POST', { initialPath: workspace }, controller.signal); pending.catch(() => {});
  try {
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;
      $deadline=[DateTime]::UtcNow.AddSeconds(20); $owned=$null; $window=$null;
      while([DateTime]::UtcNow -lt $deadline -and -not $window) {
        $owned=Get-CimInstance Win32_Process -Filter "ParentProcessId = ${application.child.pid} AND Name = 'Class.FolderPicker.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${psQuote(childTemp + path.sep)},[StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1;
        if($owned) {
          $condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$owned.ProcessId);
          $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$condition);
          foreach($item in $windows) {
            if(-not $item.Current.IsOffscreen -and $item.Current.ControlType -eq [Windows.Automation.ControlType]::Window -and $item.Current.Name -eq '选择 Class 的工作目录') { $window=$item; break }
          }
        }
        if(-not $window) { Start-Sleep -Milliseconds 100 }
      }
      if(-not $window) { throw 'The owned native folder dialog did not become visible' }
      $binary=[IO.File]::ReadAllBytes($owned.ExecutablePath); $pe=[BitConverter]::ToInt32($binary,60); $machine=[BitConverter]::ToUInt16($binary,$pe+4);
      $pattern=$window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern); $pattern.Close();
      [pscustomobject]@{ opened=$true; cancelledViaUIAutomation=$true; cancelMethod='WindowPattern.Close'; pid=$owned.ProcessId; machine=$machine } | ConvertTo-Json -Compress`;
    report.directoryPicker = JSON.parse(await runPowerShell(script));
    assert.equal(report.directoryPicker.machine, report.host.expectedArchitecture === 'arm64' ? 0xaa64 : 0x8664, 'Bundled native picker must match the target architecture');
    assert.deepEqual(await pending, { cancelled: true });
    report.checks.nativeDirectoryDialogOpenedAndCancelled = true;
  } finally { controller.abort(); await pending.catch(() => {}); }
}

try {
  assert.equal(process.platform, 'win32', 'Platform acceptance requires Windows');
  assert.equal(report.host.architecture, report.host.expectedArchitecture, 'Use a native target-architecture runtime for platform acceptance');
  if (!options.node) report.artifact = verifyNativeExecutable(await fs.readFile(executable), report.host);
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
        const script = `$ErrorActionPreference='Stop'; [IO.File]::WriteAllText(${psQuote(path.join(workspace, mode + '-pid.txt'))},[string]$PID); while(${mode === 'pause' ? `-not [IO.File]::Exists(${psQuote(finish)})` : '$true'}) { [IO.File]::AppendAllText(${psQuote(ticks)},'x'); Start-Sleep -Milliseconds 100 }; [Console]::Write('owned-command-completed')`;
        answer(response, 'run_command', { command: script, shell: 'powershell', cwd: '.' }); return;
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
  const envelope = await fs.readFile(path.join(profile, 'credentials.dpapi.json'), 'utf8');
  assert.equal(JSON.parse(envelope).version, 1); assert.ok(JSON.parse(envelope).blob.length > 40); assert.ok(!envelope.includes(fakeKey));
  assert.ok(!(await fs.readFile(path.join(profile, 'profiles.json'), 'utf8')).includes(fakeKey)); report.checks.credentialsStoredAsDpapiEnvelope = true;
  await closeApplication(); await startApplication();
  for (const agent of agents) assert.equal((await api('/api/agents/' + agent.id + '/check', 'POST')).ok, true);
  report.checks.credentialsDecryptAfterRestart = true;
  const runId = (await api('/api/runs', 'POST', { task: 'Verify the owned shell heartbeat pauses during review and resumes after rejection.' })).run.id;
  const ticks = path.join(workspace, 'pause-ticks.txt');
  await waitFor(() => size(ticks), bytes => bytes >= 3, 'owned shell heartbeat');
  await waitFor(() => aliceRequest, Boolean, 'Alice candidate request'); candidate(aliceRequest); aliceRequest = undefined;
  await waitFor(() => reviewRequest, Boolean, 'teacher review after pause');
  await delay(200); const pausedSize = await size(ticks); await delay(700); assert.equal(await size(ticks), pausedSize, 'Shell must be frozen while the teacher is reviewing'); report.checks.shellPausedDuringReview = true;
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
  assert.equal(await runPowerShell(`if(Get-Process -Id ${cancelledPid} -ErrorAction SilentlyContinue){[Console]::Write('alive')}else{[Console]::Write('gone')}`), 'gone'); report.checks.shellStopCancelsAndReapsProcess = true;
  const before = await fs.readFile(path.join(profile, 'history', runId, 'journal.jsonl'));
  const moved = await api('/api/data-directory', 'PUT', { path: destination }); assert.equal(moved.dataDir, destination); profile = destination;
  assert.equal(moved.settings.cwd, path.join(destination, 'workspace'));
  assert.deepEqual(await fs.readFile(path.join(profile, 'history', runId, 'journal.jsonl')), before);
  assert.deepEqual(await fs.readFile(path.join(anchor, 'history', runId, 'journal.jsonl')), before, 'Migration must preserve source data');
  await closeApplication(); await startApplication();
  assert.equal((await api('/api/runs/' + runId)).run.status, 'completed');
  assert.equal((await api('/api/agents/' + agents[0].id + '/check', 'POST')).ok, true);
  await waitFor(() => api('/api/memory/sessions'), value => value.items?.some(item => item.id === runId), 'migrated memory source index');
  report.checks.migrationPreservesArchiveAndCredentials = true;
  report.checks.originalAnchorRestartsMigratedProfile = true;
  assert.equal(Object.keys(report.checks).length, 9);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack || error.message; process.exitCode = 1; }
finally {
  try { await closeApplication(); } catch (error) { report.cleanup.error = error.message; report.passed = false; process.exitCode = 1; }
  if (mock) { await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections?.(); }); report.cleanup.mockServerClosed = true; }
  try {
    const resolved = await fs.realpath(directory); assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('class-platform-release-')); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    for (const target of [anchor, destination, childTemp]) {
      try { const actual = await fs.realpath(target); assert.equal(path.dirname(actual), resolved); assert.equal((await fs.lstat(target)).isSymbolicLink(), false); await fs.rm(actual, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    report.cleanup.isolatedFilesRemoved = true;
  } catch (error) { report.cleanup.error = error.message; report.passed = false; process.exitCode = 1; }
  if (report.cleanup.forcedOwnedProcessStop) { report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await fs.mkdir(path.dirname(reportFile), { recursive: true }); await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, host: report.host, checks: report.checks, cleanup: report.cleanup, report: reportFile, ...(report.error ? { error: report.error } : {}) }, null, 2));
}
