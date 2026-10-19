import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLinuxProcessIdentity, snapshotLinuxDescendants, killLinuxDescendants } from '../src/owned-linux-processes.js';

// Model /proc directly so the ownership and PID reuse checks also run on
// Windows. No test sends a signal to a real process.
function fixture(initial) {
  const processes = new Map(initial.map(item => [item.pid, { name:'fixture', ...item }])), signals = [];
  const options = {
    readdir: async () => ['self', 'thread-self', 'meminfo', ...processes.keys()].map(String),
    readFile: async filename => {
      const pid = Number(filename.split('/')[2]), item = processes.get(pid);
      if (!item) throw Object.assign(Error('process disappeared'), { code:'ENOENT' });
      const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = String(item.parentPid); fields[2] = String(item.group ?? item.pid); fields[19] = String(item.startTime);
      return `${pid} (${item.name}) ${fields.join(' ')}\n`;
    },
    kill: (pid, signal) => { signals.push([pid, signal]); return true; },
  };
  return { processes, signals, options };
}

test('Linux ownership snapshot follows the root tree across detached groups and handles unusual comm names', async () => {
  const { options } = fixture([
    { pid:100, parentPid:2, startTime:20, name:'Class ) browser MCP' },
    { pid:101, parentPid:100, startTime:21 }, { pid:102, parentPid:101, startTime:22, group:101 },
    { pid:200, parentPid:2, startTime:20 }, { pid:201, parentPid:200, startTime:23 },
    // A process older than its purported parent cannot belong to that identity.
    { pid:301, parentPid:101, startTime:19 },
  ]);
  const root = await captureLinuxProcessIdentity(100, options);
  assert.deepEqual(root, { pid:100, parentPid:2, startTime:'20' });
  assert.deepEqual((await snapshotLinuxDescendants(root, options)).map(item => item.pid), [101, 102]);
});

test('Linux fallback kills only matching snapshot identities, including reparented owned children', async () => {
  const { processes, signals, options } = fixture([
    { pid:100, parentPid:2, startTime:20 }, { pid:101, parentPid:100, startTime:21 },
    { pid:102, parentPid:101, startTime:22 }, { pid:103, parentPid:100, startTime:23 },
    { pid:200, parentPid:2, startTime:20 },
  ]);
  const snapshot = await snapshotLinuxDescendants(await captureLinuxProcessIdentity(100, options), options);
  processes.delete(100); processes.delete(103);
  processes.get(101).parentPid = 1;
  processes.set(102, { pid:102, parentPid:200, startTime:99, name:'PID reused by unrelated process' });
  assert.equal(await killLinuxDescendants(snapshot, options), 1);
  assert.deepEqual(signals, [[101, 'SIGKILL']]);
});

test('Linux root identity is checked before and after enumeration', async () => {
  const { processes, options } = fixture([{ pid:100, parentPid:2, startTime:20 }, { pid:101, parentPid:100, startTime:21 }]);
  const root = await captureLinuxProcessIdentity(100, options);
  assert.deepEqual(await snapshotLinuxDescendants({ ...root, startTime:'old' }, options), []);
  const original = options.readdir;
  options.readdir = async (...args) => { processes.get(100).startTime = 40; return original(...args); };
  assert.deepEqual(await snapshotLinuxDescendants(root, options), []);
});

test('Linux snapshot skips inaccessible unrelated processes but never ignores root permission failures', async () => {
  const { options } = fixture([{ pid:100, parentPid:2, startTime:20 }, { pid:101, parentPid:100, startTime:21 }, { pid:200, parentPid:2, startTime:19 }]);
  const root = await captureLinuxProcessIdentity(100, options), original = options.readFile;
  options.readFile = async filename => { if (filename === '/proc/200/stat') throw Object.assign(Error('unrelated process denied'), { code:'EACCES' }); return original(filename); };
  assert.deepEqual((await snapshotLinuxDescendants(root, options)).map(item => item.pid), [101]);
  options.readFile = async () => { throw Object.assign(Error('root denied'), { code:'EPERM' }); };
  await assert.rejects(snapshotLinuxDescendants(root, options), error => error.code === 'EPERM');
});

test('Linux cleanup reports permission failures while still cleaning other verified descendants', async () => {
  const { signals, options } = fixture([{ pid:101, parentPid:100, startTime:21 }, { pid:102, parentPid:100, startTime:22 }]);
  const snapshot = await Promise.all([101, 102].map(pid => captureLinuxProcessIdentity(pid, options)));
  options.kill = (pid, signal) => { if (pid === 102) throw Object.assign(Error('denied'), { code:'EPERM' }); signals.push([pid, signal]); };
  await assert.rejects(killLinuxDescendants(snapshot, options), error => error instanceof AggregateError && error.errors[0].code === 'EPERM');
  assert.deepEqual(signals, [[101, 'SIGKILL']]);
  options.kill = () => { throw Object.assign(Error('already exited'), { code:'ESRCH' }); };
  assert.equal(await killLinuxDescendants(snapshot, options), 0);
  await assert.rejects(captureLinuxProcessIdentity(1, options), /Invalid owned/);
  await assert.rejects(captureLinuxProcessIdentity(101, { readFile:async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});} }), error => error.code === 'EACCES');
});
