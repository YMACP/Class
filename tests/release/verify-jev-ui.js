import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createClassServer } from '../../src/web-server.js';
import { createMemoryStore } from '../../src/memory-store.js';
import { memoryProjectId } from '../../src/memory-manager.js';
import { findBrowserExecutable } from '../../src/browser-tools.js';

// Source-only UI acceptance. The browser and Class both use owned temporary
// directories. A direct CDP connection keeps test instrumentation out of the
// production browser tools and never connects to an existing browser session.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoot = await fs.realpath(os.tmpdir());
const directory = await fs.mkdtemp(path.join(temporaryRoot, 'class-jev-ui-'));
const dataDir = path.join(directory, 'profile'), browserDir = path.join(directory, 'browser');
const token = randomBytes(32).toString('hex'), fixtureKey = 'isolated-jev-ui-' + randomBytes(16).toString('hex');
const replacementKey = fixtureKey + '-replacement', providerKeys = [], providerRequests = [];
const report = { mode: 'source', directory, startedAt: new Date().toISOString(), checks: [], screenshots: [], pageErrors: [], localRequests: 0 };
const lifetime = new AbortController(), pending = new Map();
let app, mock, child, socket, sessionId, evaluate, nextId = 0, failureMode = false;
let browserStderr = '', childExited = false, cleanupRunning = false;
let dialogDecision = false;
const check = name => { report.checks.push(name); console.log('PASS ' + name); };
const stage = name => { report.stage = name; console.log('CHECK ' + name); };
const deadline = setTimeout(() => lifetime.abort(Error('UI acceptance exceeded 120 second wall-clock deadline')), 120000);
const hardDeadline = setTimeout(() => { report.passed = false; report.deadlineExceeded = true; void finish(true); }, 135000);
function bounded(promise, label, timeoutMs = 10000, signal = lifetime.signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(Error('Timed out: ' + label)), timeoutMs);
    const abort = () => done(signal.reason || Error('Acceptance aborted'));
    const done = (error, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(value => done(null, value), done);
  });
}
async function waitFor(predicate, label, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { lifetime.signal.throwIfAborted(); if (await predicate()) return; await delay(60, undefined, { signal: lifetime.signal }); }
  throw Error('Timed out: ' + label);
}
function cdp(method, params = {}, target = sessionId, cleanup = false) {
  if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(Error('Owned CDP socket is closed'));
  const id = ++nextId;
  const request = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) })); });
  return bounded(request, method, cleanup ? 3000 : 10000, cleanup ? null : lifetime.signal).finally(() => pending.delete(id));
}
async function screenshot(name) {
  const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const filename = path.join(directory, name + '.png');
  await fs.writeFile(filename, Buffer.from(result.data, 'base64')); report.screenshots.push(filename);
}
async function removeOwnedDirectory(target) {
  assert.equal(path.dirname(directory), temporaryRoot); assert.ok(path.basename(directory).startsWith('class-jev-ui-'));
  assert.equal(path.dirname(target), directory); assert.ok(['profile', 'browser'].includes(path.basename(target)));
  const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!stat) return;
  assert.equal(stat.isSymbolicLink(), false); assert.equal(await fs.realpath(target), target);
  await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
async function finish(force = false) {
  if (cleanupRunning) { if (force) process.exit(1); return; }
  cleanupRunning = true;
  try {
    if (socket?.readyState === WebSocket.OPEN) await cdp('Browser.close', {}, null, true).catch(() => {});
    socket?.close();
    if (child && !childExited) {
      await bounded(new Promise(resolve => child.once('exit', resolve)), 'owned browser exit', 4000, null).catch(() => {});
      // This is the ChildProcess created below, kept live from spawn through exit.
      // Chrome is prevented from de-elevating/relaunching into an unowned process.
      if (!childExited && child.exitCode === null && child.signalCode === null) child.kill();
      if (!childExited) await bounded(new Promise(resolve => child.once('exit', resolve)), 'owned browser termination', 3000, null);
    }
    report.browserExited = !child || childExited;
  } catch (error) { report.browserCleanupError = error.message; }
  try { if (app) await bounded(app.close(), 'isolated Class close', 5000, null); }
  catch (error) { report.serverCleanupError = error.message; }
  try { if (mock) { mock.closeAllConnections(); await bounded(new Promise(resolve => mock.close(resolve)), 'mock close', 3000, null); } }
  catch (error) { report.mockCleanupError = error.message; }
  try { await removeOwnedDirectory(dataDir); report.profileRemoved = true; await removeOwnedDirectory(browserDir); report.browserProfileRemoved = true; }
  catch (error) { report.cleanupError = error.message; }
  if (report.browserCleanupError || report.serverCleanupError || report.mockCleanupError || report.cleanupError || report.browserExited === false || force) report.passed = false;
  report.finishedAt = new Date().toISOString();
  // Diagnostics are bounded and never contain fixture key/token values.
  if (!report.passed) report.browserDiagnostics = browserStderr.replaceAll(token, '[redacted]').replaceAll(fixtureKey, '[redacted]');
  const reportFile = path.join(directory, 'report.json');
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, reportFile, screenshots: report.screenshots, profileRemoved: report.profileRemoved, browserProfileRemoved: report.browserProfileRemoved }));
  clearTimeout(deadline); clearTimeout(hardDeadline);
  process.exitCode = report.passed ? 0 : 1;
  if (force) process.exit(1);
}
try {
  stage('prepare isolated data');
  await fs.mkdir(path.join(dataDir, 'history'), { recursive: true, mode: 0o700 });
  await fs.mkdir(browserDir, { mode: 0o700 });
  const runId = 'run-' + randomUUID();
  const fixtureRun = { id: runId, task: 'Jev 界面统计样本',
    status: 'completed', demo: true, cwd: path.join(dataDir, 'workspace'), team: { teacher: 'fixture-teacher', students: [] }, startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:01:00.000Z', events: [], blackboard: [], outcomes: [],
    judgeStats: { enabled: true, mode: 'shadow', requests: 12, timeouts: 1, failures: 2, unclear: 3, potentialSavedChars: 8765, savedChars: 0, totalLatencyMs: 2400, inputTokens: 1230, outputTokens: 8 } };
  const historyFile = path.join(dataDir, 'history', runId + '.json'), historyText = JSON.stringify(fixtureRun);
  await fs.writeFile(historyFile, historyText);
  const projectId = memoryProjectId(fixtureRun.cwd), sourceRef = 'journal:' + runId + ':1';
  const seed = await createMemoryStore({ directory: path.join(dataDir, 'memory') });
  try {
    seed.registerSession({ ...fixtureRun, projectId });
    seed.upsertRecords(runId, [{ id: sourceRef, reference: sourceRef, role: 'user', shared: true, kind: 'run', sequence: 1, timestamp: fixtureRun.startedAt, text: 'UI-CLEAR-SOURCE-2026 原始会话应保留', payload: { task: fixtureRun.task } }]);
    for (let index = 0; index < 42; index++) seed.saveMemory({ id: 'fixture-clear-' + index, projectId, kind: index % 2 ? 'agent' : 'user', category: 'preference', status: ['active', 'paused', 'invalid'][index % 3], content: '隔离清空记忆样本 ' + index, sourceRefs: [sourceRef] }, { admin: true });
  } finally { seed.close(); }
  const assets = {};
  for (const [route, file, contentType] of [['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/style.css', 'style.css', 'text/css; charset=utf-8'], ['/class-icon.svg', 'class-icon.svg', 'image/svg+xml'], ['/favicon.ico', 'class-icon.ico', 'image/x-icon']]) {
    assets[route] = { body: await fs.readFile(path.join(root, 'public', file)), contentType };
  }
  mock = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    providerRequests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    report.localRequests++;
    providerKeys.push(request.headers.authorization);
    response.writeHead(failureMode ? 401 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(failureMode ? { error: 'private-provider-error' } : { answers: { ready: { noul: 0.99 } } }));
  });
  await bounded(new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)), 'local provider start');
  stage('start isolated Class server');
  app = await bounded(createClassServer({ dataDir, token, assets }), 'isolated Class start', 20000);
  const api = async () => {
    const response = await fetch(app.url + '/api/judge', { headers: { Authorization: 'Bearer ' + token }, signal: lifetime.signal });
    assert.equal(response.status, 200); const text = await response.text(); assert.ok(!text.includes(fixtureKey));
    const judge = JSON.parse(text).judge;
    assert.equal(judge.protocol, 'system-one'); assert.equal(judge.model, 'jev-latest');
    return judge;
  };
  const memoryApi = async route => {
    const response = await fetch(app.url + route, { headers: { Authorization: 'Bearer ' + token }, signal: lifetime.signal });
    assert.equal(response.status, 200); return response.json();
  };
  stage('start owned headless browser with a fresh profile');
  const executablePath = await findBrowserExecutable();
  assert.ok(!/firefox/i.test(executablePath), 'This acceptance script requires the installed Chrome/Edge CDP backend');
  report.browser = path.basename(executablePath);
  child = spawn(executablePath, ['--headless=new', '--do-not-de-elevate', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + browserDir, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  report.browserPid = child.pid; child.once('exit', () => { childExited = true; });
  child.stderr.on('data', chunk => { browserStderr = (browserStderr + chunk.toString()).slice(-4000); });
  let spawnError; child.once('error', error => { spawnError = error; });
  let endpoint;
  await waitFor(async () => {
    if (spawnError) throw spawnError; if (childExited) throw Error('Owned browser exited before CDP became ready');
    const lines = await fs.readFile(path.join(browserDir, 'DevToolsActivePort'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
    const [port, route] = lines.trim().split(/\r?\n/); if (!/^\d+$/.test(port || '') || !route?.startsWith('/devtools/browser/')) return false;
    endpoint = 'ws://127.0.0.1:' + port + route; return true;
  }, 'owned DevTools endpoint');
  socket = new WebSocket(endpoint);
  socket.addEventListener('message', event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.id) { const request = pending.get(message.id); if (request) message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result); }
    else if (message.sessionId === sessionId && message.method === 'Runtime.exceptionThrown') report.pageErrors.push(message.params.exceptionDetails.text);
    else if (message.sessionId === sessionId && message.method === 'Page.javascriptDialogOpening') {
      report.lastConfirmation = message.params.message;
      void cdp('Page.handleJavaScriptDialog', { accept: dialogDecision }).catch(error => report.pageErrors.push(error.message));
    }
  });
  socket.addEventListener('close', () => { for (const request of pending.values()) request.reject(Error('Owned CDP connection closed')); });
  await bounded(new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }), 'CDP connect');
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true }, null));
  await cdp('Runtime.enable'); await cdp('Page.enable');
  evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const viewport = (width, height) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const click = async selector => {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const fill = (selector, text) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const uiWait = (expression, label) => waitFor(() => evaluate(expression), label);
  const openSettings = async () => { await click('#judge-settings-button'); await uiWait(`document.querySelector('#judge-settings-dialog').open`, 'Jev dialog open'); };
  await viewport(1280, 960);
  await cdp('Page.navigate', { url: app.url + '/#token=' + token });
  await uiWait(`document.querySelector('#connection-status')?.textContent.includes('已连接')`, 'UI connected');
  assert.equal(await evaluate(`document.querySelector('#judge-settings-button').previousElementSibling.id`), 'settings-button');
  assert.equal(await evaluate(`document.querySelector('#judge-settings-button').textContent`), '');
  assert.equal(await evaluate(`document.querySelector('#judge-settings-button').getAttribute('aria-label')`), 'Jev设置');
  for (const width of [1280, 390]) {
    await viewport(width, 960);
    assert.equal(await evaluate(`(()=>{const b=s=>document.querySelector(s).getBoundingClientRect(),j=b('#judge-settings-button'),r=b('#settings-button'),t=b('.task-card h2');return j.left>=r.right&&t.right<r.left&&j.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth+1;})()`), true);
  }
  await viewport(1280, 960); await screenshot('task-jev-entry');
  await openSettings();
  assert.equal(await evaluate(`document.querySelector('#judge-settings-title').textContent`), 'Jev设置');
  assert.equal(await evaluate(`document.querySelector('#settings-dialog').open`), false);
  assert.equal(await evaluate(`document.querySelector('#judge-disable').getAttribute('aria-pressed')`), 'true');
  assert.equal(await evaluate(`document.querySelector('#judge-key').placeholder`), '输入Jev密钥');
  assert.equal(await evaluate(`document.querySelector('#judge-key').parentElement.childNodes[0].textContent.trim()`), 'Jev密钥');
  assert.equal(await evaluate(`document.querySelector('#judge-clear-key,#judge-url-help,#judge-enabled,#judge-protocol,#judge-model,.judge-description')`), null);
  assert.equal(await evaluate(`document.querySelector('#judge-settings-dialog').textContent.includes('对新任务生效')`), false);
  assert.equal(await evaluate(`document.querySelector('#judge-mode')`), null);
  assert.equal(await evaluate(`document.querySelector('#judge-features').hidden&&document.querySelector('#judge-features').disabled`), true);
  assert.deepEqual(await evaluate(`['task-dispatch','tool-calls','tool-results','submission-review'].map(id=>document.querySelector('#judge-'+id).checked)`), [false, false, true, true]);
  assert.deepEqual(await evaluate(`['requests','timeouts','fallbacks','saved','latency'].map(id=>document.querySelector('#judge-run-'+id).textContent.replace(/,/g,''))`), ['12', '1', '5', '0', '2400 ms']);
  assert.equal(await evaluate(`document.querySelector('#judge-run-status').textContent`), '历史任务：仅统计，未应用判断');
  assert.equal(await evaluate(`document.querySelector('#judge-run-potential')`), null);
  assert.equal(await evaluate(`document.querySelector('#judge-run-usage').hidden`), false);
  assert.equal(Object.hasOwn(await api(), 'mode'), false);
  assert.equal(report.localRequests, 0);
  check('independent dialog, fixed System One and jev-latest without editable controls, disabled defaults, and accurate historical task statistics');
  for (const enabled of [false, true]) {
    await click(enabled ? '#judge-enable' : '#judge-disable');
    await click('#judge-save');
    await uiWait(`document.querySelector('#judge-check-status').textContent==='尚未配置Jev密钥'`, 'missing key notification');
    assert.equal(await evaluate(`document.querySelector('#judge-settings-dialog').open`), true);
    assert.equal((await api()).hasApiKey, false); assert.equal((await api()).enabled, false);
  }
  await screenshot('jev-missing-key');
  await click('[data-dialog-close="judge-settings-dialog"]'); await openSettings();
  assert.equal(await evaluate(`document.querySelector('#judge-disable').getAttribute('aria-pressed')`), 'true');
  await evaluate(`document.querySelector('#judge-enable').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await evaluate(`document.querySelector('#judge-enable').getAttribute('aria-pressed')`), 'true');
  await uiWait(`(()=>{const a=document.querySelector('#judge-enable'),b=document.querySelector('#judge-disable');return a.getBoundingClientRect().right<=b.getBoundingClientRect().left&&getComputedStyle(a).boxShadow!=='none'&&getComputedStyle(b).boxShadow==='none';})()`, 'selected switch shadow');
  assert.equal((await api()).enabled, false);
  check('both switch choices require a first key, keep errors open, discard cancelled drafts, and support keyboard activation with selected shadow');
  assert.equal(await evaluate(`document.querySelector('#judge-features').hidden`), true);
  await fill('#judge-key', fixtureKey);
  assert.equal(await evaluate(`document.querySelector('#judge-features').hidden||document.querySelector('#judge-features').disabled`), false);
  for (const id of ['task-dispatch','tool-calls','tool-results','submission-review']) await click('#judge-'+id);
  await click('#judge-disable'); assert.equal(await evaluate(`document.querySelector('#judge-features').hidden`), true);
  await click('#judge-enable'); assert.equal(await evaluate(`document.querySelector('#judge-features').hidden`), false);
  await fill('#judge-key', ''); assert.equal(await evaluate(`document.querySelector('#judge-features').hidden`), true);
  await fill('#judge-key', fixtureKey); assert.equal(await evaluate(`document.querySelector('#judge-features').hidden`), false);
  assert.deepEqual(await evaluate(`['task-dispatch','tool-calls','tool-results','submission-review'].map(id=>document.querySelector('#judge-'+id).checked)`), [true, true, false, false]);
  check('four selections appear only after enabling with a key and persist through switch and draft-key changes');
  await screenshot('jev-desktop');
  for (const [width, height] of [[1280, 960], [390, 844]]) {
    await viewport(width, height); await evaluate(`document.querySelector('.judge-advanced').open=true`);
    const geometry = await evaluate(`(()=>{const d=document.querySelector('#judge-settings-dialog'),r=d.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,scroll:d.scrollWidth,client:d.clientWidth,outer:document.documentElement.scrollWidth};})()`);
    assert.ok(geometry.top >= 0 && geometry.bottom <= height + 1 && geometry.width <= width && geometry.scroll <= geometry.client + 1 && geometry.outer <= width + 1, JSON.stringify(geometry));
    await evaluate(`document.querySelector('#judge-save').scrollIntoView({block:'center'})`);
    assert.ok(await evaluate(`(()=>{const b=document.querySelector('#judge-save').getBoundingClientRect(),d=document.querySelector('#judge-settings-dialog').getBoundingClientRect();return b.top>=d.top&&b.bottom<=d.bottom;})()`));
    await screenshot(width === 390 ? 'jev-mobile' : 'jev-desktop-advanced');
  }
  check('desktop and narrow viewport have no horizontal overflow and save remains reachable');
  await viewport(1280, 960);
  await fill('#judge-url', 'http://127.0.0.1:' + mock.address().port); await fill('#judge-key', fixtureKey);
  await click('#judge-check');
  await uiWait(`document.querySelector('#judge-check-status').textContent.includes('连接成功')`, 'connection succeeds');
  assert.equal((await api()).hasApiKey, false); assert.equal((await api()).enabled, false);
  assert.equal(await evaluate(`document.querySelector('#judge-settings-dialog').open`), true);
  assert.equal(report.localRequests, 1);
  check('local connection test reports success without saving settings or closing dialog');
  failureMode = true; await click('#judge-check');
  await uiWait(`document.querySelector('#judge-check-status').textContent.includes('无效')`, 'safe authentication failure');
  assert.ok(!(await evaluate(`document.querySelector('#judge-check-status').textContent`)).includes('private-provider-error'));
  await screenshot('jev-connection-error');
  failureMode = false; await click('#judge-save');
  await uiWait(`!document.querySelector('#judge-settings-dialog').open`, 'save closes');
  assert.equal((await api()).enabled, true); assert.equal((await api()).hasApiKey, true);
  assert.deepEqual((await api()).features, { taskDispatch: true, toolCalls: true, toolResults: false, submissionReview: false });
  assert.equal(Object.hasOwn(await api(), 'mode'), false);
  assert.ok(!(await fs.readFile(path.join(dataDir, 'profiles.json'), 'utf8')).includes(fixtureKey));
  await openSettings();
  assert.equal(await evaluate(`document.querySelector('#judge-key').value`), '');
  assert.equal(await evaluate(`document.querySelector('#judge-key-state').textContent`), '已保存');
  assert.equal(await evaluate(`document.querySelector('#judge-features').hidden`), false);
  assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(fixtureKey)})`), false);
  await click('#judge-disable'); assert.equal(await evaluate(`document.querySelector('#judge-features').hidden`), true);
  assert.equal((await api()).enabled, true);
  await click('[data-dialog-close="judge-settings-dialog"]'); await openSettings();
  assert.equal(await evaluate(`document.querySelector('#judge-enable').getAttribute('aria-pressed')`), 'true');
  await click('#judge-disable'); await click('#judge-save');
  await uiWait(`!document.querySelector('#judge-settings-dialog').open`, 'disable saved without replacing key');
  await uiWait(`document.activeElement===document.querySelector('#judge-settings-button')`, 'focus returns to independent Jev entry');
  assert.equal((await api()).enabled, false); assert.equal((await api()).hasApiKey, true);
  assert.deepEqual((await api()).features, { taskDispatch: true, toolCalls: true, toolResults: false, submissionReview: false });
  await openSettings(); await click('#judge-check');
  await uiWait(`document.querySelector('#judge-check-status').textContent.includes('连接成功')`, 'stored key remains usable');
  assert.equal(providerKeys.at(-1), 'Bearer ' + fixtureKey);
  await fill('#judge-key', replacementKey); await click('#judge-enable'); await click('#judge-save');
  await uiWait(`!document.querySelector('#judge-settings-dialog').open`, 'replacement key saved');
  await openSettings(); await click('#judge-check');
  await uiWait(`document.querySelector('#judge-check-status').textContent.includes('连接成功')`, 'replacement key is used');
  assert.equal(providerKeys.at(-1), 'Bearer ' + replacementKey);
  await click('#judge-save'); await uiWait(`!document.querySelector('#judge-settings-dialog').open`, 'blank save retains replacement key');
  await openSettings(); await click('#judge-check');
  await uiWait(`document.querySelector('#judge-check-status').textContent.includes('连接成功')`, 'replacement key remains after blank save');
  assert.equal(providerKeys.at(-1), 'Bearer ' + replacementKey);
  assert.ok(!(await fs.readFile(path.join(dataDir, 'profiles.json'), 'utf8')).includes(replacementKey));
  const savedJudge = JSON.parse(await fs.readFile(path.join(dataDir, 'profiles.json'), 'utf8')).judge;
  assert.equal(savedJudge.protocol, 'system-one'); assert.equal(savedJudge.model, 'jev-latest');
  assert.ok(providerRequests.length > 0);
  for (const request of providerRequests) {
    assert.equal(request.url, '/v1/systemone'); assert.equal(request.body.model, 'jev-latest');
    assert.equal(request.body.questions.ready.type, 'noul'); assert.equal(Object.hasOwn(request.body, 'messages'), false);
  }
  await click('[data-dialog-close="judge-settings-dialog"]');
  check('safe errors, switch save and cancellation, empty input retains credentials, replacement key is used, and keys stay absent from public state/profile JSON');

  stage('memory clear confirms scope and preserves source sessions');
  await click('[data-page="memory"]');
  await uiWait(`document.querySelector('#memory-entries-page').textContent.endsWith('/ 42')`, 'all fixture memories loaded');
  assert.equal(await evaluate(`document.querySelector('#memory-clear').previousElementSibling.id`), 'memory-refresh');
  assert.equal(await evaluate(`document.querySelector('#memory-clear use').getAttribute('href')`), '#i-trash');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#memory-clear')).color`), 'rgb(197, 83, 77)');
  await evaluate(`(()=>{const e=document.querySelector('#memory-entry-kind');e.value='user';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('#memory-entry-search button'); await uiWait(`document.querySelector('#memory-entries-page').textContent.endsWith('/ 21')`, 'filtered user memories');
  await click('#memory-entries-next'); await uiWait(`document.querySelector('#memory-entries-page').textContent.startsWith('21')`, 'filtered second page');
  const beforeStatus = await memoryApi('/api/memory/status');
  dialogDecision = false; await click('#memory-clear');
  assert.match(report.lastConfirmation, /所有长期记忆/); assert.match(report.lastConfirmation, /原始会话记录会保留/);
  assert.equal((await memoryApi('/api/memory/entries')).total, 42);
  await screenshot('memory-clear-entry');
  dialogDecision = true; await click('#memory-clear');
  await uiWait(`document.querySelector('#memory-entries-content').textContent==='暂无记录'&&!document.querySelector('#memory-clear').disabled`, 'clear completes');
  assert.equal((await memoryApi('/api/memory/entries')).total, 0);
  const afterStatus = await memoryApi('/api/memory/status');
  assert.equal(afterStatus.memories, 0); assert.equal(afterStatus.sessions, beforeStatus.sessions); assert.equal(afterStatus.records, beforeStatus.records);
  assert.equal((await memoryApi('/api/memory/sessions?projectId=*')).total, 1);
  assert.equal(await fs.readFile(historyFile, 'utf8'), historyText);
  assert.equal(await evaluate(`document.querySelector('#memory-entries-prev').disabled&&document.querySelector('#memory-entries-next').disabled&&document.querySelector('#memory-entries-page').textContent===''`), true);
  await screenshot('memory-cleared');
  await click('#memory-settings-button'); await uiWait(`document.querySelector('#memory-summary').textContent.includes('0 条长期记忆')`, 'memory summary refreshed');
  await click('[data-dialog-close="memory-settings-dialog"]');
  check('red clear icon after refresh, cancellation, global clear from filtered second page, refreshed empty state, and original sessions preserved');
  assert.deepEqual(report.pageErrors, []); report.passed = true;
} catch (error) {
  report.passed = false; report.error = String(error.stack).replaceAll(token, '[redacted]').replaceAll(fixtureKey, '[redacted]');
  if (evaluate && !lifetime.signal.aborted) { try { await screenshot('failure'); } catch {} }
  console.error(report.error);
} finally { await finish(); }
