import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { MemoryManager, memoryProjectId } from '../src/memory-manager.js';

const admin = { admin: true }, automatic = { admin: true, automatic: true };
async function fixture(t, summarize) {
  const root = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(root, 'class-memory-incremental-'));
  let busy = true, memory;
  const managers = [];
  async function open() {
    memory = new MemoryManager({ dataDir: directory, isBusy: () => busy, summarize }); managers.push(memory);
    assert.equal(await memory.start(), true, memory.error); await memory.flush(); return memory;
  }
  await open();
  t.after(async () => {
    for (const value of managers) await value.close();
    const target = await fs.realpath(directory); assert.equal(path.dirname(target), root);
    assert.ok(path.basename(target).startsWith('class-memory-incremental-')); await fs.rm(target, { recursive: true, force: true });
  });
  const store = await memory.requireStore(), id = 'run-' + randomUUID();
  store.registerSession({ id, projectId: memoryProjectId(directory), status: 'completed', startedAt: new Date().toISOString(), metadata: { memoryExtractedAt: '2020-01-01T00:00:00.000Z' } });
  return { id, store, get memory() { return memory; }, set busy(value) { busy = value; }, open };
}
function records(id, count) {
  return Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, reference: `journal:${id}:${index}`, sequence: index, role: 'assistant', agentId: 'alice', shared: true, text: `${index === 0 ? 'HEAD' : index === count - 1 ? 'TAIL' : 'middle'}-${index}:` + 'source evidence '.repeat(35) }));
}

test('incremental extraction covers long-session head, tail and large-source chunks once across restart and appended records', async t => {
  const seen = [], contents = [];
  const f = await fixture(t, async ({ items }) => {
    assert.ok(items.reduce((sum, item) => sum + item.content.length, 0) <= 48000);
    seen.push(...items.map(item => item.reference)); contents.push(...items.map(item => item.content));
    return { memories: [{ kind: 'agent', content: 'A durable shared lesson', sourceRefs: [items[0].reference] }] };
  });
  const sources = records(f.id, 460);
  sources.splice(1, 0, { id: 'private', reference: 'private-source', sequence: 1, role: 'assistant', agentId: 'bob', shared: false, text: 'PRIVATE_NOT_FOR_SUMMARIZER' });
  sources.push({ id: 'long', reference: 'long-source', sequence: 500, shared: true, text: 'LARGE_HEAD' + 'x'.repeat(125000) + 'LARGE_TAIL' });
  const inserted = f.store.upsertRecords(f.id, sources).records.filter(item => item.reference !== 'private-source').length;
  await f.memory._queueExtraction(f.store.sessionGet({ sessionId: f.id }, admin).session);
  assert.equal(f.memory.jobs.length, 1, 'legacy timestamp must not suppress uncovered sources');
  f.busy = false; f.memory._runJobs(); await f.memory.jobPromise;
  assert.equal(f.memory.jobs[0].status, 'completed', f.memory.jobs[0].error);
  assert.equal(seen.length, inserted); assert.equal(new Set(seen).size, inserted);
  assert.ok(contents.some(value => value.startsWith('HEAD-0'))); assert.ok(contents.some(value => value.startsWith('TAIL-459')));
  assert.ok(contents.some(value => value.includes('LARGE_HEAD'))); assert.ok(contents.some(value => value.includes('LARGE_TAIL')));
  assert.ok(contents.every(value => !value.includes('PRIVATE_NOT_FOR_SUMMARIZER')));
  assert.equal(f.store.listMemories({}, admin).total, 1);
  assert.equal(f.store.extractionBatch(f.id, admin).items.length, 0);
  await f.memory.close(); f.busy = true; await f.open();
  const reopened = await f.memory.requireStore();
  await f.memory._queueExtraction(reopened.sessionGet({ sessionId: f.id }, admin).session);
  assert.equal(f.memory.jobs.length, 1);
  reopened.upsertRecords(f.id, [{ id: 'new-record', reference: 'new-record', sequence: 501, shared: true, text: 'A newly appended result' }]);
  await f.memory._queueExtraction(reopened.sessionGet({ sessionId: f.id }, admin).session);
  f.busy = false; f.memory._runJobs(); await f.memory.jobPromise;
  assert.equal(seen.length, inserted + 1); assert.equal(seen.at(-1), 'new-record');
  assert.equal(reopened.listMemories({}, admin).total, 1);
});

test('a committed batch survives pause and process reopen without resending its sources', async t => {
  let calls = 0, enter;
  const entered = new Promise(resolve => { enter = resolve; }), committed = [], retried = [];
  const f = await fixture(t, async ({ items, signal }) => {
    calls++;
    if (calls === 1) { committed.push(...items.map(item => item.reference)); return { memories: [{ kind: 'agent', content: 'First committed lesson', sourceRefs: [items[0].reference] }] }; }
    if (calls === 2) { enter(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    retried.push(...items.map(item => item.reference));
    return { memories: [{ kind: 'agent', content: 'Remaining lesson', sourceRefs: [items[0].reference] }] };
  });
  f.store.upsertRecords(f.id, records(f.id, 210));
  const job = await f.memory.queueJob({ type: 'extract', sessionId: f.id, automatic: true });
  f.busy = false; f.memory._runJobs(); await entered;
  assert.equal(f.store.listMemories({}, admin).total, 1);
  f.busy = true; f.memory.pauseBackground(); await f.memory.jobPromise;
  assert.equal(job.status, 'pending'); assert.ok(job.cursor); assert.equal(job.processedSources, committed.length);
  await f.memory.close(); await f.open();
  f.busy = false; f.memory._runJobs(); await f.memory.jobPromise;
  const recovered = f.memory.jobs.find(item => item.id === job.id);
  assert.equal(recovered.status, 'completed', recovered.error);
  assert.equal(committed.length + retried.length, 210);
  assert.equal(new Set([...committed, ...retried]).size, 210);
  assert.equal((await f.memory.requireStore()).listMemories({}, admin).total, 2);
});

test('changed source or session tombstone prevents committing stale extraction output', async t => {
  const f = await fixture(t, async () => ({ memories: [] }));
  f.store.upsertRecords(f.id, records(f.id, 1));
  const before = f.store.extractionBatch(f.id, admin);
  const memory = { kind: 'agent', content: 'Stale result', sourceRefs: [before.items[0].reference] };
  f.store.upsertRecords(f.id, [{ ...records(f.id, 1)[0], text: 'Replacement evidence' }]);
  assert.throws(() => f.store.commitExtraction({ sessionId: f.id, sources: before.items, memories: [memory] }, automatic), /changed/);
  assert.equal(f.store.listMemories({}, admin).total, 0);
  const after = f.store.extractionBatch(f.id, admin); assert.equal(after.items.length, 1);
  await f.memory.forgetSession(f.id);
  assert.throws(() => f.store.commitExtraction({ sessionId: f.id, sources: after.items, memories: [memory] }, automatic), /deleted/);
  assert.equal(f.store.extractionBatch(f.id, admin), null);
});

test('a newly busy foreground task prevents committing an in-flight extraction response', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ items }) => {
    if (++calls === 1) f.busy = true;
    return { memories: [{ kind: 'agent', content: 'Deferred lesson', sourceRefs: [items[0].reference] }] };
  });
  f.store.upsertRecords(f.id, records(f.id, 1));
  const job = await f.memory.queueJob({ type: 'extract', sessionId: f.id, automatic: true });
  f.busy = false; f.memory._runJobs(); await f.memory.jobPromise;
  assert.equal(job.status, 'pending'); assert.equal(f.store.listMemories({}, admin).total, 0);
  assert.equal(f.store.extractionBatch(f.id, admin).items.length, 1);
  f.busy = false; f.memory._runJobs(); await f.memory.jobPromise;
  assert.equal(job.status, 'completed'); assert.equal(f.store.listMemories({}, admin).total, 1);
});
