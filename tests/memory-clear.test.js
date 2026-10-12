import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemoryManager } from '../src/memory-manager.js';
import { createMemoryStore } from '../src/memory-store.js';
import { createClassServer } from '../src/web-server.js';

const admin = { admin: true }, timestamp = '2026-09-26T08:00:00.000Z';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-memory-clear-')), resources = [];
  t.after(async () => {
    for (const close of resources.reverse()) await close();
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('class-memory-clear-'));
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { directory, resources,
    async store() { const store = await createMemoryStore({ directory: path.join(directory, 'memory') }); resources.push(() => store.close()); return store; },
    async manager(options = {}) {
      const manager = new MemoryManager({ dataDir: directory, ...options }); resources.push(() => manager.close());
      assert.equal(await manager.start(), true, manager.error); await manager.flush(); return manager;
    },
  };
}
function seedSession(store, { id = 'run-' + randomUUID(), projectId = 'project-a', startedAt = timestamp } = {}) {
  const reference = `source:${id}`;
  store.registerSession({ id, projectId, task: 'KEEP_HISTORY 原始会话', status: 'completed', startedAt, finishedAt: startedAt });
  store.upsertRecords(id, [{ id: reference, reference, role: 'user', shared: true, kind: 'run', text: 'KEEP_HISTORY 历史来源仍应可以检索', timestamp: startedAt }]);
  return { id, reference, projectId };
}
function seedMemories(store, source) {
  const ids = [];
  for (const kind of ['user', 'agent']) for (const status of ['active', 'paused', 'invalid']) {
    const id = `clear-${kind}-${status}`; ids.push(id);
    store.saveMemory({ id, projectId: source.projectId, kind, status, content: `CLEAR_MEMORY ${kind} ${status}`, sourceRefs: [source.reference] }, admin);
  }
  const privateMemory = store.saveMemory({ id: 'clear-private', projectId: 'another-project', kind: 'agent', agentId: 'alice', content: 'CLEAR_MEMORY private', sourceRefs: [source.reference] }, admin);
  const expired = store.saveMemory({ id: 'clear-expired', projectId: source.projectId, kind: 'agent', expiresAt: timestamp, content: 'CLEAR_MEMORY expired', sourceRefs: [source.reference] }, admin);
  return [...ids, privateMemory.id, expired.id];
}

test('clear deletes every long-term type and state transactionally and keeps original history searchable', async t => {
  const f = await fixture(t), store = await f.store(), source = seedSession(store), ids = seedMemories(store, source);
  const before = store.status();
  assert.throws(() => store.clearMemories({ role: 'teacher', agentId: 'teacher' }), /administrator/);
  assert.equal(store.status().memories, ids.length);
  const cleared = store.clearMemories(admin);
  assert.equal(cleared.ok, true); assert.equal(cleared.deletedCount, ids.length);
  assert.ok(cleared.lastClearedAt); assert.equal(store.status().lastClearedAt, cleared.lastClearedAt);
  assert.equal(store.listMemories({}, admin).total, 0);
  assert.equal(store.memorySearch({ query: 'CLEAR_MEMORY', includeInactive: true }, admin).total, 0);
  assert.equal(store.status().sessions, before.sessions); assert.equal(store.status().records, before.records);
  assert.equal(store.sessionSearch({ query: 'KEEP_HISTORY' }, admin).total, 1);
  assert.equal(store.sessionGet({ reference: source.reference }, admin).items[0].reference, source.reference);
  assert.equal(store.sessionGet({ sessionId: source.id }, admin).session.metadata.memoryExtractedAt, cleared.lastClearedAt);
  for (const id of ids) { assert.equal(store.memoryGet(id, admin), null); assert.throws(() => store.saveMemory({ id, kind: 'agent', content: 'restore' }, admin), /Deleted memory/); }
  assert.throws(() => store.saveMemory({ kind: 'user', projectId: 'other', content: 'CLEAR_MEMORY user active', sourceRefs: [source.reference] }, { ...admin, automatic: true }), /Deleted memory/);
  assert.equal(store.status().contentTombstones, ids.length);
  store.rebuild(); assert.equal(store.memorySearch({ query: 'CLEAR_MEMORY', includeInactive: true }, admin).total, 0);
  assert.equal(store.sessionSearch({ query: 'KEEP_HISTORY' }, admin).total, 1);
  assert.equal(store.clearMemories(admin).deletedCount, 0);
});

test('database failure rolls back memory rows, FTS, deletion protection and clear marker', async t => {
  const f = await fixture(t), store = await f.store(), source = seedSession(store), ids = seedMemories(store, source);
  const db = new DatabaseSync(store.status().filename); f.resources.push(() => db.close());
  db.exec("CREATE TRIGGER fail_memory_clear BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT, 'isolated clear failure'); END;");
  assert.throws(() => store.clearMemories(admin), /isolated clear failure/);
  assert.equal(store.status().memories, ids.length); assert.equal(store.status().lastClearedAt, null);
  assert.equal(store.status().contentTombstones, 0); assert.equal(store.status().tombstones, 0);
  assert.equal(store.memorySearch({ query: 'CLEAR_MEMORY', includeInactive: true }, admin).total, ids.length);
  assert.equal(store.sessionGet({ sessionId: source.id }, admin).session.metadata.memoryExtractedAt, undefined);
});

test('clear waits for an aborted model, cancels old retries durably and still extracts a later new session', { timeout: 12000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let calls = 0;
  t.after(() => release.resolve());
  let manager = await f.manager({ summarize: async ({ items, signal }) => {
    calls++; entered.resolve(); await release.promise;
    assert.equal(signal.aborted, true);
    return { memories: [{ kind: 'agent', content: 'late reply must not recreate memory', sourceRefs: [items[0].reference] }] };
  } });
  let store = await manager.requireStore(); const source = seedSession(store), ids = seedMemories(store, source);
  const job = await manager.queueJob({ type: 'extract', sessionId: source.id, automatic: true }); await entered.promise;
  const retry = { id: 'old-retry', type: 'reflect', status: 'failed', retryAt: timestamp, createdAt: timestamp };
  manager.jobs.push(retry);
  let completed = false; const clear = manager.clearMemories().then(value => { completed = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false); assert.equal(manager.clearingMemories, true);
  await assert.rejects(manager.queueJob({ type: 'reflect' }), error => error.status === 409);
  assert.equal(await manager.queueJob({ type: 'extract', sessionId: source.id, automatic: true }), null, 'a racing background scan stops quietly');
  manager._runJobs(); assert.equal(calls, 1);
  release.resolve(); assert.deepEqual(await clear, { ok: true, deletedCount: ids.length });
  assert.equal(job.status, 'cancelled'); assert.equal(retry.status, 'cancelled'); assert.equal(retry.retryAt, undefined);
  assert.equal(manager.error, null);
  assert.equal(store.status().memories, 0); await manager.close();
  manager = await f.manager({ summarize: async ({ items }) => {
    calls++; return { memories: [{ kind: 'agent', content: 'fresh post-clear experience', sourceRefs: [items[0].reference] }] };
  } });
  store = await manager.requireStore(); manager._runJobs(); await manager.jobPromise;
  assert.equal(calls, 1); assert.equal(store.status().memories, 0);
  assert.ok(manager.jobs.every(item => item.status === 'cancelled'));
  const later = seedSession(store, { startedAt: new Date(Date.parse(manager.lastClearedAt) + 1000).toISOString() });
  await manager.scan(); manager._runJobs(); await manager.jobPromise;
  assert.equal(calls, 2); assert.equal(store.status().memories, 1);
  assert.deepEqual(store.listMemories({}, admin).items[0].sourceRefs, [later.reference]);
  assert.equal(store.sessionSearch({ query: 'KEEP_HISTORY' }, admin).total, 2);
});

test('clear while disabled does not recreate unindexed old histories when memory is enabled after restart', async t => {
  const f = await fixture(t); let calls = 0;
  let manager = await f.manager(); await manager.configure({ enabled: false });
  const history = path.join(f.directory, 'history'); await fs.mkdir(history);
  const ids = ['run-' + randomUUID(), 'run-' + randomUUID()];
  for (const [index, id] of ids.entries()) {
    await fs.mkdir(path.join(history, id));
    await fs.writeFile(path.join(history, id + '.json'), JSON.stringify({ id, task: 'old unindexed task', status: 'completed', projectId: 'old-project', hasJournal: true, ...(index ? {} : { startedAt: timestamp }) }));
    await fs.writeFile(path.join(history, id, 'journal.jsonl'), JSON.stringify({ kind: 'run', reference: 'original:' + id, task: 'KEEP_UNINDEXED 历史原文' }) + '\n');
  }
  assert.deepEqual(await manager.clearMemories(), { ok: true, deletedCount: 0 }); await manager.close();
  manager = await f.manager({ summarize: async () => { calls++; return { memories: [] }; } });
  assert.equal(manager.settings.enabled, false); await manager.configure({ enabled: true }); await manager.flush();
  manager._runJobs(); await manager.jobPromise;
  assert.equal(calls, 0); assert.equal(manager.jobs.length, 0);
  const store = await manager.requireStore(); assert.equal(store.status().memories, 0);
  assert.equal(store.sessionSearch({ query: 'KEEP_UNINDEXED' }, admin).total, 2);
  assert.ok(store.sessionGet({ sessionId: ids[1] }, admin).session.metadata.memoryExtractedAt);
  // An explicit later request to organize a retained session is still allowed.
  const explicit = await manager.queueJob({ type: 'extract', sessionId: ids[0] }); await manager.jobPromise;
  assert.equal(calls, 1); assert.equal(explicit.status, 'completed');
});

test('failed manager clear restores queued jobs and reports the database error without deleting data', async t => {
  const f = await fixture(t), manager = await f.manager(), store = await manager.requireStore(), source = seedSession(store);
  const ids = seedMemories(store, source), job = await manager.queueJob({ type: 'extract', sessionId: source.id, automatic: true });
  const original = { ...job };
  t.mock.method(store, 'clearMemories', () => { throw new Error('isolated manager clear failure'); });
  await assert.rejects(manager.clearMemories(), /isolated manager clear failure/);
  assert.equal(manager.clearingMemories, false); assert.deepEqual(job, original); assert.equal(store.status().memories, ids.length);
  const persisted = JSON.parse(await fs.readFile(path.join(f.directory, 'memory', 'jobs.json'), 'utf8'));
  assert.deepEqual(persisted, JSON.parse(JSON.stringify([original])));
});

test('HTTP clear requires local authorization, refuses a running task, clears all filters and preserves session search after restart', { timeout: 15000 }, async t => {
  const f = await fixture(t), token = 'isolated-clear-' + randomUUID(); let manager, app;
  const originalStart = MemoryManager.prototype.start;
  t.mock.method(MemoryManager.prototype, 'start', function (...args) { if (this.dataDir === f.directory) manager = this; return originalStart.apply(this, args); });
  const start = async () => { app = await createClassServer({ dataDir: f.directory, token }); f.resources.push(() => app.close()); await manager.flush(); };
  await start(); const store = await manager.requireStore(), source = seedSession(store), ids = seedMemories(store, source);
  const request = async (endpoint, method = 'GET', body, headers = {}) => {
    const response = await fetch(app.url + endpoint, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/api/memory/entries', 'DELETE', undefined, { Authorization: '' })).status, 401);
  assert.equal((await request('/api/memory/entries', 'DELETE', undefined, { Origin: 'https://example.invalid' })).status, 403);
  const running = await request('/api/runs', 'POST', { demo: true }); assert.equal(running.status, 202);
  assert.equal((await request('/api/memory/entries', 'DELETE')).status, 409);
  assert.equal(store.status().memories, ids.length);
  await request('/api/runs/' + running.body.run.id + '/stop', 'POST');
  const until = Date.now() + 8000;
  while (manager.isBusy() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(manager.isBusy(), false);
  const result = await request('/api/memory/entries?kind=user&status=active&query=not-present', 'DELETE');
  assert.deepEqual(result, { status: 200, body: { ok: true, deletedCount: ids.length } });
  assert.equal((await request('/api/memory/entries')).body.total, 0);
  assert.equal((await request('/api/memory/sessions/search', 'POST', { query: 'KEEP_HISTORY' })).body.total, 1);
  assert.equal((await request('/api/memory/source?reference=' + encodeURIComponent(source.reference))).status, 200);
  await app.close(); await start();
  assert.equal((await request('/api/memory/entries')).body.total, 0);
  assert.equal((await request('/api/memory/sessions/search', 'POST', { query: 'KEEP_HISTORY' })).body.total, 1);
  assert.deepEqual((await request('/api/memory/entries', 'DELETE')).body, { ok: true, deletedCount: 0 });
});
