import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AttachmentStore, ATTACHMENT_LIMIT } from '../src/attachment-store.js';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-attachments-'));
  const data = path.join(root, 'data'), cwd = path.join(root, 'workspace');
  await fs.mkdir(data); await fs.mkdir(cwd);
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), parent); assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(root, { recursive: true, force: true }); });
  const store = new AttachmentStore(data), upload = (name = '资料.txt', text = '用户提供的内容') => store.upload({ name, contentBase64: Buffer.from(text).toString('base64') });
  return { root, data, cwd, store, upload };
}

test('attachments preserve original bytes and allow only their owning task to claim or delete them', async t => {
  const f = await fixture(t), item = await f.upload(), id = `run-${randomUUID()}`;
  const prepared = await f.store.prepare([item.id], id, f.cwd); await prepared.commit();
  assert.equal(await fs.readFile(path.join(f.cwd, prepared.attachments[0].path), 'utf8'), '用户提供的内容');
  assert.equal((await f.store.pending()).length, 0);
  await assert.rejects(f.store.removePending(item.id), error => error.status === 409);
  await assert.rejects(f.store.prepare([item.id], `run-${randomUUID()}`, f.cwd), error => error.status === 409);
  await f.store.removeRun({ id, attachments: prepared.attachments }, f.cwd);
  await assert.rejects(f.store.load(item.id), error => error.status === 404);
});

test('upload validation rejects traversal, malformed base64, oversized files and a ninth pending file', async t => {
  const f = await fixture(t);
  for (const name of ['../secret.txt', '..\\secret.txt', 'bad\0name']) await assert.rejects(f.upload(name), error => error.status === 400);
  await assert.rejects(f.store.upload({ name: 'bad.txt', contentBase64: 'a!==' }), error => error.status === 400);
  await assert.rejects(f.store.upload({ name: 'huge.txt', contentBase64: 'A'.repeat(Math.ceil(ATTACHMENT_LIMIT / 3) * 4 + 4) }), error => error.status === 413);
  for (let i = 0; i < 8; i++) await f.upload(`${i}.txt`);
  await assert.rejects(f.upload('ninth.txt'), error => error.status === 409);
  const pending = await f.store.pending(); await f.store.removePending(pending[0].id); await f.upload('replacement.txt');
  assert.equal((await f.store.pending()).length, 8);
});

test('failed task preparation leaves attachments available and never overwrites an altered workspace copy', async t => {
  const f = await fixture(t), item = await f.upload(), id = `run-${randomUUID()}`;
  const prepared = await f.store.prepare([item.id], id, f.cwd); await prepared.commit(); await prepared.rollback();
  assert.equal((await f.store.pending()).length, 1);
  const retried = await f.store.prepare([item.id], id, f.cwd); await retried.commit();
  const file = path.join(f.cwd, retried.attachments[0].path); await fs.writeFile(file, '用户后来修改的内容');
  await assert.rejects(f.store.prepare([item.id], id, f.cwd, { resume: true }), error => error.status === 409);
  await f.store.removeRun({ id, attachments: retried.attachments }, f.cwd);
  assert.equal(await fs.readFile(file, 'utf8'), '用户后来修改的内容');
});

test('symlinked attachment roots and task copies are refused and unrelated targets survive removal', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(outside, path.join(f.cwd, '.class-attachments'), linkType);
  const item = await f.upload(), id = `run-${randomUUID()}`;
  await assert.rejects(f.store.prepare([item.id], id, f.cwd), error => error.status === 409);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(f.cwd, '.class-attachments'));
  const prepared = await f.store.prepare([item.id], id, f.cwd); await prepared.commit();
  const target = path.join(f.cwd, '.class-attachments', id), moved = path.join(f.root, 'owned-copy');
  await fs.rename(target, moved); await fs.symlink(outside, target, linkType); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await f.store.removeRun({ id, attachments: prepared.attachments }, f.cwd);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  await fs.unlink(target);
  await fs.rename(path.join(f.data, 'attachments'), path.join(f.root, 'original-attachments'));
  await fs.symlink(outside, path.join(f.data, 'attachments'), linkType);
  await assert.rejects(f.upload(), error => error.status === 409);
  await fs.unlink(path.join(f.data, 'attachments'));
});
