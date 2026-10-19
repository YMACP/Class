import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ToolManager } from '../src/tools.js';
import { createStudent, createTeacher, ModelClient } from '../src/agents.js';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-run-workspace-'));
  const project = path.join(directory, 'project'), first = path.join(project, '.class-runs', 'run-a'), second = path.join(project, '.class-runs', 'run-b');
  await fs.mkdir(first, { recursive: true }); await fs.mkdir(second, { recursive: true });
  const managers = [];
  const manager = (cwd, workspaceRoot = project) => { const tools = new ToolManager({ cwd, workspaceRoot }); managers.push(tools); return tools; };
  t.after(async () => {
    await Promise.all(managers.map(tools => tools.stopAll()));
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), parent); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    assert.ok(path.basename(resolved).startsWith('class-run-workspace-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { directory, project, first, second, manager, a: manager(first), b: manager(second) };
}
const execute = (manager, name, args) => manager.execute('fixture-member', { name, args });
const read = async (manager, target) => (await execute(manager, 'read_file', { path: target })).output;

test('relative outputs and returned file paths stay in each run while explicit shared project edits serialize', async t => {
  const { a, b, project, first, second } = await fixture(t);
  const results = await Promise.all([a, b].map((manager, i) => execute(manager, 'write_file', { path: 'outputs/result.txt', content: `run ${i}` })));
  assert.equal(await fs.readFile(path.join(first, 'outputs/result.txt'), 'utf8'), 'run 0');
  assert.equal(await fs.readFile(path.join(second, 'outputs/result.txt'), 'utf8'), 'run 1');
  for (let i = 0; i < results.length; i++) {
    const returned = JSON.parse(results[i].output).path;
    assert.equal(returned, 'outputs/result.txt');
    assert.equal(await read([a, b][i], returned), `run ${i}`, 'Returned relative paths must be reusable by the same tool manager');
  }
  const common = path.join(project, 'shared.txt'); await fs.writeFile(common, 'left=old\nright=old\n');
  assert.equal(await read(a, common), 'left=old\nright=old\n');
  await Promise.all([
    execute(a, 'edit_file', { path: common, old_text: 'left=old', new_text: 'left=new' }),
    execute(b, 'edit_file', { path: common, old_text: 'right=old', new_text: 'right=new' }),
  ]);
  assert.equal(await read(b, common), 'left=new\nright=new\n');
  const creations = await Promise.allSettled([a, b].map(manager => execute(manager, 'write_file', { path: path.join(project, 'new.txt'), content: 'create once' })));
  assert.equal(creations.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(creations.filter(result => result.status === 'rejected').length, 1);
});

test('sibling run files cannot be read, changed, listed or searched through direct paths or links', async t => {
  const { a, project, first, second } = await fixture(t);
  await fs.writeFile(path.join(second, 'private.txt'), 'SIBLING_PRIVATE_CONTENT');
  await fs.writeFile(path.join(project, 'shared.txt'), 'SHARED_CONTENT');
  await fs.symlink(second, path.join(first, 'sibling-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const variants = [path.join(second, 'private.txt'), '../run-b/private.txt', 'sibling-link/private.txt'];
  if (process.platform === 'win32') variants.push(path.join(project, '.CLASS-RUNS', 'RUN-B', 'private.txt'));
  for (const target of variants) {
    await assert.rejects(read(a, target), /Another task workspace/);
    await assert.rejects(execute(a, 'edit_file', { path: target, old_text: 'SIBLING', new_text: 'MODIFIED' }), /Another task workspace|symlinks|junctions/);
    await assert.rejects(execute(a, 'write_file', { path: target + '.new', content: 'bad' }), /Another task workspace|symlinks|junctions/);
  }
  await assert.rejects(execute(a, 'list_files', { path: path.join(project, '.class-runs') }), /Another task workspace/);
  for (const name of ['glob', 'grep']) {
    await assert.rejects(execute(a, name, { path: second, pattern: name === 'glob' ? '**/*' : 'SIBLING' }), /Another task workspace/);
    const output = JSON.parse((await execute(a, name, { path: project, pattern: name === 'glob' ? '**/*' : 'CONTENT', include_hidden: true })).output);
    assert.ok(!JSON.stringify(output).includes('private.txt')); assert.ok(!JSON.stringify(output).includes('SIBLING_PRIVATE_CONTENT'));
    assert.ok(JSON.stringify(output).includes('shared.txt'));
  }
  assert.equal(await fs.readFile(path.join(second, 'private.txt'), 'utf8'), 'SIBLING_PRIVATE_CONTENT');
  assert.deepEqual(await fs.readdir(second), ['private.txt']);
});

test('a configured project junction preserves run isolation and normal project file access', async t => {
  const { directory, project, first, second, manager } = await fixture(t);
  const alias = path.join(directory, 'project-alias'); await fs.symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const a = manager(path.join(alias, '.class-runs', 'run-a'), alias);
  await fs.writeFile(path.join(second, 'private.txt'), 'private');
  await assert.rejects(read(a, path.join(alias, '.class-runs', 'run-b', 'private.txt')), /Another task workspace/);
  await assert.rejects(execute(a, 'write_file', { path: path.join(alias, '.class-runs', 'run-b', 'new.txt'), content: 'bad' }), /Another task workspace/);
  await execute(a, 'write_file', { path: 'own.txt', content: 'own' });
  assert.equal(await fs.readFile(path.join(first, 'own.txt'), 'utf8'), 'own');
  await execute(a, 'write_file', { path: path.join(alias, 'shared.txt'), content: 'explicit shared file' });
  assert.equal(await read(a, path.join(project, 'shared.txt')), 'explicit shared file');
});

test('all teacher/student model stages receive workspace input without changing their system prompts', async t => {
  const { a, project, manager } = await fixture(t), legacy = manager(project);
  const records = [];
  t.mock.method(ModelClient.prototype, 'json', async (system, input, signal, options) => {
    records.push({ system, input });
    const names = options.tools.map(item => item.name);
    if (names.includes('submit_answer')) return { type: 'continue', content: 'fixture' };
    if (names.includes('vote')) return { approve: true, reason: 'fixture' };
    if (names.includes('define_acceptance')) return { criteria: [{ id: 'one', description: 'fixture', evidenceType: 'text' }] };
    if (names.includes('merge_discoveries')) return { groups: [{ content: 'fixture', proposerIds: ['student'] }] };
    return { valid: false, report: 'fixture' };
  });
  const provider = { protocol: 'chat', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-only' };
  for (const tools of [legacy, a]) {
    const student = createStudent({ id: 'student' }, provider, tools), teacher = createTeacher({ id: 'teacher' }, provider, tools);
    const ctx = { task: 'workspace fixture', tools, signal: new AbortController().signal, blackboard: [], history: [], feedbackHistory: [], checkpoint: async () => {} };
    await student.solve(ctx); await student.vote({ content: 'fixture' }, ctx);
    await teacher.extractCriteria(ctx.task, ctx); await teacher.merge([{ studentId: 'student', content: 'fixture' }], ctx); await teacher.judge({ content: 'fixture' }, ctx);
  }
  assert.equal(records.length, 10);
  for (let i = 0; i < 5; i++) {
    assert.equal(records[i].input.workspace, undefined); assert.equal(records[i].system, records[i + 5].system);
    assert.equal(records[i + 5].input.workspace.cwd, a.cwd); assert.equal(records[i + 5].input.workspace.projectRoot, project);
    assert.match(records[i + 5].input.workspace.instructions, /其他任务/);
  }
});
