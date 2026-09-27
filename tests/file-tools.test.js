import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { executeFileTool, fileToolDefinitions } from '../src/file-tools.js';

async function fixture(t, options = {}) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'class-file-tools-'));
  const cwd = path.join(directory, 'workspace');
  await fs.mkdir(cwd);
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('class-file-tools-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const manager = {
    cwd, maxOutputBytes: 65536,
    checkpoint: async signal => { signal?.throwIfAborted(); },
    async _path(value = '.') {
      const base = await fs.realpath(this.cwd), resolved = await fs.realpath(path.resolve(base, value));
      const relative = path.relative(base, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Tool path escapes workspace');
      return resolved;
    },
    ...options,
  };
  const run = (name, args, signal) => executeFileTool(manager, 'test-member', name, args, signal);
  return { manager, run, cwd, directory };
}

test('file schemas describe the four executable tools and exact edit fields', () => {
  assert.deepEqual(fileToolDefinitions.map(item => item.name), ['write_file', 'edit_file', 'glob', 'grep']);
  assert.deepEqual(fileToolDefinitions.find(item => item.name === 'edit_file').parameters.required, ['path', 'old_text', 'new_text']);
});

test('write creates parents, preserves UTF-8 bytes and requires explicit overwrite', async t => {
  const { run, cwd } = await fixture(t);
  const content = '\ufeff第一行\r\nsecond line\r\n';
  const created = JSON.parse((await run('write_file', { path: 'nested/a.txt', content })).output);
  assert.equal(created.action, 'created');
  assert.equal(await fs.readFile(path.join(cwd, 'nested/a.txt'), 'utf8'), content);
  await assert.rejects(run('write_file', { path: 'nested/a.txt', content: 'bad' }), /overwrite:true/);
  const overwritten = JSON.parse((await run('write_file', { path: 'nested/a.txt', content: 'replacement', overwrite: true })).output);
  assert.equal(overwritten.action, 'updated');
  assert.notEqual(overwritten.beforeSha256, overwritten.afterSha256);
  assert.equal(overwritten.diff.removedPreview, content);
  assert.equal(overwritten.diff.addedPreview, 'replacement');
  assert.equal(await fs.readFile(path.join(cwd, 'nested/a.txt'), 'utf8'), 'replacement');
  assert.deepEqual(await fs.readdir(path.join(cwd, 'nested')), ['a.txt']);
});

test('edit rejects ambiguous and missing text without changing files, then replaces exact matches', async t => {
  const { run, cwd } = await fixture(t);
  const target = path.join(cwd, 'a.txt');
  await fs.writeFile(target, 'alpha\r\nrepeat repeat\r\nomega');
  await assert.rejects(run('edit_file', { path: 'a.txt', old_text: 'repeat', new_text: 'next' }), /2 locations/);
  await assert.rejects(run('edit_file', { path: 'a.txt', old_text: 'alpha\n', new_text: 'new\n' }), /does not exactly match/);
  assert.equal(await fs.readFile(target, 'utf8'), 'alpha\r\nrepeat repeat\r\nomega');
  const result = JSON.parse((await run('edit_file', { path: 'a.txt', old_text: 'repeat', new_text: '$& next', replace_all: true })).output);
  assert.equal(result.replacements, 2);
  assert.equal(await fs.readFile(target, 'utf8'), 'alpha\r\n$& next $& next\r\nomega');
  await run('edit_file', { path: 'a.txt', old_text: ' ', new_text: '\t', replace_all: true });
  assert.equal(await fs.readFile(target, 'utf8'), 'alpha\r\n$&\tnext\t$&\tnext\r\nomega');
});

test('simultaneous edits from different managers preserve both changes', async t => {
  const { manager, run, cwd } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'left=old\nright=old\n');
  const second = { ...manager };
  await Promise.all([
    run('edit_file', { path: 'a.txt', old_text: 'left=old', new_text: 'left=new' }),
    executeFileTool(second, 'another-member', 'edit_file', { path: 'a.txt', old_text: 'right=old', new_text: 'right=new' }),
  ]);
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'left=new\nright=new\n');
  const creations = await Promise.allSettled(['first', 'second'].map(content => run('write_file', { path: 'new.txt', content })));
  assert.equal(creations.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(creations.filter(result => result.status === 'rejected').length, 1);
});

test('mutations reject traversal and junction paths; searches do not leave the workspace', async t => {
  const { run, cwd, directory } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'external needle');
  await assert.rejects(run('write_file', { path: '../outside/new.txt', content: 'bad' }), /escapes workspace/);
  await assert.rejects(run('write_file', { path: path.join(outside, 'new.txt'), content: 'bad' }), /escapes workspace/);
  await fs.symlink(outside, path.join(cwd, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run('write_file', { path: 'outside-link/new.txt', content: 'bad' }), /symlinks|junctions/);
  await assert.rejects(run('edit_file', { path: 'outside-link/secret.txt', old_text: 'needle', new_text: 'bad' }), /symlinks|junctions/);
  await assert.rejects(run('grep', { path: 'outside-link', pattern: 'needle' }), /escapes workspace/);
  const searched = JSON.parse((await run('grep', { pattern: 'needle' })).output);
  assert.deepEqual(searched.matches, []);
  assert.equal(searched.skipped.symlinks, 1);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'external needle');
  assert.deepEqual(await fs.readdir(outside), ['secret.txt']);
});

test('an aborted call cannot create a file or prevent subsequent writes', async t => {
  const { run, cwd } = await fixture(t);
  const controller = new AbortController(); controller.abort(new Error('cancel this call'));
  await assert.rejects(run('write_file', { path: 'new.txt', content: 'bad' }, controller.signal), /cancel this call/);
  await assert.rejects(fs.stat(path.join(cwd, 'new.txt')), { code: 'ENOENT' });
  await run('write_file', { path: 'new.txt', content: 'good' });
  assert.equal(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8'), 'good');
});

test('cancellation during a staged write preserves original content and removes its temporary file', async t => {
  const { run, manager, cwd } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'original');
  const controller = new AbortController();
  manager.checkpoint = async signal => {
    if ((await fs.readdir(cwd)).some(name => name.startsWith('.class-write-'))) controller.abort(new Error('cancel staged write'));
    signal?.throwIfAborted();
  };
  await assert.rejects(run('write_file', { path: 'a.txt', content: 'replacement', overwrite: true }, controller.signal), /cancel staged write/);
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(cwd), ['a.txt']);
});

test('a concurrent external modification is detected before commit', async t => {
  const { run, manager, cwd } = await fixture(t);
  const target = path.join(cwd, 'a.txt');
  await fs.writeFile(target, 'original');
  let changed = false;
  manager.checkpoint = async signal => {
    signal?.throwIfAborted();
    if (!changed && (await fs.readdir(cwd)).some(name => name.startsWith('.class-write-'))) {
      changed = true; await fs.writeFile(target, 'external modification');
    }
  };
  await assert.rejects(run('edit_file', { path: 'a.txt', old_text: 'original', new_text: 'replacement' }), /changed during writing/);
  assert.equal(await fs.readFile(target, 'utf8'), 'external modification');
  assert.deepEqual(await fs.readdir(cwd), ['a.txt']);
});

test('glob supports recursive alternatives, filters hidden/dependency folders and paginates', async t => {
  const { run, cwd } = await fixture(t);
  for (const name of ['a.js', 'b.ts', 'nested/c.js', 'nested/d.txt', '.hidden.js', 'node_modules/dependency.js', '.dot/inside.js']) {
    await fs.mkdir(path.dirname(path.join(cwd, name)), { recursive: true }); await fs.writeFile(path.join(cwd, name), name);
  }
  const page1 = JSON.parse((await run('glob', { pattern: '**/*.{js,ts}', limit: 2 })).output);
  assert.deepEqual(page1.files, ['a.js', 'b.ts']); assert.equal(page1.nextOffset, 2); assert.equal(page1.truncated, true);
  const page2 = JSON.parse((await run('glob', { pattern: '**/*.{js,ts}', offset: page1.nextOffset, limit: 2 })).output);
  assert.deepEqual(page2.files, ['nested/c.js']); assert.equal(page2.nextOffset, null);
  const hidden = JSON.parse((await run('glob', { pattern: '*.js', include_hidden: true })).output);
  assert.deepEqual(hidden.files, ['.dot/inside.js', '.hidden.js', 'a.js', 'nested/c.js']);
  assert.equal(hidden.skipped.ignoredDirectories, 1);
});

test('grep defaults to literal matching and reports binary/large files without claiming completeness', async t => {
  const { run, cwd } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'not matching\r\nLiteral [a+] 中文\r\nother [a+]\r\n');
  await fs.writeFile(path.join(cwd, 'b.bin'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(cwd, 'c.txt'), Buffer.alloc(1024 * 1024 + 1, 'x'));
  await fs.writeFile(path.join(cwd, 'd.bin'), Buffer.from([0xc3, 0x28]));
  const page = JSON.parse((await run('grep', { pattern: '[a+]', limit: 1 })).output);
  assert.deepEqual(page.matches.map(item => item.line), [2]); assert.equal(page.nextOffset, 1);
  const next = JSON.parse((await run('grep', { pattern: '[a+]', offset: 1 })).output);
  assert.deepEqual(next.matches.map(item => item.line), [3]);
  assert.equal(next.skipped.binary, 2); assert.equal(next.skipped.large, 1); assert.equal(next.truncated, true);
  const filtered = JSON.parse((await run('grep', { pattern: 'literal', path: 'a.txt', ignore_case: true })).output);
  assert.equal(filtered.matches[0].text, 'Literal [a+] 中文');
});

test('regex works in its isolated worker, and invalid expressions fail clearly', async t => {
  const { run, cwd } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'id=17\nid=xx\nID=28\n');
  const result = JSON.parse((await run('grep', { pattern: '^id=\\d+$', literal: false, ignore_case: true })).output);
  assert.deepEqual(result.matches.map(item => item.line), [1, 3]);
  await assert.rejects(run('grep', { pattern: '[', literal: false }), /Invalid regular expression/);
});

test('a pathological regex times out without blocking the main event loop', async t => {
  const { run, cwd } = await fixture(t);
  // Multiple lines also exceed the budget on engines that cap the amount of
  // backtracking for an individual RegExp.test call (for example JavaScriptCore).
  await fs.writeFile(path.join(cwd, 'a.txt'), Array(20).fill('a'.repeat(5000) + '!').join('\n'));
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats++; }, 20);
  try { await assert.rejects(run('grep', { pattern: '(a+)+$', literal: false }), /per-file limit/); }
  finally { clearInterval(timer); }
  assert.ok(heartbeats > 5, 'main event loop stays responsive while regex is stopped');
});

test('search can be cancelled while the regex worker is busy', async t => {
  const { run, cwd } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'a'.repeat(100000) + '!');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('stop regex now')), 100);
  try { await assert.rejects(run('grep', { pattern: '(a+)+$', literal: false }, controller.signal), /stop regex now/); }
  finally { clearTimeout(timer); }
});

test('byte-limited search output is explicit and its next offset refers only to returned records', async t => {
  const { run, cwd } = await fixture(t, { maxOutputBytes: 1100 });
  await fs.writeFile(path.join(cwd, 'a.txt'), Array.from({ length: 10 }, (_, index) => `needle ${index} ` + 'x'.repeat(120)).join('\n'));
  const response = await run('grep', { pattern: 'needle' });
  assert.ok(Buffer.byteLength(response.output) <= 1100); assert.equal(response.truncated, true); assert.equal(response.outputTruncated, true);
  const page = JSON.parse(response.output);
  assert.ok(page.returned > 0 && page.returned < 10);
  assert.equal(page.nextOffset, page.returned);
  const next = JSON.parse((await run('grep', { pattern: 'needle', offset: page.nextOffset })).output);
  assert.equal(next.matches[0].line, page.returned + 1);
});

test('bounded difference previews and invalid text are reported accurately', async t => {
  const { run, cwd } = await fixture(t);
  const written = await run('write_file', { path: 'a.txt', content: '中'.repeat(2000) });
  assert.equal(written.truncated, true);
  assert.equal(JSON.parse(written.output).diff.previewTruncated, true);
  await fs.writeFile(path.join(cwd, 'invalid.txt'), Buffer.from([0xff]));
  await assert.rejects(run('edit_file', { path: 'invalid.txt', old_text: 'x', new_text: 'y' }), /valid UTF-8/);
  await assert.rejects(run('write_file', { path: 'binary.txt', content: 'a\0b' }), /Binary files/);
  await assert.rejects(run('edit_file', { path: 'a.txt', old_text: '', new_text: 'x' }), /Empty tool argument/);
});

test('replace_all rejects excessive expansion before constructing the replacement', async t => {
  const { run, cwd } = await fixture(t);
  const original = 'a'.repeat(10000);
  await fs.writeFile(path.join(cwd, 'a.txt'), original);
  await assert.rejects(run('edit_file', { path: 'a.txt', old_text: 'a', new_text: 'b'.repeat(10000), replace_all: true }), /4 MiB/);
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), original);
});

test('a queued cancelled writer does not release the active path lock', async t => {
  const { manager, run, cwd } = await fixture(t);
  const target = path.join(cwd, 'a.txt');
  await fs.writeFile(target, 'first=old\nsecond=old');
  let entered, resume;
  const staged = new Promise(resolve => { entered = resolve; });
  const release = new Promise(resolve => { resume = resolve; });
  let held = false;
  manager.checkpoint = async signal => {
    signal?.throwIfAborted();
    if (!held && (await fs.readdir(cwd)).some(name => name.startsWith('.class-write-'))) { held = true; entered(); await release; }
    signal?.throwIfAborted();
  };
  const active = run('edit_file', { path: 'a.txt', old_text: 'first=old', new_text: 'first=new' });
  await staged;
  const secondManager = { ...manager, checkpoint: async signal => { signal?.throwIfAborted(); } };
  const controller = new AbortController();
  const cancelled = executeFileTool(secondManager, 'cancelled', 'edit_file', { path: 'a.txt', old_text: 'first=old', new_text: 'bad' }, controller.signal);
  const cancelledCheck = assert.rejects(cancelled, /cancel queued/);
  controller.abort(new Error('cancel queued'));
  const next = executeFileTool(secondManager, 'next', 'edit_file', { path: 'a.txt', old_text: 'second=old', new_text: 'second=new' });
  await cancelledCheck;
  assert.equal(await fs.readFile(target, 'utf8'), 'first=old\nsecond=old');
  resume(); await Promise.all([active, next]);
  assert.equal(await fs.readFile(target, 'utf8'), 'first=new\nsecond=new');
});

test('extremely small output budgets keep JSON valid and preserve mutation summaries', async t => {
  const { run, manager, cwd } = await fixture(t, { maxOutputBytes: 2 });
  const write = await run('write_file', { path: 'a.txt', content: 'needle' });
  assert.equal(write.output, '{}'); assert.equal(write.truncated, true); assert.equal(write.outputTruncated, true);
  assert.equal(write.summary.changed, true); assert.equal(write.summary.diff.addedPreview, 'needle');
  for (const cap of [1, 2, 18, 128]) {
    manager.maxOutputBytes = cap;
    const search = await run('grep', { pattern: 'needle' });
    assert.doesNotThrow(() => JSON.parse(search.output));
    assert.ok(Buffer.byteLength(search.output) <= cap);
    assert.equal(search.outputTruncated, true); assert.equal(search.truncated, true);
    assert.equal(search.nextOffset, 0); assert.equal(search.returned, 0);
  }
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'needle');
});

test('an excessive directory depth is bounded and reported as an incomplete scan', async t => {
  const { run, cwd } = await fixture(t);
  let directory = cwd;
  for (let depth = 0; depth < 66; depth++) { directory = path.join(directory, 'd'); await fs.mkdir(directory); }
  await fs.writeFile(path.join(directory, 'hidden-by-limit.txt'), 'needle');
  const response = await run('glob', { pattern: '**/*.txt' });
  const data = JSON.parse(response.output);
  assert.deepEqual(data.files, []); assert.equal(data.scanTruncated, true); assert.equal(data.skipped.depth, 1);
  assert.equal(response.truncated, true); assert.equal(data.nextOffset, null);
});
