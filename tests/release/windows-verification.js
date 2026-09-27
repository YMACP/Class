import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { windowsArchitecture, assertWindowsExecutable } from '../../scripts/windows-target.js';
import { linuxArchitecture, assertLinuxExecutable } from '../../scripts/linux-target.js';
import { getReleaseDirectory } from '../../scripts/release-paths.js';

export function standaloneVerifier() { return globalThis.__classStandaloneVerifier === true; }

export function verificationRoot(moduleUrl) {
  return standaloneVerifier() ? path.dirname(process.execPath) : path.resolve(path.dirname(fileURLToPath(moduleUrl)), '../..');
}

export function verifierCommand(suite, args) {
  const scripts = { release: 'verify-release.js', memory: 'verify-memory-release.js', ui: 'verify-memory-ui.js', portable: 'verify-portable.js', platform: 'verify-platform.js', recovery: 'verify-startup-recovery.js', browser: 'verify-browser-compatibility.js' };
  if (process.platform === 'linux') Object.assign(scripts, { portable: 'verify-linux-portable.js', platform: 'verify-linux-platform.js' });
  assert.ok(Object.hasOwn(scripts, suite), 'Unknown release verification suite');
  return { executable: process.execPath, args: standaloneVerifier() ? ['--suite', suite, ...args] : [path.join(verificationRoot(import.meta.url), 'tests', 'release', scripts[suite]), ...args] };
}

export function defaultVerificationExecutable() {
  if (standaloneVerifier()) return path.join(path.dirname(process.execPath), process.platform === 'linux' ? 'Class' : 'Class.exe');
  if (process.platform === 'linux') return path.join(path.resolve(process.env.CLASS_RELEASE_DIR || path.join(verificationRoot(import.meta.url), '..', 'class-releases', 'linux-' + linuxArchitecture(process.env.CLASS_LINUX_ARCH || process.arch))), 'Class');
  return path.join(getReleaseDirectory(), 'Class.exe');
}

// A cross-build is a file check. Release acceptance additionally requires the
// verifier to run natively on the target Windows architecture.
export function verificationHost() {
  if (process.platform === 'linux') {
    const machine = os.machine();
    return { expectedArchitecture: linuxArchitecture(process.env.CLASS_LINUX_ARCH || process.arch), platform: process.platform, architecture: process.arch, osArchitecture: ({ x86_64: 'amd64', aarch64: 'arm64' })[machine] || machine, runtime: process.versions.bun ? 'bun' : 'node', runtimeVersion: process.versions.bun || process.versions.node };
  }
  const declared = process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || process.arch;
  return {
    expectedArchitecture: windowsArchitecture(),
    platform: process.platform,
    architecture: process.arch,
    osArchitecture: ({ AMD64: 'x64', ARM64: 'arm64', x86: 'ia32' })[declared] || declared,
    runtime: process.versions.bun ? 'bun' : 'node',
    runtimeVersion: process.versions.bun || process.versions.node,
  };
}

export function verifyNativeExecutable(bytes, host = verificationHost()) {
  if (host.platform === 'linux') {
    const artifact = assertLinuxExecutable(bytes, host.expectedArchitecture);
    assert.equal(linuxArchitecture(host.architecture), host.expectedArchitecture, 'Linux verifier runtime architecture must match the native target');
    assert.equal(linuxArchitecture(host.osArchitecture), host.expectedArchitecture, 'Linux kernel architecture must match the native target; emulation is not native acceptance');
    return artifact;
  }
  const artifact = assertWindowsExecutable(bytes, host.expectedArchitecture);
  assert.equal(host.platform, 'win32', 'Executable acceptance requires Windows');
  assert.equal(host.architecture, host.expectedArchitecture,
    `Native ${host.expectedArchitecture} acceptance requires a ${host.expectedArchitecture} verifier runtime; actual runtime is ${host.architecture}. A cross-build does not prove native execution.`);
  assert.equal(host.osArchitecture, host.expectedArchitecture,
    `Expected a native Windows ${host.expectedArchitecture} host; OS reports ${host.osArchitecture}`);
  return artifact;
}
