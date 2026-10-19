import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolManager } from '../src/tools.js';
import { toolDefinitions, inspectToolCall } from '../src/tool-contract.js';
import { MCPClient } from '../src/mcp-client.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCLIExtensions } from '../src/cli-extensions.js';
import { prepareExtensionUpdate, ensureBuiltinMcpPresets, normalizeExtensions, BUILTIN_MCP_TYPES } from '../src/extension-config.js';

const schema = { type: 'object', properties: { input: { anyOf: [{ type: 'object' }, { type: 'null' }] }, name: { type: 'string' } }, additionalProperties: true };
const mcp = { id: 'mock', name: 'Mock MCP', enabled: true, agentIds: ['alice'], transport: 'http', url: 'http://127.0.0.1:1/mcp' };
const skill = { id: 'guide', name: 'Guide', description: 'Short directory entry', enabled: true, agentIds: ['alice'], content: 'SECRET_SKILL_BODY\nUse the appropriate diagnostic tools.', mcpIds: ['mock', 'private'] };
const remoteTools = [{ name: 'echo', description: 'Echo input', inputSchema: schema }];
function fakeClientFactory(log) { return (config, options) => ({
  async listTools() { log.push(['list', config.id]); return remoteTools; },
  async callTool(name, args) { log.push(['call', name, args]); return { content: [{ type: 'text', text: JSON.stringify(args) }] }; },
  async close() { log.push(['close', config.id]); }, notify() { options.onToolsChanged(); },
}); }
function managerFor(t, options = {}) { const manager = new ToolManager(options); t.after(() => manager.stopAll()); return manager; }

test('browser preset resolves only its exact default command and forwards configured transports independently', async t => {
  const received=[];
  const defaults={id:'class-browser',name:'browser',builtin:'browser',transport:'stdio',command:'Class',args:['--browser-mcp'],enabled:true,agentIds:['alice']};
  for(const entry of [defaults,{...defaults,command:'other-browser',args:['--mcp']},{...defaults,transport:'http',url:'https://localhost/mcp',skipTlsVerify:true},{...defaults,transport:'sse',url:'https://localhost/sse'}]) {
    const before=received.length;
    const manager=managerFor(t,{extensionConfig:{mcps:[entry]},extensionSecrets:{'class-browser':{env:{SETTING:'fixture=value'},headers:{Authorization:'Bearer fixture'}}},extensionOptions:{clientFactory:(config)=>{
      received.push(config);return {listTools:async()=>remoteTools,close:async()=>{}};
    }}});
    assert.equal(received.length,before,'Configuration and grants must not connect eagerly');
    await manager.execute('alice',{name:'search_tools',args:{mcpId:'class-browser'}});
    assert.ok(!manager.definitionsFor('bob').some(item=>item.name==='search_tools'));
  }
  assert.equal(received[0].command,process.execPath); assert.ok(received[0].args[0].endsWith('browser-mcp-server.js')); assert.equal(received[0].classBrowserMcp,true);
  assert.equal(received[0].env.SETTING,'fixture=value');
  assert.equal(received[1].command,'other-browser'); assert.equal(received[1].classBrowserMcp,undefined);
  assert.equal(received[2].url,'https://localhost/mcp'); assert.equal(received[2].skipTlsVerify,true); assert.equal(received[2].classBrowserMcp,undefined); assert.equal(received[2].headers.Authorization,'Bearer fixture');
  assert.equal(received[3].skipTlsVerify,false);
});

test('extensions remain lazy and isolate directory, skill body, schemas and invocation per member', async t => {
  const log = [], manager = managerFor(t, { extensionConfig: { mcps: [mcp, { ...mcp, id: 'private', name: 'Private catalogue', agentIds: ['bob'] }], skills: [skill] }, extensionOptions: { clientFactory: fakeClientFactory(log) } });
  const alice = manager.definitionsFor('alice'), bob = manager.definitionsFor('bob');
  assert.equal(log.length, 0);
  assert.equal(toolDefinitions(manager).some(item => ['search_tools', 'read_skill'].includes(item.name)), false);
  assert.ok(alice.some(item => item.name === 'search_tools'));
  assert.ok(!JSON.stringify(alice).includes('SECRET_SKILL_BODY'));
  assert.ok(!JSON.stringify(alice).includes('Private catalogue'));
  assert.ok(!JSON.stringify(bob).includes('Guide'));
  await assert.rejects(manager.execute('alice', { name: 'search_tools', args: { mcpId: 'private' } }), /not authorized/);
  await assert.rejects(manager.execute('alice', { name: 'search_tools', args: { agentId: 'bob' } }), /Unknown tool argument/);
  assert.equal(log.length, 0);
  const loaded = JSON.parse((await manager.execute('alice', { name: 'read_skill', args: { id: 'guide' } })).output);
  assert.match(loaded.content, /SECRET_SKILL_BODY/);
  assert.equal(Object.hasOwn(loaded, 'associatedMCPs'), false);
  assert.equal(log.length, 0);
  assert.ok(!manager.definitionsFor('alice').some(item => item.name.startsWith('mcp_')));
  const found = JSON.parse((await manager.execute('alice', { name: 'search_tools', args: {} })).output);
  const name = found.tools[0].name;
  assert.match(name, /^mcp_/); assert.ok(manager.definitionsFor('alice').some(item => item.name === name));
  assert.ok(!manager.definitionsFor('bob').some(item => item.name === name));
  await assert.rejects(manager.execute('bob', { name, args: {} }), /Unknown tool name/);
  const args = { input: { args: { nested: true } }, name: 'literal payload', arbitrary: [1, null, true] };
  await manager.execute('alice', { name, args });
  assert.deepEqual(log.at(-1), ['call', 'echo', args]);
  assert.ok(!log.some(item => item[0] === 'list' && item[1] === 'private'));
  await assert.rejects(manager.execute('bob', { name: 'read_skill', args: { id: 'guide' } }), /Unknown tool name/);
});

test('a Skill-only member can page legacy Skill content without connecting or gaining MCP tools', async t => {
  let clients = 0;
  const manager = managerFor(t, { extensionConfig: { mcps: [{ ...mcp, agentIds: ['bob'] }], skills: [skill] }, extensionOptions: { clientFactory: () => { clients++; throw Error('Skill reads must not create an MCP client'); } } });
  assert.ok(manager.definitionsFor('alice').some(item => item.name === 'read_skill'));
  assert.ok(!manager.definitionsFor('alice').some(item => item.name === 'search_tools'));
  let content = '', offset = 0;
  do {
    const page = JSON.parse((await manager.execute('alice', { name: 'read_skill', args: { id: 'guide', offset, limit: 13 } })).output);
    content += page.content; offset = page.nextOffset;
    assert.equal(Object.hasOwn(page, 'associatedMCPs'), false);
  } while (offset !== null);
  assert.equal(content, skill.content); assert.equal(clients, 0);
  assert.ok(!manager.definitionsFor('alice').some(item => item.name.startsWith('mcp_')));
  await assert.rejects(manager.execute('alice', { name: 'search_tools', args: { mcpId: 'mock' } }), /Unknown tool name/);
  assert.equal(clients, 0);
});

test('configuration is snapshotted, server change invalidates unlocked schema and secrets are redacted from evidence', async t => {
  const config = { mcps: [{ ...mcp, description: 'hidden-test-token' }], skills: [] }, captured = [], clients = [];
  const manager = managerFor(t, { extensionConfig: config, extensionSecrets: { mock: { env: { SECRET: 'hidden-test-token' } } },
    createOutputArtifact: async () => ({ write: async bytes => captured.push(bytes.toString()), close: async () => ({ reference: 'tool-output:1', bytes: captured.join('').length, sha256: 'hash' }) }),
    extensionOptions: { clientFactory: (config, options) => { assert.equal(config.env.SECRET, 'hidden-test-token'); const client = { listTools: async () => remoteTools.map(item => ({ ...item, description: 'hidden-test-token' })), callTool: async () => ({ content: [{ type: 'text', text: 'hidden-test-token' }] }), close: async () => {}, changed: options.onToolsChanged }; clients.push(client); return client; } },
  });
  config.mcps[0].agentIds = ['bob']; config.mcps[0].enabled = false;
  assert.ok(!JSON.stringify(manager.definitionsFor('alice')).includes('hidden-test-token'));
  const result = JSON.parse((await manager.execute('alice', { name: 'search_tools', args: {} })).output), name = result.tools[0].name;
  const called = await manager.execute('alice', { name, args: {} });
  assert.equal(called.outputRef, 'tool-output:1'); assert.ok(!captured.join('').includes('hidden-test-token')); assert.match(called.output, /REDACTED/);
  clients[0].changed(); assert.ok(!manager.definitionsFor('alice').some(item => item.name === name));
  await assert.rejects(manager.execute('alice', { name, args: {} }), /Unknown tool name/);
});

test('MCP arguments preserve rich JSON Schema names and discovery arguments cannot spoof scope', () => {
  const name = 'mcp_example', definitions = [{ name, parameters: schema, extension: true }];
  assert.deepEqual(inspectToolCall(name, { input: null, name: 'other', env: { x: 1 } }, { definitions }).args, { input: null, name: 'other', env: { x: 1 } });
  assert.throws(() => inspectToolCall(name, '{"x":1,"x":2}', { definitions }), /duplicate/);
});

test('large MCP output keeps full evidence while bounded summaries and protocol error status remain usable', async t => {
  let full = '';
  const manager = managerFor(t, { maxOutputBytes: 512, extensionConfig: { mcps: [mcp], skills: [] }, createOutputArtifact: async () => ({ write: async bytes => { full = bytes.toString(); }, close: async () => ({ reference: 'tool-output:large', bytes: Buffer.byteLength(full), sha256: 'digest' }) }),
    extensionOptions: { clientFactory: () => ({ listTools: async () => remoteTools, callTool: async () => ({ isError: true, content: [{ type: 'text', text: '中'.repeat(10000) }] }), close: async () => {} }) },
  });
  await manager.execute('alice', { name: 'search_tools', args: {} });
  const name = manager.definitionsFor('alice').find(item => item.extension).name;
  const result = await manager.execute('alice', { name, args: {} });
  assert.equal(result.success, false); assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.output) <= 512);
  assert.equal(JSON.parse(full).content[0].text.length, 10000); assert.equal(result.outputRef, 'tool-output:large'); JSON.parse(result.output);
});

async function listen(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); }
const initialized = { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'isolated mock', version: '1' } };

test('Streamable HTTP initializes, keeps session headers, paginates and reads SSE results', async t => {
  const calls = [];
  const url = await listen(t, async (req, res) => {
    const request = await body(req); calls.push(request);
    assert.equal(req.headers.authorization, 'Bearer mock-only'); assert.equal(req.headers['mcp-protocol-version'], '2025-06-18');
    if (request.method !== 'initialize') assert.equal(req.headers['mcp-session-id'], 'mock-session');
    if (!request.id) { res.writeHead(202).end(); return; }
    let result;
    if (request.method === 'initialize') { res.setHeader('Mcp-Session-Id', 'mock-session'); result = initialized; }
    else if (request.method === 'tools/list') result = request.params.cursor ? { tools: [{ ...remoteTools[0], name: 'second' }] } : { tools: remoteTools, nextCursor: 'page-two' };
    else result = { content: [{ type: 'text', text: 'done' }] };
    if (request.method === 'tools/call') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })); }
  });
  const client = new MCPClient({ transport: 'http', url, headers: { Authorization: 'Bearer mock-only' } }); t.after(() => client.close());
  assert.equal(calls.length, 0); assert.equal((await client.listTools()).length, 2);
  assert.equal((await client.callTool('echo', { x: 1 })).content[0].text, 'done');
  assert.deepEqual(calls.map(item => item.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call']);
});

test('legacy SSE uses its same-origin endpoint and closes its stream', async t => {
  let stream; const calls = [];
  const url = await listen(t, async (req, res) => {
    if (req.method === 'GET') { stream = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: endpoint\ndata: /messages?session=mock\n\n'); return; }
    assert.equal(req.url, '/messages?session=mock'); const request = await body(req); calls.push(request.method); res.writeHead(202).end();
    if (request.id) stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize' ? initialized : { tools: remoteTools } })}\n\n`);
  });
  const client = new MCPClient({ transport: 'sse', url: url + '/sse' }); t.after(() => client.close());
  assert.equal((await client.listTools()).length, 1); await client.close();
  assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('Burp preset discovers and invokes tools through SSE only for enabled authorized members', async t => {
  let stream, connections = 0; const calls = [];
  const url = await listen(t, async (req, res) => {
    if (req.method === 'GET') {
      connections++; stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages?session=burp-fixture\n\n'); return;
    }
    assert.equal(req.url, '/messages?session=burp-fixture');
    const request = await body(req); calls.push(request); res.writeHead(202).end();
    if (request.id) {
      const result = request.method === 'initialize' ? initialized : request.method === 'tools/list'
        ? { tools: remoteTools } : { content: [{ type: 'text', text: 'burp-fixture-result' }] };
      stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`);
    }
  });
  const seeded = ensureBuiltinMcpPresets(normalizeExtensions());
  const config = { ...seeded, mcps: seeded.mcps.map(item => item.builtin === 'burpsuite' ? { ...item, url } : item) };
  for (const [enabled, agentIds] of [[false, ['alice']], [true, []]]) {
    const manager = managerFor(t, { extensionConfig: { ...config, mcps: config.mcps.map(item => item.builtin === 'burpsuite' ? { ...item, enabled, agentIds } : item) } });
    assert.ok(!manager.definitionsFor('alice').some(item => item.name === 'search_tools'));
    await assert.rejects(manager.execute('alice', { name: 'search_tools', args: {} }), /Unknown tool name/);
  }
  const manager = managerFor(t, { extensionConfig: { ...config, mcps: config.mcps.map(item => item.builtin === 'burpsuite' ? { ...item, enabled: true, agentIds: ['alice'] } : item) } });
  assert.equal(connections, 0, 'Preset configuration does not connect eagerly');
  await assert.rejects(manager.execute('bob', { name: 'search_tools', args: {} }), /Unknown tool name/);
  const discovered = JSON.parse((await manager.execute('alice', { name: 'search_tools', args: { mcpId: 'class-burpsuite' } })).output);
  assert.equal(discovered.tools.length, 1); assert.equal(connections, 1);
  const result = await manager.execute('alice', { name: discovered.tools[0].name, args: { name: 'fixture request' } });
  assert.equal(result.success, true); assert.match(result.output, /burp-fixture-result/);
  assert.equal(manager.children.size, 0, 'SSE does not start Burp or a proxy process');
  assert.deepEqual(calls.map(item => item.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  await manager.stopAll();
});

test('platform HTTP presets discover and invoke namespaced tools only for enabled authorized members without spawning', async t => {
  const calls = [], names = new Set(); let spawns = 0;
  const url = await listen(t, async (req, res) => {
    const request = await body(req); calls.push({ type: req.url.slice(1), request });
    if (!request.id) { res.writeHead(202).end(); return; }
    const result = request.method === 'initialize' ? initialized : request.method === 'tools/list'
      ? { tools: remoteTools } : { content: [{ type: 'text', text: 'platform-fixture-' + req.url.slice(1) }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  const seeded = ensureBuiltinMcpPresets(ensureBuiltinMcpPresets(normalizeExtensions(), 'win32'), 'linux');
  const spawnProcess = () => { spawns++; throw Error('HTTP presets must not spawn a process'); };
  for (const type of ['tscan', 'jadx', 'x64dbg', 'ida', 'ghidra', 'gdb', 'metasploit']) {
    const preset = seeded.mcps.find(item => item.builtin === type), before = calls.length;
    assert.equal(preset.transport, 'http'); assert.equal(preset.command, undefined);
    for (const [enabled, agentIds] of [[false, ['alice']], [true, []]]) {
      const disabled = managerFor(t, { extensionConfig: { mcps: [{ ...preset, url: url + '/' + type, enabled, agentIds }] } });
      disabled.extensions.spawnProcess = spawnProcess;
      assert.ok(!disabled.definitionsFor('alice').some(item => item.name === 'search_tools'));
      await assert.rejects(disabled.execute('alice', { name: 'search_tools', args: {} }), /Unknown tool name/);
    }
    const manager = managerFor(t, { extensionConfig: { mcps: [{ ...preset, url: url + '/' + type, enabled: true, agentIds: ['alice'] }] } });
    manager.extensions.spawnProcess = spawnProcess;
    assert.equal(calls.length, before, 'Configuration and grants do not connect eagerly');
    await assert.rejects(manager.execute('bob', { name: 'search_tools', args: {} }), /Unknown tool name/);
    const found = JSON.parse((await manager.execute('alice', { name: 'search_tools', args: { mcpId: preset.id } })).output);
    assert.equal(found.tools.length, 1); assert.equal(found.tools[0].mcpId, preset.id); names.add(found.tools[0].name);
    assert.ok(!manager.definitionsFor('bob').some(item => item.name === found.tools[0].name));
    await assert.rejects(manager.execute('bob', { name: found.tools[0].name, args: {} }), /Unknown tool name/);
    const result = await manager.execute('alice', { name: found.tools[0].name, args: { name: type + '-fixture-request' } });
    assert.equal(result.success, true); assert.match(result.output, new RegExp('platform-fixture-' + type));
    assert.equal(manager.children.size, 0); assert.equal(spawns, 0);
    const ownCalls = calls.slice(before);
    assert.ok(ownCalls.every(item => item.type === type));
    assert.deepEqual(ownCalls.map(item => item.request.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.deepEqual(ownCalls.at(-1).request.params, { name: 'echo', arguments: { name: type + '-fixture-request' } });
    await manager.stopAll();
  }
  assert.equal(names.size, 7, 'Identical remote tool names have distinct preset namespaces');
  assert.equal(spawns, 0);
});

test('runtime accepts all MCP presets plus 64 custom services and rejects duplicate or unknown presets', t => {
  const external = Array.from({ length: 64 }, (_, i) => ({ ...mcp, id: 'external-' + i, enabled: false }));
  const config = ensureBuiltinMcpPresets(ensureBuiltinMcpPresets(normalizeExtensions({ mcps: external }), 'win32'), 'linux');
  assert.equal(config.mcps.length, 64 + BUILTIN_MCP_TYPES.length);
  managerFor(t, { extensionConfig: config });
  for (const type of BUILTIN_MCP_TYPES) {
    const preset = config.mcps.find(item => item.builtin === type);
    assert.throws(() => new ToolManager({ extensionConfig: { mcps: [preset, { ...preset, id: 'duplicate' }] } }), /configuration count/);
  }
  assert.throws(() => new ToolManager({ extensionConfig: { mcps: [...external, { ...mcp, id: 'external-overflow' }] } }), /configuration count/);
  assert.throws(() => new ToolManager({ extensionConfig: { mcps: [...config.mcps, { ...mcp, id: 'external-overflow' }] } }), /configuration/);
  assert.throws(() => new ToolManager({ extensionConfig: { mcps: [{ ...mcp, builtin: 'unknown' }] } }), /Unknown MCP preset/);
});

test('platform analysis presets start lazily for granted members, isolate names and resolve only exact Class launchers', async t => {
  for (const platform of ['win32', 'linux']) {
    const config = ensureBuiltinMcpPresets(normalizeExtensions(), platform), names = new Set();
    const presets = config.mcps.filter(item => item.transport === 'stdio' && item.builtin !== 'browser');
    assert.equal(presets.length, platform === 'win32' ? 3 : 7);
    for (const preset of presets) {
      const type = preset.builtin, before = structuredClone(preset), log = [], launches = [], controls = [];
      const clientFactory = (server, options) => {
        launches.push(server);
        return { ...fakeClientFactory(log)(server, options), config: server, child: {}, async _request(method, params) { controls.push([method, params]); return {}; } };
      };
      for (const [enabled, agentIds] of [[false, ['alice']], [true, []]]) {
        const manager = managerFor(t, { extensionConfig: { mcps: [{ ...preset, enabled, agentIds }] }, extensionOptions: { clientFactory } });
        assert.ok(!manager.definitionsFor('alice').some(item => item.name === 'search_tools'));
        await assert.rejects(manager.execute('alice', { name: 'search_tools', args: { mcpId: preset.id } }));
      }
      assert.equal(launches.length, 0, type + ' is never started while disabled or ungranted');
      const manager = managerFor(t, { extensionConfig: { mcps: [{ ...preset, enabled: true, agentIds: ['alice'] }] }, extensionOptions: { clientFactory } });
      assert.equal(launches.length, 0);
      const found = JSON.parse((await manager.execute('alice', { name: 'search_tools', args: { mcpId: preset.id } })).output);
      assert.equal(launches.length, 1); assert.equal(launches[0].transport, 'stdio');
      if (['pwntools', 'zsteg', 'binwalk'].includes(type)) {
        assert.equal(launches[0].command, process.execPath);
        assert.equal(path.basename(launches[0].args[0]), 'local-analysis-mcp.js');
        assert.deepEqual(launches[0].args.slice(1), [type]);
        assert.equal(launches[0].classAnalysisMcp, true);
      } else {
        assert.equal(launches[0].command, preset.command); assert.deepEqual(launches[0].args, preset.args);
        assert.equal(launches[0].classAnalysisMcp, undefined);
      }
      assert.equal(launches[0].classBrowserMcp, undefined);
      assert.equal(launches[0].env.LOCALAPPDATA, process.platform === 'win32' && type === 'windbg' ? process.env.LOCALAPPDATA : undefined);
      names.add(found.tools[0].name);
      await assert.rejects(manager.execute('bob', { name: 'search_tools', args: { mcpId: preset.id } }), /Unknown tool name/);
      await assert.rejects(manager.execute('bob', { name: found.tools[0].name, args: {} }), /Unknown tool name/);
      await manager.execute('alice', { name: found.tools[0].name, args: { name: 'fixture-' + type } });
      assert.deepEqual(log.at(-1), ['call', 'echo', { name: 'fixture-' + type }]);
      await manager.pauseAll(); await manager.resumeAll();
      assert.deepEqual(controls, ['pwntools', 'zsteg', 'binwalk'].includes(type) ? [['class/analysis/pause', {}], ['class/analysis/resume', {}]] : []);
      await manager.stopAll(); assert.deepEqual(log.at(-1), ['close', preset.id]);
      assert.deepEqual(preset, before, 'Runtime resolution does not replace saved commands or grants');
      if (['pwntools', 'zsteg', 'binwalk'].includes(type)) {
        for (const override of [{ command: 'fixture-custom-adapter', args: [...preset.args] }, { command: 'Class', args: [...preset.args, '--user-option'] }]) {
          const edited = { ...preset, ...override, enabled: true, agentIds: ['alice'], classAnalysisMcp: true };
          const custom = managerFor(t, { extensionConfig: { mcps: [edited] }, extensionOptions: { clientFactory } });
          await custom.execute('alice', { name: 'search_tools', args: { mcpId: preset.id } });
          assert.equal(launches.at(-1).command, override.command); assert.deepEqual(launches.at(-1).args, override.args);
          assert.equal(launches.at(-1).classAnalysisMcp, undefined, 'Saved fields cannot grant Class-owned process control to an edited launcher');
          const priorControls = controls.length;
          await custom.pauseAll(); await custom.resumeAll(); assert.equal(controls.length, priorControls);
          await custom.stopAll();
        }
      }
    }
    assert.equal(names.size, presets.length, 'Identical tools from different presets have distinct namespaces');
  }
});

test('analysis pause and resume bypass a paused checkpoint only for a Class-owned adapter', async () => {
  for (const classAnalysisMcp of [true, false]) {
    const sent = [], client = new MCPClient({ transport: 'stdio', command: 'never-spawned-fixture', classAnalysisMcp }, { checkpoint: async () => { throw Error('fixture checkpoint is paused'); } });
    client.child = { stdin: { writable: true, write(value, callback) { sent.push(JSON.parse(value)); callback(); } } };
    for (const method of ['class/analysis/pause', 'class/analysis/resume']) {
      const operation = client._send({ jsonrpc: '2.0', id: sent.length + 1, method, params: {} });
      if (classAnalysisMcp) await operation;
      else await assert.rejects(operation, /checkpoint is paused/);
    }
    assert.deepEqual(sent.map(item => item.method), classAnalysisMcp ? ['class/analysis/pause', 'class/analysis/resume'] : []);
    await assert.rejects(client._send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }), /checkpoint is paused/);
  }
});

test('tool timeout sends cancellation, reports uncertain execution and never retries the call', async t => {
  const calls = [];
  const url = await listen(t, async (req, res) => {
    const request = await body(req); calls.push(request);
    if (request.method === 'tools/call') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n'); return; }
    if (!request.id) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: initialized }));
  });
  const client = new MCPClient({ transport: 'http', url }, { timeoutMs: 80 }); t.after(() => client.close());
  await client.initialize(); await assert.rejects(client.callTool('slow', {}), error => error.code === 'MCP_TIMEOUT' && error.executionStatus === 'uncertain');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.filter(item => item.method === 'tools/call').length, 1); assert.ok(calls.some(item => item.method === 'notifications/cancelled'));
});

test('stdio framing and owned shutdown do not terminate another process', async t => {
  const script = `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{data+=chunk;let at;while((at=data.indexOf('\\n'))>=0){const m=JSON.parse(data.slice(0,at));data=data.slice(at+1);if(m.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?${JSON.stringify(initialized)}:m.method==='tools/list'?{tools:${JSON.stringify(remoteTools)}}:{content:[{type:'text',text:'stdio-ok'}]}})+'\\n');}});process.stderr.write('private startup text');`;
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => { const closed = once(unrelated, 'close'); unrelated.kill(); await closed; });
  const client = new MCPClient({ transport: 'stdio', command: process.execPath, args: ['-e', script], env: {} }); t.after(() => client.close());
  assert.equal((await client.listTools()).length, 1); assert.equal((await client.callTool('echo', {})).content[0].text, 'stdio-ok');
  const closed = once(client.child, 'close'); await client.close(); await closed;
  assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null);
});

test('ToolManager pause records an in-flight remote result and delivers it once after resume', async t => {
  let finish, began, calls = 0; const started = new Promise(resolve => { began = resolve; }), activities = [];
  const manager = managerFor(t, { extensionConfig: { mcps: [mcp], skills: [] }, onActivity: activity => activities.push(activity),
    extensionOptions: { clientFactory: () => ({ listTools: async () => remoteTools, callTool: () => { calls++; began(); return new Promise(resolve => { finish = resolve; }); }, close: async () => {} }) },
  });
  await manager.execute('alice', { name: 'search_tools', args: {} });
  const name = manager.definitionsFor('alice').find(item => item.extension).name;
  let delivered = false; const call = manager.execute('alice', { name, args: {} }).then(result => { delivered = true; return result; });
  await started; await manager.pauseAll(); finish({ content: [{ type: 'text', text: 'complete' }] });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(activities.some(item => item.action.name === name && item.type === 'completed')); assert.equal(delivered, false);
  await manager.resumeAll(); assert.equal((await call).success, true); assert.equal(calls, 1);
});

test('ToolManager lazily adopts stdio and stopAll closes only its owned MCP process', async t => {
  const script = `let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(m.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?${JSON.stringify(initialized)}:{tools:${JSON.stringify(remoteTools)}}})+'\\n');}});`;
  const manager = managerFor(t, { extensionConfig: { mcps: [{ ...mcp, transport: 'stdio', command: process.execPath, args: ['-e', script] }], skills: [] } });
  assert.equal(manager.children.size, 0); manager.definitionsFor('alice'); assert.equal(manager.children.size, 0);
  await manager.execute('alice', { name: 'search_tools', args: {} }); assert.equal(manager.children.size, 1);
  const child = [...manager.children][0].child;
  await manager.stopAll(); assert.equal(manager.children.size, 0); assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('MCP refuses cyclic pagination and cross-origin legacy SSE endpoints', async t => {
  const fetchImpl = async (_url, { body: text }) => {
    const request = JSON.parse(text);
    if (!request.id) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize' ? initialized : { tools: [], nextCursor: 'same' } });
  };
  const client = new MCPClient({ transport: 'http', url: 'http://isolated.invalid' }, { fetchImpl }); t.after(() => client.close());
  await assert.rejects(client.listTools(), /pagination is invalid/);
  const sse = new MCPClient({ transport: 'sse', url: 'http://isolated.invalid/sse' }, { fetchImpl: async () => new Response('event: endpoint\ndata: https://other.invalid/messages\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
  t.after(() => sse.close()); await assert.rejects(sse.initialize(), /changed origin/);
});

test('tool checkpoints restore plans and authorized tool identities, without secrets, schemas or replay', async t => {
  const log = [], original = managerFor(t, { extensionConfig: { mcps: [mcp], skills: [skill] }, extensionOptions: { clientFactory: fakeClientFactory(log) } });
  await original.execute('alice', { name: 'plan_write', args: { content: 'Preserve this plan' } });
  await original.execute('alice', { name: 'todo_write', args: { todos: [{ id: 'one', content: 'Review evidence', status: 'completed' }] } });
  await original.execute('alice', { name: 'search_tools', args: {} });
  const snapshot = original.exportState(), serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('inputSchema')); assert.ok(!serialized.includes('SECRET_SKILL_BODY')); assert.ok(!serialized.includes(mcp.url));
  const restored = managerFor(t, { extensionConfig: { mcps: [mcp], skills: [skill] }, extensionOptions: { clientFactory: fakeClientFactory(log) } });
  restored.importState(snapshot); assert.equal(restored.children.size, 0); assert.ok(!restored.definitionsFor('alice').some(item => item.extension));
  await restored.prepare(); assert.ok(restored.definitionsFor('alice').some(item => item.extension));
  assert.equal(JSON.parse((await restored.execute('alice', { name: 'plan_read', args: {} })).output).entries[0].plan, 'Preserve this plan');
  assert.equal(JSON.parse((await restored.execute('alice', { name: 'todo_read', args: {} })).output).entries[0].todos[0].status, 'completed');
  assert.ok(!log.some(item => item[0] === 'call'));
  const revoked = managerFor(t, { extensionConfig: { mcps: [{ ...mcp, agentIds: ['bob'] }], skills: [] }, extensionOptions: { clientFactory: fakeClientFactory(log) } });
  revoked.importState(snapshot); const before = log.length; await revoked.prepare(); assert.equal(log.length, before); assert.ok(!revoked.definitionsFor('alice').some(item => item.extension));
});

test('CLI extensions accept environment credentials or explicitly read a profile without changing it', async t => {
  const config = { students: [{ id: 'alice' }, { id: 'bob' }], extensions: { mcps: [mcp], skills: [skill] } };
  const loaded = await loadCLIExtensions(config, { environment: { CLASS_EXTENSION_SECRETS: JSON.stringify({ mock: { headers: { Authorization: 'Bearer cli-secret-test' } } }) } });
  assert.equal(loaded.extensionSecrets.mock.headers.Authorization, 'Bearer cli-secret-test');
  assert.ok(loaded.knownSecrets.includes('cli-secret-test')); assert.ok(!JSON.stringify(loaded.extensionConfig).includes('cli-secret-test'));
  assert.equal(Object.hasOwn(loaded.extensionConfig.skills[0], 'mcpIds'), false);
  const base = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(base, 'class-extension-profile-'));
  t.after(async () => { assert.equal(path.dirname(directory), base); assert.ok(path.basename(directory).startsWith('class-extension-profile-')); assert.equal(await fs.realpath(directory), directory); await fs.rm(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, 'profiles.json'), raw = JSON.stringify({ version: 1, agents: [{ id: 'alice' }], extensions: config.extensions });
  await fs.writeFile(filename, raw);
  const saved = prepareExtensionUpdate({ ...config.extensions, revision: 0, mcps: [{ ...mcp, env: { TOKEN: 'profile-only-test' } }] }, {}, config.students, {});
  const profile = await loadCLIExtensions({ students: [{ id: 'alice' }] }, { profileDirectory: directory, loadProfileSecrets: async where => { assert.equal(where, directory); return saved.secrets; } });
  assert.equal(profile.extensionSecrets.mock.env.TOKEN, 'profile-only-test'); assert.equal(await fs.readFile(filename, 'utf8'), raw);
  assert.equal(Object.hasOwn(profile.extensionConfig.skills[0], 'mcpIds'), false);
  await assert.rejects(loadCLIExtensions(config, { profileDirectory: directory }), /either/);
});

test('MCP pagination sends no next request while Class is paused', async t => {
  let manager, signalPage; const paused = new Promise(resolve => { signalPage = resolve; }); let pages = 0;
  const fetchImpl = async (_url, { body: text }) => {
    const request = JSON.parse(text); if (!request.id) return new Response(null, { status: 202 });
    let result = initialized;
    if (request.method === 'tools/list') {
      pages++;
      if (pages === 1) { await manager.pauseAll(); signalPage(); result = { tools: remoteTools, nextCursor: 'next' }; }
      else result = { tools: [{ ...remoteTools[0], name: 'next-tool' }] };
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
  manager = managerFor(t, { extensionConfig: { mcps: [mcp], skills: [] }, extensionOptions: { fetchImpl, timeoutMs: 1000 } });
  const pending = manager.execute('alice', { name: 'search_tools', args: {} });
  await paused; await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(pages, 1);
  await manager.resumeAll(); assert.equal(JSON.parse((await pending).output).total, 2); assert.equal(pages, 2);
});
