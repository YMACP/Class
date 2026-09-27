// Linux acceptance helpers inspect only /proc identity metadata. They never
// read process environments, command arguments, browser profiles, or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

export function parseLinuxProcessStat(text) {
  const close = text.lastIndexOf(')'), first = text.indexOf('(');
  assert.ok(first > 0 && close > first, 'Invalid Linux process stat');
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const record = { pid: Number(text.slice(0, first).trim()), state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), started: fields[19] };
  assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0 && /^\d+$/.test(record.started), 'Invalid Linux process identity');
  return record;
}
export async function linuxProcess(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Expected a positive owned process ID');
  try { return parseLinuxProcessStat(await fs.readFile('/proc/' + pid + '/stat', 'utf8')); }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
export async function captureLinuxChild(child) {
  if (!child.pid) return null;
  const record = await linuxProcess(child.pid);
  if (record) assert.equal(record.parent, process.pid, 'Refusing an unowned Linux child');
  return record;
}
async function signalIdentity(record, signal) {
  const current = await linuxProcess(record.pid);
  if (!current || current.started !== record.started) return false;
  try { process.kill(record.pid, signal); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function snapshot(deadline = Infinity) {
  const ids = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name));
  const records = [];
  for (const id of ids) { assert.ok(Date.now() < deadline, 'Owned Linux process scan exceeded its deadline'); const record = await linuxProcess(Number(id)); if (record) records.push(record); }
  return records;
}
export async function linuxDirectChildren(parent) {
  return (await snapshot()).filter(record => record.parent === parent);
}
export async function stopLinuxOwnedTree(root) {
  if (!root) return;
  const current = await linuxProcess(root.pid);
  if (!current) return;
  assert.equal(current.started, root.started, 'Owned Linux process identity changed; refusing cleanup');
  assert.equal(current.parent, process.pid, 'Owned Linux process parent changed; refusing cleanup');
  const owned = new Map([[root.pid, root]]);
  const deadline = Date.now() + 15000;
  try {
    await signalIdentity(root, 'SIGSTOP');
    // Freeze parents before discovering descendants, including children that
    // create their own process group (Class's browser and foreground tools).
    for (let pass = 0; pass < 32; pass++) {
      const records = await snapshot(deadline); let added = false, discovered;
      do {
        discovered = false;
        for (const record of records) {
          assert.ok(Date.now() < deadline, 'Owned Linux process tree did not settle before its deadline');
          if (owned.has(record.pid) || !owned.has(record.parent)) continue;
          const parent = await linuxProcess(record.parent);
          if (!parent || parent.started !== owned.get(record.parent).started) continue;
          if (await signalIdentity(record, 'SIGSTOP')) { owned.set(record.pid, record); discovered = added = true; }
        }
      } while (discovered);
      if (!added) break;
      assert.ok(pass < 31, 'Owned Linux process tree did not settle');
    }
    for (const record of [...owned.values()].reverse()) await signalIdentity(record, 'SIGKILL');
  } catch (error) {
    for (const record of [...owned.values()].reverse()) await signalIdentity(record, 'SIGCONT').catch(() => {});
    throw error;
  }
}
