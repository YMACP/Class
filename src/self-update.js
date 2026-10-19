import fs from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { checkRelease, downloadRelease } from './release-update.js';
import { VERSION, COMPILED_DESKTOP } from './version.js';

const STATUS_FILE = '.class-update-status.json';
const JOB_PATTERN = /^\.class-update-[0-9a-f-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const files = ['job.json', 'ready.json', 'commit.json', 'abort.json', 'result.json', 'payload', 'previous', 'helper', 'helper.exe'];
const activeStates = new Set(['checking', 'downloading', 'restarting']);
const validString = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\0\r\n]/.test(value);
const exists = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const newer = (next, current) => {
  if (![next, current].every(value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value))) return false;
  const a = next.split('.').map(BigInt), b = current.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
};
async function digest(filename) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}
async function regular(filename) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error('Update file is not an owned regular file');
  return info;
}
async function json(filename) {
  const info = await regular(filename);
  if (info.size > 32768) throw Error('Update record exceeds size limit');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}
async function optionalJSON(filename) {
  try { return await json(filename); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function writeJSON(filename, value) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  let file, created = false;
  try {
    file = await fs.open(temporary, 'wx', 0o600); created = true;
    await file.writeFile(JSON.stringify(value)); await file.sync();
    await file.close(); file = undefined;
    await fs.rename(temporary, filename);
  } catch (error) {
    await file?.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}
async function statusFile(directory, state, targetVersion) {
  await writeJSON(path.join(directory, STATUS_FILE), { state, targetVersion, at: new Date().toISOString(), message: state === 'failed' ? '更新失败' : '' });
}

export function createSelfUpdater({ version = VERSION, compiled = COMPILED_DESKTOP, executable = process.execPath,
  platform = process.platform, arch = process.arch, getLaunch, onInstall,
  check = checkRelease, download = downloadRelease, launchHelper = startUpdateHelper, restartNoticeMs = 5000 } = {}) {
  const supported = compiled && ['win32', 'linux'].includes(platform) && arch === 'x64';
  let state = { state: 'idle', version, supported }, pending, controller, handedOff = false, closed = false, acknowledge;
  const snapshot = () => ({ ...state });
  const failure = () => { state = { ...state, state: 'failed', message: '更新失败' }; };
  return {
    status: snapshot,
    acknowledgeRestart() { if(state.state==='restarting')acknowledge?.(); },
    async restoreStatus(directory) {
      const saved = await optionalJSON(path.join(directory, STATUS_FILE)).catch(() => undefined);
      if (saved?.state === 'failed' && newer(saved.targetVersion, version)) { state = { ...state, state: 'failed', message: '更新失败', targetVersion: saved.targetVersion, previousAttempt: true }; }
    },
    start({ prepareRestart } = {}) {
      if (closed || pending || activeStates.has(state.state)) return snapshot();
      controller = new AbortController(); const signal = controller.signal;
      state = { state: 'checking', version, supported };
      pending = (async () => {
        let helper, rollbackPreparation;
        try {
          const release = await check({ currentVersion: version, platform, arch, signal }); signal.throwIfAborted();
          if (!release.available) {
            if(release.reason==='asset_unavailable')throw Error('The newer release has no matching executable');
            state = { state: 'current', version, supported, message: '当前已是最新版' }; return;
          }
          if (!supported || !newer(release.version, version) || !release.asset) throw Error('No compatible native update');
          state = { ...state, state: 'downloading', targetVersion: release.version };
          helper = await launchHelper({ executable, version, targetVersion: release.version, asset: release.asset, download, signal, getLaunch });
          signal.throwIfAborted();
          rollbackPreparation = await prepareRestart?.(); signal.throwIfAborted();
          // Only this flag allows close() during our own graceful shutdown.
          handedOff = true; state = { ...state, state: 'restarting' };
          // Let an authenticated status response deliver the restart state.
          // A closed/background page must not block the actual update forever.
          await Promise.race([new Promise(resolve=>{acknowledge=resolve;}),delay(restartNoticeMs,undefined,{signal,ref:false})]);
          await delay(300, undefined, { signal });
          if (typeof onInstall !== 'function') throw Error('Native restart is unavailable');
          await onInstall(helper);
        } catch (error) {
          handedOff = false;
          await helper?.abort(false).catch(() => {});
          await rollbackPreparation?.().catch(() => {});
          if (!closed) failure();
        } finally { pending = undefined; }
      })();
      return snapshot();
    },
    async close() {
      if (handedOff) return;
      closed = true; controller?.abort(Error('Application stopped')); await pending;
    },
  };
}

// The helper is a copy of the already running, trusted Class executable. A
// downloaded executable is never started merely to inspect its architecture.
export async function startUpdateHelper({ executable, version, targetVersion, asset, download, signal, getLaunch }) {
  if (!path.isAbsolute(executable) || !newer(targetVersion, version)) throw Error('Invalid native update');
  await regular(executable);
  const parent = await fs.realpath(path.dirname(executable)), target = path.join(parent, path.basename(executable));
  const oldHash = await digest(target);
  const directory = await fs.mkdtemp(path.join(parent, '.class-update-'));
  // mkdtemp's short suffix is replaced by a noncolliding UUID for strict job ownership.
  const owned = path.join(parent, '.class-update-' + randomUUID());
  await fs.rename(directory, owned); await fs.chmod(owned, 0o700);
  let child, job;
  try {
    const payload = path.join(owned, 'payload');
    const downloaded = await download(asset, payload, { signal }); signal.throwIfAborted();
    if (!HASH.test(downloaded.sha256) || await digest(payload) !== downloaded.sha256) throw Error('Downloaded update hash mismatch');
    const launch = await getLaunch();
    if (![launch?.requestedPath, launch?.dataDir, launch?.cwd].every(value => validString(value) && path.isAbsolute(value))) throw Error('Invalid Class restart locations');
    const helper = path.join(owned, process.platform === 'win32' ? 'helper.exe' : 'helper');
    await fs.copyFile(target, helper, constants.COPYFILE_EXCL); await fs.chmod(helper, 0o700);
    if (await digest(helper) !== oldHash) throw Error('Class executable changed during update preparation');
    job = { schema: 1, nonce: randomBytes(32).toString('hex'), parentPid: process.pid, helperPid: null,
      target: path.basename(target), oldHash, newHash: downloaded.sha256, version, targetVersion,
      requestedPath: launch.requestedPath, dataDir: launch.dataDir, cwd: launch.cwd, noBrowser: launch.noBrowser === true,
      mode: (await fs.stat(target)).mode & 0o777, createdAt: Date.now() };
    await writeJSON(path.join(owned, 'job.json'), job);
    child = spawn(helper, ['--apply-update', owned, '--update-nonce', job.nonce], { cwd: parent, detached: true, windowsHide: true, stdio: 'ignore' });
    let exited = false, spawnError; child.once('error', error => { spawnError = error; }); child.once('exit', () => { exited = true; }); child.unref();
    const deadline = Date.now() + 15000;
    while (true) {
      signal.throwIfAborted();
      if (spawnError || exited || Date.now() >= deadline) throw Error('Update helper could not start');
      const ready = await optionalJSON(path.join(owned, 'ready.json'));
      if (ready?.nonce === job.nonce && ready.pid === child.pid) break;
      await delay(100, undefined, { signal });
    }
    return {
      async commit() {
        if (exited || spawnError) throw Error('Update helper exited before handoff');
        await writeJSON(path.join(owned, 'commit.json'), { nonce: job.nonce });
      },
      async abort(restart = false) {
        await writeJSON(path.join(owned, 'abort.json'), { nonce: job.nonce, restart });
        if (!restart) {
          const deadline = Date.now() + 10000;
          while (!exited && !spawnError && Date.now() < deadline) await delay(100);
          if (exited || spawnError) await removeOwnedFiles(owned);
        }
      },
    };
  } catch (error) {
    if (child?.pid && job) {
      await writeJSON(path.join(owned, 'abort.json'), { nonce: job.nonce, restart: false }).catch(() => {});
      const deadline = Date.now() + 10000;
      while (exists(child.pid) && Date.now() < deadline) await delay(100);
      if (!exists(child.pid)) await removeOwnedFiles(owned).catch(() => {});
    }
    else await removeOwnedFiles(owned).catch(() => {});
    throw error;
  }
}

async function readJob(directory, nonce, { self = true } = {}) {
  if (!path.isAbsolute(directory) || !JOB_PATTERN.test(path.basename(directory))) throw Error('Invalid update directory');
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory) throw Error('Update directory was replaced');
  const job = await json(path.join(directory, 'job.json'));
  if (job.schema !== 1 || !HASH.test(job.nonce) || nonce !== undefined && job.nonce !== nonce
    || !HASH.test(job.oldHash) || !HASH.test(job.newHash) || !newer(job.targetVersion, job.version)
    || !Number.isSafeInteger(job.parentPid) || job.parentPid < 1 || job.parentPid === process.pid
    || !validString(job.target) || path.basename(job.target) !== job.target || ['.', '..'].includes(job.target)
    || ![job.requestedPath, job.dataDir, job.cwd].every(value => validString(value) && path.isAbsolute(value))
    || typeof job.noBrowser !== 'boolean' || !Number.isSafeInteger(job.mode) || job.mode < 0 || job.mode > 0o777) throw Error('Invalid update job');
  const helper = path.join(directory, process.platform === 'win32' ? 'helper.exe' : 'helper');
  if (self && (await fs.realpath(process.execPath) !== helper || await digest(helper) !== job.oldHash)) throw Error('Update helper identity mismatch');
  return { job, target: path.join(path.dirname(directory), job.target), helper };
}
async function removeOwnedFiles(directory) {
  if (!JOB_PATTERN.test(path.basename(directory)) || (await fs.lstat(directory)).isSymbolicLink()) throw Error('Invalid cleanup directory');
  for (const name of await fs.readdir(directory)) if (!files.includes(name)) throw Error('Unexpected update directory content');
  for (const name of files) {
    const filename = path.join(directory, name);
    try { await regular(filename); await fs.unlink(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.rmdir(directory);
}
async function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(from, to); return; }
    catch (error) { if (attempt >= 30 || !['EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error; await delay(200); }
  }
}
function launchTarget(target, job, directory) {
  const child = spawn(target, ['--data-dir', job.requestedPath, ...(job.noBrowser ? ['--no-browser'] : []), '--update-cleanup', directory],
    { cwd: job.cwd, detached: true, windowsHide: true, stdio: 'ignore' });
  const result = { child, ended: false, error: undefined };
  child.once('error', error => { result.error = error; result.ended = true; });
  child.once('exit', () => { result.ended = true; }); child.unref();
  return result;
}
async function verifyStarted(started, job) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (started.ended) throw Error('Updated Class exited during startup');
    const instance = await optionalJSON(path.join(job.dataDir, 'instance.json')).catch(() => undefined);
    if (instance?.pid === started.child.pid && /^[a-f0-9]{64}$/.test(instance.token || '')) {
      try {
        const url = new URL(instance.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Invalid updated instance');
        const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(1200) });
        const health = await response.json();
        if (response.ok && health.app === 'class' && health.version === job.targetVersion) return;
      } catch { /* Startup may not yet have published its ready HTTP endpoint. */ }
    }
    await delay(200);
  }
  throw Error('Updated Class did not become ready');
}
async function stopOwnedChild(started) {
  if (!started || started.ended) return;
  started.child.kill();
  const deadline = Date.now() + 10000;
  while (!started.ended && Date.now() < deadline) await delay(100);
  if (!started.ended) throw Error('Updated child is still running; rollback preserved for manual recovery');
}

export async function applyUpdate(directory, nonce) {
  const { job, target } = await readJob(directory, nonce);
  await regular(target); await regular(path.join(directory, 'payload'));
  if (await digest(target) !== job.oldHash || await digest(path.join(directory, 'payload')) !== job.newHash) throw Error('Update files changed before handoff');
  await writeJSON(path.join(directory, 'ready.json'), { nonce, pid: process.pid });
  const deadline = Date.now() + 600000;
  while (true) {
    const abort = await optionalJSON(path.join(directory, 'abort.json'));
    if (abort?.nonce === nonce) {
      if (abort.restart) {
        while (exists(job.parentPid)) await delay(100);
        await statusFile(job.dataDir, 'failed', job.targetVersion).catch(() => {});
        launchTarget(target, job, directory);
      }
      await writeJSON(path.join(directory, 'result.json'), { state: 'aborted', helperPid: process.pid }).catch(() => {});
      return;
    }
    const commit = await optionalJSON(path.join(directory, 'commit.json'));
    if (commit?.nonce === nonce && !exists(job.parentPid)) break;
    if (Date.now() >= deadline) throw Error('Update handoff expired');
    // An uncommitted parent exit never permits replacement.
    if (!exists(job.parentPid) && commit?.nonce !== nonce) {
      await statusFile(job.dataDir, 'failed', job.targetVersion);
      await writeJSON(path.join(directory, 'result.json'), { state: 'aborted', helperPid: process.pid }); return;
    }
    await delay(100);
  }
  const previous = path.join(directory, 'previous');
  let moved = false, installed = false, started;
  try {
    await regular(target);
    if (await digest(target) !== job.oldHash || await digest(path.join(directory, 'payload')) !== job.newHash) throw Error('Update files changed after handoff');
    await renameRetry(target, previous); moved = true;
    await fs.chmod(path.join(directory, 'payload'), job.mode | 0o700);
    await fs.rename(path.join(directory, 'payload'), target); installed = true;
    started = launchTarget(target, job, directory);
    await verifyStarted(started, job);
    // Recording the outcome must not roll back a healthy new process when the
    // data volume becomes read-only or full. Uncleaned jobs preserve the backup.
    await statusFile(job.dataDir, 'updated', job.targetVersion).catch(() => {});
    await writeJSON(path.join(directory, 'result.json'), { state: 'updated', helperPid: process.pid }).catch(() => {});
  } catch (error) {
    await stopOwnedChild(started);
    if (installed) {
      await regular(target);
      if (await digest(target) !== job.newHash) throw Error('Installed binary changed; the previous executable is preserved');
      await fs.unlink(target);
    }
    if (moved) await renameRetry(previous, target);
    await statusFile(job.dataDir, 'failed', job.targetVersion).catch(() => {});
    await writeJSON(path.join(directory, 'result.json'), { state: 'failed', helperPid: process.pid }).catch(() => {});
    // Relaunch only our preserved executable, never another process by name.
    if (await digest(target) === job.oldHash) launchTarget(target, job, directory);
  }
}

// The restarted application removes the helper only after it has exited.
// Windows cannot unlink a running helper; no shell or scheduled deletion is used.
export async function cleanupUpdate(directory) {
  const { job, target } = await readJob(directory, undefined, { self: false });
  if (await fs.realpath(process.execPath) !== target || ![job.oldHash, job.newHash].includes(await digest(target))) throw Error('Cleanup belongs to another executable');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const result = await optionalJSON(path.join(directory, 'result.json'));
    if (result && ['updated', 'failed', 'aborted'].includes(result.state) && Number.isSafeInteger(result.helperPid) && !exists(result.helperPid)) {
      await removeOwnedFiles(directory); return;
    }
    await delay(250);
  }
}
