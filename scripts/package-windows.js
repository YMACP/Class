import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sourceRoot, getReleaseDirectory } from './release-paths.js';
import { windowsBuildArchitecture, assertWindowsExecutable } from './windows-target.js';

if (process.platform !== 'win32') throw new Error('Package the Windows release on Windows.');
const architecture = windowsBuildArchitecture();
const directory = getReleaseDirectory(architecture);
const version = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
const files = ['Class.exe', 'THIRD_PARTY_NOTICES.txt', 'README.txt'];
for (const name of files) {
  if (!fs.statSync(path.join(directory, name)).isFile()) throw new Error(`Missing release file: ${name}`);
}
const executable = fs.readFileSync(path.join(directory, 'Class.exe'));
assertWindowsExecutable(executable, architecture);
const archive = path.join(path.dirname(directory), `Class-${version}-windows-${architecture}.zip`);
const stagedArchive = archive.replace(/\.zip$/, `.${process.pid}.tmp.zip`);
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
try {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; $items = @("Class.exe", "THIRD_PARTY_NOTICES.txt", "README.txt") | ForEach-Object { Join-Path $env:CLASS_PACKAGE_INPUT $_ }; Compress-Archive -LiteralPath $items -DestinationPath $env:CLASS_PACKAGE_OUTPUT -CompressionLevel Optimal'], {
    windowsHide: true, stdio: 'inherit', env: { ...process.env, CLASS_PACKAGE_INPUT: directory, CLASS_PACKAGE_OUTPUT: stagedArchive },
  });
  if (result.error || result.status !== 0) throw new Error(`Packaging failed: ${result.error?.message || result.status}`);
  fs.renameSync(stagedArchive, archive);
} finally {
  fs.rmSync(stagedArchive, { force: true });
}
const hashes = [path.join(directory, 'Class.exe'), archive].map(file =>
  `${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.relative(path.dirname(directory), file).split(path.sep).join('/')}`).join('\n') + '\n';
fs.writeFileSync(path.join(path.dirname(directory), `SHA256SUMS-windows-${architecture}.txt`), hashes);
// Keep the original x64 checksum entrypoint for existing release scripts.
if (architecture === 'x64') fs.writeFileSync(path.join(path.dirname(directory), 'SHA256SUMS.txt'), hashes);
console.log(`Packaged: ${archive}`);
