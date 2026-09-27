// This console program is a release test driver, never the Class application.
// Compile with scripts/build-verifier.js. No developer runtime is required on
// the target PC; suites execute serially against the separately supplied EXE.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verificationHost, verifyNativeExecutable } from './windows-verification.js';
import { captureLinuxChild, stopLinuxOwnedTree } from './linux-process.js';

const compiled = typeof CLASS_VERIFIER_COMPILED !== 'undefined' && CLASS_VERIFIER_COMPILED;
if (!compiled) throw Error('Build this dedicated test driver with scripts/build-verifier.js before running it.');
globalThis.__classStandaloneVerifier = true;
const suiteNames = ['release', 'memory', 'ui', 'portable', 'platform', 'recovery', 'browser'];
const args = process.argv.slice(2), options = { suite: 'all' };
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--help') {
    console.log('Class.Verify[.exe] [--suite all|release|memory|ui|portable|platform|recovery|browser] [--exe Class[.exe]] [--report-dir folder]\nDedicated native Windows/Linux release acceptance only. Uses temporary profiles and a local fake model; briefly opens and cancels its own folder dialog. Requires a native target-architecture desktop and an installed Chromium/Edge/Chrome for existing suites. Browser compatibility additionally requires Edge/Chrome/Firefox on Windows or Chrome/Firefox on Linux; CLASS_TEST_BROWSER_EXECUTABLES accepts a JSON object mapping those names to absolute executables. Missing required browsers fail acceptance. Linux requires zenity or kdialog, xdotool, and a graphical session (Xvfb is supported). No Node, Bun, or Roslyn installation is needed.');
    process.exit(0);
  }
  if (args[index] === '--check-assets') { options.checkAssets = true; continue; }
  const key = args[index], value = args[++index];
  if (!['--suite', '--exe', '--report-dir', '--report'].includes(key) || !value || value.startsWith('--')) throw Error('Unknown verifier argument. Use --help.');
  options[key.slice(2)] = key === '--suite' ? value : path.resolve(value);
}
assert.ok(options.suite === 'all' || suiteNames.includes(options.suite), 'Unknown verifier suite');
const executable = options.exe || path.join(path.dirname(process.execPath), process.platform === 'linux' ? 'Class' : 'Class.exe');

if (options.suite !== 'all') {
  // Existing standalone Node invocations retain their original argument format.
  const suiteArgs = options.suite === 'release' ? [executable] : ['--exe', executable];
  if (options.report) {
    assert.ok(['memory', 'portable', 'platform', 'recovery', 'browser'].includes(options.suite), '--report is supported only by memory, portable, platform, recovery and browser suites');
    suiteArgs.push('--report', options.report);
  }
  if (options.checkAssets) { assert.equal(options.suite, 'memory'); suiteArgs.push('--check-assets'); }
  process.argv = [process.execPath, 'Class.Verify.exe', ...suiteArgs];
  // Literal imports allow Bun to embed every suite and its own library code.
  switch (options.suite) {
    case 'release': await import('./verify-release.js'); break;
    case 'memory': await import('./verify-memory-release.js'); break;
    case 'ui': await import('./verify-memory-ui.js'); break;
    case 'portable': if (process.platform === 'linux') await import('./verify-linux-portable.js'); else await import('./verify-portable.js'); break;
    case 'platform': if (process.platform === 'linux') await import('./verify-linux-platform.js'); else await import('./verify-platform.js'); break;
    case 'recovery': await import('./verify-startup-recovery.js'); break;
    case 'browser': await import('./verify-browser-compatibility.js'); break;
  }
} else {
  assert.ok(!options.report && !options.checkAssets, 'Use --report-dir for the complete acceptance run');
  const parent = await fs.realpath(os.tmpdir());
  const directory = options['report-dir'] ? await fs.mkdtemp(path.join(await fs.mkdir(options['report-dir'], { recursive: true }).then(() => fs.realpath(options['report-dir'])), 'class-verification-')) : await fs.mkdtemp(path.join(parent, 'class-verification-'));
  const reportFile = path.join(directory, 'verification-summary.json');
  const host = verificationHost(), report = { startedAt: new Date().toISOString(), mode: 'standalone-exe', host, executable, verifier: process.execPath, freshVm: false, suites: [], passed: false };
  let active, interrupted = false;
  const interrupt = () => { interrupted = true; console.error('Interrupt requested; stopping the owned verification process tree.'); active?.stop().catch(error => { report.interruptCleanupError = error.message; }); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  async function runSuite(name) {
    const logFile = path.join(directory, name + '.log');
    const suiteDirectory = path.join(directory, name); await fs.mkdir(suiteDirectory);
    const targetEnvironment = process.platform === 'linux' ? { CLASS_LINUX_ARCH: host.expectedArchitecture } : { CLASS_WINDOWS_ARCH: host.expectedArchitecture };
    // Bun may cache os.homedir(); isolate Firefox before the suite starts.
    if (process.platform === 'linux' && name === 'browser') Object.assign(targetEnvironment, { HOME: suiteDirectory, USERPROFILE: suiteDirectory });
    const child = spawn(process.execPath, ['--suite', name, '--exe', executable, ...(name === 'memory' ? ['--check-assets'] : [])], { cwd: directory, env: { ...process.env, TEMP: suiteDirectory, TMP: suiteDirectory, TMPDIR: suiteDirectory, ...targetEnvironment }, detached: process.platform === 'linux', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failure, forcedStop = false, cleanupFailed = false, stopPromise;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-256000); });
    child.once('error', error => { failure = error; });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const linuxIdentity = process.platform === 'linux' ? captureLinuxChild(child) : null;
    linuxIdentity?.catch(() => {});
    async function stopOwned() {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      forcedStop = true;
      if (process.platform === 'linux') { await stopLinuxOwnedTree(await linuxIdentity); return; }
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const quoted = process.execPath.replaceAll("'", "''");
      const script = `$ErrorActionPreference='Stop'; $owned=Get-CimInstance Win32_Process -Filter "ProcessId = ${child.pid}"; if($owned) { if($owned.ParentProcessId -ne ${process.pid} -or $owned.ExecutablePath -ne '${quoted}' -or -not $owned.CommandLine.Contains('--suite ${name}')) { throw 'Verifier process identity changed' }; & "$env:SystemRoot\\System32\\taskkill.exe" /PID $owned.ProcessId /T /F | Out-Null; if($LASTEXITCODE -ne 0 -and (Get-Process -Id $owned.ProcessId -ErrorAction SilentlyContinue)) { throw 'Owned verifier termination failed' } }`;
      await new Promise((resolve, reject) => {
        const helper = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => { helper.kill(); helper.unref(); reject(Error('Owned verifier cleanup helper exceeded fifteen seconds')); }, 15000);
        helper.once('error', error => { clearTimeout(timer); reject(error); }); helper.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Unable to stop the owned verification process tree')); });
      });
    }
    const stop = () => stopPromise ||= stopOwned();
    let requestBound;
    const bounded = new Promise(resolve => { requestBound = resolve; });
    active = { stop: () => { requestBound({ interrupted: true }); return stop(); } };
    // Individual suites have bounded operations; this outer bound also catches
    // a broken browser/runtime without claiming that an omitted suite passed.
    const limit = name === 'browser' ? 600000 : 360000;
    const timer = setTimeout(() => requestBound({ timedOut: true }), limit);
    let exit;
    try {
      const first = await Promise.race([closed.then(value => ({ exit: value })), bounded]);
      if (first.exit) exit = first.exit;
      else {
        failure = Error(first.timedOut ? 'Suite exceeded ' + limit / 60000 + ' minutes' : 'Verification interrupted');
        try { await stop(); } catch (error) { cleanupFailed = true; failure = error; }
        let closeTimer;
        try { exit = await Promise.race([closed, new Promise(resolve => { closeTimer = setTimeout(() => resolve(null), 10000); })]); } finally { clearTimeout(closeTimer); }
        if (!exit) { cleanupFailed = true; exit = { code: null, signal: null }; child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
      }
    } finally { clearTimeout(timer); active = undefined; }
    await fs.writeFile(logFile, output);
    const records = [];
    for (let offset = output.indexOf('{'); offset >= 0; offset = output.indexOf('{', offset + 1)) { try { records.push(JSON.parse(output.slice(offset).trim())); } catch {} }
    const summary = records.at(-1);
    const passed = !failure && !forcedStop && exit.code === 0 && exit.signal === null && (name === 'release' ? summary?.cleanShutdown === true && summary?.temporaryDataRemoved === true : summary?.passed === true);
    return { name, passed, exit, forcedStop, cleanupFailed, ownedPid: child.pid, logFile, reportDirectory: suiteDirectory, ...(summary ? { summary } : {}), ...(failure ? { error: failure.message } : {}) };
  }
  try {
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    report.executableSha256 = digest(await fs.readFile(executable)); report.verifierSha256 = digest(await fs.readFile(process.execPath));
    report.artifact = verifyNativeExecutable(await fs.readFile(executable), host);
    console.log('Class dedicated release verification. Native target: ' + host.expectedArchitecture + '. Reports: ' + directory);
    console.log('Seven suites run serially. A folder dialog owned by this test will briefly open and close.');
    for (const name of suiteNames) {
      if (interrupted) break;
      console.log('START ' + name); const result = await runSuite(name); report.suites.push(result); console.log((result.passed ? 'PASS ' : 'FAIL ') + name);
      if (result.cleanupFailed) break;
    }
    report.passed = !interrupted && report.suites.length === suiteNames.length && report.suites.every(suite => suite.passed);
  } catch (error) { report.error = error.stack || error.message; }
  finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); report.interrupted = interrupted; report.finishedAt = new Date().toISOString();
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    if (!report.passed) process.exitCode = 1;
    console.log(JSON.stringify({ passed: report.passed, host, suites: report.suites.map(({ name, passed }) => ({ name, passed })), report: reportFile, ...(report.error ? { error: report.error } : {}) }, null, 2));
  }
}
