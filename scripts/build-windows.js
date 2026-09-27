import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { embedUi } from './embed-ui.js';
import { buildDirectoryPicker } from './build-directory-picker.js';
import { getReleaseDirectory } from './release-paths.js';
import { windowsArchitecture, windowsBuildArchitecture, assertWindowsExecutable } from './windows-target.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('Build the Windows releases on Windows.');
const architecture = windowsBuildArchitecture();
const hostArchitecture = windowsArchitecture(process.arch);
const releaseDirectory = getReleaseDirectory(architecture);
const output = path.join(releaseDirectory, 'Class.exe');
if (fs.existsSync(output)) assertWindowsExecutable(fs.readFileSync(output), architecture);
const localBun = path.join(root, 'node_modules', '@oven', hostArchitecture === 'arm64' ? 'bun-windows-aarch64' : 'bun-windows-x64-baseline', 'bin', 'bun.exe');
const bun = process.env.BUN_EXECUTABLE || process.env.BUN_EXE || (process.versions.bun ? process.execPath : fs.existsSync(localBun) ? localBun : 'bun');
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const check = spawnSync(bun, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (check.error || check.status !== 0) {
  console.error('Bun was not found. Install Bun, or set BUN_EXECUTABLE to the absolute path of bun.exe.');
  process.exit(1);
}
console.log(`Building Class for Windows ${architecture} with Bun ${check.stdout.trim()}`);
buildDirectoryPicker({ architecture });
embedUi();
fs.mkdirSync(releaseDirectory, { recursive: true });
const stagedOutput = path.join(releaseDirectory, '.Class.build.exe');
const icon = path.join(root, 'public', 'class-icon.ico');
if (!fs.existsSync(icon)) throw new Error('Class icon is missing: public/class-icon.ico');
// Bun 1.4.2's Windows compiler fails with ENOENT when its executable or
// compilation working directory contains non-ASCII characters. Source paths
// can remain in place; only the compiler and its output need a temporary home.
const tempParent = fs.realpathSync(os.tmpdir());
if (process.platform === 'win32' && /[^\x00-\x7f]/.test(tempParent)) {
  throw new Error('Set TEMP and TMP to an ASCII-only directory before building Class.');
}
const compileDirectory = fs.mkdtempSync(path.join(tempParent, 'class-compile-'));
try {
  const executablePath = spawnSync(bun, ['-e', 'console.log(process.execPath)'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (executablePath.error || executablePath.status !== 0) throw new Error('Unable to resolve the Bun executable');
  const compiler = path.join(compileDirectory, process.platform === 'win32' ? 'bun.exe' : 'bun');
  fs.copyFileSync(executablePath.stdout.trim(), compiler);
  const compiledOutput = path.join(compileDirectory, 'Class.exe');
  const targetArguments = [];
  if (process.env.BUN_COMPILE_EXECUTABLE) {
    if (!path.isAbsolute(process.env.BUN_COMPILE_EXECUTABLE)) throw new Error('BUN_COMPILE_EXECUTABLE must be an absolute path to the matching Bun runtime.');
    const targetRuntime = fs.readFileSync(process.env.BUN_COMPILE_EXECUTABLE);
    const targetPe = targetRuntime.length >= 64 ? targetRuntime.readUInt32LE(0x3c) : 0;
    if (targetRuntime.toString('ascii', 0, 2) !== 'MZ' || targetPe < 64 || targetPe + 26 > targetRuntime.length ||
        targetRuntime.toString('ascii', targetPe, targetPe + 4) !== 'PE\0\0' ||
        targetRuntime.readUInt16LE(targetPe + 4) !== (architecture === 'arm64' ? 0xaa64 : 0x8664) ||
        targetRuntime.readUInt16LE(targetPe + 24) !== 0x20b) throw new Error('The supplied Bun compile runtime has the wrong Windows architecture.');
    const stagedRuntime = path.join(compileDirectory, 'target-bun.exe');
    fs.writeFileSync(stagedRuntime, targetRuntime);
    targetArguments.push(`--compile-executable-path=${stagedRuntime}`);
  }
  const result = spawnSync(compiler, [
    'build', path.join(root, 'src', 'desktop.js'),
    '--compile', `--target=${architecture === 'arm64' ? 'bun-windows-arm64' : 'bun-windows-x64-baseline'}`, '--outfile', compiledOutput,
    '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
    '--windows-hide-console',
    '--windows-title=Class', `--windows-version=${packageInfo.version}.0`,
    '--windows-description=Class multi-agent desktop harness', `--windows-icon=${icon}`,
    ...targetArguments,
  ], { cwd: compileDirectory, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Bun compilation failed (${result.status})`);
  if (!fs.existsSync(compiledOutput)) throw new Error('Build completed without producing Class.exe');
  fs.copyFileSync(compiledOutput, stagedOutput);
} finally {
  const resolved = fs.realpathSync(compileDirectory);
  if (path.dirname(resolved) !== tempParent || !path.basename(resolved).startsWith('class-compile-')) throw new Error('Unexpected compiler temporary directory');
  fs.rmSync(resolved, { recursive: true, force: true });
}
// Bun 1.3.x may hide its console at runtime while leaving the PE subsystem as CUI.
// Mark the executable as a GUI application too, so Windows never creates that console.
const executable = fs.readFileSync(stagedOutput);
if (executable.toString('ascii', 0, 2) !== 'MZ') throw new Error('Compiled output is not a Windows executable');
const peOffset = executable.readUInt32LE(0x3c);
if (peOffset < 64 || peOffset + 94 > executable.length || executable.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' || executable.readUInt16LE(peOffset + 4) !== (architecture === 'arm64' ? 0xaa64 : 0x8664) || executable.readUInt16LE(peOffset + 24) !== 0x20b) throw new Error(`Expected a Windows ${architecture} PE executable`);
executable.writeUInt16LE(2, peOffset + 24 + 68); // IMAGE_SUBSYSTEM_WINDOWS_GUI
executable.writeUInt32LE(0, peOffset + 24 + 64); // Optional checksum; avoid a stale value after the header update.
assertWindowsExecutable(executable, architecture);
fs.writeFileSync(stagedOutput, executable);
const notices = ['README.md', 'Bun-LICENSE.txt', 'unpdf-MIT.txt', 'PDFjs-Apache-2.0.txt']
  .map(name => fs.readFileSync(path.join(root, 'licenses', name), 'utf8')).join('\n\n');
fs.renameSync(stagedOutput, output);
fs.writeFileSync(path.join(releaseDirectory, 'THIRD_PARTY_NOTICES.txt'), notices);
fs.copyFileSync(path.join(root, 'docs', architecture === 'arm64' ? 'windows-arm64-release.txt' : 'windows-release.txt'), path.join(releaseDirectory, 'README.txt'));
console.log(`Ready: ${output} (${(fs.statSync(output).size / 1048576).toFixed(1)} MiB)`);
