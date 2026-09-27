// Native executable acceptance for a moved/deleted data directory. Every
// profile, startup anchor, browser profile and model request is isolated.
// Usage: node tests/release/verify-startup-recovery.js [--node | --exe executable] [--report file]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { verificationHost, verificationRoot, verifyNativeExecutable, defaultVerificationExecutable } from './windows-verification.js';
import { captureLinuxChild, stopLinuxOwnedTree } from './linux-process.js';
import { createProfileStore } from '../../src/profile-store.js';
import { createMemoryStore } from '../../src/memory-store.js';
import { memoryProjectId } from '../../src/memory-manager.js';
import { ToolManager } from '../../src/tools.js';
import { findBrowserExecutable } from '../../src/browser-tools.js';

const options = {}, args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--node') { options.node = true; continue; }
  const key = args[index], value = args[++index];
  if (!['--exe', '--report'].includes(key) || !value || value.startsWith('--')) throw Error('Usage: verify-startup-recovery.js [--node | --exe executable] [--report file]');
  options[key.slice(2)] = path.resolve(value);
}
assert.ok(!(options.node && options.exe));
const executable = options.node ? process.execPath : options.exe || defaultVerificationExecutable();
const sourceRoot = verificationRoot(import.meta.url), parent = await fs.realpath(os.tmpdir());
const directory = await fs.mkdtemp(path.join(parent, 'class-startup-recovery-'));
const fixtures = path.join(directory, 'fixtures'), reportFile = options.report || path.join(directory, 'verification-report.json');
const owner = randomUUID(), marker = 'Recovery archive beacon ' + randomUUID();
const fakeKey = 'class-recovery-local-fixture-key';
const report = { startedAt: new Date().toISOString(), mode: options.node ? 'source' : 'exe', executable, host: verificationHost(), checks: {}, cleanup: {}, modelRequests: 0, passed: false };
const applications = new Set();
let mock, modelFailure, browserManager;
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
async function absent(filename) { await assert.rejects(fs.lstat(filename), error => error.code === 'ENOENT'); }
async function waitFor(read, predicate, label, timeout = 30000) {
  const until = Date.now() + timeout; let value;
  do { if (modelFailure) throw modelFailure; value = await read(); if (predicate(value)) return value; await delay(50); } while (Date.now() < until);
  throw Error('Timed out: ' + label);
}
async function request(app, route, method = 'GET', body, success = true) {
  const response = await fetch(app.url + route, { method, headers: { Authorization: 'Bearer ' + app.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (success) assert.ok(response.ok, route + ': HTTP ' + response.status + ' ' + JSON.stringify(value));
  return success ? value : { status: response.status, value };
}
async function fixture(name) {
  const root = path.join(fixtures, name); await fs.mkdir(root, { mode: 0o700 });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:class_.*|node_options|bun_options)$/i.test(key)) delete environment[key];
  for (const [name, variable] of [['tmp', 'TEMP'], ['home', 'HOME'], ['local', 'LOCALAPPDATA'], ['roaming', 'APPDATA'], ['data', 'XDG_DATA_HOME'], ['state', 'XDG_STATE_HOME'], ['startup', 'CLASS_STARTUP_STATE_DIR']]) {
    const folder = path.join(root, name); await fs.mkdir(folder, { mode: 0o700 }); environment[variable] = folder;
  }
  Object.assign(environment, { TMP: environment.TEMP, TMPDIR: environment.TEMP, USERPROFILE: environment.HOME });
  const defaultPath = path.join(process.platform === 'linux' ? environment.XDG_DATA_HOME : environment.LOCALAPPDATA, process.platform === 'linux' ? 'class' : 'discussion');
  return { root, environment, defaultPath };
}
function recoveryAnchor(context, requested) {
  const resolved = path.resolve(requested);
  return path.join(context.environment.CLASS_STARTUP_STATE_DIR, digest(process.platform === 'win32' ? resolved.toLowerCase() : resolved));
}
async function readInstance(location) {
  try { return JSON.parse(await fs.readFile(path.join(location, 'instance.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
function bind(app, record) {
  assert.equal(record.pid, app.child.pid, 'Instance belongs to the exact child started by this verifier');
  const url = new URL(record.url); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert.match(record.token, /^[a-f0-9]{64}$/);
  app.url = record.url.replace(/\/$/, ''); app.token = record.token;
}
async function start(context, { explicit, location, duplicate = false } = {}) {
  const argv = [...(options.node ? [path.join(sourceRoot, 'src', 'desktop.js')] : []), ...(explicit ? ['--data-dir', explicit] : []), '--no-browser'];
  const child = spawn(executable, argv, { cwd: context.root, env: context.environment, detached: process.platform === 'linux', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const app = { child, context, output: '' }; applications.add(app);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { app.output = (app.output + chunk).slice(-8000); });
  app.exited = new Promise(resolve => { child.once('error', error => { app.error = error; resolve(); }); child.once('close', (code, signal) => { app.exit = { code, signal }; resolve(app.exit); }); });
  if (process.platform === 'linux') { app.identity = captureLinuxChild(child); app.identity.catch(() => {}); }
  if (duplicate) return app;
  const record = await waitFor(async () => {
    if (app.error) throw app.error;
    if (app.exit) throw Error('Owned application exited before readiness: ' + JSON.stringify(app.exit) + ' ' + app.output);
    const record = await readInstance(location); return record?.pid === child.pid ? record : null;
  }, Boolean, 'owned application readiness');
  bind(app, record); return app;
}
async function exited(app, timeout = 20000) {
  let timer;
  try { await Promise.race([app.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned application did not exit: ' + app.output)), timeout); })]); }
  finally { clearTimeout(timer); }
  if (app.error) throw app.error;
  assert.deepEqual(app.exit, { code: 0, signal: null });
}
async function forceOwned(app) {
  if (app.exit || app.error || !app.child.pid) return;
  report.cleanup.forcedOwnedChildStop = true;
  if (process.platform === 'linux') { await stopLinuxOwnedTree(await app.identity); return; }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const quoted = executable.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $owned=Get-CimInstance Win32_Process -Filter "ProcessId = ${app.child.pid}"; if($owned) { if($owned.ParentProcessId -ne ${process.pid} -or $owned.ExecutablePath -ne '${quoted}' -or -not $owned.CommandLine.Contains('--no-browser')) { throw 'Owned application identity changed' }; & "$env:SystemRoot\\System32\\taskkill.exe" /PID $owned.ProcessId /T /F | Out-Null; if($LASTEXITCODE -ne 0 -and (Get-Process -Id $owned.ProcessId -ErrorAction SilentlyContinue)) { throw 'Owned application termination failed' } }`;
  await new Promise((resolve, reject) => {
    const helper = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { helper.kill(); reject(Error('Owned cleanup helper timed out')); }, 15000);
    helper.once('error', error => { clearTimeout(timer); reject(error); }); helper.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Owned application cleanup failed')); });
  });
}
async function close(app) {
  if (!app || !applications.has(app)) return;
  let acknowledged = false;
  try {
    if (!app.exit && !app.error && app.url) acknowledged = (await request(app, '/api/shutdown', 'POST')).readyToExit === true;
    await exited(app); assert.equal(acknowledged, true);
  } finally {
    if (!app.exit && !app.error) { await forceOwned(app); await exited(app).catch(() => {}); }
    if (app.exit || app.error) applications.delete(app);
    (report.cleanup.processes ||= []).push({ pid: app.child.pid, shutdownAcknowledged: acknowledged, exit: app.exit });
  }
}
async function seedProfile(profile, label) {
  const store = await createProfileStore(profile), agentId = 'agent-' + randomUUID();
  const runId = 'run-' + randomUUID(), reference = 'journal:' + runId + ':1';
  const config = { ...store.config, agents: [{ id: agentId, name: label, model: 'recovery-fixture', role: 'teacher', baseUrl: 'http://127.0.0.1:' + mock.address().port + '/v1', protocol: 'messages' }] };
  await store.save(config, { [agentId]: fakeKey });
  const workspace = config.settings.cwd, projectId = memoryProjectId(workspace);
  const run = { id: runId, projectId, cwd: workspace, task: marker, status: 'completed', startedAt: '2026-09-20T10:00:00.000Z', finishedAt: '2026-09-20T10:01:00.000Z', events: [], blackboard: [], outcomes: [], team: { teacher: agentId, students: [] }, hasJournal: true, demo: true, metadata: { demo: true } };
  const history = path.join(profile, 'history'); await fs.mkdir(path.join(history, runId), { recursive: true });
  await fs.writeFile(path.join(history, runId + '.json'), JSON.stringify(run));
  await fs.writeFile(path.join(history, runId, 'session.json'), JSON.stringify(run));
  await fs.writeFile(path.join(history, runId, 'journal.jsonl'), JSON.stringify({ sequence: 1, kind: 'run', recordedAt: run.startedAt, task: marker }) + '\n');
  const memory = await createMemoryStore({ directory: path.join(profile, 'memory') });
  const memoryId = 'fixture-memory-' + randomUUID();
  try {
    memory.registerSession(run);
    memory.upsertRecords(runId, [{ id: reference, reference, sequence: 1, role: 'user', shared: true, kind: 'run', timestamp: run.startedAt, text: marker, payload: { task: marker } }]);
    memory.saveMemory({ id: memoryId, projectId, kind: 'user', category: 'preference', status: 'active', content: marker + ': prefer concise replies.', sourceRefs: [reference] }, { admin: true });
  } finally { memory.close(); }
  await fs.writeFile(path.join(workspace, 'fixture.txt'), marker);
  return { agentId, runId, memoryId, reference, label, historyHash: digest(await fs.readFile(path.join(history, runId + '.json'))) };
}
async function verifyProfile(app, profile, seed) {
  const state = await request(app, '/api/state');
  assert.equal(await fs.realpath(state.dataDir), await fs.realpath(profile));
  assert.equal(state.settings.cwd, path.join(profile, 'workspace'));
  assert.ok(state.agents.some(agent => agent.id === seed.agentId && agent.name === seed.label));
  assert.equal((await request(app, '/api/agents/' + seed.agentId + '/check', 'POST')).ok, true);
  assert.equal(await fs.readFile(path.join(profile, 'workspace', 'fixture.txt'), 'utf8'), marker);
  assert.equal(digest(await fs.readFile(path.join(profile, 'history', seed.runId + '.json'))), seed.historyHash);
  const memory = await request(app, '/api/memory/entries/' + seed.memoryId); assert.ok(memory.content.includes(marker));
  const result = await waitFor(() => request(app, '/api/memory/sessions/search', 'POST', { query: 'Recovery archive beacon', sessionId: seed.runId, limit: 100 }), value => value.items?.some(item => item.text.includes(marker)), 'restored history search');
  assert.ok(result.items.some(item => item.sessionId === seed.runId));
}
async function choose(app, body, profile) {
  const result = await request(app, '/api/recovery/select', 'POST', body);
  const destination = new URL(result.url); assert.equal(destination.hostname, '127.0.0.1'); assert.equal(destination.protocol, 'http:');
  const token = new URLSearchParams(destination.hash.slice(1)).get('token');
  const record = await waitFor(() => readInstance(profile), value => value?.pid === app.child.pid && value.token === token, 'selected profile instance');
  bind(app, record); return result;
}
async function treeSnapshot(folder) {
  const items = [];
  async function walk(base, prefix = '') {
    for (const entry of (await fs.readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(prefix, entry.name), filename = path.join(base, entry.name), info = await fs.lstat(filename);
      assert.equal(info.isSymbolicLink(), false); items.push([name, info.mode, entry.isFile() ? digest(await fs.readFile(filename)) : 'directory']);
      if (entry.isDirectory()) await walk(filename, name);
    }
  }
  await walk(folder); return items;
}
async function recoveryPage(app, expectedPath) {
  const state = await request(app, '/api/state'); assert.equal(state.mode, 'data-recovery');
  assert.equal(state.recovery.requestedPath, expectedPath);
  const response = await fetch(app.url + '/'); assert.equal(response.status, 200);
  const html = await response.text(); assert.match(html, /使用默认目录/); assert.match(html, /选择(?:已有)?数据目录/);
  assert.match(html, /recovery-default/); assert.match(html, /recovery-load/);
}

// Use the same real recovery form for an archived profile and a new directory.
async function chooseInBrowser(app, selected) {
  browserManager = new ToolManager({ cwd: directory, allowShell: false, browserOptions: { executablePath: await findBrowserExecutable() } });
  const browser = browserManager.browserTools, action = input => browser.execute('startup-recovery', 'browser', input);
  try {
    const opened = JSON.parse((await action({ action: 'open', url: app.url + '/#token=' + app.token })).output);
    const session = browser.sessions.get('startup-recovery'), page = session.pages.get(opened.tabId);
    const evaluate = expression => browser._evaluate(session, page, expression, AbortSignal.timeout(10000));
    await waitFor(() => evaluate(`!!document.getElementById('recovery-load')&&!document.getElementById('recovery-load').disabled`), Boolean, 'recovery form ready');
    await action({ action: 'fill', selector: '#recovery-path', text: selected }); await action({ action: 'click', selector: '#recovery-load' });
    const record = await waitFor(() => readInstance(selected), value => value?.pid === app.child.pid, 'browser-selected profile readiness'); bind(app, record);
    await waitFor(async () => {
      try { return await evaluate(`location.origin===${JSON.stringify(app.url)}&&!document.getElementById('recovery-load')&&!!document.getElementById('connection-status')&&document.getElementById('connection-status').textContent.includes('已连接')`); }
      catch (error) { if (/execution context|Cannot find context|Inspected target navigated/i.test(error.message)) return false; throw error; }
    }, Boolean, 'browser navigated to loaded Class');
  } finally { await browserManager.stopAll(); browserManager = undefined; }
}

async function verifyEmptyProfile(app, profile) {
  const state = await request(app, '/api/state');
  assert.equal(await fs.realpath(state.dataDir), await fs.realpath(profile));
  assert.equal(state.settings.cwd, path.join(profile, 'workspace'));
  assert.deepEqual(state.agents, []); assert.deepEqual(state.history, []);
  const saved = JSON.parse(await fs.readFile(path.join(profile, 'profiles.json'), 'utf8'));
  assert.equal(saved.version, 1); assert.deepEqual(saved.agents, []); assert.equal(saved.settings.cwd, path.join(profile, 'workspace'));
  for (const name of ['credentials.dpapi.json', 'credentials.aesgcm.json', 'credentials.key']) await absent(path.join(profile, name));
  for (const name of ['workspace', 'history', 'memory']) assert.equal((await fs.stat(path.join(profile, name))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(profile, 'memory', 'memory.sqlite'))).isFile(), true);
  assert.deepEqual((await request(app, '/api/memory/entries')).items, []);
  assert.deepEqual((await request(app, '/api/memory/sessions')).items, []);
}

try {
  await fs.mkdir(fixtures, { mode: 0o700 }); await fs.writeFile(path.join(fixtures, '.verification-owner'), owner, { flag: 'wx' });
  if (!options.node) { const bytes = await fs.readFile(executable); report.artifact = verifyNativeExecutable(bytes, report.host); report.executableSha256 = digest(bytes); }
  mock = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/messages'); assert.equal(req.method, 'POST'); assert.equal(req.headers['x-api-key'], fakeKey);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.model, 'recovery-fixture');
      report.modelRequests++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ ok: true, memories: [] }) }] }));
    } catch (error) { modelFailure = error; res.writeHead(500); res.end('Local recovery fixture failed'); }
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));

  const moved = await fixture('moved'), oldProfile = path.join(moved.root, 'original-profile'), selected = path.join(moved.root, 'moved-profile');
  const seed = await seedProfile(oldProfile, 'Moved profile');
  await fs.mkdir(moved.defaultPath, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(moved.defaultPath, 'data-location.json'), JSON.stringify({ version: 1, dataDir: oldProfile }));
  let app = await start(moved, { location: oldProfile }); await verifyProfile(app, oldProfile, seed); await close(app);
  await fs.rename(oldProfile, selected);
  const anchor = recoveryAnchor(moved, moved.defaultPath);
  app = await start(moved, { location: anchor }); await recoveryPage(app, oldProfile); await absent(oldProfile);
  report.checks.movedDataStartsRecoveryWithoutRecreatingOldPath = true;
  const duplicate = await start(moved, { duplicate: true }); await exited(duplicate); applications.delete(duplicate);
  assert.equal((await readInstance(anchor)).pid, app.child.pid); await recoveryPage(app, oldProfile);
  report.checks.secondLaunchReusesOwnedRecovery = true;

  const absentCandidate = path.join(moved.root, 'does-not-exist');
  const missing = await request(app, '/api/recovery/select', 'POST', { mode: 'existing', path: absentCandidate }, false); assert.ok(missing.status >= 400); await absent(absentCandidate);
  const invalid = path.join(moved.root, 'invalid-profile'); await fs.mkdir(invalid, { mode: 0o700 });
  await fs.writeFile(path.join(invalid, 'profiles.json'), '{broken');
  const beforeInvalid = await treeSnapshot(invalid);
  const bad = await request(app, '/api/recovery/select', 'POST', { mode: 'existing', path: invalid }, false); assert.ok(bad.status >= 400); assert.deepEqual(await treeSnapshot(invalid), beforeInvalid);
  await recoveryPage(app, oldProfile); report.checks.invalidSelectionsPreservePageAndCandidate = true;

  const activePath = path.join(moved.root, 'active-profile'); await seedProfile(activePath, 'Other active profile');
  const active = await start(moved, { explicit: activePath, location: activePath });
  const activeRecord = await readInstance(activePath), selectedBefore = digest(await fs.readFile(path.join(activePath, 'profiles.json')));
  const conflict = await request(app, '/api/recovery/select', 'POST', { mode: 'existing', path: activePath }, false);
  assert.equal(conflict.status, 409); assert.equal((await readInstance(activePath)).pid, activeRecord.pid); assert.equal(digest(await fs.readFile(path.join(activePath, 'profiles.json'))), selectedBefore);
  await recoveryPage(app, oldProfile); await close(active); report.checks.activeDestinationRejectsSecondWriter = true;

  // Exercise the actual recovery form and its navigation, not only the HTTP API.
  await chooseInBrowser(app, selected);
  report.checks.browserSelectionLoadsExistingProfile = true;
  await verifyProfile(app, selected, seed); await absent(oldProfile);
  report.checks.credentialsHistoryMemoryAndWorkspaceRecovered = true;
  await close(app); app = await start(moved, { location: selected }); await verifyProfile(app, selected, seed);
  report.checks.restartUsesRememberedSelection = true;
  const migrated = path.join(moved.root, 'migrated-again'); await fs.mkdir(migrated, { mode: 0o755 }); if (process.platform === 'linux') await fs.chmod(migrated, 0o755);
  assert.equal((await request(app, '/api/data-directory', 'PUT', { path: migrated })).dataDir, migrated);
  await close(app); app = await start(moved, { location: migrated });
  // Migration legitimately rewrites historic workspace metadata. Verify its
  // resulting history exists and its retrievable content remains available.
  seed.historyHash = digest(await fs.readFile(path.join(migrated, 'history', seed.runId + '.json')));
  await verifyProfile(app, migrated, seed); await close(app);
  report.checks.migrationAndRestartStillWorkAfterRecovery = true;

  const empty = await fixture('default-empty'), deleted = path.join(empty.root, 'deleted-profile');
  app = await start(empty, { explicit: deleted, location: recoveryAnchor(empty, deleted) }); await recoveryPage(app, deleted);
  await choose(app, { mode: 'default' }, empty.defaultPath);
  const initial = await request(app, '/api/state'); assert.equal(initial.dataDir, empty.defaultPath); assert.deepEqual(initial.agents, []); await absent(deleted);
  await close(app); app = await start(empty, { explicit: deleted, location: empty.defaultPath });
  assert.equal((await request(app, '/api/state')).dataDir, empty.defaultPath); await close(app);
  report.checks.deletedExplicitPathCanInitializeAndRememberDefault = true;

  const custom = await fixture('selected-empty'), customMissing = path.join(custom.root, 'missing-data');
  app = await start(custom, { explicit: customMissing, location: recoveryAnchor(custom, customMissing) }); await recoveryPage(app, customMissing);
  const unknown = path.join(custom.root, 'unrelated-files'); await fs.mkdir(unknown, { mode: 0o755 });
  if (process.platform === 'linux') await fs.chmod(unknown, 0o755);
  await fs.writeFile(path.join(unknown, 'keep.txt'), 'Unrelated fixture data must remain unchanged.');
  const partial = path.join(custom.root, 'incomplete-class'); await seedProfile(partial, 'Incomplete Class profile');
  // Missing Agent settings alongside saved credentials is damaged data, not a
  // new empty directory and not a legacy unconfigured Class installation.
  await fs.unlink(path.join(partial, 'profiles.json'));
  const runtimeOnly = path.join(custom.root, 'runtime-only'); await fs.mkdir(runtimeOnly, { mode: 0o700 });
  await fs.writeFile(path.join(runtimeOnly, 'startup.log'), 'A leftover runtime file is not an empty data directory.');
  for (const candidate of [unknown, partial, runtimeOnly]) {
    const before = await treeSnapshot(candidate), mode = (await fs.stat(candidate)).mode;
    const rejected = await request(app, '/api/recovery/select', 'POST', { mode: 'existing', path: candidate }, false);
    assert.ok(rejected.status >= 400 && rejected.status < 500); assert.deepEqual(await treeSnapshot(candidate), before);
    assert.equal((await fs.stat(candidate)).mode, mode); await recoveryPage(app, customMissing);
  }
  report.checks.nonemptyUnknownAndPartialProfilesRemainUnchanged = true;
  const fresh = path.join(custom.root, 'chosen-new-directory'); await fs.mkdir(fresh, { mode: 0o755 });
  if (process.platform === 'linux') { await fs.chmod(fresh, 0o755); assert.equal((await fs.stat(fresh)).mode & 0o777, 0o755); }
  assert.deepEqual(await fs.readdir(fresh), []);
  await chooseInBrowser(app, fresh); await verifyEmptyProfile(app, fresh); await absent(customMissing);
  report.checks.browserSelectionInitializesEmptyDirectory = true;
  if (process.platform === 'linux') assert.equal((await fs.stat(fresh)).mode & 0o777, 0o700);
  report.checks.customEmptyDirectoryPermissionsReady = true;
  const remembered = JSON.parse(await fs.readFile(path.join(recoveryAnchor(custom, customMissing), 'data-location.json'), 'utf8'));
  assert.equal(remembered.dataDir, fresh);
  await close(app); app = await start(custom, { explicit: customMissing, location: fresh }); await verifyEmptyProfile(app, fresh); await absent(customMissing);
  const normalPageEmpty = path.join(custom.root, 'normal-page-empty'); await fs.mkdir(normalPageEmpty, { mode: 0o700 });
  const normalPageRejected = await request(app, '/api/data-directory/load', 'POST', { path: normalPageEmpty }, false);
  assert.ok(normalPageRejected.status >= 400 && normalPageRejected.status < 500); assert.deepEqual(await fs.readdir(normalPageEmpty), []);
  assert.equal((await request(app, '/api/state')).dataDir, fresh, 'Normal-page load-existing semantics must remain unchanged');
  report.checks.customEmptyDirectorySelectionSurvivesRestart = true;
  const archived = path.join(custom.root, 'saved-profile'), archivedSeed = await seedProfile(archived, 'Loaded after empty initialization');
  const customLoad = await request(app, '/api/data-directory/load', 'POST', { path: archived }); assert.ok(customLoad.url);
  bind(app, await waitFor(() => readInstance(archived), value => value?.pid === app.child.pid, 'existing profile loaded from new empty profile'));
  await verifyProfile(app, archived, archivedSeed); await close(app);
  app = await start(custom, { explicit: customMissing, location: archived }); await verifyProfile(app, archived, archivedSeed); await close(app);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(fresh, 'profiles.json'), 'utf8')).agents, []);
  report.checks.loadExistingAfterCustomEmptyInitializationAndRestart = true;

  // A default directory may still contain useful data beside an obsolete
  // migration pointer. Choosing default must load its own profile directly.
  const existing = await fixture('default-existing'), existingSeed = await seedProfile(existing.defaultPath, 'Existing default profile');
  const lost = path.join(existing.root, 'obsolete-target'); await fs.writeFile(path.join(existing.defaultPath, 'data-location.json'), JSON.stringify({ version: 1, dataDir: lost }));
  app = await start(existing, { location: recoveryAnchor(existing, existing.defaultPath) }); await recoveryPage(app, lost);
  await choose(app, { mode: 'default' }, existing.defaultPath); await verifyProfile(app, existing.defaultPath, existingSeed); await absent(lost);
  await close(app); app = await start(existing, { location: existing.defaultPath }); await verifyProfile(app, existing.defaultPath, existingSeed);
  report.checks.defaultLoadsExistingDataDespiteObsoletePointer = true;
  const switched = path.join(existing.root, 'another-profile'), switchSeed = await seedProfile(switched, 'Loaded after default recovery');
  const load = await request(app, '/api/data-directory/load', 'POST', { path: switched }); assert.ok(load.url);
  const switchedRecord = await waitFor(() => readInstance(switched), value => value?.pid === app.child.pid, 'live loaded profile'); bind(app, switchedRecord);
  await verifyProfile(app, switched, switchSeed); await close(app);
  app = await start(existing, { location: switched }); await verifyProfile(app, switched, switchSeed); await close(app);
  report.checks.loadExistingAfterDefaultRecoveryAndRestart = true;
  assert.equal(modelFailure, undefined); assert.ok(report.modelRequests >= 8);
  report.checks.onlyIsolatedProfilesAndLocalFakeCredentialsUsed = true;
  report.passed = Object.keys(report.checks).length === 17 && Object.values(report.checks).every(Boolean);
} catch (error) { report.error = error.stack || error.message; report.passed = false; }
finally {
  try { await browserManager?.stopAll(); } catch (error) { report.cleanup.browserError = error.message; report.passed = false; }
  for (const app of [...applications].reverse()) {
    try { await close(app); } catch (error) { report.cleanup.error = error.message; report.passed = false; }
  }
  if (mock) { await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections?.(); }); report.cleanup.mockServerClosed = true; }
  try {
    assert.equal(applications.size, 0, 'Preserve profiles when an owned process is still live');
    const resolved = await fs.realpath(directory), target = await fs.realpath(fixtures);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('class-startup-recovery-'));
    assert.equal(path.dirname(target), resolved); assert.equal(path.basename(target), 'fixtures'); assert.ok(inside(resolved, target));
    assert.equal(await fs.readFile(path.join(target, '.verification-owner'), 'utf8'), owner);
    await fs.rm(target, { recursive: true, force: true }); report.cleanup.isolatedProfilesRemoved = true;
  } catch (error) { report.cleanup.error = error.message; report.passed = false; }
  if (report.cleanup.forcedOwnedChildStop) report.passed = false;
  report.finishedAt = new Date().toISOString(); if (!report.passed) process.exitCode = 1;
  await fs.mkdir(path.dirname(reportFile), { recursive: true }); await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, cleanup: report.cleanup, modelRequests: report.modelRequests, report: reportFile, ...(report.error ? { error: report.error } : {}) }, null, 2));
}
