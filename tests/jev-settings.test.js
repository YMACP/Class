import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createClassServer } from '../src/web-server.js';
import { createProfileStore, JUDGE_SECRET_ID } from '../src/profile-store.js';
import { loadSecrets } from '../src/secret-store.js';
import { DEFAULT_JUDGE_CONFIG } from '../src/judge-config.js';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'class-jev-settings-'));
  const dataDir = path.join(root, 'source'), token = 'jev-fixture-' + randomUUID();
  const resources = [];
  t.after(async () => {
    for (const close of resources.reverse()) await close();
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('class-jev-settings-'));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  async function server(directory = dataDir) {
    const app = await createClassServer({ dataDir: directory, dataAnchor: dataDir, token });
    resources.push(() => app.close());
    return { ...app, async api(endpoint, method = 'GET', body, status = 200) {
      const response = await fetch(app.url + endpoint, { method, headers: { Authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      assert.equal(response.status, status, endpoint + ': ' + JSON.stringify(value));
      return value;
    } };
  }
  async function mock(handler) {
    const requests = [];
    const host = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
      requests.push(request); handler(request, res);
    });
    await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
    resources.push(() => new Promise((resolve, reject) => { host.close(error => error ? reject(error) : resolve()); host.closeAllConnections(); }));
    return { url: 'http://127.0.0.1:' + host.address().port, requests };
  }
  return { root, dataDir, server, mock };
}

test('legacy profiles gain disabled Jev defaults and keep independent encrypted credentials', async t => {
  const f = await fixture(t), store = await createProfileStore(f.dataDir);
  const legacy = { ...store.config }; delete legacy.judge;
  await fs.writeFile(path.join(f.dataDir, 'profiles.json'), JSON.stringify(legacy));
  const old = await createProfileStore(f.dataDir);
  assert.equal(old.config.judge.enabled, false);
  assert.equal(Object.hasOwn(old.config.judge, 'mode'), false);
  assert.deepEqual(old.config.judge.features, { taskDispatch: false, toolCalls: false, toolResults: true, submissionReview: true });
  await old.save(old.config, { teacher: 'fixture-existing-model-key' });
  const app = await f.server();
  const saved = await app.api('/api/judge', 'PUT', { enabled: true, apiKey: 'fixture-independent-jev-key', features: { toolCalls: true } });
  assert.equal(saved.judge.hasApiKey, true);
  assert.equal(saved.judge.features.toolCalls, true);
  assert.equal(Object.hasOwn(saved.judge, 'apiKey'), false);
  const profile = await fs.readFile(path.join(f.dataDir, 'profiles.json'), 'utf8');
  assert.ok(!profile.includes('fixture-independent-jev-key'));
  assert.ok(!profile.includes('fixture-existing-model-key'));
  assert.equal(Object.hasOwn(JSON.parse(profile).judge, 'apiKey'), false);
  assert.equal(Object.hasOwn(JSON.parse(profile).judge, 'hasApiKey'), false);
  assert.equal(Object.hasOwn(JSON.parse(profile).judge, 'mode'), false);
  const state = await app.api('/api/state');
  assert.ok(!JSON.stringify(state).includes('fixture-independent-jev-key'));
  assert.ok(!JSON.stringify(state).includes('fixture-existing-model-key'));
  assert.deepEqual(await loadSecrets(f.dataDir), { teacher: 'fixture-existing-model-key', [JUDGE_SECRET_ID]: 'fixture-independent-jev-key' });
  await app.api('/api/judge', 'PUT', { mode: 'active', apiKey: '' });
  assert.equal(Object.hasOwn((await app.api('/api/judge')).judge, 'mode'), false);
  await app.api('/api/judge', 'PUT', { timeoutMs: 1 }, 400);
  await app.api('/api/judge', 'PUT', { clearKey: true }, 400);
  assert.equal((await app.api('/api/judge')).judge.hasApiKey, true);
  const cleared = await app.api('/api/judge', 'PUT', { enabled: false, clearKey: true }, 400);
  assert.equal(cleared.error, '尚未配置Jev密钥');
  assert.deepEqual(await loadSecrets(f.dataDir), { teacher: 'fixture-existing-model-key', [JUDGE_SECRET_ID]: 'fixture-independent-jev-key' });
  assert.equal((await app.api('/api/judge')).judge.hasApiKey, true);
});

test('legacy enabled observation settings retain their switch, key and four selections without a mode', async t => {
  for (const mode of ['shadow', 'active']) {
    const f = await fixture(t), store = await createProfileStore(f.dataDir);
    const features = { taskDispatch: true, toolCalls: false, toolResults: false, submissionReview: true };
    await store.save(store.config, { teacher: 'fixture-legacy-teacher-key', [JUDGE_SECRET_ID]: 'fixture-legacy-judge-key' });
    await fs.writeFile(path.join(f.dataDir, 'profiles.json'), JSON.stringify({ ...store.config, judge: { ...store.config.judge, enabled: true, mode, features } }));
    const app = await f.server(), config = (await app.api('/api/judge')).judge;
    assert.equal(config.enabled, true); assert.equal(config.hasApiKey, true);
    assert.equal(Object.hasOwn(config, 'mode'), false); assert.deepEqual(config.features, features);
    await app.api('/api/judge', 'PUT', { mode: 'shadow' });
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'profiles.json'), 'utf8')).judge;
    assert.equal(Object.hasOwn(saved, 'mode'), false); assert.equal(saved.enabled, true);
    assert.deepEqual(saved.features, features);
    assert.deepEqual(await loadSecrets(f.dataDir), { teacher: 'fixture-legacy-teacher-key', [JUDGE_SECRET_ID]: 'fixture-legacy-judge-key' });
  }
});

test('enabling requires an independent key and each judgment selection persists independently', async t => {
  const f = await fixture(t), store = await createProfileStore(f.dataDir);
  await store.save(store.config, { teacher: 'fixture-only-model-key' });
  const app = await f.server();
  for (const enabled of [true, false]) {
    const rejected = await app.api('/api/judge', 'PUT', { enabled }, 400);
    assert.equal(rejected.error, '尚未配置Jev密钥');
  }
  assert.equal((await app.api('/api/judge')).judge.enabled, false);
  const features = { taskDispatch: false, toolCalls: false, toolResults: false, submissionReview: false };
  await app.api('/api/judge', 'PUT', { enabled: true, apiKey: 'fixture-independent-key', features });
  for (const feature of Object.keys(features)) {
    const result = await app.api('/api/judge', 'PUT', { features: { [feature]: true } });
    features[feature] = true;
    assert.deepEqual(result.judge.features, features);
    assert.equal(result.judge.enabled, true); assert.equal(Object.hasOwn(result.judge, 'mode'), false);
  }
  await app.api('/api/judge', 'PUT', { enabled: false });
  assert.deepEqual((await app.api('/api/judge')).judge.features, features);
  await app.close(); const restarted = await f.server();
  assert.deepEqual((await restarted.api('/api/judge')).judge.features, features);
});

test('connection checks use draft Jev credentials and fixed System One model without saving', async t => {
  const f = await fixture(t), store = await createProfileStore(f.dataDir);
  await store.save(store.config, { teacher: 'fixture-model-secret', [JUDGE_SECRET_ID]: 'fixture-saved-judge-secret' });
  const before = await fs.readFile(path.join(f.dataDir, 'profiles.json'), 'utf8');
  const mock = await f.mock((_request, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ answers: { ready: { type: 'noul', noul: 0.99 } } }));
  });
  const app = await f.server();
  const checked = await app.api('/api/judge/check', 'POST', { baseUrl: mock.url, apiKey: 'fixture-unsaved-key', enabled: false });
  assert.equal(checked.ok, true);
  assert.equal(mock.requests[0].authorization, 'Bearer fixture-unsaved-key');
  assert.equal(mock.requests[0].url, '/v1/systemone');
  assert.equal(mock.requests[0].body.model, 'jev-latest');
  assert.equal(mock.requests[0].body.questions.ready.type, 'noul');
  assert.equal((await app.api('/api/judge/check', 'POST', { protocol: 'openai', model: 'fixture-custom-model', baseUrl: mock.url + '/v1' })).ok, true);
  assert.equal(mock.requests[1].authorization, 'Bearer fixture-saved-judge-secret');
  assert.equal(mock.requests[1].url, '/v1/systemone');
  assert.equal(mock.requests[1].body.model, 'jev-latest');
  assert.equal(Object.hasOwn(mock.requests[1].body, 'messages'), false);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'profiles.json'), 'utf8'), before);
  assert.deepEqual(await loadSecrets(f.dataDir), { teacher: 'fixture-model-secret', [JUDGE_SECRET_ID]: 'fixture-saved-judge-secret' });
});

test('failed connection checks return bounded safe statuses and never expose remote error bodies', async t => {
  const f = await fixture(t), mock = await f.mock(({ url }, res) => {
    if (url === '/timeout') return;
    res.writeHead(url === '/auth' ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'fixture-test-secret private-model-body' }));
  }), app = await f.server();
  for (const [route, expected] of [['auth', 'auth'], ['invalid', 'invalid'], ['timeout', 'timeout']]) {
    const result = await app.api('/api/judge/check', 'POST', { baseUrl: mock.url + '/' + route, apiKey: 'fixture-test-secret', timeoutMs: 100 });
    assert.equal(result.ok, false); assert.equal(result.status, expected);
    assert.ok(!JSON.stringify(result).includes('fixture-test-secret'));
    assert.ok(!JSON.stringify(result).includes('private-model-body'));
  }
  assert.equal((await app.api('/api/judge')).judge.hasApiKey, false);
});

test('failed profile publication restores old Jev and model keys before returning failure', async t => {
  const f = await fixture(t), store = await createProfileStore(f.dataDir);
  const oldKeys = { teacher: 'fixture-teacher-key', [JUDGE_SECRET_ID]: 'fixture-before-key' };
  await store.save(store.config, oldKeys);
  const before = await fs.readFile(path.join(f.dataDir, 'profiles.json'), 'utf8');
  const originalOpen = fs.open;
  fs.open = async function (filename, ...args) {
    const file = await originalOpen.call(this, filename, ...args);
    if (typeof filename === 'string' && filename.startsWith(path.join(f.dataDir, 'profiles.json.')) && filename.endsWith('.tmp')) {
      file.sync = async () => { throw Object.assign(new Error('isolated publication failure'), { code: 'EIO' }); };
    }
    return file;
  };
  try {
    await assert.rejects(store.save({ ...store.config, judge: { ...store.config.judge, enabled: true } }, { ...oldKeys, [JUDGE_SECRET_ID]: 'fixture-after-key' }), /isolated publication failure/);
  } finally { fs.open = originalOpen; }
  assert.equal(store.config.judge.enabled, false);
  assert.deepEqual(store.secrets, oldKeys);
  assert.deepEqual(await loadSecrets(f.dataDir), oldKeys);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'profiles.json'), 'utf8'), before);
  assert.ok(!(await fs.readdir(f.dataDir)).some(name => name.endsWith('.tmp')));
});

test('Jev settings and independent keys survive normal directory migration and restart; demo never calls Jev', async t => {
  const f = await fixture(t), mock = await f.mock((_req, res) => { res.end('{}'); });
  let app = await f.server();
  await app.api('/api/judge', 'PUT', { enabled: true, baseUrl: mock.url, apiKey: 'fixture-migrated-judge-key' });
  const started = await app.api('/api/runs', 'POST', { demo: true }, 202);
  let state;
  for (let attempt = 0; attempt < 200; attempt++) {
    state = await app.api('/api/state');
    if (!['running', 'stopping'].includes(state.run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(state.run.status, 'completed');
  assert.equal(state.run.judgeStats.enabled, false);
  assert.equal(state.run.judgeStats.requests, 0);
  assert.equal(mock.requests.length, 0);
  const destination = path.join(f.root, 'destination');
  await app.api('/api/data-directory', 'PUT', { path: destination });
  await app.close(); app = await f.server(destination);
  const config = (await app.api('/api/judge')).judge;
  assert.equal(config.enabled, true); assert.equal(Object.hasOwn(config, 'mode'), false); assert.equal(config.hasApiKey, true);
  assert.equal((await loadSecrets(destination))[JUDGE_SECRET_ID], 'fixture-migrated-judge-key');
  const run = (await app.api('/api/runs/' + started.run.id)).run;
  assert.equal(run.judgeStats.enabled, false); assert.equal(run.judgeStats.requests, 0);
});

const appSource = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const judgeController = appSource.slice(appSource.indexOf('  function judgeStatus('), appSource.indexOf('  function renderTeam('));
function uiHarness(api, overrides = {}) {
  const elements = new Map(), notices = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, disabled: false, open: false, hidden: false, textContent: '', dataset: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; },
      classList: { toggle() {} }, reportValidity: () => true, reset() {}, close() { this.open = false; } });
    return elements.get(id);
  };
  const context = vm.createContext({ $, api, AbortController, document: { querySelector: () => null },
    judgeBusy: false, judgeCheckController: null, busy: false, stateEpoch: 0,
    state: { judge: { ...structuredClone(DEFAULT_JUDGE_CONFIG), hasApiKey: true, ...overrides } },
    selectedRun: () => context.selected, dialogSessions: new Map(), updateControls() {},
    openDialog(id, trigger) { $(id).open = true; context.returnFocus = trigger; context.dialogSessions.set($(id), randomUUID()); },
    closeSavedDialog(id, session) { if ($(id).open && context.dialogSessions.get($(id)) === session) { $(id).close(); return true; } return false; },
    toast(message) { notices.push(message); }
  });
  vm.runInContext(judgeController + '\nglobalThis.ui={openJudgeSettings,judgeSettingsBody,saveJudgeSettings,checkJudgeConnection,renderJudgeStats,judgeFeatureVisibility,setJudgeEnabled};', context);
  context.ui.openJudgeSettings();
  return { $, context, ui: context.ui, notices };
}

test('Jev UI has a two-button switch and shows four preserved selections only after enabling with a key', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="judge-mode"|id="judge-enabled"|id="judge-protocol"|id="judge-model"|观察 · 仅统计|应用 · 辅助判断|judge-run-potential|judge-clear-key|judge-url-help|配置密钥并启用后|使用 Typesafe System One 地址|对新任务生效；正在运行的任务保持原设置|留空保留已保存的密钥/);
  assert.match(html, /id="judge-enable"[^>]*type="button"[^>]*aria-pressed="false">启用<\/button><button id="judge-disable"[^>]*type="button"[^>]*aria-pressed="true">停用/);
  assert.match(html, />Jev密钥 /); assert.match(html, /placeholder="输入Jev密钥"/);
  assert.match(html, /<fieldset id="judge-features"[^>]*hidden disabled>/);
  const progressHeader = html.slice(html.indexOf('<section class="card progress-card">'), html.indexOf('id="workflow"'));
  assert.match(progressHeader, /id="settings-button"[\s\S]*id="judge-settings-button"[^>]*class="workspace-icon-button"[^>]*aria-label="Jev设置"[^>]*title="Jev设置"/);
  assert.equal((html.match(/id="judge-settings-button"/g) || []).length, 1);
  const runSettings = html.slice(html.indexOf('id="settings-dialog"'), html.indexOf('id="judge-settings-dialog"'));
  assert.doesNotMatch(runSettings, /id="judge-settings-button"/);
  assert.doesNotMatch(html, /Jev 判断设置|Jev 设置/);
  assert.doesNotMatch(appSource, /judge-clear-key|judgeProtocolHelp|judge-url-help|judge-protocol|judge-model/);
  const h = uiHarness(async () => ({}), { protocol: 'openai', model: 'fixture-stale-model' });
  assert.equal(h.context.returnFocus, h.$('judge-settings-button'));
  assert.equal(h.$('judge-features').hidden, true);
  for (const saved of [false, true]) for (const enabled of [false, true]) for (const draft of ['', 'fixture-new-key']) {
    h.$('judge-settings-form').dataset.hasApiKey = String(saved);
    h.$('judge-key').value = draft; h.ui.setJudgeEnabled(enabled);
    const expected = enabled && Boolean(saved || draft);
    assert.equal(h.$('judge-enable').getAttribute('aria-pressed'), String(enabled));
    assert.equal(h.$('judge-disable').getAttribute('aria-pressed'), String(!enabled));
    assert.equal(h.$('judge-features').hidden, !expected, JSON.stringify({ saved, enabled, draft: Boolean(draft) }));
    assert.equal(h.$('judge-features').disabled, !expected);
    h.ui.judgeFeatureVisibility(true); assert.equal(h.$('judge-features').disabled, true);
  }
  for (let mask = 0; mask < 16; mask++) {
    const features = {};
    [['taskDispatch','task-dispatch'],['toolCalls','tool-calls'],['toolResults','tool-results'],['submissionReview','submission-review']].forEach(([feature,id], index) => {
      features[feature] = h.$('judge-' + id).checked = Boolean(mask & 1 << index);
    });
    h.ui.setJudgeEnabled(false);
    const body = h.ui.judgeSettingsBody();
    assert.equal(body.protocol, 'system-one'); assert.equal(body.model, 'jev-latest');
    assert.equal(Object.hasOwn(body, 'mode'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(body.features)), features);
    h.ui.setJudgeEnabled(true);
    assert.deepEqual(JSON.parse(JSON.stringify(h.ui.judgeSettingsBody().features)), features);
  }
});

test('Jev settings reject a missing key while keeping the dialog and unsaved switch open', async () => {
  let calls = 0;
  const h = uiHarness(async () => { calls++; return {}; }, { hasApiKey: false });
  for (const enabled of [false, true]) {
    h.ui.setJudgeEnabled(enabled); h.$('judge-key').value = '  ';
    await h.ui.saveJudgeSettings();
    assert.equal(calls, 0);
    assert.equal(h.$('judge-settings-dialog').open, true);
    assert.equal(h.$('judge-check-status').textContent, '尚未配置Jev密钥');
    assert.equal(h.context.state.judge.enabled, false);
    assert.equal(h.ui.judgeSettingsBody().enabled, enabled);
  }
});

test('Jev switch is a draft until save and blank key input preserves the stored credential', async () => {
  const calls = [];
  const h = uiHarness(async (url, options) => {
    calls.push({ url, options });
    return { judge: { ...DEFAULT_JUDGE_CONFIG, ...options.body, hasApiKey: true } };
  });
  h.ui.setJudgeEnabled(true);
  assert.equal(h.context.state.judge.enabled, false); assert.equal(calls.length, 0);
  h.$('judge-settings-dialog').close(); h.ui.openJudgeSettings();
  assert.equal(h.ui.judgeSettingsBody().enabled, false);
  assert.equal(h.$('judge-disable').getAttribute('aria-pressed'), 'true');
  h.ui.setJudgeEnabled(true); h.$('judge-key').value = '  ';
  await h.ui.saveJudgeSettings();
  assert.equal(calls.length, 1); assert.equal(calls[0].options.body.enabled, true);
  assert.equal(Object.hasOwn(calls[0].options.body, 'apiKey'), false);
  assert.equal(Object.hasOwn(calls[0].options.body, 'clearKey'), false);
  assert.equal(h.context.state.judge.enabled, true);
  assert.equal(h.$('judge-settings-dialog').open, false);
  h.ui.openJudgeSettings();
  assert.equal(h.$('judge-enable').getAttribute('aria-pressed'), 'true');
  assert.equal(h.$('judge-key').placeholder, '输入Jev密钥');
  h.ui.setJudgeEnabled(false); h.$('judge-settings-dialog').close(); h.ui.openJudgeSettings();
  assert.equal(h.ui.judgeSettingsBody().enabled, true);
  h.$('judge-key').value = '  fixture-replacement-key  ';
  await h.ui.saveJudgeSettings();
  assert.equal(calls[1].options.body.apiKey, 'fixture-replacement-key');
  assert.equal(h.$('judge-key').value, '');
});

test('Jev settings UI tests unsaved fields, preserves errors, and only closes after successful save', async () => {
  const calls = []; let rejectSave = true;
  const h = uiHarness(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/check')) return { ok: true, message: '测试成功' };
    if (rejectSave) throw new Error('保存失败');
    return { judge: { ...DEFAULT_JUDGE_CONFIG, hasApiKey: true } };
  });
  h.$('judge-key').value = 'fixture-ui-unsaved-key';
  await h.ui.checkJudgeConnection();
  assert.equal(calls[0].url, '/api/judge/check');
  assert.equal(calls[0].options.body.apiKey, 'fixture-ui-unsaved-key');
  assert.equal(Object.hasOwn(calls[0].options.body, 'mode'), false);
  assert.equal(h.$('judge-settings-dialog').open, true);
  assert.equal(h.$('judge-check-status').textContent, '测试成功');
  await h.ui.saveJudgeSettings();
  assert.equal(h.$('judge-settings-dialog').open, true);
  assert.equal(h.$('judge-key').value, 'fixture-ui-unsaved-key');
  assert.equal(h.$('judge-check-status').textContent, '保存失败');
  rejectSave = false; await h.ui.saveJudgeSettings();
  assert.equal(h.$('judge-settings-dialog').open, false);
  assert.equal(h.$('judge-key').value, '');
  assert.equal(h.context.stateEpoch, 1);
});

test('late connection replies cannot update closed dialogs and stats follow the selected task', async () => {
  let finish;
  const h = uiHarness(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.ui.checkJudgeConnection();
  h.$('judge-settings-dialog').close(); h.context.judgeCheckController.abort();
  h.$('judge-check-status').textContent = 'new view';
  finish({ ok: true, message: 'late reply' }); await pending;
  assert.equal(h.$('judge-check-status').textContent, 'new view');
  h.context.selected = { judgeStats: { enabled: true, mode: 'shadow', requests: 3, timeouts: 1, failures: 1, unclear: 1, potentialSavedChars: 900, savedChars: 0, totalLatencyMs: 1400, inputTokens: 900, outputTokens: 30 } };
  h.ui.renderJudgeStats();
  assert.equal(h.$('judge-run-requests').textContent, '3');
  assert.equal(h.$('judge-run-timeouts').textContent, '1');
  assert.equal(h.$('judge-run-saved').textContent, '0');
  assert.equal(h.$('judge-run-fallbacks').textContent, '2');
  assert.equal(h.$('judge-run-usage').hidden, false);
  assert.equal(h.$('judge-run-status').textContent, '历史任务：仅统计，未应用判断');
  h.context.selected = { judgeStats: { enabled: true, savedChars: 400 } }; h.ui.renderJudgeStats();
  assert.equal(h.$('judge-run-status').textContent, '已启用 · 按所选环节应用');
  assert.equal(h.$('judge-run-saved').textContent, '400');
  h.context.selected = { judgeStats: { enabled: true, mode: 'active' } }; h.ui.renderJudgeStats();
  assert.equal(h.$('judge-run-status').textContent, '已启用 · 按所选环节应用');
  h.context.selected = { judgeStats: { enabled: false } }; h.ui.renderJudgeStats();
  assert.equal(h.$('judge-run-status').textContent, '本次任务未启用 Jev');
  h.context.selected = null; h.ui.renderJudgeStats();
  assert.equal(h.$('judge-run-stats').hidden, true);
});
