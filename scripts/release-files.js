import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { outsideSourceDirectory } from './release-paths.js';

export function writeReleaseFile(filename, bytes) {
  const directory = outsideSourceDirectory(path.dirname(filename));
  filename = path.join(directory, path.basename(filename));
  if (fs.existsSync(filename) && (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink())) throw new Error('Refusing to replace a linked or non-file release sidecar');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let descriptor, created = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o644); created = true;
    fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, filename); created = false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) fs.rmSync(temporary, { force: true });
  }
}
