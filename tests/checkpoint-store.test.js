import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CheckpointStore, newCheckpointKey } from '../src/checkpoint-store.js';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-checkpoint-test-'));
  t.after(async () => { const actual = await fs.realpath(root); assert.equal(path.dirname(actual), parent); assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(actual, { recursive: true, force: true }); });
  const key = newCheckpointKey();
  return { root, key, id: 'run-' + randomUUID(), store: new CheckpointStore({ directory: path.join(root, 'checkpoints'), getKey: () => key }) };
}
test('private protocol history is encrypted and survives a fresh checkpoint store', async t => {
  const f = await fixture(t), state = { schemaVersion: 1, task: 'private task marker', agents: { a: { history: [{ content: 'private original model replay' }] } } };
  assert.equal(await f.store.read(f.id), null);
  await f.store.write(f.id, state, { cwd: f.root });
  const serialized = await fs.readFile(f.store.filename(f.id), 'utf8');
  assert.ok(!serialized.includes('private')); assert.ok(!serialized.includes(f.key));
  const fresh = new CheckpointStore({ directory: f.store.directory, getKey: () => f.key });
  assert.deepEqual((await fresh.read(f.id)).state, state);
  assert.equal((await fresh.read(f.id)).metadata.cwd, f.root);
  await fresh.remove(f.id); assert.equal(await fresh.read(f.id), null);
});
test('tampered ciphertext, substituted task ID, and a wrong key cannot be resumed', async t => {
  const f = await fixture(t); await f.store.write(f.id, { task: 'unchanged' });
  const original = JSON.parse(await fs.readFile(f.store.filename(f.id), 'utf8'));
  const changed = { ...original, body: (original.body[0] === 'A' ? 'B' : 'A') + original.body.slice(1) };
  await fs.writeFile(f.store.filename(f.id), JSON.stringify(changed));
  await assert.rejects(f.store.read(f.id));
  await fs.writeFile(f.store.filename(f.id), JSON.stringify(original));
  const wrong = new CheckpointStore({ directory: f.store.directory, getKey: newCheckpointKey });
  await assert.rejects(wrong.read(f.id));
  const other = 'run-' + randomUUID();
  await fs.writeFile(f.store.filename(other), JSON.stringify({ ...original, runId: other }), { mode: 0o600 });
  await assert.rejects(f.store.read(other));
});
test('concurrent writes publish in order and invalid paths never reach key storage', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, (_, sequence) => f.store.write(f.id, { sequence })));
  assert.equal((await f.store.read(f.id)).state.sequence, 7);
  for (const id of ['../profiles', 'run-../../credentials', '', null]) {
    await assert.rejects(f.store.write(id, {}), /编号/); await assert.rejects(f.store.read(id), /编号/);
  }
  assert.deepEqual((await fs.readdir(f.store.directory)), [f.id + '.json']);
});
test('missing encryption key fails closed without destroying the checkpoint', async t => {
  const f = await fixture(t); await f.store.write(f.id, { task: 'retained' });
  const before = await fs.readFile(f.store.filename(f.id));
  const missing = new CheckpointStore({ directory: f.store.directory, getKey: () => { throw Error('missing key'); } });
  await assert.rejects(missing.read(f.id), /missing key/);
  assert.deepEqual(await fs.readFile(f.store.filename(f.id)), before);
});
