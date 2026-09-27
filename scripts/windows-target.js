export function windowsArchitecture(value = process.env.CLASS_WINDOWS_ARCH || process.arch) {
  if (!['x64', 'arm64'].includes(value)) throw new Error(`Unsupported Windows architecture: ${value}. Use x64 or arm64.`);
  return value;
}

export function windowsBuildArchitecture(args = process.argv.slice(2)) {
  if (!args.length) return windowsArchitecture();
  if (args.length === 2 && args[0] === '--arch') return windowsArchitecture(args[1]);
  if (args.length === 1 && args[0].startsWith('--arch=')) return windowsArchitecture(args[0].slice(7));
  throw new Error('Usage: node scripts/<build|package>-windows.js [--arch x64|arm64]');
}

export function assertWindowsExecutable(bytes, architecture) {
  const expected = windowsArchitecture(architecture);
  const peOffset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : 0;
  const machine = expected === 'arm64' ? 0xaa64 : 0x8664;
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || peOffset < 64 || peOffset + 94 > bytes.length ||
      bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' ||
      bytes.readUInt16LE(peOffset + 4) !== machine || bytes.readUInt16LE(peOffset + 24) !== 0x20b ||
      bytes.readUInt16LE(peOffset + 24 + 68) !== 2) {
    throw new Error(`Expected a Windows ${expected} PE32+ GUI executable.`);
  }
  return { architecture: expected, machine, peOffset, subsystem: 2 };
}
