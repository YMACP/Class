import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const extensions = source.slice(source.indexOf('  // Extension management:'), source.indexOf('  // End extension management.'));
const classroom = source.slice(source.indexOf('  // Classroom selection'), source.indexOf('  // End classroom selection.'));
const plain = value => JSON.parse(JSON.stringify(value));
const config = () => ({ revision:4, agents:[], mcps:[
  { id:'builtin-browser', builtin:'browser', name:'browser', enabled:false, agentIds:[], transport:'stdio', command:'Class', args:['--browser-mcp'] },
  { id:'custom-mcp', name:'自建工具', enabled:true, agentIds:[], transport:'http', url:'http://localhost:1000/mcp', headerKeys:['Authorization'] },
], skills:[
  { id:'builtin-skill', builtin:'ctf-web', name:'ctf-web', enabled:false, agentIds:[], content:'# Web' },
  { id:'custom-skill', name:'自建技能', enabled:true, agentIds:[], content:'# Skill' },
] });
const builtinModes = [
  { id:'web_pentest', name:'Web漏洞挖掘', icon:'shield' },
  { id:'ctf_solve', name:'CTF题目求解', icon:'answer' },
  { id:'binary_audit', name:'二进制漏洞挖掘', icon:'gdb' },
  { id:'pentest', name:'渗透测试', icon:'tscan' },
];
const modes = () => ({ revision:3, items:[
  { id:'auto', name:'自动', builtin:true, prompt:'', mcps:[], skills:[] },
  ...builtinModes.map(({ id, name }) => ({ id, name, builtin:true, prompt:`# ${name}完整提示词\n\n` + '保持原文。\n'.repeat(1000), mcps:['builtin-browser'], skills:['builtin-skill'] })),
  { id:'custom-first', name:'自建模式', builtin:false, prompt:'执行自定义任务\n', mcps:['custom-mcp'], skills:['custom-skill'] },
] });
function harness(handler) {
  const elements = new Map(), calls = [], notices = [], opened = [], closed = [];
  let savedExtensions = config(), savedModes = modes();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value:'', innerHTML:'', textContent:'', hidden:false, disabled:false, checked:false, dataset:{}, options:[], type:'', style:{}, scrollLeft:0,
      setAttribute() {}, reset() {}, getClientRects:() => [], querySelectorAll() { return this.options; }, querySelector() { return null; } });
    return elements.get(id);
  };
  const context = vm.createContext({ $, state:{ dataDir:'isolated-profile', history:[], run:null, modes:{ revision:3, items:modes().items.map(({ id,name,builtin })=>({id,name,builtin})) } },
    stateEpoch:0, token:'fixture', AbortSignal, busy:false, shutdown:false, shuttingDown:false, lastConnection:true, dataDirectorySaving:false, directoryPickerPending:false,
    viewingRun:null, viewingRequest:0, savedViewingRunId:'', clearingRunId:'', taskInputRunId:null, taskInputDirty:false,
    document:{ querySelectorAll:() => [], querySelector:() => null }, sessionStorage:{ getItem:() => null, setItem() {} },
    icon:name=>`<svg data-icon="${name}"></svg>`, esc:value=>String(value ?? '').replace(/[&<>"']/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
    terminal:status=>status !== 'running', statusNames:{ completed:'已完成' }, formatDate:() => '', roleNames:{}, requestAnimationFrame:callback=>callback(),
    dialogSessions:new Map(), openDialog:id=>opened.push(id), closeSavedDialog:id=>closed.push(id), toast:(message,error)=>notices.push({message,error}),
    api:async (url, options = {}) => {
      calls.push({ url, ...plain(options) });
      if (handler) return handler(url, options);
      if (url === '/api/modes') {
        if (options.method === 'POST') savedModes = { revision:savedModes.revision + 1, items:[...savedModes.items, { ...options.body, id:'custom-added', builtin:false }] };
        if (options.method === 'DELETE') savedModes = { revision:savedModes.revision + 1, items:savedModes.items.filter(item=>!options.body.ids.includes(item.id)) };
        return plain(savedModes);
      }
      if (url === '/api/extensions' && options.method === 'DELETE') {
        const { kind, ids } = options.body;
        savedExtensions = { ...savedExtensions, revision:savedExtensions.revision + 1, [kind]:savedExtensions[kind].filter(item=>!ids.includes(item.id)) };
        savedModes = { revision:savedModes.revision + 1, items:savedModes.items.map(item=>({ ...item, [kind]:item[kind].filter(id=>!ids.includes(id)) })) };
      }
      return plain(savedExtensions);
    },
  });
  vm.runInContext(classroom + extensions + `\nglobalThis.ui={acceptExtensions,acceptModes,renderExtensions,extensionControls,openExtensionGuide,openMode,saveMode,deleteExtension,confirmExtensionDeletion,renderTaskModeOptions,renderWorkspaceHistory,historyTaskModes,taskModeValue,
    tab(value){extensionTab=value;extensionSelected.clear();},select(...ids){extensionSelected.clear();for(const id of ids)extensionSelected.add(id);},data:()=>extensionsData,modes:()=>modesData,
    draft(value){draftMode=true;draftTaskMode=value;},history(run){draftMode=false;viewingRun=run;},deletion:()=>extensionDeletion};`, context);
  context.ui.acceptExtensions(plain(savedExtensions)); context.ui.acceptModes(plain(savedModes));
  return { $, calls, notices, opened, closed, context, ui:context.ui };
}

test('single and mixed batch deletions require confirmation and remove only custom MCPs or Skills', async () => {
  for (const kind of ['mcps', 'skills']) {
    const f = harness(), custom = kind === 'mcps' ? 'custom-mcp' : 'custom-skill', builtin = kind === 'mcps' ? 'builtin-browser' : 'builtin-skill';
    f.ui.tab(kind); f.ui.select(builtin); f.ui.renderExtensions();
    assert.equal(f.$('extensions-delete').disabled, true);
    f.ui.deleteExtension(builtin); assert.equal(f.opened.length, 0);
    f.ui.select(builtin, custom); f.ui.renderExtensions(); assert.equal(f.$('extensions-delete').disabled, false);
    const card = f.$('extensions-content').innerHTML.split('<article').find(part=>part.includes(`data-extension-select="${custom}"`));
    assert.ok(card.indexOf('data-extension-guide=') < card.indexOf('data-extension-delete='));
    assert.match(card, /aria-haspopup="dialog">删除<\/button>/);
    f.ui.deleteExtension(); assert.equal(f.calls.length, 0); assert.equal(f.opened.at(-1), 'extension-delete-dialog');
    assert.match(f.$('extension-delete-note').textContent, /1 项内置项目将保留/);
    assert.doesNotMatch(f.$('extension-delete-items').innerHTML, /browser|ctf-web/);
    await f.ui.confirmExtensionDeletion();
    assert.deepEqual(f.calls[0], { url:'/api/extensions', method:'DELETE', body:{ revision:4, ids:[custom], kind } });
    assert.equal(f.ui.data()[kind].length, 1); assert.equal(f.ui.data()[kind][0].id, builtin);
    assert.equal(f.closed.at(-1), 'extension-delete-dialog'); assert.equal(f.$('extensions-delete').disabled, true);
    assert.deepEqual(plain(f.ui.modes().items.find(item=>item.id === 'custom-first')[kind]), []);
  }
});

test('deletion remains pending on conflicts, can update later-task configuration and cannot cross a profile switch', async () => {
  const f = harness(async () => { throw Error('配置已更新，请刷新后重试'); });
  f.ui.deleteExtension('custom-mcp'); await f.ui.confirmExtensionDeletion();
  assert.equal(f.calls.length, 1); assert.equal(f.closed.length, 0); assert.equal(f.ui.data().mcps.length, 2);
  assert.match(f.notices.at(-1).message, /配置已更新/);
  f.context.state.run = { status:'running' }; await f.ui.confirmExtensionDeletion(); assert.equal(f.calls.length, 2);
  f.context.state.run = null; f.context.state.dataDir = 'different-profile'; await f.ui.confirmExtensionDeletion();
  assert.equal(f.calls.length, 2); assert.match(f.notices.at(-1).message, /数据目录已更改/);
});

test('mode creation sends exact prompt and associations, retains revisions and adds the classroom option', async () => {
  const f = harness(), prompt = '# 自定义\n\n第一步\n</textarea><script>fixture()</script>\n';
  f.ui.tab('modes'); f.ui.openMode();
  assert.equal(f.$('mode-dialog-title').textContent, '添加模式'); assert.equal(f.$('mode-save-actions').hidden, false);
  assert.match(f.$('mode-mcps').innerHTML, /data-mode-mcp="builtin-browser"/); assert.match(f.$('mode-mcps').innerHTML, /data-mode-mcp="custom-mcp"/);
  f.$('mode-name').value = '  自定义<模式>  '; f.$('mode-prompt').value = prompt;
  f.$('mode-mcps').options = ['builtin-browser', 'custom-mcp'].map(id=>({getAttribute:()=>id}));
  f.$('mode-skills').options = ['custom-skill'].map(id=>({getAttribute:()=>id}));
  await f.ui.saveMode();
  assert.deepEqual(f.calls[0], { url:'/api/modes', method:'POST', body:{ revision:3, extensionRevision:4, name:'自定义<模式>', prompt, mcps:['builtin-browser','custom-mcp'], skills:['custom-skill'] } });
  assert.equal(f.closed.at(-1), 'mode-dialog'); assert.match(f.$('task-mode').innerHTML, /value="custom-added">自定义&lt;模式&gt;/);
  assert.doesNotMatch(f.$('extensions-content').innerHTML, /<script>|自定义<模式>/);
});

test('mode details show complete read-only prompt and exactly the associated extensions even during a running task', async () => {
  for (const { id } of builtinModes) {
    const f = harness(), item = modes().items.find(mode => mode.id === id); f.ui.tab('modes'); f.context.state.run = { status:'running' }; f.ui.openMode(id);
    assert.equal(f.opened.at(-1), 'mode-dialog'); assert.equal(f.$('mode-dialog-title').textContent, item.name); assert.equal(f.$('mode-prompt').value, item.prompt);
    assert.equal(f.$('mode-prompt').readOnly, true); assert.equal(f.$('mode-name').readOnly, true); assert.equal(f.$('mode-save-actions').hidden, true);
    assert.match(f.$('mode-mcps').innerHTML, /builtin-browser.*checked disabled/); assert.doesNotMatch(f.$('mode-mcps').innerHTML, /custom-mcp/);
    await f.ui.saveMode(); assert.equal(f.calls.length, 0);
  }
});

for (const { id, name, icon } of builtinModes) test(`${id} is selectable before and after mode refresh and shares its existing icon between history and the protected builtin card`, () => {
  const f = harness(), initialOptions = html.match(/<select id="task-mode"[\s\S]*?<\/select>/)?.[0];
  assert.ok(initialOptions.includes(`<option value="${id}">${name}</option>`));
  assert.ok(html.includes(`<symbol id="i-${icon}"`));
  f.context.state.modes = null; f.ui.draft(id); f.ui.renderTaskModeOptions();
  assert.equal(f.$('task-mode').value, id); assert.ok(f.$('task-mode').innerHTML.includes(`value="${id}">${name}`));
  f.context.state.history = [{ id:`run-${id}`, task:`${name}任务`, status:'completed', taskMode:id }];
  f.ui.acceptModes(modes());
  assert.equal(f.$('task-mode').value, id); assert.match(f.$('task-mode').innerHTML, /value="custom-first">自建模式/);
  assert.deepEqual(plain(f.ui.historyTaskModes().find(mode => mode.value === id)), { value:id, label:name, icon });
  const group = f.$('workspace-history-content').innerHTML.split('<section').find(part => part.includes(`data-history-mode="${id}"`));
  assert.ok(group.includes(`data-icon="${icon}"`)); assert.ok(group.includes(name));
  f.ui.tab('modes'); f.ui.select(id); f.ui.renderExtensions();
  const card = f.$('extensions-content').innerHTML.split('<article').find(part => part.includes(`data-extension-select="${id}"`));
  assert.ok(card.includes(`data-icon="${icon}"`)); assert.ok(card.includes(`data-mode-view="${id}">${name}`)); assert.match(card, />内置</);
  assert.doesNotMatch(card, /data-extension-delete=/); assert.equal(f.$('extensions-delete').disabled, true);
  f.ui.deleteExtension(id); f.ui.deleteExtension(); assert.equal(f.ui.deletion(), null); assert.equal(f.calls.length, 0);
  assert.doesNotMatch(f.$('extensions-content').innerHTML, /data-mode-view="auto"|data-extension-select="auto"/);
});

test('custom mode deletion retains associated extensions and historical name while preventing new selection', async () => {
  const f = harness(), before = plain(f.ui.data()), historical = { id:'run-old', task:'旧任务', status:'completed', taskMode:'custom-first', taskModeName:'自建模式', startedAt:'2026-01-01' };
  f.context.state.history = [historical]; f.ui.tab('modes'); f.ui.select('auto',...builtinModes.map(mode => mode.id),'custom-first'); f.ui.renderExtensions();
  assert.equal(f.$('extensions-grant').hidden, true);
  assert.doesNotMatch(f.$('extensions-content').innerHTML, /data-mode-view="auto"|data-extension-select="auto"/);
  assert.match(f.$('extensions-content').innerHTML, /data-mode-view="web_pentest"/);
  assert.equal(f.$('extensions-selection-count').textContent, '已选择 5 项');
  assert.equal(f.$('extensions-select-all').checked, true);
  assert.ok(f.ui.modes().items.some(item => item.id === 'auto'));
  f.ui.draft('auto'); f.ui.renderTaskModeOptions();
  assert.match(f.$('task-mode').innerHTML, /value="auto">自动<\/option>/);
  assert.equal(f.$('task-mode').value, 'auto');
  assert.match(f.$('task-mode').title, /沿用已启用并授权的MCP和Skill/);
  for (const id of ['auto',...builtinModes.map(mode => mode.id)]) { f.ui.deleteExtension(id); assert.equal(f.ui.deletion(), null); }
  f.ui.deleteExtension(); assert.match(f.$('extension-delete-note').textContent, /4 项内置项目将保留/);
  assert.match(f.$('extension-delete-note').textContent, /关联的MCP和Skills及历史对话不会删除/);
  await f.ui.confirmExtensionDeletion();
  assert.deepEqual(f.calls[0], { url:'/api/modes', method:'DELETE', body:{ revision:3, ids:['custom-first'] } });
  assert.deepEqual(plain(f.ui.data()), before);
  assert.match(f.$('workspace-history-content').innerHTML, /data-history-mode="custom-first"/);
  assert.match(f.$('workspace-history-content').innerHTML, /自建模式/);
  f.ui.history(historical); f.ui.renderTaskModeOptions(); assert.equal(f.$('task-mode').value, 'custom-first');
  f.ui.draft('custom-first'); f.ui.renderTaskModeOptions(); assert.equal(f.$('task-mode').value, 'auto');
  assert.doesNotMatch(f.$('task-mode').innerHTML, /custom-first/);
});

test('custom guides do not expose saved credentials, parameters or private endpoints', () => {
  const f = harness(), value = config();
  value.mcps[1] = { ...value.mcps[1], name:'<img src=x>', command:'PRIVATE_COMMAND', args:['PRIVATE_ARG'], url:'https://private.invalid?token=PRIVATE_KEY', env:{ TOKEN:'PRIVATE_ENV' }, headers:{ Authorization:'PRIVATE_HEADER' } };
  f.ui.acceptExtensions(value); f.ui.openExtensionGuide('custom-mcp');
  const guide = f.$('extension-guide-content').innerHTML;
  assert.match(guide, /http服务/); assert.doesNotMatch(guide, /PRIVATE_|private.invalid|<img/);
  f.ui.tab('skills'); f.ui.openExtensionGuide('custom-skill'); assert.match(f.$('extension-guide-content').innerHTML, /Markdown正文/);
});

test('mode creation failure keeps the draft and the opening revisions for a safe retry', async () => {
  const f = harness(async () => { throw Error('扩展配置已更新'); });
  f.ui.tab('modes'); f.ui.openMode(); f.$('mode-name').value = '保留草稿'; f.$('mode-prompt').value = '保留完整正文\n';
  f.ui.acceptExtensions({ ...config(), revision:99 });
  await f.ui.saveMode();
  assert.equal(f.calls[0].body.extensionRevision, 4); assert.equal(f.closed.length, 0);
  assert.equal(f.$('mode-name').value, '保留草稿'); assert.equal(f.$('mode-prompt').value, '保留完整正文\n');
  assert.match(f.notices.at(-1).message, /扩展配置已更新/);
});

test('modal confirmation and mode UI controls are wired with explicit labels', () => {
  assert.match(html, /data-extension-tab="mcps"[\s\S]*data-extension-tab="skills"[\s\S]*data-extension-tab="modes"/);
  assert.match(html, /id="extensions-delete"[^>]*aria-label="删除所选项目"/);
  const dialog = html.match(/<dialog[^>]*id="extension-delete-dialog"[\s\S]*?<\/dialog>/)?.[0];
  assert.match(dialog, /data-dialog-close="extension-delete-dialog">取消/); assert.match(dialog, /id="extension-delete-confirm">确认/);
  assert.match(source, /\$\('extension-delete-confirm'\)\.addEventListener\('click',confirmExtensionDeletion\)/);
  assert.match(source, /\$\('mode-form'\)\.addEventListener\('submit'/);
});
