import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MCPClient } from '../src/mcp-client.js';

// Generate an ephemeral, self-signed loopback fixture without storing a private
// key, invoking OpenSSL, adding a package, or changing the process TLS policy.
function certificate() {
  const der = (tag, ...parts) => {
    const value = Buffer.concat(parts), hex = value.length.toString(16).padStart(Math.ceil(value.length.toString(16).length / 2) * 2, '0');
    const size = value.length < 128 ? Buffer.from([value.length]) : Buffer.concat([Buffer.from([0x80 + hex.length / 2]), Buffer.from(hex, 'hex')]);
    return Buffer.concat([Buffer.from([tag]), size, value]);
  };
  const seq = (...parts) => der(0x30, ...parts), integer = n => der(2, Buffer.from([n]));
  const algorithm = Buffer.from('300a06082a8648ce3d040302', 'hex');
  const name = seq(der(0x31, seq(Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('Class MCP loopback fixture')))));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const validity = seq(der(0x17, Buffer.from('200101000000Z')), der(0x17, Buffer.from('490101000000Z')));
  const tbs = seq(der(0xa0, integer(2)), integer(1), algorithm, name, validity, name, publicKey.export({ type: 'spki', format: 'der' }));
  const encoded = seq(tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, privateKey))).toString('base64');
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: '-----BEGIN CERTIFICATE-----\n' + encoded.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n' };
}
const tls = certificate();
const initialized = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'local TLS fixture', version: '1' } };
const tools = [{ name: 'echo', description: 'Local fixture', inputSchema: { type: 'object' } }];
const reply = (res, id, result) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })); };
async function readRequest(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); }
async function eventually(predicate, label) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); } assert.ok(predicate(), label); }
async function listen(t, handler) {
  const sockets = new Set(), errors = [];
  const server = createServer(tls, (req, res) => { Promise.resolve(handler(req, res)).catch(error => { errors.push(error); res.destroy(); }); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return { url: 'https://127.0.0.1:' + server.address().port, sockets };
}
function clientFor(t, fixture, config = {}, options = {}) {
  const client = new MCPClient({ transport: 'http', url: fixture.url, ...config }, { timeoutMs: 2000, ...options });
  t.after(() => client.close()); return client;
}

test('self-signed MCP HTTPS remains rejected unless skipTlsVerify is exactly true', async t => {
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  let calls = 0;
  const fixture = await listen(t, async (req, res) => { calls++; const message = await readRequest(req); if (!message.id) res.writeHead(202).end(); else reply(res, message.id, initialized); });
  for (const value of [undefined, false, 'true']) {
    const client = clientFor(t, fixture, { skipTlsVerify: value });
    await assert.rejects(client.initialize()); await client.close();
  }
  assert.equal(calls, 0);
  const allowed = clientFor(t, fixture, { skipTlsVerify: true });
  await allowed.initialize(); await allowed.close();
  assert.equal(calls, 2);
  // A different client still verifies after an unverified connection succeeded.
  await assert.rejects(clientFor(t, fixture).initialize());
  assert.equal(calls, 2);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before);
  await eventually(() => fixture.sockets.size === 0, 'closed clients must release their TLS sockets');
});

test('unverified Streamable HTTP preserves auth, session headers, POST bodies and SSE results', async t => {
  const requests = [];
  const fixture = await listen(t, async (req, res) => {
    const message = await readRequest(req); requests.push(message);
    assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer local-fixture'); assert.equal(req.headers['x-project'], 'fixture');
    assert.equal(req.headers['mcp-protocol-version'], '2025-06-18');
    if (message.method !== 'initialize') assert.equal(req.headers['mcp-session-id'], 'tls-session');
    if (!message.id) { res.writeHead(202).end(); return; }
    if (message.method === 'initialize') { res.setHeader('Mcp-Session-Id', 'tls-session'); reply(res, message.id, initialized); }
    else if (message.method === 'tools/list') reply(res, message.id, { tools });
    else { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: message.params.arguments.text }] } }) + '\n\n'); }
  });
  const client = clientFor(t, fixture, { skipTlsVerify: true, headers: { Authorization: 'Bearer local-fixture', 'X-Project': 'fixture' } });
  assert.deepEqual(await client.listTools(), tools);
  assert.equal((await client.callTool('echo', { text: 'TLS body = preserved' })).content[0].text, 'TLS body = preserved');
  await client.close();
  assert.deepEqual(requests.map(item => item.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  await eventually(() => fixture.sockets.size === 0, 'completed SSE response must be cancelled after its result');
});

test('unverified legacy SSE preserves auth and same-origin POST endpoint and closes the stream', async t => {
  let stream; const requests = [];
  const fixture = await listen(t, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer legacy-fixture');
    if (req.method === 'GET') { assert.equal(req.url, '/sse'); stream = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: endpoint\ndata: /messages?session=tls\n\n'); return; }
    assert.equal(req.url, '/messages?session=tls');
    const message = await readRequest(req); requests.push(message);
    if (message.method === 'initialize') res.setHeader('Mcp-Session-Id', 'legacy-session');
    else assert.equal(req.headers['mcp-session-id'], 'legacy-session');
    res.writeHead(202).end();
    if (message.id) stream.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? initialized : message.method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: 'legacy result' }] } }) + '\n\n');
  });
  const client = clientFor(t, fixture, { transport: 'sse', url: fixture.url + '/sse', skipTlsVerify: true, headers: { Authorization: 'Bearer legacy-fixture' } });
  assert.deepEqual(await client.listTools(), tools);
  assert.equal((await client.callTool('echo', {})).content[0].text, 'legacy result');
  await client.close();
  assert.deepEqual(requests.map(item => item.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  await eventually(() => fixture.sockets.size === 0, 'legacy stream and POST sockets must close');
});

test('unverified HTTPS refuses redirects without following or forwarding credentials', async t => {
  let redirected = 0;
  const fixture = await listen(t, (_req, res) => { redirected++; res.writeHead(307, { Location: '/must-not-follow' }).end(); });
  for (const transport of ['http', 'sse']) {
    const client = clientFor(t, fixture, { transport, skipTlsVerify: true, headers: { Authorization: 'Bearer redirect-fixture' } });
    await assert.rejects(client.initialize()); await client.close();
  }
  assert.equal(redirected, 2);
  await eventually(() => fixture.sockets.size === 0, 'redirect sockets must close');
});

test('unverified HTTPS keeps response limits and closes rejected oversized bodies', async t => {
  const fixture = await listen(t, async (req, res) => {
    const message = await readRequest(req);
    if (!message.id) { res.writeHead(202).end(); return; }
    if (message.method === 'initialize') { reply(res, message.id, initialized); return; }
    res.writeHead(200, { 'Content-Type': message.params.name === 'sse' ? 'text/event-stream' : 'application/json' });
    res.end((message.params.name === 'sse' ? 'data: ' : '') + 'x'.repeat(8 * 1024 * 1024 + 1));
  });
  const client = clientFor(t, fixture, { skipTlsVerify: true });
  for (const name of ['json', 'sse']) await assert.rejects(client.callTool(name, {}), error => error.executionStatus === 'uncertain');
  await client.close();
  await eventually(() => fixture.sockets.size === 0, 'oversized body sockets must close');
});

test('unverified HTTPS propagates cancellation, timeout and close without replay or socket leaks', async t => {
  const requests = [];
  const fixture = await listen(t, async (req, res) => {
    const message = await readRequest(req); requests.push(message);
    if (!message.id) { res.writeHead(202).end(); return; }
    if (message.method === 'initialize') { reply(res, message.id, initialized); return; }
    // Exercise both cancellation before headers and during an open SSE body.
    if (message.params.name !== 'headers') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n'); }
  });
  for (const mode of ['abort', 'timeout', 'close']) {
    const startedAt = requests.length;
    const client = clientFor(t, fixture, { skipTlsVerify: true }, { timeoutMs: mode === 'timeout' ? 100 : 2000 });
    await client.initialize();
    const controller = new AbortController(), name = mode === 'abort' ? 'headers' : mode;
    const work = client.callTool(name, {}, controller.signal);
    const rejected = assert.rejects(work, error => error.executionStatus === 'uncertain' && (mode !== 'timeout' || error.code === 'MCP_TIMEOUT'));
    await eventually(() => requests.some(item => item.method === 'tools/call' && item.params.name === name), 'call must reach the owned fixture');
    if (mode === 'abort') controller.abort(Error('Fixture cancellation'));
    if (mode === 'close') await client.close();
    await rejected;
    if (mode !== 'close') await eventually(() => requests.slice(startedAt).some(item => item.method === 'notifications/cancelled' && item.params.requestId), 'cancellation notification must be sent');
    await client.close();
    assert.equal(requests.filter(item => item.method === 'tools/call' && item.params.name === name).length, 1);
    assert.equal(client.pending.size, 0);
    await eventually(() => fixture.sockets.size === 0, 'cancelled request sockets must close');
  }
});

test('legacy unverified SSE cancellation closes pending initialization and endpoint streams', async t => {
  for (const hasEndpoint of [false, true]) {
    let connected = false;
    const fixture = await listen(t, async (req, res) => {
      if (req.method === 'GET') { connected = true; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(hasEndpoint ? 'event: endpoint\ndata: /messages\n\n' : ': waiting for endpoint\n\n'); }
      else { await readRequest(req); res.writeHead(202).end(); }
    });
    const client = clientFor(t, fixture, { transport: 'sse', skipTlsVerify: true });
    const controller = new AbortController(), initializing = client.initialize(controller.signal);
    const rejected = assert.rejects(initializing);
    await eventually(() => connected, 'SSE fixture must be connected');
    controller.abort(Error('Stop legacy initialization'));
    await rejected; await client.close();
    await eventually(() => fixture.sockets.size === 0, 'cancelled legacy initialization must release the stream');
  }
});
