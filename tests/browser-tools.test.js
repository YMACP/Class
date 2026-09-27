import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserTools, CdpConnection, browserToolDefinitions, findBrowserExecutable } from '../src/browser-tools.js';
import { FirefoxConnection } from '../src/firefox-browser.js';
import { ToolManager } from '../src/tools.js';
import { createStudent } from '../src/agents.js';

function basicManager() {
  return { cwd: process.cwd(), maxOutputBytes: 65536, controller: new AbortController(), checkpoint: async signal => signal?.throwIfAborted() };
}

// Simulate the transport boundary, including send() failures before dispatch
// and connections that disappear only after accepting a mutating request.
function cdpFixture(browser, { fault, matches = () => false, domError, navigationError } = {}) {
  class Socket extends EventTarget {
    readyState = WebSocket.OPEN;
    requests = [];
    send(text) {
      const request = JSON.parse(text), selected = matches(request);
      if (selected && fault === 'send') throw new Error('Fixture send failed before dispatch');
      this.requests.push(request);
      if (selected && fault === 'disconnect') { queueMicrotask(() => this.close()); return; }
      if (selected && fault === 'timeout') return;
      let result = {};
      if (request.method === 'Target.getTargets') result = { targetInfos: [{ type: 'page', targetId: 'owned-tab', url: 'about:blank' }] };
      if (request.method === 'Target.createTarget') result = { targetId: 'new-owned-tab' };
      if (request.method === 'Target.attachToTarget') result = { sessionId: 'new-owned-page-session' };
      if (request.method === 'Page.navigate' && navigationError) result = { errorText: navigationError };
      if (request.method === 'Runtime.evaluate') {
        const mutation = request.params.expression.includes('let browserEffect=false');
        const value = mutation
          ? domError ? { browserEffect: false, browserError: domError } : { browserEffect: true, value: { x: 10, y: 10 } }
          : true;
        result = { result: { value } };
      }
      const message = selected && ['rejected', 'terminated'].includes(fault)
        ? { id: request.id, error: { code: fault === 'rejected' ? -32602 : -32000, message: fault === 'rejected' ? 'Invalid parameters; command not executed' : 'Execution was terminated' } }
        : { id: request.id, result };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })));
    }
    close() { if (this.readyState !== WebSocket.CLOSED) { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')); } }
  }
  const socket = new Socket(), connection = new CdpConnection(socket);
  const session = { connection, activeTabId: 'owned-tab', refKey: 'fixture-refs', pages: new Map([['owned-tab', { targetId: 'owned-tab', sessionId: 'owned-page-session' }]]) };
  browser._session = async () => session;
  return { socket, connection };
}

// Exercise real transport decoding together with the Firefox adapter. Wire
// errors are deliberately BiDi top-level strings, not CDP error objects.
function bidiFixture(browser, { fault, matches = () => false, domError } = {}) {
  class Socket extends EventTarget {
    readyState = WebSocket.OPEN;
    requests = [];
    send(text) {
      const request = JSON.parse(text), selected = matches(request);
      if (selected && fault === 'send') throw new Error('Fixture send failed before dispatch');
      this.requests.push(request);
      if (selected && fault === 'disconnect') { queueMicrotask(() => this.close()); return; }
      if (selected && fault === 'timeout') return;
      let result = {};
      if (request.method === 'browsingContext.getTree') result = { contexts: [{ context: 'owned-tab', url: 'about:blank', children: null }] };
      if (request.method === 'browsingContext.create') result = { context: 'new-owned-tab' };
      if (request.method === 'script.evaluate') {
        const mutation = request.params.expression.includes('let browserEffect=false');
        const value = mutation
          ? domError ? { browserEffect: false, browserError: domError } : { browserEffect: true, value: { x: 10, y: 10 } }
          : request.params.expression.includes('document.title') ? 'Owned fixture tab' : true;
        result = { type: 'success', realm: 'owned-realm', result: { type: 'string', value: JSON.stringify(value) } };
      }
      const message = selected && ['invalid argument', 'unknown command', 'unknown error', 'script timeout'].includes(fault)
        ? { type: 'error', id: request.id, error: fault, message: `Fixture BiDi ${fault}` }
        : { type: 'success', id: request.id, result };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })));
    }
    close() { if (this.readyState !== WebSocket.CLOSED) { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')); } }
  }
  const socket = new Socket(), transport = new CdpConnection(socket, 'bidi');
  const connection = new FirefoxConnection(transport, signal => browser._checkpoint(signal));
  const session = { connection, activeTabId: 'owned-tab', refKey: 'fixture-refs', pages: new Map([['owned-tab', { targetId: 'owned-tab', sessionId: 'owned-tab' }]]) };
  browser._session = async () => session;
  return { socket, connection, transport };
}

test('shared transport decodes BiDi errors without misclassifying dispatched failures', async t => {
  for (const fault of ['invalid argument', 'unknown command', 'unknown error', 'script timeout']) await t.test(fault, async () => {
    const browser = new BrowserTools(basicManager());
    const fixture = bidiFixture(browser, { fault, matches: request => request.method === 'input.performActions' });
    let sent = 0;
    try {
      await assert.rejects(fixture.transport.send('input.performActions', { context: 'owned-tab', actions: [] }, undefined, new AbortController().signal, () => { sent++; }), error => {
        assert.match(error.message, new RegExp(`Fixture BiDi ${fault}`));
        assert.equal(error.browserRequestState, ['invalid argument', 'unknown command'].includes(fault) ? 'rejected' : 'uncertain');
        return true;
      });
      assert.equal(sent, 1);
      assert.equal(fixture.socket.requests.length, 1);
      assert.equal(fixture.transport.pending.size, 0);
    } finally { fixture.connection.close(); await browser.stopAll(); }
  });
});

test('Firefox transport and shared effect accounting distinguish uncertain actions from pre-dispatch failure', async t => {
  const input = request => request.method === 'input.performActions';
  const mutation = request => request.method === 'script.evaluate' && request.params.expression.includes('let browserEffect=false');
  const cases = [
    { label: 'accepted key disconnected', args: { action: 'press', key: 'Enter' }, fault: 'disconnect', matches: input, unknown: true },
    { label: 'key send failed before dispatch', args: { action: 'press', key: 'Enter' }, fault: 'send', matches: input, unknown: false },
    { label: 'key explicitly rejected', args: { action: 'press', key: 'Enter' }, fault: 'invalid argument', matches: input, unknown: false },
    { label: 'unknown key command rejected', args: { action: 'press', key: 'Enter' }, fault: 'unknown command', matches: input, unknown: false },
    { label: 'fill response lost', args: { action: 'fill', selector: '#input', text: 'once', timeoutMs: 100 }, fault: 'timeout', matches: mutation, unknown: true },
    { label: 'fill timed out in browser after dispatch', args: { action: 'fill', selector: '#input', text: 'once' }, fault: 'script timeout', matches: mutation, unknown: true },
    { label: 'click release rejected after partial effect', args: { action: 'click', selector: '#button' }, fault: 'invalid argument', matches: request => input(request) && request.params.actions[0].actions[0].type === 'pointerUp', unknown: true },
    { label: 'DOM input rejected before effect', args: { action: 'fill', selector: '#missing', text: 'once' }, domError: 'Element not found', unknown: false },
    { label: 'readonly screenshot response lost', args: { action: 'screenshot', timeoutMs: 100 }, fault: 'timeout', matches: request => request.method === 'browsingContext.captureScreenshot', unknown: false },
  ];
  for (const scenario of cases) await t.test(scenario.label, async () => {
    const browser = new BrowserTools(basicManager()), fixture = bidiFixture(browser, scenario);
    try {
      await assert.rejects(browser.execute('student', 'browser', scenario.args), error => {
        assert.equal(error.executionStatus, scenario.unknown ? 'unknown' : undefined);
        return true;
      });
    } finally { fixture.connection.close(); await browser.stopAll(); }
  });
});

test('browser distinguishes ambiguous mutations from operations that never executed', async t => {
  const cases = [
    { label: 'key request accepted then disconnected', args: { action: 'press', key: 'Enter' }, fault: 'disconnect', matches: request => request.method === 'Input.dispatchKeyEvent', unknown: true },
    { label: 'fill request accepted then timed out', args: { action: 'fill', selector: '#input', text: 'once', timeoutMs: 100 }, fault: 'timeout', matches: request => request.method === 'Runtime.evaluate', unknown: true },
    { label: 'fill evaluation terminated after dispatch', args: { action: 'fill', selector: '#input', text: 'once' }, fault: 'terminated', matches: request => request.method === 'Runtime.evaluate', unknown: true },
    { label: 'click partially completed before release rejection', args: { action: 'click', selector: '#button' }, fault: 'rejected', matches: request => request.method === 'Input.dispatchMouseEvent' && request.params.type === 'mouseReleased', unknown: true },
    { label: 'send threw before the first key request', args: { action: 'press', key: 'Enter' }, fault: 'send', matches: request => request.method === 'Input.dispatchKeyEvent', unknown: false },
    { label: 'browser explicitly rejected the first key request', args: { action: 'press', key: 'Enter' }, fault: 'rejected', matches: request => request.method === 'Input.dispatchKeyEvent', unknown: false },
    { label: 'DOM validation rejected an input before mutation', args: { action: 'fill', selector: '#missing', text: 'once' }, domError: 'Element not found', unknown: false },
    { label: 'new blank tab followed by explicit navigation failure', args: { action: 'open', url: 'http://fixture.invalid' }, navigationError: 'net::ERR_NAME_NOT_RESOLVED', unknown: false },
    { label: 'connection failed while locating the target before action', args: { action: 'press', key: 'Enter' }, fault: 'disconnect', matches: request => request.method === 'Target.getTargets', unknown: false },
    { label: 'readonly screenshot timed out after send', args: { action: 'screenshot', timeoutMs: 100 }, fault: 'timeout', matches: request => request.method === 'Page.captureScreenshot', unknown: false },
  ];
  for (const scenario of cases) await t.test(scenario.label, async () => {
    const browser = new BrowserTools(basicManager());
    const fixture = cdpFixture(browser, scenario);
    try {
      await assert.rejects(browser.execute('student', 'browser', scenario.args), error => {
        assert.equal(error.executionStatus, scenario.unknown ? 'unknown' : undefined);
        return true;
      });
    } finally { fixture.connection.close(); await browser.stopAll(); }
  });
});

test('real student adapter preserves ambiguous browser status and protocol recovery does not replay it', async t => {
 for (const protocol of ['cdp', 'bidi']) await t.test(protocol, async t => {
  const activity = [];
  const manager = new ToolManager({ allowShell: false, onActivity: async item => { activity.push(item); return { reference: `journal:browser-uncertain:${activity.length}` }; } });
  const mutationMethod = protocol === 'bidi' ? 'input.performActions' : 'Input.dispatchKeyEvent';
  const fixture = (protocol === 'bidi' ? bidiFixture : cdpFixture)(manager.browserTools, { fault: 'disconnect', matches: request => request.method === mutationMethod });
  t.after(async () => { fixture.connection.close(); await manager.stopAll(); });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    requests++;
    assert.ok(requests <= 6, 'uncertainty must not produce an unlimited recovery loop');
    if (requests === 2) {
      const resultBlock = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'tool_result');
      assert.equal(JSON.parse(resultBlock.content).executionStatus, 'unknown');
    }
    // Retrying with a new call ID still must not execute the same signature.
    return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `browser-press-${requests}`, name: 'browser', input: { action: 'press', key: 'Enter' } }] });
  });
  const student = createStudent({ id: 'alice', name: 'Alice' }, { protocol: 'messages', model: 'fixture', baseUrl: 'https://browser-fixture.invalid/v1', apiKey: 'fixture-key', timeoutMs: null }, manager);
  let recoveryVersion = 0;
  const context = { task: 'Press Enter once', signal: new AbortController().signal, blackboard: [], feedbackVersion: 0, checkpoint: async () => {}, readRecoveryVersion: () => recoveryVersion };
  await assert.rejects(student.solve(context), error => error.reasonCode === 'TOOL_RESULT_UNCERTAIN' && error.memberRecoverable === true);
  assert.equal(requests, 1, 'uncertainty must stop the member immediately');
  assert.equal(activity.find(item => item.type === 'failed').executionStatus, 'unknown');
  recoveryVersion++;
  await assert.rejects(student.solve(context), error => error.reasonCode === 'TOOL_RESULT_UNCERTAIN' && error.memberRecoverable === true);
  assert.equal(fixture.socket.requests.filter(request => request.method === mutationMethod).length, 1);
  assert.equal(activity.filter(item => item.type === 'started').length, 1, 'retry cannot enter ToolManager for the ambiguous operation again');
 });
});

test('browser contract and invalid calls reject before creating any browser/profile', async () => {
  const browser = new BrowserTools(basicManager());
  assert.deepEqual(browserToolDefinitions.map(tool => tool.name), ['browser']);
  const run = args => browser.execute('student', 'browser', args);
  await assert.rejects(run({ action: 'navigate', url: 'file:///C:/private.txt' }), /HTTP/);
  await assert.rejects(run({ action: 'navigate', url: 'https://user:secret@example.invalid' }), /credentials/);
  await assert.rejects(run({ action: 'evaluate', expression: 'process.env' }), /action/);
  await assert.rejects(run({ action: 'click' }), /ref or selector/);
  await assert.rejects(run({ action: 'fill', selector: 'input' }), /requires text/);
  await assert.rejects(run({ action: 'press', key: 'UnknownModifier+A' }), /modifier/);
  await assert.rejects(run({ action: 'tabs', timeoutMs: 0 }), /timeoutMs/);
  assert.equal(browser.sessions.size, 0);
  assert.equal(browser.profiles.size, 0);
  await browser.stopAll();
});

test('browser pause gate blocks new work and stop cancels it without a launch', async () => {
  const browser = new BrowserTools(basicManager());
  browser.pauseAll();
  let settled = false;
  const pending = browser.execute('student', 'browser', { action: 'tabs' });
  pending.finally(() => { settled = true; }).catch(() => {});
  await delay(30);
  assert.equal(settled, false);
  assert.equal(browser.sessions.size, 0);
  const rejected = assert.rejects(pending, /stopped/);
  await browser.stopAll();
  await rejected;
  assert.equal(browser.profiles.size, 0);
});

test('owned headless browser: actions, student isolation, process pause and cancellation cleanup', { timeout: 180000 }, async t => {
  let executable;
  try { executable = await findBrowserExecutable(); }
  catch (error) { t.skip(error.message); return; }
  const tempRoot = await fs.realpath(os.tmpdir());
  const workspace = await fs.mkdtemp(path.join(tempRoot, 'class-browser-test-'));
  const connections = new Set();
  let tickRequests = 0;
  let resolveDelayed;
  const delayedRequested = new Promise(resolve => { resolveDelayed = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/hang') return; // cancellation/timeout must terminate this owned page
    if (request.url === '/delayed') { resolveDelayed(response); return; }
    if (request.url === '/tick') { tickRequests++; response.writeHead(204); response.end(); return; }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><title>Class browser fixture</title><style>body{min-height:2200px}button,input{margin:10px}</style>
      <h1>Local fixture</h1><label>Name <input id="name" placeholder="Name"></label><button id="save">Save</button><p id="result">initial</p><p id="tick">0</p>
      <script>
        let ticks=0; setInterval(()=>{document.querySelector('#tick').textContent=String(++ticks);fetch('/tick').catch(()=>{});},50);
        document.querySelector('#save').onclick=()=>document.querySelector('#result').textContent=document.querySelector('#name').value;
        document.querySelector('#name').onkeydown=e=>{if(e.key==='Enter')document.querySelector('#result').textContent='enter:'+e.target.value};
      </script>`);
  });
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const manager = new ToolManager({ cwd: workspace, allowShell: false, browserOptions: { executablePath: executable } });
  const browser = manager.browserTools;
  const run = (student, args, signal) => browser.execute(student, 'browser', args, signal);
  const output = result => JSON.parse(result.output);
  t.after(async () => {
    await browser.stopAll();
    await manager.stopAll();
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    const relative = path.relative(tempRoot, workspace);
    assert.ok(relative.startsWith('class-browser-test-') && path.dirname(relative) === '.');
    assert.equal(await fs.realpath(workspace), workspace);
    await fs.rm(workspace, { recursive: true, force: true });
  });
  assert.equal(typeof manager.adoptProcess, 'function', 'ToolManager must track the browser process tree');
  const first = output(await run('alice', { action: 'open', url: base }));
  assert.equal(first.title, 'Class browser fixture');
  const firstSession = browser.sessions.get('alice');
  assert.ok(firstSession.record.controlledTree);
  const firstProfile = firstSession.profile;
  assert.notEqual(firstProfile, workspace);
  const expectedProfileRoot = process.platform === 'linux' && firstSession.browserType === 'firefox' ? await fs.realpath(os.homedir()) : tempRoot;
  assert.equal(path.dirname(firstProfile), expectedProfileRoot);
  const snapshot = output(await run('alice', { action: 'snapshot' }));
  assert.match(snapshot.text, /Local fixture/);
  const input = snapshot.elements.find(item => item.tag === 'input');
  const button = snapshot.elements.find(item => item.label === 'Save');
  assert.ok(input?.ref && button?.ref);
  await run('alice', { action: 'fill', ref: input.ref, text: 'isolated-value' });
  await run('alice', { action: 'click', ref: button.ref });
  assert.match(output(await run('alice', { action: 'snapshot' })).text, /isolated-value/);
  await run('alice', { action: 'fill', selector: '#name', text: 'keyboard' });
  await run('alice', { action: 'press', key: 'Enter' });
  assert.match(output(await run('alice', { action: 'snapshot' })).text, /enter:keyboard/);
  const screenshot = await run('alice', { action: 'screenshot' });
  assert.equal(screenshot.media[0].mimeType, 'image/png');
  assert.equal(Buffer.from(screenshot.media[0].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(Buffer.from(screenshot.media[0].data, 'base64').length <= 5 * 1024 * 1024);
  await run('alice', { action: 'scroll', y: 500 });
  const alicePage = firstSession.pages.get(first.tabId);
  const evaluate = expression => browser._evaluate(firstSession, alicePage, expression, new AbortController().signal);
  await delay(100);
  assert.ok(await evaluate('scrollY') > 0);

  const second = output(await run('bob', { action: 'open', url: base }));
  const secondProfile = browser.sessions.get('bob').profile;
  assert.notEqual(firstProfile, secondProfile);
  assert.notEqual(firstSession.child.pid, browser.sessions.get('bob').child.pid);
  await assert.rejects(run('bob', { action: 'snapshot', tabId: first.tabId }), /Unknown tabId/);
  assert.equal(output(await run('bob', { action: 'snapshot' })).elements.find(item => item.tag === 'input').value, '');

  // Serialize our gate with ToolManager's real tree suspension. Timer counters
  // must not catch up during the paused interval after the processes resume.
  await run('bob', { action: 'close', all: true });
  const before = await evaluate('Number(document.querySelector("#tick").textContent)');
  const delayedOpen = run('alice', { action: 'open', url: base + '/delayed', timeoutMs: 1000 });
  delayedOpen.catch(() => {});
  const delayedResponse = await delayedRequested;
  await manager.pauseAll();
  delayedResponse.end('<!doctype html><title>Resumed navigation</title>Ready');
  assert.equal(firstSession.record.suspended, true);
  let completed = false;
  const waiting = run('alice', { action: 'snapshot', tabId: first.tabId, timeoutMs: 1000 });
  waiting.finally(() => { completed = true; }).catch(() => {});
  await delay(100); // drain requests already sent before the tree was frozen
  const pausedRequests = tickRequests;
  await delay(1300);
  assert.equal(completed, false);
  assert.equal(tickRequests, pausedRequests, 'page timer/network activity must remain frozen');
  await manager.resumeAll();
  const delayedTab = output(await delayedOpen);
  assert.equal(delayedTab.title, 'Resumed navigation', 'in-flight navigation deadline excludes pause');
  await waiting;
  const after = await evaluate('Number(document.querySelector("#tick").textContent)');
  // PowerShell process-control overhead is variable; a second counter sampled
  // directly after resume confirms that the owned page remains operable.
  assert.ok(after >= before);
  assert.equal(firstSession.record.suspended, false);
  assert.ok(alive(firstSession.child));
  assert.ok(output(await run('alice', { action: 'tabs' })).tabs.some(tab => tab.tabId === first.tabId));
  await run('alice', { action: 'close', tabId: delayedTab.tabId });

  const abort = new AbortController();
  const navigation = run('alice', { action: 'navigate', url: base + '/hang' }, abort.signal);
  const rejected = assert.rejects(navigation, /fixture cancellation/);
  await delay(200);
  abort.abort(new Error('fixture cancellation'));
  await rejected;
  assert.equal(browser.sessions.has('alice'), false);
  assert.equal(alive(firstSession.child), false);
  await assert.rejects(fs.stat(firstProfile), { code: 'ENOENT' });
  await assert.rejects(fs.stat(secondProfile), { code: 'ENOENT' });
  assert.equal(browser.profiles.size, 0);
  assert.ok(second.tabId);
  const timed = run('timeout-student', { action: 'open', url: base + '/hang', timeoutMs: 3000 });
  await assert.rejects(timed, /timed out/);
  assert.equal(browser.sessions.size, 0);
  assert.equal(browser.profiles.size, 0);
});

function alive(child) { return child.exitCode === null && child.signalCode === null; }
