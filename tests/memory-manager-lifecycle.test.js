import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryManager, memoryProjectId } from '../src/memory-manager.js';
import { createMemoryStore } from '../src/memory-store.js';

const admin = { admin: true };
const timestamp = '2026-09-26T08:00:00.000Z';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'class-memory-lifecycle-'));
  const dataDir = path.join(root, 'profile-a'), oldProfile = path.join(root, 'profile-b');
  const directory = path.join(dataDir, 'memory'), managers = [], stores = [];
  await fs.mkdir(directory, { recursive: true });
  t.after(async () => {
    for (const manager of managers) await manager.close();
    for (const store of stores) store.close();
    const target = path.resolve(root), parent = path.resolve(os.tmpdir());
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('class-memory-lifecycle-')) throw new Error('Unsafe lifecycle fixture path');
    await fs.rm(target, { recursive: true, force: true });
  });
  return {
    root, dataDir, oldProfile, directory,
    async seed() { const store = await createMemoryStore({ directory }); stores.push(store); return store; },
    async write(name, value) { await fs.writeFile(path.join(directory, name), JSON.stringify(value)); },
    async open(options = {}) {
      const memory = new MemoryManager({ dataDir, currentProject: () => path.join(dataDir, 'workspace'), ...options });
      managers.push(memory); assert.equal(await memory.start(), true, memory.error); await memory.flush(); return memory;
    },
  };
}

function seedSession(store, id, projectId, text) {
  store.registerSession({ id, projectId, task: text, status: 'completed', startedAt: timestamp, finishedAt: timestamp, team: { teacher: 'teacher', students: ['alice', 'bob'] } });
  const reference = `original:${id}`;
  store.upsertRecords(id, [{ id: reference, reference, role: 'user', kind: 'run', shared: true, timestamp, text, payload: { projectId, content: text } }]);
  return reference;
}

test('returning to a former profile remaps root and child projects without alias cycles or rewriting original text', async t => {
  const f = await fixture(t), project = memoryProjectId(path.join(f.dataDir, 'workspace'));
  const child = memoryProjectId(path.join(f.dataDir, 'workspace', '中文子项目'));
  const oldProject = memoryProjectId(path.join(f.oldProfile, 'workspace'));
  const oldChild = memoryProjectId(path.join(f.oldProfile, 'workspace', '中文子项目'));
  const external = memoryProjectId(path.join(f.root, 'external-project'));
  const original = `保留原文 MIGRATION_ROOT ${oldProject}，不能替换历史提到的路径。`;
  const store = await f.seed();
  const source = seedSession(store, 'run-return-root', oldProject, original);
  seedSession(store, 'run-return-child', oldChild, '子项目 MIGRATION_CHILD');
  seedSession(store, 'run-external', external, '外部项目 MIGRATION_EXTERNAL');
  store.saveMemory({ id: 'return-memory', projectId: oldProject, kind: 'agent', category: 'fact', status: 'active', content: '迁移前已启用的项目记忆', sourceRefs: [source] }, admin);
  store.close();
  await f.write('projects.json', { profileDirectory: f.oldProfile, aliases: [[project, oldProject], [child, oldChild]] });

  let memory = await f.open(), migrated = await memory.requireStore();
  assert.equal(memory.projectId(oldProject), project);
  assert.equal(memory.projectId(project), project);
  assert.equal(memory.projectId(oldChild), child);
  assert.equal(memory.projectId(child), child);
  assert.equal(migrated.sessionSearch({ query: 'MIGRATION_ROOT', projectId: project }, admin).total, 1);
  assert.equal(migrated.sessionSearch({ query: 'MIGRATION_CHILD', projectId: child }, admin).total, 1);
  assert.equal(migrated.sessionSearch({ query: 'MIGRATION_EXTERNAL', projectId: external }, admin).total, 1);
  assert.equal(migrated.sessionGet({ reference: source }, admin).items[0].text, original);
  assert.equal(migrated.memoryGet('return-memory', admin).projectId, project);
  assert.equal(migrated.listSessions({ projectId: oldProject }, admin).total, 0);
  const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'projects.json'), 'utf8'));
  assert.equal(saved.profileDirectory, f.dataDir);
  assert.ok(saved.aliases.every(([from, to]) => from !== to && !saved.aliases.some(([key]) => key === to)));

  await memory.close(); memory = await f.open(); migrated = await memory.requireStore();
  assert.equal((await memory.status()).sessions, 3);
  assert.equal(migrated.sessionGet({ reference: source }, admin).items[0].text, original);
  assert.equal(migrated.memoryGet('return-memory', admin).projectId, project);
});

test('copied profiles restore reflection jobs as one global queue independent of legacy project IDs', async t => {
  const f = await fixture(t), project = memoryProjectId(path.join(f.dataDir, 'workspace'));
  const oldProject = memoryProjectId(path.join(f.oldProfile, 'workspace'));
  const store = await f.seed();
  store.saveMemory({ id: 'reflection-source', projectId: oldProject, kind: 'agent', category: 'fact', status: 'active', content: '共享来源 REFLECTION_SOURCE' }, admin);
  store.close();
  await f.write('projects.json', { profileDirectory: f.oldProfile, aliases: [] });
  await f.write('jobs.json', [{ id: 'copied-reflection', type: 'reflect', projectId: oldProject, status: 'running', createdAt: timestamp }]);
  let busy = true, calls = 0;
  const memory = await f.open({ isBusy: () => busy, summarize: async ({ items }) => {
    calls++;
    assert.deepEqual(items, [{ reference: 'memory:reflection-source', content: '共享来源 REFLECTION_SOURCE', kind: 'agent', agentId: null }]);
    return { memories: [{ kind: 'agent', category: 'experience', content: '迁移后整理候选', sourceRefs: [items[0].reference] }] };
  } });
  const job = memory.jobs[0];
  assert.equal(job.status, 'pending'); assert.equal(job.projectId, undefined);
  assert.equal(await memory.queueJob({ type: 'reflect', projectId: oldProject }), job);
  assert.equal(memory.jobs.length, 1); assert.equal(calls, 0);
  busy = false; memory._runJobs(); await memory.jobPromise;
  assert.equal(job.status, 'completed', job.error); assert.equal(calls, 1);
  const candidate = (await memory.requireStore()).memoryGet(job.memoryIds[0], admin);
  assert.equal(candidate.projectId, 'profile:global'); assert.equal(candidate.status, 'active');
  assert.deepEqual(candidate.sourceRefs, ['memory:reflection-source']);
});

test('closing cancels an active reflection and a fresh manager resumes its durable pending job', async t => {
  const f = await fixture(t), project = memoryProjectId(path.join(f.dataDir, 'workspace'));
  const store = await f.seed();
  store.saveMemory({ id: 'close-source', projectId: project, kind: 'agent', status: 'active', content: '关闭重启后的原始来源' }, admin); store.close();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let memory = await f.open({ summarize: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); entered();
  }) });
  const job = await memory.queueJob({ type: 'reflect', projectId: project }); await started;
  await memory.close();
  assert.equal(job.status, 'pending'); assert.equal(memory.closed, true);
  const persisted = JSON.parse(await fs.readFile(path.join(f.directory, 'jobs.json'), 'utf8'));
  assert.equal(persisted[0].status, 'pending');
  memory = await f.open({ summarize: async ({ items }) => ({ memories: [{ kind: 'agent', content: '恢复整理结果', sourceRefs: [items[0].reference] }] }) });
  memory._runJobs(); await memory.jobPromise;
  assert.equal(memory.jobs[0].status, 'completed', memory.jobs[0].error);
  assert.equal((await memory.requireStore()).listMemories({ status: 'active' }, admin).total, 2);
});
