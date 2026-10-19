import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { runBrowserMCPServer } from '../src/browser-mcp-server.js';
import { findBrowserExecutable } from '../src/browser-tools.js';
import { ToolManager } from '../src/tools.js';
import { ensureBuiltinBrowserPreset } from '../src/extension-config.js';

const serverEntry = fileURLToPath(new URL('../src/browser-mcp-server.js', import.meta.url));
const desktopEntry = fileURLToPath(new URL('../src/desktop.js', import.meta.url));
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await delay(20); } while (Date.now() < deadline);
  throw Error(label + ' timed out');
}
async function fixture(t, { desktop = false, browser, trace = false } = {}) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'cbmcp-'));
  const dataDir = path.join(directory, 'must-not-create-profile'), traceFile = path.join(directory, 'owned-browser.jsonl');
  const extra = [];
  if (trace) {
    const script = path.join(directory, 'trace.mjs');
    await fs.writeFile(script, `import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawn; cp.spawn=function(command,args,options){ const child=original.call(this,command,args,options); const profile=args?.find(arg=>arg.startsWith('--user-data-dir=')); if(profile) fs.appendFileSync(process.env.CLASS_MCP_TEST_TRACE,JSON.stringify({pid:child.pid,profile:profile.slice(16)})+'\\n'); return child; }; syncBuiltinESMExports();`);
    extra.push('--import', pathToFileURL(script).href);
  }
  const child = spawn(process.execPath, [...extra, desktop ? desktopEntry : serverEntry, ...(desktop ? ['--browser-mcp', '--data-dir', dataDir] : [])], {
    cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLASS_DATA_DIR: dataDir, CLASS_BROWSER_EXECUTABLE: browser || path.join(directory, 'no-browser-installed'), CLASS_MCP_TEST_TRACE: traceFile, TEMP: directory, TMP: directory, TMPDIR: directory },
  });
  let buffer = '', stderr = '', sequence = 0, parseError;
  const messages = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk.toString(); let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { const value = JSON.parse(line); assert.equal(value.jsonrpc, '2.0'); messages.set(value.id, value); } catch (error) { parseError = error; }
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const send = (method, params = {}, id = ++sequence) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === null ? {} : { id }) }) + '\n'); return id; };
  const response = async id => { await until(() => { if (parseError) throw parseError; if (child.exitCode !== null || child.signalCode !== null) throw Error('Owned MCP server exited: ' + stderr); return messages.has(id); }, 'MCP response ' + id, 30000); return messages.get(id); };
  const request = (method, params) => response(send(method, params));
  const stop = async () => {
    child.stdin.end();
    await until(() => child.exitCode !== null || child.signalCode !== null, 'owned server shutdown', 30000);
    assert.deepEqual(await closed, { code: 0, signal: null }, stderr); assert.equal(buffer, ''); assert.equal(parseError, undefined);
    await assert.rejects(fs.stat(dataDir), { code: 'ENOENT' });
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      try { await until(() => child.exitCode !== null || child.signalCode !== null, 'cleanup', 30000); }
      finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
    }
    await closed;
    const actual = await fs.realpath(directory); assert.equal(path.dirname(actual), parent); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    await fs.rm(actual, { recursive: true, force: true });
  });
  return { child, directory, traceFile, send, response, request, stop, hasResponse: id => messages.has(id), async initialize() {
    const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'isolated test', version: '1' } });
    assert.equal(initialized.result.serverInfo.name, 'Class browser'); send('notifications/initialized', {}, null);
  } };
}

for (const desktop of [false, true]) test(`${desktop ? 'desktop --browser-mcp' : 'source'} serves real stdio without UI/profile/browser startup`, { timeout: 45000 }, async t => {
  const f = await fixture(t, { desktop });
  assert.deepEqual((await f.request('class/browser/pause')).result, {});
  assert.deepEqual((await f.request('class/browser/resume')).result, {});
  await f.initialize();
  const listed = await f.request('tools/list');
  assert.equal(listed.result.tools.length, 1); assert.equal(listed.result.tools[0].name, 'browser');
  assert.equal(listed.result.tools[0].inputSchema.additionalProperties, false);
  assert.deepEqual(JSON.parse((await f.request('tools/call', { name: 'browser', arguments: { action: 'tabs' } })).result.content[0].text), { tabs: [] });
  assert.equal((await f.request('tools/call', { name: 'browser', arguments: { action: 'tabs', agentId: 'other' } })).error.code, -32602);
  assert.equal((await f.request('tools/call', { name: 'shell', arguments: {} })).error.code, -32602);
  const opened = await f.request('tools/call', { name: 'browser', arguments: { action: 'open' } });
  assert.equal(opened.result.isError, true); assert.match(opened.result.content[0].text, /No supported browser/);
  assert.deepEqual((await f.request('ping')).result, {});
  assert.deepEqual(await fs.readdir(f.directory), []);
  await f.stop();
});

test('default browser preset uses per-member stdio children through the complete ToolManager lifecycle', { timeout: 45000 }, async t => {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'cbmcp-parent-'));
  const config = ensureBuiltinBrowserPreset({ mcps: [], skills: [] }), preset = config.mcps[0];
  assert.deepEqual({ command: preset.command, args: preset.args, transport: preset.transport }, { command: 'Class', args: ['--browser-mcp'], transport: 'stdio' });
  preset.enabled = true; preset.agentIds = ['alice', 'bob'];
  const realBrowser = process.env.CLASS_TEST_BROWSER_MCP === '1';
  const traceFile = path.join(directory, 'owned-browser.jsonl');
  const env = realBrowser
    ? { TEMP: directory, TMP: directory, TMPDIR: directory }
    : { CLASS_BROWSER_EXECUTABLE: path.join(directory, 'no-browser-installed') };
  if (realBrowser) {
    const script = path.join(directory, 'trace.mjs');
    await fs.writeFile(script, `import cp from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawn; cp.spawn=function(command,args,options){ const child=original.call(this,command,args,options); const chromium=args?.find(arg=>arg.startsWith('--user-data-dir=')); const index=args?.indexOf('--profile'); const profile=chromium?.slice(16)||(index>=0?args[index+1]:undefined); if(profile&&path.basename(profile).startsWith('class-browser-')) fs.appendFileSync(process.env.CLASS_MCP_TEST_TRACE,JSON.stringify({pid:child.pid,profile})+'\\n'); return child; }; syncBuiltinESMExports();`);
    env.NODE_OPTIONS = ((env.NODE_OPTIONS || '') + ' --import=' + pathToFileURL(script).href).trim();
    env.CLASS_MCP_TEST_TRACE = traceFile;
  }
  const manager = new ToolManager({ cwd: directory, extensionConfig: config, extensionSecrets: { [preset.id]: { env } } });
  t.after(async () => {
    await manager.stopAll(); const actual = await fs.realpath(directory); assert.equal(path.dirname(actual), parent); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false); await fs.rm(actual, { recursive: true, force: true });
  });
  const tools = {};
  for (const member of preset.agentIds) {
    const result = await manager.execute(member, { name: 'search_tools', args: { mcpId: preset.id } });
    const catalogue = JSON.parse(result.output); assert.equal(catalogue.errors, undefined); assert.equal(catalogue.tools.length, 1); tools[member] = catalogue.tools[0].name;
    const tabs = await manager.execute(member, { name: tools[member], args: { action: 'tabs' } });
    assert.deepEqual(JSON.parse(JSON.parse(tabs.output).content[0].text), { tabs: [] });
  }
  const records = [...manager.children]; assert.equal(records.length, 2); assert.notEqual(records[0].child.pid, records[1].child.pid); assert.ok(records.every(record => record.classBrowserMcp));
  let ownedBrowsers = [];
  if (realBrowser) {
    const opened = await manager.execute('alice', { name: tools.alice, args: { action: 'open', url: 'about:blank' } });
    assert.equal(opened.success, true, 'Default stdio browser discovery failed: ' + opened.output);
    assert.ok((await fs.readdir(directory)).some(name => name.startsWith('class-browser-')));
    ownedBrowsers = (await fs.readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(ownedBrowsers.length > 0);
    for (const item of ownedBrowsers) { assert.ok(item.pid > 0); assert.equal((await fs.stat(item.profile)).isDirectory(), true); }
  }
  await manager.pauseAll(); assert.ok(records.every(record => !record.suspended));
  let completed = false;
  const waiting = manager.execute('alice', { name: tools.alice, args: { action: 'tabs' } }).then(result => { completed = true; return result; });
  await delay(100); assert.equal(completed, false);
  await manager.resumeAll(); assert.equal((await waiting).success, true);
  await manager.pauseAll(); await manager.stopAll();
  for (const record of records) assert.deepEqual(await record.closed, { code: 0, signal: null });
  assert.equal(manager.children.size, 0);
  for (const item of ownedBrowsers) { assert.throws(() => process.kill(item.pid, 0), error => error.code === 'ESRCH'); await assert.rejects(fs.stat(item.profile), { code: 'ENOENT' }); }
  const remaining = await fs.readdir(directory);
  assert.ok(!remaining.some(name => name.startsWith('class-browser-')), 'owned browser profiles must be removed');
  if (!realBrowser) assert.deepEqual(remaining, []);
});

test('stdio cancellation, EOF and SIGTERM abort pending calls and await ownership cleanup', async t => {
  for (const ending of ['eof', 'SIGTERM']) await t.test(ending, async () => {
    const input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter();
    let calls = 0, aborted = 0, stopped = 0, text = '';
    output.on('data', chunk => { text += chunk; });
    const manager = { checkpoint: async signal => signal.throwIfAborted(), browserTools: { sessions: new Map(), execute: async (member, _name, _args, signal) => {
      assert.equal(member, 'browser-mcp'); calls++;
      await new Promise((resolve, reject) => { const abort = () => { aborted++; reject(signal.reason); }; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    } }, stopAll: async () => { await delay(15); stopped++; } };
    const work = runBrowserMCPServer({ input, output, manager, signalSource: signals });
    const send = message => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }); send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'browser', arguments: { action: 'open' } } });
    await until(() => calls === 1, 'first pending call');
    send({ method: 'notifications/cancelled', params: { requestId: 2 } }); await until(() => aborted === 1, 'request cancellation');
    send({ id: 3, method: 'tools/call', params: { name: 'browser', arguments: { action: 'open' } } });
    await until(() => calls === 2, 'second pending call');
    if (ending === 'eof') input.end(); else signals.emit('SIGTERM');
    await work;
    assert.equal(aborted, 2); assert.equal(stopped, 1); assert.equal(signals.listenerCount('SIGTERM'), 0);
    const replies = text.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(replies.find(reply => reply.id === 2).error.code, -32800); assert.equal(replies.find(reply => reply.id === 3).error.code, -32800);
  });
});

test('real browser stdio pause/resume and EOF remove only owned processes and profiles', { skip: process.env.CLASS_TEST_BROWSER_MCP !== '1', timeout: 120000 }, async t => {
  const browser = await findBrowserExecutable();
  // The ownership trace below records Chromium's explicit temporary profile.
  if (/firefox/i.test(path.basename(browser))) { t.skip('Chromium ownership trace fixture'); return; }
  const page = createServer((_req, res) => { res.end('<!doctype html><title>Isolated stdio</title><p>local-browser-stdio-evidence</p>'); });
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  t.after(async () => { page.closeAllConnections(); await new Promise(resolve => page.close(resolve)); });
  const f = await fixture(t, { browser, trace: true }); await f.initialize();
  const opened = await f.request('tools/call', { name: 'browser', arguments: { action: 'open', url: 'http://127.0.0.1:' + page.address().port } });
  assert.equal(opened.result.isError, false, JSON.stringify(opened));
  assert.deepEqual((await f.request('class/browser/pause')).result, {});
  const waiting = f.send('tools/call', { name: 'browser', arguments: { action: 'snapshot' } });
  await delay(100);
  assert.equal(f.hasResponse(waiting), false, 'paused browser must not finish a page operation');
  assert.deepEqual((await f.request('class/browser/resume')).result, {});
  assert.match((await f.response(waiting)).result.content[0].text, /local-browser-stdio-evidence/);
  const owned = (await fs.readFile(f.traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.ok(owned.length > 0);
  for (const item of owned) { assert.ok(item.pid > 0); assert.match(path.basename(item.profile), /^class-browser-/); assert.equal((await fs.stat(item.profile)).isDirectory(), true); }
  assert.deepEqual((await f.request('class/browser/pause')).result, {});
  await f.stop();
  for (const item of owned) { assert.throws(() => process.kill(item.pid, 0), error => error.code === 'ESRCH'); await assert.rejects(fs.stat(item.profile), { code: 'ENOENT' }); }
});
