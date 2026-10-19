import fs from 'node:fs/promises';

const validPid = pid => Number.isSafeInteger(pid) && pid > 1;
const same = (left, right) => left && right && left.pid === right.pid && left.startTime === right.startTime;

// Linux-only fallback for the owned Class browser MCP process. A recorded PID
// alone is insufficient after exit: every later action also checks starttime.
export async function captureLinuxProcessIdentity(pid, { readFile = fs.readFile } = {}) {
  if (!validPid(pid)) throw Error('Invalid owned Linux process ID');
  let text;
  try { text = await readFile(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
  const end = text.lastIndexOf(')'), fields = text.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || Number(text.slice(0, text.indexOf(' '))) !== pid || !/^\d+$/.test(fields[19] || '')) throw Error('Invalid Linux process identity');
  const parentPid = Number(fields[1]);
  if (!Number.isSafeInteger(parentPid) || parentPid < 0) throw Error('Invalid Linux parent process identity');
  return { pid, parentPid, startTime: fields[19] };
}

export async function snapshotLinuxDescendants(root, options = {}) {
  if (!root) return [];
  if (!same(await captureLinuxProcessIdentity(root.pid, options), root)) return [];
  const names = await (options.readdir || fs.readdir)('/proc');
  const records = (await Promise.all(names.filter(name => /^[1-9]\d*$/.test(name) && validPid(Number(name)))
    .map(async name => {
      try { return await captureLinuxProcessIdentity(Number(name), options); }
      catch (error) {
        // hidepid and other users' permissions are not authority to touch those
        // processes, and must not prevent our own service from shutting down.
        if (['EACCES', 'EPERM'].includes(error.code)) return null;
        throw error;
      }
    }))).filter(Boolean);
  // A root that exited or was replaced during enumeration grants no authority.
  if (!same(await captureLinuxProcessIdentity(root.pid, options), root)) return [];
  const known = new Map([[root.pid, root]]), owned = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of records) {
      const parent = known.get(item.parentPid);
      if (!known.has(item.pid) && parent && BigInt(item.startTime) >= BigInt(parent.startTime)) {
        known.set(item.pid, item); owned.push(item); changed = true;
      }
    }
  }
  return owned;
}

export async function killLinuxDescendants(snapshot, options = {}) {
  const kill = options.kill || process.kill, failures = [];
  let killed = 0;
  // Children may have been reparented after the server exited. A matching
  // snapshot plus starttime still identifies the same owned process; no names,
  // global process groups, or newly discovered orphans are used as evidence.
  for (const record of [...snapshot].reverse()) {
    try {
      if (!same(await captureLinuxProcessIdentity(record.pid, options), record)) continue;
      kill(record.pid, 'SIGKILL'); killed++;
    } catch (error) { if (error.code !== 'ESRCH') failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned browser process cleanup failed');
  return killed;
}
