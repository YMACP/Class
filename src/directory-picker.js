import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DIRECTORY_PICKER_BINARY } from '../build/generated/directory-picker.generated.js';

const benignChooserWarnings = new Set([
  "Unable to acquire the address of the accessibility bus: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.a11y.Bus was not provided by any .service files. If you are attempting to run GTK without a11y support, GTK_A11Y should be set to 'none'.",
  'GtkDialog mapped without a transient parent. This is discouraged.',
]);

function hasOnlyBenignChooserWarnings(diagnostic) {
  return diagnostic.split(/\r?\n/).every(line => {
    if (!line.trim()) return true;
    const warning = line.trim().match(/^(?:\((?:zenity|kdialog):\d+\):\s*)?Gtk-(?:WARNING \*\*|Message):\s*(?:\d{2}:\d{2}:\d{2}(?:\.\d+)?:\s*)?(.+)$/);
    return warning !== null && benignChooserWarnings.has(warning[1]);
  });
}

/** Linux backends are external desktop programs, invoked without a shell. */
export async function runLinuxDirectoryChooser(initial, { signal, timeoutMs = 300000, env = process.env, spawnProcess = spawn } = {}) {
  if (signal?.aborted) return { cancelled: true };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1800000) throw new Error('Invalid directory chooser timeout');
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw new Error('Linux directory selection requires a desktop session (DISPLAY or WAYLAND_DISPLAY) and zenity or kdialog');
  const title = 'Class - Select directory';
  const backends = [
    ['zenity', ['--file-selection', '--directory', '--title=' + title, '--filename=' + (initial.endsWith('/') ? initial : initial + '/')]],
    ['kdialog', ['--getexistingdirectory', initial, '--title', title]],
  ];
  for (const [executable, args] of backends) {
    if (signal?.aborted) return { cancelled: true };
    try {
      return await new Promise((resolve, reject) => {
        const child = spawnProcess(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
        let output = '', diagnostic = '', cancelled = false, timedOut = false, oversized = false, launchError;
        const abort = () => { cancelled = true; child.kill('SIGKILL'); };
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) { oversized = true; child.kill('SIGKILL'); } });
        child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
        // A failed spawn also emits close. Wait for close for every completion,
        // including abort/timeout, before allowing another chooser to open.
        child.once('error', error => { launchError = error; });
        child.once('close', (code, exitSignal) => {
          cleanup();
          if (cancelled || signal?.aborted) return resolve({ cancelled: true });
          if (timedOut) return reject(new Error('Directory selection timed out; open the chooser again'));
          if (launchError) return reject(launchError);
          if (oversized) return reject(new Error('The native directory chooser returned too much output'));
          // Both backends use exit 1 for Cancel. These GTK notices can accompany
          // normal cancellation; unknown diagnostics and rendering errors cannot.
          if (code === 1 && !exitSignal && !output.trim() && hasOnlyBenignChooserWarnings(diagnostic)) return resolve({ cancelled: true });
          if (code !== 0 || exitSignal) return reject(new Error(executable + ' directory selection failed' + (diagnostic.trim() ? ': ' + diagnostic.trim().slice(0, 512) : ' (exit ' + code + ', signal ' + (exitSignal || 'none') + ')')));
          // Remove only the protocol newline. Spaces can be part of a directory name.
          const selected = output.endsWith('\n') ? output.slice(0, -1) : output;
          if (!selected || !path.posix.isAbsolute(selected) || selected.includes('\0')) return reject(new Error('The native directory chooser returned an invalid path'));
          resolve({ cancelled: false, path: selected });
        });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Linux directory selection requires zenity or kdialog; install one of these desktop dialog utilities');
}

let activePicker = false;
/** Opens one native folder chooser and resolves only after its process exits. */
export async function pickDirectory({ initialPath, signal, timeoutMs = 300000 } = {}) {
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('Native directory selection requires Windows or a Linux desktop');
  if (activePicker) throw new Error('A directory chooser is already open');
  if (signal?.aborted) return { cancelled: true };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1800000) throw new Error('Invalid directory chooser timeout');
  activePicker = true;
  let helperDirectory, executable;
  try {
    let initial = typeof initialPath === 'string' && path.isAbsolute(initialPath) ? initialPath : os.homedir();
    // An unavailable saved workspace should not prevent selecting its replacement.
    try { initial = (await fs.stat(initial)).isDirectory() ? await fs.realpath(initial) : os.homedir(); } catch { initial = os.homedir(); }
    if (signal?.aborted) return { cancelled: true };
    if (process.platform === 'linux') {
      const result = await runLinuxDirectoryChooser(initial, { signal, timeoutMs });
      if (signal?.aborted || result.cancelled) return { cancelled: true };
      const selectedPath = await fs.realpath(result.path);
      if (!(await fs.stat(selectedPath)).isDirectory()) throw new Error('The selected path is not a directory');
      return { cancelled: false, path: selectedPath };
    }
    // The GUI component is bundled inside Class.exe. Extract into a fresh private
    // temporary directory for this request, then remove it after the dialog exits.
    const binary = Buffer.from(DIRECTORY_PICKER_BINARY.base64, 'base64');
    if (createHash('sha256').update(binary).digest('hex') !== DIRECTORY_PICKER_BINARY.sha256) throw new Error('The bundled directory chooser is damaged');
    helperDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'class-folder-picker-'));
    executable = path.join(helperDirectory, 'Class.FolderPicker.exe');
    await fs.writeFile(executable, binary, { flag: 'wx' });
    if (signal?.aborted) return { cancelled: true };
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, [], {
        // This is a GUI executable; hiding its startup window can hide the chooser.
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLASS_PICKER_INITIAL_BASE64: Buffer.from(initial, 'utf8').toString('base64') },
      });
      let output = '', cancelled = false, timedOut = false, oversized = false;
      const abort = () => { cancelled = true; child.kill('SIGKILL'); };
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) { oversized = true; child.kill('SIGKILL'); } });
      child.stderr.on('data', () => {});
      child.once('error', () => { cleanup(); reject(new Error('Unable to start the native directory chooser')); });
      child.once('close', code => {
        cleanup();
        if (cancelled || signal?.aborted) return resolve({ cancelled: true });
        if (timedOut) return reject(new Error('Directory selection timed out; open the chooser again'));
        if (oversized || code !== 0) return reject(new Error('The native directory chooser did not complete successfully'));
        try { resolve(JSON.parse(output.trim())); } catch { reject(new Error('The native directory chooser returned an invalid response')); }
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (signal?.aborted || result?.cancelled === true) return { cancelled: true };
    if (result?.cancelled !== false || typeof result.path !== 'string' || !path.isAbsolute(result.path)) throw new Error('The selected directory is invalid');
    const selectedPath = await fs.realpath(result.path);
    if (!(await fs.stat(selectedPath)).isDirectory()) throw new Error('The selected path is not a directory');
    return { cancelled: false, path: selectedPath };
  } finally {
    // Never recursively remove a computed path: these are the two resources we created.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        if (executable) await fs.rm(executable, { force: true });
        if (helperDirectory) await fs.rmdir(helperDirectory);
        break;
      } catch {
        // A short antivirus/file-indexer lock must not discard a valid selection.
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    activePicker = false;
  }
}
