import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClassServer } from '../src/web-server.js';
import { createProfileStore } from '../src/profile-store.js';
import { ModelClient } from '../src/agents.js';
import { CheckpointStore } from '../src/checkpoint-store.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// This suite uses only a loopback API and an injected updater. No executable is
// downloaded, started or replaced; all profile writes belong to this fixture.
async function fixture(t, { prepare, ...options } = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-update-api-'));
  const dataDir = path.join(root, 'data'), token = 'isolated-update-' + randomUUID();
  let app, cleanup;
  t.after(async () => {
    await cleanup?.(); await app?.close();
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('class-update-api-'));
    assert.equal((await fs.lstat(resolved)).isSymbolicLink(), false);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await prepare?.(dataDir);
  app = await createClassServer({ dataDir, token, ...options });
  return { app, root, dataDir, token, cleanup(action) { cleanup = action; },
    async request(route, { method = 'GET', body, raw, authorized = true, headers = {} } = {}) {
      const response = await fetch(app.url + route, { method,
        headers: { ...(authorized ? { authorization: 'Bearer ' + token } : {}),
          ...(body === undefined && raw === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      return { status: response.status, value: await response.json() };
    },
  };
}

test('source server exposes unsupported update state and cannot perform an executable update', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const current = await f.request('/api/state'), update = await f.request('/api/update');
  assert.equal(current.status, 200); assert.equal(update.status, 200);
  assert.deepEqual(update.value, { state: 'idle', version: current.value.version, supported: false });
  assert.deepEqual(current.value.update, update.value);
  const start = await f.request('/api/update', { method: 'POST', body: {} });
  assert.equal(start.status, 202); assert.equal(start.value.state, 'failed');
  assert.equal(start.value.supported, false); assert.equal(start.value.version, current.value.version);
  assert.equal(start.value.message, '更新失败');
  assert.equal((await f.request('/api/state')).status, 200, 'unsupported updates must leave the source server running');
});

test('update API and state expose the controller status and repeated starts remain one controller job', { timeout: 15000 }, async t => {
  let current = { state: 'idle', version: '1.2.0', supported: true }, jobCount = 0, startCalls = 0, closed = 0, captured;
  const updater = { status: () => ({ ...current }),
    start(options) {
      startCalls++;
      if (!captured) { captured = options; jobCount++; current = { ...current, state: 'checking' }; }
      return { ...current };
    },
    async close() { closed++; },
  };
  const f = await fixture(t, { updater });
  assert.deepEqual((await f.request('/api/update')).value, current);
  assert.deepEqual((await f.request('/api/state')).value.update, current);
  for (let i = 0; i < 2; i++) {
    const response = await f.request('/api/update', { method: 'POST', body: {} });
    assert.equal(response.status, 202); assert.deepEqual(response.value, current);
  }
  assert.equal(jobCount, 1); assert.equal(startCalls, 2);
  assert.equal(captured.dataDir, f.dataDir); assert.equal(typeof captured.prepareRestart, 'function');
  current = { ...current, state: 'downloading', progress: 42, latestVersion: '1.2.1' };
  assert.deepEqual((await f.request('/api/update')).value, current);
  assert.deepEqual((await f.request('/api/state')).value.update, current);
  const run = await f.request('/api/runs', { method: 'POST', body: { demo: true } });
  assert.equal(run.status, 202, 'checking/downloading cannot block ordinary classroom activity');
  await f.app.close(); await f.app.close();
  assert.equal(closed, 1, 'server close must cancel unfinished update work exactly once');
});

test('update routes require the local token and same-origin access and reject extra POST fields', { timeout: 15000 }, async t => {
  let starts = 0;
  const updater = { status: () => ({ state: 'idle', supported: true, version: '1.2.0' }), start() { starts++; return this.status(); }, close() {} };
  const f = await fixture(t, { updater });
  assert.equal((await f.request('/api/update', { authorized: false })).status, 401);
  assert.equal((await f.request('/api/update', { method: 'POST', body: {}, authorized: false })).status, 401);
  assert.equal((await f.request('/api/update', { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await f.request('/api/update', { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  for (const body of [{ url: 'https://untrusted.invalid/Class.exe' }, { dataDir: f.root }, { force: true }, []]) {
    const response = await f.request('/api/update', { method: 'POST', body });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await f.request('/api/update', { method: 'POST', raw: '{invalid' })).status, 400);
  assert.equal(starts, 0, 'invalid requests cannot reach an updater');
});

test('an active directory transition and application shutdown reject update starts', { timeout: 15000 }, async t => {
  const entered = deferred(), release = deferred();
  let starts = 0, closes = 0;
  const updater = { status: () => ({ state: 'idle', version: '1.2.0', supported: true }),
    start() { starts++; return this.status(); }, async close() { closes++; } };
  const f = await fixture(t, { updater,
    async dataDirectoryLoader() { entered.resolve(); await release.promise; return { url: 'http://127.0.0.1:45001/' }; },
  });
  f.cleanup(() => release.resolve());
  const changing = f.request('/api/data-directory/load', { method: 'POST', body: { path: path.join(f.root, 'selected') } });
  await entered.promise;
  assert.equal((await f.request('/api/update', { method: 'POST', body: {} })).status, 409);
  const closing = f.app.close();
  assert.equal((await f.request('/api/update', { method: 'POST', body: {} })).status, 503);
  release.resolve(); assert.equal((await changing).status, 200); await closing;
  assert.equal(starts, 0); assert.equal(closes, 1);
});

test('preparing a ready update stops and saves paused runs, blocks mutations, and can restore service', { timeout: 15000 }, async t => {
  let captured, status = { state: 'idle', version: '1.2.0', supported: true };
  const updater = { status: () => ({ ...status }),
    start(options) { captured ||= options; status = { ...status, state: 'downloading' }; return this.status(); }, close() {} };
  const f = await fixture(t, { updater });
  assert.equal((await f.request('/api/update', { method: 'POST', body: {} })).status, 202);
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const started = await f.request('/api/runs', { method: 'POST', body: { demo: true } });
    assert.equal(started.status, 202, 'download preparation permits concurrent classroom runs');
    const id = started.value.run.id; ids.push(id);
    const paused = await f.request(`/api/runs/${id}/pause`, { method: 'POST', body: {} });
    assert.equal(paused.status, 200); assert.equal(paused.value.run.status, 'paused');
  }
  const before = await f.request('/api/state');
  assert.deepEqual(new Set(before.value.runs.map(run => run.id)), new Set(ids));
  assert.ok(before.value.runs.every(run => run.status === 'paused'));

  // The controller invokes this after its request returned. Awaiting it while
  // owning the server's mutation queue would deadlock this real stop/save path.
  const preparing = captured.prepareRestart();
  const denied = await Promise.all([
    f.request('/api/runs', { method: 'POST', body: { demo: true } }),
    f.request('/api/data-directory', { method: 'PUT', body: { path: path.join(f.root, 'blocked-migration') } }),
    f.request(`/api/runs/${ids[0]}/resume`, { method: 'POST', body: {} }),
  ]);
  assert.deepEqual(denied.map(result => result.status), [409, 409, 409]);
  const restore = await preparing;
  assert.equal(typeof restore, 'function');
  f.app.assertUpdateSafe();
  const stopped = await f.request('/api/state');
  assert.equal(stopped.value.runs.length, 0);
  for (const id of ids) {
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'history', id + '.json'), 'utf8'));
    assert.equal(saved.id, id); assert.equal(saved.status, 'stopped'); assert.ok(saved.finishedAt);
    assert.equal(saved.result.status, 'stopped'); assert.equal(saved.errorCode, null);
    const journal = (await fs.readFile(path.join(f.dataDir, 'history', id, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(journal.some(record => record.kind === 'result' && record.result?.status === 'stopped'), 'terminal results are flushed before replacement can begin');
  }
  assert.equal((await f.request('/api/runs', { method: 'POST', body: { demo: true } })).status, 409);
  await restore();
  assert.equal((await f.request('/api/runs', { method: 'POST', body: { demo: true } })).status, 202, 'failed/cancelled update preparation restores normal task submission');
});

test('a failed terminal checkpoint cancels update preparation and preserves the last complete recovery point', { timeout: 20000 }, async t => {
  const entered = deferred(); let captured, failures = 0;
  const updater = { status: () => ({ state: 'downloading', version: '1.2.0', supported: true }),
    start(options) { captured = options; return this.status(); }, close() {} };
  t.mock.method(ModelClient.prototype, 'json', async (_system, _input, signal, options) => {
    if (options.operation === 'criteria') return { criteria: [{ id: 'goal', description: 'Complete the fixture task.', evidenceType: 'text' }] };
    assert.equal(options.operation, 'solve'); entered.resolve();
    signal.throwIfAborted();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const originalWrite = CheckpointStore.prototype.write;
  t.mock.method(CheckpointStore.prototype, 'write', async function(id, state, metadata) {
    if (metadata.reason === 'task_finished') { failures++; throw Object.assign(Error('Fixture checkpoint device is full.'), { code: 'ENOSPC' }); }
    return originalWrite.call(this, id, state, metadata);
  });
  const f = await fixture(t, { updater, async prepare(dataDir) {
    const store = await createProfileStore(dataDir), ids = ['teacher', 'alice', 'bob'];
    await store.save({ ...store.config, agents: ids.map(id => ({ id, name: id, role: id === 'teacher' ? 'teacher' : 'student',
      baseUrl: 'https://isolated-update.invalid/v1', protocol: 'messages', model: 'mock-' + id })) },
    Object.fromEntries(ids.map(id => [id, 'isolated-update-fixture-key'])));
  } });
  assert.equal((await f.request('/api/memory/settings', { method: 'PUT', body: { enabled: false } })).status, 200);
  assert.equal((await f.request('/api/update', { method: 'POST', body: {} })).status, 202);
  const started = await f.request('/api/runs', { method: 'POST', body: { task: 'Keep this isolated operation pending until shutdown.' } });
  assert.equal(started.status, 202); const id = started.value.run.id;
  await entered.promise;
  const checkpointPath = path.join(f.dataDir, 'checkpoints', id + '.json'), before = await fs.readFile(checkpointPath);
  await assert.rejects(captured.prepareRestart(), /任务记录未完整保存/);
  assert.equal(failures, 1); assert.deepEqual(await fs.readFile(checkpointPath), before);
  assert.throws(() => f.app.assertUpdateSafe(), /任务记录未完整保存/);
  const state = (await f.request('/api/state')).value;
  assert.equal(state.runs.length, 0);
  assert.ok(state.storageWarnings.some(item => item.runId === id && item.operation === 'save_checkpoint'));
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'history', id + '.json'), 'utf8'));
  assert.equal(saved.status, 'failed'); assert.equal(saved.storageError.operation, 'save_checkpoint');
  assert.equal((await f.request('/api/runs', { method: 'POST', body: { demo: true } })).status, 202, 'failed preparation releases the update gate');
});
