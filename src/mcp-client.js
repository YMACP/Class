import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { request as requestHTTPS } from 'node:https';
import { Readable } from 'node:stream';

const VERSION = '2025-06-18';
const VERSIONS = new Set([VERSION, '2025-03-26', '2024-11-05']);
const MAX_MESSAGE = 8 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (message, code = 'MCP_ERROR') => Object.assign(new Error(message), { code });

// This client implements only tools, ping and cancellation. A server cannot
// request model sampling, local files, credentials, or additional processes.
export class MCPClient {
  constructor(config, { fetchImpl = globalThis.fetch, spawnProcess, timeoutMs = 30000, startTimer, onToolsChanged, checkpoint, localTransport } = {}) {
    this.config = config; this.fetch = fetchImpl; this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs; this.startTimer = startTimer; this.onToolsChanged = onToolsChanged;
    this.checkpoint = checkpoint;
    this.localTransport = localTransport;
    this.pending = new Map(); this.sequence = 0; this.lifetime = new AbortController();
    this.closed = false; this.protocolVersion = VERSION;
  }
  async initialize(signal) {
    if (this.closed) throw failure('MCP connection is closed');
    if (!this.ready) this.ready = this._initialize(signal).catch(async error => { await this.close(); throw error; });
    return this.ready;
  }
  async _initialize(signal) {
    await this.checkpoint?.(signal);
    if (this.config.transport === 'stdio') await this._stdio(signal);
    else if (this.config.transport === 'sse') await this._legacySSE(signal);
    const result = await this._request('initialize', { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'Class', version: '1.2.0' } }, signal);
    if (!plain(result) || !VERSIONS.has(result.protocolVersion)) throw failure('MCP protocol version is unsupported');
    if (!plain(result.capabilities?.tools)) throw failure('MCP server does not provide tools');
    this.protocolVersion = result.protocolVersion;
    await this._notify('notifications/initialized', {}, signal);
  }
  async listTools(signal) {
    await this.initialize(signal);
    const tools = [], seen = new Set(); let cursor;
    for (let page = 0; page < 32; page++) {
      const result = await this._request('tools/list', cursor ? { cursor } : {}, signal);
      if (!plain(result) || !Array.isArray(result.tools)) throw failure('MCP tools/list returned invalid data');
      for (const tool of result.tools) {
        if (tools.length >= 512) throw failure('MCP tool catalogue exceeds 512 tools');
        tools.push(tool);
      }
      if (!result.nextCursor) return tools;
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 4096 || seen.has(result.nextCursor)) throw failure('MCP tool pagination is invalid');
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw failure('MCP tool pagination exceeds 32 pages');
  }
  async callTool(name, args, signal) {
    await this.initialize(signal);
    return this._request('tools/call', { name, arguments: args }, signal);
  }
  _timer(callback, milliseconds = this.timeoutMs) {
    if (this.startTimer) return this.startTimer(milliseconds, callback);
    const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer);
  }
  async _request(method, params, signal) {
    const controller = new AbortController();
    const combined = AbortSignal.any([this.lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    const id = ++this.sequence;
    let sent = false, abort, cleanupTimer;
    const response = new Promise((resolve, reject) => {
      abort = () => {
        const error = failure(combined.reason?.code === 'MCP_TIMEOUT' ? 'MCP request timed out' : 'MCP request cancelled', combined.reason?.code || 'MCP_CANCELLED');
        if (method === 'tools/call' && sent) error.executionStatus = 'uncertain';
        reject(error);
        // Cancellation is best effort and never means remote effects rolled back.
        if (sent && !this.closed) void this._notify('notifications/cancelled', { requestId: id, reason: 'Request cancelled' }, AbortSignal.timeout(1000)).catch(() => {});
      };
      this.pending.set(id, { resolve, reject });
      combined.addEventListener('abort', abort, { once: true });
      cleanupTimer = this._timer(() => controller.abort(failure('MCP request timed out', 'MCP_TIMEOUT')));
    });
    // A transport error cannot replay a possibly executed tool automatically.
    const sending = Promise.resolve().then(() => {
      combined.throwIfAborted(); sent = true;
      return this._send({ jsonrpc: '2.0', id, method, params }, combined);
    }).catch(() => {
      const error = failure('MCP transport failed');
      if (method === 'tools/call' && sent) error.executionStatus = 'uncertain';
      this.pending.get(id)?.reject(error);
    });
    try { return await response; }
    catch (error) { if (method === 'tools/call' && sent && error.code !== 'MCP_REMOTE_ERROR') error.executionStatus = 'uncertain'; throw error; }
    finally {
      cleanupTimer?.(); combined.removeEventListener('abort', abort); this.pending.delete(id);
      controller.abort(failure('MCP request completed', 'MCP_COMPLETED'));
      void sending.catch(() => {});
    }
  }
  async _notify(method, params, signal) {
    const controller = new AbortController();
    const combined = AbortSignal.any([this.lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
    const cleanup = this._timer(() => controller.abort(failure('MCP notification timed out', 'MCP_TIMEOUT')));
    try { return await this._send({ jsonrpc: '2.0', method, params }, combined); }
    finally { cleanup(); }
  }
  _receive(message) {
    if (!plain(message) || message.jsonrpc !== '2.0') throw failure('MCP message is invalid');
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        const response = message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability is not supported' } };
        void this._send(response, AbortSignal.timeout(1000)).catch(() => {});
      } else if (message.method === 'notifications/tools/list_changed') this.onToolsChanged?.();
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.error) pending.reject(failure('MCP server rejected the request', 'MCP_REMOTE_ERROR'));
    else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
    else pending.reject(failure('MCP response has no result'));
  }
  _broken(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async _stdio(signal) {
    signal?.throwIfAborted();
    const options = { cwd: this.config.cwd, env: this.config.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] };
    const owned = this.spawnProcess
      ? await this.spawnProcess(this.config.command, this.config.args || [], { ...options, classBrowserMcp: this.config.classBrowserMcp === true, classAnalysisMcp: this.config.classAnalysisMcp === true })
      : { child: spawn(this.config.command, this.config.args || [], options) };
    this.child = owned.child; this.stopProcess = owned.stop;
    const decoder = new StringDecoder('utf8'); let buffer = '';
    this.child.stdout.on('data', chunk => {
      try {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > MAX_MESSAGE) throw failure('MCP stdio message exceeds size limit');
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at).replace(/\r$/, ''); buffer = buffer.slice(at + 1);
          if (line.trim()) this._receive(JSON.parse(line));
        }
      } catch { this._broken(failure('MCP stdio protocol is invalid')); void this.close(); }
    });
    this.child.stderr.resume(); // Never publish server stderr or startup credentials.
    this.child.stdin.on('error', () => this._broken(failure('MCP input stream closed')));
    this.child.once('error', () => this._broken(failure('MCP process failed to start')));
    this.child.once('close', () => { this._broken(failure('MCP process exited')); this.closed = true; });
  }
  _headers() {
    const headers = new Headers(this.config.headers || {});
    headers.set('accept', 'application/json, text/event-stream');
    headers.set('content-type', 'application/json');
    headers.set('MCP-Protocol-Version', this.protocolVersion);
    if (this.sessionId) headers.set('Mcp-Session-Id', this.sessionId);
    return headers;
  }
  _fetch(url, options) {
    // Opt-in belongs to this MCP connection, never the global TLS environment
    // or a shared agent. Plain HTTP and verified HTTPS keep their usual fetch.
    if (this.config.skipTlsVerify === true && new URL(url).protocol === 'https:') return fetchUnverifiedHTTPS(url, options);
    return this.fetch(url, options);
  }
  async _send(message, signal) {
    const browserControl = this.config.classBrowserMcp === true && ['class/browser/pause', 'class/browser/resume'].includes(message.method);
    const analysisControl = this.config.classAnalysisMcp === true && ['class/analysis/pause', 'class/analysis/resume'].includes(message.method);
    if (message.method !== 'notifications/cancelled' && !browserControl && !analysisControl) await this.checkpoint?.(signal);
    signal?.throwIfAborted();
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > MAX_MESSAGE) throw failure('MCP request exceeds size limit');
    if (this.config.transport === 'builtin') {
      if (!this.localTransport?.send) throw failure('Built-in MCP transport is unavailable');
      const response = await this.localTransport.send(body, signal);
      if (response !== undefined) {
        if (typeof response !== 'string' || Buffer.byteLength(response) > MAX_MESSAGE) throw failure('MCP response exceeds size limit');
        this._receive(JSON.parse(response));
      }
      return;
    }
    if (this.config.transport === 'stdio') {
      if (!this.child?.stdin?.writable) throw failure('MCP process input is unavailable');
      await new Promise((resolve, reject) => this.child.stdin.write(body + '\n', error => error ? reject(error) : resolve()));
      return;
    }
    const response = await this._fetch(this.postUrl || this.config.url, { method: 'POST', headers: this._headers(), body, signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw failure('MCP HTTP request failed'); }
    const session = response.headers.get('Mcp-Session-Id');
    if (message.method === 'initialize' && session) {
      if (session.length > 1024 || !/^[\x21-\x7e]+$/.test(session)) throw failure('MCP session identifier is invalid');
      this.sessionId = session;
    }
    if (response.status === 202 || response.status === 204) { await response.body?.cancel().catch(() => {}); return; }
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      await readSSE(response.body, event => {
        if (event.data) { const value = JSON.parse(event.data); this._receive(value); return value.id === message.id && !value.method; }
        return false;
      }, signal);
    } else {
      const text = await readText(response.body, signal);
      if (text.trim()) this._receive(JSON.parse(text));
      else if (message.id !== undefined && this.config.transport !== 'sse') throw failure('MCP HTTP response is empty');
    }
  }
  async _legacySSE(signal) {
    const connect = new AbortController();
    const combined = AbortSignal.any([this.lifetime.signal, connect.signal, ...(signal ? [signal] : [])]);
    const cleanup = this._timer(() => connect.abort(failure('MCP SSE connection timed out', 'MCP_TIMEOUT')));
    try {
      const headers = this._headers(); headers.set('accept', 'text/event-stream');
      const response = await this._fetch(this.config.url, { method: 'GET', headers, signal: combined, redirect: 'error' });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw failure('MCP SSE endpoint is unavailable');
      let resolveEndpoint, rejectEndpoint;
      const endpoint = new Promise((resolve, reject) => { resolveEndpoint = resolve; rejectEndpoint = reject; });
      this.sseReading = readSSE(response.body, event => {
        if (event.event === 'endpoint') {
          const url = new URL(event.data, this.config.url);
          if (url.origin !== new URL(this.config.url).origin || url.username || url.password) throw failure('MCP SSE endpoint changed origin');
          this.postUrl = url.href; resolveEndpoint(); cleanup();
        } else if (event.data) this._receive(JSON.parse(event.data));
        return false;
      }, combined).then(() => { throw failure('MCP SSE connection closed'); }).catch(error => {
        rejectEndpoint(error); this._broken(failure('MCP SSE connection closed'));
      });
      await endpoint;
    } finally { cleanup(); }
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true; this.lifetime.abort(failure('MCP connection closed'));
    this._broken(failure('MCP connection closed'));
    this.closing = (async () => {
      await this.localTransport?.close();
      if (this.child) {
        this.child.stdin.end();
        if (this.stopProcess) await this.stopProcess();
        else if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
      }
      // Closing HTTP streams suffices; do not replay calls or send unbounded shutdown requests.
      await this.sseReading?.catch(() => {});
    })();
    return this.closing;
  }
}

// MCP sends only GET/POST with an optional JSON string body. Using a separate
// request also works in the compiled Bun runtime without a dispatcher package.
// Node's request signal destroys the socket on abort; cancelling the web body
// destroys the IncomingMessage through Readable.toWeb, including SSE streams.
function fetchUnverifiedHTTPS(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const request = requestHTTPS(url, { method, headers: Object.fromEntries(new Headers(headers)), signal, agent: false, rejectUnauthorized: false }, response => {
      try {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) throw failure('MCP redirects are not allowed');
        const responseHeaders = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        const empty = [204, 205, 304].includes(response.statusCode);
        const result = new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, statusText: response.statusMessage, headers: responseHeaders });
        if (empty) response.resume();
        resolve(result);
      } catch (error) { response.destroy(); request.destroy(); reject(error); }
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function readText(body, signal) {
  if (!body) return '';
  const reader = body.getReader(), chunks = []; let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > MAX_MESSAGE) throw failure('MCP response exceeds size limit');
      chunks.push(value);
    }
    signal?.throwIfAborted(); return Buffer.concat(chunks).toString('utf8');
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function readSSE(body, onEvent, signal) {
  if (!body) throw failure('MCP SSE response has no body');
  const reader = body.getReader(), decoder = new TextDecoder(); let buffer = '', data = [], event = 'message', size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const dispatch = () => {
    const stop = data.length ? onEvent({ event, data: data.join('\n') }) : false;
    data = []; event = 'message'; size = 0; return stop;
  };
  try {
    while (true) {
      signal?.throwIfAborted(); const chunk = await reader.read(); signal?.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (Buffer.byteLength(buffer) + size > MAX_MESSAGE) throw failure('MCP SSE event exceeds size limit');
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, ''); buffer = buffer.slice(at + 1);
        if (!line) { if (dispatch()) return; }
        else if (line.startsWith('data:')) { const part = line.slice(5).replace(/^ /, ''); size += Buffer.byteLength(part); data.push(part); }
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        if (size > MAX_MESSAGE) throw failure('MCP SSE event exceeds size limit');
      }
      if (chunk.done) { if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '')); dispatch(); return; }
    }
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
