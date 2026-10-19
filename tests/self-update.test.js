import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSelfUpdater } from '../src/self-update.js';

const defer = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve = yes; reject = no; }); return {promise,resolve,reject}; };
const release = (version = '1.3.0') => ({available:true,version,asset:{name:'Class.exe',url:'https://example.invalid/Class.exe'}});
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline,'updater did not reach its expected state'); await delay(5); }
}
function fixture(t, overrides = {}) {
  const events = [], calls = {check:[],launch:[],install:[],abort:[]};
  const helper = { async abort(restart) { calls.abort.push(restart); events.push('abort'); }, async commit() {} };
  const options = { version:'1.2.0',compiled:true,platform:'win32',arch:'x64',executable:'C:\\isolated\\Class.exe',restartNoticeMs:0,
    getLaunch: async () => ({requestedPath:'C:\\isolated\\data',dataDir:'C:\\isolated\\data',cwd:'C:\\isolated'}),
    check:async args => { calls.check.push(args); events.push('check'); return release(); },
    download:async () => { throw Error('the injected launcher must not download real files'); },
    launchHelper:async args => { calls.launch.push(args); events.push('helper-ready'); return helper; },
    onInstall:async value => { calls.install.push(value); events.push('install'); }, ...overrides };
  const updater = createSelfUpdater(options); t.after(() => updater.close());
  return {updater,events,calls,helper,options};
}

test('no release update reports current without preparing a helper or restarting', async t => {
  const f = fixture(t,{check:async () => ({available:false})});
  assert.equal(f.updater.start().state,'checking');
  await until(() => f.updater.status().state === 'current');
  assert.equal(f.updater.status().message,'当前已是最新版');
  assert.equal(f.calls.launch.length,0); assert.equal(f.calls.install.length,0);
});

test('restart restores a failed future update but a successfully installed version ignores that old failure', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'class-update-status-'));
  const filename = path.join(directory, '.class-update-status.json');
  t.after(async () => { await fs.unlink(filename); await fs.rmdir(directory); });
  await fs.writeFile(filename, JSON.stringify({state:'failed',targetVersion:'1.3.0'}));
  const previous = fixture(t);
  await previous.updater.restoreStatus(directory);
  assert.equal(previous.updater.status().state, 'failed');
  assert.equal(previous.updater.status().previousAttempt, true);
  for (const version of ['1.3.0', '1.4.0']) {
    const updated = fixture(t, {version});
    await updated.updater.restoreStatus(directory);
    assert.equal(updated.updater.status().state, 'idle', 'a healthy new version must not display the old failure');
  }
});

test('equal, older and prerelease versions can never reach replacement', async t => {
  for (const version of ['1.2.0','1.1.99','0.99.99','1.3.0-rc.1','garbage']) {
    const f = fixture(t,{check:async () => release(version)});
    f.updater.start(); await until(() => f.updater.status().state === 'failed');
    assert.equal(f.calls.launch.length,0,version); assert.equal(f.calls.install.length,0,version);
  }
});

test('a newer release without a matching executable reports failure instead of current', async t => {
  const f = fixture(t,{check:async()=>({available:false,version:'1.3.0',reason:'asset_unavailable'})});
  f.updater.start(); await until(()=>f.updater.status().state==='failed');
  assert.equal(f.updater.status().message,'更新失败');
  assert.equal(f.calls.launch.length,0); assert.equal(f.calls.install.length,0);
});

test('source execution and unsupported native platforms never replace the host executable', async t => {
  for (const config of [{compiled:false,executable:process.execPath},{platform:'darwin'},{arch:'arm64'}]) {
    const f = fixture(t,config); assert.equal(f.updater.status().supported,false);
    f.updater.start(); await until(() => f.updater.status().state === 'failed');
    assert.equal(f.calls.launch.length,0); assert.equal(f.calls.install.length,0); assert.equal(f.calls.abort.length,0);
  }
});

test('repeated clicks share one check and one helper while the update is active', async t => {
  const checked = defer(), launched = defer(); let checks = 0, launches = 0;
  const f = fixture(t,{check:async () => {checks++;return checked.promise;},launchHelper:async()=>{launches++;return launched.promise;}});
  f.updater.start(); f.updater.start(); assert.equal(checks,1);
  checked.resolve(release()); await until(()=>f.updater.status().state==='downloading');
  f.updater.start(); assert.equal(launches,1);
  launched.resolve(f.helper); await until(()=>f.updater.status().state==='restarting');
  f.updater.start(); assert.equal(checks,1); assert.equal(launches,1);
  await until(()=>f.calls.install.length===1);
});

test('closing during a cancellable download aborts it without preparing or installing', async t => {
  const downloadStarted = defer(); let downloadSignal, prepared = false;
  const f = fixture(t,{
    download:async (_asset,_file,{signal}) => { downloadSignal=signal;downloadStarted.resolve();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})); },
    launchHelper:async args => { await args.download(args.asset,'unused-fixture-payload',{signal:args.signal}); assert.fail('cancelled download must not create a helper'); },
  });
  f.updater.start({prepareRestart:async()=>{prepared=true;}}); await downloadStarted.promise;
  await f.updater.close(); assert.equal(downloadSignal.aborted,true); assert.equal(prepared,false);
  assert.equal(f.calls.install.length,0); assert.equal(f.calls.abort.length,0);
  const before=f.updater.status();f.updater.start();assert.deepEqual(f.updater.status(),before,'a closed updater cannot restart work');
});

test('failed state preservation aborts the ready helper and keeps the application running', async t => {
  const f = fixture(t);
  f.updater.start({prepareRestart:async()=>{f.events.push('prepare');throw Error('could not save current tasks');}});
  await until(()=>f.updater.status().state==='failed');
  assert.deepEqual(f.events,['check','helper-ready','prepare','abort']);
  assert.deepEqual(f.calls.abort,[false]); assert.equal(f.calls.install.length,0);
});

test('install waits for helper readiness and saved state before handing off the current executable', async t => {
  const ready = defer(), preparation = defer(); let captured;
  const f = fixture(t,{launchHelper:async args=>{captured=args;await ready.promise;f.events.push('helper-ready');return f.helper;}});
  f.updater.start({prepareRestart:async()=>{f.events.push('prepare');await preparation.promise;return async()=>f.events.push('rollback');}});
  await until(()=>f.updater.status().state==='downloading');
  assert.deepEqual(f.events,['check']); assert.equal(f.calls.install.length,0);
  ready.resolve(); await until(()=>f.events.includes('prepare')); assert.equal(f.calls.install.length,0);
  preparation.resolve(); await until(()=>f.updater.status().state==='restarting');
  await f.updater.close(); // The application's own graceful shutdown must not cancel its accepted handoff.
  await until(()=>f.calls.install.length===1);
  assert.deepEqual(f.events,['check','helper-ready','prepare','install']);
  assert.equal(f.calls.install[0],f.helper); assert.equal(f.calls.abort.length,0);
  assert.equal(captured.executable,f.options.executable); assert.equal(captured.getLaunch,f.options.getLaunch);
  assert.equal(captured.download,f.options.download); assert.equal(captured.targetVersion,'1.3.0');
});

test('handoff failure aborts the helper and releases the application preparation lock', async t => {
  const f = fixture(t,{onInstall:async()=>{f.events.push('install-failed');throw Error('handoff unavailable');}});
  f.updater.start({prepareRestart:async()=>{f.events.push('prepare');return async()=>f.events.push('rollback');}});
  await until(()=>f.updater.status().state==='failed');
  assert.deepEqual(f.events,['check','helper-ready','prepare','install-failed','abort','rollback']);
  assert.deepEqual(f.calls.abort,[false]); assert.equal(f.updater.status().message,'更新失败');
});

test('acknowledging the restart notice releases its long wait but preserves the final visible grace period', async t => {
  let installedAt;
  const f = fixture(t,{restartNoticeMs:60000,onInstall:async helper=>{installedAt=performance.now();f.calls.install.push(helper);}});
  f.updater.acknowledgeRestart(); // An unrelated earlier status response is not a restart acknowledgement.
  f.updater.start(); await until(()=>f.updater.status().state==='restarting');
  await delay(40); assert.equal(f.calls.install.length,0);
  const acknowledgedAt=performance.now(); f.updater.acknowledgeRestart();
  assert.equal(f.updater.status().state,'restarting'); assert.equal(f.calls.install.length,0);
  await delay(100); assert.equal(f.calls.install.length,0,'the restart state stays visible after the response finishes');
  await until(()=>f.calls.install.length===1);
  assert.ok(installedAt-acknowledgedAt>=280,'the final 300 ms grace period must not be skipped');
  assert.equal(f.calls.install[0],f.helper); assert.equal(f.calls.abort.length,0);
});
