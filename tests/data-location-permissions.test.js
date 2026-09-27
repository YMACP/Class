import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProfileStore } from '../src/profile-store.js';
import { loadSecrets } from '../src/secret-store.js';
import { relocateProfileDirectory, resolveDataLocation } from '../src/data-location.js';
import { linuxMigrationScenarios } from './helpers/linux-migration-scenarios.js';

const linuxOnly = { skip: process.platform !== 'linux' ? 'Requires native Linux permissions and links' : false };
const fakeSecrets = { teacher: 'migration-permission-fixture-only' };

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'class-migration-permissions-'));
  const owned = await fs.lstat(root);
  t.after(async () => {
    t.mock.restoreAll();
    const info = await fs.lstat(root), actual = await fs.realpath(root);
    assert.equal(info.isSymbolicLink(), false); assert.equal(info.isDirectory(), true);
    assert.equal(info.dev, owned.dev); assert.equal(info.ino, owned.ino);
    assert.equal(actual, root); assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('class-migration-permissions-'));
    await fs.rm(actual, { recursive: true });
  });
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  const store = await createProfileStore(source);
  await store.save(store.config, fakeSecrets);
  await fs.writeFile(path.join(source, 'source-evidence.txt'), 'Isolated migration evidence. 测试数据。\n');
  const names = ['profiles.json', 'source-evidence.txt', ...(process.platform === 'linux' ? ['credentials.key', 'credentials.aesgcm.json'] : ['credentials.dpapi.json'])];
  const sourceBytes = new Map(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(source, name))])));
  return { root, source, target, store, sourceBytes };
}

const migrate = f => relocateProfileDirectory({ sourceDir: f.source, targetPath: f.target, anchorDir: f.source, config: f.store.config, secrets: f.store.secrets });

async function sourcePreserved(f) {
  for (const [name, bytes] of f.sourceBytes) assert.deepEqual(await fs.readFile(path.join(f.source, name)), bytes, 'Source changed: ' + name);
  assert.deepEqual(await loadSecrets(f.source), fakeSecrets);
}

for (const scenario of linuxMigrationScenarios) {
  test('Linux migration ' + scenario.description, linuxOnly, async () => {
    await scenario.run(os.tmpdir());
  });
}

test('Windows migration keeps the existing empty-directory behavior without target chmod', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await fs.mkdir(f.target);
  const originalChmod = fs.chmod; let targetChmods = 0;
  t.mock.method(fs, 'chmod', async (filename, ...args) => {
    if (path.resolve(filename).toLowerCase() === f.target.toLowerCase()) targetChmods++;
    return originalChmod(filename, ...args);
  });
  const result = await migrate(f);
  assert.equal(result.dataDir, f.target); assert.equal(targetChmods, 0);
  assert.deepEqual(result.store.secrets, fakeSecrets); assert.deepEqual(await loadSecrets(f.target), fakeSecrets);
  assert.equal(resolveDataLocation(f.source).dataDir, f.target);
  assert.deepEqual(await fs.readFile(path.join(f.target, 'credentials.dpapi.json')), f.sourceBytes.get('credentials.dpapi.json'));
  await sourcePreserved(f);
});
