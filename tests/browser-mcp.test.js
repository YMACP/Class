import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolManager } from '../src/tools.js';
import { BrowserMCPTransport } from '../src/browser-mcp.js';
import { findBrowserExecutable } from '../src/browser-tools.js';

const preset = { id:'class-browser', name:'browser', transport:'builtin', builtin:'browser', enabled:true, agentIds:['alice'] };
function managerFor(t, entry = preset, options = {}) {
  const manager = new ToolManager({ extensionConfig:{ mcps:[entry], skills:[] },
    extensionOptions:{ fetchImpl:() => { throw Error('Built-in MCP must not fetch an endpoint'); }, spawnProcess:() => { throw Error('Built-in MCP must not spawn a server'); } }, ...options });
  t.after(() => manager.stopAll());
  return manager;
}
async function discover(manager, agent = 'alice') {
  const result = await manager.execute(agent, { name:'search_tools', args:{ mcpId:preset.id } });
  const catalogue = JSON.parse(result.output);
  assert.equal(catalogue.errors, undefined);
  assert.equal(catalogue.total, 1);
  assert.equal(catalogue.tools.length, 1);
  return catalogue.tools[0].name;
}

test('browser MCP preserves JSON-RPC initialization and rejects calls outside its schema', async () => {
  let calls = 0;
  const transport = new BrowserMCPTransport({ checkpoint:async () => {}, browserTools:{ execute:async () => { calls++; return { output:'{}' }; } } }, 'alice');
  const request = async (method, params = {}, id = 1) => {
    const result = await transport.send(JSON.stringify({ jsonrpc:'2.0', method, params, ...(id === null ? {} : { id }) }));
    return result && JSON.parse(result);
  };
  assert.equal((await request('tools/list')).error.code, -32000);
  assert.equal((await request('initialize', { protocolVersion:'2025-06-18' })).result.serverInfo.name, 'Class browser');
  await request('notifications/initialized', {}, null);
  assert.equal((await request('tools/list')).result.tools[0].name, 'browser');
  assert.equal((await request('tools/call', { name:'shell', arguments:{} })).error.code, -32602);
  assert.equal((await request('tools/call', { name:'browser', arguments:{ action:'tabs', agentId:'bob' } })).error.code, -32602);
  assert.equal(calls, 0);
  await transport.close();
});

test('disabled or ungranted browser MCP adds no catalogue or process and keeps native browser available', async t => {
  for (const entry of [{ ...preset, enabled:false }, { ...preset, agentIds:[] }]) {
    const manager = managerFor(t, entry);
    assert.ok(manager.definitionsFor('alice').some(item => item.name === 'browser'));
    assert.ok(!manager.definitionsFor('alice').some(item => item.name === 'search_tools'));
    assert.equal(manager.extensions.clients.size, 0);
    assert.equal(manager.browserTools.sessions.size, 0);
    await assert.rejects(manager.execute('alice', { name:'search_tools', args:{} }), /Unknown tool name/);
  }
});

test('discovery is lazy, grants remain per member and built-in credentials cannot select an external server', async t => {
  const manager = managerFor(t, preset, { extensionSecrets:{ 'class-browser':{ env:{ SECRET:'ignored' }, headers:{ Authorization:'ignored' } } } });
  const tool = await discover(manager);
  assert.equal(manager.browserTools.sessions.size, 0);
  assert.equal(manager.children.size, 0);
  assert.ok(!manager.definitionsFor('bob').some(item => item.name === tool || item.name === 'search_tools'));
  await assert.rejects(manager.execute('bob', { name:tool, args:{ action:'tabs' } }), /Unknown tool name/);
  const calls = [];
  manager.browserTools.execute = async (member, name, args) => { calls.push({ member, name, args }); return { output:'{"tabs":[]}' }; };
  await manager.execute('alice', { name:tool, args:{ action:'tabs' } });
  assert.deepEqual(calls, [{ member:'alice', name:'browser', args:{ action:'tabs' } }]);
  await assert.rejects(manager.execute('alice', { name:tool, args:{ action:'tabs', agentId:'bob' } }), /rejected the request/);
  assert.equal(calls.length, 1);
});

test('browser MCP carries images through the standard media path and preserves uncertain mutation failures', async t => {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-browser-mcp-media-'));
  t.after(async () => { const actual=await fs.realpath(directory); assert.equal(path.dirname(actual),parent); assert.ok(path.basename(actual).startsWith('class-browser-mcp-media-')); assert.equal((await fs.lstat(directory)).isSymbolicLink(),false); await fs.rm(actual,{recursive:true,force:true}); });
  const manager = managerFor(t, preset, { cwd:directory }), tool = await discover(manager);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRIYAAAAASUVORK5CYII=';
  manager.browserTools.execute = async () => ({ output:'{"format":"png"}', media:[{ type:'image', mimeType:'image/png', data:png }] });
  const screenshot = await manager.execute('alice', { name:tool, args:{ action:'screenshot' } });
  assert.equal(screenshot.media[0].mimeType, 'image/png');
  assert.equal(screenshot.media[0].data, png);
  assert.ok(screenshot.media[0].path.startsWith('.class-artifacts'));
  manager.browserTools.execute = async () => { throw Object.assign(Error('Navigation response lost'), { executionStatus:'unknown' }); };
  const failed = await manager.execute('alice', { name:tool, args:{ action:'navigate', url:'http://127.0.0.1/' } });
  assert.equal(failed.success, false);
  assert.equal(failed.executionStatus, 'unknown');
});

test('browser MCP respects the task pause gate and cancellation without replay', async t => {
  const manager = managerFor(t), tool = await discover(manager);
  let calls = 0, observedSignal;
  manager.browserTools.execute = async (_member, _name, _args, signal) => {
    calls++; observedSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once:true });
      if (signal.aborted) reject(signal.reason);
    });
  };
  await manager.pauseAll();
  const controller = new AbortController();
  const work = manager.execute('alice', { name:tool, args:{ action:'tabs' } }, { signal:controller.signal });
  const rejected = assert.rejects(work);
  await delay(30); assert.equal(calls, 0);
  await manager.resumeAll();
  for (let n = 0; n < 100 && !calls; n++) await delay(5);
  assert.equal(calls, 1);
  controller.abort(Error('Owned cancellation fixture'));
  await rejected;
  assert.equal(observedSignal.aborted, true);
  assert.equal(calls, 1);
});

test('checkpoint restoration refreshes browser schemas without replaying pages or inheriting revoked grants', async t => {
  const manager = managerFor(t), tool = await discover(manager);
  const snapshot = manager.exportState();
  const resumed = managerFor(t);
  resumed.importState(snapshot); await resumed.prepare();
  assert.ok(resumed.definitionsFor('alice').some(item => item.name === tool));
  assert.equal(resumed.browserTools.sessions.size, 0);
  const revoked = managerFor(t, { ...preset, enabled:false });
  revoked.importState(snapshot); await revoked.prepare();
  assert.ok(!revoked.definitionsFor('alice').some(item => item.name === tool || item.name === 'search_tools'));
  assert.equal(revoked.extensions.clients.size, 0);
});

test('browser MCP controls only owned browser sessions against a local page', { timeout:90000 }, async t => {
  let executable;
  try { executable = await findBrowserExecutable(); } catch { t.skip('No supported installed browser on this test host'); return; }
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'class-browser-mcp-'));
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>Owned MCP fixture</title><input id="value"><button id="apply" onclick="document.getElementById(\'result\').textContent=document.getElementById(\'value\').value">Apply</button><p id="result">Waiting</p>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = new ToolManager({ cwd:directory, extensionConfig:{ mcps:[{ ...preset, agentIds:['alice','bob'] }] }, browserOptions:{ executablePath:executable } });
  t.after(async () => {
    try { await manager.stopAll(); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const actual = await fs.realpath(directory);
    assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(actual).startsWith('class-browser-mcp-'));
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    await fs.rm(actual, { recursive:true, force:true });
  });
  const tool = await discover(manager), bobTool = await discover(manager, 'bob');
  assert.equal(manager.browserTools.sessions.size, 0);
  const call = (args, member = 'alice', name = tool) => manager.execute(member, { name, args });
  const opened = await call({ action:'open', url:'http://127.0.0.1:'+server.address().port });
  assert.equal(opened.success, true);
  await call({ action:'fill', selector:'#value', text:'MCP local success' });
  await call({ action:'click', selector:'#apply' });
  const snapshot = await call({ action:'snapshot' });
  assert.match(snapshot.output, /MCP local success/);
  const screenshot = await call({ action:'screenshot' });
  assert.equal(screenshot.media[0].mimeType, 'image/png');
  await call({ action:'open', url:'about:blank' }, 'bob', bobTool);
  assert.equal(manager.browserTools.sessions.size, 2);
  await call({ action:'close', all:true });
  assert.equal(manager.browserTools.sessions.has('alice'), false);
  assert.equal(manager.browserTools.sessions.has('bob'), true);
  await call({ action:'close', all:true }, 'bob', bobTool);
  assert.equal(manager.browserTools.sessions.size, 0);
});
