import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function writeAtomically(target, data) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function findArm64Compiler() {
  if (process.env.CLASS_CSC_EXECUTABLE) {
    const compiler = process.env.CLASS_CSC_EXECUTABLE;
    if (!path.isAbsolute(compiler) || !fs.existsSync(compiler) || !fs.statSync(compiler).isFile()) {
      throw new Error('CLASS_CSC_EXECUTABLE must be an absolute path to a Roslyn csc.exe that supports /platform:arm64.');
    }
    return compiler;
  }
  const installers = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
    .map(directory => path.join(directory, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'));
  for (const installer of [...new Set(installers)]) {
    if (!fs.existsSync(installer)) continue;
    const result = spawnSync(installer, ['-all', '-products', '*', '-utf8', '-find', 'MSBuild\\**\\Bin\\Roslyn\\csc.exe'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) continue;
    const compiler = result.stdout.split(/\r?\n/).map(value => value.trim())
      .find(candidate => path.isAbsolute(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (compiler) return compiler;
  }
  throw new Error('Building the ARM64 directory picker requires Roslyn with /platform:arm64 support. Install compatible Visual Studio Build Tools, or set CLASS_CSC_EXECUTABLE to an existing Roslyn csc.exe (for example Microsoft.Net.Compilers.Toolset 4.14.0 tasks/net472/csc.exe).');
}

function findCompiler(architecture) {
  if (architecture === 'arm64') return findArm64Compiler();
  const windowsDirectory = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidates = ['Framework64', 'Framework'].map(framework =>
    path.join(windowsDirectory, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'));
  const compiler = candidates.find(candidate => fs.existsSync(candidate));
  if (!compiler) throw new Error('The Windows .NET Framework 4 C# compiler (csc.exe) is required to build the native folder picker.');
  return compiler;
}

export function buildDirectoryPicker({ architecture = process.arch } = {}) {
  if (process.platform !== 'win32') throw new Error('Build the native directory picker on Windows.');
  if (!['x64', 'arm64'].includes(architecture)) throw new Error('The directory picker architecture must be x64 or arm64.');
  const compiler = findCompiler(architecture);
  const icon = path.join(root, 'public', 'class-icon.ico');
  if (!fs.existsSync(icon)) throw new Error('Class icon is missing: public/class-icon.ico');
  const buildDirectory = path.join(root, 'build', 'native');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const manifest = path.join(buildDirectory, 'class-directory-picker.manifest');
  const manifestContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" name="Class.DirectoryPicker" type="win32" processorArchitecture="${architecture === 'arm64' ? 'arm64' : 'amd64'}" />
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false" /></requestedPrivileges></security></trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" /></application></compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>
    <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
    <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2,PerMonitor</dpiAwareness>
    <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
  </windowsSettings></application>
</assembly>
`;
  writeAtomically(manifest, manifestContent);
  const executable = path.join(buildDirectory, 'class-directory-picker.exe');
  const temporaryExecutable = path.join(buildDirectory, `class-directory-picker.${process.pid}.${randomUUID()}.exe`);
  try {
    const result = spawnSync(compiler, [
      '/nologo', '/target:winexe', `/platform:${architecture}`, '/optimize+', '/debug-', '/utf8output', '/codepage:65001',
      `/win32manifest:${manifest}`, `/win32icon:${icon}`, `/out:${temporaryExecutable}`,
      path.join(root, 'native', 'windows', 'FolderPicker.cs'),
    ], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw new Error(`Native directory picker compilation failed: ${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`);
    }
    const binary = fs.readFileSync(temporaryExecutable);
    const peOffset = binary.length >= 64 ? binary.readUInt32LE(0x3c) : 0;
    if (binary.toString('ascii', 0, 2) !== 'MZ' || peOffset < 64 || peOffset + 94 > binary.length ||
        binary.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' ||
        binary.readUInt16LE(peOffset + 4) !== (architecture === 'arm64' ? 0xaa64 : 0x8664) ||
        binary.readUInt16LE(peOffset + 24) !== 0x20b || binary.readUInt16LE(peOffset + 24 + 68) !== 2 ||
        !binary.includes(Buffer.from(manifestContent, 'utf8'))) {
      throw new Error(`The directory picker compiler did not produce a ${architecture} Windows GUI executable with the expected manifest.`);
    }
    fs.renameSync(temporaryExecutable, executable);
    const embedded = { sha256: createHash('sha256').update(binary).digest('hex'), base64: binary.toString('base64') };
    const generated = path.join(root, 'build', 'generated', 'directory-picker.generated.js');
    fs.mkdirSync(path.dirname(generated), { recursive: true });
    writeAtomically(generated, '// Generated by scripts/build-directory-picker.js. Edit native/windows/FolderPicker.cs instead.\n' +
      `export const DIRECTORY_PICKER_BINARY = ${JSON.stringify(embedded)};\n`);
    return generated;
  } finally {
    fs.rmSync(temporaryExecutable, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Embedded native directory picker: ${buildDirectoryPicker()}`);
}
