import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClassServer } from './web-server.js';
import { ASSETS } from '../build/generated/ui-assets.generated.js';
import { canonicalDataPath, resolveDataLocation, sameDirectory, prepareLinuxMigrationTarget, DATA_POINTER, MIGRATION_LOCK, committedMigration } from './data-location.js';
import { createProfileStore } from './profile-store.js';
import { createDataRecoveryServer } from './data-recovery-server.js';
import { recoveryAnchorFor, readRecoverySelection, publishRecoverySelection, validateRecoveryDirectory, initializeEmptyRecoveryDirectory } from './startup-data-recovery.js';
import { desktopLaunchSpec } from './recovery-launcher.js';
import { defaultDataDirectory } from './platform-paths.js';
import { configureStartupLog, redactStartupSecret, startupLog, startupFailureMessage, launchBrowser, writeBrowserEntry, showStartupError } from './startup-support.js';

const args = process.argv.slice(2);
const instanceId = crypto.randomBytes(16).toString('hex');
let app, recoveryApp, requestedPath, unavailablePath, recoveryOrigin;
const retiringApps = new Set();
const ownedDirectories = new Set();
let stopping = false;

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

// Preserve the original data location so existing Agent configuration and keys remain usable.
let dataDir, anchorDir, lockFile, recoveryFile, instanceFile, currentInstance;
function setDataDirectory(directory) {
  dataDir = directory;
  lockFile = path.join(dataDir, 'instance.lock');
  recoveryFile = path.join(dataDir, 'instance.recovery.lock');
  instanceFile = path.join(dataDir, 'instance.json');
}
function writeInstance(directory, instance, exclusive = false) {
  const filename = path.join(directory, 'instance.json'), temporary = `${filename}.${instanceId}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(instance, null, 2) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); descriptor = undefined; }
    if (exclusive) { fs.linkSync(temporary, filename); fs.unlinkSync(temporary); } else fs.renameSync(temporary, filename);
  } catch (error) { try { if (descriptor !== undefined) fs.closeSync(descriptor); fs.unlinkSync(temporary); } catch {} throw error; }
}
function exclusiveBrowserEntry(directory, url) {
  const staging = fs.mkdtempSync(path.join(directory, '.class-entry-'));
  let staged;
  try {
    staged = writeBrowserEntry(staging, url);
    const destination = path.join(directory, path.basename(staged));
    fs.linkSync(staged, destination);
    return destination;
  } finally {
    if (staged) try { fs.unlinkSync(staged); } catch {}
    // A failed write may leave only our known temporary file.
    for (const name of fs.readdirSync(staging)) if (name.endsWith(`.${process.pid}.tmp`)) try { fs.unlinkSync(path.join(staging, name)); } catch {}
    try { fs.rmdirSync(staging); } catch {}
  }
}
function releaseDirectory(directory) {
  if (!ownedDirectories.has(directory)) return;
  for (const name of ['instance.json', 'instance.lock']) {
    const file = path.join(directory, name);
    if (readJson(file)?.instanceId !== instanceId) continue;
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') console.error(`Could not remove ${name}: ${error.message}`); }
  }
  ownedDirectories.delete(directory);
}
async function prepareDataDirectory({ from, to }) {
  // The anchor and all previously selected paths remain live aliases until exit,
  // so a launcher that observed the old pointer can never create a second writer.
  const targetLock = path.join(to, 'instance.lock');
  const descriptor = fs.openSync(targetLock, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, instanceId, createdAt: new Date().toISOString() })); }
  catch (error) { try { fs.unlinkSync(targetLock); } catch {} throw error; }
  finally { fs.closeSync(descriptor); }
  ownedDirectories.add(to);
  let committed = false, browserEntry;
  return {
    launchSpec: desktopLaunchSpec({ noBrowser: args.includes('--no-browser') }),
    async commit() {
      writeInstance(to, currentInstance, true);
      browserEntry = exclusiveBrowserEntry(to, browserUrl(currentInstance));
      setDataDirectory(to); configureStartupLog(to); committed = true;
    },
    async rollback() {
      if (committed) { setDataDirectory(from); configureStartupLog(from); }
      releaseDirectory(to);
      if (browserEntry) fs.unlinkSync(browserEntry);
    }
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function validInstance(value) {
  if (!value || !Number.isSafeInteger(value.pid) || !/^[a-f0-9]{64}$/.test(value.token || '')) return false;
  try {
    const url = new URL(value.url);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

async function responsiveInstance(value) {
  if (!validInstance(value) || !processExists(value.pid)) return false;
  try {
    const healthResponse = await fetch(`${value.url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(1200) });
    if (!healthResponse.ok || !['class', 'discussion'].includes((await healthResponse.json())?.app)) return false;
    const response = await fetch(`${value.url.replace(/\/$/, '')}/api/state`, {
      headers: { Authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return false;
    const state = await response.json();
    return !!state && typeof state === 'object' && !state.error;
  } catch { return false; }
}

function browserUrl(instance) { return `${instance.url}#token=${instance.token}`; }

async function openBrowser(instance) {
  const noBrowser = args.includes('--no-browser');
  if (noBrowser && process.platform !== 'linux') return;
  const url = browserUrl(instance);
  redactStartupSecret(instance.token);
  let entry;
  try { entry = writeBrowserEntry(dataDir, url); }
  catch (error) { startupLog('browser-entry-write-failed', error.message); }
  if (noBrowser) {
    console.log(entry ? `Browser entry: ${entry}` : `Browser address: ${url}`);
    return;
  }
  try {
    startupLog('browser-launch-requested', instance.url);
    await launchBrowser(url);
    startupLog('browser-launch-confirmed', instance.url);
  } catch (error) {
    const log = startupLog('browser-launch-failed', error.message);
    await showStartupError(`Class 服务已启动，但自动打开浏览器失败。\n\n${entry ? `请在浏览器中打开此文件：\n${entry}` : `请在浏览器地址栏输入：\n${url}`}\n\n启动日志：${log}`);
  }
}

function releaseInstance() {
  for (const directory of [...ownedDirectories]) releaseDirectory(directory);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { await recoveryApp?.close(); await app?.close(); await Promise.all([...retiringApps].map(value => value.close())); }
  finally { releaseInstance(); startupLog('service-stopped'); }
}

function requestShutdown() {
  setTimeout(() => { shutdown().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); }); }, 100);
}

async function claimDirectory(directory) {
  setDataDirectory(directory);
  return ownedDirectories.has(directory) ? null : acquireInstance();
}

function newInstance(server, token) {
  const instance = { pid: process.pid, instanceId, url: `${server.url.replace(/\/$/, '')}/`, token };
  if (!validInstance(instance)) throw new Error('The server returned an invalid local URL');
  return instance;
}

async function createApplication(directory, anchor, workspaceOverride, requireMemoryReady = false) {
  const token = crypto.randomBytes(32).toString('hex'); redactStartupSecret(token);
  const server = await createClassServer({
    dataDir: directory, dataAnchor: anchor, workspaceOverride, requireMemoryReady,
    dataDirectoryLifecycle: prepareDataDirectory,
    dataDirectoryLoader: ({ path: target }) => selectDataDirectory({ mode: 'existing', path: target }),
    token, assets: ASSETS, port: 0, onShutdown: requestShutdown,
  });
  return { server, instance: newInstance(server, token) };
}

async function ensureRecoveryAnchor() {
  const directory = canonicalDataPath(recoveryAnchorFor(requestedPath), { allowMissing: true });
  const previous = await claimDirectory(directory);
  if (previous) throw Object.assign(new Error('另一个 Class 正在处理此启动入口，请使用已打开的窗口。'), { status: 409 });
  return directory;
}

function retire(server) {
  if (!server) return;
  retiringApps.add(server);
  // close() marks the old host as closing immediately, then waits for the
  // current mutation/HTTP response. Awaiting it inside that mutation deadlocks.
  server.close().then(() => retiringApps.delete(server), error => startupLog('previous-host-close-failed', startupFailureMessage(error)));
}

async function selectDataDirectory({ mode, path: selected, allowEmpty = false }) {
  // A previous switch can still be flushing its memory store. Do not reopen
  // one of our retained alias directories until those hosts have fully closed.
  await Promise.all([...retiringApps].map(server => server.close()));
  const oldDirectory = dataDir, oldAnchor = anchorDir, oldInstance = currentInstance, oldApp = app;
  const previousDataDir = recoveryOrigin || unavailablePath || oldDirectory;
  const inspected = await validateRecoveryDirectory(mode === 'default' ? defaultDataDirectory() : selected, { allowCreate: mode === 'default', allowEmpty: allowEmpty && mode === 'existing', previousDataDir });
  const target = inspected.dataDir;
  const emptyLease = inspected.identity ? { ...inspected.identity, pid: process.pid, instanceId } : undefined;
  if (oldApp && sameDirectory(target, oldDirectory)) throw Object.assign(new Error('当前已在使用所选数据目录。'), { status: 400 });
  const alreadyOwned = ownedDirectories.has(target);
  let candidate, control;
  try {
    control = await ensureRecoveryAnchor();
    const relative = path.relative(control, target), inverse = path.relative(target, control);
    const inside = value => !value || (value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value));
    if (inside(relative) || inside(inverse)) throw new Error('请选择与 Class 启动状态目录分开的数据目录。');
    if (inspected.missing) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    if (process.platform === 'linux' && (inspected.missing || inspected.empty) && !alreadyOwned) {
      const entries = fs.readdirSync(target);
      if (entries.length === 0) { const handle = await prepareLinuxMigrationTarget(target); await handle.close(); }
    }
    if (await claimDirectory(target)) throw Object.assign(new Error('所选数据目录正在由另一个 Class 使用，请先退出该实例。'), { status: 409 });
    // Recheck after obtaining the lease. Never initialize an unrecognized or
    // damaged existing profile, including one changed during directory choice.
    const confirmed = await validateRecoveryDirectory(target, { allowCreate: mode === 'default', emptyLease, previousDataDir });
    if (confirmed.empty) {
      if (emptyLease) await initializeEmptyRecoveryDirectory(target, emptyLease);
      else {
        const store = await createProfileStore(target);
        await store.save(store.config);
      }
    }
    candidate = await createApplication(target, control, confirmed.workspaceOverride, true);
    for (const directory of ownedDirectories) writeInstance(directory, candidate.instance);
    // The only remembered-path mutation occurs after successful profile/server
    // startup. A selected directory's own legacy pointer is intentionally ignored.
    await publishRecoverySelection(control, target, previousDataDir);
    app = candidate.server; currentInstance = candidate.instance; anchorDir = control;
    setDataDirectory(target); configureStartupLog(target); unavailablePath = undefined;
    retire(oldApp);
    const portal = recoveryApp; recoveryApp = undefined;
    // Let the recovery HTTP response finish before closing its server.
    if (portal) { retiringApps.add(portal); setTimeout(() => { retire(portal); }, 250); }
    startupLog('data-directory-loaded', target);
    try { writeBrowserEntry(target, browserUrl(currentInstance)); } catch (error) { startupLog('browser-entry-write-failed', error.message); }
    return { url: browserUrl(currentInstance) };
  } catch (error) {
    await candidate?.server.close();
    if (!alreadyOwned) releaseDirectory(target);
    currentInstance = oldInstance; anchorDir = oldAnchor; setDataDirectory(oldDirectory);
    if (oldInstance) for (const directory of ownedDirectories) writeInstance(directory, oldInstance);
    throw error;
  }
}

async function startRecovery(error) {
  // Logging must not recreate a missing profile. Use the independent state
  // directory for recovery metadata, browser entry, and diagnostic output.
  const control = canonicalDataPath(recoveryAnchorFor(requestedPath), { allowMissing: true });
  recoveryOrigin ||= unavailablePath;
  const previous = await claimDirectory(control);
  configureStartupLog(control);
  if (previous) { releaseInstance(); await openBrowser(previous); return; }
  const token = crypto.randomBytes(32).toString('hex'); redactStartupSecret(token);
  recoveryApp = await createDataRecoveryServer({ token, requestedPath: unavailablePath || requestedPath,
    defaultPath: defaultDataDirectory(), reason: startupFailureMessage(error), assets: ASSETS,
    onSelect: selection => selectDataDirectory({ ...selection, allowEmpty: true }), onShutdown: requestShutdown });
  currentInstance = newInstance(recoveryApp, token);
  for (const directory of ownedDirectories) writeInstance(directory, currentInstance);
  startupLog('data-recovery-ready', unavailablePath || requestedPath);
  console.log(`Class data directory recovery is ready.\n${currentInstance.url}\nStartup state: ${control}`);
  await openBrowser(currentInstance);
}

async function acquireInstance() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // A second double-click waits for the first instance to finish binding its port.
  for (let attempt = 0; attempt < 35; attempt++) {
    const migrationFile = path.join(dataDir, MIGRATION_LOCK), migration = readJson(migrationFile);
    if (fs.existsSync(migrationFile)) {
      if (!migration || !Number.isSafeInteger(migration.pid) || typeof migration.anchorDir !== 'string') throw new Error('The destination migration marker is unreadable; its data was preserved');
      const complete = committedMigration(dataDir, migration);
      if (!complete && processExists(migration.pid)) { await new Promise(resolve => setTimeout(resolve, 200)); continue; }
      let published = complete;
      if (!published) try { published = sameDirectory(resolveDataLocation(migration.anchorDir).dataDir, dataDir); } catch {}
      if (!published) throw new Error('An interrupted migration left this destination incomplete. Start Class from its original data directory; this copy was preserved');
      if (!processExists(migration.pid) && readJson(migrationFile)?.migrationId === migration.migrationId) try { fs.unlinkSync(migrationFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const previous = readJson(instanceFile);
    if (await responsiveInstance(previous)) return previous;
    if (validInstance(previous) && processExists(previous.pid)) {
      // A live owner that is starting or stalled must never get a second writer.
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }
    if (fs.existsSync(recoveryFile)) {
      const recovery = readJson(recoveryFile);
      if (recovery && Number.isSafeInteger(recovery.pid) && recovery.pid > 0 && !processExists(recovery.pid)) {
        try { fs.unlinkSync(recoveryFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }
    try {
      const descriptor = fs.openSync(lockFile, 'wx', 0o600);
      ownedDirectories.add(dataDir);
      try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, instanceId, createdAt: new Date().toISOString() })); }
      finally { fs.closeSync(descriptor); }
      return null;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const locked = readJson(lockFile);
      // Never remove a lock owned by a live PID. This also avoids PID reuse mistakes.
      if (locked && Number.isSafeInteger(locked.pid) && locked.pid > 0 && !processExists(locked.pid)) {
        let recovery;
        try { recovery = fs.openSync(recoveryFile, 'wx', 0o600); }
        catch (recoveryError) { if (recoveryError.code !== 'EEXIST') throw recoveryError; }
        if (recovery !== undefined) {
          try {
            fs.writeFileSync(recovery, JSON.stringify({ pid: process.pid, instanceId }));
            const current = readJson(lockFile);
            if (current?.instanceId === locked.instanceId && current?.pid === locked.pid && !processExists(current.pid)) {
              try { fs.unlinkSync(lockFile); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
              startupLog('stale-lock-recovered', `previousPid=${current.pid}`);
            }
          } finally {
            fs.closeSync(recovery);
            if (readJson(recoveryFile)?.instanceId === instanceId) fs.unlinkSync(recoveryFile);
          }
        }
      } else if (!locked) {
        // A partially written lock may be another launch in progress; leave it intact.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const lock = readJson(lockFile);
  const confirmStopped = process.platform === 'linux' ? '请先确认原 Class 进程已退出' : '请先在任务管理器确认 Class.exe 已退出';
  if (fs.existsSync(lockFile) && !lock) throw new Error(`Class 启动锁文件损坏，已保留以避免重复运行。${confirmStopped}，再将此文件重命名后重试：${lockFile}`);
  if (fs.existsSync(recoveryFile) && !readJson(recoveryFile)) throw new Error(`Class 恢复锁文件损坏，已保留以避免重复运行。${confirmStopped}，再将此文件重命名后重试：${recoveryFile}`);
  const restart = process.platform === 'linux' ? '结束原 Class 进程后重新运行 ./Class' : '在任务管理器结束原 Class.exe 后重新双击';
  throw new Error(`另一个 Class 进程正在启动或未响应。请稍候后重试；若仍失败，${restart}。数据目录：${dataDir}`);
}

async function main() {
  if (args.includes('--help')) {
    console.log(process.platform === 'linux'
      ? 'Class desktop\nRun ./Class to open the Web UI. With --no-browser, open the printed browser entry manually.\nOptions: --data-dir <folder> --no-browser'
      : 'Class desktop\nDouble-click Class.exe to open the Web UI.\nOptions: --data-dir <folder> --no-browser');
    return;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { shutdown().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); }); });
  process.once('exit', releaseInstance);
  const explicit = option('--data-dir') || process.env.CLASS_DATA_DIR || process.env.DISCUSSION_DATA_DIR;
  requestedPath = path.resolve(explicit || defaultDataDirectory());
  unavailablePath = requestedPath;
  let previous, selection, workspaceOverride;
  try {
    selection = await readRecoverySelection(requestedPath);
    recoveryOrigin = selection?.previousDataDir;
    anchorDir = selection?.anchorDir || canonicalDataPath(requestedPath, { allowMissing: !explicit });
    previous = await claimDirectory(anchorDir);
    if (!previous) {
      // Capture the unavailable target for the recovery message/workspace map
      // before the strict resolver reports a missing or inaccessible directory.
      const pointer = readJson(path.join(anchorDir, DATA_POINTER));
      if (pointer?.version === 1 && typeof pointer.dataDir === 'string' && path.isAbsolute(pointer.dataDir)) unavailablePath = pointer.dataDir;
      const resolved = resolveDataLocation(anchorDir); anchorDir = resolved.anchorDir;
      if (!sameDirectory(dataDir, resolved.dataDir)) previous = await claimDirectory(resolved.dataDir);
      if (!previous && selection) workspaceOverride = (await validateRecoveryDirectory(dataDir, { previousDataDir: selection.previousDataDir })).workspaceOverride;
    }
  } catch (error) { await startRecovery(error); return; }
  configureStartupLog(dataDir);
  if (previous) {
    releaseInstance();
    console.log(`Class is already running: ${previous.url}`);
    startupLog('existing-instance-reused', `pid=${previous.pid} url=${previous.url}`);
    await openBrowser(previous); return;
  }
  try {
    const started = await createApplication(dataDir, anchorDir, workspaceOverride, Boolean(selection));
    app = started.server; currentInstance = started.instance;
  } catch (error) { await startRecovery(error); return; }
  unavailablePath = undefined;
  for (const directory of ownedDirectories) writeInstance(directory, currentInstance);
  startupLog('service-ready', currentInstance.url);
  console.log(`Class is ready.\n${currentInstance.url}\nData: ${dataDir}\nUse the Web UI exit button to stop the background service.`);
  await openBrowser(currentInstance);
}

main().catch(async error => {
  const reason = startupFailureMessage(error);
  console.error(`Class could not start: ${reason}`);
  const log = startupLog('startup-failed', reason);
  try { await shutdown(); } catch (closeError) { console.error(closeError.message); }
  const retry = process.platform === 'linux' ? '重新运行 ./Class' : '重新双击 Class.exe';
  await showStartupError(`Class 启动失败。\n\n${reason}\n\n启动日志：${log}\n\n请保留日志以便排查，然后${retry}。`, { silent: args.includes('--no-browser') });
  process.exitCode = 1;
});
