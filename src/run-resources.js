// This coordinator protects known shared MCP sessions within one Class server.
// It cannot infer that different network origins or custom stdio programs point
// at the same external application. Owned browser/analysis children stay local.
const sharedStdio = new Set(['ida', 'x64dbg', 'windbg', 'gdb', 'ghidra', 'jadx', 'burpsuite', 'tscan', 'metasploit', 'bloodhound']);
const unavailable = (message, code = 'MCP_RESOURCE_BUSY') => Object.assign(new Error(message), {
  code, memberRecoverable: true, executionStatus: 'not_started',
});

export function mcpResourceKey(server) {
  if (server.transport === 'http' || server.transport === 'sse') {
    const url = new URL(server.url);
    if (['localhost', 'localhost.', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) url.hostname = '127.0.0.1';
    return `remote:${url.origin}`;
  }
  // Launch arguments do not establish isolation: a later tool may attach to an
  // existing debugger target. Keep each known external adapter exclusive.
  if (server.transport === 'stdio' && sharedStdio.has(server.builtin)) return `external:${server.builtin}`;
  return null;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class RunResources {
  constructor() { this.resources = new Map(); }
  acquire(server, owner) {
    const key = mcpResourceKey(server);
    if (!key) return null;
    if (typeof owner !== 'string' || !owner) throw Error('MCP resource owner is required');
    let entry = this.resources.get(key);
    if (entry && entry.owner !== owner) throw unavailable('MCP resource is in use by another task. Continue with other tools or retry after that task releases it.');
    if (!entry) {
      entry = { owner, holders: new Set(), pending: 0, tail: Promise.resolve() };
      this.resources.set(key, entry);
    }
    const token = {}; let released = false;
    entry.holders.add(token);
    const cleanup = () => {
      if (!entry.holders.size && !entry.pending && this.resources.get(key) === entry) this.resources.delete(key);
    };
    return {
      run(action, signal) {
        if (released) throw unavailable('MCP resource lease has ended', 'EXTENSION_UNAVAILABLE');
        signal?.throwIfAborted(); entry.pending++;
        // Keep cancelled queue slots chained to their predecessor; cancellation
        // must never let a later member overtake a still-running operation.
        const operation = entry.tail.then(() => {
          signal?.throwIfAborted();
          if (released) throw unavailable('MCP resource lease has ended', 'EXTENSION_UNAVAILABLE');
          return action();
        }).finally(() => { entry.pending--; cleanup(); });
        entry.tail = operation.catch(() => {});
        return abortable(operation, signal);
      },
      release() { if (!released) { released = true; entry.holders.delete(token); cleanup(); } },
    };
  }
}
