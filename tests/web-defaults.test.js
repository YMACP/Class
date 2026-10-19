import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudent, createTeacher } from '../src/agents.js';
import { ToolManager } from '../src/tools.js';

function toolResponse(protocol, id, name, args) {
  if (protocol === 'messages') return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: args }] });
  if (protocol === 'responses') return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] });
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
}

function latestToolResult(protocol, body) {
  if (protocol === 'responses') return JSON.parse(body.input.filter(item => item.type === 'function_call_output').at(-1).output);
  if (protocol === 'chat') return JSON.parse(body.messages.filter(item => item.role === 'tool').at(-1).content);
  const blocks = body.messages.flatMap(item => Array.isArray(item.content) ? item.content : []);
  return JSON.parse(blocks.filter(item => item.type === 'tool_result').at(-1).content);
}

for (const protocol of ['messages', 'responses', 'chat']) {
  for (const role of ['student', 'teacher']) {
    test(`${protocol}: fresh and restored ${role} can search and read sources with default tools`, { timeout: 10000 }, async t => {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const cwd = await fs.mkdtemp(path.join(temporaryRoot, 'class-web-defaults-'));
      const managers = [];
      let searches = 0, reads = 0;
      const server = http.createServer((request, response) => {
        const url = new URL(request.url, origin);
        if (url.pathname === '/search') {
          searches++;
          assert.equal(url.searchParams.get('q'), 'Class public search fixture');
          response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
          response.end(`<rss><channel><item><title>Public source fixture</title><link>${origin}/source</link><description>A source to verify.</description></item></channel></rss>`);
        } else if (url.pathname === '/source') {
          reads++;
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end('<html><head><title>Source fixture</title></head><body><p>The verified fixture value is 42.</p></body></html>');
        } else {
          response.writeHead(404); response.end();
        }
      });
      t.after(async () => {
        for (const manager of managers) await manager.stopAll();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        const resolved = await fs.realpath(cwd);
        assert.equal(path.dirname(resolved), temporaryRoot);
        assert.ok(path.basename(resolved).startsWith('class-web-defaults-'));
        await fs.rm(resolved, { recursive: true, force: true });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const origin = `http://127.0.0.1:${server.address().port}`;
      const provider = { protocol, model: 'fixture-model', baseUrl: 'https://class-model.invalid/v1', apiKey: 'fixture-key', timeoutMs: null };
      let step = 0, cycle = 0;
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(new URL(url).hostname, 'class-model.invalid');
        const body = JSON.parse(options.body);
        const declarations = body.tools.map(tool => tool.function?.name || tool.name);
        assert.ok(declarations.includes('web_search'));
        assert.ok(declarations.includes('web_fetch'));
        assert.ok(!declarations.includes('run_command'));
        if (step++ === 0) return toolResponse(protocol, `search-${cycle}`, 'web_search', { query: 'Class public search fixture' });
        const result = latestToolResult(protocol, body);
        assert.equal(result.untrusted, true);
        assert.ok(result.callId, 'web results pass through the normal tool execution identity');
        assert.ok(result.output.includes(origin + '/source'), 'the model receives a source URL');
        if (step === 2) {
          assert.equal(result.name, 'web_search');
          assert.equal(result.resultCount, 1);
          return toolResponse(protocol, `fetch-${cycle}`, 'web_fetch', { url: origin + '/source' });
        }
        assert.equal(step, 3);
        assert.equal(result.name, 'web_fetch');
        assert.match(result.output, /verified fixture value is 42/);
        return role === 'student'
          ? toolResponse(protocol, `answer-${cycle}`, 'submit_answer', { content: `The verified value is 42. Source: ${origin}/source` })
          : toolResponse(protocol, `review-${cycle}`, 'submit_review', { valid: true, report: 'Verified against the fetched source.', answer: `The verified value is 42. Source: ${origin}/source` });
      });

      let snapshot;
      for (cycle = 0; cycle < 2; cycle++) {
        step = 0;
        // Only the network transport is redirected to an isolated fixture.
        // No allowShell, MCP server, search API key or web enable flag is set.
        const tools = new ToolManager({ cwd, webOptions: { proxyEnv: {}, allowedPrivateOrigins: [origin], searchProviders: [{ name: 'Fixture', format: 'rss', url: origin + '/search?q={query}' }] } });
        managers.push(tools);
        const agent = (role === 'student' ? createStudent : createTeacher)({ id: role, name: role }, provider, tools);
        if (snapshot) agent.importState(snapshot);
        const ctx = { task: 'Search the public web and verify the fixture value, citing its source.', blackboard: [], signal: new AbortController().signal };
        const result = role === 'student' ? await agent.solve(ctx) : await agent.judge({ content: 'The value is 42.' }, ctx);
        assert.equal(step, 3);
        assert.match(result.content || result.answer, /verified value is 42/);
        snapshot = agent.exportState();
      }
      assert.equal(searches, 2);
      assert.equal(reads, 2);
    });
  }
}
