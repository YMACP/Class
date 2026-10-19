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

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-composer-api-'));
  const token = randomUUID(); let dataDir = path.join(root, 'data'), app;
  t.after(async () => { await app?.close(); assert.equal(path.dirname(await fs.realpath(root)), parent); assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(root, { recursive: true, force: true }); });
  const start = async next => { if (next) dataDir = next; app = await createClassServer({ dataDir, dataAnchor: path.join(root, 'data'), token }); };
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST', expected = 200) => {
    const response = await fetch(app.url + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  const until = async check => { for (let i = 0; i < 150; i++) { const value = await check(); if (value) return value; await delay(40); } throw Error('Composer fixture timed out'); };
  return { root, dataDir, start, api, until, stop: () => app.close() };
}

test('conversation metadata and attachments persist across completion, restart and data migration without changing the task', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.start(); await f.api('/api/memory/settings', { enabled: false }, 'PUT');
  for (const taskMode of ['invalid', {}, 1, false]) await f.api('/api/runs', { demo: true, taskMode }, 'POST', 400);
  assert.equal((await f.api('/api/state')).history.length, 0, 'invalid modes must not create tasks');
  const attachment = (await f.api('/api/attachments', { name: 'example.txt', contentBase64: Buffer.from('readable fixture').toString('base64') }, 'POST', 201)).attachment;
  assert.equal((await f.api('/api/attachments')).attachments[0].id, attachment.id);
  const run = (await f.api('/api/runs', { demo: true, taskMode: 'web_pentest', attachmentIds: [attachment.id] }, 'POST', 202)).run, originalTask = run.task;
  assert.equal(run.taskMode, 'web_pentest');
  await f.api(`/api/runs/${run.id}`, { task: 'must not change' }, 'PUT', 400);
  await f.api(`/api/runs/${run.id}`, { taskMode: 'auto' }, 'PUT', 400);
  await f.api(`/api/runs/${run.id}`, { pinned: 'yes' }, 'PUT', 400);
  const edited = await f.api(`/api/runs/${run.id}`, { title: ' 新的对话名称 ', pinned: true }, 'PUT');
  assert.equal(edited.run.task, originalTask); assert.equal(edited.run.title, '新的对话名称');
  await f.api(`/api/attachments/${attachment.id}`, undefined, 'DELETE', 409);
  await f.until(async () => (await f.api('/api/state')).run.status === 'completed'); await f.stop(); await f.start();
  let state = await f.api('/api/state'); assert.equal(state.history[0].pinned, true); assert.equal(state.run.title, '新的对话名称');
  assert.equal(state.run.taskMode, 'web_pentest'); assert.equal(state.history[0].taskMode, 'web_pentest');
  const target = path.join(f.root, 'migrated'); await f.api('/api/data-directory', { path: target }, 'PUT');
  await f.stop(); await f.start(target); state = await f.api('/api/state');
  assert.equal(state.run.task, originalTask); assert.equal(state.run.attachments[0].id, attachment.id);
  assert.equal(state.run.taskMode, 'web_pentest'); assert.equal(state.history[0].taskMode, 'web_pentest');
  const copied = path.join(state.settings.cwd, '.class-runs', run.id, run.attachments[0].path); assert.equal(await fs.readFile(copied, 'utf8'), 'readable fixture');
  await f.api(`/api/runs/${run.id}`, undefined, 'DELETE');
  assert.equal((await f.api('/api/state')).history.length, 0); await assert.rejects(fs.stat(copied), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(target, 'attachments', attachment.id)), { code: 'ENOENT' });
});

for (const taskMode of ['auto', 'web_pentest']) test(`${taskMode}: teacher and students retain original task and attachments while applying the selected mode`, { timeout: 30000 }, async t => {
  const f = await fixture(t), task = '读取上传的资料，告诉我其中的验证码。', answer = 'fixture-7328';
  const seen = new Set(); let modelError;
  const send = (res, name, input) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: randomUUID(), name, input }] })); };
  const mock = http.createServer(async (req, res) => {
    try {
      const parts = []; for await (const chunk of req) parts.push(chunk); const body = JSON.parse(Buffer.concat(parts));
      const input = JSON.parse(body.messages.find(message => message.role === 'user' && typeof message.content === 'string').content);
      if (taskMode === 'web_pentest') assert.match(JSON.stringify(body.system), /Web漏洞挖掘/);
      else assert.doesNotMatch(JSON.stringify(body.system), /Web漏洞挖掘/);
      assert.equal(input.task, task); assert.equal(input.attachments[0].name, '验证码.txt'); assert.match(input.attachments[0].path, /^\.class-attachments\//);
      assert.match(input.attachmentInstructions, /read_image/); assert.match(input.attachmentInstructions, /read_pdf/); assert.doesNotMatch(input.attachmentInstructions, /read_media/);
      const criteria = body.tools.some(tool => tool.name === 'define_acceptance'); seen.add(criteria ? 'criteria' : body.model);
      if (criteria) return send(res, 'define_acceptance', { criteria: [{ id: 'read', description: task, evidenceType: 'tool' }] });
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
      if (!results.length) return send(res, 'read_file', { path: input.attachments[0].path });
      const result = JSON.parse(results.at(-1).content); assert.equal(result.output, answer); assert.ok(result.evidenceRef); seen.add(body.model + ':read');
      if (body.model !== 'teacher') return send(res, 'submit_answer', { content: answer, evidence: '实际读取了上传的文本文件。', evidenceRefs: [result.evidenceRef], completionClaims: [task], remainingIssues: [] });
      return send(res, 'submit_review', { valid: true, answer, report: '已独立读取并确认验证码。', evidenceRefs: [result.evidenceRef], criteriaResults: [{ criterionId: 'read', status: 'passed', reason: '通过读取上传资料取得验证码。', evidenceKind: 'tool', evidenceRefs: [result.evidenceRef] }] });
    } catch (error) { modelError = error; res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await f.stop(); await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections(); }); });
  const store = await createProfileStore(f.dataDir), ids = ['teacher', 'alice', 'bob'];
  await store.save({ ...store.config, agents: ids.map(id => ({ id, name: id, role: id === 'teacher' ? 'teacher' : 'student', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, protocol: 'messages', model: id })) }, Object.fromEntries(ids.map(id => [id, 'isolated-fake-key'])));
  await f.start(); await f.api('/api/memory/settings', { enabled: false }, 'PUT');
  const attachment = (await f.api('/api/attachments', { name: '验证码.txt', contentBase64: Buffer.from(answer).toString('base64') }, 'POST', 201)).attachment;
  const run = (await f.api('/api/runs', { task, ...(taskMode === 'auto' ? {} : { taskMode }), attachmentIds: [attachment.id] }, 'POST', 202)).run;
  const finished = await f.until(async () => { if (modelError) throw modelError; const current = (await f.api('/api/state')).run; return ['completed', 'failed'].includes(current.status) && current; });
  assert.equal(finished.status, 'completed', finished.error); assert.equal(finished.task, task); assert.equal(finished.result.answer, answer);
  for (const key of ['criteria', 'alice', 'bob', 'teacher', 'alice:read', 'teacher:read']) assert.ok(seen.has(key), key);
  assert.equal(finished.attachments[0].id, attachment.id); assert.equal(run.task, task);
  assert.equal(run.taskMode, taskMode); assert.equal(finished.taskMode, taskMode);
});

test('old completed history without a task mode opens as auto without rewriting the record', async t => {
  const f = await fixture(t); await f.start(); await f.api('/api/memory/settings', { enabled: false }, 'PUT');
  const run = (await f.api('/api/runs', { demo: true }, 'POST', 202)).run;
  await f.until(async () => (await f.api('/api/state')).run.status === 'completed'); await f.stop();
  const file = path.join(f.dataDir, 'history', run.id + '.json');
  const legacy = JSON.parse(await fs.readFile(file, 'utf8')); delete legacy.taskMode;
  const bytes = JSON.stringify(legacy); await fs.writeFile(file, bytes);
  await f.start();
  const state = await f.api('/api/state');
  assert.equal(state.run.taskMode, 'auto'); assert.equal(state.history[0].taskMode, 'auto');
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});
