import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolManager } from '../src/tools.js';
import { ExtensionPlanner } from '../src/extension-planner.js';

const remoteTools = [{ name: 'fixture_echo', description: 'Owned isolated MCP fixture', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false } }];
const mcp = (id, extra = {}) => ({ id, name: id, enabled: true, agentIds: ['alice'], transport: 'http', url: `http://127.0.0.1:1/${id}`, ...extra });
const skill = (id, extra = {}) => ({ id, name: id, description: `Short description for ${id}`, content: `PRIVATE_BODY_${id}\nSteps are loaded only by read_skill.`, enabled: true, agentIds: ['alice'], ...extra });
function managerFor(t, options = {}) {
  const manager = new ToolManager(options);
  t.after(() => manager.stopAll());
  return manager;
}
const execute = async (manager, agentId, name, args = {}) => JSON.parse((await manager.execute(agentId, { name, args })).output);
function clientFactory(log) {
  return config => ({
    async listTools() { log.push({ event: 'list', id: config.id, url: config.url }); return remoteTools; },
    async callTool(name, args) { log.push({ event: 'call', id: config.id, name, args }); return { content: [{ type: 'text', text: JSON.stringify(args) }] }; },
    async close() { log.push({ event: 'close', id: config.id }); },
  });
}

test('broad discovery coalesces only exact authorized MCP duplicates and keeps equal labels distinct', async t => {
  const log = [], config = { mcps: [
    mcp('first', { name: 'Same label' }),
    mcp('alias', { name: 'Different label', url: 'http://127.0.0.1:1/first', agentIds: ['alice', 'bob'] }),
    mcp('distinct', { name: 'Same label' }),
    mcp('private', { agentIds: ['bob'] }),
  ], skills: [] };
  const manager = managerFor(t, { extensionConfig: config, extensionOptions: { clientFactory: clientFactory(log) } });
  assert.equal(log.length, 0);
  const found = await execute(manager, 'alice', 'search_tools');
  assert.equal(found.tools.length, 2);
  assert.deepEqual(log.filter(item => item.event === 'list').map(item => item.id), ['first', 'distinct']);
  assert.ok(!JSON.stringify(manager.definitionsFor('alice')).includes('"id":"private"'));
  await assert.rejects(manager.execute('alice', { name: 'search_tools', args: { mcpId: 'private' } }), /not authorized/);
  const alias = await execute(manager, 'alice', 'search_tools', { mcpId: 'alias' });
  assert.ok(manager.definitionsFor('alice').some(item => item.name === alias.tools[0].name), 'Explicit aliases keep their callable declaration after catalogue deduplication');
  await execute(manager, 'alice', alias.tools[0].name, { value: 'alias remains callable' });
  assert.equal(log.filter(item => item.event === 'call' && item.id === 'alias').length, 1);
  await execute(manager, 'bob', 'search_tools', { mcpId: 'alias' });
  assert.equal(log.filter(item => item.event === 'list' && item.id === 'alias').length, 2, 'A different member retains their own authorized connection');
  await assert.rejects(manager.execute('bob', { name: found.tools[0].name, args: {} }), /Unknown tool name|not authorized/);
});

test('same endpoint with different private credentials stays separately selectable', async t => {
  const log = [], config = { mcps: [mcp('first'), mcp('second', { url: 'http://127.0.0.1:1/first' })] };
  const manager = managerFor(t, { extensionConfig: config, extensionSecrets: { first: { headers: { Authorization: 'Bearer fixture-one' } }, second: { headers: { Authorization: 'Bearer fixture-two' } } }, extensionOptions: { clientFactory: clientFactory(log) } });
  const found = await execute(manager, 'alice', 'search_tools');
  assert.equal(found.tools.length, 2);
  assert.deepEqual(log.filter(item => item.event === 'list').map(item => item.id), ['first', 'second']);
  assert.ok(!JSON.stringify(found).includes('fixture-one'));
  assert.ok(!JSON.stringify(found).includes('fixture-two'));
});

test('non-Jev discovery opens at most three new servers per page and exposes the remaining server cursor', async t => {
  const log = [], manager = managerFor(t, { extensionConfig: { mcps: Array.from({ length: 5 }, (_, index) => mcp('server-' + index)) }, extensionOptions: { clientFactory: clientFactory(log) } });
  const first = await execute(manager, 'alice', 'search_tools', { limit: 10 });
  assert.deepEqual(log.filter(item => item.event === 'list').map(item => item.id), ['server-0', 'server-1', 'server-2']);
  assert.equal(first.nextServerOffset, 3);
  const second = await execute(manager, 'alice', 'search_tools', { serverOffset: first.nextServerOffset, limit: 10 });
  assert.deepEqual(log.filter(item => item.event === 'list').map(item => item.id), ['server-0', 'server-1', 'server-2', 'server-3', 'server-4']);
  assert.equal(second.nextServerOffset, null);
  assert.deepEqual(second.tools.map(item => item.mcpId), ['server-3', 'server-4']);
});

test('Skill search returns descriptions without loading bodies or contacting MCPs', async t => {
  const log = [], manager = managerFor(t, { extensionConfig: { mcps: [mcp('server')], skills: [skill('first'), skill('second'), skill('private', { agentIds: ['bob'] })] }, extensionOptions: { clientFactory: clientFactory(log) } });
  assert.ok(manager.definitionsFor('alice').some(item => item.name === 'search_skills'));
  const found = await execute(manager, 'alice', 'search_skills', { limit: 1 });
  assert.equal(found.skills.length, 1);
  assert.equal(found.skills[0].id, 'first');
  assert.equal(found.skills[0].description, 'Short description for first');
  assert.ok(!JSON.stringify(found).includes('PRIVATE_BODY_'));
  assert.ok(!JSON.stringify(found).includes('private'));
  assert.equal(found.nextOffset, 1);
  assert.equal(log.length, 0);
  const loaded = await execute(manager, 'alice', 'read_skill', { id: found.skills[0].id });
  assert.match(loaded.content, /PRIVATE_BODY_first/);
  await assert.rejects(manager.execute('alice', { name: 'read_skill', args: { id: 'private' } }), /not authorized/);
  assert.equal(log.length, 0);
});

test('Jev ranks Skill metadata while bodies remain unloaded and ungranted entries remain invisible', async t => {
  const decisions = [], planner = new ExtensionPlanner({ judgment: {
    config: { enabled: true },
    judge: { async decide(kind, request) {
      decisions.push({ kind, request });
      return { applied: true, status: 'ok', answers: Object.fromEntries(request.state.items.map((item, index) => ['relevant_' + index, { type: 'boolean', probability: item.id === 'second' ? 0.99 : 0.01 }])) };
    } },
  } });
  const manager = managerFor(t, { extensionConfig: { skills: [skill('first'), skill('second'), skill('private', { agentIds: ['bob'] })] }, extensionOptions: { planner, task: 'Inspect the authorized evidence', taskMode: 'web_pentest' } });
  const found = await execute(manager, 'alice', 'search_skills', { limit: 10 });
  assert.deepEqual(found.skills.map(item => item.id), ['second', 'first']);
  assert.equal(found.selection.source, 'jev');
  assert.equal(found.selection.load, 'read_skill');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'extensionSelection');
  assert.equal(decisions[0].request.state.task, 'Inspect the authorized evidence');
  assert.ok(!JSON.stringify(decisions).includes('PRIVATE_BODY_'));
  assert.ok(!JSON.stringify(decisions).includes('"id":"private"'));
  assert.ok(!JSON.stringify(found).includes('PRIVATE_BODY_'));
  assert.match((await execute(manager, 'alice', 'read_skill', { id: 'first' })).content, /PRIVATE_BODY_first/);
});

test('Jev MCP preference contacts only relevant servers while explicit deferred IDs remain available', async t => {
  const log = [], decisions = [], planner = new ExtensionPlanner({ judgment: {
    config: { enabled: true },
    judge: { async decide(kind, request) {
      decisions.push({ kind, request });
      return { applied: true, status: 'ok', answers: { ...Object.fromEntries(request.state.items.map((item, index) => ['relevant_' + index, { type: 'boolean', probability: item.id === 'preferred' ? 0.99 : 0.01 }])), loading: { type: 'choice', choice: 'targeted', probabilities: { targeted: 0.99, catalogue: 0.01 } } } };
    } },
  } });
  const manager = managerFor(t, { extensionConfig: { mcps: [mcp('deferred'), mcp('preferred'), mcp('later'), mcp('private', { agentIds: ['bob'] })] }, extensionSecrets: { preferred: { headers: { Authorization: 'Bearer secret-fixture-token' } } }, extensionOptions: { planner, task: 'Inspect the authorized evidence', taskMode: 'web_pentest', clientFactory: clientFactory(log) } });
  const found = await execute(manager, 'alice', 'search_tools', { limit: 10 });
  assert.deepEqual(log.filter(item => item.event === 'list').map(item => item.id), ['preferred']);
  assert.deepEqual(found.tools.map(item => item.mcpId), ['preferred']);
  assert.equal(found.selection.source, 'jev');
  assert.equal(found.selection.load, 'discover_tools');
  assert.ok(found.deferredMcpIds.includes('deferred'));
  assert.ok(found.deferredMcpIds.includes('later'));
  assert.ok(!JSON.stringify(decisions).includes('secret-fixture-token'));
  assert.ok(!JSON.stringify(decisions).includes('127.0.0.1'));
  assert.ok(!JSON.stringify(decisions).includes('"id":"private"'));
  const deferred = await execute(manager, 'alice', 'search_tools', { mcpId: 'deferred' });
  assert.equal(deferred.tools.length, 1);
  assert.equal(deferred.tools[0].mcpId, 'deferred');
  assert.deepEqual(log.filter(item => item.event === 'list').map(item => item.id), ['preferred', 'deferred']);
});

test('Jev failure preserves bounded ordinary MCP discovery and Skill access', async t => {
  const log = [], planner = new ExtensionPlanner({ judgment: { config: { enabled: true }, judge: { async decide() { throw Error('classifier fixture unavailable'); } } } });
  const manager = managerFor(t, { extensionConfig: { mcps: [mcp('first'), mcp('second')], skills: [skill('guide')] }, extensionOptions: { planner, clientFactory: clientFactory(log) } });
  const found = await execute(manager, 'alice', 'search_tools');
  assert.equal(found.selection.source, 'fallback');
  assert.deepEqual(log.filter(item => item.event === 'list').map(item => item.id), ['first', 'second']);
  assert.equal((await execute(manager, 'alice', 'search_skills')).skills[0].id, 'guide');
  assert.match((await execute(manager, 'alice', 'read_skill', { id: 'guide' })).content, /PRIVATE_BODY_guide/);
});

test('MCP preparation retries discovery once and never retries a tool execution', async t => {
  const log = [], prepared = [], original = mcp('repairable', { transport: 'stdio', command: 'fixture-before-prepare', args: [] });
  const manager = managerFor(t, { extensionConfig: { mcps: [original] }, extensionOptions: {
    prepareMcp: async (server, context) => { prepared.push({ server, context }); return { status: 'prepared', server: { ...server, command: 'fixture-after-prepare' } }; },
    clientFactory: config => ({
      async listTools() { log.push({ event: 'list', command: config.command }); if (config.command === original.command) throw Error('missing local bridge dependency'); return remoteTools; },
      async callTool() { log.push({ event: 'call', command: config.command }); throw Error('fixture execution failed after send'); },
      async close() { log.push({ event: 'close', command: config.command }); },
    }),
  } });
  const found = await execute(manager, 'alice', 'search_tools', { mcpId: original.id });
  assert.equal(found.tools.length, 1);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].server.id, original.id);
  assert.ok(prepared[0].context.signal instanceof AbortSignal);
  assert.deepEqual(log.filter(item => item.event === 'list').map(item => item.command), [original.command, 'fixture-after-prepare']);
  await assert.rejects(manager.execute('alice', { name: found.tools[0].name, args: {} }), /fixture execution failed/);
  assert.equal(log.filter(item => item.event === 'call').length, 1);
  assert.equal(prepared.length, 1);
  assert.equal(original.command, 'fixture-before-prepare');
});

test('unavailable or failed preparation does not block discovery of another authorized server', async t => {
  for (const status of ['tool_missing', 'unavailable', 'failed']) {
    const prepared = [], manager = managerFor(t, { extensionConfig: { mcps: [mcp('missing'), mcp('working')] }, extensionOptions: {
      prepareMcp: async server => { prepared.push(server.id); return { status }; },
      clientFactory: config => ({
        async listTools() { if (config.id === 'missing') throw Error('not available'); return remoteTools; },
        async close() {},
      }),
    } });
    const found = await execute(manager, 'alice', 'search_tools');
    assert.deepEqual(found.tools.map(item => item.mcpId), ['working']);
    assert.equal(found.errors.length, 1);
    assert.deepEqual(prepared, ['missing']);
  }
});

test('a failed prepared connection is retried once rather than starting an installation loop', async t => {
  let prepares = 0, lists = 0;
  const manager = managerFor(t, { extensionConfig: { mcps: [mcp('missing')] }, extensionOptions: {
    prepareMcp: async server => { prepares++; return { status: 'prepared', server }; },
    clientFactory: () => ({ async listTools() { lists++; throw Error('still unavailable'); }, async close() {} }),
  } });
  const found = await execute(manager, 'alice', 'search_tools');
  assert.equal(found.tools.length, 0);
  assert.equal(found.errors.length, 1);
  assert.equal(prepares, 1);
  assert.equal(lists, 2);
});

test('manual connection probes never trigger environment preparation or unlock tools', async t => {
  let prepares = 0, lists = 0, calls = 0;
  const manager = managerFor(t, { extensionConfig: { mcps: [mcp('manual')] }, extensionOptions: {
    prepareMcp: async server => { prepares++; return { status: 'prepared', server }; },
    clientFactory: () => ({ async listTools() { lists++; throw Error('manual probe unavailable'); }, async callTool() { calls++; }, async close() {} }),
  } });
  await assert.rejects(manager.extensions.probeConnection('alice', 'manual'), /manual probe unavailable/);
  assert.equal(prepares, 0);
  assert.equal(lists, 1);
  assert.equal(calls, 0);
  assert.ok(!manager.definitionsFor('alice').some(item => item.extension));
});

test('catalogue loading strategy preserves normal discovery despite one preferred MCP', async t => {
  const log = [], planner = { async select() { return { source: 'jev', ids: ['second', 'first'], preferredIds: ['second'], strategy: 'catalogue' }; } };
  const manager = managerFor(t, { extensionConfig: { mcps: [mcp('first'), mcp('second')] }, extensionOptions: { planner, clientFactory: clientFactory(log) } });
  const found = await execute(manager, 'alice', 'search_tools');
  assert.equal(found.selection.strategy, 'catalogue');
  assert.deepEqual(log.filter(item => item.event === 'list').map(item => item.id), ['second', 'first']);
});

test('checkpoint restoration does not prepare dependencies until discovery is requested again', async t => {
  let prepares = 0;
  const manager = managerFor(t, { extensionConfig: { mcps: [mcp('restore')] }, extensionOptions: {
    prepareMcp: async () => { prepares++; return { status: 'manual', message: 'Fixture not available' }; },
    clientFactory: () => ({ async listTools() { throw Error('Fixture dependency unavailable'); }, async close() {} }),
  } });
  manager.extensions.importState({ version: 1, members: [{ agentId: 'alice', tools: [{ mcpId: 'restore', name: 'fixture_echo' }] }] });
  await manager.extensions.restore();
  assert.equal(prepares, 0);
  const result = await execute(manager, 'alice', 'search_tools', { mcpId: 'restore' });
  assert.equal(prepares, 1);
  assert.equal(result.errors.length, 1);
});
