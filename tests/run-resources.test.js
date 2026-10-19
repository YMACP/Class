import test from 'node:test';
import assert from 'node:assert/strict';
import { RunResources } from '../src/run-resources.js';
import { ExtensionRuntime } from '../src/extensions.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const server = (id, extra = {}) => ({ id, name: id, transport: 'http', url: 'http://localhost:8765/mcp', enabled: true, agentIds: ['member'], ...extra });
const catalogue = [{ name: 'fixture', inputSchema: { type: 'object', properties: {} } }];
function runtime(t, coordinator, owner, mcps, events, overrides = {}) {
  const manager = { cwd: process.cwd(), maxOutputBytes: 32768, async checkpoint(signal) { signal?.throwIfAborted(); } };
  const extension = new ExtensionRuntime(manager, { config: { mcps }, runResources: coordinator, resourceOwner: owner,
    clientFactory: config => {
      events.push(`${owner}:create:${config.id}`);
      return { config,
        async listTools() { events.push(`${owner}:list:${config.id}`); return catalogue; },
        async callTool() { events.push(`${owner}:call:${config.id}`); return { content: [] }; },
        async close() { events.push(`${owner}:close:${config.id}`); }, ...overrides,
      };
    },
  });
  t.after(() => extension.stopAll().catch(() => {}));
  return extension;
}
const search = async (extension, id) => JSON.parse((await extension.execute('member', 'search_tools', { mcpId: id })).output);

test('remote leases cover init/list, aliases and probes while unrelated tasks continue', async t => {
  const coordinator = new RunResources(), events = [];
  const first = runtime(t, coordinator, 'run-a', [server('debug')], events);
  const second = runtime(t, coordinator, 'run-b', [server('alias', { transport: 'sse', url: 'http://127.0.0.1:8765/other' }), server('other', { url: 'http://127.0.0.1:8766/mcp' })], events);
  const probe = runtime(t, coordinator, 'probe-fixture', [server('probe', { url: 'http://[::1]:8765/probe' })], events);
  const tools = await search(first, 'debug');
  const busy = await search(second, 'alias');
  assert.equal(busy.errors[0].code, 'MCP_RESOURCE_BUSY');
  await assert.rejects(probe.probeConnection('member', 'probe'), { code: 'MCP_RESOURCE_BUSY', executionStatus: 'not_started' });
  assert.ok(!events.some(event => /create:(alias|probe)$/.test(event)), 'A conflict must not initialize or close the occupied session');
  const independent = await search(second, 'other');
  await second.execute('member', independent.tools[0].name, {});
  await first.execute('member', tools.tools[0].name, {});
  await first.stopAll();
  assert.ok(!events.some(event => event === 'run-b:close:other'));
  assert.equal((await search(second, 'alias')).tools.length, 1);
});

test('teacher and students serialize a shared session and keep its lease until both close', async t => {
  const coordinator = new RunResources(), events = [], started = deferred(), finish = deferred();
  const students = runtime(t, coordinator, 'run-a', [server('students')], events, {
    async callTool() { events.push('student:start'); started.resolve(); await finish.promise; events.push('student:end'); return { content: [] }; },
  });
  const teacher = runtime(t, coordinator, 'run-a', [server('teacher')], events);
  const other = runtime(t, coordinator, 'run-b', [server('other')], events);
  const found = await search(students, 'students');
  const call = students.execute('member', found.tools[0].name, {}); await started.promise;
  const discovery = search(teacher, 'teacher'); await tick();
  assert.ok(!events.includes('run-a:list:teacher'));
  finish.resolve(); await call; await discovery;
  assert.ok(events.indexOf('student:end') < events.indexOf('run-a:list:teacher'));
  await students.stopAll();
  assert.equal((await search(other, 'other')).errors[0].code, 'MCP_RESOURCE_BUSY');
  await teacher.stopAll();
  assert.equal((await search(other, 'other')).tools.length, 1);
});

test('cancelled queued work cannot overtake an active resource or release it early', async () => {
  const coordinator = new RunResources(), hold = coordinator.acquire(server('fixture'), 'run-a'), started = deferred(), finish = deferred(), events = [];
  const first = hold.run(async () => { started.resolve(); await finish.promise; events.push('first'); }); await started.promise;
  const controller = new AbortController();
  const cancelled = hold.run(() => { events.push('cancelled'); }, controller.signal);
  controller.abort(new Error('fixture cancelled'));
  await assert.rejects(cancelled, /fixture cancelled/);
  const third = hold.run(() => { events.push('third'); }); await tick();
  assert.deepEqual(events, []);
  hold.release();
  assert.throws(() => coordinator.acquire(server('other'), 'run-b'), { code: 'MCP_RESOURCE_BUSY' });
  finish.resolve(); await first;
  await assert.rejects(third, /lease has ended/);
  assert.deepEqual(events, ['first']);
  coordinator.acquire(server('other'), 'run-b').release();
});

test('failed client cleanup retains ownership and known stdio debugger adapters also conflict', async t => {
  const coordinator = new RunResources(), events = [];
  const debuggerConfig = id => server(id, { builtin: 'windbg', transport: 'stdio', command: 'fixture-only', args: ['different', id] });
  const first = runtime(t, coordinator, 'run-a', [debuggerConfig('a')], events, { async close() { throw Error('fixture cleanup failed'); } });
  const second = runtime(t, coordinator, 'run-b', [debuggerConfig('b')], events);
  await search(first, 'a');
  assert.equal((await search(second, 'b')).errors[0].code, 'MCP_RESOURCE_BUSY');
  await assert.rejects(first.stopAll(), /fixture cleanup failed/);
  assert.equal((await search(second, 'b')).errors[0].code, 'MCP_RESOURCE_BUSY');
  assert.ok(!events.includes('run-b:create:b'));
});

test('owned browser and analysis children remain independently usable by different tasks', async t => {
  const coordinator = new RunResources(), events = [];
  const mcps = [server('browser', { builtin: 'browser', transport: 'stdio', command: 'Class', args: ['--browser-mcp'] }),
    server('analysis', { builtin: 'binwalk', transport: 'stdio', command: 'Class', args: ['--local-analysis-mcp', 'binwalk'] })];
  const first = runtime(t, coordinator, 'run-a', mcps, events), second = runtime(t, coordinator, 'run-b', mcps, events);
  for (const extension of [first, second]) for (const item of mcps) assert.equal((await search(extension, item.id)).tools.length, 1);
  assert.equal(coordinator.resources.size, 0);
  await first.stopAll();
  assert.ok(!events.some(event => event.startsWith('run-b:close:')));
});

test('replacing an already-closed client does not forget an earlier cleanup failure', async t => {
  const coordinator = new RunResources(), events = [];
  const first = runtime(t, coordinator, 'run-a', [server('first')], events, {
    async listTools() { this.closed = true; throw Error('fixture connection failed'); },
    async close() { throw Error('fixture cleanup failed'); },
  });
  const second = runtime(t, coordinator, 'run-b', [server('second')], events);
  await search(first, 'first'); await search(first, 'first');
  assert.equal(first.retiredClients.size, 1);
  await assert.rejects(first.stopAll(), /fixture cleanup failed/);
  assert.equal((await search(second, 'second')).errors[0].code, 'MCP_RESOURCE_BUSY');
});
