import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createProfileStore, assertProfileJSONSize, MAX_PROFILE_BYTES } from '../src/profile-store.js';
import { validateRecoveryDirectory } from '../src/startup-data-recovery.js';
import { loadCLIExtensions } from '../src/cli-extensions.js';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-profile-capacity-'));
  await fs.chmod(directory, 0o700);
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(directory)), parent); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false); await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('profile capacity counts exact UTF-8 bytes including formatting and rejects one byte over the limit', () => {
  assert.equal(MAX_PROFILE_BYTES, 64 * 1024 * 1024);
  const text = JSON.stringify({ name: '中文模式', prompt: '\n完整正文\n' }, null, 2) + '\n', size = Buffer.byteLength(text);
  assert.ok(size > text.length); assert.doesNotThrow(() => assertProfileJSONSize(text, size));
  assert.throws(() => assertProfileJSONSize(text, size - 1), error => error.status === 400 && error.code === 'PROFILE_TOO_LARGE');
});

test('valid profiles larger than the old 2MiB limit remain readable by startup recovery and CLI imports', async t => {
  const directory = await fixture(t), store = await createProfileStore(directory);
  const body = '完整中文模式正文。'.repeat(12000);
  const modes = { revision: 1, items: Array.from({ length: 8 }, (_, index) => ({ id: 'custom-' + randomUUID(), name: '模式' + index, prompt: body, mcps: [], skills: [] })) };
  await store.save({ ...store.config, modes });
  const filename = path.join(directory, 'profiles.json'), bytes = (await fs.stat(filename)).size;
  assert.ok(bytes > 2 * 1024 * 1024); assert.ok(bytes < MAX_PROFILE_BYTES);
  const restored = await createProfileStore(directory); assert.deepEqual(restored.config.modes, modes);
  const recovery = await validateRecoveryDirectory(directory); assert.equal(recovery.dataDir, directory);
  const cli = await loadCLIExtensions({}, { profileDirectory: directory, environment: {} });
  assert.equal(cli.extensionConfig.mcps.length, store.config.extensions.mcps.length);
  assert.equal(cli.extensionConfig.skills.length, store.config.extensions.skills.length);
  assert.equal((await fs.stat(filename)).size, bytes, 'reading and recovery must not rewrite a valid profile');
});

test('profile and CLI loaders reject a file over the shared limit before reading its body', async t => {
  const directory = await fixture(t), store = await createProfileStore(directory); await store.save(store.config);
  const filename = path.join(directory, 'profiles.json'), originalStat = fs.stat, originalRead = fs.readFile;
  let profileReads = 0;
  t.mock.method(fs, 'stat', async function(file, ...args) { const info = await originalStat.call(this, file, ...args); return path.resolve(file) === filename ? { ...info, size: MAX_PROFILE_BYTES + 1 } : info; });
  t.mock.method(fs, 'readFile', async function(file, ...args) { if (path.resolve(file) === filename) profileReads++; return originalRead.call(this, file, ...args); });
  await assert.rejects(createProfileStore(directory), error => error.status === 400 && error.code === 'PROFILE_TOO_LARGE');
  await assert.rejects(loadCLIExtensions({}, { profileDirectory: directory, environment: {} }), /maximum 64MiB/);
  assert.equal(profileReads, 0);
});

test('an oversized save is rejected before publishing profiles or credentials', async t => {
  const directory = await fixture(t), store = await createProfileStore(directory); await store.save(store.config);
  const filename = path.join(directory, 'profiles.json'), before = await fs.readFile(filename, 'utf8'), files = (await fs.readdir(directory)).sort();
  const originalByteLength = Buffer.byteLength, marker = 'fixture-oversized-profile';
  t.mock.method(Buffer, 'byteLength', function(value, ...args) {
    return typeof value === 'string' && value.includes(marker) ? MAX_PROFILE_BYTES + 1 : originalByteLength.call(this, value, ...args);
  });
  const modes = { revision: 1, items: [{ id: 'custom-' + randomUUID(), name: '容量边界', prompt: marker, mcps: [], skills: [] }] };
  await assert.rejects(store.save({ ...store.config, modes }, { 'fixture-secret': 'must-not-be-written' }), error => error.status === 400 && error.code === 'PROFILE_TOO_LARGE');
  assert.equal(await fs.readFile(filename, 'utf8'), before); assert.deepEqual((await fs.readdir(directory)).sort(), files);
  assert.deepEqual(store.secrets, {}); assert.deepEqual(store.config.modes.items, []);
});
