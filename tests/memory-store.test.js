import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMemoryStore } from '../src/memory-store.js';

const admin = { admin: true, projectId: 'project-a', agentId: 'teacher', role: 'teacher' };
const teacher = { projectId: 'project-a', agentId: 'teacher', role: 'teacher' };
const alice = { projectId: 'project-a', agentId: 'alice', role: 'student' };
const bob = { projectId: 'project-a', agentId: 'bob', role: 'student' };

async function fixture(t, options = {}) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'class-memory-store-'));
  const stores = [];
  const open = async () => { const store = await createMemoryStore({ directory, ...options }); stores.push(store); return store; };
  t.after(async () => {
    for (const store of stores) store.close();
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('class-memory-store-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { directory, store: await open(), open };
}
function session(store, id = 'run-a', projectId = 'project-a') {
  return store.registerSession({ id, projectId, task: '修复数据库权限问题', startedAt: '2026-09-20T10:00:00Z', team: [{ id: 'alice', role: 'student' }, { id: 'bob', role: 'student' }] });
}
function record(store, { id = 'record-a', sessionId = 'run-a', ...value } = {}) {
  return store.upsertRecords(sessionId, [{ id, agentId: 'alice', role: 'student', kind: 'tool_result', text: '默认记录', ...value }]).records[0].reference;
}
async function openFixtureDatabase(filename) {
  if (process.versions.bun) { const { Database } = await import('bun:sqlite'); return new Database(filename); }
  const { DatabaseSync } = await import('node:sqlite'); return new DatabaseSync(filename);
}

test('archives reopen with Chinese, file paths, error codes, paging and safe FTS queries', async t => {
  const { store, open } = await fixture(t);
  session(store);
  const reference = record(store, { text: '已定位数据库权限失败。文件 C:\\project\\src\\engine.js 返回 EACCES，下一步修复。' });
  record(store, { id: 'record-b', text: '普通日志', sequence: 1 });
  assert.equal(store.sessionSearch({ query: '数据库权限' }, alice).items[0].reference, reference);
  assert.equal(store.sessionSearch({ query: '数' }, alice).total, 1);
  assert.equal(store.sessionSearch({ query: 'C:\\project\\src\\engine.js EACCES' }, alice).total, 1);
  assert.equal(store.sessionSearch({ query: 'EACCES" OR nonexistent*' }, alice).total, 0);
  assert.equal(store.sessionSearch({ query: '" ) ( * -' }, alice).total, 0);
  const first = store.sessionGet({ sessionId: 'run-a', limit: 1 }, alice);
  assert.equal(first.total, 2); assert.equal(first.nextOffset, 1); assert.deepEqual(first.items, first.records);
  assert.equal(store.sessionGet({ sessionId: 'run-a', limit: 1, offset: first.nextOffset }, alice).nextOffset, null);
  assert.equal(store.sessionGet({ reference }, alice).session.id, 'run-a');
  store.close();
  const reopened = await open();
  assert.equal(reopened.sessionSearch({ query: 'EACCES' }, alice).total, 1);
  assert.equal(reopened.listSessions({ query: '数据库' }, alice).total, 1);
  assert.equal(reopened.listSessions({ query: '%' }, alice).total, 0);
  assert.deepEqual(reopened.status().projects, ['project-a']);
  assert.equal(reopened.status().sessions, 1);
});

test('long outputs remain fully retrievable and repeat imports do not duplicate chunks', async t => {
  const { store } = await fixture(t);
  session(store);
  const text = `${'abcdefghij'.repeat(2100)}最后一页错误 SQLITE_BUSY`;
  const written = store.upsertRecords('run-a', [{ id: 'long', text, agentId: 'alice', role: 'student', sequence: 4, payload: { exitCode: 1, path: 'report/output.log' } }]);
  assert.equal(written.records.length, 3);
  assert.equal(store.sessionGet({ sessionId: 'run-a' }, alice).records.map(item => item.text).join(''), text);
  const found = store.sessionSearch({ query: '最后一页错误 SQLITE_BUSY' }, alice);
  assert.equal(found.total, 1); assert.equal(found.items[0].chunkIndex, 2);
  assert.equal(store.sessionGet({ reference: 'run-a:long' }, alice).total, 3);
  const window = store.sessionGet({ reference: found.items[0].reference }, alice);
  assert.equal(window.total, 3); assert.equal(window.anchorOffset, 2); assert.equal(window.anchorReference, found.items[0].reference);
  const repeated = store.upsertRecords('run-a', [{ id: 'long', text, agentId: 'alice', role: 'student', sequence: 4, payload: { exitCode: 1, path: 'report/output.log' } }]);
  assert.equal(repeated.updated, 1); assert.equal(store.status().records, 3);
  assert.equal(store.sessionSearch({ query: 'report/output.log' }, alice).total, 1);
});

test('Unicode characters survive chunk boundaries without replacement or lost text', async t => {
  const { store } = await fixture(t);
  session(store);
  const text = 'a'.repeat(7999) + '\u{1F600}' + 'b'.repeat(7998) + '\u{2000B}' + '原始末尾';
  record(store, { id: 'unicode-long', text });
  const records = store.sessionGet({ sessionId: 'run-a' }, alice).records;
  assert.equal(records.map(item => item.text).join(''), text);
  for (const item of records) assert.equal(Buffer.from(item.text, 'utf8').toString('utf8'), item.text);
  assert.equal(store.sessionSearch({ query: '\u{1F600}' }, alice).total, 1);
});

test('original output references locate authorized artifact chunks and their surrounding context', async t => {
  const { store } = await fixture(t);
  session(store); session(store, 'run-b', 'project-b');
  const outputRef = 'output:run-a:command';
  record(store, { id: 'before', sequence: 0, text: 'before output' });
  record(store, { id: 'chunk-zero', reference: outputRef + '#0000000000', sequence: 1, text: 'first output part', payload: { outputRef, part: 0 } });
  record(store, { id: 'chunk-one', reference: outputRef + '#0000000001', sequence: 1, text: 'second output part', payload: { outputRef, part: 1 } });
  record(store, { id: 'after', sequence: 2, text: 'after output' });
  const found = store.sessionGet({ reference: outputRef }, alice);
  assert.equal(found.anchorReference, outputRef + '#0000000000'); assert.equal(found.anchorOffset, 1);
  assert.equal(found.total, 4); assert.equal(found.session.id, 'run-a');
  assert.equal(store.sessionGet({ reference: outputRef }, bob), null);
  assert.equal(store.sessionGet({ reference: outputRef, sessionId: 'run-b' }, teacher), null);
  assert.equal(store.sessionGet({ reference: outputRef }, { ...alice, projectId: 'project-b' }).session.id, 'run-a');
  assert.equal(store.sessionGet({ reference: outputRef, projectId: 'project-b' }, alice), null);
  assert.equal(store.sessionGet({ reference: outputRef + "' OR 1=1 --" }, admin), null);
});

test('literal fallback finds embedded identifiers and paths only inside the authorized scope', async t => {
  const { store } = await fixture(t);
  session(store); session(store, 'run-b', 'project-b');
  const text = 'DDDDLONG_OUTPUT_MARKERDDDD /repo/project/engine.js suffixERROR42suffix 数据库错误 literal%_wildcard';
  const source = record(store, { id: 'own-fallback', text });
  record(store, { id: 'other-fallback', text, agentId: 'bob' });
  record(store, { id: 'foreign-fallback', text, sessionId: 'run-b' });
  for (const query of ['LONG_OUTPUT_MARKER', 'gine.j', 'ERROR42', '库', '%_']) assert.equal(store.sessionSearch({ query }, alice).total, 2, query);
  assert.equal(store.sessionSearch({ query: 'LONG_OUTPUT_MARKER', projectId: 'project-b', agentId: 'bob' }, alice).total, 0);
  assert.equal(store.sessionSearch({ query: 'LONG_OUTPUT_MARKER' }, teacher).total, 3);
  assert.equal(store.sessionSearch({ query: 'LONG_OUTPUT_MARKER' }, admin).total, 3);
  assert.equal(store.sessionSearch({ query: "%' OR 1=1 --" }, admin).total, 0);
  const note = store.saveMemory({ id: 'fallback-note', kind: 'agent', agentId: 'alice', content: text, status: 'active', sourceRefs: [source] }, admin);
  assert.equal(store.memorySearch({ query: 'LONG_OUTPUT_MARKER' }, alice).items[0].id, note.id);
  assert.equal(store.memorySearch({ query: 'LONG_OUTPUT_MARKER' }, bob).total, 0);
  store.saveMemory({ id: note.id, expiresAt: '2000-01-01' }, admin);
  assert.equal(store.memorySearch({ query: 'LONG_OUTPUT_MARKER' }, alice).total, 0);
  // The slower fallback must not mix substring matches into an existing FTS result.
  record(store, { id: 'token-match', text: 'LONG_OUTPUT_MARKER' });
  const exact = store.sessionSearch({ query: 'LONG_OUTPUT_MARKER' }, alice);
  assert.equal(exact.total, 1); assert.equal(exact.items[0].id, 'token-match');
});

test('history crosses workspaces while identity authorization intersects optional query filters', async t => {
  const { store } = await fixture(t);
  session(store); session(store, 'run-b', 'project-b');
  record(store, { id: 'alice-private', text: 'needle alice private' });
  record(store, { id: 'bob-private', agentId: 'bob', text: 'needle bob private' });
  record(store, { id: 'user', agentId: 'human', role: 'user', text: 'needle user task' });
  record(store, { id: 'shared', agentId: 'bob', shared: true, text: 'needle group message' });
  record(store, { id: 'fake-shared-kind', agentId: 'bob', kind: 'shared', text: 'needle still private' });
  record(store, { id: 'foreign', sessionId: 'run-b', text: 'needle foreign project' });
  assert.equal(store.sessionSearch({ query: 'needle' }, alice).total, 4);
  assert.equal(store.sessionSearch({ query: 'needle', projectId: 'project-b', admin: true }, alice).total, 1);
  assert.equal(store.sessionSearch({ query: 'needle', agentId: 'bob' }, alice).total, 1);
  assert.equal(store.sessionSearch({ query: 'needle' }, teacher).total, 6);
  assert.equal(store.sessionSearch({ query: 'needle', projectId: 'project-b' }, admin).total, 1);
  assert.equal(store.sessionSearch({ query: 'needle' }, admin).total, 6);
  assert.equal(store.sessionGet({ reference: 'run-a:bob-private' }, alice), null);
  assert.equal(store.sessionGet({ sessionId: 'run-b' }, teacher).items.length, 1);
  assert.equal(store.sessionGet({ sessionId: 'run-a' }, alice).records.length, 3);
  assert.equal(store.exportData({}, alice).records.length, 4);
  assert.equal(store.exportData({}, alice).sessions.length, 2);
  assert.throws(() => store.sessionSearch({ query: 'needle' }), /scope/);
});

test('automatic memories are active with evidence while preserving role boundaries', async t => {
  const { store } = await fixture(t);
  session(store);
  const own = record(store, { id: 'private', text: '私有调试心得' });
  const other = record(store, { id: 'other', agentId: 'bob', text: 'Bob私有调试心得' });
  const shared = record(store, { id: 'shared', role: 'user', agentId: 'human', text: '项目采用UTF-8编码' });
  const candidate = store.saveMemory({ kind: 'agent', content: '调试先核对编码', sourceRefs: [own] }, alice);
  assert.equal(candidate.status, 'active'); assert.equal(candidate.agentId, 'alice'); assert.equal(candidate.lastVerifiedAt, null);
  assert.equal(store.memorySearch({ query: '编码' }, alice).total, 1);
  assert.equal(store.listMemories({}, alice).total, 1);
  assert.throws(() => store.saveMemory({ id: candidate.id, status: 'paused' }, alice), /administrator/);
  assert.throws(() => store.saveMemory({ kind: 'agent', content: 'bad', sourceRefs: [other] }, alice), /scope/);
  assert.throws(() => store.saveMemory({ kind: 'agent', agentId: null, content: 'bad', sourceRefs: [own] }, teacher), /private source/);
  assert.throws(() => store.saveMemory({ kind: 'agent', agentId: 'bob', content: 'bad', sourceRefs: [own] }, teacher), /private source/);
  assert.throws(() => store.saveMemory({ kind: 'agent', content: 'unproven' }, alice), /source references/);
  assert.equal(store.memoryGet(candidate.id, bob), null);
  store.saveMemory({ kind: 'agent', agentId: null, content: '项目采用UTF-8编码', sourceRefs: [shared] }, teacher);
  assert.equal(store.memorySearch({ query: '编码' }, bob).total, 1);
  assert.equal(store.memorySearch({ query: '编码', agentId: 'alice', projectId: 'other' }, bob).total, 0);
});

test('source chains reject cycles, inaccessible or expired evidence and expire retrieval by time', async t => {
  const { store } = await fixture(t);
  session(store);
  const source = record(store, { role: 'user', text: '必须核对测试日志' });
  const first = store.saveMemory({ id: 'first', kind: 'agent', agentId: null, content: '核对测试日志', status: 'active', sourceRefs: [source] }, admin);
  const second = store.saveMemory({ id: 'second', kind: 'agent', agentId: null, content: '复核日志证据', status: 'active', sourceRefs: [`memory:${first.id}`] }, admin);
  assert.throws(() => store.saveMemory({ id: first.id, sourceRefs: [`memory:${second.id}`] }, admin), /cycle/);
  const expired = store.saveMemory({ id: 'expired', kind: 'agent', agentId: null, content: '过期日志建议', status: 'active', expiresAt: '2001-01-01', sourceRefs: [source] }, admin);
  assert.equal(expired.status, 'invalid');
  assert.equal(store.memorySearch({ query: '日志' }, alice).total, 2);
  assert.equal(store.listMemories({}, admin).total, 3);
  assert.equal(store.listMemories({ status: 'invalid' }, admin).items[0].id, 'expired');
  assert.throws(() => store.saveMemory({ kind: 'agent', agentId: null, content: 'bad', sourceRefs: ['memory:expired'] }, admin), /no longer active/);
  assert.throws(() => store.saveMemory({ kind: 'agent', agentId: null, content: 'bad', sourceRefs: ['not-found'] }, admin), /not exist/);
});

test('deleting a session removes indexed originals and transitive memories and blocks reimport after reopen', async t => {
  const { store, open } = await fixture(t);
  session(store);
  const source = record(store, { role: 'user', text: 'unique deletion evidence' });
  const first = store.saveMemory({ id: 'delete-first', kind: 'agent', agentId: null, content: 'unique first', status: 'active', sourceRefs: [source] }, admin);
  store.saveMemory({ id: 'delete-second', kind: 'agent', agentId: null, content: 'unique second', status: 'active', sourceRefs: [`memory:${first.id}`] }, admin);
  assert.throws(() => store.deleteSession('run-a', alice), /teacher or administrator/);
  const deleted = store.deleteSession('run-a', teacher);
  assert.equal(deleted.deletedRecords, 1); assert.equal(deleted.deletedMemories, 2);
  assert.equal(store.sessionSearch({ query: 'unique' }, admin).total, 0);
  assert.equal(store.memorySearch({ query: 'unique' }, admin).total, 0);
  store.close();
  const reopened = await open();
  assert.equal(session(reopened).skipped, true);
  assert.equal(reopened.upsertRecords('run-a', [{ id: 'record-a', text: 'unique' }]).skipped, 1);
  assert.throws(() => reopened.saveMemory({ id: 'delete-first', kind: 'agent', agentId: null, content: 'resurrection' }, admin), /cannot be restored/);
  assert.equal(reopened.status().records, 0);
  assert.equal(reopened.exportData({}, admin).tombstones.filter(item => item.type === 'memory').length, 2);
  assert.equal(reopened.deleteSession('not-yet-indexed', admin).tombstoned, true);
  assert.equal(session(reopened, 'not-yet-indexed').skipped, true);
});

test('reference retrieval includes chronological authorized context around its anchor', async t => {
  const { store } = await fixture(t);
  session(store);
  for (let i = 0; i < 12; i++) record(store, { id: `event-${i}`, sequence: 12 - i, timestamp: `2026-09-20T10:00:${String(i).padStart(2, '0')}Z`, text: `event ${i}`, agentId: i % 2 ? 'bob' : 'alice' });
  const context = store.sessionGet({ reference: 'run-a:event-8', limit: 4 }, alice);
  assert.equal(context.total, 6); assert.equal(context.anchorOffset, 4); assert.equal(context.offset, 1);
  assert.deepEqual(context.records.map(item => item.id), ['event-2', 'event-4', 'event-6', 'event-8']);
  assert.equal(context.nextOffset, 5);
  assert.equal(store.sessionGet({ reference: 'run-a:event-8', limit: 4, offset: context.nextOffset }, alice).records[0].id, 'event-10');
});

test('memory deletion cascades derived descendants while preserving original archive', async t => {
  const { store } = await fixture(t);
  session(store);
  const source = record(store);
  const first = store.saveMemory({ id: 'parent', content: '原始经验', sourceRefs: [source] }, alice);
  store.saveMemory({ id: 'child', content: '后续经验', sourceRefs: [`memory:${first.id}`] }, alice);
  assert.throws(() => store.deleteMemory(first.id, bob), /scope/);
  assert.equal(store.deleteMemory(first.id, alice).deletedMemories, 2);
  assert.equal(store.status().records, 1);
  assert.equal(store.listMemories({}, admin).total, 0);
  assert.throws(() => store.saveMemory({ id: first.id, content: '原始经验', sourceRefs: [source] }, alice), /cannot be restored/);
});

test('redaction covers plaintext, nested payload, generic keys and live secrets in exports and indexes', async t => {
  const known = ['private-secret-1234'];
  const { store, directory } = await fixture(t, { secrets: () => known });
  store.registerSession({ id: 'run-a', projectId: 'project-a', task: 'private-secret-1234', metadata: { apiKey: 'shortsecret', trace: 'Bearer my-opaque-token' } });
  const source = record(store, { text: 'private-secret-1234 sk-abcdefghijklmnopqrstuvwxyz123456 Bearer another-token secret_later', payload: { nested: { tokenText: 'private-secret-1234', authorization: 'short-token' }, api_key: 'arbitrary' } });
  store.saveMemory({ kind: 'agent', agentId: 'alice', content: 'private-secret-1234 sk-abcdefghijklmnopqrstuvwxyz123456', sourceRefs: [source] }, admin);
  known.push('secret_later');
  const exported = JSON.stringify(store.exportData({}, admin));
  for (const secret of ['private-secret-1234', 'sk-abcdefghijklmnopqrstuvwxyz123456', 'another-token', 'shortsecret', 'short-token', 'arbitrary', 'secret_later']) assert.ok(!exported.includes(secret), secret);
  assert.ok(exported.includes('[REDACTED]'));
  assert.equal(store.sessionSearch({ query: 'private-secret-1234' }, admin).total, 0);
  store.rebuild();
  assert.equal(store.sessionSearch({ query: 'secret_later' }, admin).total, 0);
  store.close();
  const bytes = await fs.readFile(path.join(directory, 'memory.sqlite'));
  assert.ok(!bytes.includes(Buffer.from('private-secret-1234')));
  assert.ok(!bytes.includes(Buffer.from('sk-abcdefghijklmnopqrstuvwxyz123456')));
});

test('rebuilding indexes preserves scopes and does not revive deletions; profile databases remain separate', async t => {
  const { store } = await fixture(t);
  const other = await fixture(t);
  session(store); session(other.store);
  record(store, { text: '索引重建证据 EACCES' });
  record(other.store, { text: '另一个配置档案' });
  store.saveMemory({ id: 'removed', kind: 'agent', agentId: null, content: 'deleted' }, admin);
  store.deleteMemory('removed', admin);
  assert.equal(store.rebuild().records, 1);
  assert.equal(store.sessionSearch({ query: '索引重建' }, teacher).total, 1);
  assert.equal(other.store.sessionSearch({ query: '索引重建' }, admin).total, 0);
  assert.equal(store.memoryGet('removed', admin), null);
  assert.throws(() => store.saveMemory({ id: 'removed', kind: 'agent', agentId: null, content: 'restored' }, admin), /cannot be restored/);
  assert.equal(store.listSessions({ limit: 200 }, admin).total, 1);
  assert.throws(() => store.listSessions({ limit: 1000 }, admin), error => !error.fatalStorage && /pagination/.test(error.message));
});

test('project migration updates source metadata without changing profile-wide identity authorization', async t => {
  const { store, open } = await fixture(t);
  store.registerSession({ id: 'run-a', projectId: 'old-workspace', task: 'migration', team: { projectId: 'old-workspace' }, metadata: { projectId: 'old-workspace', nested: [{ projectId: 'old-workspace' }], cwd: 'old-workspace' } });
  session(store, 'already-there', 'new-workspace');
  const source = record(store, { id: 'migration-original', text: 'original text old-workspace stays verbatim', payload: { projectId: 'old-workspace', nested: [{ projectId: 'old-workspace' }, { projectId: 'unrelated' }] } });
  record(store, { sessionId: 'already-there', id: 'destination-original', text: 'existing destination record', payload: { projectId: 'old-workspace' } });
  const memory = store.saveMemory({ id: 'move-note', projectId: 'old-workspace', kind: 'agent', agentId: 'alice', content: 'recorded lesson', sourceRefs: [source], status: 'active' }, admin);
  store.saveMemory({ id: 'move-deleted', projectId: 'old-workspace', kind: 'agent', agentId: null, content: 'removed memory' }, admin);
  store.deleteMemory('move-deleted', admin);
  const migrated = store.migrateProject('old-workspace', 'new-workspace');
  assert.deepEqual({ sessions: migrated.sessions, records: migrated.records, memories: migrated.memories, tombstones: migrated.tombstones }, { sessions: 1, records: 1, memories: 1, tombstones: 1 });
  const oldContext = { ...alice, projectId: 'old-workspace' }, newContext = { ...alice, projectId: 'new-workspace' };
  assert.equal(store.sessionSearch({ query: 'original text', projectId: 'old-workspace' }, oldContext).total, 0);
  assert.equal(store.sessionSearch({ query: 'original text' }, oldContext).total, 1);
  assert.equal(store.sessionSearch({ query: 'original text' }, newContext).total, 1);
  assert.equal(store.memoryGet(memory.id, oldContext).projectId, 'new-workspace');
  assert.equal(store.memoryGet(memory.id, newContext).projectId, 'new-workspace');
  assert.deepEqual(store.memoryGet(memory.id, newContext).sourceRefs, [source]);
  const details = store.sessionGet({ reference: source }, newContext);
  assert.equal(details.records[0].reference, source); assert.equal(details.records[0].text, 'original text old-workspace stays verbatim');
  assert.equal(details.records[0].payload.projectId, 'new-workspace'); assert.equal(details.records[0].payload.nested[1].projectId, 'unrelated');
  assert.equal(details.session.metadata.projectId, 'new-workspace'); assert.equal(details.session.metadata.nested[0].projectId, 'new-workspace');
  assert.equal(details.session.metadata.cwd, 'old-workspace'); assert.equal(details.session.team.projectId, 'new-workspace');
  assert.equal(store.sessionGet({ sessionId: 'already-there' }, admin).records[0].payload.projectId, 'old-workspace');
  assert.equal(store.exportData({ projectId: 'new-workspace' }, admin).tombstones[0].id, 'move-deleted');
  assert.equal(store.migrateProject('old-workspace', 'new-workspace').records, 0);
  store.close(); const reopened = await open();
  assert.equal(reopened.memoryGet(memory.id, newContext).projectId, 'new-workspace');
  assert.throws(() => reopened.saveMemory({ id: 'move-deleted', projectId: 'new-workspace', content: 'restore' }, admin), /cannot be restored/);
});

test('project migration rolls back every table if a later update fails', async t => {
  const { store } = await fixture(t);
  session(store, 'run-a', 'old-workspace');
  const source = record(store, { payload: { projectId: 'old-workspace' } });
  store.saveMemory({ id: 'rollback-note', projectId: 'old-workspace', kind: 'agent', agentId: 'alice', content: 'rollback lesson', sourceRefs: [source] }, admin);
  let fixtureDatabase;
  if (process.versions.bun) { const { Database } = await import('bun:sqlite'); fixtureDatabase = new Database(store.status().filename); }
  else { const { DatabaseSync } = await import('node:sqlite'); fixtureDatabase = new DatabaseSync(store.status().filename); }
  try {
    fixtureDatabase.exec("CREATE TRIGGER fail_project_move BEFORE UPDATE OF project_id ON memories WHEN NEW.project_id='rejected-workspace' BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END;");
    assert.throws(() => store.migrateProject('old-workspace', 'rejected-workspace'), /fixture migration failure/);
    const original = store.sessionGet({ sessionId: 'run-a' }, admin);
    assert.equal(original.session.projectId, 'old-workspace'); assert.equal(original.records[0].projectId, 'old-workspace');
    assert.equal(original.records[0].payload.projectId, 'old-workspace'); assert.equal(store.memoryGet('rollback-note', admin).projectId, 'old-workspace');
  } finally { fixtureDatabase.close(); }
});

test('inactive memory is unavailable by direct id, search, list and export to every nonadministrator', async t => {
  const { store } = await fixture(t);
  session(store);
  const source = record(store, { role: 'user' });
  for (const status of ['paused', 'invalid']) {
    store.saveMemory({ id: `inactive-${status}`, kind: 'agent', agentId: null, status, content: `private inactive ${status}`, sourceRefs: [source] }, admin);
    for (const ctx of [alice, bob, teacher]) {
      assert.equal(store.memoryGet({ id: `inactive-${status}`, includeInactive: true }, ctx), null);
      assert.equal(store.memorySearch({ query: status, status, includeInactive: true, admin: true }, ctx).total, 0);
      assert.equal(store.listMemories({ status, includeInactive: true }, ctx).total, 0);
    }
  }
  store.saveMemory({ id: 'time-expired', kind: 'agent', agentId: null, content: 'time expired', expiresAt: '2000-01-01', sourceRefs: [source] }, admin);
  assert.equal(store.memoryGet('time-expired', teacher), null);
  assert.equal(store.memoryGet('time-expired', admin).status, 'invalid');
  assert.equal(store.memorySearch({}, admin).total, 0);
  assert.equal(store.listMemories({}, admin).total, 3);
  assert.equal(store.listMemories({ status: 'invalid' }, admin).total, 2);
  assert.equal(store.exportData({ includeInactive: true }, teacher).memories.length, 0);
});

test('only an explicit administrator edit can resume a paused memory and expiry remains authoritative', async t => {
  const { store } = await fixture(t);
  session(store);
  const source = record(store);
  const created = store.saveMemory({ id: 'pause-me', content: 'stored working practice', sourceRefs: [source] }, alice);
  store.saveMemory({ id: created.id, status: 'paused' }, admin);
  for (const ctx of [alice, teacher, { ...admin, automatic: true }]) {
    const repeated = store.saveMemory({ id: created.id, content: created.content, status: 'active', sourceRefs: [source] }, ctx);
    assert.equal(repeated.status, 'paused');
    if (!ctx.admin) assert.equal(repeated.content, undefined);
    assert.throws(() => store.saveMemory({ id: created.id, content: 'change paused body', sourceRefs: [source] }, ctx), /cannot alter/);
  }
  const newIdRetry = store.saveMemory({ id: 'retry-new-id', content: created.content, sourceRefs: [source] }, alice);
  assert.equal(newIdRetry.id, created.id); assert.equal(newIdRetry.content, undefined);
  assert.equal(store.status().memories, 1);
  const usable = store.reviewMemory({ id: created.id, verdict: 'usable', reason: 'This does not override the user pause.' }, alice);
  assert.equal(usable.status, 'paused'); assert.equal(usable.content, undefined);
  assert.equal(usable.assessment.verifiedCurrentFact, false);
  const resumed = store.saveMemory({ id: created.id, status: 'active' }, admin);
  assert.equal(resumed.status, 'active'); assert.equal(resumed.lastVerifiedAt, null);
  assert.equal(store.memoryGet(created.id, alice).content, created.content);
  store.saveMemory({ id: created.id, expiresAt: '2000-01-01' }, admin);
  assert.equal(store.saveMemory({ id: created.id, status: 'active' }, admin).status, 'invalid');
  const stillExpired = store.reviewMemory({ id: created.id, verdict: 'usable', reason: 'Historical source exists.' }, alice);
  assert.equal(stillExpired.status, 'invalid'); assert.equal(stillExpired.content, undefined);
  assert.equal(store.memoryGet(created.id, alice), null);
  assert.equal(store.saveMemory({ id: created.id, expiresAt: null, status: 'active' }, admin).status, 'active');
});

test('assessment persists only for an owner or teacher and never turns historical evidence into verification', async t => {
  const { store, open } = await fixture(t);
  session(store);
  const own = record(store, { id: 'own-evidence', text: 'owner evidence' });
  const shared = record(store, { id: 'shared-evidence', role: 'user', text: 'shared evidence' });
  const foreign = record(store, { id: 'bob-evidence', agentId: 'bob', text: 'private Bob evidence' });
  const privateNote = store.saveMemory({ id: 'private-review', content: 'owner practice', sourceRefs: [own] }, alice);
  const uncertain = store.reviewMemory({ id: privateNote.id, verdict: 'uncertain', reason: 'Need to inspect the current workspace.', sourceRefs: [own] }, alice);
  assert.equal(uncertain.status, 'active'); assert.equal(uncertain.reviewVerdict, 'uncertain');
  assert.equal(uncertain.lastVerifiedAt, null); assert.equal(uncertain.assessment.verifiedCurrentFact, false);
  assert.deepEqual(uncertain.reviewSourceRefs, [own]); assert.ok(uncertain.reviewedAt);
  assert.throws(() => store.reviewMemory({ id: privateNote.id, verdict: 'invalid', reason: 'bad' }, bob), /scope/);
  assert.throws(() => store.reviewMemory({ id: privateNote.id, verdict: 'usable', reason: 'bad', sourceRefs: [foreign] }, alice), /scope/);
  const publicNote = store.saveMemory({ id: 'public-review', kind: 'agent', agentId: null, content: 'shared project practice', sourceRefs: [shared] }, teacher);
  const local = store.reviewMemory({ id: publicNote.id, verdict: 'invalid', reason: 'Unsuitable for this task.', sourceRefs: [shared] }, bob);
  assert.equal(local.status, 'active'); assert.equal(local.assessment.appliedToMemory, false);
  assert.equal(store.memoryGet(publicNote.id, admin).reviewedAt, null);
  assert.throws(() => store.reviewMemory({ id: publicNote.id, verdict: 'invalid', reason: 'private basis', sourceRefs: [own] }, alice), /private source/);
  const invalid = store.reviewMemory({ id: privateNote.id, verdict: 'invalid', reason: 'Contradicted by the current output.', sourceRefs: [own] }, alice);
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.content, undefined); assert.equal(invalid.sourceRefs, undefined);
  assert.equal(invalid.assessment.appliedToMemory, true); assert.equal(store.memoryGet(privateNote.id, alice), null);
  const notResumed = store.reviewMemory({ id: privateNote.id, verdict: 'usable', reason: 'Retry must not reactivate it.' }, alice);
  assert.equal(notResumed.status, 'invalid'); assert.equal(notResumed.content, undefined);
  const expired = store.reviewMemory({ id: publicNote.id, verdict: 'expired', reason: 'This environment is no longer in use.', sourceRefs: [shared] }, teacher);
  assert.equal(expired.status, 'invalid'); assert.equal(expired.content, undefined);
  assert.equal(store.memorySearch({}, teacher).total, 0);
  store.close();
  const reopened = await open();
  assert.equal(reopened.memoryGet(publicNote.id, admin).reviewVerdict, 'expired');
  assert.equal(reopened.memoryGet(publicNote.id, alice), null);
  assert.throws(() => reopened.reviewMemory({ id: publicNote.id, verdict: 'confirmed', reason: 'invalid verdict' }, admin), /verdict/);
});

test('deduplication merges authorized evidence but preserves scope, content and every inactive lifecycle', async t => {
  const { store } = await fixture(t);
  session(store); session(store, 'run-b', 'project-b');
  const own = record(store, { id: 'first-source' });
  const second = record(store, { id: 'second-source' });
  const other = record(store, { id: 'other-source', agentId: 'bob' });
  const shared = record(store, { id: 'shared-source', role: 'user' });
  const foreign = record(store, { id: 'foreign-source', sessionId: 'run-b' });
  const first = store.saveMemory({ id: 'original', content: '规范化  空白\n内容', sourceRefs: [own] }, alice);
  const duplicate = store.saveMemory({ id: 'duplicate', content: '  规范化 空白 内容  ', sourceRefs: [second] }, alice);
  assert.equal(duplicate.id, first.id); assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.content, first.content); assert.deepEqual(duplicate.sourceRefs, [own, second]);
  assert.equal(store.status().memories, 1);
  assert.throws(() => store.saveMemory({ content: first.content, sourceRefs: [other] }, alice), /scope/);
  assert.equal(store.saveMemory({ content: first.content, sourceRefs: [foreign] }, alice).id, first.id);
  assert.throws(() => store.saveMemory({ id: first.id, content: 'alter the original', sourceRefs: [own] }, alice), /cannot alter/);
  assert.throws(() => store.saveMemory({ id: first.id, content: first.content, expiresAt: '2999-01-01', sourceRefs: [own] }, alice), /cannot alter/);
  assert.throws(() => store.saveMemory({ id: first.id, content: first.content, lastVerifiedAt: new Date().toISOString(), sourceRefs: [own] }, alice), /cannot alter/);
  store.saveMemory({ id: 'bob-copy', content: first.content, sourceRefs: [other] }, bob);
  store.saveMemory({ id: 'foreign-copy', content: first.content, sourceRefs: [foreign] }, { ...alice, projectId: 'project-b' });
  store.saveMemory({ id: 'skill-copy', kind: 'agent', content: first.content, sourceRefs: [own] }, alice);
  store.saveMemory({ id: 'public-copy', kind: 'agent', agentId: null, content: first.content, sourceRefs: [shared] }, teacher);
  assert.equal(store.status().memories, 3);
  for (const status of ['paused', 'invalid']) {
    store.saveMemory({ id: first.id, status }, admin);
    const retried = store.saveMemory({ content: first.content, sourceRefs: [second] }, alice);
    assert.equal(retried.id, first.id); assert.equal(retried.status, status);
    assert.equal(retried.content, undefined); assert.equal(retried.unavailable, true);
    assert.equal(store.status().memories, 3);
  }
});

test('content tombstones prevent a deleted automatic memory returning with a different id across reopen and migration', async t => {
  const { store, open } = await fixture(t);
  session(store);
  const own = record(store, { id: 'delete-source' });
  const other = record(store, { id: 'other-source', agentId: 'bob' });
  store.saveMemory({ id: 'deleted-note', content: 'deleted  durable\npractice', sourceRefs: [own] }, alice);
  store.deleteMemory('deleted-note', alice);
  assert.equal(store.status().contentTombstones, 1);
  assert.throws(() => store.saveMemory({ id: 'new-id', content: ' deleted durable practice ', sourceRefs: [own] }, alice), /Deleted memory content/);
  const foreignOwner = store.saveMemory({ id: 'bob-same-content', content: 'deleted durable practice', sourceRefs: [other] }, bob);
  assert.equal(foreignOwner.agentId, 'bob');
  store.close();
  const reopened = await open();
  assert.throws(() => reopened.saveMemory({ id: 'retry-after-reopen', content: 'deleted durable practice', sourceRefs: [own] }, alice), /Deleted memory content/);
  assert.equal(reopened.migrateProject('project-a', 'moved-project').contentTombstones, 1);
  assert.throws(() => reopened.saveMemory({ content: 'deleted durable practice', sourceRefs: [own] }, { ...alice, projectId: 'moved-project' }), /Deleted memory content/);
  const exported = reopened.exportData({ projectId: 'moved-project' }, admin);
  assert.equal(exported.contentTombstones[0].contentHash.length, 64);
  assert.equal(exported.contentTombstones[0].projectId, 'moved-project');
  assert.equal(exported.contentTombstones[0].content, undefined);
});

test('v1 candidate and confirmed migration preserves identity, evidence and deletions and is idempotent', async t => {
  const { store, open, directory } = await fixture(t);
  session(store);
  const firstSource = record(store, { id: 'legacy-source-one' });
  const secondSource = record(store, { id: 'legacy-source-two' });
  store.saveMemory({ id: 'legacy-a', content: 'legacy same content', sourceRefs: [firstSource] }, alice);
  store.saveMemory({ id: 'legacy-unique', content: 'legacy unique content', sourceRefs: [secondSource] }, alice);
  store.saveMemory({ id: 'legacy-deleted', content: 'legacy removed content', sourceRefs: [firstSource] }, alice);
  store.deleteMemory('legacy-deleted', alice);
  store.close();
  const database = await openFixtureDatabase(path.join(directory, 'memory.sqlite'));
  try {
    database.exec(`CREATE TABLE old_memories AS SELECT id,project_id,agent_id,kind,category,content,status,source_refs_json,created_at,updated_at,last_verified_at,expires_at FROM memories;
      DROP TABLE memories;
      CREATE TABLE memories(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,agent_id TEXT,kind TEXT NOT NULL,category TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,source_refs_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_verified_at TEXT,expires_at TEXT);
      INSERT INTO memories SELECT * FROM old_memories;
      DROP TABLE old_memories;
      UPDATE memories SET status='candidate' WHERE id='legacy-a';
      UPDATE memories SET status='confirmed' WHERE id='legacy-unique';
      INSERT INTO memories SELECT 'legacy-z',project_id,agent_id,kind,category,content,'confirmed','["run-a:legacy-source-two"]',created_at,updated_at,last_verified_at,expires_at FROM memories WHERE id='legacy-a';
      DROP TABLE memory_content_tombstones;
      UPDATE memory_meta SET value='1' WHERE key='schema_version';`);
  } finally { database.close(); }
  const migrated = await open();
  assert.equal(migrated.status().schemaVersion, 3);
  assert.equal(migrated.memoryGet('legacy-a', alice).status, 'active');
  assert.equal(migrated.memoryGet('legacy-unique', alice).status, 'active');
  assert.deepEqual(migrated.memoryGet('legacy-a', alice).sourceRefs, [firstSource, secondSource]);
  assert.equal(migrated.memoryGet('legacy-z', alice), null);
  assert.equal(migrated.memoryGet('legacy-z', admin).duplicateOf, 'legacy-a');
  assert.deepEqual(migrated.memoryGet('legacy-z', admin).sourceRefs, [secondSource]);
  assert.equal(migrated.memorySearch({}, alice).total, 2);
  assert.equal(migrated.saveMemory({ id: 'legacy-z', content: 'legacy same content', sourceRefs: [secondSource] }, alice).id, 'legacy-a');
  assert.equal(migrated.saveMemory({ content: 'legacy same content', sourceRefs: [secondSource] }, alice).id, 'legacy-a');
  const descendant = migrated.saveMemory({ id: 'legacy-child', content: 'uses an old retained identity', sourceRefs: ['memory:legacy-z'] }, alice);
  assert.deepEqual(descendant.sourceRefs, ['memory:legacy-z']);
  assert.throws(() => migrated.saveMemory({ id: 'legacy-deleted', content: 'resurrect', sourceRefs: [firstSource] }, alice), /cannot be restored/);
  migrated.saveMemory({ id: 'legacy-a', status: 'paused' }, admin);
  migrated.close();
  const again = await open();
  assert.equal(again.memoryGet('legacy-a', admin).status, 'paused');
  assert.equal(again.memoryGet('legacy-z', admin).duplicateOf, 'legacy-a');
  assert.equal(again.status().memories, 4);
  assert.equal(again.deleteMemory('legacy-z', admin).deletedMemories, 3);
  assert.equal(again.memoryGet('legacy-a', admin), null);
  assert.equal(again.memoryGet(descendant.id, admin), null);
});

test('deleting review-only evidence removes reviewed memory and prevents automatic resurrection', async t => {
  const { store } = await fixture(t);
  session(store); session(store, 'review-run');
  const source = record(store, { id: 'original-source' });
  const reviewSource = record(store, { sessionId: 'review-run', id: 'review-source' });
  const note = store.saveMemory({ content: 'practice with separate review evidence', sourceRefs: [source] }, alice);
  store.reviewMemory({ id: note.id, verdict: 'usable', reason: 'Validated against separate evidence.', sourceRefs: [reviewSource] }, alice);
  assert.equal(store.deleteSession('review-run', admin).deletedMemories, 1);
  assert.equal(store.memoryGet(note.id, admin), null);
  assert.throws(() => store.saveMemory({ content: note.content, sourceRefs: [source] }, alice), /Deleted memory content/);
});

test('manual disable remains available after evidence is inactive and manual evidence replacement removes old references', async t => {
  const { store } = await fixture(t);
  session(store);
  const original = record(store, { id: 'editable-original' });
  const replacement = record(store, { id: 'replacement-source' });
  const parent = store.saveMemory({ id: 'editable-parent', content: 'first evidence interpretation', sourceRefs: [original] }, alice);
  const child = store.saveMemory({ id: 'editable-child', content: 'derived procedure', sourceRefs: [`memory:${parent.id}`] }, alice);
  store.saveMemory({ id: parent.id, status: 'paused' }, admin);
  assert.equal(store.saveMemory({ id: child.id, status: 'paused' }, admin).status, 'paused');
  assert.throws(() => store.saveMemory({ id: child.id, status: 'active' }, admin), /no longer active/);
  const changed = store.saveMemory({ id: child.id, sourceRefs: [replacement] }, admin);
  assert.deepEqual(changed.sourceRefs, [replacement]);
  assert.equal(store.saveMemory({ id: child.id, status: 'active' }, admin).status, 'active');
  store.deleteMemory(parent.id, admin);
  assert.equal(store.memoryGet(child.id, alice).content, child.content);
  const removed = store.saveMemory({ id: child.id, sourceRefs: [] }, admin);
  assert.deepEqual(removed.sourceRefs, []);
  assert.deepEqual(store.saveMemory({ id: child.id, status: 'paused' }, admin).sourceRefs, []);
});

test('user and agent profiles cross workspace boundaries while ownership and source sharing remain authoritative', async t => {
  const { store } = await fixture(t);
  session(store); session(store, 'run-b', 'project-b');
  const publicA = record(store, { id: 'public-a', role: 'user', text: 'User explicitly prefers Chinese responses.' });
  const publicB = record(store, { id: 'public-b', sessionId: 'run-b', shared: true, text: 'Shared verified workflow in another workspace.' });
  const privateB = record(store, { id: 'private-b', sessionId: 'run-b', agentId: 'bob', role: 'context', text: 'Private model context BOB_ONLY' });
  const ownB = record(store, { id: 'own-b', sessionId: 'run-b', agentId: 'alice', role: 'context', text: 'Own model context ALICE_ONLY' });
  const automatic = { admin: true, automatic: true };
  const user = store.saveMemory({ kind: 'user', agentId: null, projectId: 'project-a', content: 'User prefers Chinese answers.', category: 'preference', sourceRefs: [publicA] }, automatic);
  const sharedAgent = store.saveMemory({ kind: 'agent', agentId: null, projectId: 'profile:global', content: 'Review both old and new workflow evidence.', sourceRefs: [publicA, publicB] }, automatic);
  const privateAgent = store.saveMemory({ kind: 'agent', agentId: 'bob', projectId: 'project-b', content: 'Bob private working memory.', sourceRefs: [privateB] }, automatic);
  const own = store.saveMemory({ kind: 'agent', projectId: 'project-a', content: 'Alice can reuse her own cross-workspace context.', sourceRefs: [ownB] }, alice);
  const elsewhere = { ...alice, projectId: 'unrelated-workspace' };
  assert.equal(store.memoryGet(user.id, elsewhere).kind, 'user');
  assert.equal(store.memoryGet(sharedAgent.id, elsewhere).kind, 'agent');
  assert.equal(store.memoryGet(own.id, elsewhere).agentId, 'alice');
  assert.equal(store.memoryGet(privateAgent.id, elsewhere), null);
  assert.equal(store.memoryGet(privateAgent.id, { ...teacher, projectId: 'different-project' }).agentId, 'bob');
  assert.equal(store.memorySearch({ projectId: 'does-not-exist' }, elsewhere).total, 3);
  assert.equal(store.listMemories({ projectId: 'does-not-exist' }, admin).total, 4);
  assert.equal(store.sessionGet({ reference: publicB }, elsewhere).session.projectId, 'project-b');
  assert.equal(store.sessionGet({ reference: ownB }, { agentId: 'alice', role: 'student' }).items.some(item => item.reference === ownB), true);
  assert.equal(store.sessionGet({ reference: privateB }, elsewhere), null);
  assert.equal(store.sessionSearch({ query: 'BOB_ONLY', projectId: 'project-b', admin: true }, elsewhere).total, 0);
  assert.equal(store.sessionSearch({ query: 'BOB_ONLY' }, teacher).total, 1);
  assert.throws(() => store.saveMemory({ kind: 'agent', agentId: null, content: 'Promote private context', sourceRefs: [ownB] }, alice), /teacher or administrator/);
  assert.throws(() => store.saveMemory({ kind: 'user', content: 'Student changes user profile', sourceRefs: [publicA] }, alice), /teacher or administrator/);
  assert.throws(() => store.saveMemory({ kind: 'user', agentId: 'alice', content: 'Private user profile', sourceRefs: [publicA] }, automatic), /must be shared/);
  assert.throws(() => store.saveMemory({ kind: 'user', agentId: null, content: 'Publish Bob context', sourceRefs: [privateB] }, automatic), /private source/);
  assert.throws(() => store.saveMemory({ kind: 'agent', agentId: null, content: 'Publish Bob memory', sourceRefs: [`memory:${privateAgent.id}`] }, automatic), /private source/);
  assert.throws(() => store.saveMemory({ id: sharedAgent.id, kind: 'agent', agentId: null, content: sharedAgent.content, sourceRefs: [publicB] }, alice), /scope/);
  const localReview = store.reviewMemory({ id: sharedAgent.id, verdict: 'usable', reason: 'Current task can use this shared historical guidance.', sourceRefs: [publicB] }, elsewhere);
  assert.equal(localReview.assessment.appliedToMemory, false);
  assert.equal(store.memoryGet(sharedAgent.id, admin).reviewedAt, null);
});

test('profile-wide content identity retains pauses and deletions across original projects without merging private owners or user and agent kinds', async t => {
  const { store, open } = await fixture(t);
  session(store); session(store, 'run-b', 'project-b');
  const a = record(store, { id: 'profile-a', role: 'user' });
  const b = record(store, { id: 'profile-b', sessionId: 'run-b', role: 'user' });
  const automatic = { admin: true, automatic: true };
  const note = store.saveMemory({ kind: 'agent', agentId: null, projectId: 'project-a', content: 'One  shared\nprocedure', sourceRefs: [a] }, automatic);
  store.saveMemory({ id: note.id, status: 'paused' }, admin);
  const duplicate = store.saveMemory({ kind: 'agent', agentId: null, projectId: 'project-b', content: 'One shared procedure', sourceRefs: [b] }, automatic);
  assert.equal(duplicate.id, note.id); assert.equal(duplicate.status, 'paused');
  assert.equal(duplicate.projectId, 'project-a'); assert.deepEqual(duplicate.sourceRefs, [a, b]);
  assert.equal(store.listMemories({}, admin).total, 1);
  const user = store.saveMemory({ kind: 'user', agentId: null, projectId: 'project-b', content: 'One shared procedure', sourceRefs: [b] }, automatic);
  const own = store.saveMemory({ kind: 'agent', content: 'One shared procedure', sourceRefs: [b] }, alice);
  assert.notEqual(user.id, note.id); assert.notEqual(own.id, note.id);
  store.deleteMemory(note.id, admin);
  assert.equal(store.memoryGet(user.id, bob).kind, 'user');
  assert.equal(store.memoryGet(own.id, bob), null);
  store.close();
  const reopened = await open();
  assert.throws(() => reopened.saveMemory({ kind: 'agent', agentId: null, projectId: 'third-workspace', content: 'One shared procedure', sourceRefs: [b] }, automatic), /Deleted memory content/);
  assert.equal(reopened.memoryGet(user.id, { ...bob, projectId: 'third-workspace' }).status, 'active');
  assert.equal(reopened.status().contentTombstones, 1);
});

test('v2 migration consolidates shared projects without exposing old role context and keeps global lifecycle and deletion safeguards', async t => {
  const { store, open, directory } = await fixture(t);
  session(store); session(store, 'run-b', 'project-b');
  const publicA = record(store, { id: 'v2-public-a', role: 'user' });
  const publicB = record(store, { id: 'v2-public-b', sessionId: 'run-b', shared: true });
  const privateA = record(store, { id: 'v2-private-a', text: 'Legacy Alice private context', role: 'context' });
  const privateB = record(store, { id: 'v2-private-b', sessionId: 'run-b', text: 'Legacy Bob private context', role: 'context', agentId: 'bob' });
  store.saveMemory({ id: 'v2-shared-a', kind: 'agent', agentId: null, content: 'same shared procedure', sourceRefs: [publicA] }, admin);
  const role = store.saveMemory({ id: 'v2-role', kind: 'agent', agentId: 'alice', content: 'Alice historical role procedure', sourceRefs: [privateA] }, admin);
  store.reviewMemory({ id: role.id, verdict: 'uncertain', reason: 'Historical evidence needs current review.', sourceRefs: [privateA] }, alice);
  store.saveMemory({ id: 'v2-skill', kind: 'agent', agentId: 'bob', projectId: 'project-b', content: 'Bob historical skill procedure', sourceRefs: [privateB] }, admin);
  store.saveMemory({ id: 'v2-user', kind: 'user', agentId: null, content: 'User wants concise Chinese answers', sourceRefs: [publicA] }, admin);
  store.saveMemory({ id: 'v2-expired', kind: 'agent', agentId: null, content: 'old expired procedure', status: 'invalid', sourceRefs: [publicA] }, admin);
  store.saveMemory({ id: 'v2-superseded', kind: 'agent', agentId: null, content: 'old superseded procedure', status: 'invalid', sourceRefs: [publicA] }, admin);
  store.saveMemory({ id: 'v2-time', kind: 'agent', agentId: null, content: 'old timed procedure', expiresAt: '2000-01-01', sourceRefs: [publicB] }, admin);
  store.saveMemory({ id: 'v2-deleted', kind: 'agent', agentId: null, content: 'deleted old cross-project procedure', sourceRefs: [publicA] }, admin);
  store.deleteMemory('v2-deleted', admin);
  const deletedHash = store.exportData({}, admin).contentTombstones[0].contentHash;
  store.close();
  const database = await openFixtureDatabase(path.join(directory, 'memory.sqlite'));
  const execute = (sql, values) => { const statement = database.prepare(sql); try { statement.run(...values); } finally { statement.finalize?.(); } };
  try {
    database.exec(`DROP INDEX memories_global_identity;
      UPDATE memories SET kind='project' WHERE agent_id IS NULL AND kind='agent';
      UPDATE memories SET kind='role' WHERE id='v2-role';
      UPDATE memories SET kind='skill' WHERE id='v2-skill';
      UPDATE memories SET status='expired' WHERE id='v2-expired';
      UPDATE memories SET status='superseded' WHERE id='v2-superseded';
      CREATE TABLE v2_content_tombstones(project_id TEXT NOT NULL,kind TEXT NOT NULL,agent_id TEXT NOT NULL,content_hash TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(project_id,kind,agent_id,content_hash));
      INSERT INTO v2_content_tombstones SELECT project_id,CASE WHEN kind='agent' THEN 'project' ELSE kind END,agent_id,content_hash,deleted_at FROM memory_content_tombstones;
      DROP TABLE memory_content_tombstones;
      ALTER TABLE v2_content_tombstones RENAME TO memory_content_tombstones;
      UPDATE memory_meta SET value='2' WHERE key='schema_version';`);
    execute("INSERT INTO memories(id,project_id,agent_id,kind,category,content,status,source_refs_json,created_at,updated_at,content_hash) SELECT 'v2-shared-b','project-b',agent_id,kind,category,content,'paused',?,created_at,updated_at,content_hash FROM memories WHERE id='v2-shared-a'", [JSON.stringify([publicB])]);
    execute("INSERT INTO memories(id,project_id,agent_id,kind,category,content,status,source_refs_json,created_at,updated_at,content_hash) SELECT 'v2-deleted-copy','project-b',agent_id,kind,category,'deleted old cross-project procedure','active',?,created_at,updated_at,? FROM memories WHERE id='v2-shared-a'", [JSON.stringify([publicB]), deletedHash]);
  } finally { database.close(); }
  const migrated = await open(), differentWorkspace = { ...alice, projectId: 'project-z' };
  assert.equal(migrated.status().schemaVersion, 3);
  assert.equal(migrated.memoryGet('v2-role', differentWorkspace).kind, 'agent');
  assert.equal(migrated.memoryGet('v2-role', differentWorkspace).agentId, 'alice');
  assert.equal(migrated.memoryGet('v2-role', differentWorkspace).reviewVerdict, 'uncertain');
  assert.deepEqual(migrated.memoryGet('v2-role', differentWorkspace).reviewSourceRefs, [privateA]);
  assert.equal(migrated.memoryGet('v2-skill', differentWorkspace), null);
  assert.equal(migrated.memoryGet('v2-skill', { ...bob, projectId: 'project-z' }).kind, 'agent');
  assert.equal(migrated.sessionGet({ reference: privateB }, differentWorkspace), null);
  assert.equal(migrated.sessionGet({ reference: privateA }, differentWorkspace).items.some(item => item.reference === privateA), true);
  assert.equal(migrated.memoryGet('v2-user', differentWorkspace).kind, 'user');
  assert.equal(migrated.memoryGet('v2-shared-b', admin).status, 'paused');
  assert.deepEqual(new Set(migrated.memoryGet('v2-shared-b', admin).sourceRefs), new Set([publicA, publicB]));
  assert.equal(migrated.memoryGet('v2-shared-a', admin).status, 'invalid');
  assert.equal(migrated.memoryGet('v2-shared-a', admin).duplicateOf, 'v2-shared-b');
  assert.deepEqual(migrated.memoryGet('v2-shared-a', admin).sourceRefs, [publicA]);
  for (const id of ['v2-expired', 'v2-superseded', 'v2-time']) {
    assert.equal(migrated.memoryGet(id, admin).status, 'invalid');
    assert.equal(migrated.memoryGet(id, teacher), null);
  }
  assert.equal(migrated.listMemories({ status: 'invalid' }, admin).total, 4);
  assert.equal(migrated.memoryGet('v2-deleted-copy', admin), null);
  assert.ok(migrated.exportData({}, admin).tombstones.some(item => item.id === 'v2-deleted-copy'));
  assert.throws(() => migrated.saveMemory({ kind: 'agent', agentId: null, projectId: 'another-project', content: 'deleted old cross-project procedure', sourceRefs: [publicB] }, { admin: true, automatic: true }), /Deleted memory content/);
  assert.equal(migrated.saveMemory({ kind: 'agent', agentId: null, projectId: 'another-project', content: 'same shared procedure', sourceRefs: [publicA] }, { admin: true, automatic: true }).status, 'paused');
  assert.ok(migrated.listMemories({}, admin).items.every(item => ['user', 'agent'].includes(item.kind) && ['active', 'paused', 'invalid'].includes(item.status)));
  const snapshot = migrated.exportData({}, admin);
  migrated.close();
  const again = await open();
  assert.deepEqual(again.exportData({}, admin).memories, snapshot.memories);
  assert.deepEqual(again.exportData({}, admin).contentTombstones, snapshot.contentTombstones);
  assert.equal(again.status().records, 4);
});

test('expired assessments and elapsed dates expose only invalid while paused dates stay excluded from active access', async t => {
  const { store } = await fixture(t);
  session(store);
  const source = record(store);
  const note = store.saveMemory({ content: 'A dated agent procedure', sourceRefs: [source] }, alice);
  const assessed = store.reviewMemory({ id: note.id, verdict: 'expired', reason: 'The source explicitly expired.' }, alice);
  assert.equal(assessed.status, 'invalid'); assert.equal(assessed.content, undefined);
  assert.equal(store.memoryGet(note.id, admin).reviewVerdict, 'expired');
  store.saveMemory({ id: note.id, status: 'paused', expiresAt: '2000-01-01' }, admin);
  assert.equal(store.memoryGet(note.id, admin).status, 'invalid');
  assert.equal(store.listMemories({ status: 'paused' }, admin).total, 0);
  assert.equal(store.listMemories({ status: 'invalid' }, admin).total, 1);
  for (const status of ['expired', 'superseded']) assert.throws(() => store.saveMemory({ id: note.id, status }, admin), /Invalid memory/);
});

test('v2 kind consolidation removes newly cyclic canonical evidence while retaining duplicate audit references', async t => {
  const { store, open, directory } = await fixture(t);
  session(store);
  const source = record(store, { role: 'user' });
  store.saveMemory({ id: 'cycle-c', content: 'temporary distinct content', sourceRefs: [source] }, alice);
  store.saveMemory({ id: 'cycle-b', content: 'middle skill evidence', sourceRefs: ['memory:cycle-c'] }, alice);
  store.saveMemory({ id: 'cycle-a', content: 'same historical procedure', sourceRefs: ['memory:cycle-b'] }, alice);
  store.close();
  const database = await openFixtureDatabase(path.join(directory, 'memory.sqlite'));
  try {
    database.exec(`DROP INDEX memories_global_identity;
      UPDATE memories SET kind='skill';
      UPDATE memories SET kind='role',created_at='2000-01-01T00:00:00.000Z' WHERE id='cycle-a';
      UPDATE memories SET content=(SELECT content FROM memories WHERE id='cycle-a'),content_hash=(SELECT content_hash FROM memories WHERE id='cycle-a') WHERE id='cycle-c';
      UPDATE memory_meta SET value='2' WHERE key='schema_version';`);
  } finally { database.close(); }
  const migrated = await open();
  assert.deepEqual(migrated.memoryGet('cycle-a', admin).sourceRefs, [source]);
  assert.equal(migrated.memoryGet('cycle-c', admin).duplicateOf, 'cycle-a');
  assert.deepEqual(migrated.memoryGet('cycle-c', admin).sourceRefs, [source]);
  assert.deepEqual(migrated.memoryGet('cycle-b', admin).sourceRefs, ['memory:cycle-c']);
  assert.equal(migrated.saveMemory({ content: 'safe consolidation descendant', sourceRefs: ['memory:cycle-b'] }, alice).status, 'active');
});
