// Linux equivalent of portable Windows acceptance; requires the real native
// artifact and preserves the full memory/review workflow in a runtime-free PATH.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verificationHost, verifyNativeExecutable, verificationRoot, verifierCommand, defaultVerificationExecutable } from './windows-verification.js';
import { captureLinuxChild, stopLinuxOwnedTree } from './linux-process.js';

const options = {}, args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i], value = args[i + 1];
  if (!['--exe', '--report'].includes(key) || !value || value.startsWith('--')) throw Error('Usage: node tests/release/verify-linux-portable.js [--exe Class] [--report file]');
  options[key.slice(2)] = path.resolve(value);
}
assert.equal(process.platform, 'linux', 'Linux portable acceptance requires Linux');
const executable = options.exe || defaultVerificationExecutable(), parent = await fs.realpath(os.tmpdir());
const directory = await fs.mkdtemp(path.join(parent, 'class-linux-portable-'));
const distribution = path.join(directory, 'distribution'), runtimeHome = path.join(directory, 'runtime-home');
const reportFile = options.report || path.join(directory, 'verification-report.json'), memoryReport = path.join(directory, 'memory-report.json');
const report = { startedAt: new Date().toISOString(), executable, host: verificationHost(), freshVm: false, checks: {}, cleanup: {} };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let child, closed, identity;
async function absentOnPath(command, environment) {
  const probe = spawn(command, ['--version'], { env: environment, cwd: distribution, stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    let failure; probe.once('error', error => { failure = error; });
    const timer = setTimeout(() => { probe.kill('SIGKILL'); reject(Error('Runtime probe did not finish')); }, 5000);
    probe.once('close', () => { clearTimeout(timer); failure?.code === 'ENOENT' ? resolve() : reject(Error(command + ' unexpectedly resolves on the isolated application PATH')); });
  });
}
try {
  const source = await fs.realpath(verificationRoot(import.meta.url)), relative = path.relative(source, directory);
  assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Portable fixture must be outside the source/package tree');
  const bytes = await fs.readFile(executable); report.artifact = verifyNativeExecutable(bytes, report.host); report.executableSha256 = digest(bytes);
  for (const folder of [distribution, runtimeHome]) await fs.mkdir(folder);
  const copied = path.join(distribution, 'Class'), notices = path.join(path.dirname(executable), 'THIRD_PARTY_NOTICES.txt');
  assert.ok((await fs.stat(notices)).size > 0);
  await fs.copyFile(executable, copied); await fs.chmod(copied, 0o755); await fs.copyFile(notices, path.join(distribution, 'THIRD_PARTY_NOTICES.txt'));
  assert.equal(digest(await fs.readFile(copied)), report.executableSha256); report.checks.onlyExecutableAndNoticesCopied = true;
  const emptyPath = path.join(runtimeHome, 'empty-path'), temporary = path.join(runtimeHome, 'tmp'), configuration = path.join(runtimeHome, 'config'), data = path.join(runtimeHome, 'data');
  for (const folder of [emptyPath, temporary, configuration, data]) await fs.mkdir(folder, { mode: 0o700 });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:path|node_.*|npm_.*|bun_.*|class_.*)$/i.test(key)) delete environment[key];
  Object.assign(environment, { PATH: emptyPath, HOME: runtimeHome, XDG_CONFIG_HOME: configuration, XDG_DATA_HOME: data, TEMP: temporary, TMP: temporary, TMPDIR: temporary, CLASS_LINUX_ARCH: report.host.expectedArchitecture });
  report.runtimeCommands = {};
  for (const command of ['node', 'npm', 'bun']) { await absentOnPath(command, environment); report.runtimeCommands[command] = 'not on PATH'; }
  report.checks.applicationPathHasNoDevelopmentRuntime = true;
  const command = verifierCommand('memory', ['--exe', copied, '--report', memoryReport, '--check-assets']);
  child = spawn(command.executable, command.args, { env: environment, cwd: distribution, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', spawnError; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); });
  child.once('error', error => { spawnError = error; }); closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))); identity = await captureLinuxChild(child);
  let timer, exit; try { exit = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Linux portable verification exceeded two minutes')), 120000); })]); } finally { clearTimeout(timer); }
  if (spawnError) throw spawnError;
  assert.equal(exit.code, 0, output); assert.equal(exit.signal, null);
  const verified = JSON.parse(await fs.readFile(memoryReport, 'utf8'));
  assert.equal(verified.passed, true); assert.equal(verified.assetsVerified, true); assert.equal(verified.executableSha256, report.executableSha256); assert.equal(verified.cleanup.isolatedProfileRemoved, true); assert.equal(verified.cleanup.forcedOwnedChildStop, undefined); assert.deepEqual(verified.host, report.host);
  assert.deepEqual((await fs.readdir(distribution)).sort(), ['Class', 'THIRD_PARTY_NOTICES.txt']);
  report.checks.copiedApplicationPassedRealHttpWorkflow = true; report.checks.embeddedFrontendAssetsAvailable = true; report.memoryChecks = verified.checks; report.memoryReport = memoryReport; report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack || error.message; process.exitCode = 1; }
finally {
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      await stopLinuxOwnedTree(identity); report.cleanup.forcedOwnedProcessTreeStop = true;
      let timer; try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned verifier did not exit after termination')), 10000); })]); } finally { clearTimeout(timer); }
    }
  } catch (error) { child?.stdout.destroy(); child?.stderr.destroy(); child?.unref(); report.cleanup.error = error.message; report.passed = false; process.exitCode = 1; }
  try {
    const actual = await fs.realpath(directory); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('class-linux-portable-')); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    for (const folder of [distribution, runtimeHome]) { try { const target = await fs.realpath(folder); assert.equal(path.dirname(target), actual); assert.equal((await fs.lstat(folder)).isSymbolicLink(), false); await fs.rm(target, { recursive: true, force: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    report.cleanup.isolatedFilesRemoved = true;
  } catch (error) { report.cleanup.error = error.message; report.passed = false; process.exitCode = 1; }
  if (report.cleanup.forcedOwnedProcessTreeStop) { report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await fs.mkdir(path.dirname(reportFile), { recursive: true }); await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, host: report.host, checks: report.checks, cleanup: report.cleanup, report: reportFile, ...(report.error ? { error: report.error } : {}) }, null, 2));
}
