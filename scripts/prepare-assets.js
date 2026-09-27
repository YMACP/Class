import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDirectoryPicker } from './build-directory-picker.js';
import { embedUi } from './embed-ui.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function prepareAssets({ platform = process.platform, architecture = process.arch } = {}) {
  if (platform === 'win32') buildDirectoryPicker({ architecture });
  else if (platform === 'linux') {
    const file = path.join(root, 'build', 'generated', 'directory-picker.generated.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, '// Linux uses the installed zenity or kdialog chooser; no Windows binary is embedded.\nexport const DIRECTORY_PICKER_BINARY = null;\n');
    fs.renameSync(temporary, file);
  } else throw new Error('Class currently builds for Windows and Linux only.');
  return embedUi();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`Prepared application assets: ${prepareAssets()}`);
