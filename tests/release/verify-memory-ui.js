import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createClassServer } from '../../src/web-server.js';
import { createMemoryStore } from '../../src/memory-store.js';
import { memoryProjectId } from '../../src/memory-manager.js';
import { ToolManager } from '../../src/tools.js';
import { findBrowserExecutable } from '../../src/browser-tools.js';
import { getReleaseDirectory } from '../../scripts/release-paths.js';
import { verificationHost, verifyNativeExecutable, verificationRoot, defaultVerificationExecutable } from './windows-verification.js';

// Disposable profile, real browser/API, and a controlled loopback model only.
// Usage: node tests/release/verify-memory-ui.js [--node | --exe executable]
const root = verificationRoot(import.meta.url);
const argv = process.argv.slice(2), exeIndex = argv.indexOf('--exe'), sourceMode = argv.includes('--node');
if (sourceMode && argv.length !== 1 || exeIndex >= 0 && (exeIndex !== 0 || argv.length !== 2 || argv[1].startsWith('--')) || !sourceMode && exeIndex < 0 && argv.length) throw Error('Usage: node tests/release/verify-memory-ui.js [--node | --exe executable]');
const executable = sourceMode ? null : path.resolve(exeIndex < 0 ? defaultVerificationExecutable() : argv[1]);
const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'class-memory-ui-'));
const dataDir = path.join(directory, 'profile'), workspace = path.join(dataDir, 'workspace');
const runId = `run-${randomUUID()}`, foreignId = `run-${randomUUID()}`, reference = `journal:${runId}:1`, foreignReference = `journal:${foreignId}:1`;
const original = '离线中文记忆核验：数据库权限 EACCES\n  原始空格保留 <tag>\n编号 UI-MEM-2026';
const report = { mode: executable ? 'exe' : 'source', executable, host: verificationHost(), directory, checks: [], screenshots: [], pageErrors: [], requests: [], localModelRequests: 0, startedAt: new Date().toISOString() };
const reportFile = path.join(directory, 'report.json'), modelRequests = [];
let server, child, childError, childExit, manager, session, browserPage, base, token, evaluate, api, fakeModel;
const check = name => { report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); };
async function waitFor(predicate, label, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await delay(80); } throw new Error(`Timed out: ${label}`); }
async function uiWait(expression, label) { await waitFor(() => evaluate(expression), label); }
async function screenshot(name) { const result = await manager.browserTools.execute('memory-ui', 'browser', { action: 'screenshot' }); const filename = path.join(directory, name + '.png'); await fs.writeFile(filename, Buffer.from(result.media[0].data, 'base64')); report.screenshots.push(filename); }
function replyModel(index, memories) { const response = modelRequests[index].response; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ id: `fixture-${index}`, type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ memories }) }], usage: { input_tokens: 10, output_tokens: 10 } })); }
try {
  if (executable) report.artifact = verifyNativeExecutable(await fs.readFile(executable), report.host);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 }); await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(path.join(dataDir, 'history'));
  const projectId = memoryProjectId(workspace), foreignProject = memoryProjectId(path.join(directory, 'other-project'));
  const seed = await createMemoryStore({ directory: path.join(dataDir, 'memory') });
  try {
    for (const [id, project, ref, text] of [[runId, projectId, reference, original], [foreignId, foreignProject, foreignReference, '另一工作目录的来源原文']]) {
      const run = { id, projectId: project, cwd: project, task: '隔离来源核验', demo: true, status: 'completed', startedAt: '2026-09-20T10:00:00.000Z', finishedAt: '2026-09-20T10:01:00.000Z', events: [], blackboard: [], outcomes: [], team: { teacher: 'fixture-teacher', students: [] }, hasJournal: true, metadata: { demo: true } };
      await fs.writeFile(path.join(dataDir, 'history', id + '.json'), JSON.stringify(run)); seed.registerSession(run);
      seed.upsertRecords(id, [{ id: ref, reference: ref, role: 'user', shared: true, kind: 'run', sequence: 1, timestamp: run.startedAt, text, payload: { task: text } }, ...Array.from({ length: 25 }, (_, index) => ({ id: `${id}:context-${index}`, sequence: index + 2, role: 'teacher', agentId: 'fixture-teacher', kind: 'event', text: `上下文第 ${index + 1} 条`, timestamp: run.startedAt }))]);
    }
    for (let index = 0; index < 24; index++) seed.saveMemory({ id: `fixture-memory-${String(index).padStart(2, '0')}`, projectId: index % 2 ? foreignProject : projectId, kind: index % 2 ? 'agent' : 'user', category: 'preference', status: index === 23 ? 'invalid' : index === 22 ? 'paused' : 'active', content: `中文画像核验 · 画像条目 ${String(index).padStart(2, '0')}：使用 UTF-8。${index === 0 ? '<img src=x onerror="alert(1)">' : ''}`, sourceRefs: [index % 2 ? foreignReference : reference] }, { admin: true });
  } finally { seed.close(); }
  fakeModel = http.createServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); if (request.url !== '/v1/messages' || request.method !== 'POST') { response.writeHead(404); response.end(); return; } report.localModelRequests++; modelRequests.push({ response, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); });
  await new Promise(resolve => fakeModel.listen(0, '127.0.0.1', resolve));
  if (executable) {
    child = spawn(executable, ['--data-dir', dataDir, '--no-browser'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    child.once('error', error => { childError = error; }); child.once('exit', (code, signal) => { childExit = { code, signal }; });
    let instance; await waitFor(async () => { if(childError)throw childError;if(childExit)throw Error('Owned EXE exited before readiness: '+JSON.stringify(childExit));try { instance = JSON.parse(await fs.readFile(path.join(dataDir, 'instance.json'), 'utf8')); return instance.pid === child.pid; } catch { return false; } }, 'isolated EXE startup', 30000); base = instance.url.replace(/\/$/, ''); token = instance.token;
  } else {
    token = randomBytes(32).toString('hex'); const assets = {};
    for (const [route, file, contentType] of [['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/style.css', 'style.css', 'text/css; charset=utf-8'], ['/class-icon.svg', 'class-icon.svg', 'image/svg+xml'], ['/favicon.ico', 'class-icon.ico', 'image/x-icon']]) assets[route] = { body: await fs.readFile(path.join(root, 'public', file)), contentType };
    server = await createClassServer({ dataDir, token, assets }); base = server.url;
  }
  api = async (route, options = {}) => { const response = await fetch(base + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }); const body = await response.json(); assert.ok(response.ok, `${route}: ${JSON.stringify(body)}`); return body; };
  await waitFor(async () => (await api('/api/memory/status')).memories === 24, 'fixture memories');
  manager = new ToolManager({ cwd: directory, allowShell: false, browserOptions: { executablePath: await findBrowserExecutable() } });
  const browser = manager.browserTools, action = args => browser.execute('memory-ui', 'browser', args);
  const opened = JSON.parse((await action({ action: 'open', url: base + '/#token=' + token })).output); session = browser.sessions.get('memory-ui'); browserPage = session.pages.get(opened.tabId);
  evaluate = expression => browser._evaluate(session, browserPage, expression, AbortSignal.timeout(10000));
  const cdp = (method, params) => session.connection.send(method, params, browserPage.sessionId, AbortSignal.timeout(10000));
  await cdp('Page.enable', {}); await cdp('Runtime.enable', {}); await cdp('Network.enable', {});
  const viewport = (width, height) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await viewport(1280, 960);
  let dialogDecision = false;
  session.connection.socket.addEventListener('message', event => { let message; try { message = JSON.parse(event.data); } catch { return; } if (message.sessionId !== browserPage.sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') report.pageErrors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''));
    if (message.method === 'Network.requestWillBeSent') { const request = message.params.request; if (request.url.startsWith(base + '/api/memory/')) report.requests.push({ url: request.url.slice(base.length), method: request.method, ...(request.postData ? { body: JSON.parse(request.postData) } : {}) }); }
    if (message.method === 'Page.javascriptDialogOpening') { report.lastDialog = message.params.message; cdp('Page.handleJavaScriptDialog', { accept: dialogDecision }).catch(() => {}); dialogDecision = false; }
  });
  const click = selector => action({ action: 'click', selector }), fill = (selector, value) => action({ action: 'fill', selector, text: value });
  const select = (id, value) => evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const search = () => click('#memory-entry-search button[type="submit"]'), badge = value => uiWait(`document.querySelector('#memory-state').textContent===${JSON.stringify(value)}`, value);
  const openSource = async id => { await evaluate(`(()=>{const a=document.querySelector('[data-memory-edit="${id}"]').closest('article');a.querySelector('details').open=true;a.querySelector('[data-memory-source]').click();})()`); await uiWait(`document.querySelector('#memory-context-content').textContent.includes('UI-MEM-2026')`, 'source context'); };
  await uiWait(`document.querySelector('#connection-status').textContent.includes('已连接')`, 'UI connected'); await click('[data-page="memory"]'); await uiWait(`document.querySelector('#memory-entries-page').textContent.endsWith('/ 24')`, 'global entries');
  assert.equal(await evaluate(`document.querySelectorAll('#memory-entries-content .memory-record').length`), 20);
  for (const id of ['memory-entry-project','memory-project-note','memory-add','memory-export','memory-rebuild','memory-jobs','memory-sessions-panel']) assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)})`), null, id);
  assert.deepEqual(await evaluate(`Array.from(document.querySelector('#memory-entry-kind').options,o=>[o.value,o.textContent])`), [['','全部类型'],['user','用户画像'],['agent','Agent画像']]);
  assert.deepEqual(await evaluate(`Array.from(document.querySelector('#memory-entry-status').options,o=>o.value)`), ['','active','paused','invalid']);
  assert.ok(report.requests.every(r => !r.url.startsWith('/api/memory/sessions') && !r.url.startsWith('/api/memory/source'))); check('global two-type landing page without removed controls or eager history reads');

  await select('memory-entry-kind', 'user'); await search(); await uiWait(`document.querySelector('#memory-entries-page').textContent.endsWith('/ 12')`, 'user profiles');
  await select('memory-entry-kind', 'agent'); await search(); await uiWait(`document.querySelector('#memory-entries-page').textContent.endsWith('/ 12')`, 'agent profiles from another directory');
  await select('memory-entry-kind', ''); await select('memory-entry-status', 'invalid'); await search(); await uiWait(`document.querySelector('#memory-entries-page').textContent.endsWith('/ 1')`, 'invalid profiles');
  await select('memory-entry-status', ''); await search(); await uiWait(`!document.querySelector('#memory-entries-next').disabled`, 'pagination'); await click('#memory-entries-next'); await uiWait(`document.querySelector('#memory-entries-page').textContent.startsWith('21')`, 'second page');
  assert.ok(await evaluate(`(()=>{const c=document.querySelectorAll('#memory-entries-content .memory-record');return document.querySelector('.memory-pagination').getBoundingClientRect().top>=c[c.length-1].getBoundingClientRect().bottom;})()`)); check('types and state filters, pagination follows content without overlap');

  await fill('#memory-entry-query', 'NO_MATCH_' + randomUUID()); await search(); await uiWait(`document.querySelector('#memory-entries-content').textContent==='暂无记录'`, 'empty list'); await evaluate('window.scrollTo(0,0)'); await delay(80);
  const geometry = await evaluate(`(()=>{const b=s=>document.querySelector(s).getBoundingClientRect(),e=b('.memory-empty-message'),f=b('#memory-entry-search'),p=b('.memory-pagination'),l=b('#memory-entries-content');return {x:(e.left+e.right-l.left-l.right)/2,y:(e.top+e.bottom-f.bottom-p.top)/2,bottom:innerHeight-p.bottom,button:b('#memory-entry-search button').height,select:b('#memory-entry-status').height};})()`);
  assert.ok(Math.abs(geometry.x)<2&&Math.abs(geometry.y)<18,JSON.stringify(geometry)); assert.ok(geometry.bottom>=18&&geometry.bottom<=22,JSON.stringify(geometry)); assert.equal(geometry.button,geometry.select); await screenshot('memory-empty-desktop');
  await viewport(390,844); await evaluate('window.scrollTo(0,0)'); await delay(80); assert.ok(await evaluate(`(()=>{const p=document.querySelector('.memory-pagination').getBoundingClientRect(),n=document.querySelector('.sidebar').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&p.bottom<n.top&&n.top-p.bottom<35;})()`)); await screenshot('memory-empty-mobile'); await viewport(1280,960);
  check('empty message centered, pagination at bottom and matching control heights across desktop/mobile');

  await fill('#memory-entry-query','画像条目 00'); await search(); await uiWait(`document.querySelector('[data-memory-edit="fixture-memory-00"]')`, 'editable profile'); assert.equal(await evaluate(`document.querySelectorAll('#memory-entries-content img').length`),0);
  await click('[data-memory-toggle="fixture-memory-00"]'); await waitFor(async()=>(await api('/api/memory/entries/fixture-memory-00')).status==='paused','pause'); await uiWait(`document.querySelector('[data-memory-toggle="fixture-memory-00"]').dataset.memoryStatus==='active'&&!document.querySelector('[data-memory-toggle="fixture-memory-00"]').disabled`,'pause rendered');
  await click('[data-memory-toggle="fixture-memory-00"]'); await waitFor(async()=>(await api('/api/memory/entries/fixture-memory-00')).status==='active','enable'); await uiWait(`!document.querySelector('[data-memory-edit="fixture-memory-00"]').disabled`,'editor unlocked'); await click('[data-memory-edit="fixture-memory-00"]'); await uiWait(`document.querySelector('#memory-entry-dialog').open`,'editor open');
  assert.equal(await evaluate(`document.querySelector('#memory-edit-kind').disabled`),true); assert.equal(await evaluate(`document.querySelector('#memory-edit-project')`),null); await fill('#memory-edit-content','画像条目 00：已修订，使用 UTF-8。'); await click('#memory-entry-save'); await uiWait(`!document.querySelector('#memory-entry-dialog').open`,'edit saved'); assert.equal((await api('/api/memory/entries/fixture-memory-00')).content,'画像条目 00：已修订，使用 UTF-8。'); await uiWait(`document.querySelector('#memory-entries-content').textContent.includes('已修订')`,'edited content'); check('existing profile editing, literal unsafe text and pause/enable without creation');
  await openSource('fixture-memory-00'); assert.ok((await evaluate(`document.querySelector('#memory-context-content').innerText`)).includes(original)); await action({action:'press',key:'Escape'}); assert.equal(await evaluate(`document.querySelector('#memory-session-dialog').open`),true);
  await fill('#memory-context-reference',''); await click('#memory-context-form button'); await uiWait(`!document.querySelector('#memory-context-next').disabled`,'source pagination'); await click('#memory-context-next'); await uiWait(`document.querySelector('#memory-context-page').textContent.startsWith('21')`,'source second page'); await screenshot('session-context'); await click('[data-dialog-close="memory-session-dialog"]'); check('exact original sources remain on demand with context pagination');

  await click('#memory-settings-button'); await uiWait(`document.querySelector('#memory-settings-dialog').open`,'settings'); await badge('已启用'); assert.ok(await evaluate(`document.querySelector('#memory-state').getBoundingClientRect().right<=document.querySelector('[data-dialog-close="memory-settings-dialog"]').getBoundingClientRect().left`));
  await action({action:'press',key:'Escape'}); assert.equal(await evaluate(`document.querySelector('#memory-settings-dialog').open`),true); await evaluate(`document.querySelector('#memory-settings-dialog').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:0,clientY:0}))`); assert.equal(await evaluate(`document.querySelector('#memory-settings-dialog').open`),true);
  await click('#memory-enabled'); await click('#memory-settings-save'); await uiWait(`!document.querySelector('#memory-settings-dialog').open`,'disabled save'); assert.equal((await api('/api/memory/status')).enabled,false); await uiWait(`!document.querySelector('#memory-settings-button').disabled`,'settings unlocked'); await click('#memory-settings-button'); await badge('已关闭'); await click('#memory-enabled'); await click('#memory-settings-save'); await uiWait(`!document.querySelector('#memory-settings-dialog').open`,'enabled save');
  await uiWait(`!document.querySelector('#memory-settings-button').disabled`,'settings unlocked'); await click('#memory-settings-button');
  await uiWait(`document.querySelector('#memory-settings-dialog').open`,'settings reopened'); await badge('已启用');
  await uiWait(`!document.querySelector('#memory-reflect').disabled`,'reflection available after enabling memory');
  const reflectionRequests = () => report.requests.filter(request => request.url === '/api/memory/jobs' && request.method === 'POST' && request.body?.type === 'reflect').length;
  const reflectionRequestsBeforeClick = reflectionRequests();
  await click('#memory-reflect');
  await waitFor(() => reflectionRequests() === reflectionRequestsBeforeClick + 1,'reflection POST observed after click');
  await badge('等待模型配置'); check('minimal settings, title badge, model-wait state and explicit dismissal');
  await api('/api/agents',{method:'POST',body:JSON.stringify({name:'仅本机测试老师',role:'teacher',protocol:'messages',baseUrl:`http://127.0.0.1:${fakeModel.address().port}`,model:'isolated-ui-fixture',apiKey:'isolated-ui-fixture-key'})});
  await waitFor(()=>modelRequests.length===1,'loopback reflection'); await badge('记忆整理中'); replyModel(0,'fixture-invalid-result'); await badge('整理失败'); await uiWait(`!document.querySelector('#memory-reflect').disabled`,'reflection retry'); await click('#memory-reflect');
  await waitFor(()=>modelRequests.length===2,'second loopback reflection'); await badge('记忆整理中'); replyModel(1,[]); await badge('整理成功'); assert.ok(!(await evaluate(`document.querySelector('#memory-settings-dialog').innerText`)).includes('fixture-invalid-result')); await screenshot('memory-settings-success'); check('real reflection transitions running/failure/latest-success without stale logs');
  await click('[data-dialog-close="memory-settings-dialog"]'); await openSource('fixture-memory-00'); await click('#memory-extract'); await waitFor(()=>modelRequests.length===3,'loopback extraction'); await click('[data-dialog-close="memory-session-dialog"]'); await click('#memory-settings-button'); await badge('会话整理中'); replyModel(2,[]); await badge('整理成功'); await click('[data-dialog-close="memory-settings-dialog"]'); check('source extraction has distinct running state using a local fixture only');
  await screenshot('memory-desktop'); await viewport(390,844); await evaluate('window.scrollTo(0,0)'); await screenshot('memory-mobile'); assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1')); await viewport(1280,960);

  await uiWait(`!document.querySelector('[data-memory-delete="fixture-memory-00"]').disabled`,'delete unlocked'); dialogDecision=false; await click('[data-memory-delete="fixture-memory-00"]'); assert.equal((await api('/api/memory/entries/fixture-memory-00')).id,'fixture-memory-00'); dialogDecision=true; await click('[data-memory-delete="fixture-memory-00"]'); await waitFor(async()=>(await api('/api/memory/entries?query='+encodeURIComponent('画像条目 00'))).total===0,'memory deletion'); assert.equal((await api('/api/memory/sessions?projectId=*')).total,2);
  await uiWait(`!document.querySelector('#memory-entry-search button').disabled`,'delete settled'); await fill('#memory-entry-query','画像条目 02'); await search(); await uiWait(`document.querySelector('[data-memory-edit="fixture-memory-02"]')`,'remaining source'); await openSource('fixture-memory-02'); dialogDecision=true; await click('#memory-forget'); await waitFor(async()=>(await api('/api/memory/sessions?projectId=*')).total===1,'source deletion'); await uiWait(`document.querySelector('#memory-context-content').textContent.includes('已删除')`,'deletion acknowledged'); await assert.rejects(fs.access(path.join(dataDir,'history',runId+'.json'))); await delay(5300); assert.equal((await api('/api/memory/sessions?projectId=*')).total,1);
  assert.ok(report.requests.every(r=>!(r.url==='/api/memory/entries'&&r.method==='POST'))); assert.ok(report.requests.filter(r=>r.url.startsWith('/api/memory/entries')).every(r=>!r.url.includes('projectId'))); assert.ok(report.requests.filter(r=>r.url==='/api/memory/jobs'&&r.body.type==='reflect').every(r=>Object.keys(r.body).length===1)); check('explicit deletions preserve originals until forgotten and never resurrect');
  assert.deepEqual(report.pageErrors,[]); report.passed=true;
} catch(error) {
  report.passed=false; report.error=error.stack; try{if(evaluate)report.visibleText=await evaluate('document.body.innerText');}catch{} try{if(manager)await screenshot('failure');}catch{} console.error(error.stack); process.exitCode=1;
} finally {
  if(manager){try{await manager.stopAll();report.browserProfilesCleaned=manager.browserTools.profiles.size===0;}catch(error){report.browserCleanupError=error.message;}}
  if(server){try{await server.close();}catch(error){report.serverCleanupError=error.message;}}
  if(child&&!childError&&!childExit){try{await api('/api/shutdown',{method:'POST'});await waitFor(()=>Boolean(childExit),'isolated EXE shutdown',15000);}catch(error){report.exeCleanupError=error.message;child.kill();report.forcedOwnedExeStop=true;try{await waitFor(()=>Boolean(childExit),'owned EXE exit');}catch(failure){report.exeCleanupError=failure.message;}}}
  if(childExit){report.exeExitCode=childExit.code;if(childExit.code!==0||childExit.signal)report.exeCleanupError='Owned EXE exited abnormally';}
  if(fakeModel){fakeModel.closeAllConnections();await new Promise(resolve=>fakeModel.close(resolve));}
  try{const resolved=await fs.realpath(dataDir);assert.equal(path.dirname(resolved),directory);assert.equal(path.basename(resolved),'profile');await fs.rm(resolved,{recursive:true,force:true});report.profileRemoved=true;}catch(error){report.cleanupError=error.message;}
  if(report.browserCleanupError||report.browserProfilesCleaned===false||report.serverCleanupError||report.exeCleanupError||report.forcedOwnedExeStop||report.cleanupError){report.passed=false;process.exitCode=1;}
  report.finishedAt=new Date().toISOString();await fs.writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,reportFile,screenshots:report.screenshots,profileRemoved:report.profileRemoved}));
}
