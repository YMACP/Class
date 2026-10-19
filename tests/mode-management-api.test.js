import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClassServer } from '../src/web-server.js';
import { createProfileStore } from '../src/profile-store.js';
import { WEB_PENTEST_PROMPT } from '../src/web-pentest-prompt.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'class-mode-management-'));
  const token = 'isolated-mode-management-token-123456789';
  let server = await createClassServer({ dataDir: directory, token });
  t.after(async () => { await server.close(); await fs.rm(directory, { recursive: true, force: true }); });
  async function request(route, body, method = body === undefined ? 'GET' : 'POST', status = 200) {
    const response = await fetch(new URL(route, server.url), { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  }
  return { directory, request, async restart() { await server.close(); server = await createClassServer({ dataDir: directory, token }); } };
}
const mcp = id => ({ id, name: id, transport: 'http', url: 'http://127.0.0.1:1/mcp', enabled: false, agentIds: [], headers: { Authorization: 'fixture-only-credential' } });
const skill = id => ({ id, name: id, content: 'Read the fixture only.', description: '', enabled: false, agentIds: [] });
async function extend(request) {
  const value = await request('/api/extensions');
  return request('/api/extensions', { ...value, mcps: [...value.mcps, mcp('custom-mcp-a'), mcp('custom-mcp-b')], skills: [...value.skills, skill('custom-skill-a'), skill('custom-skill-b')] }, 'PUT');
}
async function mode(request, extensions, name = '本地检查') {
  const modes = await request('/api/modes');
  const result = await request('/api/modes', { revision: modes.revision, extensionRevision: extensions.revision, name, prompt: '\n完整说明：保持老师学生与校长的各自职责。\n', mcps: ['custom-mcp-a'], skills: ['custom-skill-a'] }, 'POST', 201);
  return { result, item: result.items.find(item => item.name === name) };
}

test('built-in MCP/Skill deletion and identity stripping are rejected atomically through both APIs', async t => {
  const { request } = await fixture(t), extensions = await extend(request);
  for (const kind of ['mcps','skills']) {
    const builtin = extensions[kind].find(item => item.builtin), custom = extensions[kind].find(item => !item.builtin);
    await request('/api/extensions', { revision: extensions.revision, kind, ids: [custom.id, builtin.id] }, 'DELETE', 400);
    await request('/api/extensions', { ...extensions, [kind]: extensions[kind].filter(item => item.id !== builtin.id) }, 'PUT', 400);
    await request('/api/extensions', { ...extensions, [kind]: extensions[kind].map(item => { if (item.id !== builtin.id) return item; const copy = { ...item }; delete copy.builtin; return copy; }) }, 'PUT', 400);
    assert.deepEqual(await request('/api/extensions'), extensions);
  }
});

test('custom extension deletion removes only its secrets and mode links, with revision conflicts preventing stale deletion', async t => {
  const { request, directory } = await fixture(t), extensions = await extend(request);
  const { item } = await mode(request, extensions);
  const after = await request('/api/extensions', { revision: extensions.revision, kind: 'mcps', ids: ['custom-mcp-a','custom-mcp-b'] }, 'DELETE');
  assert.equal(after.mcps.some(entry => entry.id.startsWith('custom-mcp-')), false);
  assert.ok(after.skills.some(entry => entry.id === 'custom-skill-a'));
  const updated = (await request('/api/modes')).items.find(entry => entry.id === item.id);
  assert.deepEqual(updated.mcps, []); assert.deepEqual(updated.skills, ['custom-skill-a']);
  const store = await createProfileStore(directory);
  assert.equal(store.secrets['extension:custom-mcp-a'], undefined); assert.equal(store.secrets['extension:custom-mcp-b'], undefined);
  await request('/api/extensions', { revision: extensions.revision, kind: 'skills', ids: ['custom-skill-a'] }, 'DELETE', 409);
  await request('/api/extensions', { revision: after.revision, kind: 'skills', ids: ['custom-skill-a','missing'] }, 'DELETE', 409);
  assert.deepEqual(await request('/api/extensions'), after);
  const final = await request('/api/extensions', { revision: after.revision, kind: 'skills', ids: ['custom-skill-a','custom-skill-b'] }, 'DELETE');
  assert.equal(final.skills.some(entry => entry.id.startsWith('custom-skill-')), false);
  assert.deepEqual((await request('/api/modes')).items.find(entry => entry.id === item.id).skills, []);
});

test('mode catalogue preserves full prompts across restart and supplies only metadata in state', async t => {
  const { request, restart } = await fixture(t), extensions = await extend(request);
  const { result, item } = await mode(request, extensions);
  const web = result.items.find(entry => entry.id === 'web_pentest');
  assert.equal(web.prompt, WEB_PENTEST_PROMPT); assert.equal(web.mcps.length, 3); assert.equal(web.skills.length, 8);
  assert.equal(item.prompt, '\n完整说明：保持老师学生与校长的各自职责。\n');
  const state = await request('/api/state');
  assert.deepEqual(state.modes.items.find(entry => entry.id === item.id), { id: item.id, name: item.name, builtin: false });
  assert.ok(state.modes.items.every(entry => !Object.hasOwn(entry, 'prompt')));
  await restart(); assert.deepEqual(await request('/api/modes'), result);
  const current = await request('/api/modes');
  await request('/api/modes', { revision: current.revision, extensionRevision: extensions.revision, name: '无效关联', prompt: 'x', mcps: ['missing'], skills: [] }, 'POST', 400);
  await request('/api/modes', { revision: current.revision, extensionRevision: extensions.revision - 1, name: '过期扩展', prompt: 'x', mcps: [], skills: [] }, 'POST', 409);
  await request('/api/runs', { task: 'No model should be called.', taskMode: 'custom-00000000-0000-4000-8000-000000000000' }, 'POST', 400);
  assert.deepEqual(await request('/api/modes'), current);
});

test('mode deletion protects built-ins and leaves associated extensions untouched', async t => {
  const { request } = await fixture(t), extensions = await extend(request);
  const first = await mode(request, extensions, '模式甲'), second = await mode(request, extensions, '模式乙');
  await request('/api/modes', { revision: second.result.revision, ids: [first.item.id,'web_pentest'] }, 'DELETE', 400);
  await request('/api/modes', { revision: second.result.revision, ids: ['auto'] }, 'DELETE', 400);
  assert.deepEqual(await request('/api/modes'), second.result);
  await request('/api/modes', { revision: first.result.revision, ids: [first.item.id] }, 'DELETE', 409);
  const deleted = await request('/api/modes', { revision: second.result.revision, ids: [first.item.id, second.item.id] }, 'DELETE');
  assert.deepEqual(deleted.items.map(item => item.id), ['auto','web_pentest','ctf_solve','binary_audit','pentest']);
  assert.deepEqual(await request('/api/extensions'), extensions);
});
