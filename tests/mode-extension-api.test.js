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
import { prepareExtensionUpdate } from '../src/extension-config.js';
import { loadCLIExtensions } from '../src/cli-extensions.js';
import { MODE_EXTENSION_PRESETS, getModeExtensionPreset } from '../src/mode-extensions.js';

async function ownedDirectory(t, cleanup = async () => {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-mode-extension-api-'));
  t.after(async () => {
    await cleanup();
    const actual = await fs.realpath(root);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('class-mode-extension-api-'));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(actual, { recursive: true, force: true });
  });
  return root;
}

const sendTool = (res, name, input) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: randomUUID(), name, input }] }));
};
function directory(tools, name) {
  const description = tools.find(tool => tool.name === name)?.description;
  if (!description) return [];
  const marker = 'Directory preview: ', position = description.indexOf(marker);
  assert.ok(position >= 0, 'Extension tool must expose its bounded directory preview');
  const result = JSON.parse(description.slice(position + marker.length));
  assert.equal(result.total, result.preview.length, 'This fixture stays below the preview limit');
  return result.preview;
}

for (const scenario of ['web-defaults', 'web-explicit-grants', 'auto']) test(`${scenario}: real task API applies only task-scoped mode grants and preserves the saved profile`, { timeout: 30000 }, async t => {
  let app, mock, failure, released = false, teacherReady = false, principalTools;
  const root = await ownedDirectory(t, async () => { await app?.close(); if (mock) await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections(); }); }), dataDir = path.join(root, 'data'), token = randomUUID();
  const taskMode = scenario === 'auto' ? 'auto' : 'web_pentest';
  const task = 'Inspect only the isolated fixture metadata and report the available classroom capabilities.';
  const records = new Map(), waiting = new Map();
  const releaseAnswer = () => {
    if (!released && records.get('alice')?.ready && records.get('bob')?.ready && waiting.has('alice')) {
      released = true;
      sendTool(waiting.get('alice'), 'submit_answer', { content: 'The configured capability metadata has been inspected.', evidence: 'The authorized catalogue was read.', remainingIssues: [] });
      waiting.delete('alice');
    }
  };
  mock = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(req.url, '/v1/messages');
      if (body.model === 'principal') {
        principalTools = body.tools.map(tool => tool.name);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'The classroom is inspecting its authorized capability metadata.' }] }));
        return;
      }
      if (body.tools.some(tool => tool.name === 'define_acceptance')) {
        assert.ok(!body.tools.some(tool => ['search_tools', 'search_skills', 'read_skill'].includes(tool.name)), 'Criteria extraction keeps its existing non-execution stage');
        return sendTool(res, 'define_acceptance', { criteria: [{ id: 'metadata', description: task, evidenceType: 'text' }] });
      }
      assert.ok(['teacher', 'alice', 'bob'].includes(body.model));
      const record = records.get(body.model) || { tools: body.tools, ready: false };
      records.set(body.model, record);
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
      if (!results.length && body.tools.some(tool => tool.name === 'search_skills')) return sendTool(res, 'search_skills', { limit: 20 });
      if (results.length) {
        const result = JSON.parse(results.at(-1).content);
        assert.equal(result.success, true);
        record.skills = JSON.parse(result.output).skills;
        assert.ok(record.skills.every(item => !Object.hasOwn(item, 'content')));
      } else record.skills = [];
      record.ready = true;
      waiting.set(body.model, res);
      if (body.model === 'teacher') teacherReady = true;
      else releaseAnswer();
    } catch (error) {
      failure = error;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const store = await createProfileStore(dataDir), ids = ['teacher', 'alice', 'bob', 'principal'];
  const agents = ids.map(id => ({ id, name: id, role: id === 'teacher' ? 'teacher' : id === 'principal' ? 'principal' : 'student', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, protocol: 'messages', model: id }));
  let extensions = store.config.extensions;
  if (scenario !== 'web-defaults') extensions = {
    ...extensions,
    mcps: [...extensions.mcps.map(item => scenario === 'web-explicit-grants' && item.builtin === 'burpsuite' ? { ...item, agentIds: ['alice'] } : item),
      { id: 'custom-mcp', name: 'Custom fixture service', transport: 'http', url: 'http://127.0.0.1:1/unused-fixture', enabled: true, agentIds: ['teacher', 'bob'] }],
    skills: [...extensions.skills.map(item => scenario === 'web-explicit-grants' && item.builtin === 'ctf-web' ? { ...item, agentIds: ['bob'] } : item),
      { id: 'custom-skill', name: 'Custom fixture guide', description: 'Custom guide metadata', content: 'PRIVATE_CUSTOM_BODY', enabled: true, agentIds: ['alice'] }],
  };
  await store.save({ ...store.config, agents, extensions }, Object.fromEntries(ids.map(id => [id, 'isolated-fixture-key'])));
  app = await createClassServer({ dataDir, token });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST', status = 200) => {
    if (failure) throw failure;
    const response = await fetch(app.url + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const until = async check => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (failure) throw failure;
      const value = await check(); if (value) return value;
      await delay(25);
    }
    throw Error('Mode extension API fixture timed out');
  };
  await api('/api/memory/settings', { enabled: false }, 'PUT');
  const before = await api('/api/extensions'), savedBefore = JSON.parse(await fs.readFile(path.join(dataDir, 'profiles.json'), 'utf8')).extensions;
  const run = (await api('/api/runs', { task, taskMode }, 'POST', 202)).run;
  assert.equal(run.taskMode, taskMode);
  assert.deepEqual(run.team.students.map(item => item.id).sort(), ['alice', 'bob']);
  await until(() => teacherReady);
  assert.equal(records.size, 3);
  for (const id of ['teacher', 'alice', 'bob']) {
    const record = records.get(id);
    const expected = kind => before[kind].filter(item => {
      const modeDefault = MODE_EXTENSION_PRESETS[taskMode][kind].includes(item.builtin);
      return (item.enabled || modeDefault) && (item.agentIds.includes(id) || modeDefault && item.agentIds.length === 0);
    }).map(item => item.id).sort();
    assert.deepEqual(directory(record.tools, 'search_tools').map(item => item.id).sort(), expected('mcps'), id + ' MCP grants');
    assert.deepEqual(directory(record.tools, 'read_skill').map(item => item.id).sort(), expected('skills'), id + ' Skill grants');
    assert.deepEqual(record.skills.map(item => item.id).sort(), expected('skills'), id + ' can read the authorized short Skill catalogue');
    assert.ok(!JSON.stringify(record.tools).includes('PRIVATE_CUSTOM_BODY'));
    if (scenario === 'web-defaults') {
      assert.equal(expected('mcps').length, 3);
      assert.equal(expected('skills').length, 8);
    }
  }
  assert.deepEqual(await api('/api/extensions'), before);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'profiles.json'), 'utf8')).extensions, savedBefore);
  assert.ok(!before.agents.some(agent => agent.id === 'principal'));
  const report = (await api(`/api/runs/${run.id}/principal`, { question: 'Describe the current classroom status without taking action.' }, 'POST', 202)).report;
  await until(async () => (await api(`/api/runs/${run.id}/principal/${report.id}`)).report.status === 'completed');
  assert.deepEqual(principalTools.sort(), ['principal_list_context', 'principal_read_context', 'principal_search_context', 'context_read'].sort());
  await api(`/api/runs/${run.id}/stop`, {});
  await until(async () => !['running', 'paused'].includes((await api(`/api/runs/${run.id}`)).run.status));
  assert.deepEqual(await api('/api/extensions'), before);
  await assert.rejects(fs.stat(path.join(dataDir, 'mcp-runtimes')), { code: 'ENOENT' });
});

for (const taskMode of ['web_pentest', 'ctf_solve', 'binary_audit', 'pentest']) test(`CLI ${taskMode} seeds a task-local catalogue while automatic mode remains empty`, async () => {
  const config = { teacher: { id: 'teacher' }, students: [{ id: 'alice' }, { id: 'bob' }] };
  const automatic = await loadCLIExtensions(config, { environment: {} });
  assert.deepEqual(automatic.extensionConfig, { revision: 0, mcps: [], skills: [] });
  const web = await loadCLIExtensions({ ...config, taskMode }, { environment: {} });
  for (const kind of ['mcps', 'skills']) {
    const enabled = web.extensionConfig[kind].filter(item => item.enabled);
    assert.deepEqual(enabled.map(item => item.builtin).sort(), [...getModeExtensionPreset(taskMode)[kind]].sort());
    for (const item of enabled) assert.deepEqual(item.agentIds, ['teacher', 'alice', 'bob']);
  }
  assert.equal(Object.hasOwn(config, 'extensions'), false);
});

test('CLI mode activation rejects a dormant profile credential binding that belongs to an old endpoint', async t => {
  const root = await ownedDirectory(t), filename = path.join(root, 'profiles.json');
  const agents = [{ id: 'teacher', role: 'teacher' }, { id: 'alice', role: 'student' }, { id: 'bob', role: 'student' }];
  const initial = prepareExtensionUpdate({ revision: 0, mcps: [{ id: 'class-burpsuite', name: 'burpsuite', builtin: 'burpsuite', transport: 'sse', url: 'http://127.0.0.1:1/original', enabled: false, agentIds: [], headers: { Authorization: 'Bearer isolated-private-fixture' } }], skills: [] }, {}, agents, {});
  const extensionConfig = { ...initial.extensions, mcps: initial.extensions.mcps.map(item => ({ ...item, url: 'http://127.0.0.1:1/changed' })) };
  await fs.writeFile(filename, JSON.stringify({ version: 1, agents, extensions: extensionConfig }));
  const before = await fs.readFile(filename, 'utf8');
  const config = { teacher: { id: 'teacher' }, students: [{ id: 'alice' }, { id: 'bob' }] };
  const options = { profileDirectory: root, environment: {}, loadProfileSecrets: async () => initial.secrets };
  const automatic = await loadCLIExtensions(config, options);
  assert.deepEqual(automatic.extensionSecrets, {});
  await assert.rejects(loadCLIExtensions({ ...config, taskMode: 'web_pentest' }, options), error => error.status === 409 && /凭据与连接配置不匹配/.test(error.message));
  await assert.rejects(loadCLIExtensions({ ...config, taskMode: 'ctf_solve' }, options), error => error.status === 409 && /凭据与连接配置不匹配/.test(error.message));
  await assert.rejects(loadCLIExtensions({ ...config, taskMode: 'pentest' }, options), error => error.status === 409 && /凭据与连接配置不匹配/.test(error.message));
  assert.equal(await fs.readFile(filename, 'utf8'), before);
});
