import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { executeWebTool } from '../src/web-tools.js';

// Ephemeral CA material stays in memory. Both runtimes must verify the real
// target identity inside CONNECT; no global TLS policy is disabled for tests.
function certificate() {
  const der = (tag, ...parts) => {
    const value = Buffer.concat(parts), hex = value.length.toString(16).padStart(Math.ceil(value.length.toString(16).length / 2) * 2, '0');
    const size = value.length < 128 ? Buffer.from([value.length]) : Buffer.concat([Buffer.from([0x80 + hex.length / 2]), Buffer.from(hex, 'hex')]);
    return Buffer.concat([Buffer.from([tag]), size, value]);
  };
  const seq = (...parts) => der(0x30, ...parts), integer = n => der(2, Buffer.from([n]));
  const algorithm = Buffer.from('300a06082a8648ce3d040302', 'hex');
  const name = seq(der(0x31, seq(Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('source.example')))));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const validity = seq(der(0x17, Buffer.from('200101000000Z')), der(0x17, Buffer.from('490101000000Z')));
  const san = der(0xa3, seq(seq(Buffer.from('0603551d11', 'hex'), der(4, seq(der(0x82, Buffer.from('source.example')), der(0x87, Buffer.from([127, 0, 0, 1])))))));
  const tbs = seq(der(0xa0, integer(2)), integer(1), algorithm, name, validity, name, publicKey.export({ type: 'spki', format: 'der' }), san);
  const encoded = seq(tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, privateKey))).toString('base64');
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: '-----BEGIN CERTIFICATE-----\n' + encoded.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n' };
}
const credentials = certificate();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function manager(webOptions) {
  let gate;
  return {
    webOptions, controller: new AbortController(), maxOutputBytes: 65536, paused: false, events: new EventEmitter(),
    async checkpoint(signal) {
      signal.throwIfAborted();
      if (gate) await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        gate.promise.then(resolve).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
    },
    pause() { gate ||= deferred(); this.paused = true; this.events.emit('change'); },
    resume() { const old = gate; gate = undefined; this.paused = false; this.events.emit('change'); old?.resolve(); },
  };
}
async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { server, sockets, port: server.address().port };
}
async function proxyFixture(t, targetPort, { secure = false, connect } = {}) {
  const server = secure ? https.createServer(credentials) : http.createServer();
  const requests = [];
  server.on('connect', (request, client, head) => {
    requests.push({ authority: request.url, headers: request.headers });
    if (connect) { client.once('end', () => client.destroy()); connect(request, client); client.resume(); return; }
    const target = net.connect(targetPort, '127.0.0.1');
    target.on('error', () => client.destroy());
    client.once('close', () => target.destroy());
    target.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(client); client.pipe(target);
    });
  });
  const fixture = await listen(t, server);
  return { ...fixture, requests, url: `${secure ? 'https' : 'http'}://127.0.0.1:${fixture.port}` };
}
function toolsFor(proxy, options = {}) {
  return manager({ proxyEnv: { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
    lookup: async () => [{ address: '8.8.8.8', family: 4 }], ...options });
}
function fetchPage(tools, url = 'http://source.example/page', args = {}, signal) {
  return executeWebTool(tools, 'fixture', 'web_fetch', { url, ...args }, signal);
}
async function eventually(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(10);
  assert.ok(predicate());
}

for (const protocol of ['http', 'https']) {
  test(`${protocol} target uses a pinned CONNECT address and preserves Host, TLS and credential separation`, { timeout: 5000 }, async t => {
    let seen, servername, lookups = 0;
    const handler = (req, res) => { seen = req; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Verified through the proxy.'); };
    const source = await listen(t, protocol === 'https' ? https.createServer(credentials, handler) : http.createServer(handler));
    source.server.on('secureConnection', socket => { servername = socket.servername; });
    const proxy = await proxyFixture(t, source.port);
    const url = new URL(proxy.url); url.username = 'fixture-user'; url.password = 'fixture-secret';
    const tools = toolsFor(proxy, { ca: credentials.cert, proxyEnv: { HTTP_PROXY: url.href, HTTPS_PROXY: url.href }, lookup: async hostname => {
      lookups++; assert.equal(hostname, 'source.example'); return [{ address: '8.8.8.8', family: 4 }];
    } });
    const result = await fetchPage(tools, `${protocol}://source.example/page`);
    assert.match(result.output, /Verified through the proxy/);
    assert.equal(lookups, 1);
    assert.equal(proxy.requests[0].authority, `8.8.8.8:${protocol === 'https' ? 443 : 80}`);
    assert.equal(proxy.requests[0].headers['proxy-authorization'], 'Basic ' + Buffer.from('fixture-user:fixture-secret').toString('base64'));
    assert.equal(seen.headers.host, 'source.example');
    assert.equal(seen.headers['proxy-authorization'], undefined);
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(seen.url, '/page');
    assert.doesNotMatch(JSON.stringify(result), /fixture-user|fixture-secret/);
    if (protocol === 'https') assert.equal(servername, 'source.example');
  });
}

test('HTTPS proxy verifies its certificate and target TLS still rejects untrusted or wrong-name certificates', { timeout: 5000 }, async t => {
  let reads = 0;
  const source = await listen(t, https.createServer(credentials, (_req, res) => { reads++; res.end('TLS verified'); }));
  const proxy = await proxyFixture(t, source.port, { secure: true });
  await assert.rejects(fetchPage(toolsFor(proxy, { ca: credentials.cert }), 'https://source.example'), { code: 'WEB_PROXY_CONNECT_FAILED' });
  await assert.rejects(fetchPage(toolsFor(proxy, { proxyCa: credentials.cert }), 'https://source.example'), { code: 'WEB_TLS_ERROR' });
  await assert.rejects(fetchPage(toolsFor(proxy, { proxyCa: credentials.cert, ca: credentials.cert }), 'https://wrong-name.example'), { code: 'WEB_TLS_ERROR' });
  assert.equal(reads, 0);
  assert.match((await fetchPage(toolsFor(proxy, { proxyCa: credentials.cert, ca: credentials.cert }), 'https://source.example')).output, /TLS verified/);
  assert.equal(reads, 1);
});

test('proxy does not bypass mixed/private DNS or redirect destination checks', { timeout: 5000 }, async t => {
  const source = await listen(t, http.createServer((_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); }));
  const proxy = await proxyFixture(t, source.port);
  await assert.rejects(fetchPage(toolsFor(proxy, { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] })), { code: 'WEB_TARGET_BLOCKED' });
  await assert.rejects(fetchPage(toolsFor(proxy), 'http://127.0.0.1/private'), { code: 'WEB_TARGET_BLOCKED' });
  assert.equal(proxy.requests.length, 0);
  await assert.rejects(fetchPage(toolsFor(proxy)), { code: 'WEB_TARGET_BLOCKED' });
  assert.equal(proxy.requests.length, 1);
});

test('NO_PROXY honors exact hosts, domain suffixes, ports, wildcard and lowercase variables', { timeout: 5000 }, async t => {
  const source = await listen(t, http.createServer((_req, res) => res.end('direct fixture')));
  const proxy = await proxyFixture(t, source.port, { connect: (_req, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n') });
  const bypass = { allowPrivateNetwork: true, lookup: async () => [{ address: '127.0.0.1', family: 4 }] };
  for (const noProxy of ['source.example', '.example', '*.example', `source.example:${source.port}`, '*']) {
    const tools = toolsFor(proxy, { ...bypass, proxyEnv: { http_proxy: proxy.url, no_proxy: noProxy } });
    assert.match((await fetchPage(tools, `http://source.example:${source.port}`)).output, /direct fixture/);
  }
  assert.equal(proxy.requests.length, 0);
  for (const noProxy of ['other.example', '.notexample', 'source.example:1']) {
    await assert.rejects(fetchPage(toolsFor(proxy, { proxyEnv: { HTTP_PROXY: proxy.url, NO_PROXY: noProxy } })), { code: 'WEB_PROXY_REJECTED' });
  }
  assert.equal(proxy.requests.length, 3);
});

test('proxy rejection and invalid configuration do not reveal proxy credentials or response text', { timeout: 5000 }, async t => {
  const proxy = await proxyFixture(t, 0, { connect: (_req, socket) => socket.end('HTTP/1.1 407 fixture-secret\r\nContent-Length: 0\r\n\r\n') });
  const url = new URL(proxy.url); url.username = 'fixture-user'; url.password = 'fixture-secret';
  await assert.rejects(fetchPage(toolsFor(proxy, { proxyEnv: { HTTP_PROXY: url.href } })), error => {
    assert.equal(error.code, 'WEB_PROXY_REJECTED'); assert.doesNotMatch(error.message, /fixture-user|fixture-secret/); return true;
  });
  for (const value of ['socks5://fixture-user:fixture-secret@127.0.0.1:1', 'not a URL fixture-secret']) {
    await assert.rejects(fetchPage(toolsFor(proxy, { proxyEnv: { HTTP_PROXY: value } })), error => {
      assert.equal(error.code, 'WEB_PROXY_CONFIGURATION_INVALID'); assert.doesNotMatch(error.message, /fixture-user|fixture-secret/); return true;
    });
  }
});

test('cancellation closes a stalled CONNECT and an established tunnel', { timeout: 5000 }, async t => {
  const entered = deferred();
  const proxy = await proxyFixture(t, 0, { connect: () => entered.resolve() });
  const controller = new AbortController(), pending = fetchPage(toolsFor(proxy), undefined, {}, controller.signal);
  await entered.promise; controller.abort(new Error('fixture cancelled'));
  await assert.rejects(pending, /fixture cancelled/);
  await eventually(() => proxy.sockets.size === 0);

  const reading = deferred();
  const source = await listen(t, http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial'); reading.resolve(); }));
  const connected = await proxyFixture(t, source.port);
  const tools = toolsFor(connected), active = fetchPage(tools);
  await reading.promise; tools.controller.abort(new Error('manager stopped'));
  await assert.rejects(active, /manager stopped/);
  await eventually(() => connected.sockets.size === 0);
});

test('pause holds a completed CONNECT before sending HTTP and freezes active deadlines', { timeout: 5000 }, async t => {
  let reads = 0;
  const connected = deferred();
  const source = await listen(t, http.createServer((_req, res) => { reads++; res.end('resumed fixture'); }));
  const proxy = await proxyFixture(t, source.port);
  const tools = toolsFor(proxy);
  proxy.server.prependListener('connect', () => { tools.pause(); connected.resolve(); });
  const pending = fetchPage(tools, undefined, { timeoutMs: 1000 });
  await connected.promise; await delay(1100);
  assert.equal(reads, 0);
  tools.resume();
  assert.match((await pending).output, /resumed fixture/);
  assert.equal(reads, 1);
});

test('proxy response limits, target failures and active timeout remain enforced', { timeout: 5000 }, async t => {
  const source = await listen(t, http.createServer((req, res) => {
    if (req.url === '/stall') return;
    if (req.url === '/error') { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(1000));
  }));
  const proxy = await proxyFixture(t, source.port), tools = toolsFor(proxy, { maxResponseBytes: 512 });
  await assert.rejects(fetchPage(tools), { code: 'WEB_RESPONSE_TOO_LARGE' });
  await assert.rejects(fetchPage(tools, 'http://source.example/error'), { code: 'WEB_HTTP_ERROR' });
  await assert.rejects(fetchPage(tools, 'http://source.example/stall', { timeoutMs: 1000 }), { code: 'WEB_TIMEOUT' });
});
