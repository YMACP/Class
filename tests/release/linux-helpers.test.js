// Pure fixture checks: these do not launch an application, browser, shell, VM,
// or Linux process. Run explicitly: node --test tests/release/linux-helpers.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { verifyNativeExecutable } from './windows-verification.js';
import { parseLinuxProcessStat } from './linux-process.js';
import { linuxArchitecture, linuxBuildOptions } from '../../scripts/linux-target.js';
import { windowsArchitecture, windowsBuildArchitecture } from '../../scripts/windows-target.js';
import { getReleaseDirectory, getLinuxReleaseDirectory } from '../../scripts/release-paths.js';
import { prepareAssets } from '../../scripts/prepare-assets.js';

function elf() {
  const bytes = Buffer.alloc(256), interpreter = Buffer.from('/lib64/ld-linux-x86-64.so.2\0');
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(bytes);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(2, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(0n, 72); bytes.writeBigUInt64LE(256n, 96);
  bytes.writeUInt32LE(3, 120); bytes.writeBigUInt64LE(192n, 128); bytes.writeBigUInt64LE(BigInt(interpreter.length), 152); interpreter.copy(bytes, 192);
  return bytes;
}
const linux = () => ({ platform: 'linux', expectedArchitecture: 'amd64', architecture: 'x64', osArchitecture: 'amd64' });

test('Linux native acceptance normalizes x64/amd64 and rejects mismatched kernel/runtime', () => {
  assert.equal(verifyNativeExecutable(elf(), linux()).architecture, 'amd64');
  assert.throws(() => verifyNativeExecutable(elf(), { ...linux(), architecture: 'ia32' }), /architecture/);
  assert.throws(() => verifyNativeExecutable(elf(), { ...linux(), osArchitecture: 'ia32' }), /architecture/);
  const incompatibleMachine = elf(); incompatibleMachine.writeUInt16LE(3, 18);
  assert.throws(() => verifyNativeExecutable(incompatibleMachine, linux()), /ELF64/);
});

test('Linux native guard rejects incompatible endianness and non-glibc loader', () => {
  const bigEndian = elf(); bigEndian[5] = 2;
  assert.throws(() => verifyNativeExecutable(bigEndian, linux()), /little-endian/);
  const otherLoader = elf(); otherLoader[197] = 'x'.charCodeAt(0);
  assert.throws(() => verifyNativeExecutable(otherLoader, linux()), /glibc loader/);
});

test('Windows native executable and runtime checks remain strict', () => {
  const bytes = Buffer.alloc(512); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0x20b, 88); bytes.writeUInt16LE(2, 156);
  const host = { platform: 'win32', expectedArchitecture: 'x64', architecture: 'x64', osArchitecture: 'x64' };
  assert.equal(verifyNativeExecutable(bytes, host).architecture, 'x64');
  assert.throws(() => verifyNativeExecutable(bytes, { ...host, architecture: 'ia32' }), /runtime/);
  assert.throws(() => verifyNativeExecutable(bytes, { ...host, osArchitecture: 'ia32' }), /host/);
  assert.throws(() => verifyNativeExecutable(bytes, { ...host, platform: 'darwin' }), /Windows/);
  const incompatibleMachine = Buffer.from(bytes); incompatibleMachine.writeUInt16LE(0x014c, 68);
  assert.throws(() => verifyNativeExecutable(incompatibleMachine, host), /PE32\+/);
  bytes.writeUInt16LE(3, 156); assert.throws(() => verifyNativeExecutable(bytes, host), /GUI/);
});

test('Build targets accept only the supported Windows and Linux architectures', () => {
  assert.equal(windowsArchitecture('x64'), 'x64');
  assert.equal(windowsBuildArchitecture(['--arch', 'x64']), 'x64');
  assert.equal(windowsBuildArchitecture(['--arch=x64']), 'x64');
  for (const value of ['x64', 'amd64']) {
    assert.equal(linuxArchitecture(value), 'amd64');
    assert.equal(linuxBuildOptions(['--arch', value]).architecture, 'amd64');
    assert.equal(linuxBuildOptions(['--arch=' + value]).architecture, 'amd64');
  }
  assert.throws(() => windowsArchitecture('ia32'), /architecture/);
  assert.throws(() => windowsBuildArchitecture(['--arch', 'ia32']), /architecture/);
  assert.throws(() => linuxArchitecture('ia32'), /architecture/);
  assert.throws(() => linuxBuildOptions(['--arch', 'ia32']), /architecture/);
});

test('A custom release directory cannot bypass target validation', () => {
  const previous = process.env.CLASS_RELEASE_DIR;
  process.env.CLASS_RELEASE_DIR = os.tmpdir();
  try {
    assert.throws(() => getReleaseDirectory('ia32'), /architecture/);
    assert.throws(() => getLinuxReleaseDirectory('ia32'), /architecture/);
  } finally {
    if (previous === undefined) delete process.env.CLASS_RELEASE_DIR;
    else process.env.CLASS_RELEASE_DIR = previous;
  }
});

test('Asset preparation rejects unsupported targets before generating files', () => {
  assert.throws(() => prepareAssets({ platform: 'linux', architecture: 'ia32' }), /architecture/);
  // The Windows picker checks the build host before checking its target.
  assert.throws(() => prepareAssets({ platform: 'win32', architecture: 'ia32' }),
    process.platform === 'win32' ? /architecture/ : /Build the native directory picker on Windows/);
  assert.throws(() => prepareAssets({ platform: 'darwin', architecture: 'x64' }), /Windows and Linux/);
});

test('Linux process identity parsing handles parentheses/spaces in the executable name', () => {
  const fields = Array(25).fill('0'); fields[0] = 'T'; fields[1] = '1'; fields[2] = '42'; fields[19] = '9001';
  assert.deepEqual(parseLinuxProcessStat('42 (Class (test child)) ' + fields.join(' ')), { pid: 42, state: 'T', parent: 1, group: 42, started: '9001' });
  assert.throws(() => parseLinuxProcessStat('not a process identity'), /Invalid Linux process stat/);
});
