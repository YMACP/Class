import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextArchive } from '../src/context-archive.js';
import { JudgmentLayer } from '../src/judgment-layer.js';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-context-archive-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(directory)), parent);
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('archived public context is complete, pageable and isolated without a memory manager', async t => {
  const directory = await fixture(t), other = await fixture(t);
  const archive = new ContextArchive({ directory, owner: 'student-a', secrets: ['fixture-secret'] });
  const original = '开始😀汉字\n' + 'preserved original content\n'.repeat(9000) + '结束';
  const saved = await archive.write({ input: { task: 'current task', password: 'hidden password' }, messages: [
    { role: 'tool', content: JSON.stringify({ output: original, apiKey: 'hidden api', public: 'fixture-secret', callId: 'actual-call-id' }) },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private internal' }, { type: 'text', text: 'public conclusion' }] },
  ] });
  assert.equal(saved.readWith.name, 'context_read');
  let offset = 0, text = '';
  do {
    const page = await archive.read({ reference: saved.reference, offset, limit: 501 });
    assert.ok(Buffer.byteLength(page.output) <= 501); assert.ok(!page.output.includes('\ufffd'));
    if (page.nextOffset !== null) assert.ok(page.nextOffset > offset);
    text += page.output; offset = page.nextOffset;
  } while (offset !== null);
  assert.ok(text.includes('actual-call-id')); assert.ok(text.includes('public conclusion'));
  assert.ok(!/fixture-secret|hidden password|hidden api|private internal/.test(text));
  const data = JSON.parse(text);
  const result = typeof data.messages[0].content === 'string' ? JSON.parse(data.messages[0].content) : data.messages[0].content;
  assert.equal(result.output, original);
  await assert.rejects(new ContextArchive({ directory, owner: 'student-b' }).read({ reference: saved.reference }), /member/);
  await assert.rejects(new ContextArchive({ directory: other, owner: 'student-a' }).read({ reference: saved.reference }), /unavailable/);
  const restarted = new ContextArchive({ directory, owner: 'student-a' });
  assert.equal((await restarted.read({ reference: saved.reference })).reference, saved.reference);
});

test('invalid references, partial UTF-8 offsets and substituted archive files are rejected', async t => {
  const directory = await fixture(t), archive = new ContextArchive({ directory, owner: 'a' });
  const saved = await archive.write({ input: { task: '中文' } });
  await assert.rejects(archive.read({ reference: '../../outside' }), /member/);
  await assert.rejects(archive.read({ reference: saved.reference, offset: -1 }), /offset/);
  await assert.rejects(archive.read({ reference: saved.reference, limit: 1 }), /limit/);
  const page = await archive.read({ reference: saved.reference });
  const chineseOffset = Buffer.from(page.output).indexOf(Buffer.from('中文'));
  await assert.rejects(archive.read({ reference: saved.reference, offset: chineseOffset + 1 }), /UTF-8/);
  await assert.rejects(archive.read({ reference: saved.reference, offset: page.totalBytes + 1 }), /exceeds/);
  const [, owner, id] = saved.reference.split(':');
  const filename = path.join(directory, 'contexts', owner, id + '.json');
  await fs.link(filename, path.join(directory, 'extra-link'));
  await assert.rejects(archive.read({ reference: saved.reference }), /replaced/);
});

test('cancelled or failed archive writes cannot return a continuation reference', async t => {
  const directory = await fixture(t), controller = new AbortController();
  controller.abort(Error('cancelled task'));
  const archive = new ContextArchive({ directory, owner: 'a' });
  await assert.rejects(archive.write({ input: 'kept in model history' }, controller.signal), /cancelled task/);
  const failed = new ContextArchive({ directory, owner: 'b', storageGuard: { check() { throw Error('disk full fixture'); } } });
  await assert.rejects(failed.write({ input: 'kept in model history' }), error => error.fatalStorage === true);
});

test('shared secret Sets remain live and redact principal archive text after key changes', async t => {
  const directory = await fixture(t), secrets = new Set(['old-fixture-key']);
  const archive = new ContextArchive({ directory, owner: 'principal:question', secrets });
  secrets.add('new-fixture-key');
  const saved = await archive.write({ input: { text: 'old-fixture-key and new-fixture-key are private strings' } });
  const page = await archive.read({ reference: saved.reference });
  assert.ok(!/old-fixture-key|new-fixture-key/.test(page.output)); assert.match(page.output, /REDACTED/);
});

test('Jev compression advice is optional, respects task-dispatch opt-in and cannot authorize removal', async () => {
  const calls = [];
  const judge = { getStats: () => ({}), async decide(point, payload) { calls.push({ point, payload }); return { status: 'ok', applied: true, answers: { evidence: { type: 'boolean', probability: 1 }, constraints: { type: 'boolean', probability: 1 }, verification: { type: 'boolean', probability: 1 } } }; } };
  const input = { task: 'Preserve evidence and constraints', beforeTokens: 9000, budget: 10000 };
  const disabled = new JudgmentLayer({ enabled: false }, { judge });
  assert.equal(await disabled.contextCompaction(input), undefined); assert.equal(calls.length, 0);
  const enabled = new JudgmentLayer({ enabled: true, apiKey: 'fixture-only', features: { taskDispatch: true } }, { judge });
  const advice = await enabled.contextCompaction(input);
  assert.equal(calls.length, 1); assert.equal(calls[0].point, 'taskDispatch');
  assert.equal(advice.focus.length, 3); assert.match(advice.notice, /不得据此删除原文/);
  const noDispatch = new JudgmentLayer({ enabled: true, apiKey: 'fixture-only', features: { taskDispatch: false } }, { judge });
  assert.equal(await noDispatch.contextCompaction(input), undefined); assert.equal(calls.length, 1);
});
