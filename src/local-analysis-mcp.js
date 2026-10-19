import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { ToolManager } from './tools.js';
import { activeTimeout } from './tool-output.js';
import { captureLinuxProcessIdentity, snapshotLinuxDescendants, killLinuxDescendants } from './owned-linux-processes.js';

const MAX_MESSAGE = 256 * 1024, MAX_PENDING = 8;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = { type: 'string', minLength: 1, maxLength: 4096 };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const TOOLS = {
  zsteg: [
    { name: 'zsteg_scan', description: 'Scan a local PNG/BMP for hidden data with the installed zsteg. Paths must be absolute.', inputSchema: schema({ path: string, all: { type: 'boolean' } }, ['path']) },
    { name: 'zsteg_extract', description: 'Extract a named zsteg payload to a new absolute outputPath. Existing files are never overwritten; binary bytes are preserved.', inputSchema: schema({ path: string, selector: { ...string, maxLength: 256 }, outputPath: string }, ['path', 'selector', 'outputPath']) },
  ],
  binwalk: [
    { name: 'binwalk_scan', description: 'Scan a local file for embedded signatures with installed binwalk. path must be absolute.', inputSchema: schema({ path: string }, ['path']) },
    { name: 'binwalk_extract', description: 'Extract with installed binwalk into a new absolute outputDirectory. Requires format-specific extractors. Does not enable recursive extraction. Partial output is retained on failure.', inputSchema: schema({ path: string, outputDirectory: string }, ['path', 'outputDirectory']) },
  ],
  pwntools: [
    { name: 'pwntools_run', description: 'Run one complete Python script with pwntools imported. Include the complete interaction in this call; no process or session handles persist. Captures bounded stdout/stderr. Default timeout is 20000ms, maximum 25000ms.', inputSchema: schema({ code: { type: 'string', minLength: 1, maxLength: 65536 }, cwd: string, timeoutMs: { type: 'integer', minimum: 1, maximum: 25000 } }, ['code']) },
  ],
};

function invalid(message) { return Object.assign(Error(message), { rpcCode: -32602 }); }
function validate(tool, args) {
  if (!object(args)) throw invalid('Tool arguments must be an object');
  const properties = tool.inputSchema.properties;
  if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw invalid('Unknown tool argument');
  for (const key of tool.inputSchema.required) if (!Object.hasOwn(args, key)) throw invalid('Missing argument: ' + key);
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    if (rule.type === 'string' && (typeof value !== 'string' || !value.length || value.length > rule.maxLength || value.includes('\0'))) throw invalid('Invalid string argument: ' + key);
    if (rule.type === 'boolean' && typeof value !== 'boolean') throw invalid('Invalid boolean argument: ' + key);
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum)) throw invalid('Invalid timeoutMs');
    if (['path', 'outputPath', 'outputDirectory', 'cwd'].includes(key) && !path.isAbsolute(value)) throw invalid(key + ' must be an absolute path');
  }
  if (args.selector && !/^[a-zA-Z0-9_:,.]+$/.test(args.selector)) throw invalid('Invalid zsteg selector');
}

function childEnvironment(env) {
  const result = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'GEM_HOME', 'GEM_PATH', 'PYTHONPATH', 'VIRTUAL_ENV', 'LD_LIBRARY_PATH']) if (env[key] !== undefined) result[key] = env[key];
  return { ...result, PWNLIB_NOTERM: '1', PWNLIB_UPDATE_CHECK: 'never', PYTHONUNBUFFERED: '1' };
}

async function commandFor(kind, env) {
  if (kind === 'zsteg') return env.CLASS_ZSTEG_PATH || 'zsteg';
  if (kind === 'binwalk') return env.CLASS_BINWALK_PATH || 'binwalk';
  if (env.CLASS_PWNTOOLS_PYTHON) return env.CLASS_PWNTOOLS_PYTHON;
  const local = path.join(env.HOME || env.USERPROFILE || os.homedir(), '.local', 'share', 'class-mcp', 'pwntools', 'bin', 'python');
  try { if ((await fs.stat(local)).isFile()) return local; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return 'python3';
}

// Only the pwntools script needs a supervisor: it can deliberately create new
// sessions and exit before JavaScript's next /proc sample. Linux reparents those
// descendants to this small stdlib-only subreaper, which stays alive to reap
// them. This is lifecycle management, not an OS sandbox.
const PWNTOOLS_SCRIPT = "import sys\nfrom pwn import *\ncontext.log_console = sys.stderr\nexec(compile(sys.stdin.read(), '<class-pwntools>', 'exec'), globals(), globals())";
const PWNTOOLS_LINUX_SCRIPT = String.raw`import sys, os, signal, ctypes, time
_class_source = sys.stdin.read()
_class_libc = ctypes.CDLL(None, use_errno=True)
if _class_libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'Cannot supervise pwntools descendants')
def _class_interrupted(signum, frame):
    raise SystemExit(128 + signum)
signal.signal(signal.SIGTERM, _class_interrupted)
signal.signal(signal.SIGINT, _class_interrupted)
_class_parent = os.getppid()
if _class_libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'Cannot track pwntools parent exit')
if os.getppid() != _class_parent:
    raise SystemExit(143)
def _class_cleanup():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    deadline = time.monotonic() + 1.5
    while True:
        # These are this supervisor's own unreaped children, not global PIDs.
        # A child's PID cannot be reused until this parent reaps it.
        with open('/proc/self/task/' + str(os.getpid()) + '/children') as stream:
            children = [int(value) for value in stream.read().split()]
        if not children:
            return
        for child in children:
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
        while True:
            try:
                child, status = os.waitpid(-1, os.WNOHANG)
                if child == 0:
                    break
            except ChildProcessError:
                return
        if time.monotonic() >= deadline:
            raise RuntimeError('Owned pwntools descendants did not exit')
        time.sleep(0.01)
_class_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
try:
    _class_child = os.fork()
except BaseException:
    signal.pthread_sigmask(signal.SIG_SETMASK, _class_mask)
    raise
if _class_child == 0:
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_SETMASK, _class_mask)
    from pwn import *
    context.log_console = sys.stderr
    exec(compile(_class_source, '<class-pwntools>', 'exec'), globals(), globals())
    raise SystemExit(0)
try:
    signal.pthread_sigmask(signal.SIG_SETMASK, _class_mask)
    _, _class_status = os.waitpid(_class_child, 0)
    _class_exit = os.waitstatus_to_exitcode(_class_status)
finally:
    _class_cleanup()
raise SystemExit(_class_exit if _class_exit >= 0 else 128 - _class_exit)
`;

async function signalLinuxIdentity(identity, signal) {
  if (!identity) return false;
  const current = await captureLinuxProcessIdentity(identity.pid);
  if (!current || current.startTime !== identity.startTime) return false;
  try { process.kill(identity.pid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// Every command is an owned, detached process tree, never a shell string. The
// Linux snapshots also cover observed children that start separate groups.
function runner(manager, { spawnImpl, env, maxOutputBytes, maxBinaryBytes, activeRuns }) {
  return async (command, args, { signal, timeoutMs, cwd = process.cwd(), stdin, binary = false, supervised = false } = {}) => {
    await manager.checkpoint(signal);
    signal.throwIfAborted();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let timedOut = false, outputLimit = false, spawnError, record, cleanupError, identity;
    const descendants = new Map(), pausedDescendants = new Map(), chunks = [[], []], sizes = [0, 0], truncated = [false, false];
    const child = spawnImpl(command, args, { cwd, env: childEnvironment(env), shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => child.once('close', (code, sig) => resolve({ code, sig })));
    child.on('error', error => { spawnError = error; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') spawnError ||= error; });
    for (const [index, stream] of [child.stdout, child.stderr].entries()) {
      stream.on('error', error => { spawnError ||= error; });
      stream.on('data', chunk => {
        const data = Buffer.from(chunk), limit = binary && index === 0 ? maxBinaryBytes : maxOutputBytes;
        const keep = Math.min(data.length, Math.max(0, limit - sizes[index]));
        if (keep) { chunks[index].push(data.subarray(0, keep)); sizes[index] += keep; }
        if (keep < data.length) {
          truncated[index] = true;
          if (binary && index === 0) { outputLimit = true; controller.abort(Error('Binary extraction exceeds size limit')); }
        }
      });
    }
    let sampling, timer, poll, pausePoll, stopping, setup, disposed = false, wantPaused = manager.paused, controls = Promise.resolve();
    const sample = () => {
      if (sampling) return sampling;
      sampling = (async () => {
        if (!identity) return;
        for (const item of await snapshotLinuxDescendants(identity)) descendants.set(item.pid + ':' + item.startTime, item);
      })().catch(error => { cleanupError ||= error; }).finally(() => { sampling = undefined; });
      return sampling;
    };
    const serialize = action => { const next = controls.then(action); controls = next.catch(() => {}); return next; };
    const lifecycle = {
      pause() {
        wantPaused = true;
        return serialize(async () => {
          await setup;
          if (disposed || !wantPaused || process.platform !== 'linux') return;
          // The manager already stopped the direct group. Pause detached
          // parents before their descendants, then resample the stopped tree.
          for (let pass = 0; pass < 8; pass++) {
            await sample(); if (cleanupError) throw cleanupError;
            let changed = false;
            for (const [key, item] of descendants) if (!pausedDescendants.has(key)) {
              if (await signalLinuxIdentity(item, 'SIGSTOP')) { pausedDescendants.set(key, item); changed = true; }
            }
            if (!changed) return;
          }
          throw Error('Owned descendants did not finish pausing');
        }).catch(error => { controller.abort(error); throw error; });
      },
      resume() {
        wantPaused = false;
        return serialize(async () => {
          if (disposed || process.platform !== 'linux') return;
          for (const item of pausedDescendants.values()) await signalLinuxIdentity(item, 'SIGCONT');
          pausedDescendants.clear();
        });
      },
    };
    activeRuns.add(lifecycle);
    const stop = () => stopping ||= (async () => {
      disposed = true; clearInterval(poll); await controls;
      await sample();
      if (supervised && identity) {
        // Give the subreaper time to collect even descendants that were born
        // and orphaned between samples. A paused supervisor must be resumed.
        try {
          const sent = await signalLinuxIdentity(identity, 'SIGTERM');
          if (sent) {
            await signalLinuxIdentity(identity, 'SIGCONT');
            let grace;
            try { await Promise.race([closed, new Promise(resolve => { grace = setTimeout(resolve, 2000); })]); }
            finally { clearTimeout(grace); }
          }
          await sample();
        } catch (error) { cleanupError ||= error; }
      }
      try { if (process.platform === 'linux') await killLinuxDescendants([...descendants.values()]); }
      catch (error) { cleanupError ||= error; }
      try { if (record) await manager._kill(record); }
      catch (error) { cleanupError ||= error; }
    })();
    const abort = () => { void stop(); };
    timer = activeTimeout(manager, timeoutMs, () => { timedOut = true; controller.abort(Error('Local analysis timed out')); });
    try {
      // Register before the first await, including very short-lived commands.
      setup = (async () => {
        record = await manager.adoptProcess(child, 'local-analysis');
        if (process.platform === 'linux' && child.pid) {
          identity = await captureLinuxProcessIdentity(child.pid);
          if (identity && identity.parentPid !== process.pid) throw Error('Local analysis process ownership changed');
        }
      })();
      await setup;
      await sample();
      if (wantPaused) await lifecycle.pause();
      poll = setInterval(() => {
        if (wantPaused) {
          if (!pausePoll) pausePoll = lifecycle.pause().catch(error => { cleanupError ||= error; }).finally(() => { pausePoll = undefined; });
        } else void sample();
      }, 100);
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
      child.stdin.end(stdin);
      const result = await closed;
      clearInterval(poll);
      await sampling;
      // A completed one-shot script must not leave observed background jobs.
      if (process.platform === 'linux') await killLinuxDescendants([...descendants.values()]);
      if (stopping) await stopping;
      if (cleanupError) throw cleanupError;
      if (spawnError) throw spawnError;
      signal.throwIfAborted();
      return { ...result, stdout: Buffer.concat(chunks[0]), stderr: Buffer.concat(chunks[1]).toString('utf8'), stdoutTruncated: truncated[0], stderrTruncated: truncated[1], timedOut, outputLimit };
    } catch (error) {
      await stop();
      if (child.pid) await closed;
      throw spawnError || error;
    } finally {
      disposed = true; activeRuns.delete(lifecycle); await controls;
      timer?.(); clearInterval(poll); combined.removeEventListener('abort', abort);
    }
  };
}

function textResult(result, extra = {}) {
  return { exitCode: result.code, signal: result.sig, stdout: result.stdout.toString('utf8'), stderr: result.stderr, truncated: result.stdoutTruncated || result.stderrTruncated, stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated, timedOut: result.timedOut, ...extra };
}
const succeeded = result => result.code === 0 && !result.sig && !result.timedOut && !result.outputLimit;
const content = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError });

export async function runLocalAnalysisMCPServer(kind, {
  input = process.stdin, output = process.stdout, signalSource = process, env = process.env,
  manager, spawnImpl = spawn, defaultTimeoutMs = 20000, maxOutputBytes = 65536, maxBinaryBytes = 8 * 1024 * 1024,
} = {}) {
  if (!Object.hasOwn(TOOLS, kind)) throw Error('Unsupported local analysis MCP: ' + kind);
  if (![defaultTimeoutMs, maxOutputBytes, maxBinaryBytes].every(value => Number.isSafeInteger(value) && value > 0) || defaultTimeoutMs > 25000 || maxOutputBytes > 65536 || maxBinaryBytes > 8 * 1024 * 1024) throw Error('Invalid local analysis limits');
  manager ||= new ToolManager({ allowShell: false, extensionConfig: { mcps: [], skills: [] } });
  const activeRuns = new Set();
  let lifecycleControls = Promise.resolve();
  const control = action => { const next = lifecycleControls.then(action); lifecycleControls = next.catch(() => {}); return next; };
  const execute = runner(manager, { spawnImpl, env, maxOutputBytes, maxBinaryBytes, activeRuns });
  const decoder = new StringDecoder('utf8'), controller = new AbortController(), pending = new Map();
  let buffer = '', initialized = false, ready = false, initializing = false, running = false, writes = Promise.resolve(), queuedWrites = 0, stopping, failure;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const write = message => {
    if (output.destroyed || queuedWrites >= 16) { void stop(Error('Local analysis MCP output disconnected or backpressured')); return; }
    queuedWrites++;
    writes = writes.then(() => new Promise((resolve, reject) => {
      if (output.destroyed) return reject(Error('Local analysis MCP output disconnected'));
      output.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve());
    })).finally(() => { queuedWrites--; });
    writes.catch(error => { void stop(error); });
  };
  const errorReply = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
  const checkedCommand = async signal => {
    const command = await commandFor(kind, env);
    const args = kind === 'pwntools' ? ['-c', 'import sys; import pwn; pwn.context.log_console = sys.stderr'] : ['--help'];
    try {
      const result = await execute(command, args, { signal, timeoutMs: Math.min(defaultTimeoutMs, 5000) });
      if (!succeeded(result)) throw Error(result.timedOut ? 'dependency check timed out' : (result.stderr || result.stdout.toString()).slice(0, 1000) || 'dependency check failed');
    } catch (error) {
      if (signal.aborted) throw error;
      throw Error(kind + ' dependency unavailable; install the local tool or configure its executable path. ' + (error.code === 'ENOENT' ? 'Executable not found.' : error.message));
    }
    return command;
  };
  let command;
  async function call(name, args, signal) {
    const tool = TOOLS[kind].find(item => item.name === name);
    if (!tool) throw invalid('Unknown local analysis tool');
    validate(tool, args);
    if (args.path && !(await fs.stat(args.path)).isFile()) throw invalid('path must reference a regular file');
    if (args.cwd && !(await fs.stat(args.cwd)).isDirectory()) throw invalid('cwd must reference a directory');
    if (name === 'pwntools_run') {
      const supervised = process.platform === 'linux';
      const result = await execute(command, ['-u', '-c', supervised ? PWNTOOLS_LINUX_SCRIPT : PWNTOOLS_SCRIPT], { signal, timeoutMs: args.timeoutMs ?? defaultTimeoutMs, cwd: args.cwd, stdin: args.code, supervised });
      return content(textResult(result), !succeeded(result));
    }
    if (name === 'zsteg_extract') {
      const handle = await fs.open(args.outputPath, 'wx', 0o600), identity = await handle.stat();
      let complete = false;
      try {
        const result = await execute(command, ['--no-color', '-E', args.selector, '--', args.path], { signal, timeoutMs: defaultTimeoutMs, binary: true });
        if (!succeeded(result)) return content({ ...textResult({ ...result, stdout: Buffer.alloc(0) }), error: result.outputLimit ? 'Binary extraction exceeds size limit; output was not saved' : 'Extraction failed; output was not saved' }, true);
        signal.throwIfAborted();
        await handle.writeFile(result.stdout); await handle.sync(); signal.throwIfAborted(); complete = true;
        return content({ outputPath: args.outputPath, bytes: result.stdout.length, stderr: result.stderr, stderrTruncated: result.stderrTruncated });
      } finally {
        await handle.close();
        if (!complete) {
          try { const current = await fs.lstat(args.outputPath); if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await fs.unlink(args.outputPath); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    }
    let argv;
    if (name === 'zsteg_scan') argv = ['--no-color', ...(args.all ? ['--all'] : []), '--', args.path];
    else if (name === 'binwalk_scan') argv = ['--', args.path];
    else {
      // The long option is shared by binwalk v2/v3; their short flags differ.
      await fs.mkdir(args.outputDirectory, { mode: 0o700 });
      argv = ['--extract', '--directory', args.outputDirectory, '--', args.path];
    }
    const result = await execute(command, argv, { signal, timeoutMs: defaultTimeoutMs });
    return content(textResult(result, args.outputDirectory ? { outputDirectory: args.outputDirectory } : {}), !succeeded(result));
  }
  async function handle(message, signal) {
    // Private lifecycle controls remain responsive while initialization or a
    // tool is paused. They are never advertised in tools/list.
    if (message.method === 'class/analysis/pause') return control(async () => { await manager.pauseAll(); await Promise.all([...activeRuns].map(run => run.pause())); return {}; });
    if (message.method === 'class/analysis/resume') return control(async () => { await Promise.all([...activeRuns].map(run => run.resume())); await manager.resumeAll(); return {}; });
    if (message.method === 'initialize') {
      if (initialized || initializing || !object(message.params) || typeof message.params.protocolVersion !== 'string') throw Object.assign(Error('Invalid initialization'), { rpcCode: -32600 });
      initializing = true;
      try { command = await checkedCommand(signal); initialized = true; }
      finally { initializing = false; }
      return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Class ' + kind, version: '1.2.0' } };
    }
    if (message.method === 'ping') return {};
    if (!ready) throw Error('Initialize the local analysis MCP first');
    if (message.method === 'tools/list') return { tools: TOOLS[kind] };
    if (message.method !== 'tools/call') throw Object.assign(Error('Method not found'), { rpcCode: -32601 });
    if (running) throw Error('A local analysis call is already running');
    if (!object(message.params) || typeof message.params.name !== 'string') throw invalid('Invalid tool call');
    running = true;
    try { return await call(message.params.name, message.params.arguments ?? {}, signal); }
    catch (error) { if (signal.aborted || error.rpcCode) throw error; return content({ error: error.message || 'Local analysis failed' }, true); }
    finally { running = false; }
  }
  function dispatch(line) {
    if (!line.trim() || stopping) return;
    let message;
    try { message = JSON.parse(line); } catch { errorReply(null, -32700, 'Invalid JSON'); return; }
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { errorReply(null, -32600, 'Invalid request'); return; }
    if (message.id === undefined) {
      if (message.method === 'notifications/initialized' && initialized) ready = true;
      if (message.method === 'notifications/cancelled') pending.get(message.params?.requestId)?.controller.abort(Error('Local analysis call cancelled'));
      return;
    }
    if (!(typeof message.id === 'string' && message.id.length <= 128 || Number.isSafeInteger(message.id))) { errorReply(null, -32600, 'Invalid request ID'); return; }
    if (pending.has(message.id)) { errorReply(message.id, -32600, 'Duplicate request ID'); return; }
    if (pending.size >= MAX_PENDING) { errorReply(message.id, -32000, 'Too many pending requests'); return; }
    const request = new AbortController(), signal = AbortSignal.any([controller.signal, request.signal]);
    const work = handle(message, signal).then(result => write({ jsonrpc: '2.0', id: message.id, result }), error => {
      errorReply(message.id, signal.aborted ? -32800 : error.rpcCode || -32000, signal.aborted ? 'Local analysis request cancelled' : String(error.message || 'Local analysis failed').slice(0, 1500));
    });
    pending.set(message.id, { controller: request, work });
    void work.finally(() => pending.delete(message.id));
  }
  function consume(chunk) {
    if (stopping) return;
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_MESSAGE) { errorReply(null, -32600, 'Local analysis MCP message exceeds size limit'); void stop(); return; }
      dispatch(line);
    }
    if (Buffer.byteLength(buffer) > MAX_MESSAGE) { errorReply(null, -32600, 'Local analysis MCP message exceeds size limit'); void stop(); }
  }
  function end() { if (stopping) return; buffer += decoder.end(); if (buffer.trim()) dispatch(buffer); buffer = ''; void stop(); }
  function stop(error) {
    failure ||= error;
    if (stopping) return stopping;
    input.pause(); input.off('data', consume); input.off('end', end); input.off('close', end);
    controller.abort(Error('Local analysis MCP stopped'));
    stopping = (async () => {
      await Promise.allSettled([...pending.values()].map(item => item.work));
      try { await manager.stopAll(); } catch (error) { failure ||= error; }
      await writes.catch(error => { failure ||= error; });
      input.off('error', inputError); output.off('error', outputError); output.off('close', outputClose);
      signalSource.off('SIGINT', interrupt); signalSource.off('SIGTERM', interrupt); input.destroy();
      if (failure) rejectDone(failure); else resolveDone();
    })();
    return stopping;
  }
  const inputError = error => { void stop(error); }, outputError = error => { void stop(error); };
  const interrupt = () => { void stop(); }, outputClose = () => { void stop(); };
  input.on('data', consume); input.once('end', end); input.once('close', end); input.on('error', inputError);
  output.on('error', outputError); output.once('close', outputClose);
  signalSource.on('SIGINT', interrupt); signalSource.on('SIGTERM', interrupt);
  if (input.readableEnded || input.destroyed) end();
  return done;
}

// Compiled Bun modules share the desktop entry URL; only the standalone source
// script starts itself. Packaged Class dispatches through desktop.js instead.
if (process.argv[1] && path.basename(process.argv[1]) === 'local-analysis-mcp.js' && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runLocalAnalysisMCPServer(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
