import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const updates = source.slice(source.indexOf('  // Application updates'), source.indexOf('  // End application updates.'));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const status = (state, extra = {}) => ({ state, version:'1.2.0', supported:true, ...extra });

function harness(handler = async () => status('checking')) {
  const elements = new Map(), calls = [], notices = [], timers = new Map(), clearedIntervals = [];
  let timerId = 0, closedPrincipal = 0, controls = 0;
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { textContent:'', hidden:false, disabled:false, title:'', attributes:{},
      setAttribute(name, value) { this.attributes[name] = value; } });
    return elements.get(id);
  };
  const context = vm.createContext({ $, state:{version:'1.2.0',run:{id:'active',status:'running'}}, busy:false,
    token:'fixture-token', lastConnection:true, shutdown:false, shuttingDown:false, pollTimer:42,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id,{callback,delay}); return id; },
    clearTimeout(id) { timers.delete(id); }, clearInterval(id) { clearedIntervals.push(id); },
    closePrincipalView() { closedPrincipal++; }, setConnection(value) { context.lastConnection = value; },
    updateControls() { controls++; }, toast(message, error = false) { notices.push({message,error}); },
    api:async (url, options = {}) => { calls.push({url,...options}); return handler(url,options); } });
  vm.runInContext(updates + '\nglobalThis.ui = { acceptUpdate, acceptUpdateSnapshot, renderUpdateControls, requestUpdate, pollUpdate, updateRestarting, busy:()=>updateBusy };', context);
  const tick = async () => { const [id,timer] = timers.entries().next().value || []; assert.ok(timer,'update poll is scheduled'); timers.delete(id); timer.callback(); await new Promise(resolve=>setImmediate(resolve)); };
  return { $,context,ui:context.ui,calls,notices,timers,clearedIntervals,tick,closedPrincipal:()=>closedPrincipal,controls:()=>controls };
}

test('version and update controls follow the sidebar toggle and use the server version', () => {
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.ok(header.indexOf('id="sidebar-toggle"') < header.indexOf('id="app-version"'));
  assert.ok(header.indexOf('id="app-version"') < header.indexOf('id="update-button"'));
  assert.ok(header.indexOf('id="update-button"') < header.indexOf('id="connection-status"'));
  const f = harness(); f.ui.acceptUpdateSnapshot(status('idle'));
  assert.equal(f.$('app-version').textContent,'v1.2.0'); assert.equal(f.$('update-button').disabled,false);
  f.context.state.version = '1.4.7'; f.ui.renderUpdateControls();
  assert.equal(f.$('app-version').textContent,'v1.4.7');
  f.ui.acceptUpdateSnapshot(status('idle',{supported:false}));
  assert.equal(f.$('update-button').disabled,true);
});

test('one update request polls checking and downloading without blocking an active classroom task', async () => {
  const post = defer(), queue = [status('downloading',{targetVersion:'1.3.0'}),status('current')];
  const f = harness((_url, options) => options.method === 'POST' ? post.promise : queue.shift());
  f.ui.acceptUpdateSnapshot(status('idle')); const originalRun = f.context.state.run;
  const request = f.ui.requestUpdate(); await f.ui.requestUpdate();
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].method,'POST'); assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].body)),{});
  assert.equal(f.ui.busy(),true); assert.equal(f.context.busy,false); assert.equal(f.context.shuttingDown,false);
  assert.equal(f.context.state.run,originalRun); assert.equal(f.$('update-label').textContent,'检查中…');
  f.ui.acceptUpdateSnapshot(status('idle')); assert.equal(f.$('update-label').textContent,'检查中…');
  post.resolve(status('checking')); await request;
  await f.tick(); assert.equal(f.$('update-label').textContent,'下载中…'); assert.equal(f.$('update-button').disabled,true);
  await f.tick(); assert.equal(f.$('update-button').disabled,false); assert.equal(f.timers.size,0);
  assert.deepEqual(f.notices,[{message:'当前已是最新版',error:false}]);
  f.ui.acceptUpdateSnapshot(status('current')); await f.ui.pollUpdate();
  assert.equal(f.notices.length,1); assert.equal(f.calls.length,3); assert.equal(f.context.state.run,originalRun);
});

test('failed checks or downloads notify once and allow an independent retry', async () => {
  let attempt = 0;
  const f = harness((_url, options) => {
    if (options.method === 'POST') { if (++attempt === 1) throw Error('network failed'); return status('downloading'); }
    return status('failed',{message:'download failed'});
  });
  f.ui.acceptUpdateSnapshot(status('idle')); await f.ui.requestUpdate();
  assert.deepEqual(f.notices,[{message:'更新失败',error:true}]); assert.equal(f.$('update-button').disabled,false);
  f.ui.acceptUpdateSnapshot(status('failed')); assert.equal(f.notices.length,1);
  await f.ui.requestUpdate(); await f.tick();
  assert.deepEqual(f.notices,[{message:'更新失败',error:true},{message:'更新失败',error:true}]);
  assert.equal(f.context.busy,false); assert.equal(f.context.shuttingDown,false);
});

test('an in-progress snapshot resumes polling but a past completed snapshot does not repeat its toast', async () => {
  const f = harness(() => status('current'));
  f.ui.acceptUpdateSnapshot(status('current')); assert.equal(f.notices.length,0); assert.equal(f.timers.size,0);
  f.ui.acceptUpdateSnapshot(status('checking')); assert.equal(f.timers.size,1);
  await f.tick(); assert.equal(f.notices.length,1);
  f.ui.acceptUpdateSnapshot(status('current')); assert.equal(f.notices.length,1);
});

test('a failed previous installation notifies once after rollback without repeating on state polling', async () => {
  const f = harness(() => status('failed'));
  const failure = status('failed',{previousAttempt:true,targetVersion:'1.3.0'});
  f.ui.acceptUpdateSnapshot(failure); f.ui.acceptUpdateSnapshot(failure);
  assert.deepEqual(f.notices,[{message:'更新失败',error:true}]);
  assert.equal(f.$('update-button').disabled,false);
  await f.ui.requestUpdate(); assert.equal(f.notices.length,2,'an explicit retry may report its own failure');
  f.ui.acceptUpdateSnapshot(failure); assert.equal(f.notices.length,2);
});

test('restarting freezes the old page and suppresses late connection errors instead of reconnecting', async () => {
  const pending = defer(), f = harness(() => pending.promise);
  f.ui.acceptUpdateSnapshot(status('downloading'));
  const poll = f.ui.pollUpdate();
  f.ui.acceptUpdate(status('restarting'),true);
  assert.equal(f.$('update-label').textContent,'重启中…'); assert.equal(f.$('update-button').disabled,true);
  assert.equal(f.context.shuttingDown,true); assert.deepEqual(f.clearedIntervals,[42]); assert.equal(f.timers.size,0);
  assert.equal(f.$('access-notice').hidden,true); assert.equal(f.$('reconnect-button').hidden,true); assert.equal(f.closedPrincipal(),1);
  pending.reject(Error('old process exited')); await poll; assert.equal(f.notices.length,0);
  const realToast = source.slice(source.indexOf('  function toast('), source.indexOf('  async function api('));
  vm.runInContext(realToast + '\ntoast("old request failed",true);', f.context);
  assert.equal(f.notices.length,0);
  const realApi = source.slice(source.indexOf('  async function api('), source.indexOf('  function storageDescription('));
  f.context.fetch = async () => ({ok:false,status:401,json:async()=>({error:'old token'})});
  f.context.storageDescription = (_detail,fallback) => fallback;
  f.context.showAccess = () => assert.fail('old page must not display a new access error while restarting');
  vm.runInContext(realApi, f.context);
  await assert.rejects(vm.runInContext('api("/api/state")', f.context),/old token/);
});

test('unsupported or disconnected instances do not submit an update request', async () => {
  const f = harness();
  f.ui.acceptUpdateSnapshot(status('idle',{supported:false})); await f.ui.requestUpdate();
  f.ui.acceptUpdateSnapshot(status('idle')); f.context.lastConnection=false; await f.ui.requestUpdate();
  assert.equal(f.calls.length,0);
});
