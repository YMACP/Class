import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recoveryAnchorFor, readRecoverySelection, publishRecoverySelection, validateRecoveryDirectory, initializeEmptyRecoveryDirectory } from '../src/startup-data-recovery.js';

async function scratch(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, 'class-startup-recovery-'));
  await fs.chmod(root, 0o700);
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), temporary);
    assert.ok(path.basename(resolved).startsWith('class-startup-recovery-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return root;
}

function isolatedRegistry(t, root) {
  const previous = process.env.CLASS_STARTUP_STATE_DIR;
  process.env.CLASS_STARTUP_STATE_DIR = path.join(root, 'startup-state');
  t.after(() => {
    if (previous === undefined) delete process.env.CLASS_STARTUP_STATE_DIR;
    else process.env.CLASS_STARTUP_STATE_DIR = previous;
  });
}

async function profile(directory, { cwd = path.join(directory, 'workspace') } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await fs.mkdir(path.join(directory, 'workspace'), { mode: 0o700 });
  const config = { version: 1, agents: [], settings: { cwd } };
  await fs.writeFile(path.join(directory, 'profiles.json'), JSON.stringify(config), { mode: 0o600 });
  return config;
}

async function legacyLayout(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  for (const name of ['workspace', 'history', 'memory']) await fs.mkdir(path.join(directory, name), { mode: 0o700 });
  // A recognition fixture only. Runtime acceptance separately opens real SQLite.
  await fs.writeFile(path.join(directory, 'memory', 'memory.sqlite'), Buffer.from('SQLite format 3\0header-recognition-fixture'), { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'history', 'run-demo.json'), '{"fixture":"existing history"}', { mode: 0o600 });
}

async function imageOf(directory) {
  const result = {};
  async function walk(current, relative = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const item = path.join(current, entry.name), name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(item, name);
      else if (entry.isSymbolicLink()) result[name] = 'link:' + await fs.readlink(item);
      else result[name] = (await fs.readFile(item)).toString('base64');
    }
  }
  await walk(directory);
  return result;
}

async function emptySelection(directory) {
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const selected = await validateRecoveryDirectory(directory, { allowEmpty: true });
  const lease = { ...selected.identity, pid: process.pid, instanceId: 'owned-empty-recovery-fixture' };
  await fs.writeFile(path.join(directory, 'instance.lock'), JSON.stringify({ pid: lease.pid, instanceId: lease.instanceId }), { flag: 'wx', mode: 0o600 });
  return lease;
}

test('recovery registration is independent and never follows a selected profile pointer', async t => {
  const root = await scratch(t); isolatedRegistry(t, root);
  const requested = path.join(root, 'missing-original'), target = path.join(root, 'moved-profile');
  await profile(target);
  const before = await imageOf(target);
  await fs.writeFile(path.join(target, 'data-location.json'), JSON.stringify({ version: 1, dataDir: path.join(root, 'unrelated-missing') }));
  const anchor = recoveryAnchorFor(requested);
  assert.equal(path.dirname(anchor), process.env.CLASS_STARTUP_STATE_DIR);
  assert.match(path.basename(anchor), /^[a-f0-9]{64}$/);
  assert.equal(await readRecoverySelection(requested), null);
  await assert.rejects(fs.stat(process.env.CLASS_STARTUP_STATE_DIR), { code: 'ENOENT' });
  await fs.mkdir(anchor, { recursive: true, mode: 0o700 });
  await publishRecoverySelection(anchor, target, requested);
  assert.deepEqual(await readRecoverySelection(requested), { anchorDir: anchor, dataDir: target, previousDataDir: requested });
  const checked = await validateRecoveryDirectory(target);
  assert.equal(checked.dataDir, target);
  assert.equal((await imageOf(target))['profiles.json'], before['profiles.json']);
  await assert.rejects(fs.stat(requested), { code: 'ENOENT' });
});

test('registry override requires an absolute path', async t => {
  const root = await scratch(t); isolatedRegistry(t, root);
  process.env.CLASS_STARTUP_STATE_DIR = 'relative-startup-state';
  assert.throws(() => recoveryAnchorFor(path.join(root, 'profile')), /绝对/);
});

test('missing existing data is rejected while default validation does not create directories', async t => {
  const root = await scratch(t), missing = path.join(root, 'missing', 'profile');
  await assert.rejects(validateRecoveryDirectory(missing), /does not exist|不存在/);
  assert.deepEqual(await validateRecoveryDirectory(missing, { allowCreate: true }), { dataDir: missing, missing: true });
  await assert.rejects(fs.stat(path.join(root, 'missing')), { code: 'ENOENT' });
  const empty = path.join(root, 'empty'); await fs.mkdir(empty, { mode: 0o700 });
  await assert.rejects(validateRecoveryDirectory(empty), /profiles.json/);
  assert.deepEqual(await validateRecoveryDirectory(empty, { allowCreate: true }), { dataDir: empty, missing: false, empty: true });
  assert.deepEqual(await fs.readdir(empty), []);
});

test('custom recovery admits an existing empty directory without creating a missing selection', async t => {
  const root = await scratch(t), target = path.join(root, 'empty'), missing = path.join(root, 'missing');
  await assert.rejects(validateRecoveryDirectory(missing, { allowEmpty: true }), /does not exist|不存在/);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  await fs.mkdir(target, { mode: 0o700 });
  const info = await fs.stat(target);
  assert.deepEqual(await validateRecoveryDirectory(target, { allowEmpty: true }), {
    dataDir: target, missing: false, empty: true, identity: { dev: info.dev, ino: info.ino },
  });
  assert.deepEqual(await fs.readdir(target), []);
  // Admission of an empty selection must not weaken the ordinary loader.
  await assert.rejects(validateRecoveryDirectory(target), /profiles.json/);
  const existing = path.join(root, 'existing'); await profile(existing);
  const before = await imageOf(existing);
  assert.deepEqual(await validateRecoveryDirectory(existing, { allowEmpty: true }), { dataDir: existing, missing: false });
  assert.deepEqual(await imageOf(existing), before);
});

test('custom empty recovery rejects runtime-only, unrelated and incomplete directories', async t => {
  const root = await scratch(t);
  for (const name of ['instance.lock', 'instance.json', 'startup.log', 'data-location.json', 'unknown.txt', 'workspace', 'credentials.key', 'credentials.aesgcm.json', 'credentials.dpapi.json', 'profiles.json']) {
    await t.test(name, async () => {
      const target = path.join(root, 'case-' + name); await fs.mkdir(target, { mode: 0o700 });
      if (name === 'workspace') await fs.mkdir(path.join(target, name), { mode: 0o700 });
      else await fs.writeFile(path.join(target, name), name === 'profiles.json' ? '{invalid-profile' : 'preserve-this-fixture', { mode: 0o600 });
      const before = await imageOf(target), entries = await fs.readdir(target);
      await assert.rejects(validateRecoveryDirectory(target, { allowEmpty: true }), /profiles.json|格式损坏/);
      assert.deepEqual(await imageOf(target), before);
      assert.deepEqual(await fs.readdir(target), entries);
    });
  }
});

test('owned empty recovery publishes only initial settings and leaves credentials and registry untouched', async t => {
  const root = await scratch(t); isolatedRegistry(t, root);
  const target = path.join(root, 'selected'), requested = path.join(root, 'unavailable-original');
  const lease = await emptySelection(target), lock = await fs.readFile(path.join(target, 'instance.lock'));
  assert.deepEqual(await validateRecoveryDirectory(target, { emptyLease: lease }), { dataDir: target, missing: false, empty: true });
  await initializeEmptyRecoveryDirectory(target, lease);
  const config = JSON.parse(await fs.readFile(path.join(target, 'profiles.json'), 'utf8'));
  assert.equal(config.version, 1);
  assert.deepEqual(config.agents, []);
  assert.equal(config.settings.cwd, path.join(target, 'workspace'));
  assert.equal(config.settings.allowShell, true);
  assert.equal(config.settings.taskTimeoutMs, null);
  assert.deepEqual((await fs.readdir(target)).sort(), ['instance.lock', 'profiles.json']);
  assert.deepEqual(await fs.readFile(path.join(target, 'instance.lock')), lock);
  if (process.platform === 'linux') {
    assert.equal((await fs.stat(target)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(target, 'profiles.json'))).mode & 0o777, 0o600);
  }
  assert.equal(await readRecoverySelection(requested), null, 'only successful application startup may publish the remembered path');
  await assert.rejects(fs.stat(process.env.CLASS_STARTUP_STATE_DIR), { code: 'ENOENT' });
});

test('empty recovery rechecks Linux permissions before publishing settings', { skip: process.platform !== 'linux' }, async t => {
  const root = await scratch(t), target = path.join(root, 'selected'), lease = await emptySelection(target);
  await fs.chmod(target, 0o755);
  const before = await imageOf(target);
  await assert.rejects(initializeEmptyRecoveryDirectory(target, lease), /0700/);
  assert.deepEqual(await imageOf(target), before);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
});

test('empty recovery rejects missing, mismatched or foreign leases without writing settings', async t => {
  const root = await scratch(t);
  for (const kind of ['missing-lease', 'different-instance', 'foreign-pid', 'different-lock', 'missing-lock']) await t.test(kind, async () => {
    const target = path.join(root, kind), lease = await emptySelection(target);
    let provided = { ...lease };
    if (kind === 'missing-lease') provided = undefined;
    if (kind === 'different-instance') provided.instanceId = 'different-fixture-instance';
    if (kind === 'foreign-pid') provided.pid = process.pid + 1;
    if (kind === 'different-lock') await fs.writeFile(path.join(target, 'instance.lock'), JSON.stringify({ pid: process.pid, instanceId: 'another-lock-owner' }));
    if (kind === 'missing-lock') await fs.unlink(path.join(target, 'instance.lock'));
    const before = await imageOf(target);
    await assert.rejects(initializeEmptyRecoveryDirectory(target, provided), /目录锁|独占|发生变化/);
    assert.deepEqual(await imageOf(target), before);
    await assert.rejects(fs.stat(path.join(target, 'profiles.json')), { code: 'ENOENT' });
  });
});

test('empty recovery rejects a replaced directory even when its copied lock claims the same instance', async t => {
  const root = await scratch(t), target = path.join(root, 'selected'), moved = path.join(root, 'original-selected');
  const lease = await emptySelection(target), original = await imageOf(target);
  assert.equal(path.dirname(target), root); assert.equal(path.dirname(moved), root);
  await fs.rename(target, moved);
  await fs.mkdir(target, { mode: 0o700 });
  await fs.writeFile(path.join(target, 'instance.lock'), JSON.stringify({ pid: lease.pid, instanceId: lease.instanceId }), { mode: 0o600 });
  assert.notEqual((await fs.stat(target)).ino, lease.ino);
  const replacement = await imageOf(target);
  await assert.rejects(initializeEmptyRecoveryDirectory(target, lease), /发生变化/);
  assert.deepEqual(await imageOf(target), replacement);
  assert.deepEqual(await imageOf(moved), original);
});

test('empty recovery rejects files inserted after selection and preserves their contents', async t => {
  const root = await scratch(t);
  for (const name of ['preserved.txt', 'startup.log', 'credentials.key', 'profiles.json', 'workspace']) await t.test(name, async () => {
    const target = path.join(root, 'case-' + name), lease = await emptySelection(target);
    if (name === 'workspace') await fs.mkdir(path.join(target, name));
    else await fs.writeFile(path.join(target, name), 'preserved-concurrent-content', { mode: 0o600 });
    const before = await imageOf(target), entries = await fs.readdir(target);
    await assert.rejects(initializeEmptyRecoveryDirectory(target, lease), /发生变化/);
    assert.deepEqual(await imageOf(target), before);
    assert.deepEqual(await fs.readdir(target), entries);
  });
});

test('exclusive empty-profile publication cannot overwrite a profile inserted at the commit boundary', async t => {
  const root = await scratch(t), target = path.join(root, 'selected'), lease = await emptySelection(target);
  const filename = path.join(target, 'profiles.json'), raced = '{"fixture":"preserve concurrent profile"}';
  const originalLink = fs.link;
  let publications = 0;
  t.mock.method(fs, 'link', async (from, to) => {
    if (to === filename) {
      publications++;
      await fs.writeFile(filename, raced, { flag: 'wx', mode: 0o600 });
    }
    return originalLink(from, to);
  });
  await assert.rejects(initializeEmptyRecoveryDirectory(target, lease), /EEXIST|already exists/);
  assert.equal(publications, 1);
  assert.equal(await fs.readFile(filename, 'utf8'), raced);
  assert.deepEqual((await fs.readdir(target)).sort(), ['instance.lock', 'profiles.json']);
});

test('an interrupted initial-profile write leaves no partial profile or temporary file', async t => {
  const root = await scratch(t), target = path.join(root, 'selected'), lease = await emptySelection(target);
  const prefix = path.join(target, 'profiles.json.'), originalOpen = fs.open, before = await imageOf(target);
  let interrupted = false;
  t.mock.method(fs, 'open', async (filename, ...args) => {
    const file = await originalOpen(filename, ...args);
    if (typeof filename === 'string' && filename.startsWith(prefix) && filename.endsWith('.tmp')) {
      const write = file.writeFile.bind(file);
      file.writeFile = async () => {
        await write('{"partial":'); interrupted = true;
        throw Object.assign(new Error('isolated initial profile write failure'), { code: 'ENOSPC' });
      };
    }
    return file;
  });
  await assert.rejects(initializeEmptyRecoveryDirectory(target, lease), /isolated initial profile write failure/);
  assert.equal(interrupted, true);
  assert.deepEqual(await imageOf(target), before);
  assert.deepEqual(await fs.readdir(target), ['instance.lock']);
});

test('moved built-in workspace is remapped only when its old path is unavailable', async t => {
  const root = await scratch(t), old = path.join(root, 'previous'), target = path.join(root, 'moved');
  await profile(target, { cwd: path.join(old, 'workspace', 'nested') });
  await fs.mkdir(path.join(target, 'workspace', 'nested'));
  const before = await imageOf(target);
  assert.deepEqual(await validateRecoveryDirectory(target, { previousDataDir: old }), {
    dataDir: target, missing: false, workspaceOverride: path.join(target, 'workspace', 'nested'),
  });
  assert.deepEqual(await imageOf(target), before);
  await fs.mkdir(path.join(old, 'workspace', 'nested'), { recursive: true });
  assert.equal((await validateRecoveryDirectory(target, { previousDataDir: old })).workspaceOverride, undefined);
});

test('a missing custom workspace is not silently replaced with the profile workspace', async t => {
  const root = await scratch(t), old = path.join(root, 'previous'), target = path.join(root, 'moved');
  await profile(target, { cwd: path.join(root, 'custom-workspace') });
  assert.equal((await validateRecoveryDirectory(target, { previousDataDir: old })).workspaceOverride, undefined);
});

test('damaged profiles and credential envelopes are rejected without overwriting their bytes', async t => {
  const root = await scratch(t), target = path.join(root, 'profile'); await profile(target);
  const filename = path.join(target, 'profiles.json'), original = await fs.readFile(filename);
  const sensitive = 'private-fixture-content';
  await fs.writeFile(filename, '{invalid-' + sensitive);
  const brokenProfile = await imageOf(target);
  await assert.rejects(validateRecoveryDirectory(target), failure => {
    assert.match(failure.message, /格式损坏/); assert.ok(!failure.message.includes(sensitive)); return true;
  });
  assert.deepEqual(await imageOf(target), brokenProfile);
  await fs.writeFile(filename, original);
  const credentials = process.platform === 'linux' ? 'credentials.aesgcm.json' : 'credentials.dpapi.json';
  await fs.writeFile(path.join(target, credentials), '{invalid-' + sensitive, { mode: 0o600 });
  const brokenCredentials = await imageOf(target);
  await assert.rejects(validateRecoveryDirectory(target), failure => {
    assert.ok(!failure.message.includes(sensitive)); return true;
  });
  assert.deepEqual(await imageOf(target), brokenCredentials);
});

test('a Linux encrypted profile with a missing key is preserved and cannot become an empty profile', { skip: process.platform !== 'linux' }, async t => {
  const root = await scratch(t), target = path.join(root, 'profile'); await profile(target);
  await fs.writeFile(path.join(target, 'credentials.aesgcm.json'), JSON.stringify({
    version: 1, protection: 'local-key-aes-256-gcm', nonce: Buffer.alloc(12).toString('base64'),
    tag: Buffer.alloc(16).toString('base64'), blob: Buffer.from('isolated-ciphertext-fixture').toString('base64'),
  }), { mode: 0o600 });
  const before = await imageOf(target);
  await assert.rejects(validateRecoveryDirectory(target), { code: 'CREDENTIALS_KEY_MISSING' });
  assert.deepEqual(await imageOf(target), before);
});

test('recovery rejects linked profile roots and internal history but permits workspace contents', async t => {
  const root = await scratch(t), target = path.join(root, 'profile'), outside = path.join(root, 'outside');
  await profile(target); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'preserved.txt'), 'outside fixture');
  const alias = path.join(root, 'alias');
  await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateRecoveryDirectory(alias), /symbolic links|junctions/);
  await fs.symlink(outside, path.join(target, 'workspace', 'allowed-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await validateRecoveryDirectory(target)).dataDir, target);
  await fs.mkdir(path.join(target, 'history'));
  await fs.symlink(outside, path.join(target, 'history', 'unsafe-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateRecoveryDirectory(target), /符号链接/);
  assert.equal(await fs.readFile(path.join(outside, 'preserved.txt'), 'utf8'), 'outside fixture');
});

test('legacy unconfigured Class layout recognition uses the SQLite header and preserves demo history', async t => {
  const root = await scratch(t), target = path.join(root, 'legacy'); await legacyLayout(target);
  const before = await imageOf(target);
  assert.deepEqual(await validateRecoveryDirectory(target), { dataDir: target, missing: false, unconfigured: true });
  assert.deepEqual(await validateRecoveryDirectory(target, { allowCreate: true }), { dataDir: target, missing: false, unconfigured: true });
  assert.deepEqual(await imageOf(target), before);
  await assert.rejects(fs.stat(path.join(target, 'profiles.json')), { code: 'ENOENT' });
});

test('legacy recognition rejects an unknown root directory, missing SQLite header, or credentials without profiles', async t => {
  const root = await scratch(t);
  for (const kind of ['unrelated', 'header', 'credentials']) {
    const target = path.join(root, kind); await legacyLayout(target);
    if (kind === 'unrelated') await fs.mkdir(path.join(target, 'unrelated-personal-files'));
    if (kind === 'header') await fs.writeFile(path.join(target, 'memory', 'memory.sqlite'), 'not a sqlite header');
    if (kind === 'credentials') await fs.writeFile(path.join(target, 'credentials.key'), Buffer.alloc(32), { mode: 0o600 });
    const before = await imageOf(target);
    await assert.rejects(validateRecoveryDirectory(target, { allowCreate: true }), /profiles.json/);
    assert.deepEqual(await imageOf(target), before);
  }
});

test('failed recovery pointer publication preserves the last successful registration and target data', async t => {
  const root = await scratch(t); isolatedRegistry(t, root);
  const requested = path.join(root, 'old'), first = path.join(root, 'first'), second = path.join(root, 'second');
  await profile(first); await profile(second);
  const anchor = recoveryAnchorFor(requested); await fs.mkdir(anchor, { recursive: true, mode: 0o700 });
  await publishRecoverySelection(anchor, first, requested);
  const pointer = path.join(anchor, 'data-location.json'), previous = await fs.readFile(pointer), before = await imageOf(second);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === pointer) throw Object.assign(new Error('isolated pointer publication failure'), { code: 'EACCES' });
    return rename(from, to);
  });
  await assert.rejects(publishRecoverySelection(anchor, second, requested), /isolated pointer publication failure/);
  assert.deepEqual(await fs.readFile(pointer), previous);
  assert.deepEqual(await imageOf(second), before);
  assert.equal((await readRecoverySelection(requested)).dataDir, first);
  assert.deepEqual(await fs.readdir(anchor), ['data-location.json']);
});

test('damaged and multiply linked recovery registrations are not silently discarded or overwritten', async t => {
  const root = await scratch(t); isolatedRegistry(t, root);
  const requested = path.join(root, 'old'), target = path.join(root, 'profile'); await profile(target);
  const anchor = recoveryAnchorFor(requested); await fs.mkdir(anchor, { recursive: true, mode: 0o700 });
  const pointer = path.join(anchor, 'data-location.json'), linked = path.join(root, 'registration-copy');
  await fs.writeFile(pointer, '{damaged-fixture');
  await assert.rejects(readRecoverySelection(requested), /格式损坏/);
  assert.equal(await fs.readFile(pointer, 'utf8'), '{damaged-fixture');
  await fs.link(pointer, linked);
  await assert.rejects(publishRecoverySelection(anchor, target, requested), /额外链接/);
  await assert.rejects(readRecoverySelection(requested), /额外链接/);
  assert.equal(await fs.readFile(linked, 'utf8'), '{damaged-fixture');
});
