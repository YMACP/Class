import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultDataDirectory, defaultStartupLogDirectory, startupLogDirectory } from '../src/platform-paths.js';
import { runLinuxDirectoryChooser } from '../src/directory-picker.js';
import { configureStartupLog, redactStartupSecret, startupLog, launchBrowser, writeBrowserEntry, showStartupError } from '../src/startup-support.js';

const desktop = { DISPLAY: ':fixture' };
const benignGtkWarnings = [
  "(zenity:4788): Gtk-WARNING **: 16:11:52.933: Unable to acquire the address of the accessibility bus: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.a11y.Bus was not provided by any .service files. If you are attempting to run GTK without a11y support, GTK_A11Y should be set to 'none'.",
  'Gtk-Message: 16:11:53.767: GtkDialog mapped without a transient parent. This is discouraged.',
];
function backends(plans) {
  const calls = [], children = [];
  const spawnProcess = (executable, args, options) => {
    const plan = plans[calls.length];
    assert.ok(plan, 'Unexpected extra directory chooser process');
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
    child.finish = (code = 0, signal = null) => { child.stdout.end(); child.stderr.end(); child.emit('close', code, signal); };
    child.kill = signal => {
      child.kills.push(signal);
      if (plan.closeOnKill !== false) queueMicrotask(() => child.finish(null, signal));
      return true;
    };
    children.push(child);
    queueMicrotask(() => {
      if (plan.error) { child.emit('error', Object.assign(new Error('fixture spawn failure'), { code: plan.error })); child.finish(-2); return; }
      if (plan.output) child.stdout.write(plan.output);
      if (plan.diagnostic) child.stderr.write(plan.diagnostic);
      if (!plan.hold) child.finish(plan.code ?? 0, plan.signal ?? null);
    });
    return child;
  };
  return { calls, children, spawnProcess };
}

async function scratch(t) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-desktop-platform-'));
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('class-desktop-platform-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('Linux uses absolute XDG data/state paths and preserves custom profile logs', () => {
  const defaults = { platform: 'linux', home: '/home/fixture', env: {} };
  assert.equal(defaultDataDirectory(defaults), '/home/fixture/.local/share/class');
  assert.equal(defaultStartupLogDirectory(defaults), '/home/fixture/.local/state/class/logs');
  assert.equal(startupLogDirectory(defaultDataDirectory(defaults), defaults), defaultStartupLogDirectory(defaults));
  assert.equal(startupLogDirectory('/mnt/custom profile', defaults), '/mnt/custom profile');
  const custom = { ...defaults, env: { XDG_DATA_HOME: '/data/user', XDG_STATE_HOME: '/state/user' } };
  assert.equal(defaultDataDirectory(custom), '/data/user/class');
  assert.equal(startupLogDirectory('/data/user/class', custom), '/state/user/class/logs');
  const invalid = { ...defaults, env: { XDG_DATA_HOME: 'relative', XDG_STATE_HOME: '', LOCALAPPDATA: '/unrelated/windows' } };
  assert.equal(defaultDataDirectory(invalid), defaultDataDirectory(defaults));
  assert.equal(defaultStartupLogDirectory(invalid), defaultStartupLogDirectory(defaults));
});

test('Windows data and fallback log locations retain their established names', () => {
  const options = { platform: 'win32', home: 'C:\\Users\\Fixture', env: { LOCALAPPDATA: 'D:\\LocalData' } };
  assert.equal(defaultDataDirectory(options), 'D:\\LocalData\\discussion');
  assert.equal(defaultStartupLogDirectory(options), 'D:\\LocalData\\Class\\logs');
  assert.equal(startupLogDirectory('E:\\CustomProfile', options), 'E:\\CustomProfile');
  assert.equal(defaultDataDirectory({ ...options, env: {} }), 'C:\\Users\\Fixture\\AppData\\Local\\discussion');
});

test('Linux directory paths are single argv values and selected trailing spaces survive', async () => {
  const initial = "/tmp/space ' ; $(not-a-command)";
  const fixture = backends([{ output: '/tmp/selected space \n' }]);
  assert.deepEqual(await runLinuxDirectoryChooser(initial, { env: desktop, spawnProcess: fixture.spawnProcess }), { cancelled: false, path: '/tmp/selected space ' });
  assert.equal(fixture.calls[0].executable, 'zenity');
  assert.equal(fixture.calls[0].options.shell, false);
  assert.deepEqual(fixture.calls[0].args, ['--file-selection', '--directory', '--title=Class - Select directory', '--filename=' + initial + '/']);
});

test('Linux falls back only for a missing backend and distinguishes missing dependencies', async () => {
  const fallback = backends([{ error: 'ENOENT' }, { output: '/tmp/selected\n' }]);
  assert.deepEqual(await runLinuxDirectoryChooser('/tmp', { env: desktop, spawnProcess: fallback.spawnProcess }), { cancelled: false, path: '/tmp/selected' });
  assert.equal(fallback.calls[1].executable, 'kdialog');
  assert.deepEqual(fallback.calls[1].args, ['--getexistingdirectory', '/tmp', '--title', 'Class - Select directory']);
  const missing = backends([{ error: 'ENOENT' }, { error: 'ENOENT' }]);
  await assert.rejects(runLinuxDirectoryChooser('/tmp', { env: desktop, spawnProcess: missing.spawnProcess }), /install one/);
  const denied = backends([{ error: 'EACCES' }]);
  await assert.rejects(runLinuxDirectoryChooser('/tmp', { env: desktop, spawnProcess: denied.spawnProcess }), { code: 'EACCES' });
  assert.equal(denied.calls.length, 1);
});

test('Linux cancellation accepts the observed benign GTK warnings for either backend', async () => {
  for (const diagnostic of ['', ...benignGtkWarnings, benignGtkWarnings.join('\n') + '\n']) {
    for (const fallback of [false, true]) {
      const cancelled = backends([...(fallback ? [{ error: 'ENOENT' }] : []), { code: 1, diagnostic }]);
      assert.deepEqual(await runLinuxDirectoryChooser('/tmp', { env: desktop, spawnProcess: cancelled.spawnProcess }), { cancelled: true });
      assert.equal(cancelled.calls.length, fallback ? 2 : 1);
    }
  }
});

test('Linux cancellation is distinct from unknown diagnostics, error exits, crashes and invalid selection', async () => {
  for (const plan of [
    { code: 1, diagnostic: 'cannot open display' },
    { code: 1, diagnostic: 'backend failed' },
    { code: 1, diagnostic: benignGtkWarnings.join('\n') + '\nfailed to create drawable\n(zenity:4788): Gdk-WARNING **: 16:11:53.894: BadDrawable (invalid Pixmap or Window parameter)' },
    { code: 1, diagnostic: benignGtkWarnings[0] + ' backend failed' },
    { code: 255, diagnostic: 'unexpected backend error' },
    { code: 254, diagnostic: 'invalid backend argument' },
    { code: 5, diagnostic: benignGtkWarnings.join('\n') },
    { code: 1, signal: 'SIGSEGV', diagnostic: benignGtkWarnings.join('\n') },
    { code: 1, output: '/tmp/unexpected\n' },
    { code: 0, signal: 'SIGSEGV' },
    { output: 'relative/path\n' },
    { output: '' },
    { output: '/tmp/' + 'x'.repeat(65536) },
  ]) {
    const fixture = backends([plan]);
    await assert.rejects(runLinuxDirectoryChooser('/tmp', { env: desktop, spawnProcess: fixture.spawnProcess }));
    assert.equal(fixture.calls.length, 1);
  }
});

test('Linux headless and pre-aborted requests do not launch any process', async () => {
  const fixture = backends([]);
  await assert.rejects(runLinuxDirectoryChooser('/tmp', { env: {}, spawnProcess: fixture.spawnProcess }), /desktop session/);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await runLinuxDirectoryChooser('/tmp', { env: {}, signal: controller.signal, spawnProcess: fixture.spawnProcess }), { cancelled: true });
  assert.equal(fixture.calls.length, 0);
});

test('Linux abort waits for its owned chooser to close before reporting cancellation', async t => {
  const fixture = backends([{ hold: true, closeOnKill: false }]), controller = new AbortController();
  let settled = false;
  const pending = runLinuxDirectoryChooser('/tmp', { env: desktop, signal: controller.signal, spawnProcess: fixture.spawnProcess }).then(result => { settled = true; return result; });
  t.after(() => fixture.children[0].finish(null, 'SIGKILL'));
  controller.abort();
  await delay(10);
  assert.equal(settled, false);
  assert.deepEqual(fixture.children[0].kills, ['SIGKILL']);
  fixture.children[0].finish(null, 'SIGKILL');
  assert.deepEqual(await pending, { cancelled: true });
});

test('Linux timeout waits for close and reports failure rather than cancellation', async t => {
  const fixture = backends([{ hold: true, closeOnKill: false }]);
  let settled = false;
  const pending = runLinuxDirectoryChooser('/tmp', { env: desktop, timeoutMs: 100, spawnProcess: fixture.spawnProcess });
  const checked = assert.rejects(pending.finally(() => { settled = true; }), /timed out/);
  t.after(() => fixture.children[0].finish(null, 'SIGKILL'));
  await delay(130);
  assert.equal(settled, false);
  assert.deepEqual(fixture.children[0].kills, ['SIGKILL']);
  fixture.children[0].finish(null, 'SIGKILL');
  await checked;
});

test('Linux browser failure retains an authenticated manual entry and visible diagnostic', async t => {
  const directory = await scratch(t), url = 'http://127.0.0.1:12345/#token=isolated-fixture-token';
  const entry = writeBrowserEntry(directory, url, { platform: 'linux' });
  const body = await fs.readFile(entry, 'utf8');
  assert.ok(body.includes('href="' + url + '"'));
  assert.ok(body.includes('./Class'));
  assert.ok(!body.includes('Class.exe'));
  const calls = [];
  await assert.rejects(launchBrowser(url, { platform: 'linux', commandRunner: async (...args) => { calls.push(args); throw new Error('xdg-open fixture failure'); } }), /xdg-open fixture failure/);
  assert.deepEqual(calls, [['xdg-open', [url]]]);
  const notices = []; t.mock.method(console, 'error', message => notices.push(message));
  await showStartupError('Open browser entry: ' + entry, { platform: 'linux', silent: true });
  assert.deepEqual(notices, ['Open browser entry: ' + entry]);
  assert.equal(await fs.readFile(entry, 'utf8'), body);
  const windowsEntry = writeBrowserEntry(directory, url, { platform: 'win32' });
  assert.ok((await fs.readFile(windowsEntry, 'utf8')).includes('双击 Class.exe'));
});

test('configured startup logging remains isolated and redacts browser credentials', async t => {
  const directory = await scratch(t), token = 'isolated-secret-that-must-not-appear';
  configureStartupLog(directory); redactStartupSecret(token);
  const log = startupLog('fixture', 'http://127.0.0.1/#token=' + token);
  assert.equal(log, path.join(directory, 'startup.log'));
  const text = await fs.readFile(log, 'utf8');
  assert.ok(!text.includes(token));
  assert.ok(text.includes('[REDACTED]'));
});
