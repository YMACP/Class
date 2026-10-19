import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { ToolManager } from './tools.js';
import { BrowserMCPTransport } from './browser-mcp.js';

const MAX_MESSAGE = 8 * 1024 * 1024;
const MAX_PENDING = 32;
const MEMBER = 'browser-mcp';

// A private stdio process has one member and one isolated browser. Reuse the
// existing ownership checks, browser protocols and process-tree cleanup.
export async function runBrowserMCPServer({ input = process.stdin, output = process.stdout, manager, signalSource = process } = {}) {
  manager ||= new ToolManager({ allowShell: false, extensionConfig: { mcps: [], skills: [] } });
  const transport = new BrowserMCPTransport({
    checkpoint: signal => manager.checkpoint(signal),
    browserTools: { execute: (member, name, args, signal) => {
      // Listing an unused session must work even on a host without a browser.
      if (args.action === 'tabs' && !manager.browserTools.sessions.has(member)) return Promise.resolve({ output: JSON.stringify({ tabs: [] }) });
      return manager.browserTools.execute(member, name, args, signal);
    } },
  }, MEMBER);
  const decoder = new StringDecoder('utf8'), pending = new Set();
  let buffer = '', writes = Promise.resolve(), stopping, failure;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const requestId = message => message && !Array.isArray(message) && (typeof message.id === 'string' || Number.isSafeInteger(message.id)) ? message.id : null;
  const write = body => {
    if (body === undefined || output.destroyed) return;
    writes = writes.then(() => new Promise((resolve, reject) => {
      if (output.destroyed) { resolve(); return; }
      output.write(body + '\n', error => error ? reject(error) : resolve());
    }));
    // A disconnected reader also closes the owned browser and its profile.
    writes.catch(error => { void stop(error); });
  };
  const errorReply = (id, code, message) => write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  const dispatch = line => {
    if (!line.trim() || stopping) return;
    let message;
    try { message = JSON.parse(line); } catch { errorReply(null, -32700, 'Invalid JSON'); return; }
    if (pending.size >= MAX_PENDING && message?.method === 'tools/call') {
      if (message.id !== undefined) errorReply(requestId(message), -32000, 'Too many pending browser calls');
      return;
    }
    // Private parent controls bypass the tool pause gate and work even while
    // initialization is in flight. No model tool exposes these methods.
    const control = message?.jsonrpc === '2.0' && ['class/browser/pause', 'class/browser/resume'].includes(message.method);
    const response = control
      ? (message.method === 'class/browser/pause' ? manager.pauseAll() : manager.resumeAll()).then(() => message.id === undefined ? undefined : JSON.stringify({ jsonrpc: '2.0', id: requestId(message), result: {} }))
      : transport.send(line);
    const work = response.then(write, () => {
      if (message?.id !== undefined) errorReply(requestId(message), -32800, 'Browser MCP request cancelled');
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  function consume(chunk) {
    if (stopping) return;
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_MESSAGE) { errorReply(null, -32600, 'Browser MCP message exceeds size limit'); void stop(); return; }
      dispatch(line);
    }
    if (Buffer.byteLength(buffer) > MAX_MESSAGE) { errorReply(null, -32600, 'Browser MCP message exceeds size limit'); void stop(); }
  }
  function end() {
    if (stopping) return;
    buffer += decoder.end();
    if (buffer.trim()) dispatch(buffer);
    buffer = '';
    void stop();
  }
  function stop(error) {
    failure ||= error;
    if (stopping) return stopping;
    input.pause();
    input.off('data', consume); input.off('end', end); input.off('close', end);
    // Both abort paths run immediately. BrowserTools then waits for any launch
    // in flight before checking its owned temporary profiles a second time.
    stopping = (async () => {
      const closed = await Promise.allSettled([transport.close(), manager.stopAll()]);
      await Promise.allSettled([...pending]);
      await writes.catch(error => { failure ||= error; });
      failure ||= closed.find(result => result.status === 'rejected')?.reason;
      input.off('error', inputError); output.off('error', outputError);
      signalSource.off('SIGINT', interrupt); signalSource.off('SIGTERM', interrupt);
      input.destroy();
      if (failure) rejectDone(failure); else resolveDone();
    })();
    return stopping;
  }
  const inputError = error => { void stop(error); };
  const outputError = error => { void stop(error); };
  const interrupt = () => { void stop(); };
  input.on('data', consume); input.once('end', end); input.once('close', end); input.on('error', inputError);
  output.on('error', outputError);
  signalSource.on('SIGINT', interrupt); signalSource.on('SIGTERM', interrupt);
  if (input.readableEnded || input.destroyed) end();
  return done;
}

// Compiled Class uses desktop.js's --browser-mcp branch. Source runs can invoke
// this file with Node/Bun directly and require no generated UI assets.
// Bundled modules share the desktop entry URL; do not start an extra protocol
// listener when Class dispatches another MCP mode or the normal desktop.
if (process.argv[1] && path.basename(process.argv[1]) === 'browser-mcp-server.js' && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runBrowserMCPServer().catch(() => { console.error('Class browser MCP could not shut down cleanly.'); process.exitCode = 1; });
}
