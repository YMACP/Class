import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { createHash } from 'node:crypto';

const API = 'https://api.github.com/repos/YMACP/Class/releases/latest';
const DOWNLOAD_PREFIX = '/YMACP/Class/releases/download/';
const CDN_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const fail = (code, message) => Object.assign(new Error(message), { code });

function versionOf(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw fail('UPDATE_VERSION_INVALID', 'Expected a stable numeric major.minor.patch version');
  }
  const version = value.replace(/^v/, '');
  return { version, parts: version.split('.').map(BigInt) };
}
function newer(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}
function targetOf(platform, arch) {
  if (!['win32', 'linux'].includes(platform) || arch !== 'x64') throw fail('UPDATE_PLATFORM_UNSUPPORTED', 'Automatic releases support Windows x64 and Linux amd64 only');
  return { platform, arch };
}
function matchingName(name, platform) {
  if (typeof name !== 'string' || !name || name.length > 160 || /[\\/\x00-\x1f]/.test(name)) return false;
  if (platform === 'win32' && name === 'Class.exe') return true;
  if (platform === 'linux' && name === 'Class') return true;
  const compact = name.toLowerCase().replace(/[-_]/g, '');
  return platform === 'win32' ? /^class(?:win|win32|windows)(?:x64|amd64)\.exe$/.test(compact)
    : /^classlinux(?:x64|amd64)(?:\.bin)?$/.test(compact);
}
function checkedURL(value, kind, asset) {
  let url;
  try { url = new URL(value); } catch { throw fail('UPDATE_URL_BLOCKED', 'Invalid official release URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw fail('UPDATE_URL_BLOCKED', 'Official releases require credential-free HTTPS URLs');
  }
  if (kind === 'api') {
    if (url.href !== API) throw fail('UPDATE_URL_BLOCKED', 'Only the fixed official release API is allowed');
  } else if (url.hostname === 'github.com') {
    const expected = DOWNLOAD_PREFIX + encodeURIComponent(asset.tag) + '/' + encodeURIComponent(asset.name);
    if (url.pathname !== expected || url.search) throw fail('UPDATE_URL_BLOCKED', 'Only this official repository release asset is allowed');
  } else if (kind !== 'redirect' || !CDN_HOSTS.has(url.hostname)) {
    throw fail('UPDATE_URL_BLOCKED', 'Release redirect host is not trusted');
  }
  return url;
}
function checkedAsset(asset) {
  if (!asset || typeof asset !== 'object') throw fail('UPDATE_ASSET_INVALID', 'Missing release asset');
  targetOf(asset.platform, asset.arch);
  if (!matchingName(asset.name, asset.platform) || versionOf(asset.tag).version !== versionOf(asset.version).version
    || !Number.isSafeInteger(asset.size) || asset.size < 64 || asset.size > MAX_ASSET_BYTES) {
    throw fail('UPDATE_ASSET_INVALID', 'Invalid release asset name, version or size');
  }
  if (asset.digest !== null && asset.digest !== undefined && (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest))) {
    throw fail('UPDATE_DIGEST_INVALID', 'Release digest must be a SHA-256 checksum');
  }
  checkedURL(asset.url, 'asset', asset);
  return { ...asset, digest: asset.digest?.toLowerCase() ?? null };
}
function proxyFor(hostname, env) {
  const noProxy = String(env.no_proxy ?? env.NO_PROXY ?? '');
  for (const token of noProxy.split(/[,\s]+/).filter(Boolean)) {
    if (token === '*') return null;
    const match = /^(.*?)(?::(\d+))?$/.exec(token.toLowerCase()), host = match[1].replace(/^\*?\./, '').replace(/\.$/, '');
    if (match[2] && match[2] !== '443') continue;
    if (hostname === host || (/^(?:\*\.|\.)/.test(token) && hostname.endsWith('.' + host))) return null;
  }
  const configured = env.https_proxy ?? env.HTTPS_PROXY;
  if (!configured) return null;
  let url, authorization;
  try {
    url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw Error();
    if (url.username || url.password) authorization = 'Basic ' + Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64');
  } catch { throw fail('UPDATE_PROXY_INVALID', 'The configured HTTPS proxy is invalid'); }
  return { url, authorization };
}
function tunnel(proxy, target, signal) {
  return new Promise((resolve, reject) => {
    let request, socket, secure, settled = false;
    const finish = (error, value) => {
      if (settled) { if (value) value.destroy(); return; }
      settled = true; signal.removeEventListener('abort', abort);
      if (error) { secure?.destroy(); socket?.destroy(); request?.destroy(); reject(error); } else resolve(value);
    };
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : fail('UPDATE_CANCELLED', 'Release request cancelled'));
    const authority = target.hostname + ':443';
    request = (proxy.url.protocol === 'https:' ? https : http).request({ hostname: proxy.url.hostname, port: proxy.url.port || (proxy.url.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: authority, agent: false, headers: { host: authority, ...(proxy.authorization ? { 'proxy-authorization': proxy.authorization } : {}) } });
    request.on('error', () => finish(fail('UPDATE_PROXY_FAILED', 'Could not connect to the configured HTTPS proxy')));
    request.once('response', response => { response.destroy(); finish(fail('UPDATE_PROXY_FAILED', 'The configured proxy rejected CONNECT')); });
    request.once('connect', (response, connected, head) => {
      socket = connected; socket.on('error', () => finish(fail('UPDATE_PROXY_FAILED', 'Release proxy tunnel failed')));
      if (response.statusCode !== 200 || head.length) { finish(fail('UPDATE_PROXY_FAILED', 'The configured proxy rejected the release tunnel')); return; }
      secure = tls.connect({ socket, host: target.hostname, servername: target.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
      secure.once('secureConnect', () => finish(null, secure));
      secure.on('error', () => finish(fail('UPDATE_TLS_FAILED', 'Official release TLS verification or handshake failed')));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else request.end();
  });
}
async function requestOfficial(url, { signal, proxyEnv }) {
  const proxy = proxyFor(url.hostname, proxyEnv);
  let agent;
  if (proxy) {
    agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => { tunnel(proxy, url, signal).then(socket => callback(null, socket), callback); };
  }
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'GET', agent: agent || false, signal,
      headers: { 'user-agent': 'Class-release-updater', accept: url.href === API ? 'application/vnd.github+json' : 'application/octet-stream',
        'accept-encoding': 'identity', ...(url.href === API ? { 'x-github-api-version': '2022-11-28' } : {}) } });
    request.once('error', error => { agent?.destroy(); reject(error); });
    request.once('response', response => {
      response.once('close', () => agent?.destroy());
      resolve({ statusCode: response.statusCode || 0, headers: response.headers, body: response, destroy: () => { response.destroy(); request.destroy(); agent?.destroy(); } });
    });
    request.end();
  });
}
function operation(signal, timeoutMs, defaultMs) {
  const ms = timeoutMs ?? defaultMs;
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 600000) throw fail('UPDATE_TIMEOUT_INVALID', 'Release timeout must be between 1000 and 600000 ms');
  signal?.throwIfAborted();
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(fail('UPDATE_TIMEOUT', 'Official release operation timed out')), ms);
  return { signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal, close: () => clearTimeout(timer) };
}
function header(response, name) {
  const value = response.headers?.get ? response.headers.get(name) : response.headers?.[name];
  return Array.isArray(value) ? value.join(',') : value;
}
function declaredLength(response, maximum) {
  const encoding = header(response, 'content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw fail('UPDATE_ENCODING_UNSUPPORTED', 'Encoded release responses are not supported');
  const value = header(response, 'content-length');
  if (value === undefined || value === null) return null;
  if (!/^\d+$/.test(String(value))) throw fail('UPDATE_SIZE_INVALID', 'Invalid release Content-Length');
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes > maximum) throw fail('UPDATE_SIZE_INVALID', 'Release response exceeds its size limit');
  return bytes;
}
async function openResponse(input, { kind, asset, signal, proxyEnv, _request = requestOfficial }) {
  let url = checkedURL(input, kind, asset);
  const visited = new Set();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    signal.throwIfAborted();
    if (visited.has(url.href)) throw fail('UPDATE_REDIRECT_INVALID', 'Official release redirect loop');
    visited.add(url.href);
    const response = await _request(url, { signal, proxyEnv });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = header(response, 'location'); response.destroy?.();
      if (hop === MAX_REDIRECTS || typeof location !== 'string') throw fail('UPDATE_REDIRECT_INVALID', 'Invalid or excessive release redirects');
      let next;
      try { next = new URL(location, url).href; } catch { throw fail('UPDATE_REDIRECT_INVALID', 'Invalid release redirect target'); }
      url = checkedURL(next, kind === 'api' ? 'api' : 'redirect', asset);
      continue;
    }
    if (response.statusCode !== 200) {
      const limited = response.statusCode === 429 || (response.statusCode === 403 && String(header(response, 'x-ratelimit-remaining')) === '0');
      const error = fail(limited ? 'UPDATE_RATE_LIMITED' : 'UPDATE_HTTP_ERROR', limited
        ? 'GitHub release requests are temporarily rate limited; try again later'
        : `Official release request failed (HTTP ${response.statusCode})`);
      error.statusCode = response.statusCode;
      const reset = Number(header(response, 'x-ratelimit-reset'));
      if (limited && Number.isSafeInteger(reset) && reset > 0 && reset <= 253402300799) error.retryAt = new Date(reset * 1000).toISOString();
      response.destroy?.(); throw error;
    }
    return response;
  }
}

// _request is an isolated-test transport seam, never a setting or model/API
// parameter. URLs are checked before every injected or production request.
export async function checkRelease({ currentVersion, platform = process.platform, arch = process.arch, signal, timeoutMs, proxyEnv = process.env, _request } = {}) {
  const current = versionOf(currentVersion), target = targetOf(platform, arch), active = operation(signal, timeoutMs, 15000);
  let response;
  try {
    response = await openResponse(API, { kind: 'api', signal: active.signal, proxyEnv, _request });
    const length = declaredLength(response, MAX_METADATA_BYTES), chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      active.signal.throwIfAborted(); const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > MAX_METADATA_BYTES) throw fail('UPDATE_SIZE_INVALID', 'Release metadata exceeds its size limit');
      chunks.push(buffer);
    }
    active.signal.throwIfAborted();
    if (length !== null && bytes !== length) throw fail('UPDATE_SIZE_INVALID', 'Release metadata length does not match');
    let release;
    try { release = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('UPDATE_RELEASE_INVALID', 'Official release metadata is not valid JSON'); }
    if (!release || typeof release !== 'object' || Array.isArray(release) || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') {
      throw fail('UPDATE_RELEASE_INVALID', 'Official release metadata is incomplete');
    }
    if (release.draft || release.prerelease) return { available: false, currentVersion: current.version, reason: 'unstable_release' };
    const latest = versionOf(release.tag_name);
    const result = { available: false, currentVersion: current.version, version: latest.version, tag: release.tag_name,
      releaseUrl: 'https://github.com/YMACP/Class/releases/tag/' + encodeURIComponent(release.tag_name),
      publishedAt: typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)) ? release.published_at : null };
    if (!newer(latest.parts, current.parts)) return { ...result, reason: 'up_to_date' };
    if (!Array.isArray(release.assets)) throw fail('UPDATE_RELEASE_INVALID', 'Official release assets are missing');
    const candidates = release.assets.filter(asset => matchingName(asset?.name, platform));
    const canonical = candidates.filter(asset => asset.name === (platform === 'win32' ? 'Class.exe' : 'Class'));
    const selected = canonical.length ? canonical : candidates;
    if (!selected.length) return { ...result, reason: 'asset_unavailable' };
    if (selected.length !== 1) throw fail('UPDATE_ASSET_AMBIGUOUS', 'More than one official release asset matches this platform');
    const item = selected[0], asset = checkedAsset({ name: item.name, url: item.browser_download_url, size: item.size,
      digest: item.digest ?? null, version: latest.version, tag: release.tag_name, ...target });
    return { ...result, available: true, asset };
  } catch (error) { if (active.signal.aborted) throw active.signal.reason; throw error; }
  finally { response?.destroy?.(); active.close(); }
}

async function verifyBinary(file, bytes, platform) {
  const head = Buffer.alloc(64), { bytesRead } = await file.read(head, 0, head.length, 0);
  if (bytesRead !== head.length) throw fail('UPDATE_BINARY_INVALID', 'Release executable header is incomplete');
  if (platform === 'linux') {
    if (head.subarray(0, 4).toString('hex') !== '7f454c46' || head[4] !== 2 || head[5] !== 1 || head[6] !== 1
      || ![2, 3].includes(head.readUInt16LE(16)) || head.readUInt16LE(18) !== 62 || head.readUInt16LE(52) !== 64) {
      throw fail('UPDATE_BINARY_INVALID', 'Release is not a Linux amd64 ELF executable');
    }
  } else {
    const offset = head.readUInt32LE(60);
    if (head.toString('ascii', 0, 2) !== 'MZ' || offset < 64 || offset > bytes - 26) throw fail('UPDATE_BINARY_INVALID', 'Release is not a Windows x64 PE executable');
    const pe = Buffer.alloc(26), read = await file.read(pe, 0, pe.length, offset);
    if (read.bytesRead !== pe.length || pe.subarray(0, 4).toString('hex') !== '50450000' || pe.readUInt16LE(4) !== 0x8664
      || pe.readUInt16LE(24) !== 0x20b || !(pe.readUInt16LE(22) & 2) || (pe.readUInt16LE(22) & 0x2000)) {
      throw fail('UPDATE_BINARY_INVALID', 'Release is not a Windows x64 PE executable');
    }
  }
}

export async function downloadRelease(input, destination, { signal, timeoutMs, proxyEnv = process.env, _request } = {}) {
  const asset = checkedAsset(input);
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw fail('UPDATE_DESTINATION_INVALID', 'Release destination must be an absolute exclusive temporary path');
  const parent = await fs.lstat(path.dirname(destination));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw fail('UPDATE_DESTINATION_INVALID', 'Release destination parent must be an owned directory');
  const active = operation(signal, timeoutMs, 300000);
  let response, file, identity, complete = false;
  try {
    file = await fs.open(destination, 'wx+', 0o600); identity = await file.stat();
    response = await openResponse(asset.url, { kind: 'asset', asset, signal: active.signal, proxyEnv, _request });
    const length = declaredLength(response, MAX_ASSET_BYTES);
    if (length !== null && length !== asset.size) throw fail('UPDATE_SIZE_INVALID', 'Release Content-Length does not match its published asset size');
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of response.body) {
      active.signal.throwIfAborted(); const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > asset.size || bytes > MAX_ASSET_BYTES) throw fail('UPDATE_SIZE_INVALID', 'Release download exceeds its published asset size');
      hash.update(buffer);
      let offset = 0;
      while (offset < buffer.length) {
        active.signal.throwIfAborted();
        const written = await file.write(buffer, offset, buffer.length - offset);
        if (!written.bytesWritten) throw fail('UPDATE_WRITE_FAILED', 'Release download could not be written completely');
        offset += written.bytesWritten;
      }
    }
    active.signal.throwIfAborted();
    if (bytes !== asset.size) throw fail('UPDATE_SIZE_INVALID', 'Release download length does not match its published asset size');
    const sha256 = hash.digest('hex');
    if (asset.digest && asset.digest !== 'sha256:' + sha256) throw fail('UPDATE_DIGEST_MISMATCH', 'Release download does not match its published SHA-256 checksum');
    await verifyBinary(file, bytes, asset.platform);
    await file.sync(); await file.close(); file = undefined;
    active.signal.throwIfAborted(); complete = true;
    return { sha256, bytes };
  } catch (error) { if (active.signal.aborted) throw active.signal.reason; throw error; }
  finally {
    response?.destroy?.(); active.close(); await file?.close();
    if (!complete && identity) {
      const current = await fs.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (current && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await fs.unlink(destination);
    }
  }
}
