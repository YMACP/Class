// Native browser acceptance. No remote model or user profile is used. The
// standalone driver contains the lifecycle fixture; workflow calls execute in
// the separately supplied Class application, not in the driver's ToolManager.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { browserActions, browserFixtureHtml, assertPng, bounded, verifyBrowserLifecycle } from '../helpers/browser-compatibility.js';
import { verificationHost, verificationRoot, verifyNativeExecutable, defaultVerificationExecutable } from './windows-verification.js';
import { captureLinuxChild, stopLinuxOwnedTree } from './linux-process.js';

const options = {}, args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--node') { options.node = true; continue; }
  const key = args[index], value = args[++index];
  assert.ok(['--exe', '--report'].includes(key) && value && !value.startsWith('--'), 'Usage: verify-browser-compatibility.js [--node | --exe executable] [--report file]');
  options[key.slice(2)] = path.resolve(value);
}
assert.ok(!(options.node && options.exe));
const executable = options.node ? process.execPath : options.exe || defaultVerificationExecutable();
const sourceRoot = verificationRoot(import.meta.url), parent = await fs.realpath(os.tmpdir());
const directory = await fs.mkdtemp(path.join(parent, 'class-browser-verifier-'));
const reportFile = options.report || path.join(directory, 'verification-report.json');
const report = { startedAt: new Date().toISOString(), mode: options.node ? 'source' : 'exe', host: verificationHost(), executable, browsers: [], cleanup: {}, passed: false };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fakeKey = 'class-browser-local-fixture-key', finalAnswer = 'All browser operations passed with retained evidence and teacher feedback.';
const alive = child => child && child.exitCode === null && child.signalCode === null;

async function browserMatrix() {
  assert.ok(['win32', 'linux'].includes(process.platform), 'Browser acceptance supports the release Windows and Linux hosts');
  const names = process.platform === 'win32' ? ['edge', 'chrome', 'firefox'] : ['chrome', 'firefox'];
  let configured;
  if (process.env.CLASS_TEST_BROWSER_EXECUTABLES) {
    configured = JSON.parse(process.env.CLASS_TEST_BROWSER_EXECUTABLES);
    assert.ok(configured && typeof configured === 'object' && !Array.isArray(configured), 'Browser matrix must be a JSON object');
  }
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const defaults = process.platform === 'win32' ? {
    edge: roots.map(root => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    chrome: roots.map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    firefox: roots.map(root => path.join(root, 'Mozilla Firefox', 'firefox.exe')),
  } : { chrome: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'], firefox: ['/opt/firefox/firefox', '/usr/bin/firefox'] };
  const matrix = [];
  for (const name of names) {
    if (configured) assert.ok(typeof configured[name] === 'string' && path.isAbsolute(configured[name]), 'Missing absolute executable path for required browser: ' + name);
    let selected;
    for (const candidate of configured ? [configured[name]] : defaults[name]) {
      try { if ((await fs.stat(candidate)).isFile()) { selected = await fs.realpath(candidate); break; } } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    assert.ok(selected, 'Required browser is unavailable: ' + name + '; set CLASS_TEST_BROWSER_EXECUTABLES to a complete matrix');
    assert.match(path.basename(selected).toLowerCase(), name === 'edge' ? /msedge/ : new RegExp(name), 'Selected browser path must identify ' + name);
    matrix.push({ name, executable: selected, sha256: digest(await fs.readFile(selected)) });
  }
  assert.equal(new Set(matrix.map(item => item.executable.toLowerCase())).size, names.length, 'Each required browser must use its own executable');
  return matrix;
}

async function verifyWorkflow(browser, root) {
  const profile = path.join(root, 'profile'), workspace = path.join(root, 'workspace'), temporary = path.join(root, 'tmp');
  const sockets = new Set(), pending = new Map(), evidence = new Set(), calls = [];
  let application, exited, identity, instance, spawnError, modelFailure, mock, failure, output = '';
  let step = 0, reviews = 0, feedback = false, screenshot = false, submissions = 0, resumedTabRead = false;
  let refs, firstTab;
  const checks = {}, cleanup = { forced: false }, start = Date.now();
  function running() {
    if (modelFailure) throw modelFailure;
    if (spawnError) throw spawnError;
    assert.ok(Date.now() - start < 180000, 'Browser application workflow exceeded three minutes');
    if (application) assert.ok(alive(application), 'Owned Class exited before completion: ' + output);
  }
  async function api(route, body, method = body === undefined ? 'GET' : 'POST', closing = false) {
    if (!closing) running();
    const response = await fetch(new URL(route, instance.url), { method, headers: { Authorization: 'Bearer ' + instance.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, 'Class API failed: ' + route + ' HTTP ' + response.status); return response.json();
  }
  function issue(model, response, name, input) {
    const id = 'browser-call-' + (calls.length + 1); calls.push({ model, name, action: input.action });
    if (name === 'browser') pending.set(model, { id, action: input.action });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] }));
  }
  async function collect(body) {
    const expected = pending.get(body.model); if (!expected) return;
    const block = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : []).find(item => item.type === 'tool_result' && item.tool_use_id === expected.id);
    assert.ok(block && !block.is_error, 'Application browser operation failed: ' + expected.action);
    const content = Array.isArray(block.content) ? block.content : [{ type: 'text', text: block.content }];
    const result = JSON.parse(content.find(item => item.type === 'text')?.text);
    assert.ok(result && !result.error && result.success !== false, 'Application browser.' + expected.action + ' unsuccessful: ' + String(result?.error || result?.output || 'No result').slice(0, 1600));
    assert.match(result.evidenceRef, /^journal:/); evidence.add(result.evidenceRef);
    assert.ok(!result.media?.some(item => 'data' in item), 'Raw screenshot bytes must not enter JSON history');
    const value = JSON.parse(result.output);
    if (expected.action === 'open' || expected.action === 'navigate') assert.equal(value.title, 'Class browser compatibility');
    if (expected.action === 'open') { assert.ok(value.tabId); firstTab = value.tabId; }
    if (expected.action === 'snapshot') {
      assert.match(value.text, /Isolated browser fixture/);
      if (!refs) { refs = { input: value.elements.find(item => item.tag === 'input')?.ref, button: value.elements.find(item => item.label === 'Save')?.ref }; assert.ok(refs.input && refs.button); }
      if (step === 5) assert.match(value.text, /application-value/);
      if (step === 8) assert.match(value.text, /enter:application-keyboard/);
      if (step === 13) assert.equal(value.elements.find(item => item.tag === 'input').value, '');
      if (step === 14) { assert.equal(value.tabId, firstTab, 'Review rejection must resume the existing isolated browser tab'); resumedTabRead = true; }
    }
    if (expected.action === 'tabs') assert.ok(value.tabs.length >= 1);
    if (expected.action === 'screenshot') {
      const image = content.find(item => item.type === 'image');
      assert.equal(image?.source?.media_type, 'image/png'); assert.equal(image?.source?.type, 'base64');
      const bytes = Buffer.from(image.source.data, 'base64'); assertPng(bytes);
      const filename = result.media?.[0]?.path; assert.match(filename, /^\.class-artifacts[\\/]/);
      const artifact = path.resolve(workspace, filename), relative = path.relative(workspace, artifact);
      assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
      assert.equal(digest(await fs.readFile(artifact)), digest(bytes)); screenshot = true;
    }
    pending.delete(body.model);
  }
  async function forceStop() {
    if (!alive(application) || !application.pid) return;
    cleanup.forced = true;
    if (process.platform === 'linux') { await stopLinuxOwnedTree(await identity); return; }
    const command = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter "ProcessId = ${application.pid}"; if($p){if($p.ParentProcessId -ne ${process.pid} -or $p.ExecutablePath -ne '${executable.replaceAll("'", "''")}' -or -not $p.CommandLine.Contains('${profile.replaceAll("'", "''")}')){throw 'Owned browser test application identity changed'}; & "$env:SystemRoot\\System32\\taskkill.exe" /PID $p.ProcessId /T /F | Out-Null; if($LASTEXITCODE -ne 0 -and (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue)){throw 'Owned application cleanup failed'}}`;
    const helper = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
    try { await bounded(new Promise((resolve, reject) => { helper.once('error', reject); helper.once('close', code => code === 0 ? resolve() : reject(Error('Owned application cleanup helper failed'))); }), 15000, 'Owned application cleanup timed out'); }
    finally { if (alive(helper)) helper.kill(); }
  }
  try {
    await Promise.all([profile, workspace, temporary].map(folder => fs.mkdir(folder, { mode: 0o700 })));
    mock = createServer(async (request, response) => {
      try {
        if (request.method === 'GET') {
          if (request.url === '/tick' || request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
          assert.ok(request.url === '/fixture' || request.url === '/fresh');
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(browserFixtureHtml); return;
        }
        assert.ok(request.method === 'POST' && request.url === '/v1/messages');
        let size = 0; const chunks = [];
        for await (const chunk of request) { size += chunk.length; assert.ok(size < 24 * 1024 * 1024); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.ok(['browser-alice', 'browser-bob', 'browser-teacher'].includes(body.model));
        if (!body.tools?.length) {
          assert.equal(body.model, 'browser-teacher');
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"memories":[]}' }] })); return;
        }
        assert.ok(body.tools.some(tool => tool.name === 'browser')); await collect(body);
        const input = (body.messages || []).filter(message => message.role === 'user' && typeof message.content === 'string').map(message => { try { return JSON.parse(message.content); } catch { return null; } }).find(value => value && typeof value === 'object' && 'task' in value);
        assert.ok(input, 'Real engine input is required');
        // Bob waits for the engine's normal review/cancellation cycle.
        if (body.model === 'browser-bob') return;
        if (body.model === 'browser-alice') {
          const base = 'http://127.0.0.1:' + mock.address().port;
          const steps = [
            { action: 'open', url: base + '/fixture' }, { action: 'snapshot' },
            { action: 'fill', ref: refs?.input, text: 'application-value' }, { action: 'click', ref: refs?.button }, { action: 'snapshot' },
            { action: 'fill', selector: '#name', text: 'application-keyboard' }, { action: 'press', key: 'Enter' }, { action: 'snapshot' },
            { action: 'scroll', y: 500 }, { action: 'screenshot' }, { action: 'tabs' },
            { action: 'navigate', url: base + '/fresh' }, { action: 'snapshot' },
          ];
          if (step < steps.length) { issue(body.model, response, 'browser', steps[step++]); return; }
          const revised = submissions > 0;
          if (revised) {
            assert.equal(input.feedbackVersion, 1); assert.ok(input.blackboard?.some(entry => entry.type === 'teacher_feedback')); feedback = true;
            if (step === steps.length) { step++; issue(body.model, response, 'browser', { action: 'snapshot', tabId: firstTab }); return; }
            if (step === steps.length + 1) { step++; issue(body.model, response, 'browser', { action: 'close', all: true }); return; }
          }
          assert.ok(++submissions <= 2, 'Completed browser operations must not replay after teacher feedback');
          issue(body.model, response, 'submit_answer', { content: revised ? finalAnswer : 'Browser operations complete; final wording awaits teacher review.', evidence: 'All browser operation results are retained in the journal.', evidenceRefs: [...evidence], completionClaims: ['Browser fixture verified'], remainingIssues: [] }); return;
        }
        assert.ok(input.answer && input.reviewSnapshot, 'Teacher requires the actual review snapshot');
        assert.ok(++reviews <= 2); const valid = reviews === 2;
        if (valid) { assert.equal(input.answer.content, finalAnswer); assert.equal(feedback, true); }
        issue(body.model, response, 'submit_review', { valid, ...(valid ? { answer: finalAnswer } : {}), report: valid ? 'Retained browser evidence and revised answer passed.' : 'Revise the final wording using the existing browser evidence.', verifiedFacts: ['Browser fixture actions have journal evidence.'], gaps: valid ? [] : ['Final wording needs revision.'], recommendations: valid ? [] : ['Revise without replaying browser actions.'], evidenceRefs: [...evidence] });
      } catch (error) { modelFailure ||= error; if (!response.headersSent) response.writeHead(500); response.end('{"error":"Local browser fixture assertion failed"}'); }
    });
    mock.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (/^(?:class_.*|node_options|bun_options)$/i.test(key)) delete environment[key];
    Object.assign(environment, { CLASS_BROWSER_EXECUTABLE: browser.executable, TEMP: temporary, TMP: temporary, TMPDIR: temporary });
    // Windows browsers resolve known folders through the native user token.
    // Replacing USERPROFILE/LOCALAPPDATA with empty fixtures makes Edge reject
    // its remote-debugging profile. Keep those OS values, as verify-release
    // does; Class data/startup state and every browser profile stay explicit.
    const isolatedFolders = process.platform === 'linux' ? [['home', 'HOME'], ['local', 'LOCALAPPDATA'], ['roaming', 'APPDATA'], ['data', 'XDG_DATA_HOME'], ['state', 'XDG_STATE_HOME'], ['startup', 'CLASS_STARTUP_STATE_DIR']] : [['startup', 'CLASS_STARTUP_STATE_DIR']];
    for (const [name, variable] of isolatedFolders) {
      const folder = path.join(root, name); await fs.mkdir(folder, { mode: 0o700 }); environment[variable] = folder;
    }
    if (process.platform === 'linux') environment.USERPROFILE = environment.HOME;
    application = spawn(executable, [...(options.node ? [path.join(sourceRoot, 'src', 'desktop.js')] : []), '--data-dir', profile, '--no-browser'], { cwd: workspace, env: environment, windowsHide: true, detached: process.platform === 'linux', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [application.stdout, application.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
    exited = new Promise(resolve => { application.once('error', error => { spawnError = error; }); application.once('close', (code, signal) => resolve({ code, signal })); });
    if (process.platform === 'linux') { identity = captureLinuxChild(application); identity.catch(() => {}); }
    while (!instance) {
      running(); try { instance = JSON.parse(await fs.readFile(path.join(profile, 'instance.json'), 'utf8')); } catch (error) { if (!(error.code === 'ENOENT' || error instanceof SyntaxError)) throw error; }
      if (!instance) await delay(100);
    }
    assert.equal(instance.pid, application.pid); const address = new URL(instance.url); assert.equal(address.protocol, 'http:'); assert.equal(address.hostname, '127.0.0.1'); assert.match(instance.token, /^[a-f0-9]{64}$/);
    assert.equal((await api('/health')).version, '1.0.0');
    const state = await api('/api/state'); assert.equal(await fs.realpath(state.dataDir), await fs.realpath(profile)); assert.equal(state.agents.length, 0);
    for (const [name, role] of [['teacher', 'teacher'], ['alice', 'student'], ['bob', 'student']]) await api('/api/agents', { name: 'Browser ' + name, role, model: 'browser-' + name, baseUrl: 'http://127.0.0.1:' + mock.address().port + '/v1', protocol: 'messages', apiKey: fakeKey });
    await api('/api/settings', { cwd: workspace, voteTimeoutMs: 30000 }, 'PUT');
    const runId = (await api('/api/runs', { task: 'Exercise only the local browser fixture and preserve teacher review and feedback.' })).run.id;
    let run;
    do { run = (await api('/api/runs/' + runId)).run; assert.ok(!run.memberFailures?.length, 'Browser task isolated a failed member'); if (['running', 'stopping'].includes(run.status)) await delay(100); } while (['running', 'stopping'].includes(run.status));
    assert.equal(run.status, 'completed'); assert.equal(run.result?.answer, finalAnswer); assert.equal(run.result?.reviewRound, 2); assert.equal(run.result?.feedbackVersion, 1); assert.equal(reviews, 2); assert.equal(feedback, true);
    const journal = (await api('/api/runs/' + runId + '/evidence?kind=tool&limit=200')).records;
    assert.ok(!journal.some(record => record.activity?.type === 'failed'));
    const completed = journal.filter(record => record.activity?.type === 'completed' && record.activity.action.name === 'browser');
    assert.equal(completed.length, 15, 'Each planned browser operation runs exactly once across review rejection');
    assert.deepEqual([...new Set(completed.map(record => record.activity.action.args.action))].sort(), [...browserActions].sort());
    assert.ok(completed.every(record => !record.activity.result?.media?.some(item => 'data' in item)));
    const reviewRecords = (await api('/api/runs/' + runId + '/evidence?kind=review&limit=200')).records;
    assert.deepEqual(reviewRecords.map(record => record.judgement.valid), [false, true]);
    const events = (await api('/api/runs/' + runId + '/evidence?kind=event&limit=200')).records;
    assert.ok(events.some(record => record.event?.type === 'feedback.delivered' && record.event.feedbackVersion === 1));
    assert.equal(screenshot, true); assert.equal(resumedTabRead, true);
    Object.assign(checks, { allActionsInExecutable: true, persistedEvidence: true, nativeScreenshotRoundTrip: true, rejectFeedbackAccept: true, browserSurvivedReview: true, noActionReplay: true });
  } catch (error) { failure = error; }
  finally {
    try {
      if (alive(application) && instance) cleanup.shutdownAcknowledged = (await api('/api/shutdown', {}, 'POST', true)).readyToExit === true;
      if (exited) { const exit = await bounded(exited, 20000, 'Owned Class did not exit after shutdown'); cleanup.exit = exit; assert.deepEqual(exit, { code: 0, signal: null }); }
    } catch (error) { failure ||= error; try { await forceStop(); if (exited) await bounded(exited, 10000, 'Owned Class did not stop after cleanup'); } catch (cleanupError) { failure ||= cleanupError; } }
    for (const socket of sockets) socket.destroy();
    if (mock?.listening) await bounded(new Promise(resolve => mock.close(resolve)), 5000, 'Model fixture did not stop').catch(error => { failure ||= error; });
  }
  if (failure) throw failure;
  assert.equal(cleanup.shutdownAcknowledged, true); assert.equal(cleanup.forced, false);
  assert.ok(!(await fs.readdir(temporary)).some(name => name.startsWith('class-browser-')), 'Application shutdown must remove owned browser profiles');
  if (process.platform === 'linux') assert.ok(!(await fs.readdir(path.join(root, 'home'))).some(name => name.startsWith('class-browser-')), 'Application shutdown must remove owned Firefox profiles from the isolated home');
  checks.cleanShutdown = true;
  return { checks, cleanup, completedBrowserCalls: 15, reviews: [false, true], passed: true };
}

try {
  report.executableSha256 = digest(await fs.readFile(executable));
  if (!options.node) report.artifact = verifyNativeExecutable(await fs.readFile(executable), report.host);
  const matrix = await browserMatrix(); report.requiredBrowsers = matrix.map(item => item.name);
  for (const browser of matrix) {
    const root = path.join(directory, browser.name); await fs.mkdir(root, { mode: 0o700 });
    const lifecycleWorkspace = path.join(root, 'lifecycle'); await fs.mkdir(lifecycleWorkspace, { mode: 0o700 });
    const result = { ...browser, passed: false }; report.browsers.push(result);
    result.lifecycle = await verifyBrowserLifecycle(browser.executable, lifecycleWorkspace);
    const appRoot = path.join(root, 'application'); await fs.mkdir(appRoot, { mode: 0o700 });
    result.workflow = await verifyWorkflow(browser, appRoot); result.passed = true;
    assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), directory); assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
  report.cleanup.temporaryDataRemoved = true; report.passed = report.browsers.length === matrix.length && report.browsers.every(browser => browser.passed);
} catch (error) { report.error = String(error.stack || error.message).replaceAll(fakeKey, '[redacted]'); process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString(); await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, report: reportFile }, null, 2));
}
