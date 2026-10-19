import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const extensions = source.slice(source.indexOf('  // Extension management:'), source.indexOf('  // End extension management.'));
const plain = value => JSON.parse(JSON.stringify(value));
const presetConfig = () => ({
  revision: 4,
  agents: [{ id: 'teacher', name: '老师', role: 'teacher' }, { id: 'student', name: '学生', role: 'student' }, { id: 'principal', name: '校长', role: 'principal' }],
  mcps: [{ id: 'custom-mcp', name: 'Custom MCP', transport: 'stdio', command: 'fixture-never-run', args: [], enabled: false, agentIds: [] }],
  skills: Array.from({ length: 29 }, (_, index) => ({
    id: 'preset-' + index, builtin: 'ctf-fixture-' + index, name: 'Skill ' + index,
    description: '说明 ' + index, content: '# Skill ' + index + '\n\n按需读取 references/example.md。', enabled: false, agentIds: [],
  })),
});

// Exercises the same browser handlers against an isolated API mock. No saved
// profiles, models, local MCP servers or third-party tools are involved.
function harness(value = presetConfig()) {
  const elements = new Map(), calls = [], opened = [], closed = [], notices = [];
  let stored = plain(value);
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false, checked: false, innerHTML: '', textContent: '', dataset: {}, options: [], reset() {}, getClientRects: () => [], setAttribute() {}, querySelectorAll() { return this.options; } });
    return elements.get(id);
  };
  const context = vm.createContext({
    $, state: { agents: value.agents, history: [], run: null }, stateEpoch:0, renderTaskModeOptions() {}, renderWorkspaceHistory() {}, AbortSignal, busy: false, live: () => false,
    token: 'isolated-skill-fixture', shutdown: false, shuttingDown: false, lastConnection: true, dataDirectorySaving: false, directoryPickerPending: false,
    document: { querySelectorAll: () => [], querySelector: () => null }, icon: name => `<svg data-icon="${name}"></svg>`,
    esc: value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])),
    async api(url, options) {
      if (url === '/api/modes') return { revision:0, items:[] };
      assert.equal(url, '/api/extensions');
      const body = plain(options.body); assert.equal(body.revision, stored.revision); calls.push(body);
      if (options.method === 'DELETE') { stored = { ...stored, [body.kind]:stored[body.kind].filter(item => !body.ids.includes(item.id)), revision:stored.revision + 1 }; return plain(stored); }
      assert.equal(options.method, 'PUT');
      stored = { ...body, revision: stored.revision + 1, agents: stored.agents };
      return plain(stored);
    },
    toast: (message, warning) => notices.push({ message, warning }), openDialog: id => opened.push(id), closeSavedDialog: id => closed.push(id),
    dialogSessions: new Map(), confirm: () => true, roleNames: { teacher: '老师', student: '学生', principal: '校长' }, requestAnimationFrame: work => work(),
  });
  vm.runInContext(extensions + '\nglobalThis.ui={acceptExtensions,renderExtensions,extensionConfiguration,openExtension,saveExtension,openExtensionGrant,saveExtensionGrant,toggleExtension,deleteExtension,confirmExtensionDeletion,select(...ids){for(const id of ids)extensionSelected.add(id);},tab(value){extensionTab=value;},data(){return extensionsData;}};', context);
  context.ui.acceptExtensions(plain(stored)); context.ui.tab('skills');
  return { $, ui: context.ui, calls, opened, closed, notices, stored: () => stored };
}

test('all 29 builtin Skills render through existing cards without becoming MCP presets', async () => {
  const value = presetConfig();
  value.skills[0].builtin = 'browser'; // Even an MCP-looking marker is still a Skill in this tab.
  value.skills[0].name = '<img src=x onerror="fixture()">';
  value.skills[0].description = '<script>fixture()</script>';
  const f = harness(value); f.ui.renderExtensions();
  const markup = f.$('extensions-content').innerHTML;
  assert.equal([...markup.matchAll(/<article\b/g)].length, 29);
  assert.equal([...markup.matchAll(/data-extension-edit=/g)].length, 29);
  assert.equal([...markup.matchAll(/data-extension-toggle=/g)].length, 29);
  assert.equal([...markup.matchAll(/data-extension-select=/g)].length, 29);
  assert.equal([...markup.matchAll(/已停用/g)].length, 29);
  assert.equal([...markup.matchAll(/尚未授权成员/g)].length, 29);
  assert.equal([...markup.matchAll(/data-icon="logs"/g)].length, 29);
  assert.doesNotMatch(markup, /data-extension-delete|data-extension-guide|data-extension-test|data-icon="browser"|extension-kind|MARKDOWN SKILL|<img|<script>/);
  assert.match(markup, /&lt;img/); assert.match(markup, /&lt;script&gt;/);
  for (const skill of value.skills) await f.ui.deleteExtension(skill.id);
  assert.equal(f.calls.length, 0, 'builtin deletion is blocked in the handler as well as hidden in the card');
  assert.deepEqual(plain(f.ui.extensionConfiguration().skills), value.skills);
});

test('every builtin Skill opens its exact Markdown and preserves its marker, state and grants after editing', async () => {
  const value = presetConfig();
  value.skills[0].enabled = true; value.skills[0].agentIds = ['teacher'];
  value.skills[28].content = '# Long skill\n\n' + 'paragraph\n'.repeat(1800) + '</textarea><script>fixture()</script>';
  const f = harness(value);
  for (const original of value.skills) {
    const before = plain(f.stored()); f.ui.openExtension(original.id);
    assert.equal(f.opened.at(-1), 'extension-dialog');
    assert.equal(f.$('extension-dialog-title').textContent, '编辑 Skill');
    assert.equal(f.$('extension-skill-fields').hidden, false); assert.equal(f.$('extension-mcp-fields').hidden, true);
    assert.equal(f.$('extension-content').value, original.content); assert.equal(f.$('extension-content').required, true);
    const content = original.content + '\n\n用户补充步骤。';
    f.$('extension-name').value = original.name + ' edited'; f.$('extension-description').value = 'Updated description'; f.$('extension-content').value = content;
    await f.ui.saveExtension();
    const saved = f.stored().skills.find(item => item.id === original.id);
    assert.equal(saved.builtin, original.builtin); assert.equal(saved.content, content); assert.equal(saved.name, original.name + ' edited');
    assert.equal(saved.description, 'Updated description'); assert.equal(saved.enabled, original.enabled); assert.deepEqual(saved.agentIds, original.agentIds);
    assert.deepEqual(f.stored().skills.filter(item => item.id !== original.id), before.skills.filter(item => item.id !== original.id));
    assert.deepEqual(f.stored().mcps, before.mcps); assert.equal(f.closed.at(-1), 'extension-dialog');
  }
  assert.equal(f.calls.length, 29); assert.equal(f.notices.some(item => item.warning), false);
});

test('toggle, batch grants and saving an unrelated MCP preserve all builtin Skill markers', async () => {
  const value = presetConfig(), f = harness(value);
  await f.ui.toggleExtension('preset-0'); assert.equal(f.stored().skills[0].enabled, true);
  assert.deepEqual(f.stored().skills[0].agentIds, [], 'enabling alone never grants Agents access');
  await f.ui.toggleExtension('preset-0'); assert.equal(f.stored().skills[0].enabled, false);
  f.ui.select('preset-0', 'preset-28'); f.ui.openExtensionGrant();
  assert.match(f.$('extension-grant-agents').innerHTML, /data-grant-agent="teacher"/);
  assert.match(f.$('extension-grant-agents').innerHTML, /data-grant-agent="student"/);
  assert.doesNotMatch(f.$('extension-grant-agents').innerHTML, /data-grant-agent="principal"/);
  f.$('extension-grant-agents').options = ['teacher', 'student'].map(id => ({ getAttribute: () => id }));
  await f.ui.saveExtensionGrant(); await f.ui.saveExtensionGrant();
  for (const item of f.stored().skills) {
    assert.equal(item.builtin, value.skills.find(original => original.id === item.id).builtin);
    assert.equal(item.enabled, false, 'authorization does not implicitly enable a Skill');
    assert.deepEqual(item.agentIds, ['preset-0', 'preset-28'].includes(item.id) ? ['teacher', 'student'] : []);
  }
  const before = plain(f.stored().skills);
  f.ui.tab('mcps'); f.ui.renderExtensions(); await f.ui.toggleExtension('custom-mcp');
  assert.equal(f.stored().mcps[0].enabled, true); assert.deepEqual(f.stored().skills, before);
});

test('legacy and newly added custom Skills retain normal editing and deletion without acquiring builtin markers', async () => {
  const value = presetConfig();
  value.skills.push({ id: 'legacy', name: value.skills[0].name, description: '', content: '# Custom', enabled: true, agentIds: ['student'] });
  const f = harness(value); f.ui.renderExtensions();
  assert.match(f.$('extensions-content').innerHTML, /data-extension-delete="legacy"/);
  assert.doesNotMatch(f.$('extensions-content').innerHTML, /extension-kind|MARKDOWN SKILL/);
  f.ui.openExtension('legacy'); f.$('extension-content').value = '# Custom changed'; await f.ui.saveExtension();
  const saved = f.stored().skills.find(item => item.id === 'legacy');
  assert.equal(Object.hasOwn(saved, 'builtin'), false); assert.deepEqual(saved.agentIds, ['student']); assert.equal(saved.enabled, true);
  await f.ui.deleteExtension('legacy'); assert.equal(f.stored().skills.length, 30); await f.ui.confirmExtensionDeletion(); assert.equal(f.stored().skills.length, 29);
  f.ui.openExtension(); f.$('extension-name').value = 'Skill 0'; f.$('extension-description').value = ''; f.$('extension-content').value = '# New custom';
  await f.ui.saveExtension();
  const added = f.calls.at(-1).skills.at(-1);
  assert.equal(Object.hasOwn(added, 'builtin'), false); assert.deepEqual(added.agentIds, []);
  for (const [index, item] of f.stored().skills.slice(0, 29).entries()) assert.equal(item.builtin, value.skills[index].builtin);
});
