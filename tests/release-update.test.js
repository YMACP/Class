import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { checkRelease, downloadRelease } from '../src/release-update.js';

const API = 'https://api.github.com/repos/YMACP/Class/releases/latest';
const hash = value => createHash('sha256').update(value).digest('hex');
const response = (body, headers = {}, statusCode = 200) => {
  const stream = Readable.from(Array.isArray(body) ? body : [Buffer.from(body)]);
  return { statusCode, headers, body: stream, destroy: () => stream.destroy() };
};
function executable(platform = 'linux') {
  const buffer = Buffer.alloc(512);
  if (platform === 'linux') {
    buffer.write('\x7fELF', 0, 'ascii'); buffer[4] = 2; buffer[5] = 1; buffer[6] = 1;
    buffer.writeUInt16LE(3, 16); buffer.writeUInt16LE(62, 18); buffer.writeUInt16LE(64, 52);
  } else {
    buffer.write('MZ'); buffer.writeUInt32LE(128, 60); buffer.write('PE\0\0', 128);
    buffer.writeUInt16LE(0x8664, 132); buffer.writeUInt16LE(2, 150); buffer.writeUInt16LE(0x20b, 152);
  }
  return buffer;
}
function asset(platform = 'linux', bytes = executable(platform), overrides = {}) {
  const name = platform === 'linux' ? 'Class' : 'Class.exe';
  return { name, platform, arch: 'x64', version: '1.2.1', tag: 'v1.2.1', size: bytes.length,
    digest: 'sha256:' + hash(bytes), url: 'https://github.com/YMACP/Class/releases/download/v1.2.1/' + name, ...overrides };
}
function release({ version = 'v1.2.1', assets = [asset('linux'), asset('win32')], ...overrides } = {}) {
  return { tag_name: version, draft: false, prerelease: false, published_at: '2026-10-19T12:00:00Z',
    assets: assets.map(item => ({ name: item.name, size: item.size, digest: item.digest, browser_download_url: item.url })), ...overrides };
}
function checker(value) {
  return options => checkRelease({ currentVersion: '1.2.0', platform: 'linux', arch: 'x64', ...options,
    _request: async url => { assert.equal(url.href, API); return response(JSON.stringify(value)); } });
}
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-release-update-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(directory)), parent);
    assert.match(path.basename(directory), /^class-release-update-/);
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('official stable releases select the actual Class and Class.exe asset names without a token', async () => {
  for (const platform of ['linux', 'win32']) {
    const result = await checker(release())({ platform });
    assert.equal(result.available, true); assert.equal(result.version, '1.2.1');
    assert.equal(result.asset.name, platform === 'linux' ? 'Class' : 'Class.exe');
    assert.equal(result.asset.arch, 'x64'); assert.equal(result.asset.platform, platform);
    assert.match(result.asset.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.releaseUrl, 'https://github.com/YMACP/Class/releases/tag/v1.2.1');
  }
});

test('versions compare numeric components, never downgrade and reject nonstable or malformed semver', async () => {
  for (const currentVersion of ['1.2.1', '1.2.2', '2.0.0']) {
    const result = await checker(release())({ currentVersion }); assert.equal(result.available, false); assert.equal(result.reason, 'up_to_date'); assert.equal(result.asset, undefined);
  }
  assert.equal((await checker(release({ version: 'v1.10.0', assets: [] }))({ currentVersion: '1.9.99' })).reason, 'asset_unavailable');
  assert.equal((await checker(release({ version: 'v9007199254740993.0.0', assets: [] }))({ currentVersion: '9007199254740992.0.0' })).reason, 'asset_unavailable');
  for (const tag of ['1.2', 'v01.2.3', 'v1.2.3-beta', 'v1.2.3+build', 'v1.2.3.4', ' v1.2.3']) {
    await assert.rejects(checker(release({ version: tag }))(), { code: 'UPDATE_VERSION_INVALID' });
  }
  for (const flag of ['draft', 'prerelease']) assert.equal((await checker(release({ [flag]: true }))()).reason, 'unstable_release');
  await assert.rejects(checker(release())({ currentVersion: '1.2.0-beta' }), { code: 'UPDATE_VERSION_INVALID' });
  await assert.rejects(checker(release())({ arch: 'arm64' }), { code: 'UPDATE_PLATFORM_UNSUPPORTED' });
});

test('explicit platform names are accepted while ARM, archives and ambiguous variants cannot be downloaded', async () => {
  for (const [platform, name] of [['win32', 'Class-windows-x64.exe'], ['win32', 'Class-winx64.exe'], ['linux', 'Class-linux-amd64'], ['linux', 'Class-linux-x64.bin']]) {
    const item = asset(platform, executable(platform), { name, url: 'https://github.com/YMACP/Class/releases/download/v1.2.1/' + name });
    assert.equal((await checker(release({ assets: [item] }))({ platform })).asset.name, name);
  }
  for (const name of ['Class-linux-arm64', 'Class-linux-amd64.tar.gz', 'Class-linux-amd64.zip', 'Class-windows-arm64.exe', 'Class-source.zip', 'Class-x64.exe']) {
    assert.equal((await checker(release({ assets: [asset('linux', executable(), { name })] }))()).reason, 'asset_unavailable');
  }
  const variants = ['Class-linux-x64', 'Class-linux-amd64'].map(name => asset('linux', executable(), { name, url: 'https://github.com/YMACP/Class/releases/download/v1.2.1/' + name }));
  await assert.rejects(checker(release({ assets: variants }))(), { code: 'UPDATE_ASSET_AMBIGUOUS' });
});

test('metadata validates asset identity, length, checksum format and fixed official download URL', async () => {
  for (const overrides of [
    { size: -1 }, { size: 513 * 1024 * 1024 }, { size: 1.5 }, { digest: 'md5:abc' },
    { url: 'https://api.github.com/repos/YMACP/Class/releases/assets/1' },
    { url: 'https://github.com/other/Class/releases/download/v1.2.1/Class' },
    { url: 'https://github.com/YMACP/Class/releases/download/v1.2.2/Class' },
    { url: 'https://github.com@evil.example/YMACP/Class/releases/download/v1.2.1/Class' },
    { url: 'https://user:password@github.com/YMACP/Class/releases/download/v1.2.1/Class' },
  ]) await assert.rejects(checker(release({ assets: [asset('linux', executable(), overrides)] }))(), /release|Release|Official/);
  assert.equal((await checker(release({ assets: [asset('linux', executable(), { digest: null })] }))()).asset.digest, null);
});

test('metadata HTTP errors, malformed bodies, oversized and incomplete responses fail explicitly', async () => {
  const options = { currentVersion: '1.2.0', platform: 'linux', arch: 'x64' };
  for (const make of [
    () => response('', {}, 403), () => response('not JSON'), () => response('{}'),
    () => response('{}', { 'content-length': '1048577' }), () => response('{}', { 'content-length': '500' }),
    () => response('{}', { 'content-encoding': 'gzip' }), () => response(Buffer.alloc(1048577)),
  ]) await assert.rejects(checkRelease({ ...options, _request: async () => make() }), /release|Release|Encoded|Official/);
  await assert.rejects(checkRelease({ ...options, _request: async () => response('', { location: 'https://api.github.com/repos/other/Class/releases/latest' }, 302) }), { code: 'UPDATE_URL_BLOCKED' });
});

test('GitHub anonymous quota errors are distinguished without exposing response bodies', async () => {
  const options = { currentVersion: '1.2.0', platform: 'linux', arch: 'x64' };
  for (const status of [403, 429]) {
    await assert.rejects(checkRelease({ ...options, _request: async () => response('untrusted response text', {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792424940',
    }, status) }), error => {
      assert.equal(error.code, 'UPDATE_RATE_LIMITED'); assert.equal(error.statusCode, status);
      assert.equal(error.retryAt, new Date(1792424940000).toISOString());
      assert.ok(!error.message.includes('untrusted')); return true;
    });
  }
  await assert.rejects(checkRelease({ ...options, _request: async () => response('', {}, 403) }), { code: 'UPDATE_HTTP_ERROR', statusCode: 403 });
});

for (const platform of ['linux', 'win32']) test(`${platform}: streaming download verifies published length, hash and static x64 headers`, async t => {
  const directory = await fixture(t), binary = executable(platform), destination = path.join(directory, 'candidate');
  const visited = [];
  const result = await downloadRelease(asset(platform, binary), destination, { _request: async url => {
    visited.push(url.href);
    if (visited.length === 1) return response('', { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1?signature=fixture' }, 302);
    return response([binary.subarray(0, 5), binary.subarray(5, 129), binary.subarray(129)], { 'content-length': String(binary.length) });
  } });
  assert.deepEqual(result, { sha256: hash(binary), bytes: binary.length });
  assert.deepEqual(await fs.readFile(destination), binary); assert.equal(visited.length, 2);
});

test('download rejects unexpected URLs and redirects before requesting them', async t => {
  const directory = await fixture(t);
  for (const location of ['http://github.com/YMACP/Class/releases/download/v1.2.1/Class', 'https://api.github.com/repos/YMACP/Class/releases/assets/1',
    'https://evil.example/file', 'https://release-assets.githubusercontent.com.evil.example/file', 'https://user:pass@release-assets.githubusercontent.com/file',
    'https://release-assets.githubusercontent.com:444/file', 'https://github.com/other/Class/releases/download/v1.2.1/Class']) {
    let calls = 0; const destination = path.join(directory, 'rejected');
    await assert.rejects(downloadRelease(asset(), destination, { _request: async () => { calls++; return response('', { location }, 302); } }), { code: 'UPDATE_URL_BLOCKED' });
    assert.equal(calls, 1); await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  }
  let calls = 0;
  await assert.rejects(downloadRelease(asset(), path.join(directory, 'loop'), { _request: async url => { calls++; return response('', { location: url.href }, 302); } }), { code: 'UPDATE_REDIRECT_INVALID' });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(downloadRelease(asset(), path.join(directory, 'hops'), { _request: async () => response('', { location: 'https://release-assets.githubusercontent.com/asset?hop=' + calls++ }, 302) }), { code: 'UPDATE_REDIRECT_INVALID' });
  assert.equal(calls, 6);
});

test('hash, byte-length and executable-architecture failures remove only their own partial download', async t => {
  const directory = await fixture(t), valid = executable(), badElf = executable(), badPe = executable('win32');
  badElf.writeUInt16LE(183, 18); badPe.writeUInt16LE(0xaa64, 132);
  const cases = [
    [asset(), valid, { 'content-length': '513' }, 'UPDATE_SIZE_INVALID'],
    [asset(), valid.subarray(0, 500), {}, 'UPDATE_SIZE_INVALID'],
    [asset(), Buffer.concat([valid, Buffer.alloc(1)]), {}, 'UPDATE_SIZE_INVALID'],
    [asset('linux', valid, { digest: 'sha256:' + '0'.repeat(64) }), valid, {}, 'UPDATE_DIGEST_MISMATCH'],
    [asset('linux', badElf), badElf, {}, 'UPDATE_BINARY_INVALID'],
    [asset('win32', badPe), badPe, {}, 'UPDATE_BINARY_INVALID'],
    [asset('linux', Buffer.alloc(512)), Buffer.alloc(512), {}, 'UPDATE_BINARY_INVALID'],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [item, bytes, headers, code] = cases[i], destination = path.join(directory, 'partial-' + i);
    await assert.rejects(downloadRelease(item, destination, { _request: async () => response(bytes, headers) }), { code });
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  }
  const existing = path.join(directory, 'existing'); await fs.writeFile(existing, 'preserved existing file');
  await assert.rejects(downloadRelease(asset(), existing, { _request: async () => { throw Error('must not request'); } }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(existing, 'utf8'), 'preserved existing file');
});

test('cancelled download removes partial data, and metadata deadlines abort an unresponsive transport', { timeout: 5000 }, async t => {
  const directory = await fixture(t), destination = path.join(directory, 'cancelled'), controller = new AbortController();
  await assert.rejects(downloadRelease(asset(), destination, { signal: controller.signal, _request: async () => ({ statusCode: 200, headers: {}, body: (async function* () {
    yield executable().subarray(0, 100); controller.abort(Error('fixture stopped')); yield Buffer.alloc(10);
  })() }) }), /fixture stopped/);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await assert.rejects(checkRelease({ currentVersion: '1.2.0', platform: 'linux', arch: 'x64', timeoutMs: 1000,
    _request: (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }), { code: 'UPDATE_TIMEOUT' });
});

test('production transport honors HTTPS_PROXY with CONNECT while keeping credentials out of errors', { timeout: 5000 }, async t => {
  let connects = 0, authority, authorization;
  const proxy = http.createServer();
  proxy.on('connect', (request, socket) => {
    connects++; authority = request.url; authorization = request.headers['proxy-authorization'];
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const proxyEnv = { HTTPS_PROXY: `http://fixture-user:fixture-password@127.0.0.1:${proxy.address().port}` };
  await assert.rejects(checkRelease({ currentVersion: '1.2.0', platform: 'linux', arch: 'x64', proxyEnv }), error => {
    assert.equal(error.code, 'UPDATE_PROXY_FAILED'); assert.ok(!error.message.includes('fixture-password')); return true;
  });
  assert.equal(connects, 1); assert.equal(authority, 'api.github.com:443');
  assert.equal(authorization, 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64'));
});
