// Pure fixture checks: these do not launch an application, browser, shell, VM,
// or Linux process. Run explicitly: node --test tests/release/linux-helpers.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNativeExecutable } from './windows-verification.js';
import { parseLinuxProcessStat } from './linux-process.js';

function elf(architecture) {
  const bytes = Buffer.alloc(256), interpreter = Buffer.from((architecture === 'amd64' ? '/lib64/ld-linux-x86-64.so.2' : '/lib/ld-linux-aarch64.so.1') + '\0');
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(bytes);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(architecture === 'amd64' ? 62 : 183, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(2, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(0n, 72); bytes.writeBigUInt64LE(256n, 96);
  bytes.writeUInt32LE(3, 120); bytes.writeBigUInt64LE(192n, 128); bytes.writeBigUInt64LE(BigInt(interpreter.length), 152); interpreter.copy(bytes, 192);
  return bytes;
}
const linux = architecture => ({ platform: 'linux', expectedArchitecture: architecture, architecture: architecture === 'amd64' ? 'x64' : 'arm64', osArchitecture: architecture });

test('Linux native acceptance normalizes x64/amd64 and rejects mismatched kernel/runtime', () => {
  for (const architecture of ['amd64', 'arm64']) assert.equal(verifyNativeExecutable(elf(architecture), linux(architecture)).architecture, architecture);
  assert.throws(() => verifyNativeExecutable(elf('arm64'), { ...linux('arm64'), architecture: 'x64' }), /runtime architecture/);
  assert.throws(() => verifyNativeExecutable(elf('arm64'), { ...linux('arm64'), osArchitecture: 'amd64' }), /kernel architecture/);
  assert.throws(() => verifyNativeExecutable(elf('amd64'), linux('arm64')), /ELF64/);
});

test('Linux native guard rejects incompatible endianness and non-glibc loader', () => {
  const bigEndian = elf('amd64'); bigEndian[5] = 2;
  assert.throws(() => verifyNativeExecutable(bigEndian, linux('amd64')), /little-endian/);
  const otherLoader = elf('amd64'); otherLoader[197] = 'x'.charCodeAt(0);
  assert.throws(() => verifyNativeExecutable(otherLoader, linux('amd64')), /glibc loader/);
});

test('Windows native executable and runtime checks remain strict', () => {
  const bytes = Buffer.alloc(512); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0x20b, 88); bytes.writeUInt16LE(2, 156);
  const host = { platform: 'win32', expectedArchitecture: 'x64', architecture: 'x64', osArchitecture: 'x64' };
  assert.equal(verifyNativeExecutable(bytes, host).architecture, 'x64');
  assert.throws(() => verifyNativeExecutable(bytes, { ...host, architecture: 'arm64' }), /runtime/);
  assert.throws(() => verifyNativeExecutable(bytes, { ...host, osArchitecture: 'arm64' }), /host/);
  bytes.writeUInt16LE(3, 156); assert.throws(() => verifyNativeExecutable(bytes, host), /GUI/);
});

test('Linux process identity parsing handles parentheses/spaces in the executable name', () => {
  const fields = Array(25).fill('0'); fields[0] = 'T'; fields[1] = '1'; fields[2] = '42'; fields[19] = '9001';
  assert.deepEqual(parseLinuxProcessStat('42 (Class (test child)) ' + fields.join(' ')), { pid: 42, state: 'T', parent: 1, group: 42, started: '9001' });
  assert.throws(() => parseLinuxProcessStat('not a process identity'), /Invalid Linux process stat/);
});
