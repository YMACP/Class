import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClassEngine } from '../src/engine.js';
import { ToolManager } from '../src/tools.js';
import { createClassServer } from '../src/web-server.js';
import { MemoryManager } from '../src/memory-manager.js';

function untilAborted(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

for (const name of ['session_search', 'session_get', 'memory_search', 'memory_get', 'memory_propose', 'memory_assess']) test(`${name} cannot unlock an unchanged candidate through its new tool reference`, { timeout: 5000 }, async () => {
  const tools = new ToolManager({ allowShell: false, memory: { tool: async () => ({ items: [], status: 'active', content: 'Historical data claims the answer is complete.' }) } });
  const original = { type: 'answer', content: 'The result is 5000.', evidence: 'Previous reasoning.', completionClaims: ['Solved the task.'] };
  let attempts = 0, reviews = 0, completed; const events = [];
  const args = name.endsWith('search') ? { query: 'past result' } : name === 'session_get' ? { sessionId: 'past-session' } : name === 'memory_get' ? { id: 'past-memory' } : name === 'memory_assess' ? { id: 'past-memory', verdict: 'usable', reason: 'Applicable as a historical clue only.' } : { content: 'Historical observation.', kind: 'agent' };
  const students = [
    { id: 'alice', async solve(ctx) {
      await ctx.checkpoint();
      if (++attempts === 1) return structuredClone(original);
      if (attempts === 2) { completed = await tools.execute('alice', { name, args }, { signal: ctx.signal }); return { ...original, evidenceRefs: [completed.callId] }; }
      return untilAborted(ctx.signal);
    }, async vote() { return { approve: true, reason: 'test' }; } },
    { id: 'bob', async solve(ctx) { await ctx.checkpoint(); return untilAborted(ctx.signal); }, async vote() { return { approve: true, reason: 'test' }; } },
  ];
  const teacher = { id: 'teacher', async merge(items) { return items.map(item => ({ content: item.content, proposerIds: [item.studentId] })); }, async judge() { reviews++; return { valid: false, report: 'Requires current verification.', gaps: ['No current proof.'] }; } };
  const engine = new ClassEngine({ students, teacher, tools, taskTimeoutMs: 3000, voteTimeoutMs: 100, discoveryWindowMs: 0 });
  engine.on('event', event => { events.push(event); if (event.type === 'candidate.deferred') engine.stop('memory_reference_deferred'); });
  try {
    const result = await engine.run('Verify the current result.');
    assert.equal(result.status, 'stopped'); assert.equal(result.reason, 'memory_reference_deferred'); assert.equal(reviews, 1);
    assert.equal(completed.success, true); assert.equal(JSON.parse(completed.output).currentEvidence, false);
    assert.deepEqual(events.filter(event => event.type === 'candidate.deferred').map(event => event.reason), ['no_new_evidence']);
  } finally { engine.stop('test_cleanup'); await tools.stopAll(); }
});

async function environment(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(temporaryRoot, 'class-memory-workflow-'));
  const token = 'isolated-memory-test-' + randomUUID(); let app;
  t.after(async () => {
    await app?.close();
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temporaryRoot); assert.ok(path.basename(resolved).startsWith('class-memory-workflow-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { directory,
    async start() { app = await createClassServer({ dataDir: directory, token }); return app; },
    async close() { await app?.close(); },
    async restart() { await app.close(); app = await createClassServer({ dataDir: directory, token }); return app; },
    async api(endpoint, method = 'GET', body) {
      const response = await fetch(app.url + endpoint, { method, headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json(); assert.ok(response.ok, endpoint + ': ' + JSON.stringify(result)); return result;
    },
  };
}
async function waitFor(read, predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout; let value;
  do { value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now() < deadline);
  assert.fail(label + ': ' + JSON.stringify(value));
}
function toolResponse(id, name, args, text = '') {
  return Response.json({ stop_reason: 'tool_use', content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name, input: args }] });
}
function nativeResult(body, id) {
  const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'tool_result' && block.tool_use_id === id);
  assert.ok(result, 'Expected native result for ' + id);
  const outer = JSON.parse(result.content); assert.notEqual(outer.success, false, JSON.stringify(outer));
  return JSON.parse(outer.output);
}

test('native profiles cross workspaces while private records retain member scope and reject context spoofing', async t => {
  const env = await environment(t), memory = new MemoryManager({ dataDir: env.directory });
  let tools;
  try {
    assert.equal(await memory.start(), true);
    const store = await memory.requireStore();
    for (const [id, projectId] of [['past-own', 'project-a'], ['past-foreign', 'project-b']]) store.registerSession({ id, projectId, task: 'Scope fixture', startedAt: '2026-09-20T10:00:00Z' });
    store.upsertRecords('past-own', [
      { id: 'own', agentId: 'alice', role: 'assistant', text: 'scope beacon own' },
      { id: 'other-member', agentId: 'bob', role: 'assistant', text: 'scope beacon private teammate' },
      { id: 'shared-source', role: 'user', shared: true, text: 'scope beacon user prefers concise explanations and the demonstrated skill is checking assumptions.' },
    ]);
    store.upsertRecords('past-foreign', [{ id: 'foreign', agentId: 'alice', role: 'assistant', text: 'scope beacon foreign project' }]);
    tools = new ToolManager({ allowShell: false, memory: memory.forRun({ runId: 'run-' + randomUUID(), projectId: 'project-a', team: { teacher: 'teacher', students: [{ id: 'alice' }, { id: 'bob' }] } }) });
    for (const extra of [{ projectId: 'project-b' }, { studentId: 'bob' }, { role: 'teacher' }, { admin: true }, { profileWide: true }]) {
      await assert.rejects(tools.execute('alice', { name: 'session_search', args: { query: 'scope beacon', ...extra } }), /Unknown memory tool argument/);
    }
    const own = JSON.parse((await tools.execute('alice', { name: 'session_search', args: { query: 'scope beacon' } })).output).data;
    assert.equal(own.total, 3); assert.ok(own.items.some(item => item.text === 'scope beacon own')); assert.ok(own.items.some(item => item.text === 'scope beacon foreign project'));
    assert.ok(!own.items.some(item => item.text.includes('private teammate')));
    const teacher = JSON.parse((await tools.execute('teacher', { name: 'session_search', args: { query: 'scope beacon' } })).output).data;
    assert.equal(teacher.total, 4); assert.ok(teacher.items.some(item => item.sessionId === 'past-foreign'));
    const unknown = await tools.execute('outsider', { name: 'session_search', args: { query: 'scope beacon' } });
    assert.equal(unknown.success, false); assert.equal(unknown.code, 'memory_unavailable');
    const original = own.items.find(item => item.text === 'scope beacon own'), sharedSource = own.items.find(item => item.shared);
    const saved = JSON.parse((await tools.execute('alice', { name: 'memory_propose', args: { content: 'Own historical observation.', kind: 'agent', sourceRefs: [original.reference] } })).output).data;
    assert.equal(saved.status, 'active'); assert.equal(saved.agentId, 'alice'); assert.equal(saved.kind, 'agent');
    for (const kind of ['user', 'agent']) {
      const shared = JSON.parse((await tools.execute('teacher', { name: 'memory_propose', args: { content: kind === 'user' ? 'Shared profile: user prefers concise explanations.' : 'Shared profile: check assumptions before applying a remembered skill.', kind, sourceRefs: [sharedSource.reference] } })).output).data;
      assert.equal(shared.kind, kind); assert.equal(shared.agentId, null);
    }
    const privateSource = teacher.items.find(item => item.text.includes('private teammate'));
    const privateMemory = JSON.parse((await tools.execute('bob', { name: 'memory_propose', args: { content: 'Private bob skill.', kind: 'agent', sourceRefs: [privateSource.reference] } })).output).data;
    tools.memory = memory.forRun({ runId: 'run-' + randomUUID(), projectId: 'different-workspace', team: { teacher: 'teacher', students: [{ id: 'alice' }, { id: 'bob' }] } });
    const profiles = JSON.parse((await tools.execute('alice', { name: 'memory_search', args: { query: 'shared profile' } })).output).data;
    assert.equal(profiles.total, 2); assert.deepEqual(profiles.items.map(item => item.kind).sort(), ['agent', 'user']);
    assert.equal(JSON.parse((await tools.execute('alice', { name: 'session_get', args: { reference: privateSource.reference } })).output).data, null);
    assert.equal(JSON.parse((await tools.execute('alice', { name: 'memory_get', args: { id: privateMemory.id } })).output).data, null);
    assert.equal(JSON.parse((await tools.execute('alice', { name: 'memory_search', args: { query: 'private bob skill' } })).output).data.total, 0);
    const found = JSON.parse((await tools.execute('alice', { name: 'memory_search', args: { query: 'historical observation' } })).output);
    assert.equal(found.data.total, 1); assert.equal(found.requiresAssessment, true); assert.deepEqual(found.data.items[0].sourceRefs, [original.reference]);
    const assessed = JSON.parse((await tools.execute('alice', { name: 'memory_assess', args: { id: saved.id, verdict: 'invalid', reason: 'The original source only records a scope beacon; it does not support this inferred observation.', sourceRefs: [original.reference] } })).output);
    assert.equal(assessed.requiresAssessment, false); assert.equal(assessed.currentEvidence, false);
    assert.equal(JSON.parse((await tools.execute('alice', { name: 'memory_search', args: { query: 'historical observation' } })).output).data.total, 0);
    assert.equal(JSON.parse((await tools.execute('alice', { name: 'memory_get', args: { id: saved.id } })).output).data, null);
  } finally { await tools?.stopAll(); await memory.close(); }
});

test('HTTP restart preserves arbitrary visible history for native retrieval while teacher rejection still resumes the task', { timeout: 45000 }, async t => {
  const env = await environment(t), originalFetch = globalThis.fetch;
  const marker = 'BEACON-' + randomUUID(), sourceText = 'Archive beacon: ' + marker;
  let phase = 1, sourceRun, sourceReference, aliceRequests = 0, reviewRequests = 0;
  const retrieval = [], feedbackVersions = [], modelErrors = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (new URL(url).hostname !== 'memory-workflow-model.invalid') return originalFetch(url, options);
    const body = JSON.parse(options.body);
    if (body.model === 'bob') return untilAborted(options.signal);
    try {
      const input = JSON.parse(body.messages.find(message => message.role === 'user' && typeof message.content === 'string').content);
      if (['extract', 'reflect'].includes(input.type) && Array.isArray(input.sources)) return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"memories":[]}' }] });
      if (body.model === 'teacher') {
        reviewRequests++;
        if (phase === 1) return toolResponse('initial-review', 'submit_review', { valid: true, report: 'Recorded the requested result.', answer: 'Archive complete.' });
        if (reviewRequests === 1) return toolResponse('recall-review-reject', 'submit_review', { valid: false, report: 'Clarify that the identifier came from the original archived source, not current external verification.', gaps: ['Source attribution'], recommendations: ['Revise the final wording using the already retrieved source.'] });
        assert.ok(input.answer.content.includes(marker));
        assert.ok(input.answer.content.includes(sourceReference));
        return toolResponse('recall-review-accept', 'submit_review', { valid: true, report: 'The revised wording correctly cites the original archive.', answer: input.answer.content });
      }
      assert.equal(body.model, 'alice'); aliceRequests++;
      if (phase === 1) {
        if (aliceRequests === 1) return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: sourceText }] });
        return toolResponse('initial-answer', 'submit_answer', { content: 'Archive complete.' });
      }
      feedbackVersions.push(input.feedbackVersion);
      if (aliceRequests === 1) return toolResponse('history-search', 'session_search', { query: 'archive beacon', sessionId: sourceRun, kind: 'conversation', limit: 100 });
      if (aliceRequests === 2) {
        const result = nativeResult(body, 'history-search'); retrieval.push(result);
        assert.equal(result.currentEvidence, false);
        const hit = result.data.items.find(item => item.role === 'assistant' && item.text.includes(sourceText));
        assert.ok(hit, 'Original public reply must be searchable'); assert.equal(hit.sessionId, sourceRun);
        sourceReference = hit.reference;
        return toolResponse('history-get', 'session_get', { reference: sourceReference });
      }
      if (aliceRequests === 3) {
        const result = nativeResult(body, 'history-get'); retrieval.push(result);
        assert.equal(result.data.session.id, sourceRun);
        assert.ok(result.data.items.some(record => record.reference === sourceReference && record.text.includes(marker)));
        return toolResponse('recall-answer-one', 'submit_answer', { content: 'The previous identifier is ' + marker + '.' });
      }
      assert.equal(input.feedbackVersion, 1, 'Teacher rejection must return feedback to the same student');
      return toolResponse('recall-answer-two', 'submit_answer', { content: 'The identifier recorded in the original archive is ' + marker + '. Source: ' + sourceReference + '. This recalls the past conversation.' });
    } catch (error) { modelErrors.push(error); throw error; }
  });
  await env.start();
  const members = {};
  for (const [model, role] of [['teacher', 'teacher'], ['alice', 'student'], ['bob', 'student']]) {
    members[model] = (await env.api('/api/agents', 'POST', { name: model, role, model, protocol: 'messages', baseUrl: 'https://memory-workflow-model.invalid/v1', apiKey: 'isolated-workflow-model-key' })).agent;
  }
  await env.api('/api/memory/status');
  sourceRun = (await env.api('/api/runs', 'POST', { task: 'Record a visible result for later retrieval.' })).run.id;
  const first = await waitFor(() => env.api('/api/state'), state => state.run?.id === sourceRun && !['running', 'stopping'].includes(state.run.status), 'first run completion');
  assert.equal(first.run.status, 'completed', JSON.stringify(first.run));
  await env.restart(); phase = 2; aliceRequests = 0; reviewRequests = 0;
  const indexed = await waitFor(() => env.api('/api/memory/sessions/search', 'POST', { query: 'archive beacon', sessionId: sourceRun, kind: 'conversation', limit: 100 }), result => result.items?.some(item => item.role === 'assistant' && item.text.includes(sourceText)), 'restart indexing');
  assert.ok(indexed.items.some(item => item.agentId === members.alice.id));
  const run = (await env.api('/api/runs', 'POST', { task: 'Retrieve the identifier from the earlier archive beacon and state its exact historical source.' })).run;
  const second = await waitFor(() => env.api('/api/state'), state => state.run?.id === run.id && !['running', 'stopping'].includes(state.run.status), 'second run completion', 20000);
  assert.deepEqual(modelErrors, []); assert.equal(second.run.status, 'completed', JSON.stringify(second.run));
  assert.equal(reviewRequests, 2); assert.equal(second.run.reviewRound, 2); assert.equal(second.run.feedbackVersion, 1);
  assert.equal(aliceRequests, 4); assert.equal(retrieval.length, 2); assert.ok(feedbackVersions.includes(1));
  assert.ok(second.run.result.answer.includes(marker)); assert.ok(second.run.result.answer.includes(sourceReference));
  const journal = (await fs.readFile(path.join(env.directory, 'history', run.id, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const completed = journal.filter(record => record.kind === 'tool' && record.activity?.type === 'completed');
  assert.deepEqual(completed.map(record => record.activity.action.name), ['session_search', 'session_get']);
});

for (const condition of ['disabled', 'inaccessible']) test(`HTTP demo completes when the optional memory store is ${condition}`, { timeout: 20000 }, async t => {
  const env = await environment(t), directory = path.join(env.directory, 'memory');
  if (condition === 'disabled') { await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ enabled: false, autoExtract: false })); }
  else await fs.writeFile(directory, 'This owned fixture intentionally blocks the optional memory directory.');
  await env.start();
  const status = await env.api('/api/memory/status');
  if (condition === 'disabled') assert.equal(status.enabled, false);
  else { assert.equal(status.available, false); assert.ok(status.error); }
  const started = await env.api('/api/runs', 'POST', { demo: true });
  const result = await waitFor(() => env.api('/api/state'), state => state.run?.id === started.run.id && !['running', 'stopping'].includes(state.run.status), 'demo completion');
  assert.equal(result.run.status, 'completed', JSON.stringify(result.run)); assert.equal(result.run.result.answer, '5050');
});

test('disabling memory removes native declarations while normal model-driven teacher acceptance still completes', { timeout: 20000 }, async t => {
  const env = await environment(t), originalFetch = globalThis.fetch;
  const directory = path.join(env.directory, 'memory'); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ enabled: false, autoExtract: false }));
  const observed = [], errors = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (new URL(url).hostname !== 'memory-disabled-model.invalid') return originalFetch(url, options);
    const body = JSON.parse(options.body);
    try {
      observed.push(body.model);
      assert.ok(!body.tools.some(tool => /^(?:memory_|session_)/.test(tool.name)), 'Disabled memory must not advertise tools');
      if (body.model === 'bob') return untilAborted(options.signal);
      if (body.model === 'teacher') return toolResponse('disabled-review', 'submit_review', { valid: true, report: 'Current task verification passed.', answer: 'normal workflow complete' });
      return toolResponse('disabled-answer', 'submit_answer', { content: 'normal workflow complete' });
    } catch (error) { errors.push(error); throw error; }
  });
  await env.start(); assert.equal((await env.api('/api/memory/status')).enabled, false);
  for (const [model, role] of [['teacher', 'teacher'], ['alice', 'student'], ['bob', 'student']]) {
    await env.api('/api/agents', 'POST', { name: model, role, model, protocol: 'messages', baseUrl: 'https://memory-disabled-model.invalid/v1', apiKey: 'isolated-disabled-memory-key' });
  }
  const id = (await env.api('/api/runs', 'POST', { task: 'Complete the ordinary test task.' })).run.id;
  const result = await waitFor(() => env.api('/api/state'), state => state.run?.id === id && !['running', 'stopping'].includes(state.run.status), 'model run with memory disabled');
  assert.deepEqual(errors, []); assert.equal(result.run.status, 'completed'); assert.equal(result.run.result.answer, 'normal workflow complete');
  assert.ok(observed.includes('alice')); assert.ok(observed.includes('teacher')); assert.equal(result.run.reviewRound, 1);
});

test('clearing a completed task with inaccessible memory records deletion and prevents stale archive reimport after repair', { timeout: 20000 }, async t => {
  const env = await environment(t), blocked = path.join(env.directory, 'memory');
  await fs.writeFile(blocked, 'Owned fixture: the optional database directory is inaccessible.');
  await env.start(); assert.equal((await env.api('/api/memory/status')).available, false);
  const id = (await env.api('/api/runs', 'POST', { demo: true })).run.id;
  const completed = await waitFor(() => env.api('/api/state'), state => state.run?.id === id && !['running', 'stopping'].includes(state.run.status), 'demo completion');
  assert.equal(completed.run.status, 'completed');
  const summaryFile = path.join(env.directory, 'history', id + '.json'), archiveDir = path.join(env.directory, 'history', id);
  const summary = await fs.readFile(summaryFile), journal = await fs.readFile(path.join(archiveDir, 'journal.jsonl'));
  const cleared = await env.api('/api/runs/' + id, 'DELETE');
  assert.equal(cleared.ok, true); assert.equal(cleared.deletedId, id); assert.equal(cleared.memoryCleanupPending, true); assert.ok(cleared.warning);
  assert.equal(cleared.run, null); assert.ok(!cleared.history.some(run => run.id === id));
  assert.ok(JSON.parse(await fs.readFile(path.join(env.directory, 'memory-deletions.json'), 'utf8')).includes(id));
  await assert.rejects(fs.access(summaryFile), { code: 'ENOENT' });
  await assert.rejects(fs.access(archiveDir), { code: 'ENOENT' });
  await env.close();
  assert.equal(path.dirname(await fs.realpath(blocked)), await fs.realpath(env.directory));
  assert.ok((await fs.lstat(blocked)).isFile()); await fs.unlink(blocked); await fs.mkdir(blocked);
  // Simulate an old backup reappearing. The durable deletion ledger, rather
  // than absence of source files alone, must keep this session out of memory.
  await fs.mkdir(archiveDir); await fs.writeFile(summaryFile, summary); await fs.writeFile(path.join(archiveDir, 'journal.jsonl'), journal);
  await env.restart();
  await waitFor(() => env.api('/api/memory/status'), status => status.available && !status.indexing && status.pending === 0, 'repaired store indexed');
  const sessions = await env.api('/api/memory/sessions?projectId=*');
  assert.ok(!sessions.items.some(session => session.id === id));
  const search = await env.api('/api/memory/sessions/search', 'POST', { query: '5050', projectId: '*', sessionId: id });
  assert.equal(search.total, 0);
  const another = (await env.api('/api/runs', 'POST', { demo: true })).run.id;
  const resumed = await waitFor(() => env.api('/api/state'), state => state.run?.id === another && !['running', 'stopping'].includes(state.run.status), 'new demo after repair');
  assert.equal(resumed.run.status, 'completed');
});
