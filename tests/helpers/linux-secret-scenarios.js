// Shared native Linux scenarios for source tests and the standalone verifier.
// Every invocation owns one fresh temporary directory containing fake secrets.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSecrets, saveSecrets } from '../../src/secret-store.js';
import { loadLinuxSecrets, saveLinuxSecrets, LINUX_CREDENTIALS_FILE, LINUX_KEY_FILE } from '../../src/linux-secret-store.js';

const sample = { teacher: 'local-fixture-secret-only', student: '测试密钥，不是真实凭据' };

async function isolatedScenario(parentDirectory, action) {
  assert.equal(process.platform, 'linux', 'Credential scenarios require native Linux; they must not be skipped or emulated');
  const parent = await fs.realpath(parentDirectory);
  const root = await fs.mkdtemp(path.join(parent, 'class-secret-scenario-'));
  const owned = await fs.lstat(root);
  let failure;
  try {
    await action({ root, key: path.join(root, LINUX_KEY_FILE), ciphertext: path.join(root, LINUX_CREDENTIALS_FILE) });
  } catch (error) { failure = error; }
  try {
    const info = await fs.lstat(root), actual = await fs.realpath(root);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.isDirectory(), true);
    assert.equal(info.dev, owned.dev); assert.equal(info.ino, owned.ino);
    assert.equal(actual, root); assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('class-secret-scenario-'));
    await fs.rm(actual, { recursive: true });
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], 'Credential scenario and isolated cleanup both failed');
    throw error;
  }
  if (failure) throw failure;
}

export async function verifyConcurrentInitialCredentialSaves(parentDirectory) {
  await isolatedScenario(parentDirectory, async f => {
    // Wait for all writers even on failure before removing their directory.
    const saved = await Promise.allSettled(Array.from({ length: 12 }, async () => {
      await saveLinuxSecrets(f.root, sample);
      return fs.readFile(f.key);
    }));
    for (const result of saved) assert.equal(result.status, 'fulfilled', result.reason?.stack);
    assert.deepEqual(await loadLinuxSecrets(f.root), sample);
    const key = await fs.readFile(f.key);
    assert.equal(key.length, 32); assert.equal((await fs.stat(f.key)).nlink, 1);
    for (const result of saved) assert.deepEqual(result.value, key, 'Concurrent writers must observe the same complete key');
    assert.deepEqual((await fs.readdir(f.root)).sort(), [LINUX_CREDENTIALS_FILE, LINUX_KEY_FILE].sort());
  });
}

export async function verifyUnsafeCredentialPermissions(parentDirectory) {
  await isolatedScenario(parentDirectory, async f => {
    await saveSecrets(f.root, sample);
    assert.equal((await fs.stat(f.root)).mode & 0o777, 0o700);
    for (const filename of [f.key, f.ciphertext]) {
      assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
      const before = await fs.readFile(filename);
      await fs.chmod(filename, 0o644);
      await assert.rejects(loadSecrets(f.root), { code: 'CREDENTIALS_UNSAFE_PERMISSIONS' });
      await assert.rejects(saveSecrets(f.root, sample), { code: 'CREDENTIALS_UNSAFE_PERMISSIONS' });
      assert.equal((await fs.stat(filename)).mode & 0o777, 0o644);
      assert.deepEqual(await fs.readFile(filename), before);
      await fs.chmod(filename, 0o600);
    }
    await fs.chmod(f.root, 0o755);
    await assert.rejects(loadSecrets(f.root), { code: 'CREDENTIALS_UNSAFE_PERMISSIONS' });
    await assert.rejects(saveSecrets(f.root, sample), { code: 'CREDENTIALS_UNSAFE_PERMISSIONS' });
    assert.equal((await fs.stat(f.root)).mode & 0o777, 0o755);
  });
}

export async function verifyCredentialSymlinkRejection(parentDirectory) {
  await isolatedScenario(parentDirectory, async f => {
    await saveSecrets(f.root, sample);
    for (const filename of [f.key, f.ciphertext]) {
      const target = filename + '.retained';
      await fs.rename(filename, target);
      const before = await fs.readFile(target);
      await fs.symlink(target, filename);
      await assert.rejects(loadSecrets(f.root), { code: 'CREDENTIALS_UNSAFE_FILE' });
      await assert.rejects(saveSecrets(f.root, sample), { code: 'CREDENTIALS_UNSAFE_FILE' });
      assert.deepEqual(await fs.readFile(target), before);
      assert.equal(await fs.readlink(filename), target);
      await fs.unlink(filename); await fs.rename(target, filename);
    }
  });
}
