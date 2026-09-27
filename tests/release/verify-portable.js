// Verify the copied Windows distribution outside the source tree, with no
// Node/npm/Bun available on the application's PATH. Node runs this verifier,
// not the application. This checks the current host, not a fresh VM.
// Usage: node tests/release/verify-portable.js [--exe executable] [--report report.json]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getReleaseDirectory } from '../../scripts/release-paths.js';
import { verificationHost, verifyNativeExecutable, verificationRoot, verifierCommand } from './windows-verification.js';

const sourceRoot = verificationRoot(import.meta.url);
const options = {}, args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const option = args[index], value = args[index + 1];
  if (!['--exe', '--report'].includes(option) || !value || value.startsWith('--')) throw Error('Usage: node tests/release/verify-portable.js [--exe executable] [--report report.json]');
  options[option.slice(2)] = path.resolve(value);
}
if (process.platform !== 'win32') throw Error('This verifier requires native Windows x64 or ARM64.');
const executable = options.exe || path.join(getReleaseDirectory(), 'Class.exe');
const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'class-portable-verifier-'));
const distribution = path.join(directory, 'distribution'), runtimeHome = path.join(directory, 'runtime-home');
const reportFile = options.report || path.join(directory, 'verification-report.json'), memoryReport = path.join(directory, 'memory-report.json');
const report = { startedAt: new Date().toISOString(), executable, host: verificationHost(), freshVm: false, checks: {}, cleanup: {} };
let child, childClosed;
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
async function command(file, argv, env, cwd) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(file, argv, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; processHandle.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); }); processHandle.stderr.resume();
    processHandle.once('error', reject); processHandle.once('close', code => resolve({ code, output: output.trim() }));
  });
}
async function stopOwnedVerifier() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // The child object identifies the still-running verifier we just spawned.
  // /T stops only that verifier and its application child, never other Class runs.
  await command(taskkill, ['/PID', String(child.pid), '/T', '/F'], process.env, directory);
  await childClosed; report.cleanup.forcedOwnedProcessTreeStop = true;
}
try {
  const resolvedSource = await fs.realpath(sourceRoot);
  assert.equal(inside(resolvedSource, directory), false, 'Portable fixture must be outside the source tree');
  await fs.mkdir(distribution); await fs.mkdir(runtimeHome);
  const bytes = await fs.readFile(executable);
  report.artifact = verifyNativeExecutable(bytes, report.host);
  const notices = path.join(path.dirname(executable), 'THIRD_PARTY_NOTICES.txt'), copied = path.join(distribution, 'Class.exe');
  assert.ok((await fs.stat(notices)).size > 0, 'Distribution must include third-party notices');
  await fs.copyFile(executable, copied); await fs.copyFile(notices, path.join(distribution, 'THIRD_PARTY_NOTICES.txt'));
  report.executableSha256 = digest(bytes); assert.equal(digest(await fs.readFile(copied)), report.executableSha256);
  report.checks.onlyExecutableAndNoticesCopied = true;
  const childTemp = path.join(runtimeHome, 'tmp'), localData = path.join(runtimeHome, 'local'), roamingData = path.join(runtimeHome, 'roaming');
  for (const folder of [childTemp, localData, roamingData]) await fs.mkdir(folder);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:path|node_.*|npm_.*|bun_.*|class_.*)$/i.test(key)) delete environment[key];
  environment.PATH = [path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32', 'Wbem'), path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter);
  Object.assign(environment, { TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp, USERPROFILE: runtimeHome, LOCALAPPDATA: localData, APPDATA: roamingData });
  environment.CLASS_WINDOWS_ARCH = report.host.expectedArchitecture;
  const where = path.join(systemRoot, 'System32', 'where.exe');
  report.runtimeCommands = {};
  for (const runtime of ['node', 'npm', 'bun']) {
    const found = await command(where, [runtime], environment, distribution);
    assert.equal(found.code, 1, runtime + ' must not resolve on the application PATH'); report.runtimeCommands[runtime] = 'not on PATH';
  }
  assert.equal((await command(where, ['powershell'], environment, distribution)).code, 0, 'Keep Windows PowerShell discoverable');
  report.checks.applicationPathHasNoDevelopmentRuntime = true;
  report.checks.systemPowerShellRemainsAvailable = true;
  const verifier = verifierCommand('memory', ['--exe', copied, '--report', memoryReport, '--check-assets']);
  child = spawn(verifier.executable, verifier.args, { env: environment, cwd: distribution, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
  child.once('error', failure => { error = failure; });
  childClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let timer, exit;
  try { exit = await Promise.race([childClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Portable verification exceeded two minutes')), 120000); })]); }
  finally { clearTimeout(timer); }
  if (error) throw error;
  assert.equal(exit.code, 0, output); assert.equal(exit.signal, null);
  const verified = JSON.parse(await fs.readFile(memoryReport, 'utf8'));
  assert.equal(verified.passed, true); assert.equal(verified.assetsVerified, true); assert.equal(verified.executableSha256, report.executableSha256); assert.equal(verified.cleanup.isolatedProfileRemoved, true); assert.equal(verified.cleanup.forcedOwnedChildStop, undefined);
  assert.deepEqual(verified.host, report.host);
  assert.deepEqual((await fs.readdir(distribution)).sort(), ['Class.exe', 'THIRD_PARTY_NOTICES.txt']);
  report.checks.copiedApplicationPassedRealHttpWorkflow = true;
  report.checks.embeddedFrontendAssetsAvailable = true;
  report.memoryChecks = verified.checks; report.memoryReport = memoryReport; report.copiedExecutable = copied;
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack || error.message; process.exitCode = 1; }
finally {
  try { await stopOwnedVerifier(); }
  catch (error) { report.cleanup.error = error.message; report.passed = false; process.exitCode = 1; }
  try {
    const resolved = await fs.realpath(directory); assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('class-portable-verifier-'));
    for (const folder of [distribution, runtimeHome]) {
      try { const target = await fs.realpath(folder); assert.equal(path.dirname(target), resolved); await fs.rm(target, { recursive: true, force: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    report.cleanup.isolatedFilesRemoved = true;
  } catch (error) { report.cleanup.error = error.message; report.passed = false; process.exitCode = 1; }
  if (report.cleanup.forcedOwnedProcessTreeStop) { report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await fs.mkdir(path.dirname(reportFile), { recursive: true }); await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, cleanup: report.cleanup, report: reportFile, ...(report.error ? { error: report.error } : {}) }, null, 2));
}
