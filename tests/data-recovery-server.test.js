import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createDataRecoveryServer } from '../src/data-recovery-server.js';

// These names are only HTTP payloads. No test opens or creates profile directories.
const TOKEN = 'class-recovery-http-fixture-local-token';
const ROOT = path.resolve(os.tmpdir(), 'class-recovery-http-fixture');
const DEFAULT = path.join(ROOT, 'default');
const REQUESTED = path.join(ROOT, 'missing');
const EXISTING = path.join(ROOT, 'moved profile');
const APP_URL = `http://127.0.0.1:45001/#token=${TOKEN}`;
const OPTIONS = { timeout: 10000 };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t, { cleanup, ...options } = {}) {
  const server = await createDataRecoveryServer({
    token: TOKEN, requestedPath: REQUESTED, defaultPath: DEFAULT,
    reason: new Error('Original directory is missing'),
    onSelect: async () => ({ url: APP_URL }), onShutdown: async () => {},
    directoryPicker: async () => ({ cancelled: true }), ...options,
  });
  t.after(async () => { await cleanup?.(); await server.close(); });
  return server;
}
function begin(server, route, { method = 'GET', body, raw, token = TOKEN, headers = {} } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  let request;
  const promise = new Promise((resolve, reject) => {
    request = http.request(new URL(route, server.url), {
      method, agent: false,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value; try { value = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, value });
      });
    });
    request.once('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error('Fixture HTTP timeout')));
    request.end(payload);
  });
  return { request, promise };
}
function call(server, route, options) { return begin(server, route, options).promise; }
function select(server, body = { mode: 'default' }, options = {}) {
  return call(server, '/api/recovery/select', { method: 'POST', body, ...options });
}

test('recovery host exposes only static unauthenticated UI and redacts authenticated startup reasons', OPTIONS, async t => {
  const requestedPath = path.join(ROOT, '<script>fixture</script>');
  const server = await fixture(t, { requestedPath, reason: new Error(`unavailable Bearer ${TOKEN} #token=${TOKEN}`) });
  const health = await call(server, '/health', { token: null });
  assert.equal(health.status, 200);
  assert.deepEqual(health.value, { app: 'class', mode: 'data-recovery' });
  const state = await call(server, '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.value.mode, 'data-recovery');
  assert.equal(state.value.recovery.requestedPath, requestedPath);
  assert.equal(state.value.recovery.defaultPath, DEFAULT);
  assert.ok(state.value.recovery.reason.includes('[REDACTED]'));
  assert.ok(!state.text.includes(TOKEN));
  for (const route of ['/', '/recovery.js', '/recovery.css']) {
    const response = await call(server, route, { token: null });
    assert.equal(response.status, 200);
    assert.ok(!response.text.includes(TOKEN));
    assert.ok(!response.text.includes(requestedPath));
    assert.match(response.headers['content-security-policy'], /script-src 'self'/);
    assert.ok(!response.headers['content-security-policy'].includes('unsafe-inline'));
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await call(server, '/api/runs')).status, 404);
});

test('recovery rejects invalid Host, Origin, cross-site requests and missing or wrong bearer tokens', OPTIONS, async t => {
  let invoked = 0;
  const server = await fixture(t, { onSelect: async () => { invoked++; return { url: APP_URL }; } });
  const cases = [
    { token: null, status: 401 },
    { token: 'x'.repeat(TOKEN.length), status: 401 },
    { headers: { Host: 'attacker.invalid' }, status: 403 },
    { headers: { Origin: 'https://attacker.invalid' }, status: 403 },
    { headers: { Origin: 'null' }, status: 403 },
    { headers: { 'Sec-Fetch-Site': 'cross-site' }, status: 403 },
  ];
  for (const { status, ...options } of cases) {
    const response = await select(server, { mode: 'default' }, options);
    assert.equal(response.status, status);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const state = await call(server, '/api/state', { headers: { Origin: server.url } });
  assert.equal(state.status, 200);
  assert.equal(invoked, 0);
});

test('recovery validates JSON, content type, request size and paths before invoking selection', OPTIONS, async t => {
  let invoked = 0;
  const server = await fixture(t, { onSelect: async () => { invoked++; return { url: APP_URL }; } });
  const invalid = [
    { raw: '{', status: 400 },
    { raw: 'null', status: 400 },
    { raw: '[]', status: 400 },
    { body: { mode: 'default' }, headers: { 'Content-Type': 'text/plain' }, status: 415 },
    { body: {}, status: 400 },
    { body: { mode: 'unknown' }, status: 400 },
    { body: { mode: 'default', path: EXISTING }, status: 400 },
    { body: { mode: 'default', extra: true }, status: 400 },
    { body: { mode: 'existing' }, status: 400 },
    { body: { mode: 'existing', path: 'relative/path' }, status: 400 },
    { body: { mode: 'existing', path: EXISTING + '\0suffix' }, status: 400 },
    { body: { mode: 'existing', path: ROOT + 'a'.repeat(32769) }, status: 400 },
    { raw: JSON.stringify({ mode: 'existing', path: ROOT + 'a'.repeat(65536) }), status: 413 },
  ];
  for (const { status, ...options } of invalid) {
    const response = await call(server, '/api/recovery/select', { method: 'POST', ...options });
    assert.equal(response.status, status, JSON.stringify(options).slice(0, 150));
  }
  assert.equal(invoked, 0);
  assert.equal((await select(server)).status, 200, 'Invalid requests must not poison the selection queue');
  assert.equal(invoked, 1);
});

test('failed selections stay retryable and successful selections alone are cached', OPTIONS, async t => {
  const calls = [];
  const server = await fixture(t, {
    onSelect: async choice => {
      calls.push(choice);
      if (calls.length === 1) throw new Error(`Fixture profile validation failed Bearer ${TOKEN}`);
      return { url: APP_URL };
    },
  });
  const failed = await select(server, { mode: 'existing', path: EXISTING });
  assert.equal(failed.status, 500);
  assert.match(failed.value.error, /Fixture profile validation failed/);
  assert.ok(!failed.text.includes(TOKEN));
  const successful = await select(server, { mode: 'existing', path: EXISTING });
  assert.equal(successful.status, 200);
  assert.deepEqual(successful.value, { url: APP_URL });
  assert.deepEqual(calls, [{ mode: 'existing', path: EXISTING }, { mode: 'existing', path: EXISTING }]);
  assert.deepEqual((await select(server)).value, successful.value);
  assert.equal(calls.length, 2);
});

test('concurrent successful selections start one profile and return the same committed URL', OPTIONS, async t => {
  const entered = deferred(), release = deferred();
  let invoked = 0;
  const server = await fixture(t, {
    cleanup: () => release.resolve(),
    onSelect: async () => { invoked++; entered.resolve(); await release.promise; return { url: APP_URL }; },
  });
  const first = select(server);
  await entered.promise;
  const second = select(server);
  const blockedPicker = await call(server, '/api/directories/pick', { method: 'POST', body: {} });
  assert.equal(blockedPicker.status, 409);
  release.resolve();
  const responses = await Promise.all([first, second]);
  for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(response.value, { url: APP_URL }); }
  assert.equal(invoked, 1);
});

test('picker cancellation leaves selection uncommitted and a subsequent valid path is returned unchanged', OPTIONS, async t => {
  const picked = EXISTING + ' ', calls = [];
  let selections = 0;
  const server = await fixture(t, {
    onSelect: async () => { selections++; return { url: APP_URL }; },
    directoryPicker: async options => { calls.push(options); return calls.length === 1 ? { cancelled: true } : { cancelled: false, path: picked }; },
  });
  const cancelled = await call(server, '/api/directories/pick', { method: 'POST', body: { initialPath: EXISTING } });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.value, { cancelled: true });
  const selected = await call(server, '/api/directories/pick', { method: 'POST', body: {} });
  assert.equal(selected.status, 200);
  assert.deepEqual(selected.value, { cancelled: false, path: picked });
  assert.equal(calls[0].initialPath, EXISTING);
  assert.equal(calls[1].initialPath, DEFAULT);
  assert.equal(selections, 0);
  assert.equal((await select(server, { mode: 'existing', path: picked })).status, 200);
  assert.equal(selections, 1);
});

test('picker rejects invalid request paths and returned paths without locking later attempts', OPTIONS, async t => {
  let calls = 0;
  const server = await fixture(t, { directoryPicker: async () => { calls++; return calls === 1 ? { cancelled: false, path: 'relative' } : { cancelled: true }; } });
  for (const body of [{ initialPath: 'relative' }, { initialPath: null }, { initialPath: DEFAULT + '\0' }, { extra: true }]) {
    assert.equal((await call(server, '/api/directories/pick', { method: 'POST', body })).status, 400);
  }
  assert.equal(calls, 0);
  assert.equal((await call(server, '/api/directories/pick', { method: 'POST', body: {} })).status, 500);
  assert.equal((await call(server, '/api/directories/pick', { method: 'POST', body: {} })).status, 200);
  assert.equal(calls, 2);
});

test('disconnecting a picker request aborts and settles it before another chooser starts', OPTIONS, async t => {
  const entered = deferred(), aborted = deferred();
  let calls = 0;
  const server = await fixture(t, {
    directoryPicker: async ({ signal }) => {
      calls++;
      if (calls > 1) return { cancelled: true };
      entered.resolve();
      await new Promise(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      return { cancelled: true };
    },
  });
  const pending = begin(server, '/api/directories/pick', { method: 'POST', body: {} });
  const interrupted = pending.promise.then(() => null, error => error);
  await entered.promise;
  pending.request.destroy(new Error('Fixture closes the page'));
  assert.match((await interrupted).message, /Fixture closes the page/);
  await aborted.promise;
  const next = await call(server, '/api/directories/pick', { method: 'POST', body: {} });
  assert.equal(next.status, 200);
  assert.deepEqual(next.value, { cancelled: true });
  assert.equal(calls, 2);
});

test('closing recovery aborts a chooser and waits for its cleanup before completing', OPTIONS, async t => {
  const entered = deferred(), aborted = deferred(), cleaned = deferred();
  let complete = false;
  const server = await fixture(t, {
    cleanup: () => cleaned.resolve(),
    directoryPicker: async ({ signal }) => {
      entered.resolve();
      await new Promise(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      await cleaned.promise;
      return { cancelled: true };
    },
  });
  const pending = call(server, '/api/directories/pick', { method: 'POST', body: {} });
  await entered.promise;
  const closing = server.close().then(() => { complete = true; });
  await aborted.promise;
  assert.equal(complete, false, 'The picker must finish its cleanup before server shutdown');
  cleaned.resolve();
  assert.deepEqual((await pending).value, { cancelled: true });
  await closing;
  assert.equal(complete, true);
  await server.close();
});

test('shutdown acknowledges first, rejects new selections and closes only after an in-flight choice is committed', OPTIONS, async t => {
  const entered = deferred(), commit = deferred(), shutdownStarted = deferred(), shutdownDone = deferred();
  let rememberedPath, shutdownComplete = false, calls = 0, server;
  server = await fixture(t, {
    cleanup: () => commit.resolve(),
    onSelect: async choice => { calls++; entered.resolve(); await commit.promise; rememberedPath = choice.path; return { url: APP_URL }; },
    onShutdown: async () => {
      shutdownStarted.resolve();
      await server.close();
      shutdownComplete = true;
      shutdownDone.resolve();
    },
  });
  const selection = select(server, { mode: 'existing', path: EXISTING });
  await entered.promise;
  const response = await call(server, '/api/shutdown', { method: 'POST', body: {} });
  assert.equal(response.status, 202);
  assert.deepEqual(response.value, { ok: true, readyToExit: true });
  await shutdownStarted.promise;
  assert.equal(shutdownComplete, false);
  assert.equal(rememberedPath, undefined);
  assert.equal((await select(server)).status, 503);
  commit.resolve();
  assert.equal((await selection).status, 200);
  await shutdownDone.promise;
  assert.equal(shutdownComplete, true);
  assert.equal(rememberedPath, EXISTING);
  assert.equal(calls, 1);
});
