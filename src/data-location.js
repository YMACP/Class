import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createProfileStore, atomicJSON } from './profile-store.js';
import { assertStorageSpace, storageError, storageDetails } from './storage-health.js';
import { writeRecoveryLauncher, RECOVERY_LAUNCHER } from './recovery-launcher.js';

export const DATA_POINTER = 'data-location.json';
export const MIGRATION_LOCK = 'data-migration.lock';
export const MIGRATION_COMMIT = 'data-migration-committed.json';
export const MIGRATION_RECOVERY = 'migration-recovery.json';
const RUNTIME_FILES = new Set(['instance.lock', 'instance.json', 'instance.recovery.lock', DATA_POINTER, MIGRATION_LOCK, MIGRATION_COMMIT, MIGRATION_RECOVERY, RECOVERY_LAUNCHER, '\u6253\u5f00Class.html']);
function problem(status, message) { return Object.assign(new Error(message), { status }); }
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs].join(':');
async function stillOwned(entry) {
  try { const stat = await fs.lstat(entry.path); return !stat.isSymbolicLink() && stamp(stat) === entry.stamp; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function comparable(value) { const result = path.resolve(value); return process.platform === 'win32' ? result.toLowerCase() : result; }
export function sameDirectory(a, b) { return comparable(a) === comparable(b); }
function within(parent, child) { const relative = path.relative(comparable(parent), comparable(child)); return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); }
function validateAbsolute(value) { if (typeof value !== 'string' || !value.trim() || value.length > 32768 || value.includes('\0') || !path.isAbsolute(value)) throw problem(400, 'Data directory must be an absolute folder path'); return path.resolve(value.trim()); }

// Do not follow junctions/symlinks, including in an existing parent of a new path.
export function canonicalDataPath(value, { allowMissing = false } = {}) {
  const absolute = validateAbsolute(value), parsed = path.parse(absolute);
  let cursor = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let info;
    try { info = syncFs.lstatSync(cursor); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return path.join(syncFs.realpathSync(path.dirname(cursor)), ...parts.slice(i)); throw problem(400, 'Data directory does not exist or cannot be accessed'); }
    if (info.isSymbolicLink()) throw problem(400, 'Data directories cannot contain symbolic links or junctions');
    if (!info.isDirectory()) throw problem(400, 'Data directory path contains a non-directory');
  }
  return syncFs.realpathSync(absolute);
}

export function resolveDataLocation(anchorDir) {
  const anchor = canonicalDataPath(anchorDir), pointer = path.join(anchor, DATA_POINTER);
  let value;
  try {
    if (syncFs.lstatSync(pointer).isSymbolicLink()) throw new Error('The data-location pointer cannot be a symbolic link');
    value = JSON.parse(syncFs.readFileSync(pointer, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return { anchorDir: anchor, dataDir: anchor }; throw new Error('The saved data-directory location is unreadable; the original data has been preserved'); }
  if (!value || value.version !== 1 || typeof value.dataDir !== 'string') throw new Error('The saved data-directory location has an unsupported format');
  const target = canonicalDataPath(value.dataDir);
  if (!sameDirectory(anchor, target) && (within(anchor, target) || within(target, anchor))) throw new Error('The saved data directory overlaps its startup anchor');
  // Exactly one pointer is read: a target's own pointer never creates a chain.
  return { anchorDir: anchor, dataDir: target };
}
async function withWritableOwnedCopy(entry, operation, action, { preserveOnSuccess = true } = {}) {
  let original, changed = false, completed = false, failure;
  try {
    original = await fs.lstat(entry.path);
    if (!original.isFile() || original.isSymbolicLink() || stamp(original) !== entry.stamp) throw problem(409, 'A copied destination file changed during migration');
    // copyFile preserves Windows' read-only bit. Only our verified destination
    // copy may temporarily lose that bit; source permissions are never changed.
    if (process.platform === 'win32' && !(original.mode & 0o200)) {
      await fs.chmod(entry.path, original.mode | 0o200); changed = true;
    }
    const result = await action(); completed = true; return result;
  } catch (error) {
    failure = error.status ? error : storageError(error, { operation, path: entry.path }); throw failure;
  } finally {
    if (changed && (!completed || preserveOnSuccess)) {
      try {
        // Never apply old attributes to a replacement or an unrelated file.
        if (await stillOwned(entry)) await fs.chmod(entry.path, original.mode);
      } catch (error) {
        const restoreError = storageError(error, { operation: '恢复文件属性', path: entry.path });
        if (failure) failure.readonlyRestoreError = storageDetails(restoreError); else throw restoreError;
      }
    }
  }
}

export function committedMigration(directory, migration) {
  try {
    const filename = path.join(directory, MIGRATION_COMMIT);
    if (syncFs.lstatSync(filename).isSymbolicLink()) return false;
    const commit = JSON.parse(syncFs.readFileSync(filename, 'utf8'));
    if (commit.version !== 1 || commit.migrationId !== migration.migrationId || !sameDirectory(commit.dataDir, directory) || commit.recoveryLauncher !== path.join(directory, RECOVERY_LAUNCHER)) return false;
    const launcher = syncFs.lstatSync(commit.recoveryLauncher);
    const report = JSON.parse(syncFs.readFileSync(path.join(directory, MIGRATION_RECOVERY), 'utf8'));
    return launcher.isFile() && !launcher.isSymbolicLink() && report.version === 1 && report.migrationId === migration.migrationId;
  } catch { return false; }
}

export async function readMigrationRecovery(directory) {
  const filename = path.join(directory, MIGRATION_RECOVERY);
  try {
    if ((await fs.lstat(filename)).isSymbolicLink()) throw Error('Migration recovery report cannot be a symbolic link');
    const report = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (report.version !== 1 || !Array.isArray(report.recoveredFailures)) throw Error('Invalid migration recovery report');
    return { ...(typeof report.warning === 'string' && report.warning ? { warning: report.warning } : {}), ...(typeof report.recoveryLauncher === 'string' ? { recoveryLauncher: report.recoveryLauncher } : {}), recoveredFailures: report.recoveredFailures };
  } catch (error) { if (error.code === 'ENOENT') return { recoveredFailures: [] }; throw storageError(error, { operation: 'read_migration_recovery', path: filename }); }
}

async function inspectTree(directory, relative = '') {
  const entries = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (!relative && (RUNTIME_FILES.has(item.name) || /^(?:instance|data-location)\.json\..*\.tmp$/.test(item.name))) continue;
    const from = path.join(directory, item.name), name = path.join(relative, item.name), stat = await fs.lstat(from);
    if (stat.isSymbolicLink()) throw problem(400, 'Data migration does not follow symbolic links or junctions: ' + name);
    if (stat.isDirectory()) { entries.push({ name, directory: true }); entries.push(...await inspectTree(from, name)); }
    else if (stat.isFile()) entries.push({ name, directory: false, size: stat.size, stamp: stamp(stat) });
    else throw problem(400, 'Unsupported special file in data directory: ' + name);
  }
  return entries;
}

async function digestFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of syncFs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function journalDiagnostics(filename) {
  const issues = []; let parts = [], bytes = 0, line = 1, invalid = false;
  const add = chunk => { bytes += chunk.length; if (bytes <= 1024 * 1024) parts.push(chunk); else parts = []; };
  for await (const chunk of syncFs.createReadStream(filename)) {
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) >= 0) {
      add(chunk.subarray(start, end));
      if (!invalid) {
        try { if (bytes > 1024 * 1024) throw Error('Oversized record'); const text = Buffer.concat(parts).toString('utf8'); if (text.trim()) JSON.parse(text); }
        catch { invalid = true; issues.push({ code: 'JOURNAL_INVALID_RECORD', operation: 'verify_migration', path: filename, line, message: '档案中存在损坏记录，原文件已完整保留，未跳过或改写。' }); }
      }
      parts = []; bytes = 0; line++; start = end + 1;
    }
    add(chunk.subarray(start));
  }
  if (bytes) issues.push({ code: 'JOURNAL_INCOMPLETE_TAIL', operation: 'verify_migration', path: filename, incompleteTailBytes: bytes, message: '档案末尾存在未完整写入的记录，原文件已完整保留。' });
  return issues;
}
function normalizedSnapshots(snapshots) {
  if (snapshots === undefined) return undefined;
  if (!snapshots || !Array.isArray(snapshots.runs) || !(snapshots.currentRunId === null || typeof snapshots.currentRunId === 'string')) throw problem(400, 'Invalid recovery snapshots');
  const ids = new Set();
  for (const run of snapshots.runs) {
    if (!run || !/^[A-Za-z0-9_-]{1,160}$/.test(run.id || '') || ids.has(run.id) || !['completed', 'failed', 'stopped', 'interrupted'].includes(run.status)) throw problem(400, 'Recovery snapshots require unique, terminal task records');
    ids.add(run.id);
  }
  if (snapshots.currentRunId !== null && !ids.has(snapshots.currentRunId)) throw problem(400, 'Current recovery task is missing from snapshots');
  return JSON.parse(JSON.stringify(snapshots));
}

async function checkDestination(target, created, hasLease, runtimeReady = false) {
  canonicalDataPath(target);
  const allowed = new Set(created.map(entry => entry.path));
  allowed.add(path.join(target, MIGRATION_LOCK));
  if (hasLease) allowed.add(path.join(target, 'instance.lock'));
  if (hasLease && runtimeReady) { allowed.add(path.join(target, 'instance.json')); allowed.add(path.join(target, '\u6253\u5f00Class.html')); }
  async function inspect(directory) {
    for (const item of await fs.readdir(directory)) {
      const filename = path.join(directory, item), stat = await fs.lstat(filename);
      if (!allowed.has(filename) || stat.isSymbolicLink()) throw problem(409, 'The destination changed during migration; unrelated files were preserved');
      if (stat.isDirectory()) await inspect(filename);
    }
  }
  await inspect(target);
  for (const entry of created) if (!entry.directory && !await stillOwned(entry)) throw problem(409, 'A copied destination file changed during migration');
}

async function checkMigrationTargetIdentity(target, directory) {
  canonicalDataPath(target);
  const actual = await directory.stat(), current = await fs.lstat(target);
  if (!actual.isDirectory() || current.isSymbolicLink() || !current.isDirectory() || actual.dev !== current.dev || actual.ino !== current.ino) {
    throw problem(409, '目标数据目录在迁移准备期间发生变化，请重新选择');
  }
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : process.getuid();
  if (actual.uid !== uid || current.uid !== uid) throw problem(400, '目标数据目录必须属于当前运行用户');
  return actual;
}

export async function prepareLinuxMigrationTarget(target) {
  let directory;
  try {
    directory = await fs.open(target, syncFs.constants.O_RDONLY | syncFs.constants.O_DIRECTORY | syncFs.constants.O_NOFOLLOW);
    const before = await checkMigrationTargetIdentity(target, directory);
    // Bind the emptiness check and chmod to the opened directory, so replacing
    // the selected pathname cannot redirect a permission change elsewhere.
    const contents = () => fs.readdir(`/proc/self/fd/${directory.fd}`);
    if ((await contents()).length) throw problem(409, '目标数据目录必须为空，已有文件不会被覆盖');
    await checkMigrationTargetIdentity(target, directory);
    if ((before.mode & 0o777) !== 0o700) {
      try { await directory.chmod(0o700); }
      catch (error) { throw problem(400, `无法将目标数据目录权限设置为 0700（${error.code || '未知错误'}），请选择当前用户拥有且支持 Linux 权限的空目录`); }
    }
    const after = await checkMigrationTargetIdentity(target, directory);
    if ((after.mode & 0o777) !== 0o700) throw problem(400, '无法将目标数据目录权限设置为 0700，请选择支持 Linux 权限的空目录');
    if ((await contents()).length) throw problem(409, '目标数据目录在迁移准备期间被写入，请重新选择空目录');
    return directory;
  } catch (error) {
    await directory?.close();
    throw error;
  }
}

/** Copy a complete profile and publish the anchor pointer only after validation.
 * Source data is retained. The lifecycle holds desktop locks across the commit.
 */
export async function relocateProfileDirectory({ sourceDir, targetPath, anchorDir, config, secrets, lifecycle, snapshots }) {
  const source = canonicalDataPath(sourceDir), anchor = canonicalDataPath(anchorDir), target = canonicalDataPath(targetPath, { allowMissing: true });
  if (sameDirectory(source, target)) return { unchanged: true, dataDir: source };
  if (within(source, target) || within(target, source) || within(anchor, target) || within(target, anchor)) throw problem(400, 'Choose a data directory separate from the current directory and startup anchor');
  let existed = true;
  try { if ((await fs.readdir(target)).length) throw problem(409, 'The destination must be empty; existing files will not be overwritten'); }
  catch (error) { if (error.code === 'ENOENT') existed = false; else throw error; }
  const entries = await inspectTree(source);
  snapshots = normalizedSnapshots(snapshots);
  if (!config || config.version !== 1 || !Array.isArray(config.agents) || !config.settings || typeof config.settings.cwd !== 'string') throw problem(400, 'Invalid recovery profile');
  const workspace = path.join(source, 'workspace'), configured = path.resolve(config.settings.cwd);
  const nextConfig = JSON.parse(JSON.stringify({ ...config, settings: { ...config.settings, ...(within(workspace, configured) ? { cwd: path.join(target, 'workspace', path.relative(workspace, configured)) } : {}) } }));
  const copiedBytes = entries.reduce((total, entry) => total + (entry.size || 0), 0);
  const requiredBytes = copiedBytes + 2 * Buffer.byteLength(JSON.stringify({ config: nextConfig, snapshots })) + 1024 * 1024;
  await assertStorageSpace(target, { requiredBytes, operation: 'migrate_profile' });
  if (!existed) await fs.mkdir(target, { recursive: true, mode: 0o700 });
  // Recheck after mkdir and immediately take an exclusive migration reservation.
  if ((await fs.readdir(target)).length) throw problem(409, 'The destination changed or is already in use');
  const marker = path.join(target, MIGRATION_LOCK), migrationId = randomUUID(), created = [];
  let lease, permissionDirectory, published = false, committed = false, reserved = false, retainReservation = false;
  const trackedJSON = async (filename, value) => {
    let entry = created.find(item => item.path === filename);
    if (entry && !await stillOwned(entry)) throw problem(409, 'A destination recovery file changed during migration');
    if (entry) await withWritableOwnedCopy(entry, '保存恢复快照', () => atomicJSON(filename, value), { preserveOnSuccess: false });
    else await atomicJSON(filename, value, { overwrite: false });
    if (!entry) { entry = { path: filename, directory: false }; created.push(entry); }
    entry.stamp = stamp(await fs.lstat(filename));
  };
  const ensureDirectory = async filename => {
    if (created.some(entry => entry.path === filename && entry.directory)) return;
    await fs.mkdir(filename, { mode: 0o700 }); created.push({ path: filename, directory: true });
  };
  try {
    // Only a user-selected, empty directory owned by this Linux user is
    // normalized. Ordinary profile reads/saves keep their strict checks.
    if (process.platform === 'linux') permissionDirectory = await prepareLinuxMigrationTarget(target);
    await fs.writeFile(marker, JSON.stringify({ pid: process.pid, migrationId, anchorDir: anchor, sourceDir: source }) + '\n', { flag: 'wx', mode: 0o600 }); reserved = true;
    if (permissionDirectory) {
      await checkMigrationTargetIdentity(target, permissionDirectory);
      await permissionDirectory.close(); permissionDirectory = undefined;
    }
    lease = await lifecycle?.({ from: source, to: target, anchorDir: anchor });
    await checkDestination(target, created, Boolean(lease));
    for (const entry of entries) {
      const to = path.join(target, entry.name);
      if (entry.directory) { await fs.mkdir(to, { mode: 0o700 }); created.push({ path: to, directory: true }); }
      else {
        const from = path.join(source, entry.name);
        if (stamp(await fs.lstat(from)) !== entry.stamp) throw problem(409, 'Source data changed during migration');
        try { await fs.copyFile(from, to, syncFs.constants.COPYFILE_EXCL); }
        catch (error) {
          if ((error.storageCode || error.code) !== 'EEXIST') {
            // Some runtimes/filesystems may leave a partial destination after
            // copyFile fails. Its ownership is not confirmed, so preserve it
            // and the reservation instead of exposing an unmarked partial copy.
            try { await fs.lstat(to); retainReservation = true; }
            catch (inspectError) { if (inspectError.code !== 'ENOENT') retainReservation = true; }
          }
          throw storageError(error, { operation: '复制文件', path: to });
        }
        const owned = { path: to, directory: false, stamp: stamp(await fs.lstat(to)) }; created.push(owned);
        await withWritableOwnedCopy(owned, '同步复制文件', async () => {
          const file = await fs.open(to, 'r+'); try { await file.sync(); } finally { await file.close(); }
        });
        if (stamp(await fs.lstat(from)) !== entry.stamp || await digestFile(from) !== await digestFile(to)) throw problem(409, 'Copied data failed byte-for-byte verification');
      }
    }
    const latestEntries = await inspectTree(source);
    if (JSON.stringify(latestEntries) !== JSON.stringify(entries)) throw problem(409, 'Source data changed during migration');
    await checkDestination(target, created, Boolean(lease));
    // These credentials are an owned target copy used by future profile saves.
    // Keep their bytes intact, but allow the application to atomically replace
    // them later, just like regenerated profiles/current-run/task summaries.
    const credentials = created.find(entry => entry.path === path.join(target, 'credentials.dpapi.json'));
    if (credentials) await withWritableOwnedCopy(credentials, '准备恢复凭据', async () => {}, { preserveOnSuccess: false });
    const recoveredFailures = Array.isArray(snapshots?.storageWarnings) ? [...snapshots.storageWarnings] : [];
    for (const entry of entries) if (!entry.directory && path.basename(entry.name) === 'journal.jsonl') recoveredFailures.push(...await journalDiagnostics(path.join(target, entry.name)));
    await trackedJSON(path.join(target, 'profiles.json'), nextConfig);
    if (snapshots) {
      await ensureDirectory(path.join(target, 'history'));
      for (const run of snapshots.runs) await trackedJSON(path.join(target, 'history', run.id + '.json'), run);
      await trackedJSON(path.join(target, 'current-run.json'), { version: 1, runId: snapshots.currentRunId });
    }
    await ensureDirectory(path.join(target, 'workspace'));
    const nextStore = await createProfileStore(target);
    const oldKeys = Object.entries(secrets), newKeys = Object.entries(nextStore.secrets);
    if (oldKeys.length !== newKeys.length || oldKeys.some(([key, value]) => nextStore.secrets[key] !== value)) throw new Error('Copied Agent credentials failed verification');
    nextStore.config = nextConfig;
    const recoveryLauncher = await writeRecoveryLauncher(target, lease?.launchSpec);
    created.push({ path: recoveryLauncher, directory: false, stamp: stamp(await fs.lstat(recoveryLauncher)) });
    const fallbackWarning = '数据已完整保存到新目录，但原启动入口未更新。关闭后请使用新目录中的启动入口：' + recoveryLauncher;
    const pendingWarning = '数据已完整保存到新目录，启动位置登记尚未确认。请通过备用启动入口确保使用新目录：' + recoveryLauncher;
    const report = { version: 1, migrationId, sourceDir: source, anchorDir: anchor, dataDir: target, recoveryLauncher, recoveredFailures, copiedBytes, copiedFiles: entries.filter(entry => !entry.directory).length, createdAt: new Date().toISOString(), pointerUpdated: null, warning: pendingWarning };
    await trackedJSON(path.join(target, MIGRATION_RECOVERY), report);
    await checkDestination(target, created, Boolean(lease));
    await lease?.commit?.();
    await checkDestination(target, created, Boolean(lease), true);
    await trackedJSON(path.join(target, MIGRATION_COMMIT), { version: 1, migrationId, dataDir: target, recoveryLauncher, committedAt: new Date().toISOString() });
    committed = true;
    let warning;
    try { await atomicJSON(path.join(anchor, DATA_POINTER), { version: 1, dataDir: target }); published = true; }
    catch (error) { warning = fallbackWarning; recoveredFailures.push(storageDetails(storageError(error, { operation: 'update_startup_pointer', path: path.join(anchor, DATA_POINTER) }))); }
    if (!warning && recoveredFailures.length) warning = '数据已迁移，此前的存储异常已记录在恢复报告中，可继续查看已保存证据。';
    try { await trackedJSON(path.join(target, MIGRATION_RECOVERY), { ...report, pointerUpdated: published, recoveredFailures, warning }); }
    catch (error) { warning = (warning || '数据已迁移。') + ' 最新恢复报告未能更新；原恢复报告和新启动入口已保留。'; recoveredFailures.push(storageDetails(storageError(error, { operation: 'update_recovery_report', path: path.join(target, MIGRATION_RECOVERY) }))); }
    return { dataDir: target, store: nextStore, ...(warning ? { warning } : {}), recoveryLauncher, recoveredFailures };
  } catch (error) {
    if (!committed) {
      try { await lease?.rollback?.(); }
      catch (rollbackError) { retainReservation = true; throw new Error('Data migration failed and its destination reservation was retained: ' + rollbackError.message); }
      for (const entry of created.reverse()) {
        try { if (entry.directory) await fs.rmdir(entry.path); else if (await stillOwned(entry)) await withWritableOwnedCopy(entry, '清理迁移副本', () => fs.unlink(entry.path), { preserveOnSuccess: false }); }
        catch (cleanupError) { if (!['ENOENT', 'ENOTEMPTY'].includes(cleanupError.storageCode || cleanupError.code)) { error.cleanupFailed = true; retainReservation = true; } }
      }
    }
    throw error.status ? error : storageError(error, { operation: 'migrate_profile', path: target });
  } finally {
    await permissionDirectory?.close();
    if (reserved && !retainReservation) await fs.unlink(marker).catch(() => {});
    // On Linux, an identity/ownership check may have rejected a concurrently
    // created or replaced target. Preserve the empty root instead of deleting
    // a directory whose creation is not proven by the initial existence check.
    if (!committed && !existed && process.platform !== 'linux') await fs.rmdir(target).catch(() => {});
  }
}
