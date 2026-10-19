import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createClassServer } from '../../src/web-server.js';
import { findBrowserExecutable } from '../../src/browser-tools.js';

// Isolated source-server UI verification. Configures fixtures and mocks only
// the connection-test response; never starts tasks, model calls or MCP commands.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = await fs.realpath(process.env.CLASS_UI_VERIFY_DIR || os.tmpdir());
const directory = await fs.mkdtemp(path.join(outputRoot, 'class-extensions-ui-'));
const dataDir = path.join(directory, 'profile'), token = randomBytes(32).toString('hex');
const report = { passed: false, directory, checks: [], screenshots: [], pageErrors: [], startedAt: new Date().toISOString() };
let server, child, socket, evaluate, action, cdp;
const check = value => { report.checks.push(value); console.log('PASS ' + value); };
const presetTypes = ['browser', 'burpsuite', 'tscan', 'jadx', 'x64dbg', 'ida', 'cyberchef', 'wireshark', 'windbg', 'ghidra', 'gdb', 'sagemath', 'pwntools', 'metasploit', 'bloodhound', 'zsteg', 'binwalk', 'aflpp'];
const presetDisplayName = type => ({ sagemath: 'sageMath', aflpp: 'AFL++' })[type] ?? type;
const reversePresets = [
  { builtin: 'tscan', url: 'http://127.0.0.1:8088/mcp', description: '综合性Web安全分析工具' },
  { builtin: 'jadx', url: 'http://127.0.0.1:8651/mcp', description: 'Android反编译与代码分析工具' },
  { builtin: 'x64dbg', url: 'http://127.0.0.1:9094/', description: '对Windows程序进行动态调试' },
  { builtin: 'ida', url: 'http://127.0.0.1:8737/mcp', description: '反汇编与反编译二进制程序' },
  { builtin: 'ghidra', url: 'http://127.0.0.1:8081/mcp', description: '分析二进制程序与反编译代码' },
  { builtin: 'gdb', url: 'http://127.0.0.1:8000/mcp', description: '对Linux程序进行动态调试' },
  { builtin: 'metasploit', url: 'http://127.0.0.1:3000/', description: '渗透测试框架' },
];
const stdioPresets = [
  { builtin: 'cyberchef', command: 'cmd.exe', args: ['/d', '/s', '/c', 'cyberchef-mcp'], description: '数据分析工具' },
  { builtin: 'wireshark', ...(process.platform === 'linux' ? { command: 'wireshark-mcp', args: ['serve', '--transport', 'stdio', '--profile', 'analysis'] } : { command: 'python', args: ['-m', 'wireshark_mcp', 'serve', '--transport', 'stdio', '--profile', 'analysis'] }), description: '网络流量分析工具' },
  { builtin: 'windbg', command: 'python', args: ['-m', 'mcp_windbg', '--transport', 'stdio'], description: '二进制漏洞分析工具' },
  { builtin: 'sagemath', command: 'sagemath-mcp', args: ['--transport', 'stdio'], description: '数学与密码分析工具' },
  { builtin: 'pwntools', command: 'Class', args: ['--local-analysis-mcp', 'pwntools'], description: '二进制题目分析工具' },
  { builtin: 'bloodhound', command: 'bloodhound-mcp', args: [], description: '域环境关系分析工具' },
  { builtin: 'zsteg', command: 'Class', args: ['--local-analysis-mcp', 'zsteg'], description: '图片隐写分析工具' },
  { builtin: 'binwalk', command: 'Class', args: ['--local-analysis-mcp', 'binwalk'], description: '固件分析与提取工具' },
  { builtin: 'aflpp', command: 'aflpp-mcp', args: [], description: '模糊测试工具' },
];
const additionalPresets = [...reversePresets.map(preset => ({ ...preset, transport: 'http' })), ...stdioPresets.map(preset => ({ ...preset, transport: 'stdio' }))];
const customMcps = config => config.mcps.filter(item => !presetTypes.includes(item.builtin));
const builtinBrowser = config => config.mcps.find(item => item.builtin === 'browser');
const builtinBurp = config => config.mcps.find(item => item.builtin === 'burpsuite');
const mcp = (config, id) => { const item = config.mcps.find(entry => entry.id === id); assert.ok(item, 'MCP remains present: ' + id); return item; };
const builtinSkills = config => config.skills.filter(item => typeof item.builtin === 'string' && item.builtin);
const customSkills = config => config.skills.filter(item => !item.builtin);
const skillEntry = (config, id) => { const item = config.skills.find(entry => entry.id === id); assert.ok(item, 'Skill remains present: ' + id); return item; };
async function waitFor(predicate, label) { const end = Date.now() + 15000; do { if (await predicate()) return; await delay(50); } while (Date.now() < end); throw Error('Timed out: ' + label); }
const uiWait = (expression, label) => waitFor(() => evaluate(expression), label);
const click = selector => action({ action: 'click', selector });
const fill = (selector, text) => action({ action: 'fill', selector, text });
async function screenshot(name) { await delay(200); const response = await action({ action: 'screenshot' }), filename = path.join(directory, name + '.png'); await fs.writeFile(filename, Buffer.from(response.media[0].data, 'base64')); report.screenshots.push(filename); }
async function select(id, value) { if (id === 'extension-transport') return click(`[data-extension-transport="${value}"]`); await evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function verifyEditorControls() {
  const state=await evaluate(`(()=>{const form=document.getElementById('extension-form'),name=document.getElementById('extension-name');return {removed:!form.querySelector('#extension-enabled,#extension-agent-choices,[data-extension-agent]'),nameWidth:name.getBoundingClientRect().width,formWidth:form.getBoundingClientRect().width};})()`);
  assert.equal(state.removed,true,'Shared editor has no enabled checkbox or member authorization controls');
  assert.ok(Math.abs(state.nameWidth-state.formWidth)<=1,'Name input occupies the full form width');
}
async function saveDialog() { await verifyEditorControls(); await click('#extension-save'); await uiWait(`!document.getElementById('extension-dialog').open`, 'extension saved'); }
async function grantExtension(id, agentIds) {
  const selected=await evaluate(`Array.from(document.querySelectorAll('[data-extension-select]:checked'),node=>node.dataset.extensionSelect)`);
  for (const selectedId of selected) await click(`[data-extension-select="${selectedId}"]`);
  await click(`[data-extension-select="${id}"]`); await click('#extensions-grant');
  for (const agentId of agentIds) await click(`[data-grant-agent="${agentId}"]`);
  await click('#extension-grant-save'); await uiWait(`!document.getElementById('extension-grant-dialog').open`,'external member grants saved');
  await click(`[data-extension-select="${id}"]`);
}
async function textareaMetrics(id) {
  return evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)}),s=getComputedStyle(e),r=e.getBoundingClientRect();return {height:r.height,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,lineHeight:parseFloat(s.lineHeight),padding:parseFloat(s.paddingTop)+parseFloat(s.paddingBottom),border:parseFloat(s.borderTopWidth)+parseFloat(s.borderBottomWidth),overflow:s.overflowY,rows:e.rows};})()`);
}
async function verifyAutogrow(id, viewport) {
  const original=await evaluate(`document.getElementById(${JSON.stringify(id)}).value`), states={};
  for (const [name,value] of [['one','a'],['two','a\nb'],['three','a\nb\nc'],['overflow','a\nb\nc\nd\ne'],['softWrap','long-value-'.repeat(150)],['cleared','']]) {
    await fill('#'+id,value); await delay(40); states[name]=await textareaMetrics(id);
  }
  assert.equal(states.one.rows,1,id+' starts with one row');
  assert.ok(Math.abs(states.one.height-(states.one.lineHeight+states.one.padding+states.one.border))<=2,id+' single-line height');
  assert.ok(states.two.height>states.one.height+states.one.lineHeight-2,id+' grows to second line');
  assert.ok(states.three.height>states.two.height+states.one.lineHeight-2,id+' grows to third line');
  assert.ok(Math.abs(states.overflow.height-states.three.height)<=2,id+' stops at three lines');
  for (const name of ['overflow','softWrap']) {
    assert.ok(states[name].scrollHeight>states[name].clientHeight,id+' '+name+' scrolls');
    assert.equal(states[name].overflow,'auto',id+' '+name+' enables vertical scrolling');
    assert.ok(states[name].height<=states.three.height+2,id+' '+name+' stays within three lines');
  }
  assert.ok(Math.abs(states.cleared.height-states.one.height)<=2,id+' shrinks when cleared');
  assert.equal(states.cleared.overflow,'hidden',id+' clears unnecessary scrollbar');
  (report.autogrow??={})[viewport+'-'+id]=states;
  await fill('#'+id,original);
}
async function verifyGuides(config, viewport) {
  assert.equal(await evaluate(`document.querySelectorAll('[data-extension-guide]').length`), presetTypes.length);
  await evaluate(`window.__guidePausePolling=true;window.__guideFetchCalls=[];window.__guideOriginalFetch=window.fetch;window.fetch=(...args)=>{window.__guideFetchCalls.push(String(args[0]));return window.__guideOriginalFetch(...args);};`);
  try {
    for (const type of presetTypes) {
      const item = config.mcps.find(entry => entry.builtin === type);
      const placement = await evaluate(`(()=>{const button=document.querySelector('[data-extension-guide="${item.id}"]'),row=button.closest('.extension-card-actions'),r=button.getBoundingClientRect(),p=row.getBoundingClientRect();return {text:button.textContent.trim(),className:button.className,disabled:button.disabled,right:r.right,rowRight:p.right,otherRight:Math.max(0,...[...row.querySelectorAll('button')].filter(e=>e!==button&&e.getBoundingClientRect().bottom>r.top+1).map(e=>e.getBoundingClientRect().right)),left:r.left};})()`);
      assert.equal(placement.text, '配置指南'); assert.match(placement.className, /extension-guide-button/); assert.equal(placement.disabled, false);
      assert.ok(Math.abs(placement.right-placement.rowRight)<=2 && placement.left>=placement.otherRight, type + ' guide is the rightmost aligned card action');
      await click(`[data-extension-guide="${item.id}"]`);
      await uiWait(`document.getElementById('extension-guide-dialog').open`, type + ' guide opens');
      const guide = await evaluate(`(()=>{const dialog=document.getElementById('extension-guide-dialog'),content=document.getElementById('extension-guide-content'),r=dialog.getBoundingClientRect();return {title:document.getElementById('extension-guide-title').textContent,text:content.textContent,steps:content.querySelectorAll('ol>li').length,code:content.querySelectorAll('code').length,controls:content.querySelectorAll('input,select,textarea,form,button').length,links:[...content.querySelectorAll('a')].map(a=>({href:a.getAttribute('href'),target:a.target,rel:a.rel})),left:r.left,right:r.right,width:r.width,viewport:document.documentElement.clientWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,contentOverflow:dialog.scrollWidth>dialog.clientWidth+1};})()`);
      assert.equal(guide.title, presetDisplayName(type) + ' 配置指南'); assert.ok(guide.steps>=3); assert.equal(guide.controls, 0);
      if(type==='tscan') { assert.match(guide.text,/127\.0\.0\.1:8088\/mcp/); assert.match(guide.text,/Streamable HTTP/); assert.match(guide.text,/MCP服务配置/); }
      if(type==='jadx') { assert.match(guide.text,/127\.0\.0\.1:8651\/mcp/); assert.match(guide.text,/jadx_mcp_server\.py/); assert.match(guide.text,/--http/); }
      if(type==='wireshark' && config.platform==='linux') { assert.match(guide.text,/wireshark-mcp/); assert.doesNotMatch(guide.text,/Program Files|Npcap/); }
      assert.ok(guide.links.length>0, type + ' includes setup/download links');
      for (const link of guide.links) { assert.equal(new URL(link.href).protocol,'https:'); assert.equal(link.target,'_blank'); const rel=link.rel.split(/\s+/); assert.ok(rel.includes('noopener') && rel.includes('noreferrer')); }
      assert.doesNotMatch(guide.text, /-ui-fixture|fixture-[a-z0-9]+-(?:env|header|never-run)|fixture-env-secret/);
      assert.ok(guide.left>=0 && guide.right<=guide.viewport+1, type + ' guide fits ' + viewport);
      assert.equal(guide.pageOverflow,false); assert.equal(guide.contentOverflow,false);
      (report.guides??=[]).push({type,viewport,steps:guide.steps,code:guide.code,links:guide.links,width:guide.width});
      if(type==='ghidra') await screenshot('extensions-guide-'+viewport);
      if(type==='tscan') await screenshot('extensions-guide-tscan-'+viewport);
      if(['wireshark','sagemath','aflpp'].includes(type)) await screenshot('extensions-guide-'+type+'-'+viewport);
      await click('[data-dialog-close="extension-guide-dialog"]');
      await uiWait(`!document.getElementById('extension-guide-dialog').open`, type + ' guide closes');
    }
    assert.deepEqual(await evaluate('window.__guideFetchCalls'),[], 'Opening and closing guides does not call the API or fetch remote content');
  } finally { await evaluate('window.fetch=window.__guideOriginalFetch;delete window.__guideOriginalFetch;delete window.__guideFetchCalls;delete window.__guidePausePolling;'); }
  check('all preset read-only guides open and close through real '+viewport+' clicks with right-aligned buttons, safe links and no horizontal overflow or network calls');
}
async function verifyConnectionTests(config, viewport) {
  assert.equal(await evaluate(`document.querySelectorAll('[data-extension-test]').length`), config.mcps.length);
  for (const item of config.mcps) {
    assert.ok(await evaluate(`(()=>{const button=document.querySelector('[data-extension-test="${item.id}"]'),toggle=document.querySelector('[data-extension-toggle="${item.id}"]'),r=button.getBoundingClientRect(),t=toggle.getBoundingClientRect(),row=button.closest('.extension-card-actions').getBoundingClientRect();return button.textContent==='测试连接'&&toggle.nextElementSibling===button&&r.left>=t.right&&Math.abs(r.top-t.top)<2&&r.right<=row.right+1;})()`), item.name + ' test button is beside its toggle');
  }
  await evaluate(`window.__extensionTestCalls=[];window.__extensionTestOriginalFetch=window.fetch;window.fetch=(url,options)=>String(url)==='/api/extensions/test'?new Promise(resolve=>{window.__extensionTestCalls.push({method:options.method,body:JSON.parse(options.body)});window.__extensionTestFinish=(body,status=200)=>{delete window.__extensionTestFinish;resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));};}):window.__extensionTestOriginalFetch(url,options);`);
  const target = config.mcps.find(item => !item.builtin) || config.mcps.find(item => item.builtin === 'cyberchef');
  const failed = config.mcps.find(item => item.builtin === 'wireshark'), rejected = config.mcps.find(item => item.builtin === 'windbg');
  try {
    await click(`[data-extension-test="${target.id}"]`);
    await uiWait(`document.querySelector('[data-extension-test="${target.id}"]').textContent==='测试中…'`, 'connection test pending');
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-extension-test]')).every(button=>button.disabled)`), true);
    assert.equal(await evaluate(`document.querySelector('[data-extension-toggle="${target.id}"]').disabled`), false, 'Test does not lock enable/disable');
    assert.equal(await evaluate(`document.querySelector('[data-extension-edit="${target.id}"]').disabled`), false, 'Test does not lock editing');
    await evaluate(`document.querySelector('[data-extension-test="${target.id}"]').click()`);
    assert.deepEqual(await evaluate('window.__extensionTestCalls'), [{ method: 'POST', body: { id: target.id, revision: config.revision } }]);
    await click('[data-extension-tab="skills"]');
    assert.equal(await evaluate(`document.querySelector('[data-extension-test],[data-extension-test-result]')===null`), true, 'Skills have no MCP connection tests');
    await click('[data-extension-tab="mcps"]');
    assert.equal(await evaluate(`document.querySelector('[data-extension-test="${target.id}"]').textContent`), '测试中…');
    await evaluate(`window.__extensionTestFinish({ok:true,toolCount:23,durationMs:10})`);
    await uiWait(`document.querySelector('[data-extension-test-result="${target.id}"]')?.textContent==='连接成功，发现 23 个工具。'`, 'connection success shows tool count');
    await click('[data-extension-tab="skills"]'); await click('[data-extension-tab="mcps"]');
    assert.equal(await evaluate(`document.querySelector('[data-extension-test-result="${target.id}"]').textContent`), '连接成功，发现 23 个工具。');
    await click(`[data-extension-test="${failed.id}"]`);
    await evaluate(`window.__extensionTestFinish({ok:false,message:'未找到MCP程序 <img src=x onerror="fixtureAttack()">',code:'MCP_ERROR',durationMs:5})`);
    await uiWait(`document.querySelector('[data-extension-test-result="${failed.id}"]')?.textContent.includes('未找到MCP程序')`, 'connection failure explains reason');
    assert.equal(await evaluate(`document.querySelector('[data-extension-test-result="${failed.id}"] img')===null`), true, 'Failure text is escaped');
    await click(`[data-extension-test="${rejected.id}"]`);
    await evaluate(`window.__extensionTestFinish({error:'扩展配置已更新，请刷新后重试'},409)`);
    await uiWait(`document.querySelector('[data-extension-test-result="${rejected.id}"]')?.textContent.includes('请刷新后重试')`, 'connection API error is shown');
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-extension-test]')).some(button=>button.disabled)`), false);
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
    (report.connectionTests??=[]).push({ viewport, target: target.builtin || 'custom', requests: await evaluate('window.__extensionTestCalls'), mocked: true });
    await evaluate(`document.querySelector('[data-extension-test="${failed.id}"]').scrollIntoView({block:'center'})`);
    await screenshot('extensions-connection-test-' + viewport);
  } finally {
    await evaluate(`window.__extensionTestFinish?.({ok:false,message:'测试已结束'});window.fetch=window.__extensionTestOriginalFetch;delete window.__extensionTestOriginalFetch;delete window.__extensionTestCalls;delete window.__extensionTestFinish;`);
  }
  check(viewport + ' MCP connection tests show pending/success/failure/API-error states, serialize clicks, survive tab switches and omit Skill actions with mocked transport');
}
try {
  await fs.mkdir(dataDir, { mode: 0o700 }); const assets = {};
  for (const [route, name, contentType] of [['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/style.css', 'style.css', 'text/css; charset=utf-8'], ['/class-icon.svg', 'class-icon.svg', 'image/svg+xml'], ['/favicon.ico', 'class-icon.ico', 'image/x-icon']]) assets[route] = { body: await fs.readFile(path.join(root, 'public', name)), contentType };
  server = await createClassServer({ dataDir, token, assets }); console.log('READY isolated source server');
  const api = async (route, body) => {
    const response = await fetch(server.url + route, { signal: AbortSignal.timeout(15000), method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  const update = async config => { const response = await fetch(server.url + '/api/extensions', { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(config) }); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value; };
  for (const [name, role] of [['测试老师', 'teacher'], ['测试学生甲', 'student'], ['测试学生乙', 'student']]) await api('/api/agents', { name, role, protocol: 'messages', baseUrl: 'http://127.0.0.1:1', model: 'isolated-unused-model', apiKey: 'isolated-unused-key' });
  console.log('READY fixture agents');
  const initialConfig = await api('/api/extensions'), agents = initialConfig.agents, teacher = agents.find(item => item.role === 'teacher').id, students = agents.filter(item => item.role === 'student').map(item => item.id);
  assert.equal(initialConfig.skills.length, 29); assert.equal(builtinSkills(initialConfig).length, 29); assert.equal(customSkills(initialConfig).length, 0);
  assert.equal(new Set(initialConfig.skills.map(item => item.builtin)).size, 29);
  for (const item of initialConfig.skills) { assert.equal(item.enabled, false); assert.deepEqual(item.agentIds, []); }
  assert.equal(initialConfig.platform, process.platform);
  const platformPresets = ['tscan', 'jadx', ...(process.platform === 'win32' ? ['x64dbg', 'ida', 'cyberchef', 'wireshark', 'windbg'] : process.platform === 'linux' ? ['ghidra', 'gdb', 'wireshark', 'sagemath', 'pwntools', 'metasploit', 'bloodhound', 'zsteg', 'binwalk', 'aflpp'] : [])];
  assert.deepEqual(initialConfig.mcps.map(item => item.builtin), ['browser', 'burpsuite', ...platformPresets], 'Fresh profile contains only presets for the server OS');
  for (const type of platformPresets) {
    const preset = initialConfig.mcps.find(item => item.builtin === type), expected = additionalPresets.find(item => item.builtin === type);
    assert.equal(preset.name, presetDisplayName(type)); assert.equal(preset.transport, expected.transport);
    if (expected.transport === 'stdio') { assert.equal(preset.command, expected.command); assert.deepEqual(preset.args, expected.args); }
    else { assert.equal(preset.url, expected.url); assert.equal(preset.skipTlsVerify, false); }
    assert.equal(preset.enabled, false); assert.deepEqual(preset.agentIds, []);
    assert.deepEqual(preset.envKeys, []); assert.deepEqual(preset.headerKeys, []);
  }
  report.platformDefaults = { platform: process.platform, presets: initialConfig.mcps.map(({ builtin, transport, url, command, args }) => ({ builtin, transport, url, command, args })) };
  const initialBrowser = builtinBrowser(initialConfig); assert.ok(initialBrowser, 'Fresh profile includes built-in browser');
  assert.equal(customMcps(initialConfig).length, 0); assert.equal(initialBrowser.enabled, false); assert.deepEqual(initialBrowser.agentIds, []);
  assert.equal(initialBrowser.transport, 'stdio'); assert.equal(initialBrowser.command, 'Class'); assert.deepEqual(initialBrowser.args, ['--browser-mcp']);
  const builtin = initialBrowser.id;
  const initialBurp = builtinBurp(initialConfig); assert.ok(initialBurp, 'Fresh profile includes Burp Suite');
  assert.equal(initialBurp.name, 'burpsuite'); assert.equal(initialBurp.transport, 'sse'); assert.equal(initialBurp.url, 'http://127.0.0.1:9876');
  assert.equal(initialBurp.enabled, false); assert.deepEqual(initialBurp.agentIds, []); assert.equal(initialBurp.skipTlsVerify, false);
  assert.deepEqual(initialBurp.envKeys, []); assert.deepEqual(initialBurp.headerKeys, []);
  const burp = initialBurp.id;
  report.burpsuiteDefault = initialBurp;
  console.log('READY extension API');
  const executablePath = await findBrowserExecutable(); console.log('READY installed browser');
  const browserDir = path.join(directory, 'browser'); await fs.mkdir(browserDir);
  child = spawn(executablePath, ['--headless=new', '--do-not-de-elevate', '--noerrdialogs', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + browserDir, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', 'about:blank'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError, port; child.once('error', error => { launchError = error; }); child.stderr.resume();
  await waitFor(async () => { if (launchError) throw launchError; if (child.exitCode !== null) throw Error('Isolated Chrome exited during launch'); try { port = (await fs.readFile(path.join(browserDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return /^\d+$/.test(port); } catch { return false; } }, 'isolated Chrome CDP');
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); socket = new WebSocket(targets.find(item => item.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { const request = pending.get(message.id); if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result); } } if (message.method === 'Runtime.exceptionThrown') report.pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text); if (message.method === 'Page.javascriptDialogOpening') { (report.confirmations??=[]).push(message.params.message); cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); } });
  cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  evaluate = async expression => { const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  action = async args => {
    if (args.action === 'screenshot') { const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); return { media: [{ data: result.data }] }; }
    if (args.action === 'press') { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: args.key, code: args.key }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: args.key, code: args.key }); return; }
    if (args.action === 'fill') return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(args.selector)});if(!e||e.disabled)throw Error('Missing/disabled field');e.scrollIntoView({block:'center'});e.focus();Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(args.text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    let point;
    // Success toasts can briefly cover cards at the bottom of a long list. Wait
    // for an actual hit-testable target, retaining real pointer interactions.
    await waitFor(async () => {
      point = await evaluate(`(async()=>{const e=document.querySelector(${JSON.stringify(args.selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=e.getBoundingClientRect();if(!r.width||!r.height)return null;const point={x:r.x+r.width/2,y:r.y+r.height/2};return e.contains(document.elementFromPoint(point.x,point.y))?point:null;})()`);
      return Boolean(point);
    }, 'clickable button: ' + args.selector);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  await cdp('Runtime.enable', {}); await cdp('Page.enable', {});
  // Pause only the recurring state refresh during the no-fetch guide check.
  // Direct refresh calls and every fetch remain observable; all other timers
  // retain native behavior. Install before app.js captures its interval callback.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    const nativeSetInterval=window.setInterval;
    window.setInterval=function(callback,milliseconds,...args){
      if(typeof callback!=='function'||milliseconds!==1200)return nativeSetInterval.call(this,callback,milliseconds,...args);
      return nativeSetInterval.call(this,function(...callbackArgs){
        if(window.__guidePausePolling!==true)return callback.apply(this,callbackArgs);
      },milliseconds,...args);
    };
  })();` });
  await cdp('Browser.setDownloadBehavior', { behavior: 'deny' }); await cdp('Page.navigate', { url: server.url + '/#token=' + token });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  await uiWait(`document.getElementById('connection-status').textContent.includes('已连接')`, 'UI connection');
  await click('[data-page="extensions"]'); await uiWait(`!document.getElementById('extension-add').disabled`, 'extension data loaded');
  const builtinCard = await evaluate(`document.querySelector('[data-extension-edit="${builtin}"]').closest('article').innerText`);
  assert.ok(!builtinCard.includes('内置')); assert.match(builtinCard, /对浏览器执行自动化操作/); assert.match(builtinCard, /已停用/); assert.match(builtinCard, /尚未授权成员/);
  assert.equal(await evaluate(`document.querySelector('[data-extension-edit="${builtin}"]').closest('article').querySelector('.extension-mark use').getAttribute('href')`), '#i-browser');
  assert.equal(await evaluate(`document.querySelector('[data-extension-delete="${builtin}"]')===null`), true);
  const burpCard = await evaluate(`document.querySelector('[data-extension-edit="${burp}"]').closest('article').innerText`);
  assert.match(burpCard, /burpsuite/); assert.match(burpCard, /调用Web测试神器burpsuite/); assert.match(burpCard, /已停用/); assert.match(burpCard, /尚未授权成员/);
  assert.equal(await evaluate(`document.querySelector('[data-extension-edit="${burp}"]').closest('article').querySelector('.extension-mark use').getAttribute('href')`), '#i-burpsuite');
  assert.equal(await evaluate(`document.querySelector('[data-extension-delete="${burp}"]')===null`), true);
  assert.equal(await evaluate(`document.querySelectorAll('#extensions-content .extension-card').length`), initialConfig.mcps.length);
  for (const type of platformPresets) {
    const preset = initialConfig.mcps.find(item => item.builtin === type);
    assert.equal(await evaluate(`document.querySelector('[data-extension-edit="${preset.id}"]').closest('article').querySelector('.extension-mark use').getAttribute('href')`), '#i-' + type);
  }
  await screenshot('extensions-builtin-default-desktop');
  check('fresh API and UI show the current server OS presets without seeding other-platform entries');
  // Only this isolated profile receives the other platform's entries, modeling a
  // migrated profile. The production UI must render every marker the API returns.
  const migrated = await api('/api/extensions');
  for (const preset of additionalPresets) {
    let item = migrated.mcps.find(entry => entry.builtin === preset.builtin);
    if (!item) { item = { id: 'fixture-' + preset.builtin, builtin: preset.builtin, name: presetDisplayName(preset.builtin), transport: preset.transport, ...(preset.transport === 'stdio' ? { command: preset.command, args: [...preset.args] } : { url: preset.url, skipTlsVerify: false }), enabled: false, agentIds: [] }; migrated.mcps.push(item); }
    item.env = { FIXTURE_PRESET_TOKEN: 'fixture-' + preset.builtin + '-env' };
  }
  const allPresets = await update(migrated);
  assert.deepEqual(new Set(allPresets.mcps.map(item => item.builtin)), new Set(presetTypes));
  await click('#extensions-refresh'); await uiWait(`document.querySelectorAll('#extensions-content .extension-card').length===${presetTypes.length} && !document.getElementById('extension-add').disabled`, 'migrated preset fixtures loaded');
  for (const preset of additionalPresets) {
    const item = allPresets.mcps.find(entry => entry.builtin === preset.builtin);
    const card = await evaluate(`(()=>{const card=document.querySelector('[data-extension-edit="${item.id}"]').closest('article');return {text:card.innerText,icon:card.querySelector('.extension-mark use').getAttribute('href'),badge:!!card.querySelector('.extension-kind'),remove:!!card.querySelector('[data-extension-delete]')};})()`);
    assert.ok(card.text.includes(preset.description)); assert.match(card.text, /已停用/); assert.match(card.text, /尚未授权成员/);
    assert.equal(card.icon, '#i-' + preset.builtin); assert.equal(card.badge, false); assert.equal(card.remove, false);
  }
  await screenshot('extensions-all-presets-desktop');
  await verifyGuides(allPresets,'desktop');
  assert.deepEqual(await api('/api/extensions'),allPresets,'Reading desktop guides preserves the entire extension configuration');
  await verifyConnectionTests(allPresets, 'desktop');
  assert.deepEqual(await api('/api/extensions'),allPresets,'Connection tests preserve disabled states, member grants, credentials and revision');
  await click(`[data-extension-edit="${builtin}"]`);
  const builtinEditorState = () => evaluate(`(()=>{const fields=document.getElementById('extension-mcp-fields');return {hidden:fields.hidden,visible:!!fields.getClientRects().length,commandRequired:document.getElementById('extension-command').required,urlRequired:document.getElementById('extension-url').required,skillHidden:document.getElementById('extension-skill-fields').hidden,transportOptions:[...document.getElementById('extension-transport').options].map(option=>option.value)};})()`);
  assert.deepEqual(await builtinEditorState(), { hidden: false, visible: true, commandRequired: true, urlRequired: false, skillHidden: true, transportOptions: ['stdio', 'http', 'sse'] });
  await verifyEditorControls();
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-extension-transport]'),button=>button.textContent.trim())`),['stdio','http','sse']);
  assert.deepEqual(await evaluate(`Array.from(document.getElementById('extension-transport').options,option=>option.textContent)`),['stdio','http','sse']);
  assert.equal(await evaluate(`document.getElementById('extension-dialog-title').textContent`), '编辑配置');
  assert.equal(await evaluate(`document.getElementById('extension-command').value`), 'Class'); assert.equal(await evaluate(`document.getElementById('extension-args').value`), '--browser-mcp');
  assert.equal(await evaluate(`document.getElementById('extension-transport').hidden && document.querySelector('#extension-cwd')===null`), true);
  await click('[data-extension-transport="stdio"]'); await action({ action: 'press', key: 'ArrowRight' });
  assert.equal(await evaluate(`document.getElementById('extension-transport').value`), 'http');
  assert.equal(await evaluate(`document.activeElement.dataset.extensionTransport`), 'http');
  assert.equal(await evaluate(`document.querySelector('[data-extension-transport="http"]').getAttribute('aria-checked')`), 'true');
  assert.equal(await evaluate(`document.getElementById('extension-command').disabled && !document.getElementById('extension-url').disabled && !document.getElementById('extension-skip-tls-verify').checked`), true);
  await action({ action: 'press', key: 'End' }); assert.equal(await evaluate(`document.getElementById('extension-transport').value`), 'sse');
  await action({ action: 'press', key: 'Home' }); assert.equal(await evaluate(`document.getElementById('extension-transport').value`), 'stdio');
  await fill('#extension-name', '浏览器验收');
  await screenshot('extensions-builtin-editor-desktop'); await saveDialog();
  let savedBrowser = builtinBrowser(await api('/api/extensions'));
  assert.equal(savedBrowser.id, builtin); assert.equal(savedBrowser.name, '浏览器验收'); assert.equal(savedBrowser.enabled, false); assert.deepEqual(savedBrowser.agentIds, []);
  assert.equal(savedBrowser.command, 'Class'); assert.deepEqual(savedBrowser.args, ['--browser-mcp']);
  for (const key of ['env', 'headers']) assert.equal(Object.hasOwn(savedBrowser, key), false, 'Browser never exposes secret values: ' + key);
  await grantExtension(builtin,[teacher]);
  assert.equal(builtinBrowser(await api('/api/extensions')).enabled,false,'External grants do not enable the paused browser');
  await click(`[data-extension-toggle="${builtin}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${builtin}"]').textContent==='停用'`, 'browser enabled outside editor');
  await click('#extensions-refresh'); await uiWait(`!document.getElementById('extension-add').disabled`, 'built-in configuration refresh');
  await click(`[data-extension-toggle="${builtin}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${builtin}"]').textContent==='启用'`, 'built-in disabled');
  assert.equal(builtinBrowser(await api('/api/extensions')).enabled, false);
  await click(`[data-extension-toggle="${builtin}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${builtin}"]').textContent==='停用'`, 'built-in enabled');
  await cdp('Page.reload', { ignoreCache: true }); await uiWait(`document.getElementById('connection-status').textContent.includes('已连接')`, 'built-in page reload');
  await click('[data-page="extensions"]'); await uiWait(`!document.getElementById('extension-add').disabled`, 'built-in reload data');
  await click(`[data-extension-edit="${builtin}"]`);
  assert.equal(await evaluate(`document.getElementById('extension-name').value`), '浏览器验收');
  assert.equal((await builtinEditorState()).visible, true); await saveDialog();
  savedBrowser=builtinBrowser(await api('/api/extensions')); assert.equal(savedBrowser.enabled,true); assert.deepEqual(savedBrowser.agentIds,[teacher]);
  check('browser edits preserve disabled/enabled states and grants; shared full-width editor has no enable/member controls, lowercase protocol labels and external controls still work');
  const browserBeforeBurp = structuredClone(savedBrowser);
  await click(`[data-extension-edit="${burp}"]`);
  assert.deepEqual(await builtinEditorState(), { hidden: false, visible: true, commandRequired: false, urlRequired: true, skillHidden: true, transportOptions: ['stdio', 'http', 'sse'] });
  await verifyEditorControls();
  assert.equal(await evaluate(`document.getElementById('extension-dialog-title').textContent`), '编辑配置');
  assert.equal(await evaluate(`document.getElementById('extension-name').value`), 'burpsuite');
  assert.equal(await evaluate(`document.getElementById('extension-transport').value`), 'sse');
  assert.equal(await evaluate(`document.querySelector('[data-extension-transport="sse"]').getAttribute('aria-checked')`), 'true');
  assert.equal(await evaluate(`document.getElementById('extension-url').value`), 'http://127.0.0.1:9876');
  assert.equal(await evaluate(`document.getElementById('extension-command').disabled && !document.getElementById('extension-url').disabled && !document.getElementById('extension-skip-tls-verify').checked && document.getElementById('extension-headers').value === ''`), true);
  await screenshot('extensions-burpsuite-default-editor-desktop');
  const burpFixtureUrl = 'http://127.0.0.1:1/burp-ui-fixture';
  await fill('#extension-url', burpFixtureUrl); await saveDialog();
  let burpConfig = await api('/api/extensions'), savedBurp = builtinBurp(burpConfig);
  assert.equal(savedBurp.id, burp); assert.equal(savedBurp.url, burpFixtureUrl); assert.equal(savedBurp.enabled, false); assert.deepEqual(savedBurp.agentIds, []);
  assert.deepEqual(builtinBrowser(burpConfig), browserBeforeBurp, 'Editing the disabled Burp preset preserves browser configuration');
  await grantExtension(burp, [teacher]);
  burpConfig = await api('/api/extensions'); savedBurp = builtinBurp(burpConfig);
  assert.equal(savedBurp.enabled, false); assert.deepEqual(savedBurp.agentIds, [teacher]);
  assert.deepEqual(builtinBrowser(burpConfig), browserBeforeBurp, 'Burp member grants preserve browser configuration');
  await click(`[data-extension-toggle="${burp}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${burp}"]').textContent==='停用'`, 'Burp enabled outside editor');
  await click(`[data-extension-edit="${burp}"]`); await saveDialog();
  burpConfig = await api('/api/extensions'); savedBurp = builtinBurp(burpConfig);
  assert.equal(savedBurp.enabled, true); assert.deepEqual(savedBurp.agentIds, [teacher]); assert.equal(savedBurp.url, burpFixtureUrl);
  assert.deepEqual(builtinBrowser(burpConfig), browserBeforeBurp, 'Editing the enabled Burp preset preserves browser configuration');
  await click(`[data-extension-toggle="${burp}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${burp}"]').textContent==='启用'`, 'Burp disabled outside editor');
  await cdp('Page.reload', { ignoreCache: true }); await uiWait(`document.getElementById('connection-status').textContent.includes('已连接')`, 'Burp page reload');
  await click('[data-page="extensions"]'); await uiWait(`!document.getElementById('extension-add').disabled`, 'Burp reload data');
  await click(`[data-extension-edit="${burp}"]`);
  assert.equal(await evaluate(`document.getElementById('extension-url').value`), burpFixtureUrl);
  assert.equal(await evaluate(`document.getElementById('extension-transport').value`), 'sse');
  await screenshot('extensions-burpsuite-edited-editor-desktop'); await click('[data-dialog-close="extension-dialog"]');
  burpConfig = await api('/api/extensions'); savedBurp = builtinBurp(burpConfig);
  assert.equal(savedBurp.enabled, false); assert.deepEqual(savedBurp.agentIds, [teacher]);
  assert.equal(burpConfig.mcps.filter(item => item.builtin === 'burpsuite').length, 1);
  assert.deepEqual(builtinBrowser(burpConfig), browserBeforeBurp, 'Burp toggles and reload preserve browser configuration');
  check('Burp Suite default card/icon/SSE URL, disabled and ungranted state, shared editor, URL edits, independent grants, toggles and reload persistence preserve browser');
  const priorSharedPresets = (await api('/api/extensions')).mcps.filter(item => ['browser', 'burpsuite'].includes(item.builtin));
  for (const preset of reversePresets) {
    const item = allPresets.mcps.find(entry => entry.builtin === preset.builtin), fixtureUrl = 'https://127.0.0.1:1/' + preset.builtin + '-ui-fixture';
    await click(`[data-extension-edit="${item.id}"]`);
    assert.deepEqual(await builtinEditorState(), { hidden: false, visible: true, commandRequired: false, urlRequired: true, skillHidden: true, transportOptions: ['stdio', 'http', 'sse'] });
    assert.equal(await evaluate(`document.getElementById('extension-transport').value`), 'http');
    assert.equal(await evaluate(`document.getElementById('extension-url').value`), preset.url);
    assert.equal(await evaluate(`document.getElementById('extension-env').value + document.getElementById('extension-headers').value`), '');
    await fill('#extension-name', preset.builtin + '验收'); await fill('#extension-url', fixtureUrl);
    await click('#extension-skip-tls-verify'); await fill('#extension-headers', 'Authorization=Bearer fixture-' + preset.builtin + '-header==');
    await saveDialog();
    let saved = mcp(await api('/api/extensions'), item.id);
    assert.equal(saved.builtin, preset.builtin); assert.equal(saved.enabled, false); assert.deepEqual(saved.agentIds, []);
    await grantExtension(item.id, [teacher]);
    saved = mcp(await api('/api/extensions'), item.id);
    assert.equal(saved.enabled, false); assert.deepEqual(saved.agentIds, [teacher]);
    await click(`[data-extension-toggle="${item.id}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${item.id}"]').textContent==='停用'`, preset.builtin + ' enabled outside editor');
    await click(`[data-extension-edit="${item.id}"]`);
    assert.equal(await evaluate(`document.getElementById('extension-headers').value`), '');
    assert.equal(await evaluate(`document.querySelector('[data-clear-header="Authorization"]')!==null`), true);
    await saveDialog();
    saved = mcp(await api('/api/extensions'), item.id);
    assert.equal(saved.enabled, true); assert.deepEqual(saved.agentIds, [teacher]);
    assert.equal(saved.builtin, preset.builtin); assert.equal(saved.name, preset.builtin + '验收');
    assert.equal(saved.url, fixtureUrl); assert.equal(saved.skipTlsVerify, true);
    assert.deepEqual(saved.envKeys, ['FIXTURE_PRESET_TOKEN']); assert.deepEqual(saved.headerKeys, ['Authorization']);
    assert.ok(!JSON.stringify(saved).includes('fixture-' + preset.builtin + '-header'));
    assert.ok(!await evaluate(`document.body.innerText.includes('fixture-${preset.builtin}-header') || document.body.innerText.includes('fixture-${preset.builtin}-env')`));
    await click(`[data-extension-toggle="${item.id}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${item.id}"]').textContent==='启用'`, preset.builtin + ' disabled outside editor');
  }
  assert.deepEqual((await api('/api/extensions')).mcps.filter(item => ['browser', 'burpsuite'].includes(item.builtin)), priorSharedPresets);
  check('all HTTP presets use the shared editor and preserve markers, disabled/enabled states, grants and hidden credentials across save and external controls');
  const beforeStdioPresets = (await api('/api/extensions')).mcps.filter(item => !stdioPresets.some(preset => preset.builtin === item.builtin));
  for (const preset of stdioPresets) {
    const item = allPresets.mcps.find(entry => entry.builtin === preset.builtin), fixtureCommand = 'fixture-' + preset.builtin + '-never-run', fixtureArgs = [...preset.args, '--fixture', 'two words'];
    await click(`[data-extension-edit="${item.id}"]`);
    assert.deepEqual(await builtinEditorState(), { hidden: false, visible: true, commandRequired: true, urlRequired: false, skillHidden: true, transportOptions: ['stdio', 'http', 'sse'] });
    assert.equal(await evaluate(`document.getElementById('extension-transport').value`), 'stdio');
    assert.equal(await evaluate(`document.getElementById('extension-command').value`), preset.command);
    assert.equal(await evaluate(`document.getElementById('extension-args').value`), preset.args.join(' '));
    assert.equal(await evaluate(`document.getElementById('extension-env').value + document.getElementById('extension-headers').value`), '');
    await fill('#extension-name', preset.builtin + '验收'); await fill('#extension-command', fixtureCommand);
    await fill('#extension-args', preset.args.join(' ') + ' --fixture "two words"');
    await screenshot('extensions-' + preset.builtin + '-editor-desktop'); await saveDialog();
    let saved = mcp(await api('/api/extensions'), item.id);
    assert.equal(saved.builtin, preset.builtin); assert.equal(saved.enabled, false); assert.deepEqual(saved.agentIds, []);
    assert.equal(saved.command, fixtureCommand); assert.deepEqual(saved.args, fixtureArgs);
    await grantExtension(item.id, [teacher]);
    saved = mcp(await api('/api/extensions'), item.id); assert.equal(saved.enabled, false); assert.deepEqual(saved.agentIds, [teacher]);
    await click(`[data-extension-toggle="${item.id}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${item.id}"]').textContent==='停用'`, preset.builtin + ' enabled outside editor');
    await click(`[data-extension-edit="${item.id}"]`);
    assert.equal(await evaluate(`document.getElementById('extension-env').value`), '');
    assert.equal(await evaluate(`document.querySelector('[data-clear-env="FIXTURE_PRESET_TOKEN"]')!==null`), true);
    await saveDialog();
    saved = mcp(await api('/api/extensions'), item.id);
    assert.equal(saved.builtin, preset.builtin); assert.equal(saved.name, preset.builtin + '验收'); assert.equal(saved.transport, 'stdio');
    assert.equal(saved.enabled, true); assert.deepEqual(saved.agentIds, [teacher]);
    assert.equal(saved.command, fixtureCommand); assert.deepEqual(saved.args, fixtureArgs);
    assert.deepEqual(saved.envKeys, ['FIXTURE_PRESET_TOKEN']); assert.deepEqual(saved.headerKeys, []);
    assert.ok(!JSON.stringify(saved).includes('fixture-' + preset.builtin + '-env'));
    assert.ok(!await evaluate(`document.body.innerText.includes('fixture-${preset.builtin}-env')`));
    await click(`[data-extension-toggle="${item.id}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${item.id}"]').textContent==='启用'`, preset.builtin + ' disabled outside editor');
  }
  assert.deepEqual((await api('/api/extensions')).mcps.filter(item => !stdioPresets.some(preset => preset.builtin === item.builtin)), beforeStdioPresets);
  check('all platform stdio editors preserve commands, quoted arguments, markers and hidden environment values through saves, grants and toggles without affecting other presets');
  await click('#extension-add'); await fill('#extension-name', '本地文档工具'); await fill('#extension-command', 'fixture-command-never-run');
  assert.equal(await evaluate(`document.getElementById('extension-mcp-fields').hidden`), false);
  assert.equal(await evaluate(`document.getElementById('extension-command').required`), true);
  for (const [id,label] of [['extension-command','命令'],['extension-args','参数(空格分隔)'],['extension-env','环境变量(KEY=VALUE)']]) assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)}).closest('label').firstChild.textContent.trim()`),label);
  await verifyAutogrow('extension-args','desktop'); await verifyAutogrow('extension-env','desktop');
  await fill('#extension-args', '--fixture "value with spaces"');
  await fill('#extension-env', 'FIXTURE_TOKEN=fixture-env-secret=with=equals'); await saveDialog();
  let config = await api('/api/extensions'); assert.equal(customMcps(config).length, 1); const first = customMcps(config)[0].id;
  assert.equal(await evaluate(`document.querySelector('[data-extension-guide="${first}"]')===null`),true,'Custom MCPs have no preset guide');
  assert.equal(mcp(config,first).enabled,true); assert.deepEqual(mcp(config,first).agentIds,[],'New MCP starts without member grants');
  await grantExtension(first,[teacher]); config=await api('/api/extensions');
  assert.deepEqual(mcp(config, first).args, ['--fixture', 'value with spaces']); assert.deepEqual(mcp(config, first).agentIds, [teacher]); assert.deepEqual(mcp(config, first).envKeys, ['FIXTURE_TOKEN']); assert.ok(!JSON.stringify(config).includes('fixture-env-secret'));
  // Seed existing values through the isolated API; hidden working directories
  // and inactive header credentials must survive ordinary stdio edits.
  const legacyArgs=['--fixture','value with spaces','','C:\\Program Files\\Class\\','say "hello"',"single'quote",'back\\\\slash'];
  mcp(config, first).args=legacyArgs; mcp(config, first).cwd=directory; mcp(config, first).headers = { 'X-Fixture': 'fixture-header-secret' }; await update(config);
  await click('#extensions-refresh'); await uiWait(`!document.getElementById('extension-add').disabled`, 'private fixture refresh');
  await click(`[data-extension-edit="${first}"]`); assert.equal(await evaluate(`document.getElementById('extension-env').value`), ''); assert.equal(await evaluate(`document.getElementById('extension-headers').value==='' && document.getElementById('extension-remote-fields').hidden`), true);
  report.mcpEditor = await evaluate(`(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};};return {dialog:rect('extension-dialog'),controls:rect('extension-transport-controls'),name:rect('extension-name'),args:rect('extension-args'),env:rect('extension-env')};})()`);
  assert.ok(report.mcpEditor.controls.bottom < report.mcpEditor.name.y && report.mcpEditor.args.bottom < report.mcpEditor.env.y, 'Transport selectors come first and inputs occupy separate rows');
  assert.ok(Math.abs(report.mcpEditor.args.x-report.mcpEditor.env.x)<1, 'MCP input left edges align');
  assert.ok(Math.abs(report.mcpEditor.args.width-report.mcpEditor.env.width)<1, 'MCP inputs use the full row');
  assert.equal(report.mcpEditor.dialog.width,580,'MCP editor retains compact desktop width');
  await screenshot('extensions-mcp-editor-desktop');
  report.mcpFooter = await evaluate(`(()=>{const dialog=document.getElementById('extension-dialog');dialog.scrollTop=dialog.scrollHeight;const actions=dialog.querySelector('.dialog-actions'),button=document.getElementById('extension-save'),r=button.getBoundingClientRect(),d=dialog.getBoundingClientRect();return {actionsPaddingTop:getComputedStyle(actions).paddingTop,dialogPaddingBottom:getComputedStyle(dialog).paddingBottom,buttonTop:r.top,buttonBottom:r.bottom,dialogBottom:d.bottom};})()`);
  assert.equal(report.mcpFooter.actionsPaddingTop, '18px'); assert.equal(report.mcpFooter.dialogPaddingBottom, '16px'); assert.ok(report.mcpFooter.buttonBottom<report.mcpFooter.dialogBottom, 'Save button fully visible at the bottom');
  await screenshot('extensions-mcp-editor-footer');
  await action({ action: 'press', key: 'Escape' }); assert.equal(await evaluate(`document.getElementById('extension-dialog').open`), true); await saveDialog();
  config = await api('/api/extensions'); assert.deepEqual(mcp(config, first).envKeys, ['FIXTURE_TOKEN']); assert.deepEqual(mcp(config, first).headerKeys, ['X-Fixture']); assert.equal(mcp(config, first).cwd,directory); assert.deepEqual(mcp(config, first).args,legacyArgs,'Existing arguments survive edit/save including quotes, empty values and Windows paths');
  await click(`[data-extension-edit="${first}"]`); const argumentsBeforeError=await evaluate(`document.getElementById('extension-args').value`);
  await fill('#extension-args','--fixture "unfinished'); await click('#extension-save'); await uiWait(`!!document.querySelector('#extension-dialog .dialog-feedback')`, 'unclosed quote feedback');
  assert.equal(await evaluate(`document.getElementById('extension-dialog').open`),true); assert.equal(await evaluate(`document.getElementById('extension-args').value`),'--fixture "unfinished'); assert.deepEqual(mcp(await api('/api/extensions'), first).args,legacyArgs,'Malformed arguments cannot overwrite saved values');
  await fill('#extension-args',argumentsBeforeError); await saveDialog();
  await click(`[data-extension-edit="${first}"]`);
  await fill('#extension-env', 'FIXTURE_TOKEN=one\nFIXTURE_TOKEN=two'); await click('#extension-save');
  await uiWait(`document.querySelector('#extension-dialog .dialog-feedback')?.textContent.includes('重复')`, 'duplicate environment key feedback');
  assert.equal(await evaluate(`document.getElementById('extension-dialog').open`), true); assert.equal(await evaluate(`document.getElementById('extension-env').value`), 'FIXTURE_TOKEN=one\nFIXTURE_TOKEN=two');
  await fill('#extension-env', '{"KEY":"value"}'); await click('#extension-save');
  await uiWait(`document.querySelector('#extension-dialog .dialog-feedback')?.textContent.includes('KEY=VALUE')`, 'legacy JSON environment feedback');
  assert.equal(await evaluate(`document.getElementById('extension-dialog').open`), true);
  await fill('#extension-env', ''); await saveDialog();
  check('MCP argument quote parsing, legacy array round trip, invalid-input draft preservation and one-to-three-line auto-growth');
  check('MCP creation, member grants, secret non-disclosure and blank-preserve save');
  await click('#extension-add'); await fill('#extension-name', '远程知识工具'); await select('extension-transport', 'http'); await fill('#extension-url', 'http://127.0.0.1:1/mcp');
  assert.equal(await evaluate(`document.getElementById('extension-skip-tls-verify').checked`), false);
  assert.equal(await evaluate(`document.getElementById('extension-url').closest('label').firstChild.textContent.trim()`), 'MCP服务器地址');
  await verifyAutogrow('extension-headers', 'desktop');
  await fill('#extension-headers', 'Authorization=Bearer fixture-unused-remote-key=='); await click('#extension-skip-tls-verify'); await screenshot('extensions-http-editor-desktop'); await saveDialog();
  config = await api('/api/extensions'); const second = customMcps(config).find(item => item.id !== first).id;
  assert.equal(mcp(config, second).skipTlsVerify, true); assert.deepEqual(mcp(config, second).headerKeys, ['Authorization']);
  await click('#extensions-refresh'); await uiWait(`!document.getElementById('extension-add').disabled`, 'remote credential fixture refresh');
  await click('#extensions-select-all'); await click('#extensions-grant'); await click(`[data-grant-agent="${students[0]}"]`); await click(`[data-grant-agent="${students[1]}"]`); await click('#extension-grant-save'); await uiWait(`!document.getElementById('extension-grant-dialog').open`, 'bulk grants');
  config = await api('/api/extensions'); assert.deepEqual(new Set(mcp(config, first).agentIds), new Set([teacher, ...students])); assert.deepEqual(new Set(mcp(config, second).agentIds), new Set(students));
  assert.deepEqual(new Set(builtinBrowser(config).agentIds), new Set([teacher, ...students])); assert.equal(builtinBrowser(config).id, builtin); assert.equal(builtinBrowser(config).enabled, true);
  assert.deepEqual(new Set(builtinBurp(config).agentIds), new Set([teacher, ...students])); assert.equal(builtinBurp(config).id, burp); assert.equal(builtinBurp(config).enabled, false);
  await click(`[data-extension-edit="${second}"]`); assert.equal(await evaluate(`document.getElementById('extension-headers').value`), '');
  await fill('#extension-headers', 'Authorization=one\nauthorization=two'); await click('#extension-save');
  await uiWait(`document.querySelector('#extension-dialog .dialog-feedback')?.textContent.includes('重复')`, 'case-insensitive duplicate header feedback');
  assert.equal(await evaluate(`document.getElementById('extension-dialog').open`), true); await fill('#extension-headers','');
  await select('extension-transport', 'sse'); await saveDialog(); config=await api('/api/extensions'); assert.equal(mcp(config, second).transport, 'sse'); assert.equal(mcp(config, second).skipTlsVerify,true); assert.deepEqual(mcp(config, second).headerKeys, ['Authorization']); assert.ok(!JSON.stringify(config).includes('fixture-unused-remote-key'));
  await click(`[data-extension-edit="${second}"]`); await screenshot('extensions-sse-editor-desktop'); await click('[data-dialog-close="extension-dialog"]');
  await screenshot('extensions-mcp-desktop'); check('multiple MCP selection and bulk grants preserve old permissions; HTTP and SSE editor');
  await click(`[data-extension-edit="${builtin}"]`); await select('extension-transport', 'http');
  await fill('#extension-url', 'https://127.0.0.1:1/browser-ui-fixture'); await click('#extension-skip-tls-verify');
  await fill('#extension-headers', 'X-Browser=fixture-browser-header=='); await saveDialog();
  config = await api('/api/extensions'); savedBrowser=builtinBrowser(config);
  assert.equal(config.mcps.filter(item=>item.builtin==='browser').length,1); assert.equal(savedBrowser.id,builtin); assert.equal(savedBrowser.transport,'http'); assert.equal(savedBrowser.skipTlsVerify,true); assert.deepEqual(savedBrowser.headerKeys,['X-Browser']);
  assert.equal(savedBrowser.url,'https://127.0.0.1:1/browser-ui-fixture'); assert.ok(!JSON.stringify(config).includes('fixture-browser-header'));
  await click('#extensions-refresh'); await uiWait(`!document.getElementById('extension-add').disabled`, 'browser external transport refresh');
  await click(`[data-extension-edit="${builtin}"]`);
  assert.equal(await evaluate(`document.getElementById('extension-transport').value`),'http'); assert.equal(await evaluate(`document.getElementById('extension-skip-tls-verify').checked`),true); assert.equal(await evaluate(`document.getElementById('extension-headers').value`),'');
  assert.equal(await evaluate(`document.getElementById('extension-url').value`),'https://127.0.0.1:1/browser-ui-fixture');
  await select('extension-transport','sse'); await saveDialog();
  config=await api('/api/extensions'); savedBrowser=builtinBrowser(config);
  assert.equal(savedBrowser.transport,'sse'); assert.equal(savedBrowser.skipTlsVerify,true); assert.deepEqual(savedBrowser.headerKeys,['X-Browser']); assert.equal(config.mcps.filter(item=>item.builtin==='browser').length,1);
  await click(`[data-extension-edit="${builtin}"]`); await click('[data-clear-header="X-Browser"]'); await saveDialog();
  assert.deepEqual(builtinBrowser(await api('/api/extensions')).headerKeys,[]);
  await click(`[data-extension-edit="${builtin}"]`); await fill('#extension-url','not a valid URL'); await select('extension-transport','stdio');
  await fill('#extension-command','Class'); await fill('#extension-args','--browser-mcp'); await saveDialog();
  config=await api('/api/extensions'); savedBrowser=builtinBrowser(config);
  assert.equal(savedBrowser.id,builtin); assert.equal(savedBrowser.transport,'stdio'); assert.equal(savedBrowser.command,'Class'); assert.deepEqual(savedBrowser.args,['--browser-mcp']); assert.equal(config.mcps.filter(item=>item.builtin==='browser').length,1); assert.equal(customMcps(config).length,2);
  assert.equal(await evaluate(`document.querySelector('[data-extension-edit="${builtin}"]').closest('article').querySelector('.extension-mark use').getAttribute('href')`),'#i-browser');
  assert.equal(await evaluate(`document.querySelector('[data-extension-delete="${builtin}"]')===null`),true);
  check('browser HTTP/SSE/stdio saves retain one preset and grants, preserve URL/TLS/header settings on refresh, explicitly delete headers, and ignore inactive invalid URL validation');
  await click('[data-extension-tab="skills"]');
  config = await api('/api/extensions'); assert.deepEqual(builtinSkills(config), builtinSkills(initialConfig), 'Earlier MCP edits preserve every default Skill and its marker');
  assert.equal(await evaluate(`document.querySelectorAll('#extensions-content .extension-card').length`), 29);
  assert.equal(await evaluate(`document.querySelector('#extensions-content .extension-kind')===null && !document.getElementById('extensions-content').innerText.includes('MARKDOWN SKILL')`), true);
  assert.equal(await evaluate(`document.querySelector('#extensions-content [data-extension-delete],#extensions-content [data-extension-guide],#extensions-content [data-extension-test]')===null`), true);
  for (const item of builtinSkills(config)) {
    const card = await evaluate(`document.querySelector('[data-extension-edit="${item.id}"]').closest('article').innerText`);
    assert.match(card, /已停用/); assert.match(card, /尚未授权成员/);
  }
  const mcpGrantsBeforeSkill = (await api('/api/extensions')).mcps.map(({ id, agentIds }) => ({ id, agentIds }));
  const originalBuiltinSkill = builtinSkills(config)[0], builtinSkillId = originalBuiltinSkill.id;
  await click(`[data-extension-toggle="${builtinSkillId}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${builtinSkillId}"]').textContent==='停用'`, 'builtin Skill enabled');
  let savedBuiltinSkill = skillEntry(await api('/api/extensions'), builtinSkillId);
  assert.equal(savedBuiltinSkill.enabled, true); assert.deepEqual(savedBuiltinSkill.agentIds, []); assert.equal(savedBuiltinSkill.builtin, originalBuiltinSkill.builtin);
  await grantExtension(builtinSkillId, [teacher]);
  await click(`[data-extension-edit="${builtinSkillId}"]`);
  assert.equal(await evaluate(`document.getElementById('extension-content').value`), originalBuiltinSkill.content);
  const builtinMarkdown = originalBuiltinSkill.content + '\n\n## 隔离界面验收\n保留内置资源标识和独立成员授权。';
  await fill('#extension-description', '内置 Skill 编辑验收'); await fill('#extension-content', builtinMarkdown); await saveDialog();
  savedBuiltinSkill = skillEntry(await api('/api/extensions'), builtinSkillId);
  assert.equal(savedBuiltinSkill.builtin, originalBuiltinSkill.builtin); assert.equal(savedBuiltinSkill.content, builtinMarkdown);
  assert.equal(savedBuiltinSkill.description, '内置 Skill 编辑验收'); assert.equal(savedBuiltinSkill.enabled, true); assert.deepEqual(savedBuiltinSkill.agentIds, [teacher]);
  config = await api('/api/extensions');
  assert.deepEqual(builtinSkills(config).filter(item => item.id !== builtinSkillId), builtinSkills(initialConfig).filter(item => item.id !== builtinSkillId));
  assert.equal(await evaluate(`document.querySelector('[data-extension-delete="${builtinSkillId}"]')===null`), true);
  await screenshot('extensions-builtin-skills-desktop');
  check('29 builtin Skill cards default disabled and ungranted, forbid deletion, and real enable/grant/Markdown edit clicks preserve the builtin marker without changing other Skills');
  await click('#extension-add');
  assert.equal(await evaluate(`document.querySelector('#extension-mcp-choices,[data-skill-mcp]')===null && !document.getElementById('extension-dialog').textContent.includes('关联 MCP') && !document.getElementById('extension-dialog').textContent.includes('关联MCP')`), true, 'Skill editor has no associated-MCP controls');
  await fill('#extension-name', '证据核对'); await fill('#extension-description', '核对来源后再提交结论'); const markdown = '# 证据核对\n\n1. 读取来源\n2. 核对结果\n\n`保留原始内容`'; await fill('#extension-content', markdown); await saveDialog();
  config = await api('/api/extensions'); assert.equal(customSkills(config).length, 1); const skill = customSkills(config)[0].id;
  assert.equal(await evaluate(`document.querySelector('#extensions-content .extension-kind')===null && !document.getElementById('extensions-content').innerText.includes('MARKDOWN SKILL')`), true, 'Custom and builtin Skills have no type badge');
  assert.equal(skillEntry(config, skill).content, markdown); assert.equal(Object.hasOwn(skillEntry(config, skill), 'mcpIds'), false, 'Public Skill configuration has no MCP associations');
  assert.equal(Object.hasOwn(skillEntry(config, skill), 'builtin'), false, 'New custom Skill does not acquire a builtin marker');
  assert.equal(skillEntry(config, skill).enabled,true); assert.deepEqual(skillEntry(config, skill).agentIds,[],'New Skill starts without member grants'); await grantExtension(skill,[teacher]);
  await grantExtension(skill, [students[0]]);
  await click(`[data-extension-toggle="${skill}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${skill}"]').textContent==='启用'`, 'skill stopped'); assert.equal(skillEntry(await api('/api/extensions'), skill).enabled, false);
  await click(`[data-extension-edit="${skill}"]`); await fill('#extension-description','暂停期间仍可编辑配置'); await saveDialog();
  config=await api('/api/extensions'); assert.equal(skillEntry(config, skill).enabled,false); assert.deepEqual(skillEntry(config, skill).agentIds,[teacher,students[0]]);
  assert.deepEqual(skillEntry(config, builtinSkillId), savedBuiltinSkill, 'Custom Skill grants and edits do not change the builtin Skill');
  await click(`[data-extension-toggle="${skill}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${skill}"]').textContent==='停用'`, 'skill enabled');
  config = await api('/api/extensions'); assert.deepEqual(config.mcps.map(({ id, agentIds }) => ({ id, agentIds })), mcpGrantsBeforeSkill, 'Skill grants and toggles do not alter MCP authorization');
  const skillGrantsBeforeMcp = config.skills.map(({ id, agentIds }) => ({ id, agentIds }));
  await click('[data-extension-tab="mcps"]'); await grantExtension(second,[teacher]);
  config = await api('/api/extensions'); assert.deepEqual(config.skills.map(({ id, agentIds }) => ({ id, agentIds })), skillGrantsBeforeMcp, 'MCP member changes do not alter Skill authorization');
  await cdp('Page.reload', { ignoreCache: true }); await uiWait(`document.getElementById('connection-status').textContent.includes('已连接')`, 'reload'); await click('[data-page="extensions"]'); await uiWait(`!document.getElementById('extension-add').disabled`, 'reloaded extensions'); await click('[data-extension-tab="skills"]');
  await click(`[data-extension-edit="${skill}"]`); assert.equal(await evaluate(`document.getElementById('extension-content').value`), markdown); await verifyEditorControls();
  report.skillEditorWidth=await evaluate(`document.getElementById('extension-dialog').getBoundingClientRect().width`); assert.equal(report.skillEditorWidth,580, 'Skill editor uses the same compact width as MCP');
  assert.equal(report.skillEditorWidth,report.mcpEditor.dialog.width); await fill('#extension-description', '编辑后仍独立授权'); await saveDialog();
  config = await api('/api/extensions'); assert.equal(skillEntry(config, skill).description, '编辑后仍独立授权'); assert.equal(skillEntry(config, skill).content, markdown); assert.equal(Object.hasOwn(skillEntry(config, skill), 'mcpIds'), false); assert.deepEqual(skillEntry(config, skill).agentIds, [teacher, students[0]]);
  assert.deepEqual(skillEntry(config, builtinSkillId), savedBuiltinSkill, 'Reload and unrelated edits retain the builtin Skill marker, edited body, enabled state and grants');
  await click(`[data-extension-edit="${skill}"]`); await evaluate(`document.getElementById('extension-dialog').scrollTop=0`); await screenshot('extensions-skill-editor-desktop'); await click('[data-dialog-close="extension-dialog"]'); check('Custom Skill independent member grants, Markdown editing, enable/disable, compact width and reload persistence coexist with 29 builtin Skills without MCP associations');
  await click('[data-extension-tab="mcps"]'); await click(`[data-extension-edit="${first}"]`); await fill('#extension-name', '尚未保存的名称');
  config = await api('/api/extensions'); mcp(config, second).name = '其他页面更新'; await update(config);
  await click('#extension-save'); await uiWait(`!!document.querySelector('#extension-dialog .dialog-feedback')`, 'revision conflict feedback'); assert.equal(await evaluate(`document.getElementById('extension-dialog').open`), true); assert.equal(await evaluate(`document.getElementById('extension-name').value`), '尚未保存的名称'); assert.equal(mcp(await api('/api/extensions'), first).name, '本地文档工具');
  await click('[data-dialog-close="extension-dialog"]'); await click('#extensions-refresh'); await uiWait(`document.getElementById('extensions-content').textContent.includes('其他页面更新')`, 'conflict refresh');
  await click(`[data-extension-edit="${first}"]`); await click('[data-clear-env="FIXTURE_TOKEN"]'); await saveDialog(); assert.deepEqual(mcp(await api('/api/extensions'), first).envKeys, []); assert.deepEqual(mcp(await api('/api/extensions'), first).headerKeys, ['X-Fixture']);
  check('409 conflict preserves editor and draft; explicit key deletion leaves unrelated saved secrets');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await evaluate('window.scrollTo(0,0)'); await delay(100);
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1')); await screenshot('extensions-mcp-mobile');
  const beforeMobileGuides=await api('/api/extensions'); await verifyGuides(beforeMobileGuides,'mobile');
  assert.deepEqual(await api('/api/extensions'),beforeMobileGuides,'Reading mobile guides preserves edited endpoints, grants, enabled states and credentials');
  await verifyConnectionTests(beforeMobileGuides, 'mobile');
  assert.deepEqual(await api('/api/extensions'),beforeMobileGuides,'Mobile connection tests preserve the entire configuration');
  for (const preset of stdioPresets) {
    const item = beforeMobileGuides.mcps.find(entry => entry.builtin === preset.builtin);
    assert.equal(await evaluate(`document.querySelector('[data-extension-edit="${item.id}"]').closest('article').querySelector('.extension-mark use').getAttribute('href')`), '#i-' + preset.builtin);
    await click(`[data-extension-edit="${item.id}"]`);
    assert.deepEqual(await builtinEditorState(), { hidden: false, visible: true, commandRequired: true, urlRequired: false, skillHidden: true, transportOptions: ['stdio', 'http', 'sse'] });
    assert.equal(await evaluate(`document.getElementById('extension-command').value`), item.command);
    assert.equal(await evaluate(`document.getElementById('extension-env').value`), '');
    assert.ok(await evaluate(`(()=>{const r=document.getElementById('extension-dialog').getBoundingClientRect();return r.left>=0 && r.right<=document.documentElement.clientWidth+1 && document.documentElement.scrollWidth<=innerWidth+1;})()`));
    await screenshot('extensions-' + preset.builtin + '-editor-mobile'); await saveDialog();
    await grantExtension(item.id, [teacher]);
    await click(`[data-extension-toggle="${item.id}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${item.id}"]').textContent==='停用'`, preset.builtin + ' enabled on mobile');
    assert.equal(mcp(await api('/api/extensions'), item.id).enabled, true);
    await click(`[data-extension-toggle="${item.id}"]`); await uiWait(`document.querySelector('[data-extension-toggle="${item.id}"]').textContent==='启用'`, preset.builtin + ' disabled on mobile');
    assert.deepEqual(mcp(await api('/api/extensions'), item.id), item, preset.builtin + ' mobile save, repeat grant and toggle round trip preserves the complete connection');
  }
  check('CyberChef, Wireshark and WinDbg mobile cards, editors, saves, grants and toggles preserve settings and fit the viewport');
  await click(`[data-extension-edit="${first}"]`); assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1')); await verifyAutogrow('extension-args','mobile'); await verifyAutogrow('extension-env','mobile'); await screenshot('extensions-editor-mobile');
  report.mcpMobileEditor=await evaluate(`(()=>{const r=document.getElementById('extension-dialog').getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,viewport:innerWidth,availableWidth:document.documentElement.clientWidth};})()`);
  report.mcpMobileWidth=report.mcpMobileEditor.width; assert.ok(report.mcpMobileEditor.left>=0 && report.mcpMobileEditor.right<=report.mcpMobileEditor.availableWidth+1); await click('[data-dialog-close="extension-dialog"]');
  await click(`[data-extension-edit="${builtin}"]`); assert.equal((await builtinEditorState()).visible, true);
  assert.ok(await evaluate(`(()=>{const r=document.getElementById('extension-dialog').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1 && document.documentElement.scrollWidth<=innerWidth+1;})()`));
  await screenshot('extensions-builtin-editor-mobile'); await click('[data-dialog-close="extension-dialog"]');
  await click(`[data-extension-edit="${burp}"]`);
  assert.equal(await evaluate(`document.getElementById('extension-url').value`), burpFixtureUrl);
  assert.ok(await evaluate(`(()=>{const r=document.getElementById('extension-dialog').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1 && document.documentElement.scrollWidth<=innerWidth+1;})()`));
  await screenshot('extensions-burpsuite-editor-mobile'); await click('[data-dialog-close="extension-dialog"]');
  await click(`[data-extension-edit="${second}"]`); await verifyAutogrow('extension-headers','mobile');
  assert.equal(await evaluate(`document.getElementById('extension-skip-tls-verify').checked`),true);
  await evaluate(`document.getElementById('extension-dialog').scrollTop=0`); await screenshot('extensions-remote-editor-mobile'); await click('[data-dialog-close="extension-dialog"]');
  await click('[data-extension-tab="skills"]'); await click(`[data-extension-edit="${skill}"]`);
  assert.equal(await evaluate(`document.querySelector('#extensions-content [data-extension-guide]')===null`),true,'Skills have no preset guide');
  report.skillMobileEditor=await evaluate(`(()=>{const dialog=document.getElementById('extension-dialog');dialog.scrollTop=0;const r=dialog.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,viewport:innerWidth,availableWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth};})()`);
  // Either long list can have a classic page scrollbar. Compare equal margins
  // within the available viewport rather than absolute widths.
  assert.equal(report.skillMobileEditor.availableWidth-report.skillMobileEditor.width,report.mcpMobileEditor.availableWidth-report.mcpMobileWidth, 'Skill and MCP retain the same responsive margins'); assert.ok(report.skillMobileEditor.left>=0 && report.skillMobileEditor.right<=report.skillMobileEditor.availableWidth+1); assert.ok(report.skillMobileEditor.scrollWidth<=report.skillMobileEditor.viewport+1);
  assert.equal(await evaluate(`document.querySelector('#extension-mcp-choices,[data-skill-mcp]')===null`),true); await screenshot('extensions-skill-editor-mobile'); await click('[data-dialog-close="extension-dialog"]'); await click('[data-extension-tab="mcps"]');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  await click(`[data-extension-delete="${second}"]`); await waitFor(async () => customMcps(await api('/api/extensions')).length === 1, 'MCP deletion');
  savedBrowser = builtinBrowser(await api('/api/extensions'));
  assert.equal(savedBrowser.id, builtin); assert.equal(savedBrowser.name, '浏览器验收'); assert.equal(savedBrowser.enabled, true); assert.deepEqual(new Set(savedBrowser.agentIds), new Set([teacher, ...students]));
  assert.equal(await evaluate(`document.querySelector('[data-extension-delete="${builtin}"]')===null`), true);
  savedBurp = builtinBurp(await api('/api/extensions'));
  assert.equal(savedBurp.id, burp); assert.equal(savedBurp.name, 'burpsuite'); assert.equal(savedBurp.transport, 'sse'); assert.equal(savedBurp.url, burpFixtureUrl);
  assert.equal(savedBurp.enabled, false); assert.deepEqual(new Set(savedBurp.agentIds), new Set([teacher, ...students]));
  assert.equal(await evaluate(`document.querySelector('[data-extension-delete="${burp}"]')===null`), true);
  const finalPresets = await api('/api/extensions');
  for (const preset of reversePresets) {
    const item = finalPresets.mcps.find(entry => entry.builtin === preset.builtin);
    assert.equal(item.name, preset.builtin + '验收'); assert.equal(item.enabled, false);
    assert.equal(item.url, 'https://127.0.0.1:1/' + preset.builtin + '-ui-fixture'); assert.equal(item.skipTlsVerify, true);
    assert.deepEqual(new Set(item.agentIds), new Set([teacher, ...students]));
    assert.deepEqual(item.headerKeys, ['Authorization']); assert.deepEqual(item.envKeys, ['FIXTURE_PRESET_TOKEN']);
    assert.equal(await evaluate(`document.querySelector('[data-extension-delete="${item.id}"]')===null`), true);
  }
  for (const preset of stdioPresets) {
    const item = finalPresets.mcps.find(entry => entry.builtin === preset.builtin);
    assert.equal(item.name, preset.builtin + '验收'); assert.equal(item.enabled, false); assert.equal(item.transport, 'stdio');
    assert.equal(item.command, 'fixture-' + preset.builtin + '-never-run'); assert.deepEqual(item.args, [...preset.args, '--fixture', 'two words']);
    assert.deepEqual(new Set(item.agentIds), new Set([teacher, ...students]));
    assert.deepEqual(item.headerKeys, []); assert.deepEqual(item.envKeys, ['FIXTURE_PRESET_TOKEN']);
    assert.equal(await evaluate(`document.querySelector('[data-extension-delete="${item.id}"]')===null`), true);
  }
  const builtinSkillsBeforeDeletion = builtinSkills(await api('/api/extensions'));
  await click('[data-extension-tab="skills"]'); await click(`[data-extension-delete="${skill}"]`); await waitFor(async () => customSkills(await api('/api/extensions')).length === 0, 'custom Skill deletion');
  config = await api('/api/extensions'); assert.equal(config.skills.length, 29); assert.deepEqual(builtinSkills(config), builtinSkillsBeforeDeletion);
  assert.deepEqual(skillEntry(config, builtinSkillId), savedBuiltinSkill);
  await uiWait(`document.querySelectorAll('#extensions-content .extension-card').length===29 && document.querySelector('#extensions-content [data-extension-delete]')===null`, 'builtin Skill cards remain after custom deletion');
  assert.equal(await evaluate(`document.querySelector('#extensions-content .large-empty')===null`), true);
  check('desktop/mobile layouts and explicit MCP/custom Skill deletion preserve all 29 nondeletable builtin Skills'); assert.deepEqual(report.pageErrors, []); report.passed = true;
} catch (error) { report.error = error.stack; console.error(error.stack); process.exitCode = 1; try { if (evaluate) report.visibleText = await evaluate('document.body.innerText'); if (action) await screenshot('failure'); } catch {} }
finally {
  try { if (cdp) await cdp('Browser.close').catch(() => {}); socket?.close(); if (child && child.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]); if (child.exitCode === null) child.kill(); } await server?.close(); for (const name of ['profile', 'browser']) { const target = await fs.realpath(path.join(directory, name)); assert.equal(path.dirname(target), directory); assert.equal(path.basename(target), name); await fs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } report.profileRemoved = true; }
  catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); const reportFile = path.join(directory, 'report.json'); await fs.writeFile(reportFile, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, reportFile, screenshots: report.screenshots }));
}
