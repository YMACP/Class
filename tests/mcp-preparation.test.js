import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { createMcpPreparer } from '../src/mcp-preparation.js';
import { activeTimeout } from '../src/tool-output.js';

const entry = (builtin, platform = 'win32') => ({ id: `class-${builtin}`, name: builtin, builtin, enabled: true, agentIds: ['teacher'], transport: 'stdio', command: builtin === 'wireshark' && platform === 'linux' ? 'wireshark-mcp' : 'python', args: builtin === 'wireshark' ? [...(platform === 'linux' ? [] : ['-m', 'wireshark_mcp']), 'serve', '--transport', 'stdio', '--profile', 'analysis'] : ['-m', 'mcp_windbg', '--transport', 'stdio'] });
const browser = { id: 'class-browser', builtin: 'browser', transport: 'stdio', command: 'Class', args: ['--browser-mcp'] };
async function fixture(t, { platform = 'win32', found = { tshark: '/fixture/tshark', python: '/fixture/python' }, beforeRun, ...options } = {}) {
  const parent = await fs.realpath(os.tmpdir()), base = await fs.mkdtemp(path.join(parent, 'class-mcp-preparation-'));
  const cacheDir = path.join(base, 'runtime');
  t.after(async () => {
    const actual = await fs.realpath(base);
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('class-mcp-preparation-'));
    assert.equal((await fs.lstat(base)).isSymbolicLink(), false); await fs.rm(actual, { recursive: true, force: true });
  });
  const calls = [], probes = [];
  const run = async (command, args, opts) => {
    calls.push({ command, args, options: opts });
    await beforeRun?.(command, args, opts);
    const at = args.indexOf('venv');
    if (at >= 0) {
      const venv = args.at(-1), python = path.join(venv, platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'python.exe' : 'python');
      await fs.mkdir(path.dirname(python), { recursive: true }); await fs.writeFile(python, 'owned fixture only', { mode: 0o700 });
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const probe = async (names, candidates) => { probes.push({ names, candidates }); return names.map(name => found[name]).find(Boolean) || null; };
  const config = { cacheDir, platform, env: { PATH: '/fixture', HOME: base, USERPROFILE: base, APP_API_KEY: 'must-not-leak', PYTHONPATH: '/untrusted', PIP_INDEX_URL: 'https://untrusted.invalid', UV_INDEX: 'https://untrusted.invalid' }, run, probe, ...options };
  return { base, cacheDir, calls, probes, config, prepare: createMcpPreparer(config).prepare };
}
const absent = async filename => { await assert.rejects(fs.access(filename), { code: 'ENOENT' }); };

test('custom MCP and modified builtin commands never trigger discovery or installation', async t => {
  const host = await fixture(t);
  for (const server of [{ ...entry('wireshark'), builtin: undefined }, { ...entry('wireshark'), args: ['-m', 'something_from_model'] }, { ...entry('wireshark'), cwd: '/task' }, { ...entry('wireshark'), command: '/user/chosen/python' }]) {
    assert.equal((await host.prepare(server)).status, 'manual');
  }
  assert.equal(host.calls.length, 0); assert.equal(host.probes.length, 0); await absent(host.cacheDir);
});

test('missing actual tool skips dependencies and creates no cache', async t => {
  const host = await fixture(t, { found: {} });
  assert.equal((await host.prepare(entry('wireshark'))).status, 'missing-tool');
  assert.equal(host.calls.length, 0); await absent(host.cacheDir);
});

test('installed TShark gets pinned isolated adapter and runtime-only launch override', async t => {
  const host = await fixture(t), server = entry('wireshark'), original = structuredClone(server);
  const secret = { env: { TOKEN: 'private-mcp-token', WIRESHARK_MCP_ALLOWED_DIRS: '/user/captures' }, headers: { Authorization: 'private-header' } }, beforeSecret = structuredClone(secret);
  const value = await host.prepare(server, { secret });
  assert.equal(value.status, 'prepared'); assert.deepEqual(server, original); assert.deepEqual(secret, beforeSecret);
  assert.ok(value.server.command.startsWith(host.cacheDir)); assert.deepEqual(value.server.args, server.args);
  assert.deepEqual(value.server.agentIds, ['teacher']); assert.equal(value.secret.env.TOKEN, secret.env.TOKEN);
  assert.equal(value.secret.env.WIRESHARK_MCP_TSHARK_PATH, '/fixture/tshark');
  const install = host.calls.find(call => call.args.includes('install'));
  assert.ok(install.args.includes('--isolated')); assert.ok(install.args.includes('wireshark-mcp==3.1.0')); assert.ok(install.args.includes('https://pypi.org/simple'));
  for (const call of host.calls) {
    assert.equal(call.options.cwd, host.cacheDir); assert.equal(call.options.env.TOKEN, undefined); assert.equal(call.options.env.APP_API_KEY, undefined);
    assert.equal(call.options.env.PYTHONPATH, undefined); assert.equal(call.options.env.PIP_INDEX_URL, undefined); assert.equal(call.options.env.UV_INDEX, undefined);
    assert.ok(call.options.env.TMP.startsWith(host.cacheDir)); assert.ok(call.options.timeoutMs <= 120000); assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.ok(!JSON.stringify(host.calls).includes('private-mcp-token'));
});

test('WinDbg recipe requires cdb and passes its verified path only at runtime', async t => {
  const host = await fixture(t, { found: { cdb: 'C:\\Tools\\cdb.exe', python: '/fixture/python' } });
  const value = await host.prepare(entry('windbg'));
  assert.equal(value.status, 'prepared'); assert.deepEqual(value.server.args.slice(-2), ['--cdb-path', 'C:\\Tools\\cdb.exe']);
  assert.ok(host.calls.find(call => call.args.includes('mcp-windbg==1.5.1')));
  const linux = await fixture(t, { platform: 'linux' });
  assert.equal((await linux.prepare(entry('windbg'))).status, 'manual'); assert.equal(linux.calls.length, 0);
});

test('existing uv confines managed Python and pinned package installation to owned cache', async t => {
  const host = await fixture(t, { platform: 'linux', found: { tshark: '/fixture/tshark', uv: '/fixture/uv' } });
  const value = await host.prepare(entry('wireshark', 'linux'));
  assert.equal(value.status, 'prepared'); assert.ok(value.server.command.endsWith(path.join('bin', 'python')));
  const create = host.calls.find(call => call.args.includes('venv'));
  assert.ok(create.args.includes('3.12')); assert.ok(create.args.includes('--no-config')); assert.ok(create.options.env.UV_PYTHON_INSTALL_DIR.startsWith(host.cacheDir));
  assert.ok(host.calls.find(call => call.args.includes('wireshark-mcp==3.1.0'))); assert.ok(!host.calls.some(call => ['sudo', 'apt', 'winget', 'powershell'].includes(call.command)));
});

test('verified cache is reused without downloading or reinstalling', async t => {
  const host = await fixture(t);
  assert.equal((await host.prepare(entry('wireshark'))).status, 'prepared');
  host.calls.length = 0;
  const another = createMcpPreparer(host.config);
  assert.equal((await another.prepare(entry('wireshark'))).status, 'prepared');
  assert.equal(host.calls.length, 1); assert.ok(host.calls[0].args.includes('-c')); assert.ok(!host.calls[0].args.includes('install'));
});

test('uv retries a cancelled package installation using the intact venv without recreating it', async t => {
  let installed = false, attempts = 0;
  const host = await fixture(t, {
    platform: 'linux', found: { tshark: '/fixture/tshark', uv: '/fixture/uv' },
    beforeRun: async (_command, args) => {
      if (args.includes('install')) { attempts++; if (attempts === 1) throw new Error('network interrupted'); installed = true; }
      if (args.includes('-c') && args.at(-1).includes('importlib.metadata') && !installed) throw new Error('adapter not installed');
    },
  });
  assert.equal((await host.prepare(entry('wireshark', 'linux'))).status, 'failed');
  await absent(path.join(host.cacheDir, '.installation-lock.json'));
  const value = await host.prepare(entry('wireshark', 'linux'));
  assert.equal(value.status, 'prepared'); assert.equal(attempts, 2);
  assert.equal(host.calls.filter(call => call.args.includes('venv')).length, 1);
  assert.ok(!host.calls.some(call => call.args.includes('--allow-existing') || call.args.includes('--clear')));
  await absent(path.join(host.cacheDir, '.installation-lock.json'));
});

test('partial venv creation is preserved and a fresh attempt is persisted for reuse', async t => {
  let first = true, abandoned;
  const host = await fixture(t, {
    platform: 'linux', found: { tshark: '/fixture/tshark', uv: '/fixture/uv' },
    beforeRun: async (_command, args) => {
      if (args.includes('venv') && first) {
        first = false; abandoned = args.at(-1); await fs.mkdir(abandoned, { recursive: true });
        await fs.writeFile(path.join(abandoned, 'partial.txt'), 'preserve interrupted attempt'); throw new Error('creation interrupted');
      }
    },
  });
  assert.equal((await host.prepare(entry('wireshark', 'linux'))).status, 'failed');
  const value = await host.prepare(entry('wireshark', 'linux'));
  assert.equal(value.status, 'prepared'); assert.ok(!value.server.command.startsWith(abandoned + path.sep));
  assert.equal(await fs.readFile(path.join(abandoned, 'partial.txt'), 'utf8'), 'preserve interrupted attempt');
  const pointer = JSON.parse(await fs.readFile(path.join(path.dirname(abandoned), 'environment.json'), 'utf8'));
  assert.match(pointer.directory, /^venv-[a-f0-9-]{36}$/); assert.ok(value.server.command.includes(pointer.directory));
  host.calls.length = 0;
  const reused = await createMcpPreparer(host.config).prepare(entry('wireshark', 'linux'));
  assert.equal(reused.status, 'prepared'); assert.equal(reused.server.command, value.server.command);
  assert.equal(host.calls.length, 1); assert.ok(!host.calls[0].args.includes('venv'));
});

test('an independent process or crash lock prevents mutation and is never removed automatically', async t => {
  const host = await fixture(t); assert.equal((await host.prepare(entry('wireshark'))).status, 'prepared');
  const filename = path.join(host.cacheDir, '.installation-lock.json');
  const value = JSON.stringify({ owner: 'class-mcp-runtime-v1', pid: process.pid, token: 'different-process-token', createdAt: '2020-01-01T00:00:00.000Z' });
  await fs.writeFile(filename, value); host.calls.length = 0;
  const blocked = await createMcpPreparer(host.config).prepare(entry('wireshark'));
  assert.equal(blocked.status, 'manual'); assert.match(blocked.message, /其他Class进程/); assert.equal(host.calls.length, 0);
  assert.equal(await fs.readFile(filename, 'utf8'), value);
});

test('concurrent managers share one installation and retain caller secrets separately', async t => {
  let installing = 0, peak = 0;
  const host = await fixture(t, { beforeRun: async (_command, args) => { if (args.includes('install')) { installing++; peak = Math.max(peak, installing); await delay(30); installing--; } } });
  const second = createMcpPreparer(host.config);
  const values = await Promise.all([host.prepare(entry('wireshark'), { secret: { env: { TOKEN: 'first' } } }), second.prepare(entry('wireshark'), { secret: { env: { TOKEN: 'second' } } })]);
  assert.ok(values.every(value => value.status === 'prepared')); assert.equal(peak, 1);
  assert.equal(host.calls.filter(call => call.args.includes('install')).length, 1);
  assert.equal(values[0].secret.env.TOKEN, 'first'); assert.equal(values[1].secret.env.TOKEN, 'second');
});

test('cancelled queued preparation does not run or cancel another manager', async t => {
  let announce, release; const started = new Promise(resolve => { announce = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const host = await fixture(t, { beforeRun: async (_command, args) => { if (args.includes('install')) { announce(); await gate; } } });
  const first = host.prepare(entry('wireshark')); await started;
  const controller = new AbortController(), second = createMcpPreparer(host.config).prepare(entry('wireshark'), { signal: controller.signal });
  controller.abort(); assert.equal((await second).status, 'cancelled'); release(); assert.equal((await first).status, 'prepared');
  assert.equal(host.calls.filter(call => call.args.includes('install')).length, 1);
});

test('timeout cancels an owned runner and never returns launch success', async t => {
  const host = await fixture(t, { beforeRun: async (_command, args, options) => { if (args.includes('install')) await new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' })), { once: true }); }); } });
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  const value = await host.prepare(entry('wireshark'), { timeoutMs: 30 });
  assert.equal(value.status, 'cancelled'); assert.equal(value.server, undefined);
});

test('injected active timer excludes task pause and removes its listener after preparation', async t => {
  const manager = { paused: false, events: new EventEmitter() };
  let announce, release, activeSignal;
  const started = new Promise(resolve => { announce = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const host = await fixture(t, {
    startTimer: (ms, callback) => activeTimeout(manager, ms, callback),
    beforeRun: async (_command, args, options) => { if (args.includes('install')) { activeSignal = options.signal; announce(); await gate; } },
  });
  let settled = false;
  const pending = host.prepare(entry('wireshark'), { timeoutMs: 1000 }).finally(() => { settled = true; });
  await started;
  manager.paused = true; manager.events.emit('change');
  await delay(1100);
  assert.equal(activeSignal.aborted, false); assert.equal(settled, false); assert.equal(manager.events.listenerCount('change'), 1);
  manager.paused = false; manager.events.emit('change'); release();
  assert.equal((await pending).status, 'prepared'); assert.equal(manager.events.listenerCount('change'), 0);
});

test('injected preparation timer is cleaned after skip and cancellation', async t => {
  let activeTimers = 0;
  const startTimer = () => { activeTimers++; return () => { activeTimers--; }; };
  const missing = await fixture(t, { found: {}, startTimer });
  assert.equal((await missing.prepare(entry('wireshark'))).status, 'missing-tool'); assert.equal(activeTimers, 0);
  const controller = new AbortController();
  const host = await fixture(t, { startTimer, beforeRun: async (_command, args) => { if (args.includes('install')) controller.abort(); } });
  assert.equal((await host.prepare(entry('wireshark'), { signal: controller.signal })).status, 'cancelled'); assert.equal(activeTimers, 0);
});

test('unowned or linked cache is not modified or used to install', async t => {
  const host = await fixture(t); await fs.mkdir(host.cacheDir); await fs.writeFile(path.join(host.cacheDir, 'unrelated.txt'), 'keep');
  assert.equal((await host.prepare(entry('wireshark'))).status, 'failed'); assert.equal(host.calls.length, 0);
  assert.equal(await fs.readFile(path.join(host.cacheDir, 'unrelated.txt'), 'utf8'), 'keep');
  const other = await fixture(t), target = path.join(other.base, 'target'); await fs.mkdir(target);
  await fs.symlink(target, other.cacheDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await other.prepare(entry('wireshark'))).status, 'failed'); assert.equal(other.calls.length, 0); assert.deepEqual(await fs.readdir(target), []);
});

test('missing Python and uv uses only pinned official archive and rejects hash mismatch', async t => {
  const requests = [];
  const host = await fixture(t, { found: { tshark: '/fixture/tshark', tar: '/fixture/tar' }, fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response('not the pinned uv release'); } });
  const value = await host.prepare(entry('wireshark'));
  assert.equal(value.status, 'failed'); assert.equal(value.server, undefined); assert.equal(host.calls.length, 0);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://github.com/astral-sh/uv/releases/download/0.9.5/uv-x86_64-pc-windows-msvc.zip');
  assert.ok(requests[0].options.signal instanceof AbortSignal); assert.equal(requests[0].options.headers, undefined);
  await absent(path.join(host.cacheDir, 'uv-0.9.5', 'uv.exe'));
});

test('missing archive extractor gives actionable manual status without installing full tools', async t => {
  const host = await fixture(t, { found: { tshark: '/fixture/tshark' }, fetchImpl: () => { throw new Error('must not download'); } });
  assert.equal((await host.prepare(entry('wireshark'))).status, 'manual'); assert.equal(host.calls.length, 0);
});

test('browser detection never installs or launches the browser', async t => {
  const host = await fixture(t, { found: { chrome: 'C:\\Tools\\chrome.exe' } });
  assert.equal((await host.prepare(browser)).status, 'unchanged'); assert.equal(host.calls.length, 0); await absent(host.cacheDir);
  const missing = await fixture(t, { found: {} }); assert.equal((await missing.prepare(browser)).status, 'missing-tool');
});

test('Burp and Tscan distinguish detected applications from absent tools and never toggle plugins', async t => {
  const host = await fixture(t, { found: { burpsuite: '/tools/burp', TscanPlus: '/tools/tscan' } });
  for (const builtin of ['burpsuite', 'tscan']) {
    const value = await host.prepare({ builtin, transport: builtin === 'burpsuite' ? 'sse' : 'http', url: builtin === 'burpsuite' ? 'http://127.0.0.1:9876' : 'http://127.0.0.1:8088/mcp' });
    assert.equal(value.status, 'manual'); assert.match(value.message, /已检测到/);
  }
  assert.equal(host.calls.length, 0); await absent(host.cacheDir);
  const missing = await fixture(t, { found: {} });
  assert.equal((await missing.prepare({ builtin: 'tscan', transport: 'http', url: 'http://127.0.0.1:8088/mcp' })).status, 'missing-tool');
  const custom = await missing.prepare({ builtin: 'tscan', transport: 'http', url: 'https://user-service.invalid/mcp' });
  assert.equal(custom.status, 'manual'); assert.match(custom.message, /自定义服务地址/);
});

test('installer errors cannot disclose supplied keys or subprocess diagnostics', async t => {
  const host = await fixture(t, { beforeRun: async (_command, args) => { if (args.includes('install')) throw new Error('secret-value-from-proxy'); } });
  const value = await host.prepare(entry('wireshark'));
  assert.equal(value.status, 'failed'); assert.equal(value.server, undefined); assert.ok(!JSON.stringify(value).includes('secret-value-from-proxy'));
});
