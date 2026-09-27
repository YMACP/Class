import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadSecrets, saveSecrets } from '../src/secret-store.js';
import { loadLinuxSecrets, saveLinuxSecrets, LINUX_CREDENTIALS_FILE, LINUX_KEY_FILE } from '../src/linux-secret-store.js';
import { createProfileStore } from '../src/profile-store.js';
import { relocateProfileDirectory, resolveDataLocation } from '../src/data-location.js';
import { verifyConcurrentInitialCredentialSaves, verifyUnsafeCredentialPermissions, verifyCredentialSymlinkRejection } from './helpers/linux-secret-scenarios.js';

const sample = { teacher: 'local-fixture-secret-only', student: '测试密钥，不是真实凭据' };
const linuxOnly = { skip: process.platform !== 'linux' ? 'Requires native Linux ownership and permission semantics' : false };

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-secret-test-'));
  t.after(async () => {
    const actual = await fs.realpath(root);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('class-secret-test-'));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(actual, { recursive: true, force: true });
  });
  return { root, ciphertext: path.join(root, LINUX_CREDENTIALS_FILE), key: path.join(root, LINUX_KEY_FILE) };
}

test('Linux local-key credentials survive rereading and do not persist API key plaintext', async t => {
  const f = await fixture(t);
  assert.deepEqual(await loadLinuxSecrets(f.root), {});
  await saveLinuxSecrets(f.root, sample);
  assert.deepEqual(await loadLinuxSecrets(f.root), sample);
  const first = JSON.parse(await fs.readFile(f.ciphertext, 'utf8')), key = await fs.readFile(f.key);
  assert.equal(key.length, 32); assert.equal(first.version, 1); assert.equal(first.protection, 'local-key-aes-256-gcm');
  assert.equal(Buffer.from(first.nonce, 'base64').length, 12); assert.equal(Buffer.from(first.tag, 'base64').length, 16);
  assert.equal((await fs.readFile(f.ciphertext, 'utf8')).includes(sample.teacher), false);
  await saveLinuxSecrets(f.root, sample);
  const second = JSON.parse(await fs.readFile(f.ciphertext, 'utf8'));
  assert.notEqual(second.nonce, first.nonce); assert.notEqual(second.blob, first.blob);
  assert.deepEqual(await fs.readFile(f.key), key); assert.deepEqual(await loadLinuxSecrets(f.root), sample);
  assert.deepEqual((await fs.readdir(f.root)).sort(), [LINUX_CREDENTIALS_FILE, LINUX_KEY_FILE].sort());
});

test('concurrent first saves publish one complete key without rotating it', linuxOnly, async () => {
  await verifyConcurrentInitialCredentialSaves(os.tmpdir());
});

test('tampered ciphertext is rejected and cannot be overwritten by a later save', async t => {
  const f = await fixture(t); await saveLinuxSecrets(f.root, sample);
  const key = await fs.readFile(f.key), envelope = JSON.parse(await fs.readFile(f.ciphertext, 'utf8'));
  const bytes = Buffer.from(envelope.blob, 'base64'); bytes[0] ^= 1; envelope.blob = bytes.toString('base64');
  const corrupted = JSON.stringify(envelope); await fs.writeFile(f.ciphertext, corrupted);
  await assert.rejects(loadLinuxSecrets(f.root), { code: 'CREDENTIALS_AUTHENTICATION_FAILED' });
  await assert.rejects(saveLinuxSecrets(f.root, { teacher: 'replacement-fixture' }), { code: 'CREDENTIALS_AUTHENTICATION_FAILED' });
  assert.equal(await fs.readFile(f.ciphertext, 'utf8'), corrupted); assert.deepEqual(await fs.readFile(f.key), key);
});

test('a missing key cannot be regenerated over existing ciphertext', async t => {
  const f = await fixture(t); await saveLinuxSecrets(f.root, sample);
  const ciphertext = await fs.readFile(f.ciphertext); await fs.unlink(f.key);
  await assert.rejects(loadLinuxSecrets(f.root), { code: 'CREDENTIALS_KEY_MISSING' });
  await assert.rejects(saveLinuxSecrets(f.root, sample), { code: 'CREDENTIALS_KEY_MISSING' });
  await assert.rejects(fs.stat(f.key), { code: 'ENOENT' }); assert.deepEqual(await fs.readFile(f.ciphertext), ciphertext);
});

test('wrong and truncated keys fail closed without replacing ciphertext', async t => {
  const f = await fixture(t); await saveLinuxSecrets(f.root, sample);
  const ciphertext = await fs.readFile(f.ciphertext);
  await fs.writeFile(f.key, randomBytes(32));
  await assert.rejects(loadLinuxSecrets(f.root), { code: 'CREDENTIALS_AUTHENTICATION_FAILED' });
  await assert.rejects(saveLinuxSecrets(f.root, sample), { code: 'CREDENTIALS_AUTHENTICATION_FAILED' });
  await fs.writeFile(f.key, Buffer.alloc(0));
  await assert.rejects(saveLinuxSecrets(f.root, sample), { code: 'CREDENTIALS_INVALID_KEY' });
  assert.deepEqual(await fs.readFile(f.ciphertext), ciphertext); assert.equal((await fs.stat(f.key)).size, 0);
});

test('unsupported envelope metadata does not silently create credentials', async t => {
  const f = await fixture(t);
  const raw = JSON.stringify({ version: 7, protection: 'plaintext', blob: 'e30=' });
  await fs.writeFile(f.ciphertext, raw, { mode: 0o600 });
  await assert.rejects(loadLinuxSecrets(f.root), { code: 'CREDENTIALS_INVALID_ENVELOPE' });
  await assert.rejects(saveLinuxSecrets(f.root, sample), { code: 'CREDENTIALS_INVALID_ENVELOPE' });
  await assert.rejects(fs.stat(f.key), { code: 'ENOENT' }); assert.equal(await fs.readFile(f.ciphertext, 'utf8'), raw);
});

test('failed fsync never publishes an incomplete key or replaces saved credentials', async t => {
  const f = await fixture(t), originalOpen = fs.open;
  async function failTemporarySync(prefix, action) {
    fs.open = async function (filename, ...args) {
      const file = await originalOpen.call(this, filename, ...args);
      if (typeof filename === 'string' && filename.startsWith(prefix + '.') && filename.endsWith('.tmp')) {
        file.sync = async () => { throw Object.assign(new Error('fixture fsync failure'), { code: 'EIO' }); };
      }
      return file;
    };
    try { await assert.rejects(action(), error => error.fatalStorage === true && error.storageCode === 'EIO'); }
    finally { fs.open = originalOpen; }
  }
  await failTemporarySync(f.key, () => saveLinuxSecrets(f.root, sample));
  assert.deepEqual(await fs.readdir(f.root), []);
  await saveLinuxSecrets(f.root, sample);
  const ciphertext = await fs.readFile(f.ciphertext), key = await fs.readFile(f.key);
  await failTemporarySync(f.ciphertext, () => saveLinuxSecrets(f.root, { teacher: 'changed-fixture' }));
  assert.deepEqual(await fs.readFile(f.ciphertext), ciphertext); assert.deepEqual(await fs.readFile(f.key), key);
  assert.deepEqual(await loadLinuxSecrets(f.root), sample);
  assert.deepEqual((await fs.readdir(f.root)).sort(), [LINUX_CREDENTIALS_FILE, LINUX_KEY_FILE].sort());
});

test('Linux loading refuses Windows DPAPI data without altering it', async t => {
  const f = await fixture(t), filename = path.join(f.root, 'credentials.dpapi.json');
  const legacy = JSON.stringify({ version: 1, blob: 'Zml4dHVyZQ==' }); await fs.writeFile(filename, legacy, { mode: 0o600 });
  await assert.rejects(loadLinuxSecrets(f.root), { code: 'CREDENTIALS_FOREIGN_PLATFORM' });
  await assert.rejects(saveLinuxSecrets(f.root, sample), { code: 'CREDENTIALS_FOREIGN_PLATFORM' });
  assert.equal(await fs.readFile(filename, 'utf8'), legacy); assert.deepEqual(await fs.readdir(f.root), ['credentials.dpapi.json']);
});

test('credential key hard links are rejected without modifying the shared inode', async t => {
  const f = await fixture(t); await saveLinuxSecrets(f.root, sample);
  const alias = path.join(f.root, 'key-alias'), key = await fs.readFile(f.key); await fs.link(f.key, alias);
  await assert.rejects(loadLinuxSecrets(f.root), { code: 'CREDENTIALS_MULTIPLE_LINKS' });
  await assert.rejects(saveLinuxSecrets(f.root, sample), { code: 'CREDENTIALS_MULTIPLE_LINKS' });
  assert.deepEqual(await fs.readFile(alias), key); assert.equal((await fs.stat(f.key)).nlink, 2);
});

test('native platform facade persists credentials with its own protection format', { skip: !['win32', 'linux'].includes(process.platform) }, async t => {
  const f = await fixture(t); await saveSecrets(f.root, sample); assert.deepEqual(await loadSecrets(f.root), sample);
  const file = process.platform === 'win32' ? 'credentials.dpapi.json' : LINUX_CREDENTIALS_FILE;
  assert.equal((await fs.readFile(path.join(f.root, file), 'utf8')).includes(sample.teacher), false);
  if (process.platform === 'win32') {
    const value = JSON.parse(await fs.readFile(path.join(f.root, file), 'utf8'));
    assert.deepEqual(Object.keys(value).sort(), ['blob', 'version']); assert.equal(value.version, 1);
    await assert.rejects(fs.stat(f.key), { code: 'ENOENT' });
  }
});

test('Windows refuses a Linux-only credential profile without overwriting it', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await saveLinuxSecrets(f.root, sample);
  const original = await fs.readFile(f.ciphertext);
  await assert.rejects(loadSecrets(f.root), { code: 'CREDENTIALS_FOREIGN_PLATFORM' });
  await assert.rejects(saveSecrets(f.root, sample), { code: 'CREDENTIALS_FOREIGN_PLATFORM' });
  assert.deepEqual(await fs.readFile(f.ciphertext), original);
});

test('Linux requires 0700 profile and 0600 credentials without silently changing modes', linuxOnly, async () => {
  await verifyUnsafeCredentialPermissions(os.tmpdir());
});

test('Linux rejects symlink key and envelope paths without touching their target', linuxOnly, async () => {
  await verifyCredentialSymlinkRejection(os.tmpdir());
});

test('Linux profile-directory migration preserves the exact key and restart decryption', linuxOnly, async t => {
  const f = await fixture(t), source = path.join(f.root, 'source'), target = path.join(f.root, 'target');
  const store = await createProfileStore(source); await store.save(store.config, sample);
  const originalKey = await fs.readFile(path.join(source, LINUX_KEY_FILE));
  const result = await relocateProfileDirectory({ sourceDir: source, targetPath: target, anchorDir: source, config: store.config, secrets: store.secrets });
  assert.deepEqual(result.store.secrets, sample); assert.equal(resolveDataLocation(source).dataDir, target);
  const reopened = await createProfileStore(target); assert.deepEqual(reopened.secrets, sample);
  assert.deepEqual(await fs.readFile(path.join(target, LINUX_KEY_FILE)), originalKey);
  assert.deepEqual(await loadSecrets(source), sample); assert.deepEqual(await loadSecrets(target), sample);
  assert.equal((await fs.stat(path.join(target, LINUX_KEY_FILE))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(target, LINUX_CREDENTIALS_FILE))).mode & 0o777, 0o600);
});
