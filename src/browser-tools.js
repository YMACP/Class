import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { boundedJson } from './tool-output.js';
import { FirefoxConnection } from './firefox-browser.js';

const ACTIONS = ['open', 'navigate', 'tabs', 'snapshot', 'click', 'fill', 'press', 'scroll', 'screenshot', 'close'];
export const browserToolDefinitions = [{
  name: 'browser',
  description: 'Operate your own isolated headless installed browser: Edge/Chrome/Firefox on Windows, Chrome/Firefox on Linux (Chromium also supported). Firefox requires version 149 or newer. open creates a tab; navigate loads an HTTP(S) URL; tabs lists tabs; snapshot reads main-frame text and interactive element refs; click/fill accept a snapshot ref or CSS selector; press sends a key (e.g. Enter, Control+A); scroll moves the page; screenshot returns a PNG; close closes a tab (all=true closes your browser). Refs expire on navigation or the next snapshot. Browser processes use a fresh temporary profile, never your existing browser. Browser activity pauses with the task. No arbitrary JavaScript execution is exposed.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ACTIONS },
    url: { type: 'string', minLength: 1, description: 'HTTP(S) URL; open defaults to about:blank.' },
    tabId: { type: 'string', minLength: 1, description: 'A tab from your own browser; defaults to the last used tab.' },
    ref: { type: 'string', minLength: 1, description: 'Element ref from the latest snapshot.' },
    selector: { type: 'string', minLength: 1, description: 'CSS selector instead of ref.' },
    text: { type: 'string', description: 'Text for fill, including empty text to clear.' },
    key: { type: 'string', minLength: 1, description: 'Key or modifier combination for press.' },
    x: { type: 'number', minimum: -10000, maximum: 10000, description: 'Horizontal scroll distance in CSS pixels.' },
    y: { type: 'number', minimum: -10000, maximum: 10000, description: 'Vertical scroll distance in CSS pixels; default 600.' },
    all: { type: 'boolean', description: 'For close, close all your tabs and remove the temporary profile.' },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 120000, description: 'Active execution timeout; excludes task pause. Default 30000.' },
  } },
}];

const cancelled = signal => signal?.reason instanceof Error ? signal.reason : new Error('Browser operation cancelled');
const alive = child => child && child.exitCode === null && child.signalCode === null;
const textArg = (args, key) => { if (typeof args[key] !== 'string' || !args[key].trim()) throw new Error(`browser.${key} must be a nonempty string`); return args[key]; };

function browserUrl(value) {
  if (value === 'about:blank') return value;
  if (typeof value !== 'string' || value.length > 16384) throw new Error('browser.url must be an HTTP(S) URL');
  let url;
  try { url = new URL(value); } catch { throw new Error('browser.url must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('browser only accepts HTTP(S) URLs without embedded credentials');
  return url.href;
}

/** Detection checks executables only; it never opens a user's browser profile. */
export async function findBrowserExecutable(explicit = process.env.CLASS_BROWSER_EXECUTABLE) {
  return (await findBrowser(explicit)).executable;
}

async function findBrowser(explicit = process.env.CLASS_BROWSER_EXECUTABLE) {
  const candidates = [];
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('CLASS_BROWSER_EXECUTABLE must be an absolute executable path');
    candidates.push(explicit);
  } else if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(root, 'Mozilla Firefox', 'firefox.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Firefox.app/Contents/MacOS/firefox');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome',
      '/usr/bin/firefox', '/usr/bin/firefox-esr', '/snap/bin/firefox', '/opt/firefox/firefox');
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      const real = await fs.realpath(candidate);
      // Snap launchers use argv[0] to select the application. Resolving
      // /snap/bin/firefox to /usr/bin/snap would launch the wrong program.
      const executable = process.platform === 'win32' ? real : candidate;
      const browserType = /firefox/i.test(path.basename(candidate)) || /firefox/i.test(path.basename(real)) ? 'firefox' : 'chromium';
      return { executable, browserType };
    } catch { /* Try the next installation. */ }
  }
  throw new Error('No supported browser found. Install Edge/Chrome/Firefox on Windows or Chrome/Firefox on Linux, or set CLASS_BROWSER_EXECUTABLE to its absolute path. Firefox requires version 149 or newer.');
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(), ms);
    const abort = () => finish(cancelled(signal));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function bounded(promise, ms, description) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), ms); })]).finally(() => clearTimeout(timer));
}

export class CdpConnection {
  constructor(socket, protocol = 'cdp') {
    this.protocol = protocol;
    this.socket = socket; this.nextId = 0; this.pending = new Map(); this.closed = false;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString()); } catch { this.close(new Error('Invalid browser protocol message')); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); pending.cleanup();
      if (message.error) pending.reject(Object.assign(new Error(`Browser ${pending.method}: ${protocol === 'bidi' ? message.message || message.error : message.error.message}`), {
        // Invalid parameters / unknown method are pre-dispatch rejections. Other
        // server errors (e.g. evaluation termination) can follow partial effects.
        browserRequestState: (protocol === 'bidi' ? ['invalid argument', 'unknown command'].includes(message.error) : [-32601, -32602].includes(message.error.code)) ? 'rejected' : 'uncertain',
      }));
      else pending.resolve(message.result || {});
    });
    socket.addEventListener('close', () => this.close(new Error('Browser connection closed')));
    socket.addEventListener('error', () => this.close(new Error('Browser connection failed')));
  }
  static async connect(url, signal, protocol = 'cdp') {
    signal.throwIfAborted();
    const socket = new WebSocket(url);
    const connection = new CdpConnection(socket, protocol);
    await new Promise((resolve, reject) => {
      const cleanup = () => { socket.removeEventListener('open', open); socket.removeEventListener('error', error); socket.removeEventListener('close', error); signal.removeEventListener('abort', abort); };
      const open = () => { cleanup(); resolve(); };
      const error = () => { cleanup(); connection.close(); reject(new Error('Could not connect to the owned browser')); };
      const abort = () => { cleanup(); connection.close(); reject(cancelled(signal)); };
      socket.addEventListener('open', open, { once: true }); socket.addEventListener('error', error, { once: true }); socket.addEventListener('close', error, { once: true }); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    return connection;
  }
  send(method, params = {}, sessionId, signal, onSent) {
    if (this.closed) return Promise.reject(new Error('Browser connection closed'));
    signal?.throwIfAborted();
    // WebSocket silently discards send() in CLOSING/CLOSED. Such a request was
    // never sent and must not be classified as an ambiguous browser action.
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Browser connection is not open'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const abort = () => { this.pending.delete(id); cleanup(); reject(cancelled(signal)); };
      this.pending.set(id, { method, resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId && this.protocol === 'cdp' ? { sessionId } : {}) })); onSent?.(); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  close(error = new Error('Browser connection closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    try { this.socket.close(); } catch { /* Already closed. */ }
  }
}

/** One owned process/profile per student. ToolManager owns process-tree control;
 * this module owns browser protocols, active-time deadlines and profile cleanup. */
export class BrowserTools {
  constructor(manager) {
    this.manager = manager; this.options = manager.browserOptions || {};
    this.sessions = new Map(); this.queues = new Map(); this.profiles = new Set();
    this.events = new EventEmitter(); this.events.setMaxListeners(0);
    this.controller = new AbortController(); this.paused = false; this.stopped = false;
    this.effects = new WeakMap();
  }
  _signal(signal) { return AbortSignal.any([this.controller.signal, ...(this.manager.controller?.signal ? [this.manager.controller.signal] : []), ...(signal ? [signal] : [])]); }
  async _checkpoint(signal) {
    while (this.paused) {
      signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        const clean = () => { this.events.off('change', change); signal.removeEventListener('abort', abort); };
        const change = () => { clean(); resolve(); };
        const abort = () => { clean(); reject(cancelled(signal)); };
        this.events.once('change', change); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    await this.manager.checkpoint(signal); signal.throwIfAborted();
  }
  _activeTimer(ms, expire) {
    let remaining = ms, timer, started;
    const update = () => {
      clearTimeout(timer);
      if (started !== undefined) remaining -= performance.now() - started;
      started = undefined;
      if (!this.paused) { started = performance.now(); timer = setTimeout(expire, Math.max(0, remaining)); }
    };
    this.events.on('change', update); update();
    return () => { clearTimeout(timer); this.events.off('change', update); };
  }
  execute(studentId, name, args = {}, signal) {
    if (name !== 'browser') return Promise.reject(new Error(`Unknown browser tool: ${name}`));
    if (typeof studentId !== 'string' || !studentId) return Promise.reject(new Error('browser requires a studentId'));
    const combined = this._signal(signal);
    const previous = this.queues.get(studentId) || Promise.resolve();
    const execution = previous.catch(() => {}).then(() => this._execute(studentId, args, combined));
    this.queues.set(studentId, execution);
    execution.finally(() => { if (this.queues.get(studentId) === execution) this.queues.delete(studentId); }).catch(() => {});
    return execution;
  }
  async _execute(studentId, args, externalSignal) {
    if (!args || typeof args !== 'object' || !ACTIONS.includes(args.action)) throw new Error('Invalid browser.action');
    if (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 100 || args.timeoutMs > 120000)) throw new Error('browser.timeoutMs must be between 100 and 120000');
    if (args.url !== undefined) browserUrl(args.url);
    if (args.action === 'navigate') browserUrl(textArg(args, 'url'));
    if (['click', 'fill'].includes(args.action)) {
      if (!!args.ref === !!args.selector) throw new Error('browser click/fill requires exactly one ref or selector');
      textArg(args, args.ref ? 'ref' : 'selector');
      if (args.ref && !/^e\d+$/.test(args.ref)) throw new Error('Invalid browser.ref');
      if (args.action === 'fill' && typeof args.text !== 'string') throw new Error('browser.fill requires text');
    }
    if (args.action === 'press') keySpec(textArg(args, 'key'));
    for (const key of ['x', 'y']) if (args[key] !== undefined && (!Number.isFinite(args[key]) || Math.abs(args[key]) > 10000)) throw new Error(`Invalid browser.${key}`);
    await this._checkpoint(externalSignal);
    const timeout = new AbortController();
    const signal = AbortSignal.any([externalSignal, timeout.signal]);
    const effects = { mutating: !['tabs', 'snapshot', 'screenshot'].includes(args.action), pending: 0, confirmed: 0 };
    this.effects.set(signal, effects);
    const cancelTimer = this._activeTimer(args.timeoutMs ?? this.options.timeoutMs ?? 30000, () => timeout.abort(new Error('Browser operation timed out; its isolated browser was closed.')));
    try {
      if (args.action === 'close' && args.all) { await this._closeSession(studentId); return this._result({ action: 'close', closed: 'all' }); }
      const session = await this._session(studentId, signal);
      if (args.action === 'tabs') return this._result({ tabs: await this._tabs(session, signal), activeTabId: session.activeTabId });
      const page = args.action === 'open' ? await this._newPage(session, signal) : await this._page(session, args.tabId, signal);
      const command = (method, params, effect = false) => this._command(session, method, params, page.sessionId, signal, effect);
      if (args.action === 'close') {
        const { success } = await this._command(session, 'Target.closeTarget', { targetId: page.targetId }, undefined, signal, result => result.success === true);
        session.pages.delete(page.targetId); if (session.activeTabId === page.targetId) session.activeTabId = undefined;
        return this._result({ action: 'close', tabId: page.targetId, success });
      }
      if (args.action === 'open' || args.action === 'navigate') {
        const result = await command('Page.navigate', { url: browserUrl(args.url ?? 'about:blank') }, result => !result.errorText);
        if (result.errorText) throw new Error(`Browser navigation failed: ${result.errorText}`);
        await this._ready(session, page, signal);
        return this._result({ tabId: page.targetId, ...await this._evaluate(session, page, '({url:location.href,title:document.title})', signal) });
      }
      if (args.action === 'snapshot') {
        await this._ready(session, page, signal);
        const maxText = Math.min(16000, Math.max(128, Math.floor((this.manager.maxOutputBytes || 65536) / 3)));
        const key = JSON.stringify(session.refKey);
        const value = await this._evaluate(session, page, `(() => {
          const refs = new Map(); globalThis[Symbol.for(${key})] = refs;
          const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],[tabindex]')].filter(el => { const r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(el).visibility!=='hidden'; });
          const elements = nodes.slice(0,100).map((el,i) => { const ref='e'+(i+1); refs.set(ref,el); return {ref,tag:el.tagName.toLowerCase(),role:el.getAttribute('role')||undefined,label:(el.getAttribute('aria-label')||el.innerText||el.getAttribute('placeholder')||el.getAttribute('name')||'').slice(0,160),value:el.type==='password'?'[password]':typeof el.value==='string'?el.value.slice(0,160):undefined}; });
          const text=document.body?.innerText||'';
          return {url:location.href,title:document.title,text:text.slice(0,${maxText}),elements,truncated:text.length>${maxText}||nodes.length>100};
        })()`, signal);
        return this._result({ tabId: page.targetId, ...value });
      }
      if (args.action === 'click' || args.action === 'fill') {
        const lookup = args.ref ? `globalThis[Symbol.for(${JSON.stringify(session.refKey)})]?.get(${JSON.stringify(args.ref)})` : `document.querySelector(${JSON.stringify(args.selector)})`;
        if (args.action === 'click') {
          const point = await this._evaluate(session, page, `(() => { const el=${lookup}; if(!el||!el.isConnected)throw new Error('Element not found; take a new snapshot'); const before=el.getBoundingClientRect(); if(!before.width||!before.height||getComputedStyle(el).visibility==='hidden')throw new Error('Element is not visible'); __classMarkEffect(); el.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); const r=el.getBoundingClientRect(); el.focus(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`, signal, true);
          await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, true);
          await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, true);
        } else {
          await this._evaluate(session, page, `(() => { const el=${lookup}; if(!el||!el.isConnected)throw new Error('Element not found; take a new snapshot'); if(el.disabled||el.readOnly)throw new Error('Element is not editable'); const before=el.getBoundingClientRect(); if(!before.width||!before.height||getComputedStyle(el).visibility==='hidden')throw new Error('Element is not visible'); const native=el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement; if(el instanceof HTMLInputElement && el.type==='file')throw new Error('File inputs are not supported'); if(!native&&!el.isContentEditable)throw new Error('Element is not a text input'); const text=${JSON.stringify(args.text)}; __classMarkEffect(); el.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); el.focus(); if(native){ const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,text); }else el.textContent=text; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`, signal, true);
        }
      } else if (args.action === 'press') {
        const spec = keySpec(args.key);
        await command('Input.dispatchKeyEvent', { type: 'keyDown', ...spec }, true);
        const { text, ...release } = spec;
        await command('Input.dispatchKeyEvent', { type: 'keyUp', ...release }, true);
      } else if (args.action === 'scroll') {
        await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 360, deltaX: args.x ?? 0, deltaY: args.y ?? 600 }, true);
      } else if (args.action === 'screenshot') {
        const { data } = await command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
        if (typeof data !== 'string' || !data) throw new Error('Browser did not return a screenshot');
        const bytes = Buffer.from(data, 'base64').length;
        if (bytes > 5 * 1024 * 1024) throw new Error('Browser screenshot exceeds the 5 MiB limit');
        return { ...this._result({ tabId: page.targetId, format: 'png', bytes }), media: [{ type: 'image', mimeType: 'image/png', data }] };
      }
      return this._result({ action: args.action, tabId: page.targetId, success: true });
    } catch (error) {
      let failure = error;
      if (signal.aborted) {
        await this._closeSession(studentId).catch(() => {});
        failure = cancelled(signal);
      }
      // A lost response or a failed later step cannot prove that a previously
      // dispatched click/fill/key/navigation did not act. Preserve this status
      // through the agent adapter so protocol recovery never replays it.
      if (effects.pending || effects.confirmed) failure = Object.assign(new Error(failure.message, { cause: failure }), failure, { executionStatus: 'unknown' });
      throw failure;
    } finally { cancelTimer(); this.effects.delete(signal); }
  }
  _result(value) {
    const bounded = boundedJson(value, this.manager.maxOutputBytes || 65536);
    return { name: 'browser', ...bounded, truncated: bounded.truncated || value.truncated === true };
  }
  async _command(session, method, params, sessionId, signal, effect = false) {
    await this._checkpoint(signal);
    const effects = this.effects.get(signal);
    const tracked = effect && effects?.mutating;
    let sent = false;
    try {
      const result = await session.connection.send(method, params, sessionId, signal, () => { if (tracked) { sent = true; effects.pending++; } });
      if (sent) { effects.pending--; if (typeof effect !== 'function' || effect(result)) effects.confirmed++; }
      return result;
    } catch (error) {
      // An explicit CDP rejection confirms this request was not dispatched to
      // the operation. Earlier completed steps remain tracked independently.
      if (sent && error.browserRequestState === 'rejected') effects.pending--;
      throw error;
    }
  }
  async _evaluate(session, page, expression, signal, mutation = false) {
    if (mutation) expression = `(() => { let browserEffect=false; const __classMarkEffect=()=>{browserEffect=true}; try { const value=(${expression}); return {browserEffect,value}; } catch(error) { return {browserEffect,browserError:String(error?.message||error)}; } })()`;
    const result = await this._command(session, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false, userGesture: true, timeout: 5000 }, page.sessionId, signal, mutation ? response => response.result?.value?.browserEffect !== false : false);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser page evaluation failed');
    if (mutation) {
      if (result.result?.value?.browserError) throw new Error(result.result.value.browserError);
      return result.result?.value?.value;
    }
    return result.result?.value;
  }
  async _ready(session, page, signal) {
    while (true) {
      try { if (await this._evaluate(session, page, "document.readyState !== 'loading'", signal)) return; }
      catch (error) { if (!/context|navigat/i.test(error.message)) throw error; }
      await delay(40, signal);
    }
  }
  async _tabs(session, signal) {
    const { targetInfos } = await this._command(session, 'Target.getTargets', {}, undefined, signal);
    return targetInfos.filter(target => target.type === 'page').map(target => ({ tabId: target.targetId, title: target.title, url: target.url }));
  }
  async _newPage(session, signal) {
    // Creating an owned blank tab is preparation, not a submitted page action.
    // It must not turn a later, explicit navigation failure into uncertainty.
    const { targetId } = await this._command(session, 'Target.createTarget', { url: 'about:blank' }, undefined, signal);
    return this._attach(session, targetId, signal);
  }
  async _page(session, tabId, signal) {
    const tabs = await this._tabs(session, signal);
    const id = tabId ?? (tabs.some(tab => tab.tabId === session.activeTabId) ? session.activeTabId : tabs[0]?.tabId);
    if (tabId && !tabs.some(tab => tab.tabId === tabId)) throw new Error('Unknown tabId for this student');
    if (!id) return this._newPage(session, signal);
    return this._attach(session, id, signal);
  }
  async _attach(session, targetId, signal) {
    if (!session.pages.has(targetId)) {
      const { sessionId } = await this._command(session, 'Target.attachToTarget', { targetId, flatten: true }, undefined, signal);
      await this._command(session, 'Page.enable', {}, sessionId, signal);
      await this._command(session, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId, signal);
      session.pages.set(targetId, { targetId, sessionId });
    }
    session.activeTabId = targetId;
    return session.pages.get(targetId);
  }
  async _session(studentId, signal) {
    const current = this.sessions.get(studentId);
    if (current && alive(current.child) && !current.connection?.closed) return current;
    if (current) await this._closeSession(studentId);
    if (typeof this.manager.adoptProcess !== 'function') throw new Error('Browser process ownership is not configured');
    const { executable, browserType } = await findBrowser(this.options.executablePath);
    await this._checkpoint(signal);
    let tempRoot = await fs.realpath(os.tmpdir());
    if (process.platform === 'linux' && browserType === 'firefox') {
      // Ubuntu's Firefox Snap cannot see the host's /tmp. A fresh, non-hidden
      // directory under HOME is visible to both native and confined Firefox.
      tempRoot = await fs.realpath(os.homedir());
    } else if (process.platform === 'linux') {
      // Chromium creates a Unix socket below TMPDIR. Leave room for its
      // generated directory and socket name within Linux's 108-byte limit.
      const fitsSocketPath = root => Buffer.byteLength(path.join(root, 'class-browser-XXXXXX')) <= 60;
      if (!fitsSocketPath(tempRoot)) tempRoot = await fs.realpath('/tmp');
      if (!fitsSocketPath(tempRoot)) throw new Error('Browser requires a shorter Linux temporary directory');
    }
    const profile = await fs.mkdtemp(path.join(tempRoot, 'class-browser-'));
    this.profiles.add(profile);
    const session = { profile, tempRoot, browserType, pages: new Map(), refKey: `class-browser-${randomUUID()}`, child: undefined, record: undefined, connection: undefined };
    this.sessions.set(studentId, session);
    try {
      await this._checkpoint(signal);
      const args = browserType === 'firefox' ? [
        '--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0', 'about:blank',
      ] : [
        '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--disable-default-apps', '--disable-extensions', '--disable-features=Translate,MediaRouter,OptimizationHints', '--password-store=basic', '--use-mock-keychain',
        '--window-size=1280,720', 'about:blank',
      ];
      session.child = spawn(executable, args, {
        cwd: this.manager.cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        // Keep browser scratch files in its private, owned profile. Override
        // only the child environment; the app's temporary directory is intact.
        ...(process.platform === 'linux' ? { env: { ...process.env, TMPDIR: profile, TMP: profile, TEMP: profile } } : {}),
      });
      let launchError, stderr = '', endpoint;
      session.child.once('error', error => { launchError = error; });
      session.child.stdout.resume();
      session.child.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-4096);
        if (browserType === 'firefox' && !endpoint) {
          const match = stderr.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)\r?\n/);
          if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) endpoint = `ws://127.0.0.1:${match[1]}/session`;
        }
      });
      session.record = await this.manager.adoptProcess(session.child, studentId);
      while (!endpoint) {
        await this._checkpoint(signal);
        if (launchError) throw launchError;
        if (!alive(session.child)) throw new Error(`Browser exited during startup: ${stderr.slice(-1000)}`);
        if (browserType === 'chromium') try {
          const [port, route] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
          if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535 && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(route)) endpoint = `ws://127.0.0.1:${port}${route}`;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!endpoint) await delay(40, signal);
      }
      const connection = await CdpConnection.connect(endpoint, signal, browserType === 'firefox' ? 'bidi' : 'cdp');
      session.connection = browserType === 'firefox' ? new FirefoxConnection(connection, activeSignal => this._checkpoint(activeSignal)) : connection;
      if (browserType === 'firefox') await session.connection.initialize(signal);
      // A fresh browser profile still inherits the OS download directory.
      // Disable downloads so page clicks cannot write into the user's Downloads.
      await this._command(session, 'Browser.setDownloadBehavior', { behavior: 'deny' }, undefined, signal);
      return session;
    } catch (error) {
      await this._closeSession(studentId).catch(() => {});
      throw error;
    }
  }
  async _removeProfile(session) {
    if (!this.profiles.has(session.profile)) return;
    const relative = path.relative(session.tempRoot, session.profile);
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(relative) !== '.' || !path.basename(relative).startsWith('class-browser-')) throw new Error('Refusing to remove an unowned browser profile');
    let stat;
    try { stat = await fs.lstat(session.profile); } catch (error) { if (error.code === 'ENOENT') { this.profiles.delete(session.profile); return; } throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(session.profile) !== session.profile) throw new Error('Browser profile ownership changed');
    await fs.rm(session.profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    this.profiles.delete(session.profile);
  }
  async _closeSession(studentId) {
    const session = this.sessions.get(studentId);
    if (!session) return;
    if (session.closing) return session.closing;
    session.closing = (async () => {
      session.connection?.close();
      if (session.record) {
        await bounded(this.manager._kill(session.record), 15000, 'Timed out stopping the owned browser');
        if (session.record.closed) await bounded(session.record.closed, 5000, 'Owned browser did not exit');
      } else if (alive(session.child)) {
        // Adoption can fail before the record is returned. The child handle still
        // refers exclusively to the process this module just spawned.
        session.child.kill('SIGKILL');
        await bounded(new Promise(resolve => { if (!alive(session.child)) resolve(); else session.child.once('close', resolve); }), 5000, 'Owned browser did not exit');
      }
      await this._removeProfile(session);
      if (this.sessions.get(studentId) === session) this.sessions.delete(studentId);
    })();
    try { return await session.closing; } catch (error) { session.closing = undefined; throw error; }
  }
  pauseAll() { this.paused = true; this.events.emit('change'); }
  resumeAll() { if (!this.stopped) { this.paused = false; this.events.emit('change'); } }
  async stopAll() {
    this.stopped = true; this.controller.abort(new Error('Browser tools stopped')); this.events.emit('change');
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this._closeSession(id)));
    await Promise.allSettled([...this.queues.values()]);
    // A launch blocked at a checkpoint can finish unwinding after the first pass.
    const retry = await Promise.allSettled([...this.sessions.keys()].map(id => this._closeSession(id)));
    const failure = retry.find(result => result.status === 'rejected') || (this.sessions.size ? results.find(result => result.status === 'rejected') : undefined);
    if (failure) throw failure.reason;
  }
}

function keySpec(value) {
  const parts = value.split('+'), key = parts.pop(), modifierBits = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };
  let modifiers = 0;
  for (const modifier of parts) { if (!modifierBits[modifier]) throw new Error(`Unsupported browser key modifier: ${modifier}`); modifiers |= modifierBits[modifier]; }
  const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };
  if (!key || (!(key in codes) && [...key].length !== 1)) throw new Error('Unsupported browser key');
  const actual = key === 'Space' ? ' ' : key;
  return { key: actual, modifiers, windowsVirtualKeyCode: codes[key] ?? actual.toUpperCase().charCodeAt(0), ...(actual.length === 1 && !(modifiers & 7) ? { text: actual } : {}) };
}
