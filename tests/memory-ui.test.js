import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const controller = app.slice(app.indexOf('  const memoryKinds ='), app.indexOf("  let agentsStamp='"));

function harness(api = async () => ({ items: [], total: 0, nextOffset: null })) {
  const elements = new Map(), notices = [], closedDialogs = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, checked: false, options: [], classes: new Set(), classList: { toggle(name, value) { value ? elements.get(id).classes.add(name) : elements.get(id).classes.delete(name); } }, querySelectorAll: () => [], add(option) { this.options.push(option); } });
    return elements.get(id);
  };
  const context = vm.createContext({ $, api, URLSearchParams, Date, console,
    state: { agents: [], dataDir: 'isolated-fixture' }, token: 'fixture', shutdown: false, shuttingDown: false, lastConnection: true, page: 'memory',
    document: { querySelector: () => null }, toast(message, warning) { notices.push({ message, warning }); }, openDialog() {}, dialogSessions: new Map(), closeSavedDialog(id) { closedDialogs.push(id); }, person: () => null, formatDate: value => value || '—', statusNames: {},
    text: value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value),
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
  });
  vm.runInContext(controller + `\nglobalThis.controller = {memoryRecordMarkup,memoryEntryMarkup,memorySourceMarkup,loadMemoryEntries,loadMemoryContext,memoryDeletionNotice,showMemoryDeletionNotice,refreshMemory,memorySetEntryStatus,saveMemorySettings,memoryActivity,requestMemoryJob,openMemoryEntry,
    status(value){memoryStatus=value;}, requested(value){memoryRequestedJob=value;}, context(value){memoryContext=value;}, closeContext(){memoryContextRequest++;memoryContext=null;}, views:memoryViews};`, context);
  context.controller.status({ enabled: true, available: true });
  return { $, ui: context.controller, notices, closedDialogs };
}

test('deleting with unavailable memory index reports unfinished cleanup instead of complete success', () => {
  const { $, ui, notices } = harness();
  const warning = '数据库恢复后继续清理，删除记录已保存。';
  const notice = ui.memoryDeletionNotice({ memoryCleanupPending: true, warning }, '会话及关联记忆已删除。');
  assert.equal(notice.pending, true);
  assert.match(notice.message, /索引清理尚未完成/);
  assert.ok(notice.message.includes(warning));
  assert.ok(!notice.message.includes('会话及关联记忆已删除'));
  ui.showMemoryDeletionNotice(notice);
  assert.equal(notices[0].warning, true);
  assert.equal($('memory-error').hidden, false);
  assert.equal($('memory-error').textContent, notice.message);
  assert.match(ui.memoryDeletionNotice({ memoryCleanupPending: true }, 'done').message, /恢复后/);
});

test('fully completed deletion keeps the ordinary success message', () => {
  const { $, ui, notices } = harness();
  const notice = ui.memoryDeletionNotice({ deleted: true }, '任务、讨论记录及关联记忆已清除。');
  ui.showMemoryDeletionNotice(notice);
  assert.equal(notice.pending, false);
  assert.equal(notice.message, '任务、讨论记录及关联记忆已清除。');
  assert.equal(notices[0].warning, false);
  assert.equal($('memory-error').textContent, '');
});

test('untrusted stored text and source references render literally instead of executable HTML', () => {
  const { ui } = harness();
  const attack = '<img src=x onerror="alert(1)">&';
  const record = ui.memoryRecordMarkup({ reference: attack, text: attack, role: attack });
  const memory = ui.memoryEntryMarkup({ id: attack, content: attack, status: 'active', sourceRefs: [attack, 'memory:' + attack], reviewReason: attack, reviewSourceRefs: [attack] });
  for (const markup of [record, memory]) {
    assert.ok(!markup.includes('<img'));
    assert.ok(markup.includes('&lt;img'));
    assert.ok(markup.includes('&quot;'));
  }
});

test('long-term memory search uses global types and preserves status and exact content while paginating', async () => {
  const calls = [], content = '第一行\n  第二行 <tag>';
  const { $, ui } = harness(async url => {
    calls.push(new URL(url, 'http://fixture'));
    return { items: [{ id: 'm-1', kind: 'agent', status: 'paused', content }], total: 41, offset: 20, nextOffset: 40 };
  });
  $('memory-entry-query').value = '关键字';
  $('memory-entry-status').value = 'paused';
  $('memory-entry-kind').value = 'agent';
  await ui.loadMemoryEntries(20);
  assert.equal(calls[0].pathname, '/api/memory/entries');
  assert.deepEqual(Object.fromEntries(calls[0].searchParams), { offset: '20', limit: '20', query: '关键字', status: 'paused', kind: 'agent' });
  assert.ok($('memory-entries-content').innerHTML.includes('第一行\n  第二行 &lt;tag&gt;'));
  assert.equal(ui.views.entries.nextOffset, 40);
  assert.equal($('memory-entries-page').textContent, '21–21 / 41');
  assert.ok($('memory-entries-content').innerHTML.includes('Agent画像'));
});

test('empty results have one simple message and no duplicate pagination label', async () => {
  const { $, ui } = harness(); await ui.loadMemoryEntries();
  assert.equal($('memory-entries-content').innerHTML, '<div class="memory-empty-message">暂无记录</div>');
  assert.ok($('memory-entries-content').classes.has('memory-empty'));
  assert.equal($('memory-entries-page').textContent, '');
  assert.equal($('memory-entries-prev').disabled, true);
  assert.equal($('memory-entries-next').disabled, true);
});

test('late memory search responses cannot overwrite a newer query', async () => {
  const pending = [];
  const { $, ui } = harness(() => new Promise(resolve => pending.push(resolve)));
  $('memory-entry-query').value = 'old'; const oldRequest = ui.loadMemoryEntries();
  $('memory-entry-query').value = 'new'; const newRequest = ui.loadMemoryEntries();
  pending[1]({ items: [{ id: 'new', content: 'new result' }], total: 1, nextOffset: null }); await newRequest;
  pending[0]({ items: [{ id: 'old', content: 'old result' }], total: 1, nextOffset: null }); await oldRequest;
  assert.ok($('memory-entries-content').innerHTML.includes('new result'));
  assert.ok(!$('memory-entries-content').innerHTML.includes('old result'));
});

test('memory landing page loads only long-term entries and settings without eager session history requests', async () => {
  const calls = [];
  const { ui } = harness(async url => {
    calls.push(url);
    return url === '/api/memory/status' ? { enabled: true, memories: 0, jobs: [] } : { items: [], total: 0 };
  });
  await ui.refreshMemory(true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], '/api/memory/status');
  assert.ok(calls[1].startsWith('/api/memory/entries?'));
  const main = html.slice(html.indexOf('id="page-memory"'), html.indexOf('</main>'));
  assert.ok(main.includes('id="memory-entries-panel"'));
  assert.ok(!main.includes('memory-sessions-'));
  assert.ok(!main.includes('memory-settings-form'));
  assert.ok(main.indexOf('id="memory-settings-button"') < main.indexOf('id="memory-refresh"'));
  assert.ok(html.includes('<dialog closedby="none" id="memory-settings-dialog"'));
  assert.ok(!html.includes('memory-auto-extract'));
  assert.ok(!html.includes('候选'));
  for (const removed of ['memory-entry-project','memory-edit-project','memory-project-note','memory-add','memory-export','memory-rebuild','memory-jobs']) assert.ok(!html.includes(`id="${removed}"`), removed);
  assert.ok(!html.includes('新增记忆'));
  assert.ok(html.includes('全部类型'));
  const settings = html.slice(html.indexOf('id="memory-settings-dialog"'), html.indexOf('id="memory-entry-dialog"'));
  assert.ok(settings.indexOf('id="memory-state"') < settings.indexOf('aria-label="关闭记忆设置"'));
  assert.ok(!settings.includes('<h3>'));
});

test('entry lifecycle actions pause and enable through the new statuses and display pre-use evaluation carefully', async () => {
  const changes = [];
  const { ui } = harness(async (url, options) => {
    if (options?.method === 'PUT') changes.push({ url, body: JSON.parse(JSON.stringify(options.body)) });
    return url === '/api/memory/status' ? { currentProjectId: 'fixture-project', enabled: true } : { items: [], total: 0 };
  });
  const markup = ui.memoryEntryMarkup({ id: 'm-1', status: 'active', content: '历史结论', reviewVerdict: 'usable', reviewReason: '与当前任务相关', reviewedAt: '2026-09-26T08:00:00.000Z' });
  assert.match(markup, /data-memory-status="paused">暂停/);
  assert.match(markup, /最近使用前评估：可参考 · 与当前任务相关/);
  assert.ok(!markup.includes('已验证'));
  assert.match(ui.memoryEntryMarkup({ id: 'm-1', status: 'paused' }), /data-memory-status="active">启用/);
  for (const oldStatus of ['expired','superseded']) assert.match(ui.memoryEntryMarkup({ id: 'old', kind: 'user', status: oldStatus }), /memory-status invalid">已失效/);
  await ui.memorySetEntryStatus('m-1', 'paused');
  await ui.memorySetEntryStatus('m-1', 'active');
  assert.deepEqual(changes, [{ url: '/api/memory/entries/m-1', body: { status: 'paused' } }, { url: '/api/memory/entries/m-1', body: { status: 'active' } }]);
});

test('the settings badge reports the current job once and distinguishes extraction from reflection', () => {
  const { ui } = harness(), base = { enabled: true, available: true };
  const oldFailure = { id: 'old', type: 'reflect', status: 'failed', error: 'old failure' };
  assert.equal(ui.memoryActivity({ ...base, jobs: [oldFailure, { id: 'new', type: 'extract', status: 'running' }] }).label, '会话整理中');
  assert.equal(ui.memoryActivity({ ...base, jobs: [oldFailure, { id: 'new', type: 'reflect', status: 'running' }] }).label, '记忆整理中');
  assert.equal(ui.memoryActivity({ ...base, jobs: [oldFailure, { id: 'new', status: 'completed' }] }).label, '整理成功');
  assert.equal(ui.memoryActivity({ ...base, jobs: [{ id: 'retried-old', status: 'completed', createdAt: '2026-09-01T00:00:00Z', finishedAt: '2026-09-26T01:00:00Z' }, { id: 'old-failure', status: 'failed', createdAt: '2026-09-25T00:00:00Z', finishedAt: '2026-09-25T01:00:00Z' }] }).label, '整理成功', 'a retried earlier job is ordered by its latest activity');
  const failed = ui.memoryActivity({ ...base, jobs: [{ id: 'new', status: 'failed', error: 'specific failure' }] });
  assert.equal(failed.label, '整理失败'); assert.equal(failed.detail, 'specific failure');
  assert.equal(ui.memoryActivity({ ...base, jobs: [{ status: 'pending', notice: '等待配置可用的老师模型' }] }).label, '等待模型配置');
  assert.equal(ui.memoryActivity({ ...base, jobs: [] }).label, '已启用');
  assert.equal(ui.memoryActivity({ ...base, enabled: false, jobs: [oldFailure] }).label, '已关闭');
  ui.requested({ type: 'reflect', status: 'pending' });
  assert.equal(ui.memoryActivity({ ...base, jobs: [oldFailure] }).label, '等待记忆整理');
});

test('completed manual jobs stop overriding a later automatic result', async () => {
  const { ui } = harness(async url => url === '/api/memory/status' ? { enabled: true, jobs: [{ id: 'manual', type: 'reflect', status: 'failed', finishedAt: '2026-09-25T00:00:00Z' }] } : { items: [], total: 0 });
  ui.requested({ id: 'manual', type: 'reflect', status: 'pending' });
  await ui.refreshMemory(true);
  assert.equal(ui.memoryActivity({ enabled: true, jobs: [{ id: 'auto', type: 'extract', status: 'completed', finishedAt: '2026-09-26T00:00:00Z' }] }).label, '整理成功');
});

test('manual reflection is global and editing never opens an empty creation form', async () => {
  const writes = [], calls = [];
  const { ui } = harness(async (url, options) => {
    calls.push(url);
    if (options?.method === 'POST') { writes.push(JSON.parse(JSON.stringify(options.body))); return { id: 'current-job', type: 'reflect', status: 'pending' }; }
    return url === '/api/memory/status' ? { enabled: true, jobs: [] } : { items: [], total: 0 };
  });
  await ui.openMemoryEntry(); assert.deepEqual(calls, []);
  await ui.requestMemoryJob('reflect');
  assert.deepEqual(writes, [{ type: 'reflect' }]);
  assert.ok(calls.every(url => !url.includes('projectId')));
});

test('settings submit only the master switch and close only after a successful save', async () => {
  const writes = [];
  let fail = true;
  const { $, ui, closedDialogs } = harness(async (url, options) => {
    if (url === '/api/memory/settings') {
      writes.push(JSON.parse(JSON.stringify(options.body)));
      if (fail) throw new Error('isolated save failure');
    }
    return url === '/api/memory/status' ? { currentProjectId: 'fixture-project', enabled: true } : { items: [], total: 0 };
  });
  $('memory-enabled').checked = false;
  await ui.saveMemorySettings(); assert.deepEqual(closedDialogs, []);
  fail = false; $('memory-enabled').checked = false;
  await ui.saveMemorySettings();
  assert.deepEqual(writes, [{ enabled: false }, { enabled: false }]);
  assert.deepEqual(closedDialogs, ['memory-settings-dialog']);
});

test('opaque source references resolve through the source API and a closed detail discards its response', async () => {
  let resolve, called;
  const { $, ui } = harness(url => { called = url; return new Promise(done => { resolve = done; }); });
  ui.context({ id: '', reference: 'opaque/ref:with spaces#2', offset: 0, loading: false });
  const request = ui.loadMemoryContext();
  const url = new URL(called, 'http://fixture');
  assert.equal(url.pathname, '/api/memory/source');
  assert.equal(url.searchParams.get('reference'), 'opaque/ref:with spaces#2');
  assert.equal(url.searchParams.has('offset'), false, 'the server must choose the page around the cited source');
  ui.closeContext();
  resolve({ session: { id: 'resolved-session' }, items: [{ text: 'must not reappear' }], total: 1 });
  await request;
  assert.equal($('memory-context-content').innerHTML, '');
});
