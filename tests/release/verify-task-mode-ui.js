import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { findBrowserExecutable } from '../../src/browser-tools.js';

// Source UI with loopback API fixtures only. No Class engine, real models,
// MCP tools, remote targets or existing user data are opened by this verifier.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = await fs.realpath(process.env.CLASS_UI_VERIFY_DIR || os.tmpdir());
const directory = await fs.mkdtemp(path.join(outputRoot, 'class-task-mode-ui-'));
const dataDir = path.join(directory, 'profile'), browserDir = path.join(directory, 'browser');
const report = { passed: false, verification: 'source UI and loopback API fixtures; not actual engine execution', directory, startedAt: new Date().toISOString(), checks: [], screenshots: [], pageErrors: [], requests: [] };
const agents = [['teacher', 'teacher', '测试老师'], ['student-a', 'student', '学生甲'], ['student-b', 'student', '学生乙'], ['principal', 'principal', '测试校长']].map(([id, role, name]) => ({ id, role, name, protocol: 'messages', model: 'fixture-never-called', baseUrl: 'http://127.0.0.1:1', hasKey: true }));
const team = { teacher: 'teacher', students: agents.filter(a => a.role === 'student').map(({ id, name }) => ({ id, name })) };
const taskModes = [
  { id:'auto', name:'自动', icon:'sparkles' },
  { id:'web_pentest', name:'Web漏洞挖掘', icon:'shield' },
  { id:'ctf_solve', name:'CTF题目求解', icon:'answer' },
  { id:'binary_audit', name:'二进制漏洞挖掘', icon:'gdb' },
  { id:'pentest', name:'渗透测试', icon:'tscan' },
];
const modeCatalogue = { revision:1, items:taskModes.map(({ id, name }) => ({ id, name, builtin:true, prompt:id === 'auto' ? '' : `# ${name}完整提示词\n\n` + '隔离夹具：保留完整正文、角色边界和证据要求。\n'.repeat(1000), mcps:[], skills:[] })) };
const makeRun = (id, task, extra = {}) => ({ id, task, status: 'completed', startedAt: '2026-10-16T06:00:00.000Z', finishedAt: '2026-10-16T06:02:00.000Z', team, events: [], blackboard: [], result: { reason: 'answer_valid', answer: { content: '隔离测试记录' }, report: '本地夹具，无真实任务。' }, ...extra });
const legacyRun = makeRun('fixture-legacy', '旧版记录：没有任务模式字段。');
const webRun = makeRun('fixture-web', '历史 Web 模式记录。', { taskMode: 'web_pentest' });
const otherModeRuns = taskModes.slice(2).map(({ id, name }) => makeRun('fixture-' + id, `历史${name}模式记录。`, { taskMode:id }));
const records = new Map([legacyRun, webRun, ...otherModeRuns].map(run => [run.id, run])), uploads = new Map(), principalReports = new Map();
let currentRun = webRun, currentHistory = [webRun, ...otherModeRuns, legacyRun], runSequence = 0, chooser;
const state = () => ({ agents, modes:{ revision:modeCatalogue.revision, items:modeCatalogue.items.map(({ id, name, builtin }) => ({ id, name, builtin })) }, run: currentRun, runs:[...records.values()].filter(run=>['running','starting','paused','stopping'].includes(run.status)), history: currentHistory.map(({ id, task, taskSpec, schedule, scheduled, taskMode, status, startedAt, finishedAt, attachments }) => ({ id, task, taskSpec, schedule, scheduled:scheduled===true, ...(taskMode ? { taskMode } : {}), status, startedAt, finishedAt, attachments })), dataDir, settings: { cwd: dataDir, voteTimeoutMs: 30000 }, judge: { enabled: false, hasApiKey: false, protocol: 'system-one', baseUrl: 'http://127.0.0.1:1', model: 'jev-latest', features: {}, timeoutMs: 3000, minOutputChars: 400, maxConcurrency: 2 } });
let server, child, socket, cdp, evaluate;
const check = value => { report.checks.push(value); console.log('PASS ' + value); };
async function waitFor(predicate, label) { const end = Date.now() + 15000; do { if (await predicate()) return; await delay(40); } while (Date.now() < end); throw Error('Timed out: ' + label); }
const uiWait = (expression, label) => waitFor(() => evaluate(expression), label);
const historyButton = id => '#workspace-history-content [data-run-view="' + id + '"]';
const runPosts = () => report.requests.filter(r => r.pathname === '/api/runs' && r.method === 'POST');
async function click(selector) {
  let point;
  await waitFor(async () => {
    point = await evaluate(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=e.getBoundingClientRect(),point={x:r.x+r.width/2,y:r.y+r.height/2};return r.width&&r.height&&e.contains(document.elementFromPoint(point.x,point.y))?point:null;})()`);
    return point;
  }, 'visible button after layout and transient notices: ' + selector);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function fill(value) { await evaluate(`(()=>{const e=document.getElementById('task-input');if(e.disabled)throw Error('Task input disabled');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function field(id,value) { await evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function selectMode(value) { await evaluate(`(()=>{const e=document.getElementById('task-mode');if(e.disabled)throw Error('Task mode disabled');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function mode(value, disabled) { await uiWait(`document.getElementById('task-mode').value===${JSON.stringify(value)} && document.getElementById('task-mode').disabled===${disabled}`, `mode ${value}, disabled=${disabled}`); }
async function selected(run) { await uiWait(`document.getElementById('workspace-task-original').textContent===${JSON.stringify(run.task)} && document.getElementById('blackboard-content').dataset.runId===${JSON.stringify(run.id)}`, 'selected ' + run.id); }
async function screenshot(name) { const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const filename = path.join(directory, name + '.png'); await fs.writeFile(filename, Buffer.from(result.data, 'base64')); report.screenshots.push(filename); }
async function reload() { await evaluate('window.__fixtureReload=true'); await cdp('Page.reload', { ignoreCache: true }); await uiWait(`!window.__fixtureReload && document.getElementById('connection-status')?.textContent.includes('已连接')`, 'reload'); }
async function layout(width, label = String(width), resize = true) {
  if (resize) await cdp('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 844 : 960, deviceScaleFactor: 1, mobile: false }); await delay(100);
  await evaluate(`document.querySelector('.task-card').scrollIntoView({block:'center'})`); await delay(60);
  const value = await evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};},rect=id=>box(document.getElementById(id)),r=document.querySelector('.task-card').getBoundingClientRect(),input=document.getElementById('task-input'),s=getComputedStyle(input);return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,card:{x:r.x,right:r.right,bottom:r.bottom},options:rect('task-options'),taskToggle:box(document.getElementById('task-kind').closest('label')),scheduleToggle:box(document.getElementById('task-schedule').closest('label')),mode:rect('task-mode'),attachment:rect('attachment-button'),input:rect('task-input'),send:rect('start-button'),taskFields:!document.getElementById('task-spec-fields').hidden?{name:rect('task-name'),description:rect('task-description'),goal:rect('task-goal')}:null,schedule:!document.getElementById('task-schedule-fields').hidden?rect('task-schedule-at'):null,inputScrollHeight:input.scrollHeight,inputClientHeight:input.clientHeight,inputOverflow:s.overflowY,inputMaximum:parseFloat(s.lineHeight)*3+parseFloat(s.paddingTop)+parseFloat(s.paddingBottom)+parseFloat(s.borderTopWidth)+parseFloat(s.borderBottomWidth)};})()`);
  assert.ok(value.scrollWidth <= value.viewport + 1, 'No horizontal overflow at ' + width);
  const close=(a,b,message)=>assert.ok(Math.abs(a-b)<=2,message+' at '+label);
  close(value.taskToggle.y,value.scheduleToggle.y,'Task and schedule share a row');close(value.mode.y,value.taskToggle.y,'Mode shares the control row');
  close(value.mode.x-value.scheduleToggle.right,value.scheduleToggle.x-value.taskToggle.right,'Top controls have equal gaps');
  assert.ok(value.mode.x-value.scheduleToggle.right<=12,'Top controls use compact gaps');
  close(value.mode.height,value.taskToggle.height,'Mode and checkbox control heights match');
  assert.ok(value.mode.bottom<=value.attachment.y+1,'Mode is above the upload row');
  for (const id of ['mode', 'attachment', 'send', ...(value.taskFields?[]:['input'])]) { assert.ok(value[id].width > 0 && value[id].height > 0); assert.ok(value[id].x >= value.card.x - 1 && value[id].right <= value.card.right + 1, id + ' fits composer at ' + width); }
  if(value.taskFields){const {name,description,goal}=value.taskFields;close(name.y,description.y,'Name and description share a row');close(name.width,description.width,'Task name and description widths match');close(name.height,description.height,'Task name and description heights match');close(name.height,goal.height,'Task goal height matches');close(goal.x,name.x,'Task goal left edge aligns');close(goal.right,description.right,'Task goal spans both columns');assert.ok(goal.y>=name.bottom,'Goal occupies the next row');}
  if(value.schedule){close(value.schedule.right,value.options.right,'Execution time is right aligned');close(value.schedule.height,value.mode.height,'Execution time matches controls');if(width>=1280)close(value.schedule.y,value.mode.y,'Execution time shares desktop control row');}
  if (!value.taskFields && value.inputScrollHeight > value.inputClientHeight + 1) { assert.equal(value.inputOverflow, 'auto', 'Wrapped text remains readable after layout at ' + label); assert.ok(Math.abs(value.input.height - value.inputMaximum) <= 2, 'Scrollable textarea reaches three lines at ' + label); }
  report.layouts ??= []; report.layouts.push({ label, ...value }); await screenshot('task-mode-' + label);
}
async function verifyGrow(width) {
  const original = await evaluate(`document.getElementById('task-input').value`), metrics = {};
  for (const [name, text] of [['one', '第一行'], ['two', '第一行\n第二行'], ['three', '第一行\n第二行\n第三行'], ['overflow', '第一行\n第二行\n第三行\n第四行\n第五行'], ['softwrap', '持续输入用于验证自动换行。'.repeat(60)], ['cleared', '']]) {
    await fill(text); await delay(40);
    metrics[name] = await evaluate(`(()=>{const e=document.getElementById('task-input'),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {height:r.height,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,lineHeight:parseFloat(s.lineHeight),overflow:s.overflowY};})()`);
  }
  assert.ok(metrics.two.height > metrics.one.height + metrics.one.lineHeight - 2); assert.ok(metrics.three.height > metrics.two.height + metrics.one.lineHeight - 2);
  for (const name of ['overflow', 'softwrap']) { assert.ok(Math.abs(metrics[name].height - metrics.three.height) <= 2); assert.ok(metrics[name].scrollHeight > metrics[name].clientHeight); assert.equal(metrics[name].overflow, 'auto'); }
  assert.equal(metrics.cleared.height, metrics.one.height); assert.equal(metrics.cleared.overflow, 'hidden'); (report.autogrow ??= {})[width] = metrics; await fill(original);
}
try {
  await fs.mkdir(dataDir, { mode: 0o700 }); await fs.mkdir(browserDir);
  const assets = new Map(); report.sourceHashes = {};
  for (const [route, name, contentType] of [['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/style.css', 'style.css', 'text/css; charset=utf-8'], ['/class-icon.svg', 'class-icon.svg', 'image/svg+xml'], ['/favicon.ico', 'class-icon.ico', 'image/x-icon']]) {
    const body = await fs.readFile(path.join(root, 'public', name)); assets.set(route, { body, contentType }); report.sourceHashes[name] = createHash('sha256').update(body).digest('hex');
  }
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const answer = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (pathname.startsWith('/api/')) {
        let body = ''; for await (const part of req) body += part;
        const request = { method: req.method, pathname, ...(body ? { body: JSON.parse(body) } : {}) }; report.requests.push(request);
        if (pathname === '/api/state' && req.method === 'GET') return answer(200, state());
        if (pathname === '/api/modes' && req.method === 'GET') return answer(200, modeCatalogue);
        if (pathname === '/api/extensions' && req.method === 'GET') return answer(200, { revision:1, mcps:[], skills:[], agents, platform:process.platform });
        const principal = pathname.match(/^\/api\/runs\/([^/]+)\/principal(?:\/([^/]+))?$/);
        if (principal) {
          const [, runId, reportId] = principal;
          if (req.method === 'GET') return answer(200, reportId ? { report: principalReports.get(reportId) } : { reports: [...principalReports.values()].filter(r => r.runId === runId) });
          if (req.method === 'POST' && !reportId) { const report = { id: 'report-' + randomUUID(), runId, question: request.body.question, status: 'completed', createdAt: new Date().toISOString(), principal: { id: 'principal', name: '测试校长' }, answer: '隔离校长答复：模式保持不变。' }; principalReports.set(report.id, report); return answer(202, { report }); }
        }
        const command = pathname.match(/^\/api\/runs\/([^/]+)\/(pause|resume|stop|start|cancel)$/);
        if(command && req.method === 'POST') {
          const run=records.get(command[1]);assert.ok(run,'Fixture run exists');
          run.status={pause:'paused',resume:'running',stop:'stopped',start:'running',cancel:'cancelled'}[command[2]];
          if(command[2]==='start'){run.startedAt=new Date().toISOString();run.phase='solving';run.scheduled=false;}
          return answer(200,{run});
        }
        if (pathname.startsWith('/api/runs/') && req.method === 'PATCH') {
          const run=records.get(decodeURIComponent(pathname.slice('/api/runs/'.length)));assert.ok(run && ['scheduled','missed'].includes(run.status));
          Object.assign(run,request.body,{status:'scheduled',task:request.body.taskSpec.description});return answer(200,{run});
        }
        if (pathname.startsWith('/api/runs/') && req.method === 'GET') { const run = records.get(decodeURIComponent(pathname.slice('/api/runs/'.length))); return run ? answer(200, { run }) : answer(404, { error: 'Fixture run missing' }); }
        if (pathname === '/api/attachments' && req.method === 'GET') return answer(200, { attachments: [...uploads.values()] });
        if (pathname === '/api/attachments' && req.method === 'POST') { const bytes = Buffer.from(request.body.contentBase64, 'base64'), attachment = { id: 'file-' + randomUUID(), name: request.body.name, size: bytes.length, createdAt: new Date().toISOString(), sha256: createHash('sha256').update(bytes).digest('hex') }; uploads.set(attachment.id, attachment); return answer(201, { attachment }); }
        if (pathname === '/api/runs' && req.method === 'POST') {
          assert.ok(taskModes.some(mode => mode.id === request.body.taskMode), 'UI includes taskMode');
          const id = 'fixture-submitted-' + ++runSequence;
          currentRun = makeRun(id, request.body.taskSpec?.description || request.body.task, { taskSpec:request.body.taskSpec,schedule:request.body.schedule,scheduled:!!request.body.schedule,taskMode: request.body.taskMode, status: request.body.schedule?'scheduled':'running', finishedAt: undefined, result: undefined, phase: request.body.schedule?undefined:'solving', startedAt: new Date().toISOString(), attachments: (request.body.attachmentIds || []).map(id => ({ ...uploads.get(id), path: '.class-attachments/fixture/' + id + '.txt' })) });
          for (const id of request.body.attachmentIds || []) uploads.delete(id);
          records.set(id, currentRun); currentHistory.unshift(currentRun); return answer(202, { run: currentRun });
        }
        return answer(404, { error: 'Unexpected fixture request: ' + req.method + ' ' + pathname });
      }
      const asset = assets.get(pathname); if (!asset) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': asset.contentType, 'Cache-Control': 'no-store' }); res.end(asset.body);
    } catch (error) { answer(500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:' + server.address().port;
  const executablePath = await findBrowserExecutable();
  child = spawn(executablePath, ['--headless=new', '--do-not-de-elevate', '--noerrdialogs', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + browserDir, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', 'about:blank'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError, port; child.once('error', error => { launchError = error; }); child.stderr.resume();
  await waitFor(async () => { if (launchError) throw launchError; if (child.exitCode !== null) throw Error('Owned browser exited'); try { port = (await fs.readFile(path.join(browserDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return /^\d+$/.test(port); } catch { return false; } }, 'private browser CDP');
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { const request = pending.get(message.id); if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result); } } if (message.method === 'Runtime.exceptionThrown') report.pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text); if (message.method === 'Page.fileChooserOpened') chooser = message.params; });
  cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  evaluate = async expression => { const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Page.setInterceptFileChooserDialog', { enabled: true }); await cdp('Browser.setDownloadBehavior', { behavior: 'deny' });
  await cdp('Emulation.setTimezoneOverride', { timezoneId:'America/Los_Angeles' });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false }); await cdp('Page.navigate', { url: url + '/#token=isolated-fixture-token' });
  await uiWait(`document.getElementById('connection-status')?.textContent.includes('已连接') && document.querySelectorAll('#workspace-history-content [data-run-view]').length===5`, 'initial fixture state');
  assert.deepEqual(await evaluate(`[...document.getElementById('task-mode').options].map(o=>({value:o.value,label:o.textContent.trim()}))`), taskModes.map(({ id, name }) => ({ value:id, label:name })));
  await click(historyButton(webRun.id)); await selected(webRun); await mode('web_pentest', true);
  for (const historical of otherModeRuns) {
    const variant = taskModes.find(mode => mode.id === historical.taskMode);
    await click(historyButton(historical.id)); await selected(historical); await mode(variant.id, true);
    assert.equal(await evaluate(`document.querySelector('[data-history-mode="${variant.id}"] .workspace-history-mode-name').textContent`), variant.name);
    assert.equal(await evaluate(`document.querySelector('[data-history-mode="${variant.id}"] .workspace-history-mode-icon use').getAttribute('href')`), '#i-' + variant.icon);
  }
  await click(historyButton(legacyRun.id)); await selected(legacyRun); await mode('auto', true); assert.equal(Object.hasOwn(legacyRun, 'taskMode'), false);
  assert.equal(runPosts().length, 0); check('Historical mode is read-only; legacy records without taskMode display auto');

  await click('[data-page="extensions"]'); await click('[data-extension-tab="modes"]');
  await uiWait(`document.querySelectorAll('#extensions-content .mode-card').length===4`, 'builtin mode cards');
  assert.equal(await evaluate(`document.querySelector('#extensions-content [data-mode-view="auto"]') === null`), true);
  for (const variant of taskModes.slice(1)) {
    const item = modeCatalogue.items.find(mode => mode.id === variant.id);
    assert.equal(await evaluate(`document.querySelector('[data-mode-view="${variant.id}"]').closest('.mode-card').querySelector('.extension-mark use').getAttribute('href')`), '#i-' + variant.icon);
    assert.equal(await evaluate(`document.querySelector('#extensions-content [data-extension-delete="${variant.id}"]') === null`), true);
    await click(`[data-extension-select="${variant.id}"]`);
    assert.equal(await evaluate(`document.getElementById('extensions-delete').disabled`), true);
    await click(`.mode-title-button[data-mode-view="${variant.id}"]`);
    await uiWait(`document.getElementById('mode-dialog').open`, 'readonly ' + variant.id);
    assert.equal(await evaluate(`document.getElementById('mode-dialog-title').textContent`), variant.name);
    assert.equal(await evaluate(`document.getElementById('mode-prompt').value`), item.prompt);
    assert.equal(await evaluate(`document.getElementById('mode-prompt').readOnly && document.getElementById('mode-name').readOnly && document.getElementById('mode-save-actions').hidden`), true);
    await click('[data-dialog-close="mode-dialog"]'); await click(`[data-extension-select="${variant.id}"]`);
  }
  await screenshot('builtin-mode-cards'); await click('[data-page="workspace"]');
  check('All four builtin cards retain their icons, show exact readonly prompts and cannot be deleted; auto remains hidden');

  await click('#workspace-new-conversation'); await mode('auto', false); await selectMode('web_pentest'); const task = '仅验证本地界面模式与附件，不执行任何目标操作。'; await fill(task);
  const fixtureFile = path.join(dataDir, 'mode-notes.txt'); await fs.writeFile(fixtureFile, 'Owned attachment fixture. No network targets.'); chooser = null; await click('#attachment-button'); await waitFor(() => chooser, 'native attachment chooser'); await cdp('DOM.setFileInputFiles', { files: [fixtureFile], backendNodeId: chooser.backendNodeId }); await uiWait(`document.getElementById('task-attachments').textContent.includes('mode-notes.txt') && !document.getElementById('start-button').disabled`, 'attachment uploaded');
  await click(historyButton(legacyRun.id)); await selected(legacyRun); await mode('auto', true); await click('#workspace-new-conversation'); await mode('web_pentest', false);
  assert.equal(await evaluate(`document.getElementById('task-input').value`), task); assert.ok(await evaluate(`document.getElementById('task-attachments').textContent.includes('mode-notes.txt')`)); await delay(1400); await mode('web_pentest', false);
  check('New draft remembers its chosen mode, text and attachments across history navigation and polling');
  await layout(1280); await verifyGrow(1280); await layout(900);
  if (await evaluate(`document.documentElement.classList.contains('sidebar-collapsed')`)) await click('#sidebar-toggle');
  await layout(900, '900-expanded', false); await click('#sidebar-toggle'); await layout(900, '900-collapsed', false);
  await layout(390); await verifyGrow(390); await layout(390, '390-after-typing', false);
  check('Task, schedule and mode form a compact aligned row above upload; desktop and 390px fit; ordinary composer grows through three lines');
  await reload(); await mode('auto', false); assert.equal(await evaluate(`document.getElementById('task-input').value`), task); await selectMode('web_pentest');
  check('A page reload restores auto for the draft while retaining existing draft content');

  await click('#start-button'); await waitFor(() => runPosts().length === 1, 'web task submission'); const submittedWeb = currentRun; await selected(submittedWeb); await mode('web_pentest', true);
  assert.equal(runPosts()[0].body.task, task); assert.equal(runPosts()[0].body.taskMode, 'web_pentest'); assert.equal(runPosts()[0].body.attachmentIds.length, 1); assert.equal(submittedWeb.attachments[0].name, 'mode-notes.txt');
  assert.equal(await evaluate(`document.getElementById('start-button').getAttribute('aria-label')`),'停止任务');
  assert.equal(await evaluate(`document.getElementById('start-button').type`),'button');
  await fill('/btw 当前任务使用什么模式？'); await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}); await waitFor(() => principalReports.size === 1, 'independent principal question');
  await uiWait(`document.getElementById('principal-messages').textContent.includes('模式保持不变')`, 'principal answer'); await mode('web_pentest', true);
  assert.equal(runPosts().length, 1); assert.equal(currentRun.taskMode, 'web_pentest'); assert.equal(currentRun.status, 'running'); assert.deepEqual(report.requests.find(r => r.pathname.endsWith('/principal') && r.method === 'POST').body, { question: '当前任务使用什么模式？' });
  await click('[data-dialog-close="principal-dialog"]'); await screenshot('task-mode-running-web');
  await click(historyButton(legacyRun.id)); await selected(legacyRun); await mode('auto', true); await click('#workspace-return-active'); await selected(submittedWeb); await mode('web_pentest', true);
  check('POST carries web_pentest; active mode is immutable; /btw only creates a principal question and history switching preserves the active run');

  submittedWeb.status = 'completed'; submittedWeb.finishedAt = new Date().toISOString(); await uiWait(`document.getElementById('start-button').dataset.action!=='stop'`, 'fixture completion');
  await click('#workspace-new-conversation'); await mode('auto', false); await fill('默认模式的隔离提交。'); await click('#start-button'); await waitFor(() => runPosts().length === 2, 'auto task submission');
  await selected(currentRun); await mode('auto', true); assert.equal(runPosts()[1].body.taskMode, 'auto'); assert.deepEqual(runPosts()[1].body.attachmentIds, []);
  await click(historyButton(submittedWeb.id)); await selected(submittedWeb); await mode('web_pentest', true); await reload(); await selected(submittedWeb); await mode('web_pentest', true);
  check('Next new task defaults to auto; submitted Web and auto modes remain correct in saved history and across reload');

  for (const variant of taskModes.slice(2)) {
    currentRun.status = 'completed'; currentRun.finishedAt = new Date().toISOString(); await uiWait(`document.getElementById('start-button').dataset.action!=='stop'`, 'previous fixture completion');
    await click('#workspace-new-conversation'); await mode('auto', false); await selectMode(variant.id); await fill(`${variant.name}模式的隔离提交。`);
    await layout(390, '390-' + variant.id + '-mode');
    const before = runPosts().length;
    await click('#start-button'); await waitFor(() => runPosts().length === before + 1, variant.id + ' task submission'); const submitted = currentRun;
    await selected(submitted); await mode(variant.id, true); assert.equal(runPosts().at(-1).body.taskMode, variant.id);
    await click(historyButton(legacyRun.id)); await selected(legacyRun); await mode('auto', true);
    await click('#workspace-return-active'); await selected(submitted); await mode(variant.id, true);
    await reload(); await selected(submitted); await mode(variant.id, true);
    check(variant.id + ' fits the mobile composer, is submitted unchanged and survives historical navigation and reload');
  }

  const prior=currentRun;
  await click('#workspace-new-conversation');await click('#task-kind');await field('task-name','并发任务甲');await field('task-goal','交付隔离验证结果');await field('task-description','任务描述甲');await selectMode('binary_audit');
  assert.equal(await evaluate(`document.getElementById('task-schedule').disabled`),false);
  await layout(1280,'1280-task-fields');await layout(390,'390-task-fields');
  const beforeTask=runPosts().length;await click('#start-button');await waitFor(()=>runPosts().length===beforeTask+1,'concurrent task creation');const taskRun=currentRun;await selected(taskRun);
  assert.equal(prior.status,'running');assert.equal(taskRun.taskSpec.name,'并发任务甲');assert.equal(taskRun.taskMode,'binary_audit');
  assert.equal(Object.hasOwn(runPosts().at(-1).body,'task'),false);
  await click('#workspace-new-conversation');assert.equal(await evaluate(`document.getElementById('task-kind').checked`),false);await fill('并发普通对话');await click('#start-button');await waitFor(()=>runPosts().length===beforeTask+2,'concurrent plain discussion');const plainRun=currentRun;
  await click(historyButton(taskRun.id));await selected(taskRun);await delay(1400);await selected(taskRun);
  await click('#pause-button');await uiWait(`document.getElementById('run-status').textContent==='已暂停'`,'selected pause');assert.equal(plainRun.status,'running');assert.equal(prior.status,'running');
  await click('#resume-button');await uiWait(`!document.getElementById('pause-button').hidden`,'selected resume');
  assert.equal(await evaluate(`document.getElementById('task-input').value`),'');
  assert.equal(await evaluate(`document.getElementById('start-button').getAttribute('aria-label')`),'停止任务');
  await click('#start-button');await uiWait(`document.getElementById('run-status').textContent==='已停止'`,'selected stop');assert.equal(plainRun.status,'running');assert.equal(prior.status,'running');
  const controls=report.requests.filter(request=>request.method==='POST'&&/\/(pause|resume|stop)$/.test(request.pathname));
  assert.deepEqual(controls.map(request=>request.pathname),['pause','resume','stop'].map(operation=>'/api/runs/'+taskRun.id+'/'+operation));
  check('Task fields and ordinary discussions create concurrent runs; selection and pause/resume/stop stay bound to the selected ID');

  await click('#workspace-new-conversation');await click('#task-kind');await click('#task-schedule');await field('task-name','一次性定时任务');await field('task-goal','按时交付');await field('task-schedule-at','2099-10-19T22:15');await field('task-description','定时描述');await selectMode('pentest');
  assert.equal(await evaluate(`Intl.DateTimeFormat().resolvedOptions().timeZone`),'America/Los_Angeles');
  assert.equal(await evaluate(`document.getElementById('task-schedule-zone')===null && document.getElementById('schedule-edit-zone')===null`),true);
  assert.doesNotMatch(await evaluate(`document.getElementById('task-options').textContent`),/时区|仅执行一次/);
  await layout(1280,'1280-schedule-fields');await layout(390,'390-schedule-fields');
  const beforeSchedule=runPosts().length;await click('#start-button');await waitFor(()=>runPosts().length===beforeSchedule+1,'scheduled creation');const scheduled=currentRun;
  await selected(scheduled);await uiWait(`!document.getElementById('scheduled-task-panel').hidden && document.getElementById('task-form').hidden`,'scheduled panel');
  assert.equal(scheduled.status,'scheduled');assert.equal(scheduled.taskMode,'pentest');assert.equal(plainRun.status,'running');
  assert.deepEqual(scheduled.schedule,{at:'2099-10-19T14:15:00.000Z',timeZone:'Asia/Shanghai'});await screenshot('scheduled-task-pending');
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(historyButton(scheduled.id)+' time')}).textContent`),/22:15/,'Scheduled history uses Shanghai time too');
  await click('#scheduled-edit');await uiWait(`document.getElementById('schedule-edit-dialog').open`,'schedule editor');
  assert.equal(await evaluate(`document.getElementById('schedule-edit-at').value`),'2099-10-19T22:15');
  await field('schedule-edit-name','一次性定时任务已改');await field('schedule-edit-description','修改后的描述');await field('schedule-edit-goal','修改后的目标');await field('schedule-edit-at','2099-10-20T08:30');
  await click('#schedule-edit-form button[type="submit"]');await uiWait(`!document.getElementById('schedule-edit-dialog').open`,'schedule saved');
  assert.equal(scheduled.taskSpec.name,'一次性定时任务已改');assert.equal(scheduled.task,'修改后的描述');
  assert.deepEqual(scheduled.schedule,{at:'2099-10-20T00:30:00.000Z',timeZone:'Asia/Shanghai'});
  scheduled.status='missed';await uiWait(`document.getElementById('run-status').textContent==='已错过'`,'missed schedule');
  assert.match(await evaluate(`document.getElementById('scheduled-task-note').textContent`),/已错过/);
  await click('#scheduled-start');await uiWait(`!document.getElementById('pause-button').hidden`,'scheduled start now');assert.equal(scheduled.status,'running');assert.equal(plainRun.status,'running');
  await reload();await selected(scheduled);await mode('pentest',true);
  await click('#workspace-new-conversation');await click('#task-kind');await click('#task-schedule');await field('task-name','待取消任务');await field('task-goal','不会执行');await field('task-schedule-at','2099-10-21T08:30');await field('task-description','取消夹具');
  await click('#start-button');await waitFor(()=>runPosts().length===beforeSchedule+2,'second schedule');const cancelled=currentRun;await selected(cancelled);await click('#scheduled-cancel');
  await uiWait(`document.getElementById('run-status').textContent==='已取消'`,'schedule cancelled');assert.equal(cancelled.status,'cancelled');assert.equal(scheduled.status,'running');assert.equal(plainRun.status,'running');
  check('Schedules hide timezone labels and consistently use Shanghai despite a Los Angeles browser; edit, start-now and cancel preserve other runs');
  assert.deepEqual(report.pageErrors, []); report.passed = true;
} catch (error) {
  report.error = error.stack; console.error(error.stack); process.exitCode = 1;
  try { if (evaluate) report.visibleText = await evaluate('document.body.innerText'); if (cdp) await screenshot('failure'); } catch {}
} finally {
  try {
    if (cdp) await cdp('Browser.close').catch(() => {}); socket?.close();
    if (child && child.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]); if (child.exitCode === null) child.kill(); }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const name of ['profile', 'browser']) { const candidate = path.join(directory, name), stat = await fs.lstat(candidate); assert.equal(stat.isSymbolicLink(), false); const target = await fs.realpath(candidate); assert.equal(path.dirname(target), directory); assert.equal(path.basename(target), name); await fs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); }
    report.ownedDataRemoved = true;
  } catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); const filename = path.join(directory, 'report.json'); await fs.writeFile(filename, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, reportFile: filename, screenshots: report.screenshots }));
}
