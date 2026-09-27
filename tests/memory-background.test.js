import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryManager, memoryProjectId } from '../src/memory-manager.js';
import { RunJournal } from '../src/run-journal.js';
import { createClassServer } from '../src/web-server.js';

const admin = { admin: true };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(read, predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(15);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
async function temporaryDirectory(t) {
  const root = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'class-memory-background-'));
  return { directory, async remove() {
    const target = await fs.realpath(directory);
    assert.equal(path.dirname(target), root);
    assert.ok(path.basename(target).startsWith('class-memory-background-'));
    await fs.rm(target, { recursive: true, force: true });
  } };
}
function seedSession(store, projectId) {
  const id = `run-${randomUUID()}`, reference = `journal:${id}:1`;
  store.registerSession({ id, projectId, task: 'Isolated background extraction evidence', status: 'completed', startedAt: new Date().toISOString() });
  store.upsertRecords(id, [{ id: reference, reference, role: 'user', kind: 'run', shared: true, text: 'Original user evidence for isolated background memory tests.' }]);
  return { id, reference };
}

test('HTTP task startup keeps extraction paused through async preparation and releases busy state after failure and completion', { timeout: 25000 }, async t => {
  const fixture = await temporaryDirectory(t), { directory } = fixture;
  const gate = deferred(), entered = deferred();
  const token = 'isolated-background-' + randomUUID();
  let app, memory, summaryCalls = 0, finishSummaries = false, blockJournal = false;
  const busyAtPause = [];
  const originalStart = MemoryManager.prototype.start;
  const originalPause = MemoryManager.prototype.pauseBackground;
  const originalAppend = RunJournal.prototype.append;
  t.mock.method(MemoryManager.prototype, 'start', function (...args) {
    if (this.dataDir === directory) memory = this;
    return originalStart.apply(this, args);
  });
  t.mock.method(MemoryManager.prototype, 'pauseBackground', function (...args) {
    if (this.dataDir === directory) busyAtPause.push(this.isBusy());
    return originalPause.apply(this, args);
  });
  t.mock.method(RunJournal.prototype, 'append', async function (record, ...args) {
    if (blockJournal && record.kind === 'run' && record.demo === true && path.dirname(this.directory) === path.join(directory, 'history')) {
      entered.resolve(); await gate.promise;
    }
    return originalAppend.call(this, record, ...args);
  });
  t.after(async () => { gate.resolve(); await app?.close(); await fixture.remove(); });
  app = await createClassServer({ dataDir: directory, token });
  assert.ok(memory);
  await memory.start(); await memory.flush();
  memory.canSummarize = () => true;
  memory.summarize = ({ signal }) => {
    summaryCalls++;
    if (finishSummaries) return Promise.resolve({ memories: [] });
    return new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const source = seedSession(await memory.requireStore(), memoryProjectId(path.join(directory, 'workspace')));
  const job = await memory.queueJob({ type: 'extract', sessionId: source.id, automatic: true });
  await waitFor(() => summaryCalls, count => count === 1, 'initial background model request');
  const api = async (endpoint, body) => {
    const response = await fetch(app.url + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };

  const invalid = await api('/api/runs', { demo: 'invalid' });
  assert.equal(invalid.status, 400);
  await memory.jobPromise;
  assert.deepEqual(busyAtPause, [true]);
  assert.equal(job.status, 'pending'); assert.equal(memory.isBusy(), false);
  memory._runJobs();
  await waitFor(() => summaryCalls, count => count === 2, 'background resumes after failed startup');

  blockJournal = true;
  const starting = api('/api/runs', { demo: true });
  await entered.promise;
  await memory.jobPromise;
  assert.deepEqual(busyAtPause, [true, true]);
  assert.equal(job.status, 'pending'); assert.equal(memory.isBusy(), true);
  assert.equal((await api('/api/state')).body.run, null, 'Preparation is paused before the active run exists');
  memory._runJobs();
  assert.equal(memory.jobPromise, null); assert.equal(summaryCalls, 2, 'A timer tick cannot restart extraction during preparation');
  gate.resolve();
  const started = await starting;
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const finished = await waitFor(() => api('/api/state'), result => result.body.run?.id === started.body.run.id && !['running', 'stopping'].includes(result.body.run.status), 'actual demo completion');
  assert.equal(finished.body.run.status, 'completed', JSON.stringify(finished.body.run));
  assert.equal(memory.isBusy(), false);
  finishSummaries = true;
  memory._runJobs(); await memory.jobPromise;
  assert.equal(summaryCalls, 3); assert.equal(job.status, 'completed');
});

test('interrupted extraction retries the same job with reordered notes without losing content or reviving paused and deleted memories', { timeout: 12000 }, async t => {
  const fixture = await temporaryDirectory(t), { directory } = fixture;
  let memory, calls = 0, busy = true;
  const managers = [];
  t.after(async () => { for (const manager of managers) await manager.close(); await fixture.remove(); });
  const open = async summarize => {
    memory = new MemoryManager({ dataDir: directory, isBusy: () => busy, summarize });
    managers.push(memory);
    assert.equal(await memory.start(), true, memory.error); await memory.flush();
    return memory;
  };
  await open(async ({ items }) => {
    calls++;
    return { memories: ['Already persisted note A', 'New note B'].map(content => ({ kind: 'agent', content, sourceRefs: [items[0].reference] })) };
  });
  const store = await memory.requireStore(), projectId = memoryProjectId(directory), source = seedSession(store, projectId);
  const paused = store.saveMemory({ id: 'paused-protection', projectId, kind: 'agent', content: 'User paused note', sourceRefs: [source.reference], status: 'paused' }, admin);
  const deleted = store.saveMemory({ id: 'deleted-protection', projectId, kind: 'agent', content: 'User deleted note', sourceRefs: [source.reference] }, admin);
  store.deleteMemory(deleted.id, admin);
  const saveMemory = store.saveMemory;
  let writes = 0;
  const fault = t.mock.method(store, 'saveMemory', function (value, context) {
    if (++writes === 2) throw new Error('isolated interruption after the first durable memory');
    return saveMemory.call(this, value, context);
  });
  const job = await memory.queueJob({ type: 'extract', sessionId: source.id, automatic: true });
  busy = false; memory._runJobs(); await memory.jobPromise;
  assert.equal(job.status, 'failed'); assert.equal(calls, 1);
  const partial = store.memorySearch({ query: 'Already persisted note A' }, admin).items[0];
  assert.ok(partial); assert.equal(store.listMemories({}, admin).total, 2);
  assert.equal(store.sessionGet({ sessionId: source.id }, admin).session.metadata.memoryExtractedAt, undefined);
  fault.mock.restore();
  // A process exit leaves the durable running job beside its already committed
  // first note; reopen must retry that same job rather than depend on array order.
  job.status = 'running'; delete job.retryAt;
  await memory._saveJobs(); await memory.close();
  busy = true;
  await open(async ({ items }) => {
    calls++;
    return { memories: ['New note B', 'Already persisted note A', 'User deleted note', 'User paused note', 'New note C'].map(content => ({ kind: 'agent', content, sourceRefs: [items[0].reference] })) };
  });
  const retry = memory.jobs.find(item => item.id === job.id);
  assert.ok(retry); assert.equal(retry.status, 'pending');
  busy = false; memory._runJobs(); await memory.jobPromise;
  assert.equal(calls, 2); assert.equal(retry.status, 'completed', retry.error);
  const reopened = await memory.requireStore();
  assert.equal(reopened.memoryGet(partial.id, admin).content, 'Already persisted note A');
  assert.deepEqual(reopened.memorySearch({}, admin).items.map(item => item.content).sort(), ['Already persisted note A', 'New note B', 'New note C']);
  assert.equal(reopened.memoryGet(paused.id, admin).status, 'paused');
  assert.equal(reopened.memoryGet(deleted.id, admin), null);
  assert.equal(reopened.listMemories({}, admin).total, 4);
  assert.equal(retry.skipped, 1);
  assert.equal(new Set(retry.memoryIds).size, 4);
  assert.ok(reopened.sessionGet({ sessionId: source.id }, admin).session.metadata.memoryExtractedAt);
});
