import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { ensureBuiltinMcpPresets, extensionSecrets, normalizeExtensions, prepareExtensionUpdate, publicExtensions } from '../src/extension-config.js';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const extensions = source.slice(source.indexOf('  // Extension management:'), source.indexOf('  // End extension management.'));
const recovery = source.slice(source.indexOf('  async function resumeRun('), source.indexOf('  async function retryMember('));
function harness(api = async () => {}) {
  const elements = new Map(), notices = [], closed = [], opened = [], calls = [];
  const $ = id => { assert.ok(!['extension-enabled', 'extension-agent-choices'].includes(id), 'Removed editor control must not be used: ' + id); if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false, checked: false, innerHTML: '', textContent: '', options: [], dataset: {}, reset() {}, getClientRects: () => [], setAttribute() {}, querySelectorAll() { return this.options; } }); return elements.get(id); };
  const state = { agents: [], history: [], run: null };
  const context = vm.createContext({ $, state, AbortSignal, busy: false, live: () => state.run?.status === 'running', token: 'fixture', shutdown: false, shuttingDown: false, lastConnection: true, dataDirectorySaving: false, directoryPickerPending: false,
    document: { querySelectorAll: () => [], querySelector: () => null }, icon: name => `<svg data-icon="${name}"></svg>`, esc: value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])),
    api: async (...args) => { calls.push(args); return api(...args); }, toast: (message, warning) => notices.push({ message, warning }), closeSavedDialog: id => closed.push(id), dialogSessions: new Map(), openDialog: id => opened.push(id), confirm: () => true,
    selectedRun: () => state.run, conversationRecord:id=>context.state.run?.id===id?context.state.run:null, acceptRun:run=>{context.state={...context.state,run};}, action: work => work(), stateEpoch: 0, viewingRun: null, rememberViewingRun() {}, fillTaskInput() {}, navigate() {}, render() {}, renderTaskModeOptions() {}, renderWorkspaceHistory() {}, roleNames: {}, requestAnimationFrame: work => work() });
  vm.runInContext(extensions + recovery + `\nglobalThis.ui={acceptExtensions,renderExtensions,extensionControls,testExtensionConnection,extensionConfiguration,extensionSecretInput,openExtensionGrant,saveExtensionGrant,toggleExtension,deleteExtension,confirmExtensionDeletion,resumeRun,parseExtensionArgs,formatExtensionArgs,chooseExtensionTransport,openExtension,openExtensionGuide,saveExtension,select(...ids){for(const id of ids)extensionSelected.add(id);},tab(value){extensionTab=value;},data(){return extensionsData;}};`, context);
  return { $, ui: context.ui, notices, closed, opened, calls, state, context };
}
const config = () => ({ revision: 7, agents: [{ id: 'teacher', name: '老师', role: 'teacher' }, { id: 'alice', name: '甲', role: 'student' }], mcps: [{ id: 'a', name: '工具', transport: 'stdio', command: 'fixture', args: [], enabled: true, agentIds: ['teacher'], envKeys: ['KEY'] }, { id: 'b', name: '工具乙', transport: 'http', url: 'http://127.0.0.1:1/mcp', enabled: true, agentIds: [] }], skills: [{ id: 's', name: '技能', description: '', content: '# 步骤', enabled: true, agentIds: ['teacher'], mcpIds: ['a'] }] });
const builtinConfig = () => {
  const value = config();
  value.mcps.push({ id: 'reserved-browser-42', name: '自定义浏览器名称', transport: 'stdio', command: 'Class', args: ['--browser-mcp'], builtin: 'browser', enabled: false, agentIds: [] });
  return value;
};
const burpConfig = () => {
  const value = builtinConfig();
  value.mcps.push({ id: 'reserved-burp-42', name: 'burpsuite', builtin: 'burpsuite', transport: 'sse', url: 'http://127.0.0.1:9876', skipTlsVerify: false, enabled: false, agentIds: [] });
  return value;
};
const reversePresets = [
  ['tscan', 'http://127.0.0.1:8088/mcp', '综合性Web安全分析工具'],
  ['jadx', 'http://127.0.0.1:8651/mcp', 'Android反编译与代码分析工具'],
  ['x64dbg', 'http://127.0.0.1:9094/', '对Windows程序进行动态调试'],
  ['ida', 'http://127.0.0.1:8737/mcp', '反汇编与反编译二进制程序'],
  ['ghidra', 'http://127.0.0.1:8081/mcp', '分析二进制程序与反编译代码'],
  ['gdb', 'http://127.0.0.1:8000/mcp', '对Linux程序进行动态调试'],
  ['metasploit', 'http://127.0.0.1:3000/', '渗透测试框架'],
];
const stdioPresets = [
  ['cyberchef', 'cmd.exe', ['/d', '/s', '/c', 'cyberchef-mcp'], '数据分析工具'],
  ['wireshark', 'python', ['-m', 'wireshark_mcp', 'serve', '--transport', 'stdio', '--profile', 'analysis'], '网络流量分析工具'],
  ['windbg', 'python', ['-m', 'mcp_windbg', '--transport', 'stdio'], '二进制漏洞分析工具'],
  ['sagemath', 'sagemath-mcp', ['--transport', 'stdio'], '数学与密码分析工具'],
  ['pwntools', 'Class', ['--local-analysis-mcp', 'pwntools'], '二进制题目分析工具'],
  ['bloodhound', 'bloodhound-mcp', [], '域环境关系分析工具'],
  ['zsteg', 'Class', ['--local-analysis-mcp', 'zsteg'], '图片隐写分析工具'],
  ['binwalk', 'Class', ['--local-analysis-mcp', 'binwalk'], '固件分析与提取工具'],
  ['aflpp', 'aflpp-mcp', [], '模糊测试工具'],
];
const presetDisplayName = type => ({ sagemath: 'sageMath', aflpp: 'AFL++' })[type] ?? type;
const allPresetConfig = () => {
  const value = burpConfig();
  value.mcps.push(...reversePresets.map(([builtin, url]) => ({ id: 'fixture-' + builtin, name: builtin, builtin, transport: 'http', url, skipTlsVerify: false, enabled: false, agentIds: [] })));
  value.mcps.push(...stdioPresets.map(([builtin, command, args]) => ({ id: 'fixture-' + builtin, name: presetDisplayName(builtin), builtin, transport: 'stdio', command, args: [...args], enabled: false, agentIds: [] })));
  return value;
};
const plain = value => JSON.parse(JSON.stringify(value));

test('fresh profiles render common and platform presets with disabled and ungranted defaults', () => {
  for (const [platform, types] of [
    ['win32', ['browser', 'burpsuite', 'tscan', 'jadx', 'x64dbg', 'ida', 'cyberchef', 'wireshark', 'windbg']],
    ['linux', ['browser', 'burpsuite', 'tscan', 'jadx', 'ghidra', 'gdb', 'wireshark', 'sagemath', 'pwntools', 'metasploit', 'bloodhound', 'zsteg', 'binwalk', 'aflpp']],
  ]) {
    const value = { ...ensureBuiltinMcpPresets(normalizeExtensions({}), platform), platform, agents: [] }, f = harness();
    assert.deepEqual(value.mcps.map(item => item.builtin), types);
    for (const item of value.mcps) { assert.equal(item.enabled, false); assert.deepEqual(item.agentIds, []); }
    for (const [builtin, command, args] of stdioPresets) {
      const item = value.mcps.find(entry => entry.builtin === builtin);
      if (!types.includes(builtin)) { assert.equal(item, undefined); continue; }
      assert.equal(item.name, presetDisplayName(builtin)); assert.equal(item.transport, 'stdio');
      assert.equal(item.command, builtin === 'wireshark' && platform === 'linux' ? 'wireshark-mcp' : command);
      assert.deepEqual(item.args, builtin === 'wireshark' && platform === 'linux' ? ['serve', '--transport', 'stdio', '--profile', 'analysis'] : args);
    }
    f.ui.acceptExtensions(value); f.ui.renderExtensions();
    assert.equal([...f.$('extensions-content').innerHTML.matchAll(/data-extension-guide=/g)].length, types.length);
    f.ui.openExtensionGuide(value.mcps.find(item => item.builtin === 'wireshark').id);
    const guide = f.$('extension-guide-content').innerHTML;
    if (platform === 'linux') { assert.match(guide, /wireshark-mcp/); assert.doesNotMatch(guide, /Program Files|Npcap/); }
    else { assert.match(guide, /python|Python/); assert.match(guide, /WIRESHARK_TSHARK_PATH|Program Files/); }
  }
});

test('all server-provided preset markers render their own icons without badges or delete actions on any host', async () => {
  const value = allPresetConfig(), f = harness();
  // The UI consumes server data; imported presets from another OS remain visible.
  value.mcps[1].name = 'x64dbg';
  f.ui.acceptExtensions(value); f.ui.renderExtensions();
  const cards = f.$('extensions-content').innerHTML;
  const descriptions = [['browser', '对浏览器执行自动化操作'], ['burpsuite', '调用Web测试神器burpsuite'], ...reversePresets.map(([type, , description]) => [type, description]), ...stdioPresets.map(([type, , , description]) => [type, description])];
  const symbols = [];
  for (const [type, description] of descriptions) {
    const preset = value.mcps.find(item => item.builtin === type);
    const card = cards.split('<article').find(part => part.includes(`data-extension-select="${preset.id}"`));
    assert.ok(card, type + ' is rendered from the API');
    assert.ok(card.includes(`data-icon="${type}"`)); assert.ok(card.includes(description));
    assert.match(card, /已停用/); assert.match(card, /尚未授权成员/);
    assert.doesNotMatch(card, /extension-kind|data-extension-delete/);
    assert.ok(card.includes(`data-extension-edit="${preset.id}"`)); assert.ok(card.includes(`data-extension-toggle="${preset.id}"`));
    assert.match(card, /class="[^"]*extension-guide-button/); assert.ok(card.includes(`data-extension-guide="${preset.id}"`));
    await f.ui.deleteExtension(preset.id);
    const symbol = html.match(new RegExp(`<symbol id="i-${type}"[^>]*>([\\s\\S]*?)<\\/symbol>`));
    assert.ok(symbol, type + ' has an SVG definition'); symbols.push(symbol[1]);
  }
  assert.equal(new Set(symbols).size, descriptions.length, 'Preset icons are distinct');
  assert.equal(f.calls.length, 0, 'Preset deletion never reaches the API');
  assert.ok(cards.includes('data-extension-delete="b"'), 'A matching display name does not turn a custom MCP into a preset');
  assert.equal([...cards.matchAll(/data-extension-guide=/g)].length, value.mcps.length);
  assert.ok(cards.includes('data-extension-guide="a"')); assert.ok(cards.includes('data-extension-guide="b"'));
  f.ui.tab('skills'); f.ui.renderExtensions(); assert.doesNotMatch(f.$('extensions-content').innerHTML, /extension-kind|MARKDOWN SKILL/);
});

test('all preset guides open read-only while locked and use defaults without exposing saved names, endpoints or secrets', () => {
  const value = allPresetConfig(), f = harness(), attack = '<img src=x onerror="guideAttack()">';
  for (const item of value.mcps.filter(item => item.builtin)) {
    item.name = attack; item.url = 'https://localhost/private-saved-endpoint';
    item.headers = { Authorization: 'private-guide-fixture-secret' }; item.env = { TOKEN: 'private-guide-fixture-secret' };
  }
  const before = structuredClone(value);
  f.ui.acceptExtensions(value); f.state.run = { id: 'fixture-running', status: 'running' };
  f.context.busy = true;
  f.ui.renderExtensions();
  assert.doesNotMatch(f.$('extensions-content').innerHTML, /<img/); assert.match(f.$('extensions-content').innerHTML, /&lt;img/);
  for (const item of value.mcps.filter(item => item.builtin)) {
    f.ui.openExtensionGuide(item.id);
    assert.equal(f.opened.at(-1), 'extension-guide-dialog');
    assert.equal(f.$('extension-guide-title').textContent, presetDisplayName(item.builtin) + ' 配置指南');
    const content = f.$('extension-guide-content').innerHTML;
    assert.match(content, /<ol(?:\s|>)/); assert.ok([...content.matchAll(/<li(?:\s|>)/g)].length >= 3);
    assert.doesNotMatch(content, /<img|guideAttack|private-saved-endpoint|private-guide-fixture-secret/);
    assert.doesNotMatch(content, /<(?:input|select|textarea|form)(?:\s|>)/);
    if (item.builtin === 'tscan') { assert.match(content, /127\.0\.0\.1:8088\/mcp/); assert.match(content, /Streamable HTTP/); assert.match(content, /MCP服务配置/); }
    if (item.builtin === 'jadx') { assert.match(content, /127\.0\.0\.1:8651\/mcp/); assert.match(content, /jadx_mcp_server\.py/); assert.match(content, /--http/); }
    const links = [...content.matchAll(/<a\b([^>]*)>/g)];
    assert.ok(links.length > 0, item.builtin + ' provides setup/download documentation');
    for (const [, attributes] of links) {
      assert.match(attributes, /href="https:\/\//); assert.match(attributes, /target="_blank"/);
      const rel = attributes.match(/rel="([^"]+)"/)?.[1].split(/\s+/) || [];
      assert.ok(rel.includes('noopener') && rel.includes('noreferrer'));
    }
  }
  const guideCount = value.mcps.filter(item => item.builtin).length;
  assert.equal(f.opened.length, guideCount); assert.equal(f.calls.length, 0); assert.deepEqual(plain(f.ui.data()), before);
  for (const id of ['s', 'missing']) f.ui.openExtensionGuide(id);
  assert.equal(f.opened.length, guideCount, 'IDs outside the selected tab cannot open a guide');
  for (const id of ['a', 'b']) { f.ui.openExtensionGuide(id); assert.doesNotMatch(f.$('extension-guide-content').innerHTML, /private-saved-endpoint|private-guide-fixture-secret/); }
  assert.equal(f.opened.length, guideCount + 2, 'Custom MCPs receive their own generic setup guide');
  const dialog = html.match(/<dialog\b[^>]*id="extension-guide-dialog"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(dialog); assert.match(dialog, /id="extension-guide-title"/); assert.match(dialog, /id="extension-guide-content"/);
  assert.match(dialog, /data-dialog-close="extension-guide-dialog"/); assert.doesNotMatch(dialog, /<(?:input|select|textarea|form)(?:\s|>)/);
});

test('every MCP card offers connection testing immediately after its toggle while Skills have no test action', () => {
  const value = allPresetConfig(), f = harness(); f.ui.acceptExtensions(value); f.ui.renderExtensions();
  const cards = f.$('extensions-content').innerHTML;
  assert.equal([...cards.matchAll(/data-extension-test=/g)].length, value.mcps.length);
  for (const item of value.mcps) {
    const card = cards.split('<article').find(part => part.includes(`data-extension-select="${item.id}"`));
    assert.ok(card.includes(`data-extension-test="${item.id}" aria-busy="false">测试连接`));
    assert.ok(card.indexOf('data-extension-toggle=') < card.indexOf('data-extension-test='));
  }
  f.ui.tab('skills'); f.ui.renderExtensions(); assert.doesNotMatch(f.$('extensions-content').innerHTML, /data-extension-test|extension-test-result/);
});

test('connection tests serialize requests, retain results across tabs and preserve disabled state and grants', async () => {
  let finish; const f = harness(async () => new Promise(resolve => { finish = resolve; })), value = allPresetConfig();
  const preset = value.mcps.find(item => item.builtin === 'cyberchef'), before = structuredClone(value), buttons = [{ disabled: false }, { disabled: false }];
  f.context.document.querySelectorAll = selector => selector === '[data-extension-test]' ? buttons : [];
  f.ui.acceptExtensions(value); const request = f.ui.testExtensionConnection(preset.id);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], '/api/extensions/test');
  assert.equal(f.calls[0][1].method, 'POST'); assert.deepEqual(plain(f.calls[0][1].body), { id: preset.id, revision: value.revision });
  assert.match(f.$('extensions-content').innerHTML, /aria-busy="true">测试中…/); assert.ok(buttons.every(button => button.disabled));
  await f.ui.testExtensionConnection(preset.id); await f.ui.testExtensionConnection('a'); assert.equal(f.calls.length, 1);
  assert.equal(f.$('extension-add').disabled, false, 'Testing does not lock configuration controls');
  f.ui.tab('skills'); f.ui.renderExtensions(); assert.doesNotMatch(f.$('extensions-content').innerHTML, /data-extension-test/);
  finish({ ok: true, toolCount: 23, durationMs: 12 }); await request;
  assert.doesNotMatch(f.$('extensions-content').innerHTML, /连接成功|测试中/);
  f.ui.tab('mcps'); f.ui.renderExtensions(); assert.match(f.$('extensions-content').innerHTML, /连接成功，发现 23 个工具/);
  assert.ok(buttons.every(button => !button.disabled)); assert.deepEqual(plain(f.ui.data()), before);
  f.ui.acceptExtensions(structuredClone(before)); f.ui.renderExtensions(); assert.match(f.$('extensions-content').innerHTML, /连接成功，发现 23 个工具/);
});

test('connection failures show escaped reasons and stale test completions cannot describe changed settings', async () => {
  const value = config(), f = harness(async () => ({ ok: false, message: '<img src=x onerror="testAttack()"> missing executable' }));
  f.ui.acceptExtensions(value); await f.ui.testExtensionConnection('a');
  assert.match(f.$('extensions-content').innerHTML, /连接失败：&lt;img/); assert.doesNotMatch(f.$('extensions-content').innerHTML, /<img/);
  let finish; const stale = harness(async () => new Promise(resolve => { finish = resolve; }));
  stale.ui.acceptExtensions(value); const request = stale.ui.testExtensionConnection('a');
  stale.ui.acceptExtensions({ ...value, revision: value.revision + 1 });
  finish({ ok: true, toolCount: 99 }); await request;
  assert.doesNotMatch(stale.$('extensions-content').innerHTML, /连接成功|99 个工具|测试中/);
  f.ui.acceptExtensions({ ...value, revision: value.revision + 1 }); f.ui.renderExtensions();
  assert.doesNotMatch(f.$('extensions-content').innerHTML, /连接失败|testAttack/);
});

test('connection tests report API errors and reject invalid success data without altering configuration', async () => {
  for (const result of [new Error('扩展配置已更新，请刷新后重试'), { ok: true, toolCount: -1 }, { ok: true, toolCount: '23' }, { ok: false }]) {
    const value = config(), before = structuredClone(value), f = harness(async () => { if (result instanceof Error) throw result; return result; });
    f.ui.acceptExtensions(value); await f.ui.testExtensionConnection('b');
    assert.match(f.$('extensions-content').innerHTML, /连接失败/); assert.doesNotMatch(f.$('extensions-content').innerHTML, /测试中/);
    assert.deepEqual(plain(f.ui.data()), before);
  }
  const f = harness(); f.ui.acceptExtensions(config()); f.state.run = { status: 'running' };
  await f.ui.testExtensionConnection('a'); f.state.run = null;
  await f.ui.testExtensionConnection('missing'); await f.ui.testExtensionConnection('s');
  f.ui.tab('skills'); await f.ui.testExtensionConnection('a'); assert.equal(f.calls.length, 1);
});

test('new preset editors, external toggles and grants preserve markers and private credentials through actual configuration updates', async () => {
  for (const [type] of [...reversePresets, ...stdioPresets]) for (const transport of ['http', 'sse', 'stdio']) {
    const value = allPresetConfig(), preset = value.mcps.find(item => item.builtin === type), requests = [];
    preset.agentIds = ['teacher'];
    preset.headers = { Authorization: 'Bearer saved-fixture==' }; preset.env = { FIXTURE_TOKEN: 'saved-env-fixture' };
    let stored = normalizeExtensions(value, value.agents), secrets = {};
    ({ extensions: stored, secrets } = prepareExtensionUpdate(value, stored, value.agents, secrets));
    const f = harness(async (url, options) => {
      assert.equal(url, '/api/extensions'); assert.equal(options.method, 'PUT');
      const body = plain(options.body); requests.push(body);
      ({ extensions: stored, secrets } = prepareExtensionUpdate(body, stored, value.agents, secrets));
      return publicExtensions(stored, secrets, value.agents);
    });
    f.ui.acceptExtensions(publicExtensions(stored, secrets, value.agents)); f.ui.openExtension(preset.id);
    assert.equal(f.$('extension-dialog-title').textContent, '编辑配置');
    assert.equal(f.$('extension-url').value, preset.url || '');
    assert.equal(f.$('extension-transport').value, preset.transport);
    if (preset.transport === 'stdio') {
      assert.equal(f.$('extension-command').value, preset.command);
      assert.deepEqual(plain(f.ui.parseExtensionArgs(f.$('extension-args').value)), preset.args);
    }
    assert.equal(f.$('extension-headers').value, ''); assert.equal(f.$('extension-env').value, '');
    f.ui.chooseExtensionTransport(transport);
    assert.equal(f.$('extension-command').required, transport === 'stdio');
    assert.equal(f.$('extension-url').required, transport !== 'stdio');
    f.$('extension-name').value = 'Edited ' + type;
    f.$('extension-url').value = 'https://localhost/fixture-' + type; f.$('extension-skip-tls-verify').checked = true;
    f.$('extension-command').value = 'fixture-never-run'; f.$('extension-args').value = '--name "two words"';
    f.$(transport === 'stdio' ? 'extension-env' : 'extension-headers').value = transport === 'stdio' ? 'FIXTURE_TOKEN=replacement-env==' : 'Authorization=Bearer replacement-header==';
    await f.ui.saveExtension();
    const edited = plain(stored.mcps.find(item => item.id === preset.id));
    assert.equal(edited.builtin, type); assert.equal(edited.transport, transport);
    assert.equal(edited.enabled, false); assert.deepEqual(edited.agentIds, ['teacher']);
    assert.equal(edited.name, 'Edited ' + type);
    if (transport === 'stdio') assert.deepEqual(edited.args, ['--name', 'two words']);
    else { assert.equal(edited.url, 'https://localhost/fixture-' + type); assert.equal(edited.skipTlsVerify, true); }
    const expectedSecrets = { env: { FIXTURE_TOKEN: transport === 'stdio' ? 'replacement-env==' : 'saved-env-fixture' }, headers: { Authorization: transport === 'stdio' ? 'Bearer saved-fixture==' : 'Bearer replacement-header==' } };
    const verifySecrets = () => {
      const privateValue = extensionSecrets(secrets, stored)[preset.id];
      assert.deepEqual(privateValue.env, expectedSecrets.env); assert.deepEqual(privateValue.headers, expectedSecrets.headers);
      assert.doesNotMatch(JSON.stringify(f.ui.data()), /saved-fixture|saved-env-fixture|replacement-env|replacement-header/);
    };
    verifySecrets();
    f.ui.openExtension(preset.id); await f.ui.saveExtension(); verifySecrets();
    await f.ui.toggleExtension(preset.id); verifySecrets();
    assert.equal(stored.mcps.find(item => item.id === preset.id).enabled, true);
    f.ui.select(preset.id); f.ui.openExtensionGrant();
    f.$('extension-grant-agents').options = [{ getAttribute: () => 'alice' }]; await f.ui.saveExtensionGrant(); verifySecrets();
    assert.deepEqual(stored.mcps.find(item => item.id === preset.id), { ...edited, enabled: true, agentIds: ['teacher', 'alice'] });
    for (const body of requests.slice(1)) {
      const item = body.mcps.find(entry => entry.id === preset.id);
      assert.equal(item.builtin, type); assert.equal(item.headers, undefined); assert.equal(item.env, undefined);
    }
    for (const other of stored.mcps.filter(item => item.builtin && item.builtin !== type)) {
      assert.equal(other.enabled, false); assert.deepEqual(other.agentIds, []);
    }
  }
});

test('shared extension editor omits enable and authorization controls and uses lowercase protocol labels', () => {
  assert.doesNotMatch(html, /id="extension-(?:enabled|agent-choices)"/);
  assert.deepEqual([...html.matchAll(/data-extension-transport="(stdio|http|sse)">([^<]*)/g)].map(match => [match[1], match[2]]), [['stdio', 'stdio'], ['http', 'http'], ['sse', 'sse']]);
  const options = html.match(/<select id="extension-transport"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(options); assert.deepEqual([...options.matchAll(/<option value="([^"]+)">([^<]*)/g)].map(match => [match[1], match[2]]), [['stdio', 'stdio'], ['http', 'http'], ['sse', 'sse']]);
  assert.match(html, /id="extension-grant-agents"/);
});

test('extension cards escape untrusted names, descriptions, URLs, member names and IDs', () => {
  const f = harness(), value = config(), attack = '<img src=x onerror="bad()">';
  value.mcps[0].name = attack; value.mcps[0].id = attack; value.mcps[0].command = attack; value.agents[0].name = attack;
  f.ui.acceptExtensions(value); f.ui.renderExtensions();
  assert.ok(!f.$('extensions-content').innerHTML.includes('<img'));
  assert.match(f.$('extensions-content').innerHTML, /&lt;img/);
  assert.match(f.$('extensions-content').innerHTML, /&quot;/);
});

test('extension payload preserves revision and grants while omitting secrets, key display metadata and legacy skill associations', () => {
  const f = harness(), value = config(); value.mcps[0].env = { KEY: 'should-never-copy' };
  f.ui.acceptExtensions(value); const payload = f.ui.extensionConfiguration();
  assert.equal(payload.revision, 7); assert.deepEqual([...payload.mcps[0].agentIds], ['teacher']);
  assert.equal(payload.mcps[0].env, undefined); assert.equal(payload.mcps[0].envKeys, undefined);
  assert.equal(payload.skills[0].mcpIds, undefined); assert.deepEqual([...payload.skills[0].agentIds], ['teacher']);
  f.$('secret').value = ' '; assert.equal(f.ui.extensionSecretInput('secret'), undefined);
  for (const invalid of ['[]', 'null', '{"KEY":3}', 'broken']) { f.$('secret').value = invalid; assert.throws(() => f.ui.extensionSecretInput('secret')); }
  f.$('secret').value = 'KEY=replacement'; assert.equal(f.ui.extensionSecretInput('secret').KEY, 'replacement');
});

test('bulk grants add selected agents only to selected extensions and retain existing authorizations', async () => {
  let saved;
  const f = harness(async (url, options) => { saved = options.body; return { ...saved, revision: saved.revision + 1, agents: config().agents }; });
  const value=config(); value.agents.push({ id: 'principal', name: '校长', role: 'principal' });
  f.ui.acceptExtensions(value); f.ui.select('a', 'b'); f.ui.openExtensionGrant();
  assert.match(f.$('extension-grant-agents').innerHTML, /data-grant-agent="teacher"/); assert.doesNotMatch(f.$('extension-grant-agents').innerHTML, /data-grant-agent="principal"/);
  f.$('extension-grant-agents').options = [{ getAttribute: () => 'alice' }];
  await f.ui.saveExtensionGrant();
  assert.equal(saved.revision, 7); assert.deepEqual([...saved.mcps[0].agentIds], ['teacher', 'alice']); assert.deepEqual([...saved.mcps[1].agentIds], ['alice']);
  assert.deepEqual([...saved.skills[0].agentIds], ['teacher']); assert.deepEqual(f.closed, ['extension-grant-dialog']);
});

test('a revision conflict retains cached configuration and the open authorization editor', async () => {
  const f = harness(async () => { throw Error('扩展配置已更新，请刷新后重试'); });
  f.ui.acceptExtensions(config()); f.ui.select('a'); f.$('extension-grant-agents').options = [{ getAttribute: () => 'alice' }];
  await f.ui.saveExtensionGrant();
  assert.equal(f.ui.data().revision, 7); assert.deepEqual([...f.ui.data().mcps[0].agentIds], ['teacher']); assert.deepEqual(f.closed, []);
  assert.equal(f.notices[0].warning, true); assert.match(f.notices[0].message, /刷新/);
});

test('running tasks retain their snapshot while later-task configuration can change and historical resume requires a checkpoint', async () => {
  const f = harness(async (url,options) => url === '/api/extensions' ? {...options.body,agents:[],revision:8} : ({ run: { id: 'run-owned', status: 'running' } })); f.ui.acceptExtensions(config());
  f.state.run = { id: 'current', status: 'running' }; const active=f.state.run; await f.ui.toggleExtension('a'); assert.equal(f.calls.length, 1); assert.equal(f.state.run,active);
  f.state.run = { id: 'run-owned', status: 'interrupted', recoverable: false }; await f.ui.resumeRun('run-owned'); assert.equal(f.calls.length, 1);
  f.state.run.recoverable = true; await f.ui.resumeRun('run-owned');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1][0], '/api/runs/run-owned/resume'); assert.equal(f.calls[1][1].method, 'POST');
  assert.equal(f.context.state.run.id, 'run-owned'); assert.equal(f.context.state.run.status, 'running');
});

test('MCP arguments support whitespace, quoted pieces and literal Windows paths without shell expansion', () => {
  const { ui } = harness();
  assert.deepEqual([...ui.parseExtensionArgs(`  --name="two words" pre'fixed value'post '' ""\n--count\t3  `)], ['--name=two words', 'prefixed valuepost', '', '', '--count', '3']);
  assert.deepEqual([...ui.parseExtensionArgs(String.raw`C:\new\tools "C:\new\tools" \\server\share '\\server\share with spaces\'`)], [String.raw`C:\new\tools`, String.raw`C:\new\tools`, String.raw`\\server\share`, '\\\\server\\share with spaces\\']);
  assert.deepEqual([...ui.parseExtensionArgs(String.raw`"say \"hello\"" '$HOME' '$(whoami)' ';'`)], ['say "hello"', '$HOME', '$(whoami)', ';']);
  assert.throws(() => ui.parseExtensionArgs('--name "unfinished'), /引号未闭合/);
  assert.throws(() => ui.parseExtensionArgs("--name 'unfinished"), /引号未闭合/);
});

test('editing and saving an existing MCP preserves exact argument strings, including quoted JSON and control characters', async () => {
  const args = ['--dir', 'C:\\Program Files\\', '--json', '{"a":"b c"}', '', "O'Reilly", '\\\\server\\share', 'C:\\new', 'C:\\u{d}', '\r\n', '\t', 'first\nsecond', '\u0000', '\u2028', 'quote"\\', '空 格'];
  let saved;
  const f = harness(async (url, options) => { saved = options.body; return { ...saved, revision: 8, agents: config().agents }; });
  const value = config(); value.mcps[0].args = args;
  f.ui.acceptExtensions(value); f.ui.openExtension('a');
  // Browser textarea values normalize carriage returns; formatting must remain lossless across that boundary.
  f.$('extension-args').value = f.$('extension-args').value.replace(/\r\n?/g, '\n');
  await f.ui.saveExtension();
  assert.deepEqual([...saved.mcps[0].args], args);
  assert.equal(saved.mcps[0].command, 'fixture');
  assert.deepEqual(f.closed, ['extension-dialog']);
});

test('an unfinished quote blocks saving without discarding the MCP editor or its draft', async () => {
  const f = harness(); f.ui.acceptExtensions(config()); f.ui.openExtension('a');
  const draft = '--name "unfinished'; f.$('extension-args').value = draft;
  await f.ui.saveExtension();
  assert.equal(f.calls.length, 0); assert.deepEqual(f.closed, []);
  assert.equal(f.$('extension-args').value, draft);
  assert.equal(f.ui.data().revision, 7);
  assert.match(f.notices[0].message, /引号未闭合/); assert.equal(f.notices[0].warning, true);
});

test('remote MCP transports ignore unfinished arguments hidden by switching away from stdio', async () => {
  for (const transport of ['http', 'sse']) {
    let saved;
    const f = harness(async (url, options) => { saved = options.body; return { ...saved, revision: 8, agents: config().agents }; });
    f.ui.acceptExtensions(config()); f.ui.openExtension('a');
    f.$('extension-args').value = '--name "unfinished'; f.$('extension-transport').value = transport;
    f.$('extension-url').value = 'https://example.invalid/mcp';
    await f.ui.saveExtension();
    assert.equal(saved.mcps[0].transport, transport); assert.equal(saved.mcps[0].args, undefined);
    assert.deepEqual(f.closed, ['extension-dialog']);
  }
});

test('browser preset cards remain disabled and ungranted, use a browser icon without a builtin badge, and cannot be deleted', async () => {
  const value = builtinConfig(), builtin = value.mcps.at(-1);
  // A normal MCP with the same name stays a normal, removable service.
  value.mcps[1].name = builtin.name;
  const f = harness(async (url, options) => url === '/api/modes' ? { revision:0, items:[] } : ({ ...value, mcps:value.mcps.filter(item => !options.body.ids.includes(item.id)), revision:8 }));
  f.ui.acceptExtensions(value); f.ui.renderExtensions();
  const html = f.$('extensions-content').innerHTML;
  const card = html.split('<article').find(part => part.includes(`data-extension-select="${builtin.id}"`));
  assert.ok(!card.includes('extension-kind')); assert.match(card, /data-icon="browser"/);
  assert.match(card, /对浏览器执行自动化操作/); assert.match(card, /已停用/); assert.match(card, /尚未授权成员/);
  assert.ok(card.includes(`data-extension-edit="${builtin.id}"`));
  assert.ok(card.includes(`data-extension-toggle="${builtin.id}"`));
  assert.ok(!card.includes('data-extension-delete'));
  assert.ok(html.includes('data-extension-delete="b"'));
  await f.ui.deleteExtension(builtin.id); assert.equal(f.calls.length, 0);
  await f.ui.deleteExtension('b'); assert.equal(f.calls.length, 0); await f.ui.confirmExtensionDeletion(); assert.equal(f.calls[0][1].method, 'DELETE');
  assert.deepEqual(plain(f.ui.data().mcps.find(item => item.id === builtin.id)), builtin);
});

test('browser preset uses the shared connection editor and transport switching updates only active required fields', () => {
  const f = harness(), value = builtinConfig(), builtin = value.mcps.at(-1);
  value.agents.push({ id: 'principal', name: '校长', role: 'principal' });
  f.ui.acceptExtensions(value); f.ui.openExtension('b');
  assert.equal(f.$('extension-url').required, true);
  f.ui.openExtension(builtin.id);
  assert.equal(f.$('extension-mcp-fields').hidden, false);
  assert.equal(f.$('extension-skill-fields').hidden, true);
  assert.equal(f.$('extension-command').required, true); assert.equal(f.$('extension-url').required, false);
  assert.equal(f.$('extension-content').required, false);
  assert.equal(f.$('extension-name').value, builtin.name);
  assert.equal(f.$('extension-dialog-title').textContent, '编辑配置');
  assert.equal(f.$('extension-command').value, 'Class'); assert.equal(f.$('extension-args').value, '--browser-mcp');
  f.ui.chooseExtensionTransport('sse');
  assert.equal(f.$('extension-stdio-fields').hidden, true); assert.equal(f.$('extension-remote-fields').hidden, false);
  assert.equal(f.$('extension-command').required, false); assert.equal(f.$('extension-url').required, true);
  assert.equal(f.$('extension-skip-tls-verify').checked, false);
  f.ui.openExtension();
  assert.equal(f.$('extension-mcp-fields').hidden, false); assert.equal(f.$('extension-transport').value, 'stdio');
  assert.equal(f.$('extension-command').required, true); assert.equal(f.$('extension-url').required, false);
  f.ui.openExtension('b');
  assert.equal(f.$('extension-mcp-fields').hidden, false); assert.equal(f.$('extension-transport').value, 'http');
  assert.equal(f.$('extension-command').required, false); assert.equal(f.$('extension-url').required, true);
});

test('Burp cards show their own icon and description, start disabled and ungranted, and cannot be deleted', async () => {
  const value = burpConfig(), preset = value.mcps.at(-1);
  value.mcps[1].name = 'burpsuite';
  const f = harness(async (url, options) => url === '/api/modes' ? { revision:0, items:[] } : ({ ...value, mcps:value.mcps.filter(item => !options.body.ids.includes(item.id)), revision:8 }));
  f.ui.acceptExtensions(value); f.ui.renderExtensions();
  const cards = f.$('extensions-content').innerHTML;
  const card = cards.split('<article').find(part => part.includes(`data-extension-select="${preset.id}"`));
  assert.match(card, /data-icon="burpsuite"/); assert.match(card, /调用Web测试神器burpsuite/);
  assert.match(card, /已停用/); assert.match(card, /尚未授权成员/); assert.doesNotMatch(card, /extension-kind/);
  assert.ok(card.includes(`data-extension-edit="${preset.id}"`)); assert.ok(card.includes(`data-extension-toggle="${preset.id}"`));
  assert.doesNotMatch(card, /data-extension-delete/); assert.ok(cards.includes('data-extension-delete="b"'));
  const browserCard = cards.split('<article').find(part => part.includes('data-extension-select="reserved-browser-42"'));
  assert.match(browserCard, /data-icon="browser"/); assert.match(browserCard, /对浏览器执行自动化操作/);
  await f.ui.deleteExtension(preset.id); assert.equal(f.calls.length, 0);
  await f.ui.deleteExtension('b'); assert.equal(f.calls.length, 0); await f.ui.confirmExtensionDeletion(); assert.equal(f.calls[0][1].method, 'DELETE');
  assert.deepEqual(plain(f.ui.data().mcps.find(item => item.id === preset.id)), preset);
});

test('Burp opens the shared editor with its SSE URL and TLS default and can switch to every transport', () => {
  const value = burpConfig(), preset = value.mcps.at(-1), f = harness();
  f.ui.acceptExtensions(value); f.ui.openExtension(preset.id);
  assert.equal(f.$('extension-dialog-title').textContent, '编辑配置');
  assert.equal(f.$('extension-name').value, 'burpsuite'); assert.equal(f.$('extension-transport').value, 'sse');
  assert.equal(f.$('extension-url').value, 'http://127.0.0.1:9876'); assert.equal(f.$('extension-skip-tls-verify').checked, false);
  assert.equal(f.$('extension-mcp-fields').hidden, false); assert.equal(f.$('extension-skill-fields').hidden, true);
  assert.equal(f.$('extension-command').required, false); assert.equal(f.$('extension-url').required, true);
  for (const transport of ['stdio', 'http', 'sse']) {
    f.ui.chooseExtensionTransport(transport);
    assert.equal(f.$('extension-transport').value, transport);
    assert.equal(f.$('extension-stdio-fields').hidden, transport !== 'stdio');
    assert.equal(f.$('extension-remote-fields').hidden, transport === 'stdio');
    assert.equal(f.$('extension-command').required, transport === 'stdio');
    assert.equal(f.$('extension-url').required, transport !== 'stdio');
  }
});

test('Burp connection edits preserve either enabled state and grants; external toggle and grants keep the edited connection', async () => {
  for (const enabled of [false, true]) for (const transport of ['sse', 'http', 'stdio']) {
    const value = burpConfig(), preset = value.mcps.at(-1), requests = [];
    preset.enabled = enabled; preset.agentIds = ['teacher'];
    const f = harness(async (url, options) => { requests.push(plain(options.body)); return { ...options.body, revision: options.body.revision + 1, agents: value.agents }; });
    f.ui.acceptExtensions(value); f.ui.openExtension(preset.id); f.ui.chooseExtensionTransport(transport);
    f.$('extension-name').value = 'Edited Burp';
    f.$('extension-url').value = 'https://localhost/edited-burp'; f.$('extension-skip-tls-verify').checked = true;
    f.$('extension-command').value = 'fixture-burp'; f.$('extension-args').value = '--name "two words"';
    f.$('extension-env').value = transport === 'stdio' ? 'BURP_SETTING=fixture=value' : 'invalid hidden environment';
    f.$('extension-headers').value = transport === 'stdio' ? 'invalid hidden header' : 'Authorization=Bearer fixture=value';
    await f.ui.saveExtension();
    const connection = transport === 'stdio' ? { command: 'fixture-burp', args: ['--name', 'two words'] }
      : { url: 'https://localhost/edited-burp', skipTlsVerify: true };
    const common = { id: preset.id, name: 'Edited Burp', builtin: 'burpsuite', transport, enabled, agentIds: ['teacher'], ...connection };
    assert.deepEqual(requests[0].mcps.find(item => item.id === preset.id), { ...common, ...(transport === 'stdio'
      ? { env: { BURP_SETTING: 'fixture=value' }, clearEnv: [] }
      : { headers: { Authorization: 'Bearer fixture=value' }, clearHeaders: [] }) });
    assert.deepEqual(f.closed, ['extension-dialog']);
    await f.ui.toggleExtension(preset.id);
    const expected = { ...common, enabled: !enabled, ...(transport === 'stdio' ? {} : { args: [] }) };
    assert.deepEqual(requests[1].mcps.find(item => item.id === preset.id), expected);
    f.ui.select(preset.id); f.ui.openExtensionGrant();
    f.$('extension-grant-agents').options = [{ getAttribute: () => 'alice' }]; await f.ui.saveExtensionGrant();
    assert.deepEqual(requests[2].mcps.find(item => item.id === preset.id), { ...expected, agentIds: ['teacher', 'alice'] });
    assert.deepEqual(requests[2].mcps.find(item => item.builtin === 'browser'), value.mcps.find(item => item.builtin === 'browser'));
    assert.deepEqual(requests[2].mcps.find(item => item.id === 'a').agentIds, ['teacher']);
    assert.equal(requests[2].mcps.find(item => item.id === 'a').command, 'fixture');
  }
});

test('editing another extension keeps both preset connections, enabled states and grants', async () => {
  for (const [tab, id] of [['mcps', 'a'], ['skills', 's']]) {
    const value = burpConfig(), preset = value.mcps.at(-1);
    Object.assign(preset, { name: 'Saved Burp', transport: 'http', url: 'https://localhost/saved-burp', skipTlsVerify: true, enabled: true, agentIds: ['alice'] });
    let saved;
    const f = harness(async (url, options) => { saved = plain(options.body); return { ...options.body, revision: 8, agents: value.agents }; });
    f.ui.acceptExtensions(value); f.ui.tab(tab); f.ui.openExtension(id); await f.ui.saveExtension();
    assert.deepEqual(saved.mcps.find(item => item.id === preset.id), { ...preset, args: [] });
    assert.deepEqual(saved.mcps.find(item => item.builtin === 'browser'), value.mcps.find(item => item.builtin === 'browser'));
    assert.equal(saved.skills[0].content, '# 步骤');
  }
});

test('Burp editor keeps the draft on revision conflicts while tasks run from their snapshots', async () => {
  const value = burpConfig(), preset = value.mcps.at(-1), f = harness(async () => { throw Error('扩展配置已更新，请刷新后重试'); });
  f.ui.acceptExtensions(value); f.ui.openExtension(preset.id); f.$('extension-url').value = 'https://localhost/keep-draft';
  f.state.run = { id: 'current', status: 'running' }; f.ui.select(preset.id);
  await f.ui.saveExtension(); await f.ui.toggleExtension(preset.id); await f.ui.saveExtensionGrant();
  assert.equal(f.calls.length, 2);
  f.state.run = null; await f.ui.saveExtension();
  assert.equal(f.calls.length, 3); assert.deepEqual(f.closed, []);
  assert.equal(f.$('extension-url').value, 'https://localhost/keep-draft');
  assert.equal(f.ui.data().revision, value.revision); assert.deepEqual(plain(f.ui.data().mcps.at(-1)), preset);
  assert.equal(f.notices[0].warning, true); assert.match(f.notices[0].message, /刷新/);
});

test('browser can use external transport while editing, toggling and bulk grants preserve its marker, TLS option and saved working directory', async () => {
  const value = builtinConfig(), builtin = value.mcps.at(-1), requests = [];
  builtin.cwd = 'C:\\fixture\\workspace';
  const f = harness(async (url, options) => { requests.push(plain(options.body)); return { ...options.body, revision: options.body.revision + 1, agents: value.agents }; });
  f.ui.acceptExtensions(value); f.ui.openExtension(builtin.id);
  f.$('extension-name').value = '改名后的浏览器';
  f.$('extension-args').value = '--broken "'; f.$('extension-env').value = 'invalid hidden environment';
  f.$('extension-command').value = 'should-not-launch'; f.$('extension-transport').value = 'http';
  f.$('extension-url').value = 'https://example.invalid/mcp'; f.$('extension-skip-tls-verify').checked = true;
  f.$('extension-headers').value = 'Authorization=Bearer value=with=equals';
  f.$('extension-env-keys').options = [{ getAttribute: () => 'SECRET' }];
  await f.ui.saveExtension();
  const saved = requests[0].mcps.find(item => item.id === builtin.id);
  const common = { id: builtin.id, builtin: 'browser', name: '改名后的浏览器', enabled: false, agentIds: [], transport: 'http', cwd: builtin.cwd, url: 'https://example.invalid/mcp', skipTlsVerify: true };
  assert.deepEqual(saved, { ...common, headers: { Authorization: 'Bearer value=with=equals' }, clearHeaders: [] });
  assert.deepEqual(f.closed, ['extension-dialog']);
  await f.ui.toggleExtension(builtin.id);
  assert.deepEqual(requests[1].mcps.find(item => item.id === builtin.id), { ...common, enabled: true, args: [] });
  f.ui.select(builtin.id); f.$('extension-grant-agents').options = [{ getAttribute: () => 'alice' }];
  await f.ui.saveExtensionGrant();
  assert.deepEqual(requests[2].mcps.find(item => item.id === builtin.id), { ...common, enabled: true, agentIds: ['alice'], args: [] });
  assert.equal(requests[2].mcps.find(item => item.id === 'a').command, 'fixture');
  assert.equal(requests[2].mcps.find(item => item.id === 'a').envKeys, undefined);
});

test('editing MCPs and Skills preserves both enabled states and all existing grants', async () => {
  for (const [tab,id] of [['mcps','a'],['skills','s']]) for (const enabled of [false,true]) {
    let saved;
    const f=harness(async (url,options)=>{saved=options.body;return {...saved,revision:8,agents:config().agents};});
    const value=config(), prior=value[tab].find(item=>item.id===id); prior.enabled=enabled; prior.agentIds=['alice','teacher'];
    f.ui.acceptExtensions(value); f.ui.tab(tab); f.ui.openExtension(id); f.$('extension-name').value='只更新配置名称'; await f.ui.saveExtension();
    const item=saved[tab].find(item=>item.id===id);
    assert.equal(item.enabled,enabled); assert.deepEqual([...item.agentIds],['alice','teacher']); assert.equal(item.name,'只更新配置名称');
    assert.deepEqual(prior.agentIds,['alice','teacher']);
  }
});

test('new MCPs and Skills start enabled with no grants while existing browser stays disabled', async () => {
  for (const tab of ['mcps','skills']) {
    let saved;
    const value=builtinConfig(), f=harness(async (url,options)=>{saved=options.body;return {...saved,revision:8,agents:value.agents};});
    f.ui.acceptExtensions(value); f.ui.tab(tab); f.ui.openExtension();
    f.$('extension-name').value='新扩展'; f.$('extension-command').value='fixture-command'; f.$('extension-content').value='# 技能';
    await f.ui.saveExtension();
    assert.equal(saved[tab].at(-1).enabled,true); assert.deepEqual([...saved[tab].at(-1).agentIds],[]);
    const browser=saved.mcps.find(item=>item.builtin==='browser'); assert.equal(browser.enabled,false); assert.deepEqual([...browser.agentIds],[]);
  }
});

test('KEY=VALUE parsing keeps values exact, rejects duplicate or invalid names, and treats headers case-insensitively', () => {
  const f = harness();
  f.$('secret').value = '\n API_KEY = value=with=equals  \r\nEMPTY=\nPATH=C:\\fixture\\bin\n';
  assert.deepEqual(plain(f.ui.extensionSecretInput('secret')), { API_KEY: ' value=with=equals  ', EMPTY: '', PATH: 'C:\\fixture\\bin' });
  f.$('secret').value = 'Authorization=Bearer token==\nX-Trace= abc ';
  assert.deepEqual(plain(f.ui.extensionSecretInput('secret', true)), { Authorization: 'Bearer token==', 'X-Trace': ' abc ' });
  for (const [value, header, message] of [
    ['KEY=one\nKEY=two', false, /第 2 行重复/], ['Authorization=one\nauthorization=two', true, /第 2 行重复/],
    ['no separator', false, /KEY=VALUE/], ['=value', false, /KEY=VALUE/], ['BAD KEY=value', false, /名称无效/],
    ['Header:Name=value', true, /名称无效/], ['__proto__=value', false, /名称无效/], ['constructor=value', true, /名称无效/],
    ['KEY=bad\0value', false, /值无效/]
  ]) { f.$('secret').value = value; assert.throws(() => f.ui.extensionSecretInput('secret', header), message); }
});

test('invalid key-value drafts stay open, inactive secrets are ignored, and blank inputs retain existing secrets', async () => {
  for (const transport of ['stdio', 'http', 'sse']) {
    let saved;
    const f = harness(async (url, options) => { saved = options.body; return { ...saved, revision: 8, agents: config().agents }; });
    const value = config(); value.mcps[0].cwd = 'C:\\fixture\\workspace';
    f.ui.acceptExtensions(value); f.ui.openExtension('a'); f.ui.chooseExtensionTransport(transport);
    f.$('extension-url').value = 'https://example.invalid/mcp';
    const active = transport === 'stdio' ? 'extension-env' : 'extension-headers', inactive = transport === 'stdio' ? 'extension-headers' : 'extension-env';
    f.$(active).value = 'KEY=one\nKEY=two'; f.$(inactive).value = 'not a key-value pair';
    await f.ui.saveExtension(); assert.equal(f.calls.length, 0); assert.deepEqual(f.closed, []);
    assert.equal(f.$(active).value, 'KEY=one\nKEY=two'); assert.match(f.notices[0].message, /重复/);
    f.$(active).value = '  \n'; await f.ui.saveExtension();
    assert.equal(f.calls.length, 1); assert.equal(saved.mcps[0].env, undefined); assert.equal(saved.mcps[0].headers, undefined);
    assert.equal(saved.mcps[0].cwd, value.mcps[0].cwd);
    assert.deepEqual(f.closed, ['extension-dialog']);
  }
});

test('editing another MCP or Skill preserves the built-in browser through whole-configuration saves', async () => {
  for (const [tab, id] of [['mcps', 'a'], ['skills', 's']]) {
    const value = builtinConfig(), builtin = value.mcps.at(-1);
    let saved;
    const f = harness(async (url, options) => { saved = options.body; return { ...saved, revision: 8, agents: value.agents }; });
    f.ui.acceptExtensions(value); f.ui.tab(tab); f.ui.openExtension(id);
    await f.ui.saveExtension();
    assert.deepEqual(plain(saved.mcps.find(item => item.id === builtin.id)), builtin);
    assert.equal(saved.mcps.find(item => item.id === 'a').command, 'fixture');
    assert.equal(saved.skills[0].content, '# 步骤');
  }
});

test('built-in changes keep revision-conflict protections without losing the draft while another task runs', async () => {
  const f = harness(async () => { throw Error('扩展配置已更新，请刷新后重试'); }), value = builtinConfig(), builtin = value.mcps.at(-1);
  f.ui.acceptExtensions(value); f.ui.openExtension(builtin.id); f.$('extension-name').value = '保留我的改名';
  f.state.run = { id: 'current', status: 'running' };
  await f.ui.saveExtension(); await f.ui.toggleExtension(builtin.id); assert.equal(f.calls.length, 2);
  f.state.run = null; await f.ui.saveExtension();
  assert.equal(f.calls.length, 3); assert.equal(f.ui.data().revision, value.revision);
  assert.deepEqual(plain(f.ui.data().mcps.at(-1)), builtin); assert.deepEqual(f.closed, []);
  assert.equal(f.$('extension-name').value, '保留我的改名'); assert.equal(f.notices[0].warning, true);
});
