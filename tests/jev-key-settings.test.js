import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createClassServer } from '../src/web-server.js';
import { createProfileStore, JUDGE_SECRET_ID } from '../src/profile-store.js';
import { loadSecrets } from '../src/secret-store.js';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'class-jev-key-settings-'));
  const dataDir = path.join(root, 'profile'), token = 'fixture-token-' + randomUUID();
  const resources = [], calls = [];
  t.after(async () => {
    for (const close of resources.reverse()) await close();
    const actual = await fs.realpath(root);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('class-jev-key-settings-'));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(actual, { recursive: true, force: true });
  });
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ authorization: req.headers.authorization, url: req.url, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answers: { ready: { type: 'noul', noul: 0.99 } } }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  resources.push(() => new Promise((resolve, reject) => {
    mock.close(error => error ? reject(error) : resolve()); mock.closeAllConnections();
  }));
  const baseUrl = 'http://127.0.0.1:' + mock.address().port + '/v1/systemone';
  async function server() {
    const app = await createClassServer({ dataDir, dataAnchor: dataDir, token });
    resources.push(() => app.close());
    return { ...app, async api(endpoint, body, method = body === undefined ? 'GET' : 'PUT', expected = 200) {
      const response = await fetch(app.url + endpoint, { method, headers: { authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      const value = await response.json();
      assert.equal(response.status, expected, endpoint + ': ' + JSON.stringify(value));
      return value;
    } };
  }
  return { dataDir, calls, baseUrl, server };
}

test('saving never-configured Jev settings requires a key even when disabled and preserves member credentials', async t => {
  const f = await fixture(t), store = await createProfileStore(f.dataDir);
  const memberKeys = { teacher: 'fixture-teacher-unmodified', student: 'fixture-student-unmodified' };
  await store.save(store.config, memberKeys);
  const before = await fs.readFile(path.join(f.dataDir, 'profiles.json'), 'utf8');
  const app = await f.server();
  const initial = (await app.api('/api/judge')).judge;
  assert.equal(initial.enabled, false); assert.equal(initial.hasApiKey, false);
  for (const body of [{}, { enabled: false }, { enabled: true }, { apiKey: '' }, { enabled: false, apiKey: ' \t\r\n' }, { enabled: true, apiKey: ' ' }]) {
    const result = await app.api('/api/judge', body, 'PUT', 400);
    assert.equal(result.error, '尚未配置Jev密钥');
    assert.deepEqual((await app.api('/api/judge')).judge, initial);
    assert.equal(await fs.readFile(path.join(f.dataDir, 'profiles.json'), 'utf8'), before);
  }
  assert.deepEqual(await loadSecrets(f.dataDir), memberKeys);
  assert.equal(f.calls.length, 0);
});

test('saved Jev key replacements apply to the next HTTP request; empty or omitted input retains the key across restart', async t => {
  const f = await fixture(t), store = await createProfileStore(f.dataDir);
  const memberKeys = { teacher: 'fixture-original-teacher-key', student: 'fixture-original-student-key' };
  const firstKey = 'fixture-first-jev-key', newKey = 'fixture-replaced-jev-key';
  await store.save(store.config, memberKeys);
  let app = await f.server();
  async function check(expectedKey) {
    const prior = f.calls.length;
    const checked = await app.api('/api/judge/check', {}, 'POST');
    assert.equal(checked.ok, true);
    assert.equal(f.calls.length, prior + 1);
    assert.equal(f.calls.at(-1).authorization, 'Bearer ' + expectedKey);
    assert.equal(f.calls.at(-1).url, '/v1/systemone');
    assert.equal(f.calls.at(-1).body.model, 'jev-latest');
  }
  const first = await app.api('/api/judge', { enabled: false, baseUrl: f.baseUrl, apiKey: firstKey });
  assert.equal(first.judge.enabled, false); assert.equal(first.judge.hasApiKey, true);
  await check(firstKey);
  const replaced = await app.api('/api/judge', { enabled: true, apiKey: '  ' + newKey + '  ' });
  assert.equal(replaced.judge.enabled, true); await check(newKey);
  for (const body of [{ apiKey: '' }, { apiKey: ' \t\r\n' }, {}, { enabled: false }]) {
    assert.equal((await app.api('/api/judge', body)).judge.hasApiKey, true);
    await check(newKey);
  }
  assert.deepEqual(await loadSecrets(f.dataDir), { ...memberKeys, [JUDGE_SECRET_ID]: newKey });
  const publicData = JSON.stringify(await app.api('/api/state'));
  const profile = await fs.readFile(path.join(f.dataDir, 'profiles.json'), 'utf8');
  const credentialFiles = (await fs.readdir(f.dataDir)).filter(name => /^credentials\./.test(name));
  assert.ok(credentialFiles.length > 0);
  const encrypted = (await Promise.all(credentialFiles.map(name => fs.readFile(path.join(f.dataDir, name))))).map(data => data.toString('utf8')).join('\n');
  for (const secret of [...Object.values(memberKeys), firstKey, newKey]) {
    assert.equal(publicData.includes(secret), false);
    assert.equal(profile.includes(secret), false);
    assert.equal(encrypted.includes(secret), false);
  }
  assert.equal(Object.hasOwn(JSON.parse(profile).judge, 'apiKey'), false);
  await app.close(); app = await f.server();
  const restarted = (await app.api('/api/judge')).judge;
  assert.equal(restarted.hasApiKey, true); assert.equal(restarted.enabled, false);
  await check(newKey);
  await app.api('/api/judge', { enabled: true, apiKey: '' });
  await check(newKey);
  assert.deepEqual(await loadSecrets(f.dataDir), { ...memberKeys, [JUDGE_SECRET_ID]: newKey });
});

test('legacy profiles and API overrides use fixed native Jev settings while preserving credentials and preferences', async t => {
  const f = await fixture(t), store = await createProfileStore(f.dataDir);
  const key = 'fixture-legacy-fixed-jev-key';
  const features = { taskDispatch: true, toolCalls: false, toolResults: false, submissionReview: true };
  await store.save({ ...store.config, judge: { ...store.config.judge, enabled: true, baseUrl: f.baseUrl, features } }, { [JUDGE_SECRET_ID]: key });
  const filename = path.join(f.dataDir, 'profiles.json');
  const legacy = JSON.parse(await fs.readFile(filename, 'utf8'));
  legacy.judge.protocol = 'openai'; legacy.judge.model = 'legacy-model';
  await fs.writeFile(filename, JSON.stringify(legacy));
  let app = await f.server();
  const expected = { ...legacy.judge, protocol: 'system-one', model: 'jev-latest', hasApiKey: true };
  assert.deepEqual((await app.api('/api/judge')).judge, expected);
  for (const submitted of [
    { protocol: 'openai', model: 'other-model' },
    { protocol: 'unsupported', model: null },
  ]) {
    assert.equal((await app.api('/api/judge/check', submitted, 'POST')).ok, true);
    assert.deepEqual((await app.api('/api/judge', submitted)).judge, expected);
    assert.equal((await app.api('/api/judge/check', {}, 'POST')).ok, true);
    assert.deepEqual(await loadSecrets(f.dataDir), { [JUDGE_SECRET_ID]: key });
  }
  const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(saved.judge.protocol, 'system-one'); assert.equal(saved.judge.model, 'jev-latest');
  assert.deepEqual(saved.agents, legacy.agents); assert.deepEqual(saved.settings, legacy.settings);
  await app.close(); app = await f.server();
  assert.deepEqual((await app.api('/api/judge')).judge, expected);
  assert.equal((await app.api('/api/judge/check', {}, 'POST')).ok, true);
  assert.equal(f.calls.length, 5);
  for (const call of f.calls) {
    assert.equal(call.authorization, 'Bearer ' + key);
    assert.equal(call.url, '/v1/systemone');
    assert.equal(call.body.model, 'jev-latest');
    assert.deepEqual(Object.keys(call.body).sort(), ['model', 'questions', 'state']);
    assert.equal(call.body.questions.ready.type, 'noul');
  }
});

test('legacy clear-key requests cannot save a keyless Jev configuration or erase the saved key', async t => {
  const f = await fixture(t), app = await f.server(), key = 'fixture-preserved-jev-key';
  await app.api('/api/judge', { enabled: true, baseUrl: f.baseUrl, apiKey: key });
  const before = await fs.readFile(path.join(f.dataDir, 'profiles.json'), 'utf8');
  for (const body of [{ clearKey: true }, { clearKey: true, enabled: false }]) {
    const rejected = await app.api('/api/judge', body, 'PUT', 400);
    assert.equal(rejected.error, '尚未配置Jev密钥');
    assert.equal((await app.api('/api/judge')).judge.enabled, true);
    assert.equal(await fs.readFile(path.join(f.dataDir, 'profiles.json'), 'utf8'), before);
    assert.equal((await loadSecrets(f.dataDir))[JUDGE_SECRET_ID], key);
  }
  const checked = await app.api('/api/judge/check', {}, 'POST');
  assert.equal(checked.ok, true); assert.equal(f.calls.at(-1).authorization, 'Bearer ' + key);
});
