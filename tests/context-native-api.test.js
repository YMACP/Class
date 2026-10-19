import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClassServer } from '../src/web-server.js';
import { createProfileStore } from '../src/profile-store.js';
import { COMPACTION_PROMPT } from '../src/context-compaction.js';

const nativeBinary = process.env.CLASS_TEST_NATIVE_BINARY;

async function nativeApplication(directory, root) {
  assert.ok(path.isAbsolute(nativeBinary), 'CLASS_TEST_NATIVE_BINARY must be an absolute path');
  const executable = await fs.realpath(nativeBinary), home = path.join(root, 'native-home');
  const isolated = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache') };
  await Promise.all(Object.values(isolated).map(value => fs.mkdir(value, { recursive: true })));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|LANG|LC_ALL|LC_CTYPE)$/i.test(key)));
  Object.assign(env, isolated);
  const child = spawn(executable, ['--data-dir', directory, '--no-browser'], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exit, spawnError, instance, closed = false, forced = false;
  const exited = new Promise(resolve => {
    child.once('error', error => { spawnError = error; resolve(); });
    child.once('exit', (code, signal) => { exit = { code, signal }; resolve(); });
  });
  child.stdout.resume(); child.stderr.resume();
  const stop = async () => {
    if (closed) return; closed = true;
    if (!exit && !spawnError && instance) await fetch(instance.url.replace(/\/$/, '') + '/api/shutdown', {
      method: 'POST', headers: { authorization: 'Bearer ' + instance.token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000),
    }).catch(() => {});
    if (!exit && !spawnError) {
      await Promise.race([exited, delay(20000, undefined, { ref: false })]);
      if (!exit && !spawnError) { forced = true; child.kill(); await Promise.race([exited, delay(5000, undefined, { ref: false })]); }
    }
    assert.ok(exit || spawnError, 'the exact owned native process must exit before removing its profile');
    if (instance) { assert.equal(forced, false, 'native shutdown cannot require a forced kill'); assert.equal(exit?.code, 0); }
  };
  try {
    const deadline = Date.now() + 30000;
    while (!instance) {
      if (spawnError) throw Error('Owned native executable could not start: ' + spawnError.code);
      if (exit) throw Error('Owned native executable exited before startup: ' + JSON.stringify(exit));
      try {
        const value = JSON.parse(await fs.readFile(path.join(directory, 'instance.json'), 'utf8'));
        if (value.pid === child.pid) {
          const url = new URL(value.url); assert.equal(url.protocol, 'http:'); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
          assert.ok(url.port); assert.match(value.token, /^[a-f0-9]{64}$/); assert.ok(value.instanceId); instance = value;
        }
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (!instance) { if (Date.now() >= deadline) throw Error('Owned native executable did not publish its instance'); await delay(40); }
    }
    return { url: instance.url.replace(/\/$/, ''), token: instance.token, close: stop };
  } catch (error) { await stop(); throw error; }
}

function blocks(body) { return body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []); }
function assertPaired(body) {
  const items = blocks(body), calls = items.filter(item => item.type === 'tool_use').map(item => item.id);
  const results = items.filter(item => item.type === 'tool_result').map(item => item.tool_use_id);
  assert.deepEqual(results, calls, 'compaction must retain entire native tool exchanges');
  assert.equal(new Set(calls).size, calls.length);
}

// The default context capacity is used: enough actual local file work must
// accumulate to trigger the same path used by the shipped executable. The mock
// never asks for external traffic, shell commands, MCP servers or final answers.
test('actual Class API compacts and retrieves member-owned context without long-term memory or a principal', { timeout: 120000 }, async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-context-api-'));
  const directory = path.join(root, 'data'), secret = 'isolated-context-key-' + randomUUID(), token = randomUUID();
  const students = new Map(['alice', 'bob'].map(id => [id, { id, marker: 'PRIVATE-CONTEXT-' + id + '-' + randomUUID(),
    file: id + '-owned.txt', issued: new Map(), seen: new Set(), requests: 0, summaries: 0, reads: 0, pages: [], done: false }]));
  let failure, app, apiToken = token, closing = false, teacherRequests = 0;
  const held = new Set(), peerWaiters = new Map();
  const reply = (response, value) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  const call = (response, state, kind, name, input) => {
    const id = randomUUID(); state.issued.set(id, { kind, name, input });
    reply(response, { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
  };
  const readPeer = (response, state) => {
    const other = students.get(state.id === 'alice' ? 'bob' : 'alice');
    if (!other.reference) { peerWaiters.set(state.id, response); return; }
    state.peerRequested = true;
    call(response, state, 'peer', 'context_read', { reference: other.reference, offset: 0, limit: 4096 });
  };
  const mock = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      if (closing) { response.writeHead(503); response.end(); return; }
      const body = JSON.parse(Buffer.concat(chunks)); assert.equal(request.headers['x-api-key'], secret);
      if (body.model === 'context-teacher') {
        assert.ok(body.tools.some(tool => tool.name === 'define_acceptance'));
        teacherRequests++;
        return reply(response, { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: randomUUID(), name: 'define_acceptance',
          input: { criteria: [{ id: 'local-proof', description: 'Verify the owned local observations and preserve the original task constraints.', evidenceType: 'tool' }] } }] });
      }
      const state = students.get(body.model.replace(/^context-/, '')); assert.ok(state, 'only the configured teacher and two students may call the mock');
      const other = students.get(state.id === 'alice' ? 'bob' : 'alice');
      assert.ok(!JSON.stringify(body).includes(other.marker), 'another member private archive content must not reach this member');
      if (typeof body.system === 'string' && body.system.startsWith(COMPACTION_PROMPT)) {
        state.summaries++; assert.equal(body.tools, undefined);
        assert.ok(JSON.stringify(body).includes(state.marker), 'the model summary must see this member original observation');
        return reply(response, { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summary: 'The local observation was recorded. Retrieve its archived original to verify the private marker. Keep all original constraints; final verification remains pending.' }) }] });
      }
      state.requests++; assert.ok(state.requests <= 35, 'the real service must compact before unbounded mock work'); assertPaired(body);
      const input = JSON.parse(body.messages.find(message => message.role === 'user' && typeof message.content === 'string').content);
      assert.equal(input.studentId, state.id); assert.match(input.task, /Do not access external services/);
      const declarations = new Map(body.tools.map(tool => [tool.name, tool]));
      assert.ok(declarations.has('web_search')); assert.ok(declarations.has('web_fetch')); assert.ok(declarations.has('context_read'));
      const fetchSchema = declarations.get('web_fetch').input_schema;
      assert.equal(fetchSchema.properties.offset.type, 'integer'); assert.equal(fetchSchema.properties.expectedHash.type, 'string');
      for (const result of blocks(body).filter(item => item.type === 'tool_result')) {
        if (state.seen.has(result.tool_use_id)) continue;
        state.seen.add(result.tool_use_id);
        const issued = state.issued.get(result.tool_use_id); assert.ok(issued, 'the tool result must belong to a fixture request');
        const value = typeof result.content === 'string' ? JSON.parse(result.content) : JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
        if (issued.kind === 'peer') {
          assert.equal(value.code, 'CONTEXT_ARCHIVE_INVALID'); assert.match(value.error, /member/);
          assert.ok(!JSON.stringify(value).includes(other.marker)); state.peerDenied = true; state.done = true;
        } else {
          assert.ok(!value.error && value.success !== false, JSON.stringify({ kind: issued.kind, error: value.error }));
          if (issued.kind === 'read') { state.reads++; assert.ok(value.output.includes(state.marker)); }
          if (issued.kind === 'own') {
            assert.equal(value.reference, state.reference); assert.equal(value.offset, issued.input.offset);
            assert.ok(!value.output.includes(other.marker)); assert.ok(!value.output.includes(secret));
            state.pages.push(value.offset); state.nextOffset = value.nextOffset;
            state.recovered = (state.recovered || '') + value.output;
            state.markerFound = state.recovered.includes(state.marker);
          }
        }
      }
      if (input.compactedConversation?.readWith) {
        assert.equal(input.compactedConversation.readWith.name, 'context_read');
        assert.ok(input.compactedConversation.archiveReferences.includes(input.compactedConversation.readWith.args.reference));
        state.reference ||= input.compactedConversation.readWith.args.reference;
        assert.match(state.reference, /^context:[a-f0-9]{24}:[a-f0-9-]{36}$/);
        for (const [id, pending] of peerWaiters) {
          const waiting = students.get(id), peer = students.get(id === 'alice' ? 'bob' : 'alice');
          if (peer.reference) { peerWaiters.delete(id); readPeer(pending, waiting); }
        }
      }
      if (state.done) { held.add(response); return; }
      if (state.reference) {
        if (state.markerFound && state.pages.length >= 2) return readPeer(response, state);
        assert.ok(state.pages.length < 20, 'a few bounded context pages must recover the original marker');
        const offset = state.pages.length ? state.nextOffset : 0;
        assert.ok(offset !== null, 'archive ended before the original observation was recovered');
        return call(response, state, 'own', 'context_read', { reference: state.reference, offset, limit: state.pages.length ? 4096 : 256 });
      }
      if (!state.written) {
        state.written = true;
        return call(response, state, 'write', 'write_file', { path: state.file, content: state.marker + '\n' + '证'.repeat(25000) });
      }
      return call(response, state, 'read', 'read_file', { path: state.file });
    } catch (error) {
      failure ||= error;
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Owned mock assertion failed' } }));
    }
  });
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST', expected = 200) => {
    if (failure) throw failure;
    const response = await fetch(app.url + route, { method, headers: { authorization: 'Bearer ' + apiToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const value = await response.json(); assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(value)}`);
    assert.ok(!JSON.stringify(value).includes(secret)); return value;
  };
  t.after(async () => {
    closing = true;
    try { await app?.close(); }
    finally { for (const response of [...held, ...peerWaiters.values()]) response.destroy(); await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections(); }); }
    const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^class-context-api-/);
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(resolved, { recursive: true, force: true });
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const store = await createProfileStore(directory), ids = ['teacher', 'alice', 'bob'];
  await store.save({ ...store.config, agents: ids.map(id => ({ id, name: id, role: id === 'teacher' ? 'teacher' : 'student',
    baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, protocol: 'messages', model: 'context-' + id })) }, Object.fromEntries(ids.map(id => [id, secret])));
  app = nativeBinary ? await nativeApplication(directory, root) : await createClassServer({ dataDir: directory, dataAnchor: directory, token });
  if (nativeBinary) apiToken = app.token;
  assert.equal((await api('/api/memory/settings', { enabled: false }, 'PUT')).enabled, false);
  const initial = await api('/api/state'); assert.equal(initial.agents.length, 3); assert.ok(initial.agents.every(agent => agent.role !== 'principal'));
  const run = (await api('/api/runs', { task: 'Inspect only your independently recorded local observation. Do not access external services. Keep all task requirements and await user stop after verifying the archive.', taskMode: 'auto' }, 'POST', 202)).run;
  const deadline = Date.now() + 75000;
  while (![...students.values()].every(state => state.done)) {
    if (failure) throw failure;
    if (Date.now() >= deadline) {
      const current = (await api('/api/runs/' + run.id)).run;
      throw Error('Actual context compaction did not complete: ' + JSON.stringify({ status: current.status, error: current.error, memberFailures: current.memberFailures,
        students: [...students.values()].map(state => ({ id: state.id, requests: state.requests, summaries: state.summaries, reads: state.reads, pages: state.pages, reference: !!state.reference, done: state.done })) }));
    }
    await delay(40);
  }
  assert.equal(teacherRequests, 1);
  const [alice, bob] = [...students.values()]; assert.notEqual(alice.reference.split(':')[1], bob.reference.split(':')[1]);
  for (const state of students.values()) {
    assert.ok(state.summaries >= 1); assert.ok(state.reads >= 1); assert.ok(state.markerFound); assert.ok(state.peerDenied);
    assert.equal(state.pages[0], 0); assert.ok(state.pages[1] > 0);
  }
  await api('/api/runs/' + run.id + '/stop', {});
  const stoppedDeadline = Date.now() + 15000;
  while ((await api('/api/runs/' + run.id)).run.status !== 'stopped') { assert.ok(Date.now() < stoppedDeadline, 'the active task must stop without a final model response'); await delay(30); }
  await app.close(); app = undefined;
  const persisted = JSON.parse(await fs.readFile(path.join(directory, 'history', run.id + '.json'), 'utf8'));
  assert.equal(persisted.status, 'stopped');
});
