import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const selection = source.slice(source.indexOf('  // Classroom selection'), source.indexOf('  // End classroom selection.'));
const principal = source.slice(source.indexOf('  // Principal reports'), source.indexOf('  // End independent principal reports.'));
const controls = source.slice(source.indexOf('  function updateControls()'), source.indexOf('  function fillSettings()'));
const readiness = source.slice(source.indexOf('  function teamReady()'), source.indexOf('  function memberFailures('));
const refresh = source.slice(source.indexOf('  async function refresh()'), source.indexOf('  async function action('));
const submit = source.slice(source.indexOf("  $('workspace-new-conversation').addEventListener"), source.indexOf("  $('clear-task-button').addEventListener"));
const deletion = source.slice(source.indexOf('  async function clearSelectedTask()'), source.indexOf('  function closeSavedDialog('));
const run = (id, status = 'completed', task = `问题 ${id}`) => ({ id, status, task, startedAt: `2026-10-${id === 'a' ? '14' : '15'}T08:00:00Z` });
const fixture = () => ({ dataDir: 'isolated-data-a', agents: [{ id: 'teacher', role: 'teacher' }, { id: 's1', role: 'student' }, { id: 's2', role: 'student' }], run: run('b'), history: [run('b'), run('a')] });
const builtinTaskModes = ['auto', 'web_pentest', 'ctf_solve', 'binary_audit', 'pentest'];
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness({ initial = fixture(), stored = {}, handler } = {}) {
  const elements = new Map(), calls = [], notices = [], storage = new Map(Object.entries(stored)), timers = new Map(), frames = new Map(), observers = []; let timerSequence = 0, frameSequence = 0;
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, hidden: false, readOnly: false, innerHTML: '', textContent: '', listeners: {}, attributes: {}, style: {}, dataset: {}, classList:{toggle(){}}, scrollHeight: 40, scrollTop: 0,
      setAttribute(name, value) { this.attributes[name] = value; }, querySelectorAll() { return []; }, querySelector() { return $('menu-pin'); }, getClientRects() { return []; }, getBoundingClientRect() { return { right:300,top:50,bottom:80,width:150,height:120 }; }, addEventListener(name, callback) { this.listeners[name] = callback; }, focus() {}, click() {}, show() {this.open=true;}, close() {this.open=false;this.listeners.close?.();} });
    return elements.get(id);
  };
  const context = vm.createContext({ $, state: initial, viewingRun: null, taskInputRunId: null, taskInputDirty: false, viewingRequest: 0, savedViewingRunId: '', stateEpoch: 0,
    page:'workspace', extensionsRequest:0, extensionsLoading:false, extensionsData:null, modesData:null, extensionSelected:new Set(), modeEditing:null, extensionDeletion:null,
    busy: false, clearingRunId: '', dataDirectorySaving: false, directoryPickerPending: false, judgeBusy: false, shutdown: false, shuttingDown: false, lastConnection: true,
    token: 'isolated-token', refreshPending: false, settingsDirty: false, dataDirectoryDirty: false, pendingMemberRetries: new Set(), pendingChecks: new Set(), dispatchingTask: false,
    terminal: status => ['completed', 'failed', 'stopped', 'cancelled', 'interrupted'].includes(status), statusNames: { completed: '已完成', running: '讨论中', paused:'已暂停', scheduled:'待执行', missed:'已错过' },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    formatDate: value => value || '—', icon: () => '<svg></svg>', rememberBoard() {}, navigate() {}, renderRun() {}, extensionControls() {}, judgeFeatureVisibility() {},
    memberFailures: () => [], retryAllowed: () => false, teamReady: () => true, openDialog(id) { $(id).open=true; }, closeSavedDialog(id) { $(id).open=false; }, dialogSessions:new Map(), showAccess() {}, setConnection: online => { context.lastConnection = online; }, renderUpdateControls() {}, acceptUpdateSnapshot() {},
    document: { querySelectorAll: () => [], addEventListener() {} }, window: { addEventListener() {}, innerWidth:1280,innerHeight:900 },
    getComputedStyle: () => ({lineHeight:'22px',paddingTop:'9px',paddingBottom:'9px',borderTopWidth:'1px',borderBottomWidth:'1px'}),
    FileReader: class { readAsDataURL(file) { this.result='data:application/octet-stream;base64,'+Buffer.from(file.content || '').toString('base64'); this.onload(); } },
    confirm: () => true, prompt: () => null, boardViews:new Map(), persistBoard() {}, evidenceRequest:0,evidenceState:null,evidenceReturnLogsRunId:'', evidenceControls() {}, memoryDeletionNotice: (_result,message)=>({message}),showMemoryDeletionNotice() {},
    dialogReturnFocus:new WeakMap(),AbortController,setTimeout:(callback,delay)=>{const id=++timerSequence;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),
    requestAnimationFrame:callback=>{const id=++frameSequence;frames.set(id,callback);return id;},
    ResizeObserver:class {constructor(callback){this.callback=callback;observers.push(this);}observe(target){this.target=target;}},
    toast: (message, error) => notices.push({ message, error }),
    api: async (url, options = {}) => { calls.push({ url, method: options.method || 'GET', body: options.body }); return handler ? handler(url, options) : url === '/api/state' ? context.state : { run: context.state.history.find(item => url.endsWith('/' + item.id)) }; }
  });
  context.action = async work => { if (context.busy) return; context.busy = true; try { await work(); } catch(error) { notices.push({message:error.message,error:true}); } finally { context.busy = false; } };
  vm.runInContext(selection + principal + readiness + controls + refresh + deletion + submit + `
    globalThis.ui = { newConversation, viewConversation, fillTaskInput, renderWorkspaceHistory, updateControls, refresh, selectedRun,
      isDraft: () => draftMode, draft: () => draftTask, request: () => viewingRequest, resizeTaskInput, uploadTaskFiles, removeDraftAttachment,
      updateConversation, deleteConversation, clearSelectedTask, renderTaskAttachments, attachments: () => draftAttachments, validateDraftAttachments,
      openPrincipalReport, sendPrincipalQuestion, cancelPrincipalReport, closePrincipalView, pollPrincipalReport, submitBtw, principalView:()=>principalView,
      activeRuns,controlRun,stopRun,openScheduledTask,saveScheduledTask,scheduleDateInput,scheduleValue,describeSchedule,taskSpec:()=>draftTaskSpec };
  `, context);
  context.render = () => { context.ui.fillTaskInput(); context.ui.renderWorkspaceHistory(); context.ui.updateControls(); };
  const edit = value => { $('task-input').value = value; $('task-input').listeners.input(); };
  return { $, ui: context.ui, context, calls, notices, storage, edit, timers, frames, observers };
}

test('new conversations and historical navigation retain the draft without mutating stored or running tasks', async () => {
  const f = harness(), originalRun = f.context.state.run;
  f.ui.newConversation(); f.edit('尚未提交的新问题');
  await f.ui.viewConversation('a');
  assert.equal(f.$('task-input').value, ''); assert.equal(f.$('workspace-task-original').textContent, '问题 a'); assert.equal(f.$('task-input').readOnly, false);
  await f.ui.viewConversation('b'); f.ui.newConversation();
  assert.equal(f.$('task-input').value, '尚未提交的新问题');
  assert.equal(f.context.state.run, originalRun); assert.equal(f.context.state.history.length, 2);
  assert.ok(f.calls.every(call => call.method === 'GET')); assert.equal(f.ui.selectedRun(), null);
  f.context.render(); assert.equal(f.$('task-input').value, '尚未提交的新问题');
});

test('the latest historical selection wins when earlier responses arrive late', async () => {
  const pending = defer();
  const f = harness({ handler: url => url.endsWith('/a') ? pending.promise : { run: run('c') } });
  const first = f.ui.viewConversation('a'); await f.ui.viewConversation('c');
  pending.resolve({ run: run('a') }); await first;
  assert.equal(f.ui.selectedRun().id, 'c'); assert.equal(f.$('workspace-task-original').textContent, '问题 c'); assert.equal(f.$('task-input').value, '');
});

test('entering a new conversation cancels a pending selection without discarding newly edited text', async () => {
  const pending = defer(), f = harness({ handler: () => pending.promise });
  const loading = f.ui.viewConversation('a'); f.ui.newConversation(); f.edit('保留本次草稿');
  pending.resolve({ run: run('a') }); await loading;
  assert.equal(f.ui.isDraft(), true); assert.equal(f.$('task-input').value, '保留本次草稿');
  assert.equal(f.notices.length, 0);
});

test('an active task remains separate from concurrent drafts and historical stop controls', async () => {
  const state = fixture(); state.run = run('b', 'running');
  const f = harness({ initial: state }); f.ui.newConversation(); f.edit('下一次任务');
  assert.equal(f.$('task-input').readOnly, false); assert.equal(f.$('task-input').disabled, false);
  assert.equal(f.$('start-button').disabled, false); assert.equal(f.$('start-button').dataset.action, 'submit');
  assert.equal(f.$('workspace-active-notice').hidden, false);
  await f.ui.viewConversation('a'); assert.equal(f.$('start-button').dataset.action, 'submit');
  await f.ui.viewConversation('b'); assert.equal(f.$('start-button').dataset.action, 'stop');
  assert.equal(f.context.state.run.status, 'running');
});

test('concurrent runs refresh by selected ID without a newer conversation stealing the selected classroom', async () => {
  const first=run('a','running'),second=run('b','running'),state={...fixture(),run:second,runs:[first,second],history:[first,second]};
  let next=state;
  const f=harness({initial:state,handler:url=>url==='/api/state'?next:{run:{...first,status:'completed',result:{answer:'done'}}}});
  await f.ui.viewConversation('a');
  assert.equal(f.ui.selectedRun().id,'a');assert.equal(f.$('start-button').dataset.action,'stop');assert.equal(f.$('pause-button').hidden,false);
  next={...state,runs:[{...first,phase:'reviewing'},second]};await f.ui.refresh();
  assert.equal(f.ui.selectedRun().id,'a');assert.equal(f.ui.selectedRun().phase,'reviewing');
  next={...state,runs:[second],history:[{...first,status:'completed'},second]};await f.ui.refresh();
  assert.equal(f.ui.selectedRun().id,'a');assert.equal(f.ui.selectedRun().status,'completed');assert.equal(f.$('start-button').dataset.action,'submit');
  assert.equal(f.ui.activeRuns().length,1);assert.equal(f.ui.activeRuns()[0].id,'b');
});

test('Task and Schedule stay in the draft, submit authoritative fields with the mode and reset only after success', async () => {
  const active=run('b','running'),state={...fixture(),run:active,runs:[active]},pending=defer();
  const f=harness({initial:state,handler:(url,options)=>options.method==='POST'?pending.promise:{run:state.history.find(item=>url.endsWith('/'+item.id))}});
  f.ui.newConversation();assert.equal(f.$('task-schedule').disabled,true);
  f.$('task-kind').checked=true;f.$('task-kind').listeners.change();
  assert.equal(f.$('task-schedule').disabled,false);assert.equal(f.$('task-spec-fields').hidden,false);
  for(const [id,value] of [['task-name','夜间复核'],['task-goal','交付验证报告'],['task-schedule-at','2099-10-19T22:15']]){f.$(id).value=value;f.$(id).listeners.input();}
  f.edit('只检查授权范围');f.$('task-schedule').checked=true;f.$('task-schedule').listeners.change();
  f.$('task-mode').value='binary_audit';f.$('task-mode').listeners.change();
  await f.ui.viewConversation('a');f.ui.newConversation();
  assert.equal(f.$('task-name').value,'夜间复核');assert.equal(f.$('task-goal').value,'交付验证报告');assert.equal(f.$('task-schedule').checked,true);
  assert.equal(f.$('task-description').value,'只检查授权范围');assert.equal(f.$('task-input').hidden,true);
  f.$('task-form').listeners.submit({preventDefault(){}});
  const posted=f.calls.find(call=>call.method==='POST');
  assert.deepEqual(JSON.parse(JSON.stringify(posted.body)),{taskSpec:{name:'夜间复核',description:'只检查授权范围',goal:'交付验证报告'},attachmentIds:[],taskMode:'binary_audit',schedule:{at:'2099-10-19T14:15:00.000Z',timeZone:'Asia/Shanghai'}});
  pending.resolve({run:{...run('scheduled','scheduled','完整任务'),...posted.body}});await settle();f.context.render();
  assert.equal(f.ui.activeRuns().length,1);assert.equal(f.ui.activeRuns()[0].id,'b');
  assert.equal(f.$('scheduled-task-panel').hidden,false);assert.equal(f.$('task-form').hidden,true);
  f.ui.newConversation();assert.equal(f.$('task-kind').checked,false);assert.equal(f.$('task-schedule').checked,false);assert.equal(f.$('task-schedule').disabled,true);
});

test('Task submission rejects missing goals and past schedules without consuming the editable draft', () => {
  const f=harness();f.ui.newConversation();f.$('task-kind').checked=true;f.$('task-kind').listeners.change();f.edit('描述');
  f.$('task-name').value='任务';f.$('task-name').listeners.input();
  f.$('task-form').listeners.submit({preventDefault(){}});assert.equal(f.calls.length,0);assert.match(f.notices.at(-1).message,/目标/);
  f.$('task-goal').value='目标';f.$('task-goal').listeners.input();f.$('task-schedule').checked=true;f.$('task-schedule').listeners.change();
  f.$('task-schedule-at').value='2000-01-01T00:00';f.$('task-schedule-at').listeners.input();f.$('task-form').listeners.submit({preventDefault(){}});
  assert.equal(f.calls.length,0);assert.match(f.notices.at(-1).message,/未来/);assert.equal(f.$('task-input').value,'描述');
  f.$('task-kind').checked=false;f.$('task-kind').listeners.change();assert.equal(f.$('task-schedule').checked,false);assert.equal(f.$('task-name').required,false);
});

test('task descriptions stay synchronized with the conversation draft across toggles and history navigation', async () => {
  const f=harness();f.ui.newConversation();f.edit('普通草稿');
  f.$('task-kind').checked=true;f.$('task-kind').listeners.change();
  assert.equal(f.$('task-description').value,'普通草稿');assert.equal(f.$('task-description').required,true);
  assert.equal(f.$('task-input').required,false);assert.equal(f.$('task-input').hidden,true);
  f.$('task-description').value='任务描述\n第二行';f.$('task-description').listeners.input();
  await f.ui.viewConversation('a');f.ui.newConversation();
  assert.equal(f.$('task-description').value,'任务描述\n第二行');assert.equal(f.ui.draft(),'任务描述\n第二行');
  f.$('task-kind').checked=false;f.$('task-kind').listeners.change();
  assert.equal(f.$('task-input').value,'任务描述\n第二行');assert.equal(f.$('task-input').hidden,false);
  assert.equal(f.$('task-description').required,false);assert.equal(f.$('task-input').required,true);
});

test('schedule creation, editing and display use Shanghai time on computers in other time zones', () => {
  const functions=source.slice(source.indexOf('  function scheduleDateInput('),source.indexOf('  function renderTaskSpec('));
  const script=`const vm=require('node:vm');const result=vm.runInNewContext(${JSON.stringify("const taskTimeZone='Asia/Shanghai';"+functions+"JSON.stringify({created:scheduleValue('2099-10-19T22:15'),editing:scheduleDateInput('2099-10-19T14:15:00Z'),midnight:scheduleDateInput('2099-10-18T16:00:00Z'),display:describeSchedule({schedule:{at:'2099-10-19T14:15:00Z',timeZone:'America/New_York'}})})")});process.stdout.write(result);`;
  const results=['UTC','America/New_York','Asia/Tokyo'].map(TZ=>JSON.parse(execFileSync(process.execPath,['-e',script],{env:{...process.env,TZ},encoding:'utf8'})));
  for(const result of results){
    assert.deepEqual(result.created,{at:'2099-10-19T14:15:00.000Z',timeZone:'Asia/Shanghai'});
    assert.equal(result.editing,'2099-10-19T22:15');assert.equal(result.midnight,'2099-10-19T00:00');
    assert.match(result.display,/22:15/);assert.doesNotMatch(result.display,/Asia\/Shanghai|America\/New_York|UTC/);
  }
  assert.deepEqual(results[0],results[1]);assert.deepEqual(results[1],results[2]);
  const f=harness();assert.throws(()=>f.ui.scheduleValue('2099-02-31T12:00'),/未来/);
});

test('pending schedule history displays Shanghai time while ordinary started conversations retain local dates', () => {
  // scheduleRun uses creation time as startedAt until the reserved run actually starts.
  const scheduled={id:'pending',status:'scheduled',scheduled:true,taskSpec:{name:'定时任务'},schedule:{at:'2099-10-19T14:15:00Z',timeZone:'America/Los_Angeles'},startedAt:'2099-10-18T01:00:00Z',finishedAt:null};
  const started={...run('started'),scheduled:false,schedule:scheduled.schedule,startedAt:'2099-10-19T14:15:00Z'},f=harness({initial:{...fixture(),run:started,history:[scheduled,started]}});
  f.context.formatDate=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'America/Los_Angeles',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
  f.ui.renderWorkspaceHistory();const markup=f.$('workspace-history-content').innerHTML;
  assert.match(markup,/data-run-view="pending"[\s\S]*?<time[^>]*>10\/19 22:15<\/time>/);
  assert.match(markup,/data-run-view="started"[\s\S]*?<time[^>]*>[^<]*07:15<\/time>/);
});

test('the same composer button becomes stop after starting, bypasses unrelated busy work and isolates its pending request', async () => {
  const first=run('a','running'),second=run('b','running'),state={...fixture(),run:second,runs:[first,second],history:[first,second]},pending=defer();
  const f=harness({initial:state,handler:url=>url==='/api/runs/a/stop'?pending.promise:{run:{...second,status:'stopping'}}});
  await f.ui.viewConversation('a');assert.equal(f.$('start-button').type,'button');assert.equal(f.$('start-button').attributes['aria-label'],'停止任务');
  f.context.busy=true;f.context.judgeBusy=true;f.ui.updateControls();assert.equal(f.$('start-button').disabled,false);
  f.$('start-button').listeners.click({preventDefault(){}});f.$('start-button').listeners.click({preventDefault(){}});
  assert.equal(f.calls.filter(call=>call.url==='/api/runs/a/stop').length,1);assert.equal(f.$('start-button').disabled,true);
  assert.equal(f.$('start-button').attributes['aria-label'],'正在停止…');
  f.context.busy=false;f.context.judgeBusy=false;await f.ui.viewConversation('b');
  assert.equal(f.$('start-button').disabled,false);assert.equal(f.ui.selectedRun().id,'b');
  pending.resolve({run:{...first,status:'stopped'}});await settle();
  assert.equal(f.ui.selectedRun().id,'b');assert.equal(f.ui.activeRuns()[0].id,'b');assert.equal(second.status,'running');
  assert.equal(f.$('start-button').dataset.action,'stop');
});

test('stop errors leave the same task retryable, and a late pause reply cannot overwrite a newer stop', async () => {
  const first=run('a','running'),state={...fixture(),run:first,runs:[first],history:[first]},pause=defer();let failed=true;
  const f=harness({initial:state,handler:url=>{
    if(url.endsWith('/pause'))return pause.promise;
    if(failed){failed=false;throw Error('断连');}
    return {run:{...first,status:'stopping'}};
  }});
  f.context.render();await f.ui.stopRun('a');assert.equal(f.$('start-button').disabled,false);assert.match(f.notices.at(-1).message,/断连/);
  const pausing=f.ui.controlRun('pause');await f.ui.stopRun('a');
  pause.resolve({run:{...first,status:'paused'}});await pausing;
  assert.equal(f.ui.selectedRun().status,'stopping');assert.equal(f.$('start-button').disabled,true);
  assert.deepEqual(f.calls.map(call=>call.url),['/api/runs/a/stop','/api/runs/a/pause','/api/runs/a/stop']);
});

test('a deferred stop cannot resurrect a task deleted from history or cleared from the selected classroom', async () => {
  for(const clear of [false,true]){
    const first=run('a','running'),second=run('b','running'),state={...fixture(),run:second,runs:[first,second],history:[first,second]},pending=defer();
    const f=harness({initial:state,handler:(url,options)=>url.endsWith('/stop')?pending.promise:options.method==='DELETE'?{ok:true,deletedId:'a',run:second,runs:[second],history:[second]}:{run:first}});
    await f.ui.viewConversation('a');const stopping=f.ui.stopRun('a');
    if(clear)await f.ui.clearSelectedTask();else await f.ui.deleteConversation('a');
    assert.equal(f.ui.isDraft(),true);assert.equal(f.context.state.history.some(item=>item.id==='a'),false);
    pending.resolve({run:{...first,status:'stopping'}});await stopping;
    assert.equal(f.context.state.history.some(item=>item.id==='a'),false);assert.equal(f.context.state.run.id,'b');
    assert.deepEqual(Array.from(f.ui.activeRuns(),item=>item.id),['b']);assert.equal(f.ui.isDraft(),true);
    assert.equal(f.$('start-button').dataset.action,'submit');assert.equal(f.notices.some(item=>item.message==='已请求停止此任务。'),false);
  }
});

test('a stop response arriving during the same task deletion does not alter the classroom being cleared', async () => {
  const first=run('a','running'),state={...fixture(),run:first,runs:[first],history:[first]},stop=defer(),remove=defer();
  const f=harness({initial:state,handler:(_url,options)=>options.method==='DELETE'?remove.promise:stop.promise});
  f.context.render();const stopping=f.ui.stopRun('a'),deleting=f.ui.deleteConversation('a');
  stop.resolve({run:{...first,status:'stopping'}});await stopping;
  assert.equal(f.context.clearingRunId,'a');assert.equal(f.ui.selectedRun(),first);assert.equal(f.notices.length,0);
  remove.resolve({ok:true,deletedId:'a',run:null,runs:[],history:[]});await deleting;
  assert.equal(f.ui.activeRuns().length,0);assert.equal(f.context.state.history.length,0);assert.equal(f.ui.isDraft(),true);
});

test('only the stopping task loses pause and resume controls while another classroom remains controllable', async () => {
  for(const status of ['running','paused']){
    const first=run('a',status),second=run('b','running'),state={...fixture(),run:second,runs:[first,second],history:[first,second]},stop=defer();
    const f=harness({initial:state,handler:url=>url.endsWith('/stop')?stop.promise:{run:{...second,status:'paused'}}});
    await f.ui.viewConversation('a');const stopping=f.ui.stopRun('a');
    assert.equal(f.$('pause-button').disabled,true);assert.equal(f.$('resume-button').disabled,true);
    await f.ui.controlRun('pause','a');await f.ui.controlRun('resume','a');assert.equal(f.calls.length,1);
    await f.ui.viewConversation('b');assert.equal(f.$('pause-button').disabled,false);await f.ui.controlRun('pause');
    assert.equal(f.calls.at(-1).url,'/api/runs/b/pause');assert.equal(f.ui.selectedRun().status,'paused');
    stop.resolve({run:{...first,status:'stopping'}});await stopping;
    await f.ui.controlRun('pause','a');await f.ui.controlRun('resume','a');assert.equal(f.calls.length,2);
    assert.equal(f.ui.selectedRun().id,'b');assert.equal(f.$('resume-button').disabled,false);
  }
});

test('ordinary concurrent submissions preserve another active run and do not inherit hidden Task fields', async () => {
  const first=run('b','running'),state={...fixture(),run:first,runs:[first]};
  const f=harness({initial:state,handler:()=>({run:run('new','running','新对话')})});f.ui.newConversation();
  f.$('task-kind').checked=true;f.$('task-kind').listeners.change();f.$('task-name').value='不应发送';f.$('task-name').listeners.input();
  f.$('task-kind').checked=false;f.$('task-kind').listeners.change();f.edit('新对话');f.$('task-form').listeners.submit({preventDefault(){}});await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)),{task:'新对话',attachmentIds:[],taskMode:'auto'});
  assert.deepEqual(Array.from(f.ui.activeRuns(),run=>run.id),['b','new']);assert.equal(first.status,'running');
});

test('pause, resume and stop address the selected run and preserve every other active classroom', async () => {
  const first=run('a','running'),second=run('b','running'),state={...fixture(),run:second,runs:[first,second],history:[first,second]};
  const f=harness({initial:state,handler:(url)=>({run:{...first,status:url.endsWith('/pause')?'paused':url.endsWith('/resume')?'running':'stopping'}})});
  await f.ui.viewConversation('a');await f.ui.controlRun('pause');f.context.render();
  assert.equal(f.$('resume-button').hidden,false);assert.equal(f.$('pause-button').hidden,true);assert.equal(f.ui.selectedRun().status,'paused');
  await f.ui.controlRun('resume');await f.ui.controlRun('stop');
  assert.deepEqual(f.calls.map(call=>call.url),['/api/runs/a/pause','/api/runs/a/resume','/api/runs/a/stop']);
  assert.equal(f.ui.activeRuns().find(run=>run.id==='b'),second);assert.equal(second.status,'running');
});

test('pending schedules expose edit/start/cancel, retain attachments and never send an accidental immediate task', async () => {
  const scheduled={...run('a','missed','旧描述'),taskSpec:{name:'旧名称',description:'旧描述',goal:'旧目标'},schedule:{at:'2000-01-01T00:00:00Z',timeZone:'UTC'},taskMode:'ctf_solve',attachments:[{id:'bound-file',name:'sample.txt',size:3}]};
  const active=run('b','running'),state={...fixture(),run:active,runs:[active],history:[scheduled,active]};
  const f=harness({initial:state,handler:(url,options)=>options.method==='PATCH'?{run:{...scheduled,...options.body,status:'scheduled'}}:options.method==='POST'?{run:{...scheduled,status:url.endsWith('/start')?'running':'cancelled'}}:{run:scheduled}});
  await f.ui.viewConversation('a');assert.equal(f.$('scheduled-task-panel').hidden,false);assert.match(f.$('scheduled-task-note').textContent,/已错过/);
  assert.match(f.$('workspace-history-content').innerHTML,/已错过/);f.ui.openScheduledTask();assert.equal(f.$('schedule-edit-dialog').open,true);
  f.$('schedule-edit-name').value='修改名称';f.$('schedule-edit-goal').value='修改目标';f.$('schedule-edit-at').value='2099-01-01T12:00';
  await f.ui.saveScheduledTask();const patch=f.calls.find(call=>call.method==='PATCH');assert.equal(patch.url,'/api/runs/a');assert.equal(patch.body.taskSpec.name,'修改名称');assert.equal(Object.hasOwn(patch.body,'attachmentIds'),false);
  assert.equal(f.ui.selectedRun().attachments[0].id,'bound-file');assert.equal(f.$('schedule-edit-dialog').open,false);
  await f.ui.controlRun('cancel');assert.equal(f.calls.at(-1).url,'/api/runs/a/cancel');assert.equal(f.ui.selectedRun().status,'cancelled');assert.equal(active.status,'running');
  f.context.state.history=[scheduled,active];f.context.state.run=active;await f.ui.viewConversation('a');await f.ui.controlRun('start');assert.equal(f.calls.at(-1).url,'/api/runs/a/start');assert.equal(f.ui.selectedRun().status,'running');
  assert.equal(f.calls.some(call=>call.url==='/api/runs'),false);
});

test('Task draft fields restore only within the same data directory', async () => {
  const state=fixture(),stored={'class-workspace-view':JSON.stringify({dataDir:state.dataDir,draftMode:true,draftTask:'描述',draftTaskSpec:{enabled:true,name:'保存的名称',goal:'保存的目标',scheduled:true,at:'2099-01-01T12:00'}})};
  const f=harness({initial:null,stored,handler:url=>url==='/api/state'?state:{attachments:[]}});await f.ui.refresh();
  assert.equal(f.$('task-name').value,'保存的名称');assert.equal(f.$('task-schedule').checked,true);
  f.context.state={...state,dataDir:'old'};state.dataDir='new';state.run=null;state.history=[];await f.ui.refresh();
  assert.equal(f.$('task-kind').checked,false);assert.equal(f.$('task-name').value,'');assert.equal(f.$('task-goal').value,'');
});

test('failed schedule placeholders remain retryable and show descriptions while principal access waits for a real run', async () => {
  const scheduled={...run('a','failed','生成的完整任务'),scheduled:true,taskSpec:{name:'启动失败任务',description:'原始描述',goal:'目标'},schedule:{at:'2000-01-01T00:00:00Z',timeZone:'UTC'}};
  const active=run('b','running'),state={...fixture(),run:active,runs:[active],history:[scheduled,active]};
  const f=harness({initial:state,handler:(url,options)=>options.method==='POST'?{run:{...scheduled,status:'cancelled'}}:{run:scheduled}});
  await f.ui.viewConversation('a');
  assert.equal(f.$('scheduled-task-panel').hidden,false);assert.match(f.$('scheduled-task-note').textContent,/启动失败/);
  assert.equal(f.$('task-spec-description-field').hidden,false);assert.equal(f.$('task-spec-description').textContent,'原始描述');
  assert.equal(f.$('principal-button').disabled,true);assert.equal(f.$('scheduled-start').disabled,false);
  f.ui.openScheduledTask();assert.equal(f.$('schedule-edit-dialog').open,true);
  await f.ui.controlRun('cancel');f.context.render();
  assert.equal(f.$('scheduled-task-panel').hidden,true);assert.equal(f.$('principal-button').disabled,true);
  const count=f.calls.length;await f.ui.controlRun('start');assert.equal(f.calls.length,count);
  await f.ui.viewConversation('b');assert.equal(f.$('principal-button').disabled,false);
});

test('a dispatched schedule waits for the actual run before exposing live controls or principal access', async () => {
  const scheduled={...run('a','scheduled'),scheduled:true,taskSpec:{name:'待启动',description:'描述',goal:'目标'},schedule:{at:'2099-01-01T00:00:00Z',timeZone:'UTC'}};
  const active=run('b','running'),state={...fixture(),run:active,runs:[active],history:[scheduled,active]};
  let next=state;
  const f=harness({initial:state,handler:(url,options)=>url==='/api/state'?next:{run:options.method==='POST'?{...scheduled,status:'starting'}:scheduled}});
  await f.ui.viewConversation('a');await f.ui.controlRun('start');f.context.render();
  assert.equal(f.ui.selectedRun().status,'starting');assert.equal(f.ui.activeRuns().length,1);
  assert.equal(f.$('start-button').dataset.action,'submit');assert.equal(f.$('principal-button').disabled,true);
  const dispatched={...scheduled,status:'running',scheduled:false};next={...state,run:dispatched,runs:[active,dispatched],history:[dispatched,active]};
  await f.ui.refresh();assert.equal(f.ui.selectedRun().id,'a');assert.equal(f.ui.selectedRun().status,'running');
  assert.equal(f.$('start-button').dataset.action,'stop');assert.equal(f.$('principal-button').disabled,false);
});

test('same-directory refresh restores a new draft and its historical navigation separately', async () => {
  const stored = { 'class-workspace-view': JSON.stringify({ dataDir: 'isolated-data-a', draftMode: true, draftTask: '刷新后仍保留', runId: '' }) };
  const state = fixture(), f = harness({ initial: null, stored, handler: () => state });
  await f.ui.refresh(); assert.equal(f.ui.isDraft(), true); assert.equal(f.$('task-input').value, '刷新后仍保留');
  f.edit('轮询不覆盖'); await f.ui.refresh(); assert.equal(f.$('task-input').value, '轮询不覆盖');
  const saved = JSON.parse(f.storage.get('class-workspace-view'));
  assert.equal(saved.draftTask, '轮询不覆盖'); assert.equal(saved.dataDir, state.dataDir);
});

test('drafts and selected history never cross data directories', async () => {
  const stored = { 'class-workspace-view': JSON.stringify({ dataDir: 'other-private-data', draftMode: true, draftTask: '其他目录的私有草稿', runId: 'a' }) };
  const state = fixture(), f = harness({ initial: null, stored, handler: () => state });
  await f.ui.refresh(); assert.equal(f.ui.isDraft(), false); assert.equal(f.$('workspace-task-original').textContent, '问题 b'); assert.equal(f.$('task-input').value, ''); assert.equal(f.ui.draft(), '');
  f.ui.newConversation(); f.edit('当前目录草稿'); state.dataDir = 'new-isolated-data'; state.run = null; state.history = [];
  // Return a separate state object, as the HTTP snapshot does.
  f.context.state = { ...f.context.state, dataDir: 'isolated-data-a', run: run('b') };
  await f.ui.refresh(); assert.equal(f.ui.isDraft(), true); assert.equal(f.$('task-input').value, ''); assert.equal(f.ui.draft(), '');
});

test('saved historical selection is restored without making a new task', async () => {
  const state = fixture(), stored = { 'class-workspace-view': JSON.stringify({ dataDir: state.dataDir, draftMode: false, draftTask: '备用草稿', runId: 'a' }) };
  const f = harness({ initial: null, stored, handler: url => url === '/api/state' ? state : { run: run('a') } });
  await f.ui.refresh(); assert.equal(f.ui.selectedRun().id, 'a'); assert.equal(f.$('task-input').readOnly, false); assert.equal(f.$('workspace-task-original').textContent, '问题 a');
  f.ui.newConversation(); assert.equal(f.$('task-input').value, '备用草稿');
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('a late state poll cannot replace the historical view selected while it was pending', async () => {
  const pending = defer(), state = fixture();
  const f = harness({ handler: url => url === '/api/state' ? pending.promise : { run: run('a') } });
  const poll = f.ui.refresh(); await f.ui.viewConversation('a'); pending.resolve(state); await poll;
  assert.equal(f.ui.selectedRun().id, 'a'); assert.equal(f.$('task-input').value, ''); assert.equal(f.$('workspace-task-original').textContent, '问题 a');
});

test('disabled browser storage does not prevent drafts or historical navigation', async () => {
  const f = harness(); f.context.sessionStorage.setItem = () => { throw new Error('storage disabled'); };
  f.context.sessionStorage.removeItem = () => { throw new Error('storage disabled'); };
  f.ui.newConversation(); f.edit('内存中的草稿'); await f.ui.viewConversation('a'); f.ui.newConversation();
  assert.equal(f.$('task-input').value, '内存中的草稿'); assert.equal(f.notices.length, 0);
});

test('submitting a new draft creates one task and then selects its saved original question', async () => {
  const pending = defer(), created = run('new', 'running', '新的完整问题');
  const f = harness({ handler: () => pending.promise });
  f.ui.newConversation(); f.edit(created.task);
  f.$('task-form').listeners.submit({ preventDefault() {} });
  f.$('task-form').listeners.submit({ preventDefault() {} });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/runs'); assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].body.task, created.task);
  pending.resolve({ run: created }); await new Promise(resolve => setImmediate(resolve));
  f.context.render();
  assert.equal(f.ui.isDraft(), false); assert.equal(f.ui.selectedRun().id, created.id); assert.equal(f.ui.draft(), '');
  assert.equal(f.$('task-input').value, ''); assert.equal(f.$('workspace-task-original').textContent, created.task); assert.equal(f.$('task-input').readOnly, false);
});

test('the history list deduplicates current tasks and escapes stored text and identifiers', () => {
  const state = fixture(), attack = '<img src=x onerror="bad()">';
  state.run.task = attack; state.history[0].task = 'outdated summary'; state.history.push(run(attack));
  const f = harness({ initial: state }); f.ui.renderWorkspaceHistory();
  const markup = f.$('workspace-history-content').innerHTML;
  assert.equal((markup.match(/data-run-view="b"/g) || []).length, 1);
  assert.ok(!markup.includes('<img')); assert.ok(markup.includes('&lt;img')); assert.ok(markup.includes('&quot;'));
  assert.ok(markup.includes('is-selected')); assert.equal(f.$('workspace-conversation-title').hidden, true);
});

test('the composer grows from one to three lines, scrolls beyond three, and preserves its scroll position', () => {
  const f = harness(), input = f.$('task-input'); input.getClientRects = () => [{}];
  input.scrollHeight = 40; f.ui.resizeTaskInput(); assert.equal(input.style.height,'42px'); assert.equal(input.style.overflowY,'hidden');
  input.scrollHeight = 62; f.ui.resizeTaskInput(); assert.equal(input.style.height,'64px');
  input.scrollHeight = 84; f.ui.resizeTaskInput(); assert.equal(input.style.height,'86px'); assert.equal(input.style.overflowY,'hidden');
  input.scrollHeight = 128; input.scrollTop = 33; f.ui.resizeTaskInput(); assert.equal(input.style.height,'86px'); assert.equal(input.style.overflowY,'auto'); assert.equal(input.scrollTop,33);
});

test('uploaded attachments survive history navigation and are included once in the original task submission', async () => {
  const f = harness({handler:(url,options) => url === '/api/attachments' ? {attachment:{id:'file-1',name:'notes.txt',size:5}} : url === '/api/runs' ? {run:{...run('new','running',options.body.task),attachments:[{id:'file-1',name:'notes.txt',size:5}]}} : {run:run('a')}});
  f.ui.newConversation(); f.edit('请检查附件'); await f.ui.uploadTaskFiles([{name:'notes.txt',size:5,content:'hello'}]);
  assert.equal(f.ui.attachments()[0].status,'ready'); assert.equal(f.calls[0].body.contentBase64,'aGVsbG8=');
  await f.ui.viewConversation('a'); assert.equal(f.$('task-attachments').hidden,true); f.ui.newConversation(); assert.equal(f.$('task-attachments').hidden,false);
  f.$('task-form').listeners.submit({preventDefault(){}}); await new Promise(resolve=>setImmediate(resolve));
  const post=f.calls.find(call=>call.url==='/api/runs'); assert.deepEqual(JSON.parse(JSON.stringify(post.body)),{task:'请检查附件',attachmentIds:['file-1'],taskMode:'auto'});
  assert.equal(f.ui.attachments().length,0); assert.equal(f.ui.selectedRun().attachments[0].id,'file-1');
  assert.ok(!f.$('task-attachments').innerHTML.includes('data-attachment-remove'));
});

test('pending or failed uploads prevent task creation until the failure is explicitly removed', async () => {
  const pending=defer(), f=harness({handler:()=>pending.promise}); f.ui.newConversation(); f.edit('附件必须存在');
  const uploading=f.ui.uploadTaskFiles([{name:'bad.txt',size:3,content:'bad'}]);
  f.$('task-form').listeners.submit({preventDefault(){}}); assert.ok(!f.calls.some(call=>call.url==='/api/runs'));
  pending.reject(new Error('写入失败')); await uploading;
  assert.equal(f.ui.attachments()[0].status,'error'); f.$('task-form').listeners.submit({preventDefault(){}});
  assert.ok(!f.calls.some(call=>call.url==='/api/runs'));
  await f.ui.removeDraftAttachment(f.ui.attachments()[0].key); assert.equal(f.ui.attachments().length,0);
});

test('removing an uploaded draft file deletes only that pending attachment', async () => {
  const f=harness({handler:(_url,options)=>options.method==='DELETE' ? {ok:true,deletedId:'f'} : {attachment:{id:'f',name:'a.txt',size:1}}});
  f.ui.newConversation(); await f.ui.uploadTaskFiles([{name:'a.txt',size:1,content:'x'}]); await f.ui.removeDraftAttachment(f.ui.attachments()[0].key);
  assert.equal(f.ui.attachments().length,0); assert.equal(f.calls[1].url,'/api/attachments/f'); assert.equal(f.calls[1].method,'DELETE');
});

test('restored draft attachments are checked against this data directory and missing files block submission', async () => {
  const state=fixture(), stored={'class-workspace-view':JSON.stringify({dataDir:state.dataDir,draftMode:true,draftTask:'恢复附件',draftAttachments:[{id:'present',name:'ok.txt',size:2,status:'ready'},{id:'missing',name:'gone.txt',size:2,status:'ready'}]})};
  const f=harness({initial:null,stored,handler:url=>url==='/api/state' ? state : {attachments:[{id:'present',name:'ok.txt',size:2}]}});
  await f.ui.refresh(); assert.equal(f.ui.attachments()[0].status,'ready'); assert.equal(f.ui.attachments()[1].status,'error'); assert.equal(f.$('start-button').disabled,true);
  assert.equal(f.calls.filter(call=>call.url==='/api/attachments').length,1);
});

test('uploads completed after a data directory switch cannot enter the new draft', async () => {
  const pending=defer(), next={...fixture(),dataDir:'isolated-data-b',run:null,history:[]};
  const f=harness({handler:(url,options)=>url==='/api/state' ? next : options.method==='POST' ? pending.promise : {attachments:[]}}); f.ui.newConversation();
  const uploading=f.ui.uploadTaskFiles([{name:'private.txt',size:1,content:'x'}]); await new Promise(resolve=>setImmediate(resolve));
  await f.ui.refresh(); pending.resolve({attachment:{id:'old-file',name:'private.txt',size:1}}); await uploading;
  assert.equal(f.ui.attachments().length,0); assert.equal(f.context.state.dataDir,next.dataDir); assert.ok(!f.$('task-attachments').innerHTML.includes('private'));
});

test('new browser sessions recover all pending files and retain their delete controls', async () => {
  const state=fixture(), file={id:'orphan',name:'recover.txt',size:3};
  const f=harness({initial:null,handler:(url,options)=>url==='/api/state' ? state : options.method==='DELETE' ? {ok:true,deletedId:file.id} : {attachments:[file]}});
  await f.ui.refresh(); f.ui.newConversation();
  assert.equal(f.ui.attachments()[0].id,'orphan'); assert.ok(f.$('task-attachments').innerHTML.includes('data-attachment-remove'));
  await f.ui.removeDraftAttachment(f.ui.attachments()[0].key); assert.equal(f.ui.attachments().length,0); assert.equal(f.calls.at(-1).url,'/api/attachments/orphan');
});

test('refresh revalidates failed saved IDs and reconciles an upload whose response was lost', async () => {
  const state=fixture(), stored={'class-workspace-view':JSON.stringify({dataDir:state.dataDir,draftMode:true,draftTask:'恢复',draftAttachments:[{id:'retry-check',name:'a.txt',size:1,status:'error'},{name:'b.txt',size:2,status:'uploading'}]})};
  const f=harness({initial:null,stored,handler:url=>url==='/api/state' ? state : {attachments:[{id:'retry-check',name:'a.txt',size:1},{id:'lost-response',name:'b.txt',size:2}]}});
  await f.ui.refresh(); assert.equal(f.ui.attachments().length,2); assert.ok(f.ui.attachments().every(item=>item.status==='ready')); assert.equal(f.ui.attachments()[1].id,'lost-response');
});

test('renaming and pinning keep the original question and active task intact and sort pinned conversations first', async () => {
  const state=fixture(); state.run.status='running';
  const f=harness({initial:state,handler:(_url,options)=>({run:{...run('a'),...options.body},history:[run('b'),{...run('a'),...options.body}]})});
  await f.ui.updateConversation('a',{title:'置顶的名称',pinned:true});
  assert.equal(f.context.state.run.status,'running'); assert.equal(f.context.state.history[1].task,'问题 a');
  const markup=f.$('workspace-history-content').innerHTML; assert.ok(markup.indexOf('data-run-view="a"') < markup.indexOf('data-run-view="b"')); assert.ok(markup.includes('置顶的名称'));
  assert.equal(f.calls[0].method,'PUT'); assert.equal(f.calls[0].url,'/api/runs/a');
});

test('deleting a different historical conversation preserves the selected running task and unsent draft', async () => {
  const state=fixture(); state.run.status='running';
  const f=harness({initial:state,handler:()=>({ok:true,deletedId:'a',run:state.run,history:[state.run]})});
  f.ui.newConversation(); f.edit('保留下一次草稿'); await f.ui.viewConversation('b');
  await f.ui.deleteConversation('a'); assert.equal(f.calls.at(-1).url,'/api/runs/a'); assert.equal(f.calls.at(-1).method,'DELETE');
  assert.equal(f.ui.selectedRun().id,'b'); assert.equal(f.ui.selectedRun().status,'running');
  f.ui.newConversation(); assert.equal(f.$('task-input').value,'保留下一次草稿');
});

const withPrincipal = (status = 'running') => { const state=fixture(); state.run.status=status; state.agents.push({id:'p',role:'principal',name:'观察校长',hasKey:true}); return state; };
const report = (runId='b',status='pending',answer='') => ({id:'report-'+runId,runId,question:'目前进展如何？',status,answer,principal:{id:'p',name:'观察校长'},createdAt:'2026-10-17T08:00:00Z'});
const settle = () => new Promise(resolve=>setImmediate(resolve));

test('the optional principal never counts as a student or changes main-task readiness', () => {
  const state=withPrincipal('completed'); state.agents=state.agents.filter(agent=>agent.id!=='s2');
  const f=harness({initial:state}); f.ui.newConversation(); assert.equal(f.$('start-button').disabled,true);
  state.agents.push({id:'s2',role:'student'}); f.context.render(); assert.equal(f.$('start-button').disabled,false);
});

test('an unconfigured principal shows a precise message without blocking ordinary task creation', async () => {
  const f=harness({handler:()=>({reports:[]})}); await f.ui.openPrincipalReport();
  assert.equal(f.$('principal-dialog').open,true); assert.match(f.$('principal-error').textContent,/尚未配置校长/); assert.equal(f.context.busy,false); assert.equal(f.calls.length,1); assert.equal(f.calls[0].method,'GET');
  f.ui.newConversation(); assert.equal(f.$('principal-dialog').open,false); assert.equal(f.$('start-button').disabled,false);
});

test('viewing-mode input retains separate per-run side drafts and cannot redispatch an original task', async () => {
  const f=harness(); f.context.render(); f.edit('/btw 问题B'); await f.ui.viewConversation('a'); f.edit('/btw 问题A');
  await f.ui.viewConversation('b'); assert.equal(f.$('task-input').value,'/btw 问题B'); assert.equal(f.$('workspace-task-original').textContent,'问题 b');
  f.edit('这是普通文字'); f.$('task-form').listeners.submit({preventDefault(){}});
  assert.ok(f.calls.every(call=>call.method==='GET')); assert.match(f.notices.at(-1).message,/新建对话/);
  const saved=JSON.parse(f.storage.get('class-workspace-view')); assert.deepEqual(saved.sideDrafts,[['b','这是普通文字'],['a','/btw 问题A']]);
});

test('/btw during a running classroom creates only a principal report and leaves stop and navigation available', async () => {
  const state=withPrincipal(), f=harness({initial:state,handler:(_url,options)=>options.method==='POST' ? {report:report()} : {reports:[]}});
  f.context.render(); f.edit('/btw 目前进展如何？'); f.$('task-form').listeners.submit({preventDefault(){}}); await settle();
  assert.equal(f.context.busy,false); assert.equal(f.context.state.run,state.run); assert.equal(f.context.state.run.task,'问题 b');
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1); assert.equal(f.calls.at(-1).url,'/api/runs/b/principal'); assert.equal(f.calls.at(-1).body.question,'目前进展如何？');
  assert.equal(f.$('start-button').disabled,false); assert.equal(f.$('workspace-new-conversation').disabled,false); assert.equal(f.$('task-input').value,'');
  assert.equal(f.$('principal-cancel').hidden,false); assert.equal(f.$('principal-send').disabled,true);
});

test('Enter in the active composer only sends /btw and never triggers the stop button', async () => {
  const state=withPrincipal(),f=harness({initial:state,handler:(_url,options)=>options.method==='POST'?{report:report()}:{reports:[]}});
  f.context.render();f.edit('正常文字');let prevented=false;
  f.$('task-input').listeners.keydown({key:'Enter',preventDefault(){prevented=true;}});
  assert.equal(prevented,false);assert.equal(f.calls.length,0);
  f.edit('/btw 当前进展');f.$('task-input').listeners.keydown({key:'Enter',isComposing:true,preventDefault(){prevented=true;}});
  assert.equal(f.calls.length,0);
  f.$('task-input').listeners.keydown({key:'Enter',shiftKey:true,preventDefault(){prevented=true;}});assert.equal(f.calls.length,0);
  f.$('task-input').listeners.keydown({key:'Enter',preventDefault(){prevented=true;}});await settle();
  assert.equal(prevented,true);assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
  assert.equal(f.calls.at(-1).url,'/api/runs/b/principal');assert.equal(f.calls.at(-1).body.question,'当前进展');
  assert.equal(f.$('start-button').dataset.action,'stop');assert.equal(f.$('start-button').type,'button');
  assert.equal(state.run.status,'running');assert.equal(f.calls.some(call=>call.url.endsWith('/stop')),false);
});

test('/btw from a new draft uses the current task without consuming draft attachments', async () => {
  const state=withPrincipal('completed'), f=harness({initial:state,handler:(url,options)=>url==='/api/attachments' ? {attachment:{id:'f',name:'context.txt',size:1}} : options.method==='POST' ? {report:report()} : {reports:[]}});
  f.ui.newConversation(); await f.ui.uploadTaskFiles([{name:'context.txt',size:1,content:'x'}]); f.edit('/btw 汇报一下');
  await f.ui.submitBtw('汇报一下'); assert.equal(f.ui.attachments()[0].id,'f');
  const request=f.calls.find(call=>call.url==='/api/runs/b/principal'&&call.method==='POST'); assert.deepEqual(JSON.parse(JSON.stringify(request.body)),{question:'汇报一下'});
  assert.ok(!f.calls.some(call=>call.url==='/api/runs'));
});

test('closing a principal panel ignores a late list response and reopening retrieves saved answers', async () => {
  const pending=defer(); let later=false;
  const f=harness({initial:withPrincipal(),handler:()=>later ? {reports:[report('b','completed','这是已保存的汇报')]} : pending.promise});
  const opening=f.ui.openPrincipalReport(); f.ui.closePrincipalView(); pending.resolve({reports:[report('b','completed','不应显示的迟到内容')]}); await opening;
  assert.equal(f.ui.principalView(),null); assert.ok(!f.$('principal-messages').innerHTML.includes('不应显示'));
  later=true; await f.ui.openPrincipalReport(); assert.ok(f.$('principal-messages').innerHTML.includes('这是已保存的汇报'));
});

test('a late principal poll cannot cross into another selected conversation', async () => {
  const pending=defer(), f=harness({initial:withPrincipal(),handler:url=>url.endsWith('/report-b') ? pending.promise : url==='/api/runs/a' ? {run:run('a')} : {reports:url.includes('/b/')?[report()]:[]}});
  await f.ui.openPrincipalReport(); const oldView=f.ui.principalView(), polling=f.ui.pollPrincipalReport(oldView);
  await f.ui.viewConversation('a'); await f.ui.openPrincipalReport(); pending.resolve({report:report('b','completed','B私有迟到回答')}); await polling;
  assert.equal(f.ui.principalView().runId,'a'); assert.ok(!f.$('principal-messages').innerHTML.includes('B私有迟到回答')); assert.equal(f.context.state.run.status,'running');
});

test('cancelling a principal answer calls only its own endpoint and keeps the main classroom running', async () => {
  const f=harness({initial:withPrincipal(),handler:(_url,options)=>options.method==='POST' ? {report:report('b','cancelled')} : {reports:[report()]}});
  await f.ui.openPrincipalReport(); await f.ui.cancelPrincipalReport();
  assert.equal(f.calls.at(-1).url,'/api/runs/b/principal/report-b/cancel'); assert.equal(f.context.state.run.status,'running'); assert.equal(f.$('start-button').disabled,false);
  assert.equal(f.$('principal-cancel').hidden,true); assert.equal(f.ui.principalView().reports[0].status,'cancelled');
});

test('principal output is rendered literally and never enters task or blackboard state', async () => {
  const state=withPrincipal(), attack='<img src=x onerror="alert(1)">', f=harness({initial:state,handler:()=>({reports:[{...report('b','completed',attack),question:attack}]})});
  await f.ui.openPrincipalReport(); const markup=f.$('principal-messages').innerHTML;
  assert.ok(!markup.includes('<img')); assert.ok(markup.includes('&lt;img')); assert.equal(f.context.state.run,state.run); assert.equal(f.$('blackboard-content').innerHTML,'');
});

test('saved principal reports remain readable after the principal or its credential is removed', async () => {
  for (const initial of [fixture(),withPrincipal()]) {
    const principal=initial.agents.find(agent=>agent.role==='principal'); if(principal)principal.hasKey=false;
    const f=harness({initial,handler:()=>({reports:[report('b','completed','此前保存的课堂汇报')]})});
    await f.ui.openPrincipalReport('新的问题');
    assert.ok(f.$('principal-messages').innerHTML.includes('此前保存的课堂汇报')); assert.equal(f.$('principal-send').disabled,true);
    assert.match(f.$('principal-error').textContent,/尚未配置校长/); assert.ok(f.calls.every(call=>call.method==='GET'));
  }
});

test('transient report polling failures retry GET with bounded backoff and never resubmit a model request', async () => {
  let attempts=0;
  const f=harness({initial:withPrincipal(),handler:url=>{
    if(!url.endsWith('/report-b'))return {reports:[report()]};
    if(++attempts<=5)throw new Error('暂时断线');
    return {report:report('b','completed','恢复后取得的报告')};
  }});
  await f.ui.openPrincipalReport();
  const delays=[];
  while(f.timers.size){const [id,timer]=f.timers.entries().next().value; f.timers.delete(id);delays.push(timer.delay);await timer.callback();}
  assert.deepEqual(delays,[900,1800,3600,7200,10000,10000]); assert.equal(attempts,6);
  assert.ok(f.calls.every(call=>call.method==='GET')); assert.ok(f.$('principal-messages').innerHTML.includes('恢复后取得的报告'));
  assert.equal(f.$('principal-error').hidden,true); assert.equal(f.context.state.run.status,'running');
});

test('closing a report during retry backoff removes the retry timer', async () => {
  const f=harness({initial:withPrincipal(),handler:url=>{if(url.endsWith('/report-b'))throw new Error('断线');return {reports:[report()]};}});
  await f.ui.openPrincipalReport(); await f.ui.pollPrincipalReport(f.ui.principalView()); assert.equal([...f.timers.values()][0].delay,1800);
  f.ui.closePrincipalView(); assert.equal(f.timers.size,0); assert.equal(f.ui.principalView(),null);
});

test('successful shutdown hides the access notice without a replacement success message, while incomplete shutdown retains its warning', async () => {
  const shutdownCode=source.slice(source.indexOf("  $('shutdown-button').addEventListener"),source.indexOf("  $('memory-refresh').addEventListener"));
  for(const readyToExit of [true,false]) {
    const f=harness({handler:()=>({readyToExit})}); f.context.clearInterval=()=>{};f.context.pollTimer=null;
    f.context.showAccess=(title,message)=>{f.$('access-notice').hidden=false;f.$('access-title').textContent=title;f.$('access-message').textContent=message;};
    vm.runInContext(shutdownCode,f.context); f.$('access-notice').hidden=false;f.$('shutdown-button').listeners.click();await settle();
    assert.equal(f.$('access-notice').hidden,readyToExit);assert.equal(f.notices.length,0);
    if(readyToExit){assert.equal(f.$('shutdown-button').disabled,true);assert.equal(f.context.shutdown,true);}
    else assert.match(f.$('access-message').textContent,/尚未确认/);
  }
});

test('closing and reopening the principal panel in the same tick survives a delayed native close event', async () => {
  const f=harness({initial:withPrincipal(),handler:()=>({reports:[report('b','completed','已保存的报告')]})});
  const dialog=f.$('principal-dialog');dialog.id='principal-dialog';const queuedClose=[];
  dialog.close=function(){this.open=false;queuedClose.push(this.listeners.close);};
  await f.ui.openPrincipalReport();const previous=f.ui.principalView();
  let click;
  f.context.document.addEventListener=(type,handler)=>{if(type==='click')click=handler;};
  const clickCode=source.slice(source.indexOf("  document.addEventListener('click',event=>{\n    if (conversationMenuId"),source.indexOf("  $('add-agent-button').addEventListener"));
  vm.runInContext(clickCode,f.context);
  const closeButton={disabled:false,hasAttribute:name=>name==='data-dialog-close',closest:()=>dialog};
  click({preventDefault(){},target:{closest:selector=>selector==='button'?closeButton:null}});
  assert.equal(f.ui.principalView(),null); assert.equal(dialog.open,false);
  const reopening=f.ui.openPrincipalReport();for(const onClose of queuedClose)onClose();await reopening;
  assert.equal(dialog.open,true);assert.notEqual(f.ui.principalView(),previous);assert.ok(f.$('principal-messages').innerHTML.includes('已保存的报告'));
  // A programmatic native close also must not leave a stale view blocking reopen.
  dialog.close();await f.ui.openPrincipalReport();assert.equal(dialog.open,true);assert.ok(f.ui.principalView());
});

test('task mode starts on auto and preserves a draft choice across polling and historical navigation', async () => {
  for (const taskMode of builtinTaskModes.slice(1)) {
    const state=fixture(), f=harness({initial:state,handler:url=>url==='/api/state'?state:{run:run('a')}});
    f.ui.newConversation();assert.equal(f.$('task-mode').value,'auto');assert.equal(f.$('task-mode').disabled,false);
    f.$('task-mode').value=taskMode;f.$('task-mode').listeners.change();f.edit('按所选模式运行');
    await f.ui.refresh();assert.equal(f.$('task-mode').value,taskMode);
    await f.ui.viewConversation('a');assert.equal(f.$('task-mode').value,'auto');assert.equal(f.$('task-mode').disabled,true);
    f.ui.newConversation();assert.equal(f.$('task-mode').value,taskMode);assert.equal(f.$('task-input').value,'按所选模式运行');
    assert.equal(state.run.taskMode,undefined);assert.ok(f.calls.every(call=>call.method==='GET'));
  }
});

test('all builtin task modes are submitted once and become immutable on the created run', async () => {
  for(const taskMode of builtinTaskModes) {
    const pending=defer(),f=harness({handler:()=>pending.promise});f.ui.newConversation();f.edit('新的任务');
    f.$('task-mode').value=taskMode;f.$('task-mode').listeners.change();f.$('task-form').listeners.submit({preventDefault(){}});
    assert.equal(f.calls[0].body.taskMode,taskMode);assert.equal(f.calls[0].url,'/api/runs');
    f.$('task-form').listeners.submit({preventDefault(){}});assert.equal(f.calls.length,1);
    pending.resolve({run:{...run('new','running','新的任务'),taskMode}});await settle();f.context.render();
    assert.equal(f.$('task-mode').value,taskMode);assert.equal(f.$('task-mode').disabled,true);
    f.$('task-mode').value=taskMode==='auto'?'web_pentest':'auto';f.$('task-mode').listeners.change();assert.equal(f.$('task-mode').value,taskMode);
    f.ui.newConversation();assert.equal(f.$('task-mode').value,'auto');assert.equal(f.$('task-mode').disabled,false);
  }
});

test('historical task modes are displayed without changing the next draft and older runs default to auto', async () => {
  for (const taskMode of builtinTaskModes.slice(1)) {
    const state=fixture();state.run.taskMode=taskMode;
    const f=harness({initial:state,handler:()=>({run:run('a')})});f.context.render();assert.equal(f.$('task-mode').value,taskMode);assert.equal(f.$('task-mode').disabled,true);
    await f.ui.viewConversation('a');assert.equal(f.$('task-mode').value,'auto');
    f.ui.newConversation();assert.equal(f.$('task-mode').value,'auto');assert.equal(state.run.taskMode,taskMode);
  }
});

test('/btw keeps the existing task mode and does not submit or consume a draft task mode', async () => {
  for (const taskMode of builtinTaskModes.slice(1)) {
    const state=withPrincipal();state.run.taskMode=taskMode;
    const f=harness({initial:state,handler:(_url,options)=>options.method==='POST'?{report:report()}:{reports:[]}});
    f.context.render();f.edit('/btw 任务进展');await f.ui.submitBtw('任务进展');
    assert.equal(f.$('task-mode').value,taskMode);assert.equal(f.$('task-mode').disabled,true);assert.equal(state.run.taskMode,taskMode);
    assert.ok(f.calls.every(call=>call.url!=='/api/runs'));assert.ok(f.calls.filter(call=>call.method==='POST').every(call=>!Object.hasOwn(call.body,'taskMode')));
    f.ui.newConversation();f.$('task-mode').value=taskMode;f.$('task-mode').listeners.change();f.edit('/btw 旁路提问');await f.ui.submitBtw('旁路提问');
    assert.equal(f.$('task-mode').value,taskMode);assert.equal(f.$('task-mode').disabled,false);
  }
});

test('a reloaded or relocated draft begins with auto without importing a mode from stored text', async () => {
  const state=fixture(),stored={'class-workspace-view':JSON.stringify({dataDir:state.dataDir,draftMode:true,draftTask:'原草稿',draftTaskMode:'web_pentest'})};
  const f=harness({initial:null,stored,handler:url=>url==='/api/state'?state:{attachments:[]}});
  await f.ui.refresh();assert.equal(f.$('task-mode').value,'auto');assert.equal(f.$('task-input').value,'原草稿');
  f.$('task-mode').value='web_pentest';f.$('task-mode').listeners.change();
  f.context.state={...state,dataDir:'old-isolated-dir'};state.dataDir='new-isolated-dir';state.run=null;state.history=[];
  await f.ui.refresh();assert.equal(f.$('task-mode').value,'auto');assert.equal(f.$('task-mode').disabled,false);
});

test('composer width changes remeasure wrapping after layout without looping on height or resetting scroll', () => {
  const f=harness(),input=f.$('task-input');input.getClientRects=()=>[{}];input.scrollHeight=40;f.ui.resizeTaskInput();
  assert.equal(input.style.height,'42px');
  const observer=f.observers.find(item=>item.target===input);
  const finishFrame=()=>{const [id,callback]=f.frames.entries().next().value;f.frames.delete(id);callback();};
  observer.callback([{contentRect:{width:180,height:40}}]);
  // The sidebar's final layout arrives before the queued measurement.
  input.scrollHeight=62;observer.callback([{contentRect:{width:170,height:40}}]);assert.equal(f.frames.size,1);
  finishFrame();assert.equal(input.style.height,'64px');assert.equal(input.style.overflowY,'hidden');
  observer.callback([{contentRect:{width:170,height:62}}]);assert.equal(f.frames.size,0);
  input.scrollHeight=150;input.scrollTop=44;observer.callback([{contentRect:{width:110,height:62}}]);finishFrame();
  assert.equal(input.style.height,'86px');assert.equal(input.style.overflowY,'auto');assert.equal(input.scrollTop,44);
  input.scrollHeight=40;observer.callback([{contentRect:{width:500,height:84}}]);finishFrame();assert.equal(input.style.height,'42px');
});
