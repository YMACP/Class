import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolManager } from '../../src/tools.js';

export const browserActions = ['open', 'navigate', 'tabs', 'snapshot', 'click', 'fill', 'press', 'scroll', 'screenshot', 'close'];
export const browserFixtureHtml = `<!doctype html><title>Class browser compatibility</title>
<style>body{min-height:2400px}button,input{margin:10px}</style>
<h1>Isolated browser fixture</h1><input id="name" placeholder="Name"><button id="save">Save</button>
<p id="result">initial</p><p id="scroll">scroll:0</p>
<script>
document.querySelector('#save').onclick=()=>document.querySelector('#result').textContent=document.querySelector('#name').value;
document.querySelector('#name').onkeydown=e=>{if(e.key==='Enter')document.querySelector('#result').textContent='enter:'+e.target.value};
addEventListener('scroll',()=>document.querySelector('#scroll').textContent='scroll:'+Math.round(scrollY));
setInterval(()=>fetch('/tick').catch(()=>{}),50);
</script>`;

export function assertPng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(bytes.length > 8 && bytes.length <= 5 * 1024 * 1024, 'Screenshot must be a bounded PNG');
}

export async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

// This is test code embedded only in the dedicated verifier. Every browser is
// selected explicitly; absence of a required browser is never a skipped pass.
export async function verifyBrowserLifecycle(executable, workspace) {
  const sockets = new Set(), checks = {}, children = [], profiles = [], hanging = new Set();
  let tickRequests = 0, delayedResponse;
  let announceDelayed;
  const delayedRequested = new Promise(resolve => { announceDelayed = resolve; });
  const server = createServer((request, response) => {
    if (request.url.startsWith('/hang?')) { hanging.add(request.url); return; }
    if (request.url === '/delayed') { delayedResponse = response; announceDelayed(); return; }
    if (request.url === '/tick') { tickRequests++; response.writeHead(204); response.end(); return; }
    response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(browserFixtureHtml);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const manager = new ToolManager({ cwd: workspace, allowShell: false, browserOptions: { executablePath: executable } });
  const browser = manager.browserTools, actions = new Set();
  const run = async (student, args, signal) => { const result = await browser.execute(student, 'browser', args, signal); actions.add(args.action); return result; };
  const output = result => JSON.parse(result.output);
  // The standalone suite sets HOME before this process starts: Bun may cache
  // os.homedir(), so changing process.env.HOME here would not isolate it.
  const browserHome = process.platform === 'linux' ? await fs.realpath(os.homedir()) : undefined;
  const remember = student => {
    const session = browser.sessions.get(student); children.push(session.child); profiles.push(session.profile);
    if (process.platform === 'linux' && session.browserType === 'firefox') assert.equal(path.dirname(session.profile), browserHome, 'Firefox profile must stay inside the process home');
    return session;
  };
  try {
    const first = output(await run('alice', { action: 'open', url: base }));
    assert.equal(first.title, 'Class browser compatibility');
    const session = remember('alice'); assert.equal(session.record.controlledTree, true);
    const snapshot = output(await run('alice', { action: 'snapshot' }));
    assert.match(snapshot.text, /Isolated browser fixture/);
    const input = snapshot.elements.find(item => item.tag === 'input'), button = snapshot.elements.find(item => item.label === 'Save');
    assert.ok(input?.ref && button?.ref);
    await run('alice', { action: 'fill', ref: input.ref, text: 'isolated-value' });
    await run('alice', { action: 'click', ref: button.ref });
    assert.match(output(await run('alice', { action: 'snapshot' })).text, /isolated-value/);
    await run('alice', { action: 'fill', selector: '#name', text: 'keyboard' });
    await run('alice', { action: 'press', key: 'Enter' });
    assert.match(output(await run('alice', { action: 'snapshot' })).text, /enter:keyboard/);
    const screenshot = await run('alice', { action: 'screenshot' });
    assert.equal(screenshot.media[0].mimeType, 'image/png'); assertPng(Buffer.from(screenshot.media[0].data, 'base64'));
    await run('alice', { action: 'scroll', y: 500 }); await delay(150);
    assert.match(output(await run('alice', { action: 'snapshot' })).text, /scroll:[1-9]\d*/);
    checks.actionsAndScreenshot = true;

    const second = output(await run('bob', { action: 'open', url: base }));
    const other = remember('bob'); assert.notEqual(session.profile, other.profile); assert.notEqual(session.child.pid, other.child.pid);
    await assert.rejects(run('bob', { action: 'snapshot', tabId: first.tabId }), /Unknown tabId/);
    assert.equal(output(await run('bob', { action: 'snapshot' })).elements.find(item => item.tag === 'input').value, '');
    assert.ok(second.tabId); await run('bob', { action: 'close', all: true }); checks.studentIsolation = true;

    const delayedOpen = run('alice', { action: 'open', url: base + '/delayed', timeoutMs: 1500 }); delayedOpen.catch(() => {});
    await bounded(delayedRequested, 10000, 'Delayed navigation never reached its local fixture');
    await manager.pauseAll(); assert.equal(session.record.suspended, true);
    delayedResponse.end('<!doctype html><title>Resumed navigation</title>Ready');
    let completed = false;
    const waiting = run('alice', { action: 'snapshot', tabId: first.tabId, timeoutMs: 1500 });
    waiting.finally(() => { completed = true; }).catch(() => {});
    await delay(100); const pausedTicks = tickRequests; await delay(1800);
    assert.equal(completed, false); assert.equal(tickRequests, pausedTicks, 'Owned browser network timers must stay frozen during task pause');
    await manager.resumeAll();
    const delayedTab = output(await delayedOpen); assert.equal(delayedTab.title, 'Resumed navigation'); await waiting;
    assert.equal(session.record.suspended, false);
    assert.ok(output(await run('alice', { action: 'tabs' })).tabs.some(tab => tab.tabId === first.tabId));
    await run('alice', { action: 'close', tabId: delayedTab.tabId }); checks.pauseResumeAndActiveDeadline = true;

    const navigated = output(await run('alice', { action: 'navigate', tabId: first.tabId, url: base + '/fresh' }));
    assert.equal(navigated.title, 'Class browser compatibility');
    assert.equal(output(await run('alice', { action: 'snapshot' })).elements.find(item => item.tag === 'input').value, '');
    const abort = new AbortController(), navigation = run('alice', { action: 'navigate', url: base + '/hang?cancel' }, abort.signal);
    const rejected = assert.rejects(navigation, /fixture cancellation/); rejected.catch(() => {});
    const cancelDeadline = Date.now() + 10000;
    while (!hanging.has('/hang?cancel') && Date.now() < cancelDeadline) await delay(25);
    assert.equal(hanging.has('/hang?cancel'), true, 'Cancellation navigation never reached its fixture');
    abort.abort(Error('fixture cancellation')); await rejected;
    assert.equal(browser.sessions.has('alice'), false); checks.cancellation = true;
    await run('timeout-student', { action: 'open', url: base }); remember('timeout-student');
    await assert.rejects(run('timeout-student', { action: 'navigate', url: base + '/hang?timeout', timeoutMs: 3000 }), /timed out/);
    assert.equal(hanging.has('/hang?timeout'), true, 'Timeout must cover a real pending navigation, not browser startup');
    assert.equal(browser.sessions.size, 0); assert.equal(browser.profiles.size, 0); checks.timeout = true;
    assert.deepEqual([...actions].sort(), [...browserActions].sort()); checks.allActions = true;
  } finally {
    try { await manager.stopAll(); }
    finally {
      for (const socket of sockets) socket.destroy();
      await bounded(new Promise(resolve => server.close(resolve)), 5000, 'Browser fixture server did not stop');
    }
  }
  for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned browser root must exit');
  for (const profile of profiles) await assert.rejects(fs.lstat(profile), { code: 'ENOENT' });
  assert.equal(browser.sessions.size, 0); assert.equal(browser.profiles.size, 0); assert.equal(manager.children.size, 0);
  checks.processAndProfileCleanup = true;
  return { checks, actions: [...actions].sort(), browserPids: children.map(child => child.pid), passed: true };
}
