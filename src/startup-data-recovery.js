import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalDataPath, DATA_POINTER, sameDirectory } from './data-location.js';
import { atomicJSON, DEFAULT_SETTINGS } from './profile-store.js';
import { defaultStartupLogDirectory } from './platform-paths.js';
import { loadSecrets } from './secret-store.js';

const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100000;
const MAX_TREE_DEPTH = 64;
const CREDENTIAL_FILES = ['credentials.dpapi.json', 'credentials.aesgcm.json', 'credentials.key'];
const RUNTIME_FILES = new Set(['instance.lock', 'instance.json', 'instance.recovery.lock', DATA_POINTER, 'startup.log', '打开Class.html']);
const LEGACY_FILES = new Set([...RUNTIME_FILES, 'workspace', 'history', 'memory', 'current-run.json', 'memory-deletions.json',
  'data-migration.lock', 'data-migration-committed.json', 'migration-recovery.json', '启动Class.sh', '启动Class.vbs']);
const error = (message, code = 'DATA_RECOVERY_INVALID') => Object.assign(new Error(message), { status: 400, code });

function absolute(value, label = '数据目录') {
  if (typeof value !== 'string' || !value.trim() || value.length > 32768 || value.includes('\0') || !path.isAbsolute(value)) {
    throw error(`${label}必须是绝对目录路径`);
  }
  return path.resolve(value);
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function owner(info) {
  if (process.platform === 'win32') return;
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : process.getuid();
  if (info.uid !== uid) throw error('数据目录和内部记录必须属于当前运行用户');
}

function regular(info, label) {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw error(`${label}必须是没有额外链接的普通文件`);
  owner(info);
}

async function optionalInfo(filename) {
  try { return await fs.lstat(filename); }
  catch (failure) { if (failure.code === 'ENOENT') return null; throw error('数据目录或内部记录无法访问', 'DATA_RECOVERY_UNAVAILABLE'); }
}

async function directoryInfo(directory) {
  const info = await fs.lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw error('数据目录不能包含符号链接或非目录路径');
  owner(info);
  await fs.access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  return info;
}

async function readJSON(filename, label, maximum = MAX_PROFILE_BYTES) {
  const before = await fs.lstat(filename);
  regular(before, label);
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const current = await file.stat();
    regular(current, label);
    if (before.dev !== current.dev || before.ino !== current.ino) throw error(`${label}在读取期间发生变化，请重试`);
    if (current.size > maximum) throw error(`${label}超过允许的大小`);
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maximum) throw error(`${label}超过允许的大小`);
    try { return JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { throw error(`${label}格式损坏；原文件已保留`); }
  } finally { await file.close(); }
}

/** Stable recovery metadata lives outside the unavailable profile. No mkdir. */
export function recoveryAnchorFor(requestedPath) {
  const requested = absolute(requestedPath);
  const configured = process.env.CLASS_STARTUP_STATE_DIR;
  const root = configured === undefined
    ? path.join(path.dirname(defaultStartupLogDirectory()), 'startup')
    : absolute(configured, '启动状态目录');
  return path.join(root, createHash('sha256').update(comparable(requested)).digest('hex'));
}

export async function readRecoverySelection(requestedPath) {
  const anchorDir = canonicalDataPath(recoveryAnchorFor(requestedPath), { allowMissing: true });
  if (!await optionalInfo(anchorDir)) return null;
  await directoryInfo(anchorDir);
  const filename = path.join(anchorDir, DATA_POINTER);
  if (!await optionalInfo(filename)) return null;
  const value = await readJSON(filename, '恢复目录登记', 128 * 1024);
  if (!value || value.version !== 1 || typeof value.dataDir !== 'string' ||
      (value.previousDataDir !== undefined && typeof value.previousDataDir !== 'string')) {
    throw error('恢复目录登记格式无效；原文件已保留');
  }
  const dataDir = absolute(value.dataDir);
  const previousDataDir = value.previousDataDir === undefined ? undefined : absolute(value.previousDataDir);
  return { anchorDir, dataDir, ...(previousDataDir === undefined ? {} : { previousDataDir }) };
}

/** Caller holds the anchor lease and has successfully loaded the selected data. */
export async function publishRecoverySelection(anchorDir, dataDir, previousDataDir) {
  const anchor = canonicalDataPath(absolute(anchorDir)), target = canonicalDataPath(absolute(dataDir));
  await directoryInfo(anchor);
  const filename = path.join(anchor, DATA_POINTER), info = await optionalInfo(filename);
  if (info) regular(info, '恢复目录登记');
  const previous = previousDataDir === undefined ? undefined : absolute(previousDataDir);
  await atomicJSON(filename, { version: 1, dataDir: target, ...(previous === undefined ? {} : { previousDataDir: previous }) });
}

async function inspectInternalTree(directory, budget, depth = 0) {
  if (depth > MAX_TREE_DEPTH) throw error('数据记录目录层级过深，请检查所选目录');
  await directoryInfo(directory);
  const stream = await fs.opendir(directory);
  for await (const entry of stream) {
    if (++budget.entries > MAX_TREE_ENTRIES) throw error('数据记录数量超过本次恢复检查上限，请检查所选目录');
    const filename = path.join(directory, entry.name), info = await fs.lstat(filename);
    if (info.isSymbolicLink()) throw error('历史记录和记忆目录不能包含符号链接');
    if (info.isDirectory()) await inspectInternalTree(filename, budget, depth + 1);
    else {
      regular(info, '历史记录和记忆文件');
      await fs.access(filename, constants.R_OK | constants.W_OK);
    }
  }
}

async function movedWorkspace(dataDir, config, previousDataDir) {
  if (previousDataDir === undefined || !config) return undefined;
  const previous = absolute(previousDataDir), oldWorkspace = path.join(previous, 'workspace');
  const configured = absolute(config.settings.cwd, '工作目录');
  if (sameDirectory(previous, dataDir)) return undefined;
  const relative = path.relative(comparable(oldWorkspace), comparable(configured));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return undefined;
  try { await fs.access(configured, constants.R_OK | constants.W_OK | constants.X_OK); return undefined; }
  catch { /* Only an unavailable workspace inside the former profile is moved. */ }
  // Preserve the original spelling after the case-insensitive containment check.
  const suffix = path.relative(oldWorkspace, configured), candidate = path.join(dataDir, 'workspace', suffix);
  try {
    const mapped = canonicalDataPath(candidate);
    await directoryInfo(mapped);
    return mapped;
  } catch { return undefined; }
}

async function unconfiguredClassDirectory(dataDir, entries) {
  // Older first launches did not save profiles.json until settings or an Agent
  // were saved. A demo could already have produced history and memory records.
  // Recognize that precise layout; a missing profile alongside credentials is
  // incomplete data, never an invitation to reset the saved Agent configuration.
  if (entries.some(name => !LEGACY_FILES.has(name)) || CREDENTIAL_FILES.some(name => entries.includes(name))) return false;
  for (const name of ['workspace', 'history', 'memory']) {
    const info = await optionalInfo(path.join(dataDir, name));
    if (!info?.isDirectory() || info.isSymbolicLink()) return false;
  }
  const filename = path.join(dataDir, 'memory', 'memory.sqlite'), info = await optionalInfo(filename);
  if (!info) return false;
  regular(info, '记忆数据库');
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const current = await file.stat(); regular(current, '记忆数据库');
    if (info.dev !== current.dev || info.ino !== current.ino) throw error('记忆数据库在读取期间发生变化，请重试');
    const header = Buffer.alloc(16);
    let length = 0;
    while (length < header.length) {
      const result = await file.read(header, length, header.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    return length === 16 && header.equals(Buffer.from('SQLite format 3\0'));
  } finally { await file.close(); }
}

/** Validate an existing profile without initializing, copying, or changing it. */
export async function validateRecoveryDirectory(target, { allowCreate = false, allowEmpty = false, emptyLease, previousDataDir } = {}) {
  const dataDir = canonicalDataPath(absolute(target), { allowMissing: allowCreate });
  const root = await optionalInfo(dataDir);
  if (!root) {
    if (!allowCreate) throw error('所选数据目录不存在', 'DATA_RECOVERY_UNAVAILABLE');
    let parent = path.dirname(dataDir);
    while (!await optionalInfo(parent)) parent = path.dirname(parent);
    await fs.access(parent, constants.W_OK | constants.X_OK);
    return { dataDir, missing: true };
  }
  await directoryInfo(dataDir);
  const entries = await fs.readdir(dataDir), budget = { entries: entries.length };
  // A custom empty directory is admitted before taking its lease. Afterward,
  // only that exact directory and our own lock may remain; runtime-looking
  // files from another directory are not evidence of an empty selection.
  if (emptyLease) {
    if (root.dev !== emptyLease.dev || root.ino !== emptyLease.ino || entries.length !== 1 || entries[0] !== 'instance.lock') {
      throw error('所选空目录在初始化前发生变化；原文件已保留，请重新选择');
    }
    if (process.platform === 'linux' && (root.mode & 0o777) !== 0o700) {
      throw error('所选空目录权限在初始化前发生变化，Linux 数据目录权限必须为 0700');
    }
    const lock = await readJSON(path.join(dataDir, 'instance.lock'), '数据目录锁');
    if (emptyLease.pid !== process.pid || lock.pid !== emptyLease.pid || !emptyLease.instanceId || lock.instanceId !== emptyLease.instanceId) {
      throw error('所选空目录不再由当前 Class 独占，请重新选择');
    }
    return { dataDir, missing: false, empty: true };
  }
  if (allowEmpty && entries.length === 0) {
    return { dataDir, missing: false, empty: true, identity: { dev: root.dev, ino: root.ino } };
  }
  if (entries.length > MAX_TREE_ENTRIES) throw error('数据目录文件数量超过本次恢复检查上限');
  for (const name of entries) {
    const filename = path.join(dataDir, name), info = await fs.lstat(filename);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw error('数据目录不能包含符号链接或特殊文件');
    if (name === 'history' || name === 'memory') {
      if (!info.isDirectory()) throw error('历史记录和记忆路径必须是目录');
      await inspectInternalTree(filename, budget);
    } else if (name === 'workspace') {
      if (!info.isDirectory()) throw error('工作目录路径必须是目录');
      await directoryInfo(filename);
    } else if (info.isFile()) {
      regular(info, '数据目录记录');
    }
  }
  const profile = path.join(dataDir, 'profiles.json'), profileInfo = await optionalInfo(profile);
  if (!profileInfo) {
    if (await unconfiguredClassDirectory(dataDir, entries)) {
      await loadSecrets(dataDir);
      return { dataDir, missing: false, unconfigured: true };
    }
    if (!allowCreate || entries.some(name => !RUNTIME_FILES.has(name))) {
      throw error('所选目录缺少 profiles.json，不能确认是完整的 Class 数据目录；原文件已保留');
    }
    return { dataDir, missing: false, empty: true };
  }
  const config = await readJSON(profile, 'Agent 配置');
  if (!config || config.version !== 1 || !Array.isArray(config.agents) || config.agents.length > 17 ||
      !config.settings || typeof config.settings !== 'object' || Array.isArray(config.settings) ||
      typeof config.settings.cwd !== 'string' || !path.isAbsolute(config.settings.cwd)) {
    throw error('保存的 Agent 配置格式无效；原文件已保留');
  }
  for (const name of CREDENTIAL_FILES) {
    const info = await optionalInfo(path.join(dataDir, name));
    if (info) regular(info, '凭据文件');
  }
  // Existing credential protection remains authoritative, including platform,
  // ownership, Linux permissions and authentication of the encrypted payload.
  await loadSecrets(dataDir);
  const workspaceOverride = await movedWorkspace(dataDir, config, previousDataDir);
  return { dataDir, missing: false, ...(workspaceOverride === undefined ? {} : { workspaceOverride }) };
}

/** Publish initial settings exclusively; normal startup creates the stores and
 * workspace. No credentials exist yet, and no existing file is overwritten. */
export async function initializeEmptyRecoveryDirectory(target, emptyLease) {
  if (!emptyLease) throw error('初始化空目录前必须取得当前 Class 的目录锁');
  const { dataDir } = await validateRecoveryDirectory(target, { emptyLease });
  await atomicJSON(path.join(dataDir, 'profiles.json'), {
    version: 1, agents: [], settings: { ...DEFAULT_SETTINGS, cwd: path.join(dataDir, 'workspace') },
  }, { overwrite: false });
}
