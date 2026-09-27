// Shared by native Linux source tests and the compiled release verifier.
// Each scenario uses fresh fake-data directories and restores its fault hooks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProfileStore } from '../../src/profile-store.js';
import { loadSecrets } from '../../src/secret-store.js';
import { relocateProfileDirectory, resolveDataLocation, DATA_POINTER } from '../../src/data-location.js';

const fakeSecrets = { teacher: 'migration-permission-fixture-only' };

async function isolatedScenario(parentDirectory, action) {
  assert.equal(process.platform, 'linux', 'Directory permission scenarios require native Linux; do not skip them in release acceptance');
  const parent = await fs.realpath(parentDirectory);
  const root = await fs.mkdtemp(path.join(parent, 'class-migration-permissions-'));
  const owned = await fs.lstat(root);
  let failure;
  try {
    const source = path.join(root, 'source'), target = path.join(root, 'target');
    const store = await createProfileStore(source);
    await store.save(store.config, fakeSecrets);
    await fs.writeFile(path.join(source, 'source-evidence.txt'), 'Isolated migration evidence. 测试数据。\n');
    const names = ['profiles.json', 'source-evidence.txt', 'credentials.key', 'credentials.aesgcm.json'];
    const sourceBytes = new Map(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(source, name))])));
    await action({ root, source, target, store, sourceBytes });
  } catch (error) { failure = error; }
  try {
    const info = await fs.lstat(root), actual = await fs.realpath(root);
    assert.equal(info.isSymbolicLink(), false); assert.equal(info.isDirectory(), true);
    assert.equal(info.dev, owned.dev); assert.equal(info.ino, owned.ino);
    assert.equal(actual, root); assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('class-migration-permissions-'));
    await fs.rm(actual, { recursive: true });
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], 'Directory permission scenario and isolated cleanup both failed');
    throw error;
  }
  if (failure) throw failure;
}

const migrate = f => relocateProfileDirectory({ sourceDir: f.source, targetPath: f.target, anchorDir: f.source, config: f.store.config, secrets: f.store.secrets });

async function sourcePreserved(f) {
  for (const [name, bytes] of f.sourceBytes) assert.deepEqual(await fs.readFile(path.join(f.source, name)), bytes, 'Source changed: ' + name);
  assert.deepEqual(await loadSecrets(f.source), fakeSecrets);
}

async function rejectedWithoutPointer(f, expected) {
  await assert.rejects(migrate(f), expected);
  await assert.rejects(fs.lstat(path.join(f.source, DATA_POINTER)), { code: 'ENOENT' });
  assert.equal(resolveDataLocation(f.source).dataDir, f.source);
  await sourcePreserved(f);
}

async function emptyDestination(f, mode = 0o755) {
  await fs.mkdir(f.target, { mode }); await fs.chmod(f.target, mode);
  const before = await fs.lstat(f.target);
  assert.equal(before.mode & 0o777, mode); assert.equal(before.uid, process.geteuid());
  assert.deepEqual(await fs.readdir(f.target), []);
}

async function successfulMigration(parentDirectory, initialMode) {
  await isolatedScenario(parentDirectory, async f => {
    if (initialMode === null) await assert.rejects(fs.lstat(f.target), { code: 'ENOENT' });
    else await emptyDestination(f, initialMode);
    const result = await migrate(f);
    assert.equal(result.dataDir, f.target); assert.equal((await fs.stat(f.target)).mode & 0o777, 0o700);
    assert.deepEqual(result.store.secrets, fakeSecrets); assert.deepEqual(await loadSecrets(f.target), fakeSecrets);
    assert.equal(resolveDataLocation(f.source).dataDir, f.target);
    for (const name of ['credentials.key', 'credentials.aesgcm.json', 'source-evidence.txt']) {
      assert.deepEqual(await fs.readFile(path.join(f.target, name)), f.sourceBytes.get(name));
    }
    for (const name of ['credentials.key', 'credentials.aesgcm.json']) assert.equal((await fs.stat(path.join(f.target, name))).mode & 0o777, 0o600);
    await sourcePreserved(f);
  });
}

// Foreign ownership is simulated stat metadata; no chown or foreign user data.
// Hooks affect only the isolated target's FileHandle. All scenarios run
// sequentially, before the release suite starts its separate Class process.
async function withTargetFault(f, fault, action) {
  const isTarget = filename => typeof filename === 'string' && path.resolve(filename) === f.target;
  const originalOpen = fs.open, originalChmod = fs.chmod, originalCopyFile = fs.copyFile;
  const restoreHandles = [], observed = { ownershipReads: 0, targetChmods: 0, targetCopies: 0 };
  fs.copyFile = async (source, destination, ...args) => {
    if (typeof destination === 'string' && path.resolve(destination).startsWith(f.target + path.sep)) observed.targetCopies++;
    return originalCopyFile(source, destination, ...args);
  };
  fs.chmod = async (filename, ...args) => {
    if (isTarget(filename)) observed.targetChmods++;
    return originalChmod(filename, ...args);
  };
  fs.open = async (filename, ...args) => {
    const handle = await originalOpen(filename, ...args);
    if (isTarget(filename)) {
      const originalStat = handle.stat, originalHandleChmod = handle.chmod;
      restoreHandles.push(() => { handle.stat = originalStat; handle.chmod = originalHandleChmod; });
      handle.stat = async (...statArgs) => {
        const info = await originalStat.apply(handle, statArgs);
        observed.ownershipReads++;
        if (fault === 'foreign-owner') Object.defineProperty(info, 'uid', { value: process.geteuid() === 0 ? 1 : 0, configurable: true });
        return info;
      };
      handle.chmod = async (...modeArgs) => {
        observed.targetChmods++;
        if (fault === 'chmod-error') throw Object.assign(new Error('isolated chmod failure'), { code: 'EPERM' });
        if (fault === 'chmod-noop') return;
        return originalHandleChmod.apply(handle, modeArgs);
      };
    }
    return handle;
  };
  try { await action(observed); }
  finally {
    fs.open = originalOpen; fs.chmod = originalChmod; fs.copyFile = originalCopyFile;
    for (const restore of restoreHandles) restore();
  }
}

async function rejectedTargetFault(parentDirectory, fault) {
  await isolatedScenario(parentDirectory, async f => {
    await emptyDestination(f);
    await withTargetFault(f, fault, async observed => {
      await rejectedWithoutPointer(f, fault === 'foreign-owner' ? /必须属于当前运行用户/ : /无法将目标数据目录权限设置为\s*0700/);
      assert.ok(observed.ownershipReads > 0);
      assert.equal(observed.targetChmods, fault === 'foreign-owner' ? 0 : 1);
      assert.equal(observed.targetCopies, 0);
    });
    assert.equal((await fs.stat(f.target)).mode & 0o777, 0o755);
    assert.deepEqual(await fs.readdir(f.target), []);
  });
}

export const linuxMigrationScenarios = Object.freeze([
  { name: 'existingEmpty0755', description: 'normalizes an existing empty 0755 destination and preserves credentials', run: parent => successfulMigration(parent, 0o755) },
  { name: 'existingEmpty0775', description: 'normalizes an existing empty 0775 destination and preserves credentials', run: parent => successfulMigration(parent, 0o775) },
  { name: 'missingDestination', description: 'creates a missing destination and preserves credentials', run: parent => successfulMigration(parent, null) },
  { name: 'nonemptyDestinationPreserved', description: 'leaves a nonempty destination and its permissions untouched', run: parent => isolatedScenario(parent, async f => {
    await emptyDestination(f);
    const retained = path.join(f.target, 'retained.txt'), bytes = Buffer.from('Unrelated destination fixture.\n');
    await fs.writeFile(retained, bytes, { mode: 0o640 }); const before = await fs.stat(retained);
    await rejectedWithoutPointer(f, { status: 409 });
    assert.equal((await fs.stat(f.target)).mode & 0o777, 0o755);
    assert.deepEqual(await fs.readdir(f.target), ['retained.txt']);
    assert.deepEqual(await fs.readFile(retained), bytes); assert.equal((await fs.stat(retained)).mode, before.mode);
  }) },
  { name: 'symlinkDestinationPreserved', description: 'does not follow or chmod a destination symlink', run: parent => isolatedScenario(parent, async f => {
    const linked = path.join(f.root, 'retained-directory');
    await fs.mkdir(linked); await fs.chmod(linked, 0o755); await fs.symlink(linked, f.target, 'dir');
    await rejectedWithoutPointer(f, { status: 400 });
    assert.equal(await fs.readlink(f.target), linked);
    assert.equal((await fs.stat(linked)).mode & 0o777, 0o755); assert.deepEqual(await fs.readdir(linked), []);
  }) },
  { name: 'foreignOwnerRejected', description: 'rejects a foreign-owner stat before chmod or copying', run: parent => rejectedTargetFault(parent, 'foreign-owner') },
  { name: 'chmodFailureRejected', description: 'rejects a chmod error without copying or publishing a pointer', run: parent => rejectedTargetFault(parent, 'chmod-error') },
  { name: 'chmodNoopRejected', description: 'rejects a chmod that leaves the unsafe mode unchanged', run: parent => rejectedTargetFault(parent, 'chmod-noop') },
]);
