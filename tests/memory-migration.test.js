import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClassServer } from '../src/web-server.js';
import { resolveDataLocation } from '../src/data-location.js';
import { createMemoryStore } from '../src/memory-store.js';

async function waitFor(read, predicate, label) {
  const deadline = Date.now() + 12000; let value;
  do { value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now() < deadline);
  assert.fail(label + ': ' + JSON.stringify(value));
}

test('HTTP data-directory migration preserves indexed sources, active memories and restart location', { timeout: 30000 }, async t => {
  const temporaryRoot = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temporaryRoot, 'class-memory-migration-'));
  const source = path.join(root, 'source'), target = path.join(root, 'destination'), token = 'isolated-migration-' + randomUUID();
  let app;
  t.after(async () => {
    await app?.close(); const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), temporaryRoot); assert.ok(path.basename(resolved).startsWith('class-memory-migration-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  async function api(endpoint, method = 'GET', body) {
    const response = await fetch(app.url + endpoint, { method, headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.ok(response.ok, endpoint + ': ' + JSON.stringify(value)); return value;
  }
  app = await createClassServer({ dataDir: source, dataAnchor: source, token });
  await api('/api/memory/status');
  const sessionId = (await api('/api/runs', 'POST', { demo: true })).run.id;
  await waitFor(() => api('/api/state'), state => state.run?.id === sessionId && !['running', 'stopping'].includes(state.run.status), 'demo completion');
  const search = await waitFor(() => api('/api/memory/sessions/search', 'POST', { query: '5050', sessionId, limit: 100 }), result => result.items?.some(item => item.shared), 'shared source indexing');
  const sourceRecord = search.items.find(item => item.shared), reference = sourceRecord.reference, projectId = sourceRecord.projectId;
  const manual = await fetch(app.url + '/api/memory/entries', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'agent', content: 'Manual creation is unavailable.' }) });
  assert.equal(manual.status, 405); await manual.json();
  const absent = await fetch(app.url + '/api/memory/entries/nonexistent', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'agent', content: 'An update must not create a memory.' }) });
  assert.equal(absent.status, 404); await absent.json();
  await app.close();
  const fixtureStore = await createMemoryStore({ directory: path.join(source, 'memory') });
  const saved = fixtureStore.saveMemory({ kind: 'agent', agentId: null, projectId, content: 'The archived demonstration reported 5050.', category: 'experience', status: 'active', sourceRefs: [reference] }, { admin: true, automatic: true });
  fixtureStore.close();
  app = await createClassServer({ dataDir: source, dataAnchor: source, token });
  const moved = await api('/api/data-directory', 'PUT', { path: target });
  assert.equal(moved.dataDir, target); assert.equal(moved.settings.cwd, path.join(target, 'workspace'));
  assert.equal(resolveDataLocation(source).dataDir, target);
  assert.ok((await fs.stat(path.join(target, 'memory', 'memory.sqlite'))).isFile());
  assert.ok((await fs.stat(path.join(source, 'history', sessionId, 'journal.jsonl'))).isFile(), 'Migration preserves source archive');
  assert.equal(await fs.readFile(path.join(target, 'history', sessionId, 'journal.jsonl'), 'utf8'), await fs.readFile(path.join(source, 'history', sessionId, 'journal.jsonl'), 'utf8'));
  const status = await waitFor(() => api('/api/memory/status'), status => status.available && !status.indexing && status.pending === 0, 'migrated store readiness');
  assert.notEqual(status.currentProjectId, projectId);
  const after = await api('/api/memory/sessions/search', 'POST', { query: '5050', sessionId });
  assert.ok(after.items.some(item => item.reference === reference && item.projectId === status.currentProjectId));
  const memory = await api('/api/memory/entries/' + saved.id);
  assert.equal(memory.content, saved.content); assert.equal(memory.status, 'active'); assert.deepEqual(memory.sourceRefs, [reference]); assert.equal(memory.projectId, status.currentProjectId);
  const defaultMemories = await api('/api/memory/entries');
  assert.ok(defaultMemories.items.some(item => item.id === saved.id && item.projectId === status.currentProjectId));
  const defaultSessions = await api('/api/memory/sessions');
  assert.ok(defaultSessions.items.some(item => item.id === sessionId && item.projectId === status.currentProjectId));
  const origin = await api('/api/memory/source?reference=' + encodeURIComponent(reference));
  assert.equal(origin.session.id, sessionId); assert.ok(origin.records.some(item => item.text.includes('5050')));
  await app.close();
  const location = resolveDataLocation(source);
  app = await createClassServer({ dataDir: location.dataDir, dataAnchor: location.anchorDir, token });
  const restartedStatus = await waitFor(() => api('/api/memory/status'), status => status.available && !status.indexing && status.pending === 0, 'restarted migrated store');
  assert.equal(restartedStatus.currentProjectId, status.currentProjectId);
  const restarted = await api('/api/memory/sessions/search', 'POST', { query: '5050', sessionId });
  assert.ok(restarted.items.some(item => item.reference === reference && item.projectId === restartedStatus.currentProjectId));
  const restartedMemory = await api('/api/memory/entries/' + saved.id);
  assert.equal(restartedMemory.content, saved.content); assert.equal(restartedMemory.projectId, restartedStatus.currentProjectId);
  assert.ok((await api('/api/memory/entries')).items.some(item => item.id === saved.id && item.projectId === restartedStatus.currentProjectId));
  assert.ok((await api('/api/memory/sessions')).items.some(item => item.id === sessionId && item.projectId === restartedStatus.currentProjectId));
});
