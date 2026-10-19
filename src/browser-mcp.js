import { browserToolDefinitions } from './browser-tools.js';
import { inspectToolCall } from './tool-contract.js';

const VERSION = '2025-06-18';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const definition = { ...browserToolDefinitions[0], strictArguments: true };

// Private, in-process MCP transport. JSON-RPC initialization, discovery and
// calls still pass through MCPClient. No socket, subprocess or extra browser
// implementation is needed. The member identity comes only from the runtime.
export class BrowserMCPTransport {
  constructor(manager, agentId) {
    if (typeof agentId !== 'string' || !agentId) throw Error('Browser MCP requires an authorized member');
    this.manager = manager; this.agentId = agentId;
    this.initialized = false; this.ready = false; this.closed = false;
    this.controller = new AbortController(); this.pending = new Map();
  }
  async send(body, signal) {
    if (this.closed) throw Error('Browser MCP is closed');
    let message;
    try { message = JSON.parse(body); } catch { return JSON.stringify({ jsonrpc:'2.0', id:null, error:{ code:-32700, message:'Invalid JSON' } }); }
    const reply = result => JSON.stringify({ jsonrpc:'2.0', id:message.id, result });
    const reject = (code, text) => JSON.stringify({ jsonrpc:'2.0', id:message?.id ?? null, error:{ code, message:text } });
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return reject(-32600, 'Invalid request');
    if (message.id === undefined) {
      if (message.method === 'notifications/initialized' && this.initialized) this.ready = true;
      if (message.method === 'notifications/cancelled') this.pending.get(message.params?.requestId)?.controller.abort(Error('Browser MCP call cancelled'));
      return;
    }
    if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id))) return reject(-32600, 'Invalid request ID');
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    if (message.method === 'initialize') {
      if (this.initialized || !object(message.params) || typeof message.params.protocolVersion !== 'string') return reject(-32600, 'Invalid initialization');
      this.initialized = true;
      return reply({ protocolVersion:VERSION, capabilities:{ tools:{} }, serverInfo:{ name:'Class browser', version:'1.2.0' } });
    }
    if (message.method === 'ping') return reply({});
    if (!this.ready) return reject(-32000, 'Initialize the browser MCP first');
    if (message.method === 'tools/list') return reply({ tools:[{ name:definition.name, description:definition.description, inputSchema:definition.parameters }] });
    if (message.method !== 'tools/call') return reject(-32601, 'Method not found');
    if (!object(message.params) || message.params.name !== definition.name) return reject(-32602, 'Unknown browser tool');
    if (this.pending.has(message.id)) return reject(-32600, 'Duplicate request ID');
    let args;
    try { args = inspectToolCall(definition.name, message.params.arguments ?? {}, { definitions:[definition] }).args; }
    catch { return reject(-32602, 'Arguments do not match the browser tool schema'); }
    const controller = new AbortController(), callSignal = AbortSignal.any([combined, controller.signal]);
    const work = (async () => {
      try {
        await this.manager.checkpoint(callSignal);
        const result = await this.manager.browserTools.execute(this.agentId, 'browser', args, callSignal);
        return reply({ content:[{ type:'text', text:result.output }, ...(result.media || []).map(({ type, data, mimeType }) => ({ type, data, mimeType }))], isError:result.success === false });
      } catch (error) {
        if (callSignal.aborted) throw error;
        return reply({ isError:true, content:[{ type:'text', text:error.message || 'Browser operation failed' }],
          structuredContent:{ executionStatus:['unknown','uncertain','not_started'].includes(error.executionStatus) ? error.executionStatus : 'not_started' } });
      }
    })();
    this.pending.set(message.id, { controller, work });
    try { return await work; } finally { this.pending.delete(message.id); }
  }
  async close() {
    this.closed = true; this.controller.abort(Error('Browser MCP closed'));
    await Promise.allSettled([...this.pending.values()].map(item => item.work));
    // BrowserTools/ToolManager own all browser processes and their cleanup.
  }
}
