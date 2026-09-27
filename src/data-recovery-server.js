import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pickDirectory } from './directory-picker.js';
import { startupFailureMessage } from './startup-support.js';

const BODY_LIMIT = 65536;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validPath(value) { return typeof value === 'string' && value.length > 0 && value.length <= 32768 && !value.includes('\0') && path.isAbsolute(value); }
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, '请求必须使用 JSON 格式。');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > BODY_LIMIT) fail(413, '请求内容过长。'); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, '请求内容不是有效的 JSON。'); }
  if (!isObject(value)) fail(400, '请求内容必须为 JSON 对象。');
  return value;
}
function send(res, status, value, contentType = 'application/json; charset=utf-8') {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP });
  res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Class</title><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/recovery.css"><script src="/recovery.js" defer></script></head>
<body><main class="recovery-card"><header><span class="brand">Class</span><button id="recovery-exit" class="text-button" type="button" disabled>退出</button></header>
<h1>重新选择数据目录</h1><p class="intro">原数据目录可能已被移动、删除或无法访问。请选择要使用的数据目录，继续打开 Class。</p>
<dl class="unavailable"><dt>原数据目录</dt><dd id="recovery-requested">正在读取…</dd></dl><p id="recovery-reason" class="reason"></p>
<section aria-labelledby="existing-title"><h2 id="existing-title">选择数据目录</h2><p class="hint">可加载已有的 Class 配置和历史记录，也可选择空目录开始使用。</p><form id="recovery-form"><label for="recovery-path">数据目录路径</label><div class="path-row"><input id="recovery-path" type="text" spellcheck="false" autocomplete="off" maxlength="32768" placeholder="输入数据目录的完整路径" disabled><button id="recovery-browse" class="browse-button" type="button" title="浏览文件夹" aria-label="浏览文件夹" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M3 9h18"/></svg></button><button id="recovery-load" class="primary" type="submit" disabled>加载目录</button></div></form></section>
<section class="default-section" aria-labelledby="default-title"><div><h2 id="default-title">使用默认目录</h2><p class="hint">已有数据会直接加载；没有数据时会创建新的配置。</p><p id="recovery-default-path" class="directory"></p></div><button id="recovery-default" type="button" disabled>使用默认目录</button></section>
<p class="preserve-note">选择目录不会删除或覆盖其他目录中的数据。</p><p id="recovery-message" role="status" aria-live="polite">正在准备…</p>
</main></body></html>`;

const CSS = `:root{font-family:"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif;font-size:14px;color:#203c33;background:#f6f6f1;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px 20px}button,input{font:inherit}button{cursor:pointer;border:1px solid #dbe5d9;border-radius:8px;background:#f8faf4;color:#277759;padding:11px 16px;white-space:nowrap;min-height:44px}button:hover:not(:disabled){background:#edf3e8}button:disabled{opacity:.55;cursor:not-allowed}button:focus-visible,input:focus-visible{outline:3px solid #a6c4ab;outline-offset:2px}.recovery-card{width:min(720px,100%);padding:32px 36px;background:#fff;border:1px solid #e5e9e2;border-radius:16px;box-shadow:0 14px 45px #203c3308}header{display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{font-size:26px;font-weight:650;letter-spacing:-.5px;color:#163f32}.text-button{background:transparent;border:0;color:#7c8982;min-height:36px;padding:7px}.text-button:hover:not(:disabled){color:#b95043;background:#faf6f2}h1{font-size:26px;line-height:1.4;font-weight:650;margin:26px 0 12px}h2{font-size:16px;line-height:1.5;margin:0 0 8px;font-weight:600}.intro,.hint,.reason,.preserve-note{font-size:14px;line-height:1.8;color:#7c8982;margin:0}.unavailable{background:#f7f9f4;border:1px solid #e5e9e2;border-radius:8px;padding:13px 15px;margin:20px 0 8px}.unavailable dt{font-size:12px;color:#82917c;margin-bottom:5px}.unavailable dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap;line-height:1.7}.reason{color:#966c26;overflow-wrap:anywhere;white-space:pre-wrap;font-size:12px}section{margin-top:28px}label{display:block;font-size:12px;color:#72816f;margin:17px 0 8px}.path-row{display:flex;gap:8px;align-items:stretch}input{width:100%;min-width:0;border:1px solid #dfe5da;border-radius:8px;background:#fcfdf9;color:#203c33;padding:11px 12px;line-height:1.6}.browse-button{padding:10px;width:44px;flex-shrink:0;display:grid;place-items:center}svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.primary{background:#277759;border-color:#277759;color:#fff}.primary:hover:not(:disabled){background:#206448}.default-section{display:flex;align-items:center;gap:20px;justify-content:space-between;padding-top:24px;border-top:1px solid #e5e9e2}.default-section>div{min-width:0}.directory{overflow-wrap:anywhere;white-space:pre-wrap;font-size:12px;line-height:1.7;color:#72816f;margin:8px 0 0}.preserve-note{margin-top:25px;font-size:12px}#recovery-message{font-size:13px;line-height:1.8;margin:14px 0 0;min-height:24px;overflow-wrap:anywhere;white-space:pre-wrap;color:#277759}#recovery-message.error{color:#b95043}@media(max-width:580px){body{padding:16px 12px}.recovery-card{padding:24px 20px}h1{font-size:23px}.path-row{flex-wrap:wrap}.path-row input{flex:1}.path-row .primary{width:100%}.default-section{display:block}.default-section>button{margin-top:14px;width:100%}}`;

const SCRIPT = String.raw`'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const message = $('recovery-message');
  const controls = ['recovery-default', 'recovery-path', 'recovery-browse', 'recovery-load', 'recovery-exit'].map($);
  const fragment = new URLSearchParams(location.hash.slice(1));
  let token = fragment.get('token') || '', ready = false, busy = false, finished = false, defaultPath = '';
  try {
    token ||= sessionStorage.getItem('class-recovery-token') || '';
    if (token) sessionStorage.setItem('class-recovery-token', token);
  } catch {}
  if (fragment.has('token')) history.replaceState(null, '', location.pathname + location.search);
  function feedback(text, error = false) { message.textContent = text; message.classList.toggle('error', error); }
  function disable() { for (const control of controls) control.disabled = !ready || busy || finished; }
  async function api(route, body) {
    const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', credentials: 'omit', redirect: 'error' });
    let result;
    try { result = await response.json(); } catch { throw new Error('无法读取 Class 的响应，请重新打开 Class。'); }
    if (!response.ok) throw new Error(result.error || '操作未完成，请重试。');
    return result;
  }
  async function select(mode) {
    if (!ready || busy || finished) return;
    const selected = $('recovery-path').value;
    if (mode === 'existing' && !selected.trim()) { feedback('请输入数据目录的完整路径。', true); $('recovery-path').focus(); return; }
    busy = true; disable(); feedback('正在准备数据目录…');
    try {
      const result = await api('/api/recovery/select', { mode, ...(mode === 'existing' ? { path: selected } : {}) });
      const target = new URL(result.url);
      if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname) || target.username || target.password || !new URLSearchParams(target.hash.slice(1)).get('token')) throw new Error('Class 返回了无效的启动地址，请重新打开 Class。');
      feedback('目录已加载，正在打开 Class…'); finished = true;
      try { sessionStorage.removeItem('class-recovery-token'); } catch {}
      location.replace(target.href);
    } catch (error) { feedback(error.message || '目录加载失败，请检查后重试。', true); }
    finally { busy = false; disable(); }
  }
  $('recovery-default').addEventListener('click', () => select('default'));
  $('recovery-form').addEventListener('submit', event => { event.preventDefault(); select('existing'); });
  $('recovery-browse').addEventListener('click', async () => {
    if (!ready || busy || finished) return;
    busy = true; disable(); feedback('请选择数据目录…');
    try {
      const value = $('recovery-path').value;
      const absolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\');
      const result = await api('/api/directories/pick', { initialPath: absolute ? value : defaultPath });
      if (!result.cancelled) $('recovery-path').value = result.path;
      feedback(result.cancelled ? '' : '已选择目录，点击“加载目录”继续。');
    } catch (error) { feedback((error.message || '无法打开目录选择窗口。') + '\n也可以直接输入完整路径。', true); }
    finally { busy = false; disable(); }
  });
  $('recovery-exit').addEventListener('click', async () => {
    if (!ready || busy || finished) return;
    busy = true; disable(); feedback('正在退出…');
    try { await api('/api/shutdown', {}); finished = true; feedback('Class 已退出，可以关闭此页面。'); }
    catch (error) { feedback(error.message || '退出失败，请重试。', true); }
    finally { busy = false; disable(); }
  });
  (async () => {
    try {
      if (!token) throw new Error('此页面缺少访问凭据，请重新运行 Class 打开恢复页面。');
      const state = await api('/api/state');
      if (state.mode !== 'data-recovery') throw new Error('恢复页面已失效，请重新打开 Class。');
      const recovery = state.recovery;
      $('recovery-requested').textContent = recovery.requestedPath || '未指定';
      $('recovery-reason').textContent = recovery.reason || '';
      $('recovery-default-path').textContent = defaultPath = recovery.defaultPath;
      $('recovery-path').value = recovery.requestedPath || '';
      ready = true; feedback(''); disable();
    } catch (error) { feedback(error.message || '无法连接 Class，请重新打开。', true); }
  })();
})();`;

/** A small recovery host: it never opens, initializes, copies, or migrates a profile. */
export async function createDataRecoveryServer({ token, requestedPath, defaultPath, reason, onSelect, onShutdown, directoryPicker = pickDirectory, assets = {} } = {}) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('A random local access token of at least 24 characters is required');
  if (!validPath(defaultPath)) throw new Error('defaultPath must be an absolute path');
  if (requestedPath !== undefined && typeof requestedPath !== 'string') throw new Error('requestedPath must be text');
  if (typeof onSelect !== 'function' || typeof onShutdown !== 'function' || typeof directoryPicker !== 'function') throw new Error('Recovery callbacks must be functions');
  const safe = error => startupFailureMessage(typeof error === 'string' ? new Error(error) : error).split(token).join('[REDACTED]');
  const state = { mode: 'data-recovery', recovery: { requestedPath: requestedPath || '', defaultPath, reason: safe(reason) } };
  let closing = false, closePromise, chooser, selecting = false, selectedResult, mutations = Promise.resolve();
  function serial(operation) {
    const result = mutations.then(operation);
    mutations = result.catch(() => {});
    return result;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes((req.headers.host || '').toLowerCase())) fail(403, 'Invalid local Host');
      if (req.headers.origin && ![ `http://127.0.0.1:${port}`, `http://localhost:${port}` ].includes(req.headers.origin)) fail(403, 'Cross-origin access is not allowed');
      if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site access is not allowed');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname === '/health' && req.method === 'GET') { send(res, 200, { app: 'class', mode: 'data-recovery' }); return; }
      if (url.pathname.startsWith('/api/')) {
        const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(401, '本地访问凭据无效，请重新打开 Class。');
        if (closing) fail(503, 'Class 正在退出。');
        if (url.pathname === '/api/state' && req.method === 'GET') { send(res, 200, state); return; }
        if (url.pathname === '/api/recovery/select' && req.method === 'POST') {
          const body = await readBody(req);
          if (Object.keys(body).some(key => !['mode', 'path'].includes(key)) || !['default', 'existing'].includes(body.mode)) fail(400, '请选择默认目录或其他数据目录。');
          if (body.mode === 'default' && body.path !== undefined) fail(400, '使用默认目录时不接受其他路径。');
          if (body.mode === 'existing' && !validPath(body.path)) fail(400, '请输入数据目录的完整路径。');
          const result = await serial(async () => {
            if (closing) fail(503, 'Class 正在退出。');
            if (selectedResult) return selectedResult;
            if (chooser) fail(409, '请先完成目录选择。');
            selecting = true;
            try {
              const selected = await onSelect({ mode: body.mode, ...(body.mode === 'existing' ? { path: body.path } : {}) });
              let address;
              try { address = new URL(selected?.url); } catch { fail(500, 'Class 返回了无效的启动地址。'); }
              if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(address.hostname) || address.username || address.password || !new URLSearchParams(address.hash.slice(1)).get('token')) fail(500, 'Class 返回了无效的启动地址。');
              selectedResult = { url: address.href };
              return selectedResult;
            } finally { selecting = false; }
          });
          send(res, 200, result); return;
        }
        if (url.pathname === '/api/directories/pick' && req.method === 'POST') {
          const body = await readBody(req);
          if (Object.keys(body).some(key => key !== 'initialPath') || (body.initialPath !== undefined && !validPath(body.initialPath))) fail(400, '目录选择起始路径无效。');
          if (closing) fail(503, 'Class 正在退出。');
          if (chooser || selecting || selectedResult) fail(409, '请先完成当前目录操作。');
          const controller = new AbortController(), pending = { controller, promise: null };
          const disconnected = () => controller.abort(new Error('Directory selection cancelled'));
          chooser = pending; res.once('close', disconnected);
          try {
            pending.promise = Promise.resolve().then(() => directoryPicker({ initialPath: body.initialPath ?? defaultPath, signal: controller.signal }));
            const selected = await pending.promise;
            if (controller.signal.aborted || selected?.cancelled === true) send(res, 200, { cancelled: true });
            else {
              if (selected?.cancelled !== false || !validPath(selected.path)) fail(500, '目录选择窗口返回了无效路径。');
              send(res, 200, { cancelled: false, path: selected.path });
            }
          } finally { if (chooser === pending) chooser = null; res.off('close', disconnected); }
          return;
        }
        if (url.pathname === '/api/shutdown' && req.method === 'POST') {
          req.resume(); closing = true; chooser?.controller.abort(new Error('Application shutdown'));
          res.once('finish', () => { setImmediate(() => { Promise.resolve().then(onShutdown).catch(() => {}); }); });
          send(res, 202, { ok: true, readyToExit: true }); return;
        }
        fail(404, '接口不存在。');
      }
      if (req.method === 'GET') {
        if (url.pathname === '/' || url.pathname === '/index.html') { send(res, 200, HTML, 'text/html; charset=utf-8'); return; }
        if (url.pathname === '/recovery.js') { send(res, 200, SCRIPT, 'text/javascript; charset=utf-8'); return; }
        if (url.pathname === '/recovery.css') { send(res, 200, CSS, 'text/css; charset=utf-8'); return; }
        if (url.pathname === '/favicon.ico' && Object.hasOwn(assets, '/favicon.ico')) { const asset = assets['/favicon.ico']; send(res, 200, asset.body, asset.contentType || 'image/x-icon'); return; }
      }
      fail(404, 'Not found');
    } catch (error) {
      req.resume();
      if (res.headersSent) { res.destroy(); return; }
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      send(res, status, { error: safe(error) });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  function close() {
    if (closePromise) return closePromise;
    closing = true; chooser?.controller.abort(new Error('Application shutdown'));
    closePromise = (async () => {
      await mutations; await chooser?.promise?.catch(() => {});
      if (server.listening) await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections?.(); });
    })();
    return closePromise;
  }
  return { url: `http://127.0.0.1:${server.address().port}`, close };
}
