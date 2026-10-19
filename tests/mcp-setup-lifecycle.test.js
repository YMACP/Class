import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolManager } from '../src/tools.js';

async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'owned setup did not start'); await delay(10); }
}

test('fixed setup commands run without a shell, return bounded output and release owned children', { timeout: 30000 }, async t => {
  const manager = new ToolManager({ allowShell: true });
  t.after(() => manager.stopAll());
  const result = await manager.runExtensionSetup(process.execPath, ['-e', 'process.stdout.write("ready");process.stderr.write("detail")'], { env: {}, timeoutMs: 5000 });
  assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'ready'); assert.equal(result.stderr, 'detail');
  assert.equal(manager.children.size, 0);
});

test('setup cancellation while paused tears down only its owned process', { timeout: 30000 }, async t => {
  const manager = new ToolManager({ allowShell: true }), controller = new AbortController();
  t.after(() => manager.stopAll());
  const pending = manager.runExtensionSetup(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, signal: controller.signal, timeoutMs: 10000 });
  const rejected = assert.rejects(pending, /cancelled fixture/);
  await until(() => manager.children.size === 1);
  await manager.pauseAll();
  assert.equal(manager.children.size, 1);
  controller.abort(new Error('cancelled fixture'));
  await rejected; assert.equal(manager.children.size, 0);
});

test('task stop aborts pending setup, and disabled process execution never starts setup', { timeout: 30000 }, async t => {
  const manager = new ToolManager({ allowShell: true });
  t.after(() => manager.stopAll());
  const pending = manager.runExtensionSetup(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, timeoutMs: 10000 });
  const rejected = assert.rejects(pending);
  await until(() => manager.children.size === 1);
  await manager.stopAll(); await rejected; assert.equal(manager.children.size, 0);
  const denied = new ToolManager(); t.after(() => denied.stopAll());
  await assert.rejects(denied.runExtensionSetup(process.execPath, ['--version']), /未允许/);
  assert.equal(denied.children.size, 0);
});
