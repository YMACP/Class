import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { once, EventEmitter } from 'node:events';
import { executeWebTool, isPublicAddress, readableHTML, webToolDefinitions } from '../src/web-tools.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function manager(options = {}) {
  let gate;
  return {
    maxOutputBytes: 65536, controller: new AbortController(), webOptions: options, paused: false, events: new EventEmitter(),
    async checkpoint(signal) {
      signal.throwIfAborted();
      if (gate) await new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
        gate.promise.then(resolve).finally(() => signal.removeEventListener('abort', aborted));
        if (signal.aborted) aborted();
      });
      signal.throwIfAborted();
    },
    pause() { gate ||= deferred(); this.paused = true; this.events.emit('change'); },
    resume() { const saved = gate; gate = undefined; this.paused = false; this.events.emit('change'); saved?.resolve(); },
  };
}
async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
function call(tools, name, args, signal) { return executeWebTool(tools, 'fixture-student', name, args, signal); }

test('web schemas expose only public read operations, never private-network permission', () => {
  assert.deepEqual(webToolDefinitions.map(tool => tool.name), ['web_search', 'web_fetch']);
  for (const definition of webToolDefinitions) {
    assert.equal(definition.parameters.additionalProperties, false);
    assert.ok(!('allowPrivateNetwork' in definition.parameters.properties));
    assert.match(definition.description, /untrusted/i);
  }
});

test('public address classification blocks local, reserved and IPv6 transition destinations', () => {
  for (const address of ['0.1.2.3', '10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.0.1', '192.0.2.1', '198.19.0.1', '198.51.100.2', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '64:ff9b::7f00:1', '2001:0::1', '2001:db8::1', '2002:7f00:1::', '3fff::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
});

test('fetch extracts readable HTML, source, title and relative links without executing scripts', { timeout: 5000 }, async t => {
  let requests = 0;
  const { origin } = await fixture(t, (_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Example &amp; Evidence</title><style>SECRET_STYLE</style></head><body><h1>Readable</h1><p>你好 &amp; hello</p><a href="/proof?a=1&amp;b=2">Proof</a><script>SECRET_SCRIPT; fetch("/side-effect")</script><img src="/not-requested" alt="Figure"><ul><li>First</li></ul></body></html>');
  });
  const result = await call(manager({ allowedPrivateOrigins: [origin] }), 'web_fetch', { url: origin });
  assert.equal(result.name, 'web_fetch');
  assert.equal(result.untrusted, true);
  assert.equal(result.statusCode, 200);
  assert.match(result.output, /Title: Example & Evidence/);
  assert.match(result.output, /# Readable/);
  assert.match(result.output, /你好 & hello/);
  assert.ok(result.output.includes(`[Proof](${origin}/proof?a=1&b=2)`));
  assert.doesNotMatch(result.output, /SECRET_SCRIPT|SECRET_STYLE/);
  assert.equal(requests, 1);
});

test('fetch reads compressed text and JSON; enforces text and shared UTF-8 output limits', { timeout: 5000 }, async t => {
  const { origin } = await fixture(t, (request, response) => {
    if (request.url === '/json') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"answer":42}'); return; }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'gzip' });
    response.end(gzipSync('中文'.repeat(2000)));
  });
  const tools = manager({ allowPrivateNetwork: true });
  assert.match((await call(tools, 'web_fetch', { url: origin + '/json' })).output, /"answer":42/);
  const contentLimited = await call(tools, 'web_fetch', { url: origin, maxChars: 100 });
  assert.equal(contentLimited.truncated, true);
  assert.match(contentLimited.output, /Content truncated/);
  tools.maxOutputBytes = 321;
  const byteLimited = await call(tools, 'web_fetch', { url: origin });
  assert.equal(byteLimited.truncated, true);
  assert.ok(Buffer.byteLength(byteLimited.output) <= 321);
  assert.doesNotMatch(byteLimited.output, /�/);
});

test('fetch rejects invalid URLs, private literals and mixed public/private DNS answers before requests', { timeout: 5000 }, async t => {
  let hits = 0;
  const { origin } = await fixture(t, (_request, response) => { hits++; response.end('must not be read'); });
  const tools = manager();
  for (const url of ['file:///C:/secret', 'ftp://example.com/file', 'https://user:password@example.com/', origin, 'http://2130706433/', 'http://[::1]/', 'http://localhost/', 'http://metadata.internal/']) {
    await assert.rejects(call(tools, 'web_fetch', { url }), /HTTP|credentials|private|Local/);
  }
  tools.webOptions.lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(call(tools, 'web_fetch', { url: 'http://public.example/' }), { code: 'WEB_TARGET_BLOCKED' });
  assert.equal(hits, 0);
});

test('connection uses the validated DNS address once and preserves the original Host', { timeout: 5000 }, async t => {
  let host, lookups = 0;
  const { server } = await fixture(t, (request, response) => { host = request.headers.host; response.end('pinned'); });
  const tools = manager({ allowPrivateNetwork: true, lookup: async () => {
    lookups++;
    assert.equal(lookups, 1, 'the HTTP transport must not do a second DNS lookup');
    return [{ address: '127.0.0.1', family: 4 }];
  } });
  const expectedHost = `public.example:${server.address().port}`;
  assert.match((await call(tools, 'web_fetch', { url: `http://${expectedHost}/` })).output, /pinned/);
  assert.equal(host, expectedHost);
  assert.equal(lookups, 1);
});

test('connection can fall back between validated IP addresses without another DNS query', { timeout: 5000 }, async t => {
  let lookups = 0;
  const { server } = await fixture(t, (_request, response) => response.end('alternate address'));
  const tools = manager({ allowPrivateNetwork: true, lookup: async () => {
    lookups++;
    return [{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }];
  } });
  const result = await call(tools, 'web_fetch', { url: `http://address-fixture.example:${server.address().port}/` });
  assert.match(result.output, /alternate address/);
  assert.equal(lookups, 1);
});

test('redirects are followed with public-target and scheme checks on every hop', { timeout: 5000 }, async t => {
  let hits = 0;
  const { origin, server } = await fixture(t, (request, response) => {
    hits++;
    if (request.url === '/ok') response.end('redirect evidence');
    else response.writeHead(302, { location: request.url === '/safe' ? '/ok' : request.url === '/file' ? 'file:///C:/secret' : `http://localhost:${server.address().port}/ok` }).end();
  });
  const tools = manager({ allowedPrivateOrigins: [origin] });
  const result = await call(tools, 'web_fetch', { url: origin + '/safe' });
  assert.equal(result.url, origin + '/ok');
  assert.match(result.output, /redirect evidence/);
  await assert.rejects(call(tools, 'web_fetch', { url: origin + '/private' }), { code: 'WEB_TARGET_BLOCKED' });
  await assert.rejects(call(tools, 'web_fetch', { url: origin + '/file' }), { code: 'WEB_URL_INVALID' });
  assert.equal(hits, 4, 'blocked redirect targets must never be requested');
});

test('redirect loops and redirect count are bounded', { timeout: 5000 }, async t => {
  let hits = 0;
  const { origin } = await fixture(t, (request, response) => {
    hits++;
    const path = request.url === '/loop' ? '/loop' : '/' + (Number(request.url.slice(1)) + 1);
    response.writeHead(302, { location: path }).end();
  });
  const tools = manager({ allowPrivateNetwork: true });
  await assert.rejects(call(tools, 'web_fetch', { url: origin + '/loop' }), { code: 'WEB_REDIRECT_LIMIT' });
  assert.equal(hits, 1);
  await assert.rejects(call(tools, 'web_fetch', { url: origin + '/0' }), { code: 'WEB_REDIRECT_LIMIT' });
  assert.equal(hits, 7);
});

test('pause gates hold a redirect and resume without repeating the completed first request', { timeout: 5000 }, async t => {
  const tools = manager({ allowPrivateNetwork: true });
  const reached = deferred();
  let first = 0, second = 0;
  const { origin } = await fixture(t, (request, response) => {
    if (request.url === '/first') { first++; tools.pause(); response.writeHead(302, { location: '/second' }).end(); reached.resolve(); }
    else { second++; response.end('finished once'); }
  });
  const execution = call(tools, 'web_fetch', { url: origin + '/first' });
  await reached.promise;
  await tick(); await tick();
  assert.equal(second, 0);
  tools.resume();
  assert.match((await execution).output, /finished once/);
  assert.equal(first, 1); assert.equal(second, 1);
});

test('response byte bounds reject declared, chunked and decompressed oversized bodies', { timeout: 5000 }, async t => {
  const { origin } = await fixture(t, (request, response) => {
    response.setHeader('content-type', 'text/plain');
    if (request.url === '/length') { response.setHeader('content-length', 1000); response.end('x'.repeat(1000)); }
    else if (request.url === '/gzip') { response.setHeader('content-encoding', 'gzip'); response.end(gzipSync('x'.repeat(20000))); }
    else { response.write('x'.repeat(300)); response.end('x'.repeat(300)); }
  });
  const tools = manager({ allowPrivateNetwork: true, maxResponseBytes: 512 });
  for (const route of ['/length', '/chunks', '/gzip']) await assert.rejects(call(tools, 'web_fetch', { url: origin + route }), { code: 'WEB_RESPONSE_TOO_LARGE' });
});

test('HTTP errors, unsupported binaries and incomplete responses are not returned as evidence', { timeout: 5000 }, async t => {
  const { origin } = await fixture(t, (request, response) => {
    if (request.url === '/error') response.writeHead(403).end('denied');
    else if (request.url === '/binary') response.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.7');
    else { response.writeHead(200, { 'content-length': 500 }); response.write('partial'); setImmediate(() => response.destroy()); }
  });
  const tools = manager({ allowPrivateNetwork: true });
  await assert.rejects(call(tools, 'web_fetch', { url: origin + '/error' }), { code: 'WEB_HTTP_ERROR' });
  await assert.rejects(call(tools, 'web_fetch', { url: origin + '/binary' }), { code: 'WEB_CONTENT_UNSUPPORTED' });
  await assert.rejects(call(tools, 'web_fetch', { url: origin + '/incomplete' }), /closed|aborted|hang up|reset/i);
});

test('deadline cancels stalled responses', { timeout: 5000 }, async t => {
  const { origin } = await fixture(t, (_request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.write('waiting'); });
  const tools = manager({ allowPrivateNetwork: true });
  await assert.rejects(call(tools, 'web_fetch', { url: origin, timeoutMs: 1000 }), { code: 'WEB_TIMEOUT' });
});

test('caller abort, manager stop and cancellation while paused terminate without another request', { timeout: 5000 }, async t => {
  const reached = [];
  let requests = 0;
  const { origin } = await fixture(t, (_request, response) => {
    requests++; response.writeHead(200); response.write('waiting'); reached.shift()?.resolve();
  });
  for (const useManager of [false, true]) {
    const tools = manager({ allowPrivateNetwork: true }), controller = new AbortController(), started = deferred();
    reached.push(started);
    const pending = call(tools, 'web_fetch', { url: origin }, controller.signal);
    await started.promise;
    (useManager ? tools.controller : controller).abort(new Error('fixture cancelled'));
    await assert.rejects(pending, /fixture cancelled/);
  }
  const tools = manager({ allowPrivateNetwork: true }); tools.pause();
  const pending = call(tools, 'web_fetch', { url: origin });
  tools.controller.abort(new Error('paused stop'));
  await assert.rejects(pending, /paused stop/);
  tools.resume();
  assert.equal(requests, 2);
});

test('search parses DuckDuckGo result titles, decoded URLs and snippets with query encoding', { timeout: 5000 }, async t => {
  let query;
  const { origin } = await fixture(t, (request, response) => {
    query = new URL(request.url, 'http://fixture').searchParams.get('q');
    response.writeHead(200, { 'content-type': 'text/html' }).end('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fproof%3Fa%3D1%26b%3D2">Real &amp; result</a><a class="result__snippet">Verified <b>snippet</b>.</a><a class="result__a" href="https://example.com/second">Second</a><div class="result__snippet">More</div>');
  });
  const tools = manager({ allowPrivateNetwork: true, searchProviders: [{ name: 'DDG fixture', format: 'html', url: origin + '/?q={query}' }] });
  const result = await call(tools, 'web_search', { query: '中文 & proof', maxResults: 1 });
  assert.equal(query, '中文 & proof');
  assert.equal(result.resultCount, 1);
  assert.match(result.output, /Real & result/);
  assert.match(result.output, /https:\/\/example.com\/proof\?a=1&b=2/);
  assert.match(result.output, /Verified snippet/);
  assert.doesNotMatch(result.output, /Second/);
});

test('search falls back from anti-bot HTML to real RSS results, removing duplicates', { timeout: 5000 }, async t => {
  const paths = [];
  const { origin } = await fixture(t, (request, response) => {
    paths.push(new URL(request.url, 'http://fixture').pathname);
    if (request.url.startsWith('/blocked')) { response.writeHead(200, { 'content-type': 'text/html' }).end('<html>CAPTCHA: verify you are human</html>'); return; }
    response.writeHead(200, { 'content-type': 'application/rss+xml' }).end('<rss><channel><item><title>Evidence &amp; link</title><link>https://example.com/proof</link><description><![CDATA[Actual <b>summary</b>]]></description></item><item><title>Duplicate</title><link>https://example.com/proof</link><description>Duplicate</description></item></channel></rss>');
  });
  const tools = manager({ allowPrivateNetwork: true, searchProviders: [
    { name: 'Blocked fixture', format: 'html', url: origin + '/blocked?q={query}' },
    { name: 'RSS fixture', format: 'rss', url: origin + '/rss?q={query}' },
  ] });
  const result = await call(tools, 'web_search', { query: 'fixture' });
  assert.equal(result.resultCount, 1);
  assert.match(result.output, /Evidence & link/);
  assert.match(result.output, /Actual summary/);
  assert.doesNotMatch(result.output, /Duplicate|CAPTCHA/);
  assert.deepEqual(paths, ['/blocked', '/rss']);
});

test('search reports explicit failure when providers return challenges or no valid results', { timeout: 5000 }, async t => {
  const { origin } = await fixture(t, (_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<html>CAPTCHA: unusual traffic</html>'));
  const tools = manager({ allowPrivateNetwork: true, searchProviders: [{ name: 'Challenge fixture', format: 'html', url: origin + '/?q={query}' }] });
  await assert.rejects(call(tools, 'web_search', { query: 'fixture' }), error => error.code === 'WEB_SEARCH_FAILED' && /anti-bot challenge/.test(error.message));
});

test('a stalled search provider leaves time for the fallback service', { timeout: 5000 }, async t => {
  const paths = [];
  const { origin } = await fixture(t, (request, response) => {
    paths.push(new URL(request.url, 'http://fixture').pathname);
    if (request.url.startsWith('/stalled')) return;
    response.writeHead(200, { 'content-type': 'application/rss+xml' }).end('<rss><channel><item><title>Fallback proof</title><link>https://example.com/proof</link><description>Verified fallback snippet</description></item></channel></rss>');
  });
  const tools = manager({ allowPrivateNetwork: true, searchProviders: [
    { name: 'Stalled fixture', format: 'html', url: origin + '/stalled?q={query}' },
    { name: 'Fallback fixture', format: 'rss', url: origin + '/rss?q={query}' },
  ] });
  const result = await call(tools, 'web_search', { query: 'fixture', timeoutMs: 2000 });
  assert.match(result.output, /Fallback proof/);
  assert.deepEqual(paths, ['/stalled', '/rss']);
});

test('a long pause freezes both search provider and total operation deadlines', { timeout: 5000 }, async t => {
  const tools = manager({ allowPrivateNetwork: true });
  const reached = deferred();
  let requests = 0;
  const { origin } = await fixture(t, (_request, response) => {
    requests++; tools.pause(); reached.resolve();
    response.writeHead(200, { 'content-type': 'application/rss+xml' }).end('<rss><channel><item><title>Paused evidence</title><link>https://example.com/proof</link><description>Retained response</description></item></channel></rss>');
  });
  tools.webOptions.searchProviders = [{ name: 'Pause fixture', format: 'rss', url: origin + '/?q={query}' }];
  const pending = call(tools, 'web_search', { query: 'fixture', timeoutMs: 1000 });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await reached.promise;
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(settled, false, 'paused time must not exhaust either deadline');
  tools.resume();
  assert.match((await pending).output, /Paused evidence/);
  assert.equal(requests, 1);
});

test('invalid arguments fail before any request', { timeout: 5000 }, async () => {
  const tools = manager({ lookup: () => { throw new Error('must not resolve'); } });
  await assert.rejects(call(tools, 'web_fetch', { url: 'https://example.com', timeoutMs: 0 }), { code: 'WEB_ARGUMENT_INVALID' });
  await assert.rejects(call(tools, 'web_search', { query: ' ' }), { code: 'WEB_ARGUMENT_INVALID' });
  await assert.rejects(call(tools, 'web_search', { query: 'x'.repeat(2001) }), { code: 'WEB_ARGUMENT_INVALID' });
  await assert.rejects(call(tools, 'web_search', { query: 'fixture', maxResults: 11 }), { code: 'WEB_ARGUMENT_INVALID' });
});

test('malformed HTML is bounded even with many unterminated tag and comment prefixes', { timeout: 3000 }, () => {
  assert.ok(readableHTML('<a '.repeat(100000), 'https://example.com/').text.length > 0);
  assert.equal(readableHTML('<!--'.repeat(100000), 'https://example.com/').text, '');
});

test('DNS lookup cancellation does not wait for an unresponsive resolver', { timeout: 3000 }, async () => {
  const started = deferred(), controller = new AbortController();
  const tools = manager({ lookup: () => { started.resolve(); return new Promise(() => {}); } });
  const pending = call(tools, 'web_fetch', { url: 'https://resolver-fixture.example/' }, controller.signal);
  await started.promise;
  controller.abort(new Error('resolver cancelled'));
  await assert.rejects(pending, /resolver cancelled/);
});
