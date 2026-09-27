import test from 'node:test';
import assert from 'node:assert/strict';
import { FirefoxConnection } from '../src/firefox-browser.js';

// Model the shared transport boundary, not Firefox internals. Production owns
// JSON/error decoding; these fixtures return the same result objects it emits.
function fixture(reply = () => ({}), checkpoint) {
  const requests = [], checkpoints = [];
  let permit = false;
  const connection = {
    closed: false,
    async send(method, params, context, signal, onSent) {
      assert.equal(permit, true, `${method} bypassed the task pause gate`);
      permit = false;
      assert.equal(context, undefined, 'BiDi routes by params.context, not a CDP session');
      signal?.throwIfAborted();
      const request = { method, params, signal };
      requests.push(request);
      onSent?.();
      return reply(request, requests.length);
    },
    close() { this.closed = true; },
  };
  const adapter = new FirefoxConnection(connection, async signal => {
    checkpoints.push(signal);
    signal?.throwIfAborted();
    await checkpoint?.(signal);
    signal?.throwIfAborted();
    permit = true;
  });
  return { adapter, connection, requests, checkpoints };
}

const signal = () => new AbortController().signal;
const scriptValue = value => ({ type: 'success', realm: 'fixture-realm', result: { type: 'string', value: JSON.stringify(value) } });

test('Firefox session initialization accepts supported versions and rejects incompatible browsers', async t => {
  for (const browserVersion of ['149.0', '149.0a1', '150.1']) await t.test(browserVersion, async () => {
    const { adapter, requests } = fixture(() => ({ sessionId: 'owned-session', capabilities: { browserName: 'firefox', browserVersion } }));
    await adapter.initialize(signal());
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].params, { capabilities: {} });
    assert.equal(requests[0].method, 'session.new');
  });
  for (const capabilities of [
    { browserName: 'firefox', browserVersion: '148.0' },
    { browserName: 'firefox', browserVersion: '128.10.0esr' },
    { browserName: 'firefox', browserVersion: 'unknown' },
    { browserName: 'chrome', browserVersion: '149.0' },
  ]) await t.test(JSON.stringify(capabilities), async () => {
    const { adapter, requests } = fixture(() => ({ sessionId: 'owned-session', capabilities }));
    await assert.rejects(adapter.initialize(signal()), /Firefox|149|version|版本/i);
    assert.equal(requests.length, 1, 'an incompatible session must not launch additional commands');
  });
});

test('Firefox denies downloads and propagates a failure to establish that protection', async () => {
  const { adapter, requests } = fixture();
  await adapter.send('Browser.setDownloadBehavior', { behavior: 'deny' }, undefined, signal());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'browser.setDownloadBehavior');
  assert.deepEqual(requests[0].params, { downloadBehavior: { type: 'denied' } });
  const rejected = Object.assign(new Error('Fixture download policy unavailable'), { browserRequestState: 'rejected' });
  const failure = fixture(() => { throw rejected; });
  await assert.rejects(failure.adapter.send('Browser.setDownloadBehavior', { behavior: 'deny' }, undefined, signal()), /download policy unavailable/);
  assert.equal(failure.requests.length, 1, 'failed protection must not be silently retried');
});

test('Firefox evaluation retains the shared mutation envelope and structured values', async () => {
  const envelope = { browserEffect: false, browserError: 'Element not found; take a new snapshot' };
  const value = { title: '中文 fixture', text: 'one\ntwo', elements: [{ ref: 'e1', value: '' }], nested: [null, true, 3] };
  for (const expected of [envelope, { browserEffect: true, value: { x: 1, y: 2 } }, value, null, false]) {
    const { adapter, requests } = fixture(() => scriptValue(expected));
    const expression = '(() => ({ browserEffect: false, value: "fixture" }))()';
    const result = await adapter.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false, userGesture: true }, 'owned-tab', signal());
    assert.deepEqual(result.result.value, expected);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'script.evaluate');
    assert.equal(requests[0].params.expression, `JSON.stringify((${expression}))`);
    assert.deepEqual(requests[0].params.target, { context: 'owned-tab' });
    assert.equal(requests[0].params.awaitPromise, false);
    assert.equal(requests[0].params.resultOwnership, 'none');
    assert.equal(requests[0].params.userActivation, true);
  }
});

test('Firefox page exceptions and transport rejection stay distinct without replay', async () => {
  const pageException = fixture(() => ({ type: 'exception', realm: 'fixture-realm', exceptionDetails: { text: 'Fixture page exception', lineNumber: 0, columnNumber: 0, exception: { type: 'error' } } }));
  const result = await pageException.adapter.send('Runtime.evaluate', { expression: 'throw new Error("fixture")' }, 'owned-tab', signal());
  assert.match(result.exceptionDetails.exception?.description || result.exceptionDetails.text, /Fixture page exception/);
  const rejection = Object.assign(new Error('Fixture invalid argument'), { browserRequestState: 'rejected' });
  const denied = fixture(() => { throw rejection; });
  await assert.rejects(denied.adapter.send('Runtime.evaluate', { expression: '1' }, 'owned-tab', signal()), error => error === rejection);
  assert.equal(denied.requests.length, 1);
});

test('Firefox tab discovery returns top-level tab ids, URLs and titles', async () => {
  const titles = { first: 'First tab', second: 'Second tab' };
  const { adapter, requests } = fixture(({ method, params }) => {
    if (method === 'browsingContext.getTree') return { contexts: [{ context: 'first', url: 'https://first.invalid', children: null }, { context: 'second', url: 'about:blank', children: null }] };
    if (method === 'script.evaluate') return scriptValue(titles[params.target.context]);
    assert.fail(`Unexpected discovery command ${method}`);
  });
  const result = await adapter.send('Target.getTargets', {}, undefined, signal());
  assert.deepEqual(result.targetInfos, [
    { type: 'page', targetId: 'first', title: 'First tab', url: 'https://first.invalid' },
    { type: 'page', targetId: 'second', title: 'Second tab', url: 'about:blank' },
  ]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].params, { maxDepth: 0 });
});

test('Firefox tab lifecycle, viewport, navigation and screenshot preserve the shared contract', async () => {
  const png = 'iVBORw0KGgo=';
  const { adapter, requests, checkpoints } = fixture(({ method }) => {
    if (method === 'browsingContext.create') return { context: 'new-tab' };
    if (method === 'browsingContext.captureScreenshot') return { data: png };
    return {};
  });
  const active = signal();
  let sent = 0;
  const run = (method, params = {}, context) => adapter.send(method, params, context, active, () => { sent++; });
  assert.deepEqual(await run('Target.createTarget', { url: 'about:blank' }), { targetId: 'new-tab' });
  assert.deepEqual(await run('Target.attachToTarget', { targetId: 'new-tab', flatten: true }), { sessionId: 'new-tab' });
  assert.deepEqual(await run('Page.enable', {}, 'new-tab'), {});
  await run('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, 'new-tab');
  assert.deepEqual(await run('Page.navigate', { url: 'https://fixture.invalid/path' }, 'new-tab'), {});
  assert.deepEqual(await run('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, 'new-tab'), { data: png });
  assert.deepEqual(await run('Target.closeTarget', { targetId: 'new-tab' }), { success: true });
  assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
    { method: 'browsingContext.create', params: { type: 'tab' } },
    { method: 'browsingContext.setViewport', params: { context: 'new-tab', viewport: { width: 1280, height: 720 }, devicePixelRatio: 1 } },
    { method: 'browsingContext.navigate', params: { context: 'new-tab', url: 'https://fixture.invalid/path', wait: 'interactive' } },
    { method: 'browsingContext.captureScreenshot', params: { context: 'new-tab', origin: 'viewport', format: { type: 'image/png' } } },
    { method: 'browsingContext.close', params: { context: 'new-tab', promptUnload: false } },
  ]);
  assert.equal(sent, requests.length, 'local bookkeeping must not invent dispatched effects');
  assert.equal(checkpoints.length, 7, 'local attachment and enable must also observe pause/cancel');
});

test('Firefox click and wheel send each input transition once', async () => {
  const { adapter, requests } = fixture();
  let sent = 0;
  const run = params => adapter.send('Input.dispatchMouseEvent', params, 'owned-tab', signal(), () => { sent++; });
  await run({ type: 'mousePressed', x: 20.25, y: 30.5, button: 'left', clickCount: 1 });
  await run({ type: 'mouseReleased', x: 20.25, y: 30.5, button: 'left', clickCount: 1 });
  await run({ type: 'mouseWheel', x: 640.4, y: 359.8, deltaX: -10.4, deltaY: 600.7 });
  assert.equal(requests.length, 3);
  assert.equal(sent, 3);
  assert.ok(requests.every(request => request.method === 'input.performActions' && request.params.context === 'owned-tab'));
  const down = requests[0].params.actions[0], up = requests[1].params.actions[0], wheel = requests[2].params.actions[0];
  assert.equal(down.type, 'pointer');
  assert.equal(down.parameters.pointerType, 'mouse');
  assert.equal(up.id, down.id, 'release must address the same pointer source');
  assert.deepEqual(down.actions, [{ type: 'pointerMove', x: 20.25, y: 30.5, origin: 'viewport', duration: 0 }, { type: 'pointerDown', button: 0 }]);
  assert.deepEqual(up.actions, [{ type: 'pointerUp', button: 0 }]);
  assert.equal(wheel.type, 'wheel');
  assert.deepEqual(wheel.actions, [{ type: 'scroll', x: 640, y: 360, deltaX: -10, deltaY: 601, origin: 'viewport', duration: 0 }]);
});

test('Firefox keyboard presses modifiers once and releases them in reverse order', async () => {
  const { adapter, requests } = fixture();
  let sent = 0;
  const run = params => adapter.send('Input.dispatchKeyEvent', params, 'owned-tab', signal(), () => { sent++; });
  await run({ type: 'keyDown', key: 'A', modifiers: 10, windowsVirtualKeyCode: 65 });
  await run({ type: 'keyUp', key: 'A', modifiers: 10, windowsVirtualKeyCode: 65 });
  await run({ type: 'keyDown', key: 'Enter', modifiers: 0, windowsVirtualKeyCode: 13 });
  await run({ type: 'keyUp', key: 'Enter', modifiers: 0, windowsVirtualKeyCode: 13 });
  assert.equal(requests.length, 4);
  assert.equal(sent, 4);
  const sources = requests.map(request => request.params.actions[0]);
  assert.ok(sources.every(source => source.type === 'key' && source.id === sources[0].id));
  assert.deepEqual(sources.map(source => source.actions), [
    [{ type: 'keyDown', value: '\uE009' }, { type: 'keyDown', value: '\uE008' }, { type: 'keyDown', value: 'A' }],
    [{ type: 'keyUp', value: 'A' }, { type: 'keyUp', value: '\uE008' }, { type: 'keyUp', value: '\uE009' }],
    [{ type: 'keyDown', value: '\uE007' }],
    [{ type: 'keyUp', value: '\uE007' }],
  ]);
});

test('Firefox checks cancellation at the pause gate before dispatching a command', async () => {
  const abort = new AbortController(), reason = new Error('Fixture cancelled while paused');
  const { adapter, requests } = fixture(undefined, async () => { abort.abort(reason); });
  await assert.rejects(adapter.send('Target.getTargets', {}, undefined, abort.signal), error => error === reason);
  assert.equal(requests.length, 0);
  const already = fixture();
  await assert.rejects(already.adapter.send('Target.getTargets', {}, undefined, abort.signal), error => error === reason);
  assert.equal(already.requests.length, 0);
});

test('Firefox cancellation between tab-tree and title requests prevents later work', async () => {
  const abort = new AbortController(), reason = new Error('Fixture cancelled during tab discovery');
  const { adapter, requests } = fixture(() => {
    abort.abort(reason);
    return { contexts: [{ context: 'owned-tab', url: 'about:blank' }] };
  });
  await assert.rejects(adapter.send('Target.getTargets', {}, undefined, abort.signal), error => error === reason);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'browsingContext.getTree');
});

test('Firefox preserves accepted-then-disconnected mutation errors without another send', async () => {
  const failure = Object.assign(new Error('Fixture disconnected after accepting mutation'), { browserRequestState: 'uncertain' });
  const { adapter, requests } = fixture(() => { throw failure; });
  let sent = 0;
  await assert.rejects(adapter.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 }, 'owned-tab', signal(), () => { sent++; }), error => error === failure);
  assert.equal(sent, 1, 'the owning BrowserTools must learn the mutation was dispatched');
  assert.equal(requests.length, 1, 'a lost response must never cause a replay');
});

test('Firefox forwards transport closure', () => {
  const { adapter, connection } = fixture();
  assert.equal(adapter.closed, false);
  adapter.close();
  assert.equal(connection.closed, true);
  assert.equal(adapter.closed, true);
});
