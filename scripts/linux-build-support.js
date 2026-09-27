import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { outsideSourceDirectory } from './release-paths.js';
import { linuxArchitecture, assertLinuxExecutable } from './linux-target.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeVersion = '1.4.2';
// Official npm tarballs verified against their package-lock SHA512 integrity.
const runtimeHashes = { amd64: 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c', arm64: '616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1' };
export function buildLinuxExecutable({ architecture, entry, output, definitions = [] }) {
  architecture = linuxArchitecture(architecture);
  if (!['win32', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('Use a Windows or Linux x64/ARM64 build host.');
  const directory = outsideSourceDirectory(path.dirname(path.resolve(output)));
  output = path.join(directory, path.basename(output));
  if (fs.existsSync(output)) {
    if (fs.lstatSync(output).isSymbolicLink()) throw new Error('Refusing to overwrite a linked Linux executable');
    assertLinuxExecutable(fs.readFileSync(output), architecture);
  }
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (packageInfo.version !== '1.0.0') throw new Error('Keep the Class release version at 1.0.0.');
  const suffix = process.arch === 'arm64' ? 'aarch64' : 'x64-baseline';
  const hostPackage = `bun-${process.platform === 'win32' ? 'windows' : 'linux'}-${suffix}`;
  const local = path.join(root, 'node_modules', '@oven', hostPackage, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  const bun = process.env.BUN_EXECUTABLE || process.env.BUN_EXE || (process.versions.bun ? process.execPath : fs.existsSync(local) ? local : 'bun');
  const check = spawnSync(bun, ['-e', 'console.log(JSON.stringify({file:process.execPath,version:Bun.version}))'], { cwd: root, windowsHide: true, encoding: 'utf8' });
  if (check.error || check.status !== 0) throw new Error('Install the locked build-host Bun, or set BUN_EXECUTABLE to its absolute path.');
  const host = JSON.parse(check.stdout.trim());
  if (host.version !== runtimeVersion) throw new Error(`Expected Bun ${runtimeVersion}; actual ${host.version}`);
  let targetRuntime = process.env.BUN_COMPILE_EXECUTABLE;
  if (!targetRuntime && process.platform === 'linux' && linuxArchitecture(process.arch) === architecture) targetRuntime = host.file;
  const compileParent = fs.realpathSync(os.tmpdir());
  if (process.platform === 'win32' && /[^\x00-\x7f]/.test(compileParent)) throw new Error('Set build-process TEMP and TMP to an ASCII-only directory.');
  const temporary = fs.mkdtempSync(path.join(compileParent, 'class-linux-compile-'));
  try {
    const compiler = path.join(temporary, process.platform === 'win32' ? 'bun.exe' : 'bun');
    fs.copyFileSync(host.file, compiler); if (process.platform !== 'win32') fs.chmodSync(compiler, 0o755);
    const runtimeArguments = [];
    if (targetRuntime) {
      if (!path.isAbsolute(targetRuntime)) throw new Error('BUN_COMPILE_EXECUTABLE must be an absolute path to the matching Bun 1.4.2 Linux runtime.');
      const runtimeBytes = fs.readFileSync(targetRuntime);
      assertLinuxExecutable(runtimeBytes, architecture);
      if (createHash('sha256').update(runtimeBytes).digest('hex') !== runtimeHashes[architecture]) throw new Error('The supplied compile runtime must be the official matching Linux Bun 1.4.2 binary.');
      const stagedRuntime = path.join(temporary, 'target-bun'); fs.copyFileSync(targetRuntime, stagedRuntime);
      runtimeArguments.push(`--compile-executable-path=${stagedRuntime}`);
    }
    const compiled = path.join(temporary, path.basename(output));
    const target = architecture === 'amd64' ? 'bun-linux-x64-baseline' : 'bun-linux-arm64';
    const result = spawnSync(compiler, ['build', path.join(root, entry), '--compile', `--target=${target}`, '--outfile', compiled,
      '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', ...definitions.map(value => '--define=' + value), ...runtimeArguments],
    { cwd: temporary, windowsHide: true, stdio: 'inherit', env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(compileParent, 'bun-cache') } });
    if (result.error || result.status !== 0) throw result.error || new Error(`Linux compilation failed (${result.status})`);
    const header = assertLinuxExecutable(fs.readFileSync(compiled), architecture);
    fs.mkdirSync(directory, { recursive: true });
    const staged = path.join(directory, `.${path.basename(output)}.${randomUUID()}.tmp`);
    let created = false;
    try {
      fs.copyFileSync(compiled, staged, fs.constants.COPYFILE_EXCL);
      created = true;
      if (process.platform !== 'win32') fs.chmodSync(staged, 0o755);
      fs.renameSync(staged, output);
      created = false;
    } finally { if (created) fs.rmSync(staged, { force: true }); }
    return { executable: output, version: packageInfo.version, runtimeVersion, bytes: fs.statSync(output).size, ...header, nativeRunVerified: false };
  } finally {
    const actual = fs.realpathSync(temporary);
    if (path.dirname(actual) !== compileParent || !path.basename(actual).startsWith('class-linux-compile-') || fs.lstatSync(temporary).isSymbolicLink()) throw new Error('Unexpected compiler temporary directory');
    fs.rmSync(actual, { recursive: true, force: true });
  }
}
