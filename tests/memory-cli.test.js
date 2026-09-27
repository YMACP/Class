import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createMemoryStore } from '../src/memory-store.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function message(value) { return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }] }; }
function submission(id, name, input) { return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] }; }

for (const mode of ['automatic', 'extraction-failure', 'no-memory']) test(`CLI ${mode} keeps result persistence and memory work isolated`, { timeout: 25000 }, async t => {
  const temporaryRoot = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temporaryRoot, 'class-memory-cli-'));
  const output = path.join(root, 'profile'), workspace = path.join(root, 'workspace'), configuration = path.join(root, 'config.json');
  const marker = 'CLI-ARCHIVE-' + randomUUID(), answer = 'Historical CLI identifier: ' + marker;
  const errors = [], declarations = [], extractionRefs = [];
  let child, childClosed, store, extractionRequests = 0, teacherRequests = 0, persistedBeforeExtraction = false;
  const server = http.createServer(async (req, res) => {
    const send = (body, status = 200) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); } };
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/messages');
      let content = ''; for await (const chunk of req) { content += chunk; assert.ok(content.length < 2 * 1024 * 1024); }
      const body = JSON.parse(content), input = JSON.parse(body.messages.find(item => item.role === 'user' && typeof item.content === 'string').content);
      if (input.type === 'extract' && Array.isArray(input.sources)) {
        extractionRequests++; assert.equal(mode === 'no-memory', false); assert.equal(body.model, 'teacher');
        const runs = (await fs.readdir(output)).filter(name => name.startsWith('Class-')); assert.equal(runs.length, 1);
        const session = JSON.parse(await fs.readFile(path.join(output, runs[0], 'session.json'), 'utf8'));
        const result = JSON.parse(await fs.readFile(path.join(output, runs[0], 'result.json'), 'utf8'));
        assert.equal(session.status, 'completed'); assert.equal(result.status, 'completed'); assert.equal(result.answer, answer);
        persistedBeforeExtraction = true;
        const source = input.sources.find(item => item.content.includes(answer)); assert.ok(source, 'Completed result must be available as a cited original source');
        extractionRefs.push(source.reference);
        return send(message(mode === 'extraction-failure' ? { memories: null } : { memories: [{ kind: 'agent', category: 'fact', content: answer, sourceRefs: [source.reference] }] }));
      }
      declarations.push({ model: body.model, memoryTools: (body.tools || []).filter(tool => /^(?:memory_|session_)/.test(tool.name)).map(tool => tool.name) });
      if (body.model === 'bob') return; // The CLI aborts its own peer request during review.
      if (body.model === 'alice') return send(submission('cli-answer', 'submit_answer', { content: answer }));
      assert.equal(body.model, 'teacher'); teacherRequests++;
      return send(submission('cli-review', 'submit_review', { valid: true, report: 'Recorded the requested historical identifier.', answer }));
    } catch (error) { errors.push(error.message); send({ error: { message: error.message } }, 400); }
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await childClosed;
    await store?.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved), temporaryRoot); assert.ok(path.basename(resolved).startsWith('class-memory-cli-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(configuration, JSON.stringify({ task: 'Create a historical identifier for the completed CLI task.', cwd: workspace, allowShell: false, taskTimeoutMs: 12000, voteTimeoutMs: 1000, discoveryWindowMs: 0,
    provider: { protocol: 'messages', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'alice', apiKey: 'isolated-cli-fake-key', timeoutMs: 10000 },
    teacher: { id: 'teacher', provider: { model: 'teacher' } }, students: [{ id: 'alice', provider: { model: 'alice' } }, { id: 'bob', provider: { model: 'bob' } }],
  }));
  child = spawn(process.execPath, [cli, '--config', configuration, '--output-dir', output, ...(mode === 'no-memory' ? ['--no-memory'] : [])], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', spawnError;
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-20000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });
  child.once('error', error => { spawnError = error; });
  childClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const timeout = setTimeout(() => child.kill(), 20000);
  let exit; try { exit = await childClosed; } finally { clearTimeout(timeout); }
  assert.equal(spawnError, undefined); assert.deepEqual(errors, []); assert.equal(exit.signal, null); assert.equal(exit.code, 0, stdout + '\n' + stderr);
  assert.equal(teacherRequests, 1);
  const directories = (await fs.readdir(output)).filter(name => name.startsWith('Class-')); assert.equal(directories.length, 1);
  const runDirectory = path.join(output, directories[0]), result = JSON.parse(await fs.readFile(path.join(runDirectory, 'result.json'), 'utf8'));
  assert.equal(result.status, 'completed'); assert.equal(result.answer, answer);
  assert.equal(JSON.parse(await fs.readFile(path.join(runDirectory, 'session.json'), 'utf8')).status, 'completed');
  if (mode === 'no-memory') {
    assert.equal(extractionRequests, 0); assert.ok(declarations.length >= 2); assert.ok(declarations.every(item => item.memoryTools.length === 0));
    await assert.rejects(fs.stat(path.join(output, 'memory')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(runDirectory, 'conversations.jsonl')), { code: 'ENOENT' });
  } else {
    assert.equal(extractionRequests, 1); assert.equal(persistedBeforeExtraction, true);
    assert.ok(declarations.filter(item => item.model !== 'bob').every(item => item.memoryTools.includes('memory_assess')));
    const jobs = JSON.parse(await fs.readFile(path.join(output, 'memory', 'jobs.json'), 'utf8'));
    const job = jobs.find(item => item.type === 'extract' && item.sessionId === directories[0]); assert.ok(job);
    store = await createMemoryStore({ directory: path.join(output, 'memory') });
    const memories = store.memorySearch({ query: marker }, { admin: true });
    if (mode === 'automatic') {
      assert.equal(job.status, 'completed'); assert.equal(memories.total, 1);
      const memory = memories.items[0]; assert.equal(memory.status, 'active'); assert.equal(memory.content, answer); assert.deepEqual(memory.sourceRefs, extractionRefs);
      const source = store.sessionGet({ reference: memory.sourceRefs[0] }, { admin: true }); assert.equal(source.session.id, directories[0]); assert.ok(source.items.some(item => item.text.includes(answer)));
      assert.ok(source.session.metadata.memoryExtractedAt); assert.deepEqual(job.memoryIds, [memory.id]);
    } else {
      assert.equal(job.status, 'failed'); assert.match(job.error, /记忆结果/); assert.equal(memories.total, 0); assert.ok(job.retryAt);
    }
  }
});
