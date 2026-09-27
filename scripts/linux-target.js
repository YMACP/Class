export function linuxArchitecture(value = process.env.CLASS_LINUX_ARCH || process.arch) {
  if (value === 'amd64' || value === 'x64') return 'amd64';
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  throw new Error('The Linux architecture must be amd64 (x64) or arm64.');
}

export function linuxBuildOptions(args = process.argv.slice(2), { allowOutput = false } = {}) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const [key, inline] = args[index].split(/=(.*)/s);
    if (key !== '--arch' && !(allowOutput && key === '--out')) throw new Error(`Unsupported build argument: ${key}`);
    const value = inline === undefined ? args[++index] : inline;
    if (!value || value.startsWith('--') || options[key.slice(2)]) throw new Error(`Missing or duplicate ${key}`);
    options[key.slice(2)] = value;
  }
  return { ...options, architecture: linuxArchitecture(options.arch) };
}

// This verifies the binary format only; native execution is a separate gate.
export function assertLinuxExecutable(bytes, architecture = linuxArchitecture()) {
  architecture = linuxArchitecture(architecture);
  if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 || ![0, 3].includes(bytes[7]) ||
      ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== (architecture === 'amd64' ? 62 : 183) ||
      bytes.readUInt32LE(20) !== 1 || bytes.readUInt16LE(52) !== 64) {
    throw new Error(`Expected a little-endian Linux ${architecture} ELF64 executable`);
  }
  const integer = (offset) => {
    const value = bytes.readBigUInt64LE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ELF offset exceeds safe bounds');
    return Number(value);
  };
  const table = integer(32), stride = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (stride !== 56 || !count || table < 64 || table + count * stride > bytes.length) throw new Error('Invalid ELF program headers');
  let interpreter, loadable = false;
  for (let index = 0; index < count; index++) {
    const header = table + index * stride, type = bytes.readUInt32LE(header);
    const offset = integer(header + 8), size = integer(header + 32);
    if (offset + size > bytes.length) throw new Error('ELF segment exceeds the file');
    if (type === 1 && size > 0) loadable = true;
    if (type === 3) {
      const segment = bytes.subarray(offset, offset + size);
      if (interpreter || segment.at(-1) !== 0) throw new Error('Invalid ELF interpreter');
      interpreter = segment.subarray(0, -1).toString('utf8');
    }
  }
  const expected = architecture === 'amd64' ? '/lib64/ld-linux-x86-64.so.2' : '/lib/ld-linux-aarch64.so.1';
  if (!loadable || interpreter !== expected) throw new Error(`Expected the Linux glibc loader ${expected}`);
  return { architecture, machine: bytes.readUInt16LE(18), format: 'ELF64', interpreter };
}
