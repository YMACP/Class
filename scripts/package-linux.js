import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { linuxBuildOptions, assertLinuxExecutable } from './linux-target.js';
import { getLinuxReleaseDirectory } from './release-paths.js';
import { writeReleaseFile } from './release-files.js';

// Explicit USTAR modes preserve Linux executable permissions on Windows build hosts.
// Only this allowlisted flat distribution is archived; no profile/source/cache files.
const { architecture } = linuxBuildOptions();
const directory = getLinuxReleaseDirectory(architecture), parent = path.dirname(directory);
const executable = path.join(directory, 'Class');
assertLinuxExecutable(fs.readFileSync(executable), architecture);
const manifestBytes = fs.readFileSync(path.join(directory, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (manifest.version !== '1.0.0' || manifest.architecture !== architecture || manifest.executable !== 'Class') throw new Error('The Linux release manifest does not match the requested target');
const names = ['Class', 'README.txt', 'THIRD_PARTY_NOTICES.txt', 'manifest.json'];
const expectedHashes = new Map([['manifest.json', createHash('sha256').update(manifestBytes).digest('hex')]]);
const digest = async file => { const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
for (const name of names) {
  const file = path.join(directory, name), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error(`Invalid distribution file ${name}`);
  if (name !== 'manifest.json') {
    const record = manifest.files?.find(value => value.name === name);
    if (!record || record.bytes !== stat.size || record.sha256 !== await digest(file)) throw new Error(`Distribution changed since build: ${name}`);
    expectedHashes.set(name, record.sha256);
  }
}
function header(name, size, mode) {
  const block = Buffer.alloc(512);
  const octal = (offset, length, value) => {
    const text = value.toString(8);
    if (text.length >= length) throw new Error('Archive field exceeds USTAR limit');
    block.write(text.padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  };
  block.write(name, 0, 100, 'ascii'); octal(100, 8, mode); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, size); octal(136, 12, 0);
  block.fill(0x20, 148, 156); block[156] = 0x30; block.write('ustar\0', 257, 6, 'ascii'); block.write('00', 263, 2, 'ascii');
  const checksum = block.reduce((total, byte) => total + byte, 0);
  block.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return block;
}
async function* archiveEntries() {
  for (const name of names) {
    const file = path.join(directory, name), before = fs.statSync(file);
    yield header(name, before.size, name === 'Class' ? 0o755 : 0o644);
    let read = 0; const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) { read += chunk.length; hash.update(chunk); yield chunk; }
    const after = fs.statSync(file);
    if (read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || hash.digest('hex') !== expectedHashes.get(name)) throw new Error(`File changed during packaging: ${name}`);
    if (read % 512) yield Buffer.alloc(512 - read % 512);
  }
  yield Buffer.alloc(1024);
}
const filename = `Class-1.0.0-linux-${architecture}.tar.gz`, archive = path.join(parent, filename), temporary = `${archive}.${randomUUID()}.tmp`;
if (fs.existsSync(archive) && fs.lstatSync(archive).isSymbolicLink()) throw new Error('Refusing to replace a linked archive');
try {
  await pipeline(Readable.from(archiveEntries()), createGzip({ level: 9 }), fs.createWriteStream(temporary, { flags: 'wx' }));
  fs.renameSync(temporary, archive);
} finally { fs.rmSync(temporary, { force: true }); }
const sums = `${await digest(executable)}  ${path.basename(directory)}/Class\n${await digest(archive)}  ${filename}\n`;
writeReleaseFile(path.join(parent, `SHA256SUMS-linux-${architecture}.txt`), sums);
console.log(JSON.stringify({ archive, bytes: fs.statSync(archive).size, architecture, version: '1.0.0', sha256: await digest(archive), nativeRunVerified: false }, null, 2));
