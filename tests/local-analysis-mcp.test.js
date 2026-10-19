import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { runLocalAnalysisMCPServer } from '../src/local-analysis-mcp.js';
import { captureLinuxProcessIdentity, killLinuxDescendants } from '../src/owned-linux-processes.js';

async function until(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  throw Error(label + ' timed out');
}

// Real harmless child processes; the manager double avoids starting Windows
// PowerShell just to test protocol handling. Linux additionally tests the real
// ToolManager and /proc ownership cleanup below.
function processManager() {
  const events = new EventEmitter(), children = new Set();
  return {
    events, children, paused: false, stopped: false, stopCount: 0,
    async checkpoint(signal) {
      signal.throwIfAborted();
      while (this.paused && !this.stopped) await new Promise((resolve, reject) => {
        const cleanup = () => { events.off('change', change); signal.removeEventListener('abort', abort); };
        const change = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason); };
        events.on('change', change); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted(); if (this.stopped) throw Error('Stopped');
    },
    async adoptProcess(child) {
      const record = { child }; children.add(record);
      record.closed = new Promise(resolve => child.once('close', (code, sig) => { children.delete(record); resolve({ code, sig }); }));
      if (!child.pid) await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      return record;
    },
    async _kill(record) {
      if (record.child.exitCode !== null || record.child.signalCode !== null) return;
      if (process.platform === 'win32') record.child.kill('SIGKILL');
      else { try { process.kill(-record.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      await record.closed;
    },
    async pauseAll() { this.paused = true; events.emit('change'); },
    async resumeAll() { this.paused = false; events.emit('change'); },
    async stopAll() { this.stopCount++; this.stopped = true; events.emit('change'); await Promise.all([...children].map(record => this._kill(record))); },
  };
}

async function fixture(t, kind, options = {}) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-local-analysis-'));
  const fake = path.join(directory, 'owned-cli.mjs'), inputPath = path.join(directory, 'owned input; echo injection.bin');
  await fs.writeFile(inputPath, Buffer.from([0, 255, 1, 128]));
  await fs.writeFile(fake, `import {spawn} from 'node:child_process';
const args=JSON.parse(process.argv[2]),mode=process.env.LOCAL_FAKE_MODE;
if(args.includes('--help')||args[0]==='-c'){
  if(mode==='missing-import'){process.stderr.write('No module named pwn');process.exit(1);}
  process.stdout.write('owned dependency ready');process.exit(0);
}
if(mode==='wait'||mode==='fork'){
  if(mode==='fork'){
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    process.stdout.write(JSON.stringify({ownedChild:child.pid})+'\\n');
  }else process.stdout.write('started');
  setInterval(()=>{},1000);
}else if(mode==='binary')process.stdout.write(Buffer.from([0,255,128,13,10,0,65]));
else if(mode==='verbose')process.stdout.write(Buffer.alloc(4096,65));
else if(mode==='failure'){process.stderr.write('owned tool error');process.exitCode=2;}
else {let text='';for await(const data of process.stdin)text+=data;process.stdout.write(JSON.stringify({args:args[0]==='-u'?[args[0],args[1],'<script>']:args,stdin:text,cwd:process.cwd(),secret:process.env.CLASS_API_KEY??null}));}
`);
  if (options.realPython) await fs.writeFile(path.join(directory, 'pwn.py'), 'class _Context: pass\ncontext = _Context()\n__all__ = ["context"]\n');
  const input = new PassThrough(), output = new PassThrough(), signalSource = new EventEmitter();
  const calls = [], children = [], messages = [], manager = options.realManager ? undefined : processManager();
  let mode = options.mode || 'success', buffer = '', sequence = 0, parseError, ended;
  output.on('data', data => {
    buffer += data.toString(); let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { const value = JSON.parse(line); assert.equal(value.jsonrpc, '2.0'); messages.push(value); } catch (error) { parseError = error; }
    }
  });
  const environment = { ...process.env, CLASS_API_KEY: 'must-not-reach-cli', CLASS_ZSTEG_PATH: 'owned-zsteg', CLASS_BINWALK_PATH: 'owned-binwalk', CLASS_PWNTOOLS_PYTHON: 'owned-python' };
  if (options.realPython) { environment.CLASS_PWNTOOLS_PYTHON = 'python3'; environment.PYTHONPATH = directory; }
  const work = runLocalAnalysisMCPServer(kind, {
    input, output, signalSource, manager, env: environment, ...options.server,
    spawnImpl(command, args, settings) {
      calls.push({ command, args, settings });
      assert.equal(settings.shell, false);
      const child = options.realPython ? spawn(command, args, settings) : mode === 'missing-executable'
        ? spawn(path.join(directory, 'missing-owned-command'), args, settings)
        : spawn(process.execPath, [fake, JSON.stringify(args)], { ...settings, env: { ...settings.env, LOCAL_FAKE_MODE: mode } });
      children.push(child); return child;
    },
  });
  work.then(() => { ended = true; }, error => { ended = error; });
  const send = (method, params = {}, id = ++sequence) => { input.write(JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === null ? {} : { id }) }) + '\n'); return id; };
  const response = async id => { await until(() => { if (parseError) throw parseError; return messages.some(message => message.id === id); }, 'response ' + id, 10000); return messages.find(message => message.id === id); };
  const request = (method, params) => response(send(method, params));
  const initialize = async () => { const result = await request('initialize', { protocolVersion: '2025-06-18' }); assert.equal(result.result?.serverInfo.name, 'Class ' + kind, JSON.stringify(result)); send('notifications/initialized', {}, null); };
  t.after(async () => {
    if (!ended) input.end();
    await work;
    assert.equal(parseError, undefined); assert.equal(buffer, '');
    for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null || !child.pid, 'owned child must exit');
    assert.equal(signalSource.listenerCount('SIGTERM'), 0);
    const actual = await fs.realpath(directory); assert.equal(path.dirname(actual), parent); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    await fs.rm(actual, { recursive: true, force: true });
  });
  return { directory, inputPath, input, output, calls, children, manager, messages, signalSource, work, send, response, request, initialize, setMode(value) { mode = value; } };
}

test('local MCP requires the real dependency check and lists only its own tools', async t => {
  for (const [kind, names] of [['zsteg', ['zsteg_scan', 'zsteg_extract']], ['binwalk', ['binwalk_scan', 'binwalk_extract']], ['pwntools', ['pwntools_run']]]) await t.test(kind, async t => {
    const f = await fixture(t, kind);
    assert.equal((await f.request('tools/list')).error.code, -32000);
    await f.initialize();
    assert.deepEqual((await f.request('tools/list')).result.tools.map(tool => tool.name), names);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].args[0], kind === 'pwntools' ? '-c' : '--help');
    assert.deepEqual((await f.request('ping')).result, {});
    assert.equal((await f.request('tools/call', { name: 'shell', arguments: {} })).error.code, -32602);
  });
});

test('missing executable or pwntools import fails initialize without claiming connectivity', async t => {
  for (const mode of ['missing-executable', 'missing-import']) await t.test(mode, async t => {
    const f = await fixture(t, 'pwntools', { mode });
    const result = await f.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(result.error.code, -32000); assert.match(result.error.message, /dependency unavailable/);
    assert.equal((await f.request('tools/list')).error.code, -32000);
  });
});

test('paths and argv are structured; unknown arguments, relative paths and malicious selectors never run', async t => {
  const f = await fixture(t, 'zsteg'); await f.initialize();
  const scanned = await f.request('tools/call', { name: 'zsteg_scan', arguments: { path: f.inputPath, all: true } });
  assert.equal(scanned.result.isError, false);
  assert.deepEqual(f.calls[1].args, ['--no-color', '--all', '--', f.inputPath]);
  assert.equal(f.calls[1].settings.env.CLASS_API_KEY, undefined);
  for (const args of [{ path: 'relative.png' }, { path: f.inputPath, extra: true }, { path: f.inputPath, all: 'true' }]) {
    assert.equal((await f.request('tools/call', { name: 'zsteg_scan', arguments: args })).error.code, -32602);
  }
  assert.equal((await f.request('tools/call', { name: 'zsteg_extract', arguments: { path: f.inputPath, selector: '1b;touch owned', outputPath: path.join(f.directory, 'new.bin') } })).error.code, -32602);
  assert.equal(f.calls.length, 2);
});

test('zsteg binary extraction preserves bytes, refuses overwrite and removes failed partial output', async t => {
  const f = await fixture(t, 'zsteg'); await f.initialize(); f.setMode('binary');
  const outputPath = path.join(f.directory, 'payload.bin');
  const params = { name: 'zsteg_extract', arguments: { path: f.inputPath, selector: '1b,rgb,lsb', outputPath } };
  const result = await f.request('tools/call', params);
  assert.equal(result.result.isError, false); assert.deepEqual(await fs.readFile(outputPath), Buffer.from([0,255,128,13,10,0,65]));
  const extraPath = path.join(f.directory, 'extra-payload.bin');
  assert.equal((await f.request('tools/call', { ...params, arguments: { ...params.arguments, selector: 'extradata:0', outputPath: extraPath } })).result.isError, false);
  assert.equal(f.calls.at(-1).args[2], 'extradata:0');
  const count = f.calls.length; assert.equal((await f.request('tools/call', params)).result.isError, true); assert.equal(f.calls.length, count);
  assert.deepEqual(await fs.readFile(outputPath), Buffer.from([0,255,128,13,10,0,65]));
  f.setMode('failure'); const failedPath = path.join(f.directory, 'failed.bin');
  assert.equal((await f.request('tools/call', { ...params, arguments: { ...params.arguments, outputPath: failedPath } })).result.isError, true);
  await assert.rejects(fs.stat(failedPath), { code: 'ENOENT' });
});

test('binary extraction size limit fails without retaining a truncated payload', async t => {
  const f = await fixture(t, 'zsteg', { server: { maxBinaryBytes: 4 } }); await f.initialize(); f.setMode('binary');
  const outputPath = path.join(f.directory, 'oversize.bin');
  const reply = await f.request('tools/call', { name: 'zsteg_extract', arguments: { path: f.inputPath, selector: '1b,rgb,lsb', outputPath } });
  assert.equal(reply.result.isError, true); assert.match(reply.result.content[0].text, /size limit/);
  await assert.rejects(fs.stat(outputPath), { code: 'ENOENT' });
});

test('binwalk uses the common v2/v3 long directory flag and never overwrites a directory', async t => {
  const f = await fixture(t, 'binwalk'); await f.initialize();
  const outputDirectory = path.join(f.directory, 'extracted');
  const params = { name: 'binwalk_extract', arguments: { path: f.inputPath, outputDirectory } };
  assert.equal((await f.request('tools/call', params)).result.isError, false);
  assert.deepEqual(f.calls[1].args, ['--extract', '--directory', outputDirectory, '--', f.inputPath]);
  assert.equal(f.calls[1].args.includes('-M'), false);
  await fs.writeFile(path.join(outputDirectory, 'keep.txt'), 'preserve');
  const count = f.calls.length; assert.equal((await f.request('tools/call', params)).result.isError, true); assert.equal(f.calls.length, count);
  assert.equal(await fs.readFile(path.join(outputDirectory, 'keep.txt'), 'utf8'), 'preserve');
});

test('pwntools runs one complete script via stdin with stderr logging and bounded output', async t => {
  const f = await fixture(t, 'pwntools', { server: { maxOutputBytes: 1024 } }); await f.initialize();
  const code = "print('owned script; no shell')";
  const reply = await f.request('tools/call', { name: 'pwntools_run', arguments: { code, cwd: f.directory, timeoutMs: 25000 } });
  assert.equal(reply.result.isError, false);
  const result = JSON.parse(reply.result.content[0].text), echoed = JSON.parse(result.stdout);
  assert.equal(echoed.stdin, code); assert.equal(echoed.cwd, f.directory); assert.equal(echoed.secret, null);
  assert.match(f.calls[1].args[2], /context\.log_console = sys\.stderr/); assert.equal(f.calls[1].args[0], '-u');
  f.setMode('verbose');
  const large = JSON.parse((await f.request('tools/call', { name: 'pwntools_run', arguments: { code: 'ignored fake input' } })).result.content[0].text);
  assert.equal(large.stdout.length, 1024); assert.equal(large.stdoutTruncated, true); assert.equal(large.truncated, true);
  const count = f.calls.length;
  assert.equal((await f.request('tools/call', { name: 'pwntools_run', arguments: { code, timeoutMs: 25001 } })).error.code, -32602);
  assert.equal(f.calls.length, count);
});

test('timeout and cancellation stop owned processes; concurrent tools cannot expand execution', async t => {
  const f = await fixture(t, 'pwntools'); await f.initialize(); f.setMode('wait');
  const timed = await f.request('tools/call', { name: 'pwntools_run', arguments: { code: 'fake wait', timeoutMs: 120 } });
  assert.equal(timed.result.isError, true); assert.equal(JSON.parse(timed.result.content[0].text).timedOut, true);
  const id = f.send('tools/call', { name: 'pwntools_run', arguments: { code: 'fake wait' } });
  await until(() => f.calls.length === 3, 'owned second tool starts');
  assert.equal((await f.request('tools/call', { name: 'pwntools_run', arguments: { code: 'must not launch' } })).error.code, -32000);
  f.send('notifications/cancelled', { requestId: id }, null);
  assert.equal((await f.response(id)).error.code, -32800);
  await until(() => f.manager.children.size === 0, 'all cancelled owned processes exit');
});

test('pause controls work before initialization, freeze timeout, and resume/EOF cleanly', async t => {
  const f = await fixture(t, 'pwntools');
  assert.deepEqual((await f.request('class/analysis/pause')).result, {});
  const init = f.send('initialize', { protocolVersion: '2025-06-18' });
  await delay(50); assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.request('class/analysis/resume')).result, {});
  assert.equal((await f.response(init)).result.serverInfo.name, 'Class pwntools'); f.send('notifications/initialized', {}, null);
  f.setMode('wait');
  const id = f.send('tools/call', { name: 'pwntools_run', arguments: { code: 'fake wait', timeoutMs: 400 } });
  await until(() => f.calls.length === 2, 'owned waiting process starts');
  assert.deepEqual((await f.request('class/analysis/pause')).result, {});
  await delay(550); assert.equal(f.messages.some(message => message.id === id), false);
  assert.deepEqual((await f.request('class/analysis/resume')).result, {});
  assert.equal(JSON.parse((await f.response(id)).result.content[0].text).timedOut, true);
  f.input.end(); await f.work; assert.equal(f.manager.stopCount, 1); assert.equal(f.manager.events.listenerCount('change'), 0);
});

test('EOF and SIGTERM cancel in-flight tools and remove signal hooks', async t => {
  for (const ending of ['eof', 'SIGTERM']) await t.test(ending, async t => {
    const f = await fixture(t, 'pwntools'); await f.initialize(); f.setMode('wait');
    const id = f.send('tools/call', { name: 'pwntools_run', arguments: { code: 'fake wait' } });
    await until(() => f.calls.length === 2, 'owned pending process starts');
    if (ending === 'eof') f.input.end(); else f.signalSource.emit('SIGTERM');
    await f.work; assert.equal((await f.response(id)).error.code, -32800); assert.equal(f.manager.children.size, 0);
  });
});

test('Linux real manager cancels its observed detached descendants by identity', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const f = await fixture(t, 'pwntools', { realManager: true }); await f.initialize(); f.setMode('fork');
  const id = f.send('tools/call', { name: 'pwntools_run', arguments: { code: 'fake owned descendants', timeoutMs: 1500 } });
  const result = JSON.parse((await f.response(id)).result.content[0].text);
  assert.equal(result.timedOut, true);
  const { ownedChild } = JSON.parse(result.stdout.trim()); assert.ok(Number.isSafeInteger(ownedChild));
  // A reparented process can briefly remain a zombie until init reaps it.
  await until(async () => {
    try { const stat = await fs.readFile('/proc/' + ownedChild + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z '); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }, 'owned detached descendant exits');
});

async function linuxProcessExited(identity) {
  if (!identity) return true;
  const current = await captureLinuxProcessIdentity(identity.pid);
  if (!current || current.startTime !== identity.startTime) return true;
  try { const stat = await fs.readFile('/proc/' + identity.pid + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z '); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

test('Linux detached pwntools heartbeat pauses, resumes, and exits on EOF', { skip: process.platform !== 'linux', timeout: 20000 }, async t => {
  const f = await fixture(t, 'pwntools', { realManager: true, realPython: true }); await f.initialize();
  const heartbeat = path.join(f.directory, 'heartbeat.bin'), pidPath = path.join(f.directory, 'heartbeat.pid');
  const childCode = "import os,sys,time\nwith open(sys.argv[1], 'ab', buffering=0) as output:\n while True:\n  output.write(b'.')\n  time.sleep(0.015)";
  const code = `import os, sys, subprocess, time\nchild = subprocess.Popen([sys.executable, '-u', '-c', ${JSON.stringify(childCode)}, ${JSON.stringify(heartbeat)}], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nwith open(${JSON.stringify(pidPath)}, 'w') as stream: stream.write(str(child.pid))\ntime.sleep(60)`;
  const id = f.send('tools/call', { name: 'pwntools_run', arguments: { code, cwd: f.directory, timeoutMs: 5000 } });
  await until(async () => { try { return (await fs.stat(heartbeat)).size >= 3; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, 'owned heartbeat starts');
  const identity = await captureLinuxProcessIdentity(Number(await fs.readFile(pidPath, 'utf8')));
  assert.ok(identity); t.after(() => killLinuxDescendants([identity]));
  const stat = await fs.readFile('/proc/' + identity.pid + '/stat', 'utf8');
  assert.equal(Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]), identity.pid, 'fixture really created its own process group');
  assert.deepEqual((await f.request('class/analysis/pause')).result, {});
  await delay(50); const pausedSize = (await fs.stat(heartbeat)).size;
  await delay(250); assert.equal((await fs.stat(heartbeat)).size, pausedSize, 'detached descendant must stop writing while paused');
  assert.equal(f.messages.some(message => message.id === id), false);
  assert.deepEqual((await f.request('class/analysis/resume')).result, {});
  await until(async () => (await fs.stat(heartbeat)).size > pausedSize, 'detached heartbeat resumes');
  // Also exercise EOF cleanup while both the direct group and detached child
  // are stopped: only the owned supervisor is resumed to reap its children.
  assert.deepEqual((await f.request('class/analysis/pause')).result, {});
  f.input.end(); await f.work;
  assert.equal((await f.response(id)).error.code, -32800);
  await until(() => linuxProcessExited(identity), 'paused detached child exits on EOF');
});

test('Linux pwntools subreaper collects a fork-and-exit child before the next polling interval', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const f = await fixture(t, 'pwntools', { realManager: true, realPython: true }); await f.initialize();
  const pidPath = path.join(f.directory, 'orphan.json');
  // os._exit deliberately skips Python cleanup. The child creates a new
  // session immediately; its parent exits without sleeping or waiting for a
  // JavaScript /proc sample. The supervisor must retain and reap the orphan.
  const code = `import os, json, time\nreader, writer = os.pipe()\nchild = os.fork()\nif child == 0:\n os.close(reader)\n os.setsid()\n os.write(writer, b'1')\n os.close(writer)\n time.sleep(60)\n os._exit(0)\nos.close(writer)\nos.read(reader, 1)\nos.close(reader)\nwith open('/proc/' + str(child) + '/stat') as stream:\n fields = stream.read().rsplit(')', 1)[1].split()\nwith open(${JSON.stringify(pidPath)}, 'w') as stream:\n json.dump({'pid': child, 'startTime': fields[19], 'group': int(fields[2])}, stream)\nos._exit(0)`;
  const reply = await f.request('tools/call', { name: 'pwntools_run', arguments: { code, cwd: f.directory, timeoutMs: 5000 } });
  const identity = JSON.parse(await fs.readFile(pidPath, 'utf8')); t.after(() => killLinuxDescendants([identity]));
  assert.equal(identity.group, identity.pid, 'forked child entered a separate session before its parent exited');
  assert.equal(reply.result?.isError, false, JSON.stringify(reply));
  assert.equal(JSON.parse(reply.result.content[0].text).exitCode, 0);
  assert.equal(await linuxProcessExited(identity), true, 'tool completion must not retain the rapidly orphaned child');
});

test('malformed and oversized messages are bounded and shutdown does not launch tools', async t => {
  const f = await fixture(t, 'zsteg');
  f.input.write('{bad json}\n'); await until(() => f.messages.length === 1, 'parse error');
  assert.equal(f.messages[0].error.code, -32700);
  f.input.write('x'.repeat(256 * 1024 + 1)); await f.work;
  assert.equal(f.calls.length, 0); assert.equal(f.messages.at(-1).error.code, -32600);
});
