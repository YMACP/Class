import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { linuxBuildOptions } from './linux-target.js';
import { getLinuxReleaseDirectory } from './release-paths.js';
import { prepareAssets } from './prepare-assets.js';
import { buildLinuxExecutable, root } from './linux-build-support.js';
import { writeReleaseFile } from './release-files.js';

const { architecture } = linuxBuildOptions();
const directory = getLinuxReleaseDirectory(architecture);
prepareAssets({ platform: 'linux', architecture });
const result = buildLinuxExecutable({ architecture, entry: 'src/desktop.js', output: path.join(directory, 'Class') });
const notices = ['README.md', 'Bun-LICENSE.txt', 'unpdf-MIT.txt', 'PDFjs-Apache-2.0.txt'].map(name => fs.readFileSync(path.join(root, 'licenses', name), 'utf8')).join('\n\n');
writeReleaseFile(path.join(directory, 'THIRD_PARTY_NOTICES.txt'), notices);
writeReleaseFile(path.join(directory, 'README.txt'), fs.readFileSync(path.join(root, 'docs', 'linux-release.txt')));
const manifest = { ...result, executable: 'Class', files: ['Class', 'README.txt', 'THIRD_PARTY_NOTICES.txt'].map(name => ({ name, bytes: fs.statSync(path.join(directory, name)).size, sha256: createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex') })) };
writeReleaseFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
