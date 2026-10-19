// Native 1.2.0 acceptance: local MCP/LLM fixtures only, no existing user data.
// node tests/release/verify-state-release.js /absolute/path/to/Class[.exe]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const executable = await fs.realpath(path.resolve(process.argv[2]));
const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-native-state-'));
const profile = path.join(directory, 'profile'); await fs.mkdir(profile, { mode: 0o700 });
let child, exit, instance, failure, fixtureFailure, resumed = false, stage = 0, criteriaCalls = 0, mcpCalls = 0, held = false, writeReceipt;
const transcript = [], tool = (res, name, input) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: randomUUID(), name, input }] })); };
const mock = http.createServer(async (req, res) => {
  try {
    const parts = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts));
    if (req.url === '/mcp') {
      assert.equal(req.headers.authorization, 'Bearer isolated-extension-secret');
      if (body.id === undefined) { res.writeHead(202); res.end(); return; }
      let result;
      if (body.method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } };
      else if (body.method === 'tools/list') result = { tools: [{ name: 'value', description: 'Read local fixture value', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
      else { assert.equal(body.method, 'tools/call'); assert.equal(body.params.name, 'value'); mcpCalls++; result = { content: [{ type: 'text', text: '42' }] }; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return;
    }
    const names = body.tools.map(item => item.name);
    if (names.includes('define_acceptance')) { criteriaCalls++; return tool(res, 'define_acceptance', { criteria: [{ id: 'file', description: 'Save the fixture value 42 to result.txt.', evidenceType: 'tool' }] }); }
    if (body.model === 'bob') { assert.ok(!names.includes('search_tools')); assert.ok(!names.includes('read_skill')); return; }
    if (body.model === 'alice') {
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
      const last = results.length ? JSON.parse(results.at(-1).content) : null;
      if (resumed) return tool(res, 'submit_answer', { content: 'Saved 42 to result.txt.', evidence: 'The completed write is recorded.', evidenceRefs: [writeReceipt.evidenceRef], completionClaims: ['Saved the requested value'], remainingIssues: [] });
      if (stage++ === 0) { assert.ok(names.includes('read_skill') && names.includes('search_tools')); assert.ok(!names.some(name => name.startsWith('mcp_'))); return tool(res, 'read_skill', { id: 'guide' }); }
      if (stage === 2) { assert.ok(last.output.includes('Read the fixture')); assert.ok(!names.some(name => name.startsWith('mcp_'))); return tool(res, 'search_tools', { mcpId: 'fixture' }); }
      if (stage === 3) { const discovered = JSON.parse(last.output).tools[0]; assert.ok(names.includes(discovered.name)); return tool(res, discovered.name, {}); }
      if (stage === 4) { assert.ok(last.output.includes('42')); return tool(res, 'write_file', { path: 'result.txt', content: '42' }); }
      writeReceipt = last; assert.ok(writeReceipt?.evidenceRef); held = true; return;
    }
    assert.equal(body.model, 'teacher'); assert.ok(!names.includes('search_tools') && !names.includes('read_skill'));
    return tool(res, 'submit_review', { valid: true, answer: 'Saved 42 to result.txt.', report: 'The completed file write contains the requested value.', criteriaResults: [{ criterionId: 'file', status: 'passed', reason: 'The saved write receipt records the file content.', evidenceKind: 'tool', evidenceRefs: [writeReceipt.evidenceRef] }] });
  } catch (error) { fixtureFailure = error; if (!res.headersSent) res.writeHead(500); res.end(); }
});
async function until(check, label) { for (let i = 0; i < 240; i++) { if (fixtureFailure) throw fixtureFailure; const result = await check(); if (result) return result; await delay(50); } throw Error(label + ' timed out'); }
async function launch() {
  instance = undefined;
  child = spawn(executable, ['--data-dir', profile, '--no-browser'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => transcript.push(chunk.toString().slice(0, 2000)));
  exit = new Promise(resolve => { child.once('error', error => resolve({ error })); child.once('exit', code => resolve({ code })); });
  await until(async () => {
    assert.equal(child.exitCode, null, transcript.join('').slice(-2000));
    try { const data = JSON.parse(await fs.readFile(path.join(profile, 'instance.json'), 'utf8')); if (data.pid !== child.pid) return false; instance = data; return true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, 'startup');
}
async function api(route, body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
  if (fixtureFailure) throw fixtureFailure;
  const response = await fetch(new URL(route, instance.url), { method, headers: { authorization: 'Bearer ' + instance.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const value = await response.json(); assert.equal(response.status, expected, route + ': ' + JSON.stringify(value)); return value;
}
let report;
try {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); await launch();
  assert.equal((await api('/health')).version, '1.2.0'); await api('/api/memory/settings', { enabled: false }, 'PUT');
  const ids = {};
  for (const name of ['teacher', 'alice', 'bob']) ids[name] = (await api('/api/agents', { name, role: name === 'teacher' ? 'teacher' : 'student', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, protocol: 'messages', model: name, apiKey: 'isolated-model-secret' })).agent.id;
  const extensions = await api('/api/extensions', { revision: 0, mcps: [{ id: 'fixture', name: 'Fixture', transport: 'http', url: `http://127.0.0.1:${mock.address().port}/mcp`, enabled: true, agentIds: [ids.alice], headers: { Authorization: 'Bearer isolated-extension-secret' } }], skills: [{ id: 'guide', name: 'Guide', content: 'Read the fixture value, then save it to result.txt.', enabled: true, agentIds: [ids.alice] }] }, 'PUT');
  assert.ok(!JSON.stringify(extensions).includes('isolated-extension-secret'));
  const run = (await api('/api/runs', { task: 'Read the fixture and save 42 in result.txt.' }, 'POST', 202)).run;
  await until(() => held, 'extension workflow');
  const output = path.join(profile, 'workspace', 'result.txt'), before = await fs.stat(output);
  // Kill this exact owned process while a model request is pending. No stdio MCP or browser was launched.
  child.kill('SIGKILL'); await exit; resumed = true; await launch();
  const state = await api('/api/state'); assert.equal(state.history[0].recoverable, true);
  assert.deepEqual((await api('/api/extensions')).mcps[0].agentIds, [ids.alice]);
  await api(`/api/runs/${run.id}/resume`, {}, 'POST', 202);
  const completed = await until(async () => { const value = await api('/api/state'); return value.run.status === 'completed' ? value : false; }, 'safe recovery');
  assert.equal(completed.run.id, run.id); assert.equal(completed.run.resumeCount, 1); assert.equal(criteriaCalls, 1); assert.equal(mcpCalls, 1);
  assert.equal((await fs.stat(output)).mtimeMs, before.mtimeMs); assert.equal(await fs.readFile(output, 'utf8'), '42');
  const profileText = await fs.readFile(path.join(profile, 'profiles.json'), 'utf8'); assert.ok(!profileText.includes('isolated-extension-secret'));
  await api('/api/shutdown', {}, 'POST', 202); assert.equal((await exit).code, 0);
  report = { passed: true, version: '1.2.0', platform: process.platform, architecture: process.arch, sha256: createHash('sha256').update(await fs.readFile(executable)).digest('hex'), checks: ['native startup', 'encrypted MCP credentials', 'per-Agent authorization', 'lazy Skill and MCP loading', 'real local MCP call', 'crash and safe same-task resume', 'criteria retained', 'completed writes not repeated', 'clean shutdown'] };
} catch (error) { failure = error; }
finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
  await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections(); });
  const actual = await fs.realpath(directory); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('class-native-state-')); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false); await fs.rm(actual, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify(report, null, 2));
