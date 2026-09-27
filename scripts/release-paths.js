import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsArchitecture } from './windows-target.js';
import { linuxArchitecture } from './linux-target.js';

export const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Release binaries must stay outside the source tree, including through a junction.
export function getReleaseDirectory(architecture = windowsArchitecture()) {
  return outsideSourceDirectory(process.env.CLASS_RELEASE_DIR || path.join(sourceRoot, '..', 'class-releases', `windows-${windowsArchitecture(architecture)}`));
}

export function getLinuxReleaseDirectory(architecture = linuxArchitecture()) {
  return outsideSourceDirectory(process.env.CLASS_RELEASE_DIR || path.join(sourceRoot, '..', 'class-releases', `linux-${linuxArchitecture(architecture)}`));
}

export function outsideSourceDirectory(directory) {
  const output = path.resolve(directory);
  let ancestor = output;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('The release output drive does not exist.');
    ancestor = parent;
  }
  if (!fs.statSync(ancestor).isDirectory()) throw new Error('The release output path contains a file instead of a directory.');
  const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, output));
  const relative = path.relative(fs.realpathSync(sourceRoot), resolved);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('CLASS_RELEASE_DIR must be outside the Class source directory.');
  }
  return resolved;
}
