import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClassServer } from '../src/web-server.js';
import { createProfileStore } from '../src/profile-store.js';
import { CheckpointStore, CHECKPOINT_SECRET_ID } from '../src/checkpoint-store.js';

for (const [mode, taskMode] of [['restart', 'web_pentest'], ['migrate', 'web_pentest'], ['migrate-subdirectory', 'web_pentest'], ['external-workspace', 'auto'], ['restart', 'ctf_solve'], ['restart', 'binary_audit'], ['restart', 'pentest']]) test(`${taskMode} ${mode}: resume retains criteria, verifies relocated files and never replays the completed write`, { timeout: 45000 }, async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-resume-api-'));
  const source = path.join(root, 'source'), target = path.join(root, 'destination');
  const external = mode === 'external-workspace', migrate = mode !== 'restart', movedWorkspace = migrate && !external;
  const suffix = mode === 'migrate-subdirectory' ? 'nested' : '';
  const originalRoot = external ? path.join(root, 'external') : path.join(source, 'workspace', suffix);
  const expectedRoot = movedWorkspace ? path.join(target, 'workspace', suffix) : originalRoot;
  let originalCwd = originalRoot, expectedCwd = expectedRoot;
  let dataDir = source, app, resumed = false, criteriaCalls = 0, writeCalls = 0, readCalls = 0, waiting = false, evidence, newReadRef, mockFailure;
  const token = randomUUID(), task = 'Create result.txt containing 4 and verify the saved result.';
  const send = (res, name, input) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: randomUUID(), name, input }] })); };
  const mock = http.createServer(async (req, res) => {
    try {
      const parts = []; for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts));
      if (taskMode === 'web_pentest') assert.match(JSON.stringify(body.system), /Web漏洞挖掘/);
      else assert.doesNotMatch(JSON.stringify(body.system), /Web漏洞挖掘/);
      if (taskMode === 'ctf_solve') assert.match(JSON.stringify(body.system), /当前任务模式：CTF题目求解/);
      if (taskMode === 'binary_audit') assert.match(JSON.stringify(body.system), /当前任务模式：二进制漏洞挖掘/);
      if (taskMode === 'pentest') assert.match(JSON.stringify(body.system), /当前任务模式：渗透测试/);
      const originalInput = JSON.parse(body.messages.find(message => message.role === 'user' && typeof message.content === 'string').content);
      assert.equal(originalInput.attachments?.[0]?.name, 'resume-note.txt');
      assert.match(originalInput.attachments[0].path, /^\.class-attachments\//);
      if (body.tools?.some(tool => tool.name === 'define_acceptance')) {
        criteriaCalls++; return send(res, 'define_acceptance', { criteria: [{ id: 'file', description: task, evidenceType: 'tool' }] });
      }
      if (body.model === 'bob') return; // Intentionally unfinished peer; shutdown cancels only this request.
      if (body.model === 'alice') {
        const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
        if (!results.length && !resumed) { writeCalls++; return send(res, 'write_file', { path: 'result.txt', content: '4' }); }
        if (results.length) evidence = JSON.parse(results.at(-1).content);
        if (!resumed) { waiting = true; return; }
        assert.ok(evidence?.evidenceRef, 'confirmed result must remain available');
        return send(res, 'submit_answer', { content: 'Saved 4 to result.txt.', evidence: 'The recorded write completed.', evidenceRefs: [evidence.evidenceRef], completionClaims: [task], remainingIssues: [] });
      }
      assert.equal(body.model, 'teacher');
      const input = JSON.parse(body.messages.find(message => message.role === 'user' && typeof message.content === 'string').content);
      const moved = input.resumeWarnings?.find(item => item.callId === 'workspace:moved');
      let refs = [evidence.evidenceRef], recoveryChecks = [];
      if (movedWorkspace) {
        assert.equal(moved.previousCwd, originalCwd); assert.equal(moved.cwd, expectedCwd); assert.equal(moved.resolved, false);
        const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
        if (!results.length) { readCalls++; return send(res, 'read_file', { path: path.join(expectedCwd, 'result.txt') }); }
        const checked = JSON.parse(results.at(-1).content);
        assert.equal(checked.output, '4', 'read must target the migrated copy, not the deliberately changed old file');
        assert.ok(checked.evidenceRef); assert.notEqual(checked.evidenceRef, evidence.evidenceRef);
        newReadRef = checked.evidenceRef; refs = [newReadRef];
        recoveryChecks = [{ callId: 'workspace:moved', status: 'verified', reason: 'A fresh read in the new workspace confirms the saved file.', evidenceRefs: refs }];
      } else assert.equal(moved, undefined, 'an external workspace must not be relocated');
      return send(res, 'submit_review', { valid: true, answer: 'Saved 4 to result.txt.', report: 'The file operation completed and its location is verified.', criteriaResults: [{ criterionId: 'file', status: 'passed', reason: 'The recorded operation verifies the requested content.', evidenceKind: 'tool', evidenceRefs: refs }], evidenceRefs: refs, recoveryChecks });
    } catch (error) { mockFailure = error; res.writeHead(500); res.end(); }
  });
  t.after(async () => {
    await app?.close(); await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections(); });
    const actual = await fs.realpath(root); assert.equal(path.dirname(actual), parent); assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(actual, { recursive: true, force: true });
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const store = await createProfileStore(source), ids = ['teacher', 'alice', 'bob'];
  await fs.mkdir(originalCwd, { recursive: true });
  await store.save({ ...store.config, settings: { ...store.config.settings, cwd: originalCwd }, agents: ids.map(id => ({ id, name: id, role: id === 'teacher' ? 'teacher' : 'student', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, protocol: 'messages', model: id })) }, Object.fromEntries(ids.map(id => [id, 'isolated-fake-key'])));
  const start = async () => { app = await createClassServer({ dataDir, dataAnchor: source, token }); };
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST', status = 200) => {
    if (mockFailure) throw mockFailure;
    const response = await fetch(app.url + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  async function until(check) { for (let i = 0; i < 180; i++) { if (mockFailure) throw mockFailure; const result = await check(); if (result) return result; await delay(50); } throw Error('Isolated resume fixture timed out'); }
  await start(); await api('/api/memory/settings', { enabled: false }, 'PUT');
  const attachment = (await api('/api/attachments', { name: 'resume-note.txt', contentBase64: Buffer.from('preserve uploaded input across resume').toString('base64') }, 'POST', 201)).attachment;
  const original = (await api('/api/runs', { task, taskMode, attachmentIds: [attachment.id] }, 'POST', 202)).run;
  originalCwd = path.join(originalRoot, '.class-runs', original.id);
  expectedCwd = path.join(expectedRoot, '.class-runs', original.id);
  assert.equal(original.cwd, originalCwd);
  assert.equal(original.taskMode, taskMode);
  await until(() => waiting);
  const output = path.join(originalCwd, 'result.txt');
  await app.close(); resumed = true; await start();
  const savedStore = await createProfileStore(source);
  const savedCheckpoints = new CheckpointStore({ directory: path.join(source, 'checkpoints'), getKey: () => savedStore.secrets[CHECKPOINT_SECRET_ID] });
  const saved = await savedCheckpoints.read(original.id);
  assert.equal(saved.metadata.cwd, originalCwd);
  assert.equal(saved.metadata.taskMode, taskMode); assert.equal(saved.state.taskMode, taskMode);
  assert.deepEqual(saved.metadata.attachmentIds, [attachment.id]);
  if (external) assert.equal(Object.hasOwn(saved.metadata, 'workspaceRelative'), false);
  else assert.equal(saved.metadata.workspaceRelative, path.join(suffix, '.class-runs', original.id));
  if (mode === 'restart') {
    await savedCheckpoints.write(original.id, { ...saved.state, taskMode: 'auto' }, saved.metadata);
    await api(`/api/runs/${original.id}/resume`, {}, 'POST', 409);
    await savedCheckpoints.write(original.id, saved.state, { ...saved.metadata, taskMode: 'auto' });
    await api(`/api/runs/${original.id}/resume`, {}, 'POST', 409);
    for (const workspaceRelative of ['../outside', '..\\outside', path.join(root, 'outside'), 'C:outside']) {
      await savedCheckpoints.write(original.id, saved.state, { ...saved.metadata, workspaceRelative });
      await api(`/api/runs/${original.id}/resume`, {}, 'POST', 409);
    }
    await savedCheckpoints.write(original.id, saved.state, saved.metadata);
  }
  if (mode === 'external-workspace') {
    // Existing checkpoints and history predate task modes and mean automatic.
    delete saved.state.taskMode; delete saved.metadata.taskMode;
    await savedCheckpoints.write(original.id, saved.state, saved.metadata);
  }
  if (migrate) {
    const moved = await api('/api/data-directory', { path: target }, 'PUT');
    assert.equal(moved.dataDir, target); assert.equal(moved.settings.cwd, expectedRoot);
    if (movedWorkspace) await fs.writeFile(output, 'Old workspace is preserved; do not use this copy.');
    await app.close(); dataDir = target; await start();
  }
  const currentOutput = path.join(expectedCwd, 'result.txt'), before = await fs.stat(currentOutput), oldBefore = await fs.stat(output);
  assert.equal(await fs.readFile(path.join(expectedCwd, original.attachments[0].path), 'utf8'), 'preserve uploaded input across resume');
  let state = await api('/api/state'); assert.equal(state.history[0].id, original.id); assert.equal(state.history[0].recoverable, true);
  const teacher = state.agents.find(agent => agent.id === 'teacher');
  await api('/api/agents', { ...teacher, model: 'changed' }, 'POST');
  await api(`/api/runs/${original.id}/resume`, {}, 'POST', 409);
  await api('/api/agents', teacher, 'POST');
  await api(`/api/runs/${original.id}/resume`, { taskMode: taskMode === 'auto' ? 'web_pentest' : 'auto' }, 'POST', 400);
  const next = (await api(`/api/runs/${original.id}/resume`, {}, 'POST', 202)).run;
  assert.equal(next.id, original.id);
  assert.equal(next.taskMode, taskMode);
  state = await until(async () => { const state = await api('/api/state'); return state.run?.status === 'completed' ? state : false; });
  assert.equal(state.run.id, original.id); assert.equal(state.run.resumeCount, 1); assert.equal(state.run.recoverable, false);
  assert.equal(state.run.taskMode, taskMode);
  assert.equal(criteriaCalls, 1, 'the accepted task criteria must not be regenerated on restart');
  assert.equal(state.run.cwd, expectedCwd); assert.equal(writeCalls, 1); assert.equal(readCalls, movedWorkspace ? 1 : 0);
  assert.equal((await fs.stat(currentOutput)).mtimeMs, before.mtimeMs); assert.equal(await fs.readFile(currentOutput, 'utf8'), '4');
  assert.equal((await fs.stat(output)).mtimeMs, oldBefore.mtimeMs);
  assert.equal(await fs.readFile(output, 'utf8'), movedWorkspace ? 'Old workspace is preserved; do not use this copy.' : '4');
  if (movedWorkspace) {
    assert.ok(newReadRef);
    const journal = await fs.readFile(path.join(dataDir, 'history', original.id, 'journal.jsonl'), 'utf8');
    assert.ok(journal.includes('workspace:moved')); assert.ok(journal.includes(newReadRef));
  }
  await assert.rejects(fs.stat(path.join(dataDir, 'checkpoints', original.id + '.json')), { code: 'ENOENT' });
});
