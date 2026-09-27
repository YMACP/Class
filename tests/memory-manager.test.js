import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryManager, memoryProjectId } from '../src/memory-manager.js';
import { RunJournal } from '../src/run-journal.js';

const admin = { admin: true };
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'class-memory-manager-'));
  const runId = `run-${randomUUID()}`, archive = path.join(dir, 'history', runId);
  const run = { id: runId, cwd: dir, projectId: memoryProjectId(dir), task: '核对历史会话与路径 E:\\工作区\\proof.txt', hasJournal: true, startedAt: new Date().toISOString(), status: 'running', team: { teacher: 'teacher', students: [{ id: 'alice' }, { id: 'bob' }] } };
  let memory = new MemoryManager({ dataDir: dir, currentProject: () => dir, ...options }); await memory.start(); await memory.flush();
  memory.registerRun(run); await memory.flush();
  const journal = new RunJournal({ directory: archive, runId, onRecord: record => memory.observeRecord(runId, record) });
  await journal.append({ kind: 'run', task: run.task, startedAt: run.startedAt, cwd: dir, projectId: run.projectId });
  t.after(async () => { await memory.close(); if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('class-memory-manager-')) throw new Error('Unsafe fixture path'); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, archive, runId, run, journal, get memory() { return memory; }, async restart() { await memory.close(); memory = new MemoryManager({ dataDir: dir, currentProject: () => dir, ...options }); await memory.start(); await memory.flush(); return memory; } };
}
test('history keeps private model context private and indexes visible text plus long tool artifacts', async t => {
  const f = await fixture(t, { secrets: new Set(['private-credential']) });
  f.memory.captureConversation(f.runId, { studentId: 'alice', role: 'user', content: 'private-context-ALPHA private-credential' });
  f.memory.captureConversation(f.runId, { studentId: 'alice', role: 'assistant', content: '扫描识别编号ALPHA98765', thinking: 'hidden-chain' });
  await fs.mkdir(path.join(f.archive, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(f.archive, 'outputs', 'call-one.txt'), 'line\n'.repeat(6000) + 'long-tail-OMEGA-END');
  await f.journal.append({ kind: 'tool', studentId: 'alice', activity: { type: 'completed', studentId: 'alice', action: { name: 'read_file' }, result: { outputRef: `output:${f.runId}:call-one` } } });
  await f.memory.flush();
  const store = await f.memory.requireStore(), context = id => ({ projectId: f.run.projectId, agentId: id, role: 'student' });
  assert.ok(store.sessionSearch({ query: '扫描识别' }, context('alice')).total > 0);
  assert.equal(store.sessionSearch({ query: 'private-context-ALPHA' }, context('bob')).total, 0);
  assert.ok(store.sessionSearch({ query: 'private-context-ALPHA' }, context('alice')).total > 0);
  assert.ok(store.sessionSearch({ query: 'long-tail-OMEGA-END' }, context('alice')).total > 0);
  assert.equal(store.sessionSearch({ query: 'private-credential' }, admin).total, 0);
  assert.equal(store.sessionSearch({ query: 'hidden-chain' }, admin).total, 0);
  const rows = store.sessionSearch({ query: 'ALPHA98765' }, admin).items;
  assert.ok(rows.some(row => row.reference.startsWith('conversation:')));
});
test('restart backfills originals idempotently and retains deleted-session tombstones', async t => {
  const f = await fixture(t);
  f.memory.captureConversation(f.runId, { studentId: 'alice', role: 'assistant', content: 'restart-marker-BETA' });
  f.run.status = 'completed'; f.run.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(f.dir, 'history', `${f.runId}.json`), JSON.stringify(f.run));
  await f.memory.flush(); await f.memory.scan(); await f.memory.flush();
  const before = (await f.memory.status()).records;
  await f.restart();
  assert.equal((await f.memory.status()).records, before);
  assert.ok((await f.memory.requireStore()).sessionSearch({ query: 'restart-marker-BETA' }, admin).total);
  await f.memory.forgetSession(f.runId); await f.memory.scan(); await f.memory.flush();
  assert.equal((await f.memory.requireStore()).sessionSearch({ query: 'restart-marker-BETA' }, admin).total, 0);
  await f.restart();
  assert.equal((await f.memory.requireStore()).sessionSearch({ query: 'restart-marker-BETA' }, admin).total, 0);
});
test('bad optional database cannot poison durable journal or required run execution', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'class-memory-manager-bad-'));
  await fs.mkdir(path.join(dir, 'memory')); await fs.writeFile(path.join(dir, 'memory', 'memory.sqlite'), 'not SQLite');
  const memory = new MemoryManager({ dataDir: dir });
  t.after(async () => { await memory.close(); await fs.rm(dir, { recursive: true, force: true }); });
  assert.equal(await memory.start(), false);
  const journal = new RunJournal({ directory: path.join(dir, 'archive'), runId: 'isolation', onRecord() { throw new Error('index unavailable'); } });
  await journal.append({ kind: 'result', result: { status: 'completed' } });
  await journal.flush(); assert.equal((await journal.read()).records[0].result.status, 'completed');
  assert.equal((await memory.status()).available, false);
  await assert.rejects(memory.requireStore(), error => error.code === 'memory_unavailable' && !error.fatalStorage);
  assert.equal((await memory.configure({ enabled: false })).enabled, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'memory', 'settings.json'), 'utf8')).enabled, false);
});
test('background extraction waits for idle and activates only sourced memories without confirmation', async t => {
  let busy = true, calls = 0;
  const f = await fixture(t, { isBusy: () => busy, summarize: async ({ items }) => {
    calls++;
    return { memories: [{ kind: 'agent', category: 'fact', content: '该项目曾核对历史会话。', sourceRefs: [items[0].reference] }, { content: 'unsourced fabrication', sourceRefs: ['invented'] }] };
  } });
  await f.memory.flush(); f.run.status = 'completed'; f.memory.registerRun(f.run); await f.memory.flush();
  const job = await f.memory.queueJob({ type: 'extract', sessionId: f.runId });
  await delay(15); assert.equal(calls, 0); assert.equal(job.status, 'pending');
  busy = false; f.memory._runJobs(); await f.memory.jobPromise;
  assert.equal(calls, 1); assert.equal(job.status, 'completed');
  const store = await f.memory.requireStore();
  assert.equal(store.listMemories({}, admin).items[0].status, 'active');
  assert.equal(store.listMemories({}, admin).total, 1);
  assert.equal(store.memorySearch({ query: '历史会话' }, admin).total, 1);
  assert.ok(store.sessionGet({sessionId:f.runId},admin).session.metadata.memoryExtractedAt);
});
test('master switch blocks tools without removing user-managed memories', async t => {
  const f = await fixture(t); await f.memory.flush();
  const tools = f.memory.forRun({ runId: f.runId, projectId: f.run.projectId, team: f.run.team });
  await f.memory.configure({ enabled: false });
  await assert.rejects(tools.tool('session_search', { query: '历史' }, { studentId: 'alice' }), /已关闭/);
  await f.memory.configure({ enabled: true });
  assert.equal((await tools.tool('session_search', { query: '历史' }, { studentId: 'alice' })).success, true);
  await assert.rejects(tools.tool('session_search', { query: '历史' }, { studentId: 'stranger' }), /权限/);
});
test('long review artifacts are searchable and preserve text order in paged context', async t => {
  const f = await fixture(t);
  const original = 'A'.repeat(8000) + 'B'.repeat(4000) + 'C'.repeat(8000) + 'D'.repeat(4000) + 'UNIQUE_FULL_REVIEW_CONTENT';
  const artifact = await f.journal.writeTextArtifact({ text: original });
  await f.journal.append({ kind: 'outcome', studentId: 'teacher', entry: { type: 'teacher_review', fullContentRef: artifact.reference } });
  await f.memory.flush();
  const store = await f.memory.requireStore();
  const hits = store.sessionSearch({ query: 'UNIQUE_FULL_REVIEW_CONTENT' }, admin);
  assert.ok(hits.total > 0);
  const page = store.sessionGet({ sessionId: f.runId, kind: 'tool_output', limit: 200 }, admin);
  assert.equal(page.items.map(item => item.text).join(''), original);
  assert.equal(store.sessionSearch({ query: 'UNIQUE_FULL_REVIEW_CONTENT' }, { projectId: f.run.projectId, agentId: 'bob', role: 'student' }).total, 0);
  await f.journal.append({ kind: 'outcome', entry: { type: 'final_answer', studentId: 'teacher', content: 'Published conclusion', reviewFullContentRef: artifact.reference } });
  await f.memory.flush();
  assert.equal(store.sessionSearch({ query: 'UNIQUE_FULL_REVIEW_CONTENT' }, { projectId: f.run.projectId, agentId: 'bob', role: 'student' }).total, 0, 'Citing a private review in the final answer never shares its text');
  assert.equal(store.sessionGet({ reference: artifact.reference }, { projectId: f.run.projectId, agentId: 'bob', role: 'student' }), null);
  assert.ok(store.sessionGet({ reference: artifact.reference }, { projectId: f.run.projectId, agentId: 'teacher', role: 'teacher' }));
});
test('background extraction includes published outcomes after the first 200 private rows', async t => {
  let sources;
  const f = await fixture(t, { summarize: async ({ items }) => { sources = items; return { memories: [] }; } });
  for (let index = 0; index < 215; index++) await f.journal.append({ kind: 'outcome', entry: { type: 'progress', studentId: 'alice', content: `Private-${index}` } });
  await f.journal.append({ kind: 'result', result: { answer: 'RECENT_FINAL_ANSWER' } });
  f.run.status = 'completed'; f.memory.registerRun(f.run); await f.memory.flush();
  await f.memory.queueJob({ type: 'extract', sessionId: f.runId }); await f.memory.jobPromise;
  assert.ok(sources.some(item => item.content.includes('RECENT_FINAL_ANSWER')));
  assert.ok(sources.every(item => !item.content.includes('Private-')));
});
test('one damaged old summary does not prevent indexing other retained sessions', async t => {
  const f = await fixture(t);
  const badId = `run-${randomUUID()}`;
  await fs.writeFile(path.join(f.dir, 'history', `${badId}.json`), '{incomplete');
  await f.journal.append({ kind: 'result', result: { answer: 'HEALTHY_ARCHIVE_KEPT' } });
  f.run.status = 'completed'; await fs.writeFile(path.join(f.dir, 'history', `${f.runId}.json`), JSON.stringify(f.run));
  await f.restart();
  assert.ok((await f.memory.requireStore()).sessionSearch({ query: 'HEALTHY_ARCHIVE_KEPT' }, admin).total > 0);
  assert.ok((await f.memory.status()).error, 'The damaged summary is still reported');
});
test('automatic extraction survives job-log rotation and never reactivates or recreates managed content', async t => {
  let calls = 0;
  const f = await fixture(t, { summarize: async ({ items }) => {
    calls++; return { memories: [{ kind: 'agent', content: '持久项目经验 AUTO_RETAINED', sourceRefs: [items[0].reference] }] };
  } });
  f.run.status = 'completed';
  await fs.writeFile(path.join(f.dir, 'history', `${f.runId}.json`), JSON.stringify(f.run));
  await f.memory.scan(); await f.memory.jobPromise;
  const store = await f.memory.requireStore(), entry = store.listMemories({}, admin).items[0];
  assert.equal(calls, 1); assert.equal(entry.status, 'active');
  store.saveMemory({ id: entry.id, status: 'paused' }, admin);
  await f.memory.queueJob({ type: 'extract', sessionId: f.runId }); await f.memory.jobPromise;
  assert.equal(store.listMemories({}, admin).total, 1); assert.equal(store.memoryGet(entry.id, admin).status, 'paused');
  store.deleteMemory(entry.id, admin);
  await f.memory.queueJob({ type: 'extract', sessionId: f.runId }); await f.memory.jobPromise;
  assert.equal(store.listMemories({}, admin).total, 0);
  await f.memory.close();
  await fs.writeFile(path.join(f.dir, 'memory', 'jobs.json'), '[]');
  const previousCalls = calls; await f.restart(); f.memory._runJobs(); await f.memory.jobPromise;
  assert.equal(calls, previousCalls); assert.equal((await f.memory.requireStore()).listMemories({}, admin).total, 0);
});
test('old extraction toggle migrates to automatic while preserving the overall off switch', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'class-memory-manager-settings-'));
  await fs.mkdir(path.join(dir, 'memory'));
  await fs.writeFile(path.join(dir, 'memory', 'settings.json'), JSON.stringify({ enabled: false, autoExtract: false }));
  const memory = new MemoryManager({ dataDir: dir });
  t.after(async () => { await memory.close(); await fs.rm(dir, { recursive: true, force: true }); });
  assert.equal(await memory.start(), true);
  const status = await memory.status(); assert.equal(status.enabled, false); assert.equal(status.autoExtract, true);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'memory', 'settings.json'), 'utf8'));
  assert.equal(saved.version, 2); assert.equal(saved.enabled, false); assert.equal(saved.autoExtract, true);
  await assert.rejects(memory.configure({ autoExtract: false }), /无效记忆设置/);
});
test('unconfigured extraction waits and transient automatic failures do not fail the task or retry without bounds', async t => {
  let ready = false, calls = 0;
  const f = await fixture(t, { canSummarize: () => ready, summarize: async () => { calls++; throw new Error('isolated transient model error'); } });
  f.run.status = 'completed'; f.memory.registerRun(f.run); await f.memory.flush(); await f.memory.scan();
  const job = f.memory.jobs.find(item => item.sessionId === f.runId);
  assert.equal(calls, 0); assert.equal(job.status, 'pending'); assert.match(job.notice, /等待配置/);
  ready = true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (job.retryAt) job.retryAt = '2000-01-01T00:00:00.000Z';
    f.memory._runJobs(); await f.memory.jobPromise;
    assert.equal(job.status, 'failed'); assert.equal(job.attempts, attempt);
  }
  assert.equal(calls, 3); assert.equal(job.retryAt, undefined);
  f.memory._runJobs(); await f.memory.jobPromise; assert.equal(calls, 3);
  assert.equal((await f.memory.requireStore()).sessionGet({ sessionId: f.runId }, admin).session.status, 'completed');
  await f.journal.append({ kind: 'event', event: { type: 'still-readable' } }); await f.journal.flush();
});

test('global reflection includes both profiles across workspaces with separate private model inputs and fixed output owners', async t => {
  let busy = true; const requests = [];
  const f = await fixture(t, { isBusy: () => busy, summarize: async ({ items }) => {
    requests.push(items);
    const owners = new Set(items.map(item => item.agentId));
    assert.equal(owners.size, 1, 'One model request must not mix private owners or private and shared data');
    const owner = items[0].agentId;
    if (owner !== null) return { memories: [
      { kind: 'agent', agentId: null, content: 'REFLECT_' + owner.toUpperCase() + ' 私有技能经验', sourceRefs: [items[0].reference] },
      { kind: 'user', content: 'DO_NOT_SHARE_PRIVATE', sourceRefs: [items[0].reference] },
      { kind: 'agent', content: 'DO_NOT_CITE_OUTSIDE_GROUP', sourceRefs: ['memory:shared-seed'] },
    ] };
    return { memories: [
      { kind: 'user', content: 'REFLECT_USER 偏爱简短中文回复', sourceRefs: ['memory:user-seed'] },
      { kind: 'agent', content: 'REFLECT_SHARED 先检查文件编码再解析', sourceRefs: ['memory:shared-seed'] },
      { kind: 'agent', content: 'DO_NOT_MERGE_OWNERS', sourceRefs: ['memory:alice-seed', 'memory:bob-seed'] },
      { kind: 'project', content: 'DO_NOT_KEEP_OLD_TYPE', sourceRefs: ['memory:shared-seed'] },
    ] };
  } });
  const store = await f.memory.requireStore();
  for (const [id, kind, agentId, workspace] of [['user-seed','user',null,'a'],['shared-seed','agent',null,'b'],['alice-seed','agent','alice','a'],['bob-seed','agent','bob','b']]) {
    store.saveMemory({ id, kind, agentId, projectId: memoryProjectId(path.join(f.dir, workspace)), content: 'SOURCE_' + id, status: 'active' }, admin);
  }
  const job = await f.memory.queueJob({ type: 'reflect', projectId: 'obsolete-project-filter' });
  busy = false; f.memory._runJobs(); await f.memory.jobPromise;
  assert.equal(job.status, 'completed', job.error); assert.equal(job.projectId, undefined);
  assert.equal(requests.length, 3); assert.equal(requests.flat().length, 4); assert.equal(job.memoryIds.length, 4); assert.equal(job.skipped, 6);
  const entries = job.memoryIds.map(id => store.memoryGet(id, admin));
  assert.deepEqual(entries.map(entry => [entry.kind,entry.agentId]).sort(), [['user',null],['agent',null],['agent','alice'],['agent','bob']].sort());
  const alice = { agentId: 'alice', role: 'student', projectId: memoryProjectId(path.join(f.dir, 'new-workspace')) };
  assert.equal(store.memorySearch({ query: 'REFLECT_USER' }, alice).total, 1);
  assert.equal(store.memorySearch({ query: 'REFLECT_SHARED' }, alice).total, 1);
  assert.equal(store.memorySearch({ query: 'REFLECT_ALICE' }, alice).total, 1);
  assert.equal(store.memorySearch({ query: 'REFLECT_BOB' }, alice).total, 0);
  assert.equal(store.memorySearch({ query: 'DO_NOT', includeInactive: true }, admin).total, 0);
});
