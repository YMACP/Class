import path from 'node:path';
import { linuxBuildOptions } from './linux-target.js';
import { prepareAssets } from './prepare-assets.js';
import { buildLinuxExecutable, root } from './linux-build-support.js';

const { architecture, out } = linuxBuildOptions(undefined, { allowOutput: true });
const output = path.resolve(out || path.join(root, '..', 'class-verification', `linux-${architecture}`, 'Class.Verify'));
if (path.basename(output) !== 'Class.Verify') throw new Error('The dedicated Linux verifier must be named Class.Verify.');
prepareAssets({ platform: 'linux', architecture });
console.log(JSON.stringify(buildLinuxExecutable({ architecture, entry: 'tests/release/standalone-verifier.js', output, definitions: ['CLASS_VERIFIER_COMPILED=true'] }), null, 2));
