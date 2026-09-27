// Build the dedicated test driver only. Application builds and package metadata
// are separate; this script never changes Class.exe, profiles, or business code.
// node scripts/build-verifier.js --arch x64|arm64 --out <outside-source>/Class.Verify.exe
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsArchitecture } from './windows-target.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i], value = args[i + 1];
  if (!['--arch', '--out'].includes(key) || !value || value.startsWith('--')) throw Error('Usage: node scripts/build-verifier.js --arch x64|arm64 --out <directory>/Class.Verify.exe');
  options[key.slice(2)] = value;
}
if (process.platform !== 'win32') throw Error('Build the Windows verification driver on Windows.');
const architecture = windowsArchitecture(options.arch), output = path.resolve(options.out || path.join(root, '..', 'class-verification', 'windows-' + architecture, 'Class.Verify.exe'));
if (path.basename(output) !== 'Class.Verify.exe') throw Error('The dedicated verifier output must be named Class.Verify.exe');
function inside(parent, target) { const rel = path.relative(parent, target); return !rel || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); }
let ancestor = path.dirname(output); while (!fs.existsSync(ancestor)) { const parent = path.dirname(ancestor); if (parent === ancestor) throw Error('Verifier output drive does not exist'); ancestor = parent; }
const resolvedOutput = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, output));
if (inside(fs.realpathSync(root), resolvedOutput)) throw Error('Verifier output must stay outside the source directory, including junction targets');
if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw Error('Refusing to overwrite a linked verifier executable');
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (packageInfo.version !== '1.0.0') throw Error('The current verification package must retain version 1.0.0');
const localBun = path.join(root, 'node_modules', '@oven', process.arch === 'arm64' ? 'bun-windows-aarch64' : 'bun-windows-x64-baseline', 'bin', 'bun.exe');
const bun = process.env.BUN_EXECUTABLE || process.env.BUN_EXE || (process.versions.bun ? process.execPath : fs.existsSync(localBun) ? localBun : 'bun');
const resolved = spawnSync(bun, ['-e', 'console.log(process.execPath)'], { cwd: root, windowsHide: true, encoding: 'utf8' });
if (resolved.error || resolved.status !== 0) throw Error('A build-host Bun executable is required; set BUN_EXECUTABLE. Target users do not install Bun.');
const tempParent = fs.realpathSync(os.tmpdir());
if (/[^\x00-\x7f]/.test(tempParent)) throw Error('Set build-process TEMP and TMP to an ASCII-only owned directory.');
const temporary = fs.mkdtempSync(path.join(tempParent, 'class-verifier-compile-'));
function pe(bytes, target) {
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0;
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || offset < 64 || offset + 94 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' || bytes.readUInt16LE(offset + 4) !== (target === 'arm64' ? 0xaa64 : 0x8664) || bytes.readUInt16LE(offset + 24) !== 0x20b) throw Error('Expected a Windows ' + target + ' PE32+ executable');
  return { offset, machine: bytes.readUInt16LE(offset + 4), subsystem: bytes.readUInt16LE(offset + 24 + 68) };
}
try {
  const compiler = path.join(temporary, 'bun.exe'), compiled = path.join(temporary, 'Class.Verify.exe');
  fs.copyFileSync(resolved.stdout.trim(), compiler);
  const runtime = process.env.BUN_COMPILE_EXECUTABLE || (architecture === process.arch ? resolved.stdout.trim() : null);
  if (!runtime || !path.isAbsolute(runtime)) throw Error('Set BUN_COMPILE_EXECUTABLE to an existing matching target Bun runtime. This verifier build does not download a runtime.');
  pe(fs.readFileSync(runtime), architecture);
  const stagedRuntime = path.join(temporary, 'target-bun.exe'); fs.copyFileSync(runtime, stagedRuntime);
  const result = spawnSync(compiler, ['build', path.join(root, 'tests', 'release', 'standalone-verifier.js'), '--compile', '--target=' + (architecture === 'arm64' ? 'bun-windows-arm64' : 'bun-windows-x64-baseline'), '--compile-executable-path=' + stagedRuntime, '--define=CLASS_VERIFIER_COMPILED=true', '--outfile', compiled, '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--windows-title=Class Verify', '--windows-version=1.0.0.0', '--windows-description=Class dedicated release acceptance driver'], { cwd: temporary, windowsHide: true, stdio: 'inherit', env: { ...process.env, TEMP: tempParent, TMP: tempParent, TMPDIR: tempParent, BUN_INSTALL_CACHE_DIR: path.join(tempParent, 'bun-cache') } });
  if (result.error || result.status !== 0) throw result.error || Error('Verifier compilation failed: ' + result.status);
  const bytes = fs.readFileSync(compiled), header = pe(bytes, architecture);
  if (header.subsystem !== 3) throw Error('The dedicated test driver must remain a console program, not the Class GUI');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(compiled, output);
  console.log(JSON.stringify({ executable: output, architecture, version: packageInfo.version, bytes: bytes.length, subsystem: header.subsystem, applicationUnchanged: true }, null, 2));
} finally {
  const actual = fs.realpathSync(temporary);
  if (path.dirname(actual) !== tempParent || !path.basename(actual).startsWith('class-verifier-compile-') || fs.lstatSync(temporary).isSymbolicLink()) throw Error('Unexpected owned verifier compilation directory');
  fs.rmSync(actual, { recursive: true, force: true });
}
