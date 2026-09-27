import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolManager } from '../src/tools.js';
import { ModelProtocolClient } from '../src/model-protocol.js';
import { toolDefinitions } from '../src/tool-contract.js';
import { RunJournal } from '../src/run-journal.js';
import { boundedJson, utf8Prefix, activeTimeout } from '../src/tool-output.js';
import { retainToolMedia } from '../src/media-tools.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGRkAAAAASUVORK5CYII=', 'base64');
function pdfFixture() {
  const text = 'BT /F1 12 Tf 40 100 Td (Class media evidence 5050) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, item] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${item}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
async function workspace(t) {
  const root = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(root, 'class-media-plan-'));
  const journal = new RunJournal({ directory: path.join(directory, 'journal'), runId: 'media-plan' });
  const activities = [];
  const manager = new ToolManager({ cwd: directory, onActivity: async activity => { activities.push(activity); return journal.append({ kind: 'tool', activity }); } });
  t.after(async () => { await manager.stopAll(); await journal.flush(); const resolved = await fs.realpath(directory); assert.equal(path.dirname(resolved), root); assert.ok(path.basename(resolved).startsWith('class-media-plan-')); await fs.rm(resolved, { recursive: true, force: true }); });
  await fs.writeFile(path.join(directory, 'image.png'), png); await fs.writeFile(path.join(directory, 'evidence.pdf'), pdfFixture());
  return { directory, manager, journal, activities };
}

test('six capability groups are registered while existing collaboration stays outside the execution registry', async t => {
  const { manager } = await workspace(t), names = toolDefinitions(manager).map(tool => tool.name);
  for (const name of ['read_file','list_files','sleep','write_file','edit_file','glob','grep','web_search','web_fetch','browser','read_image','read_pdf','plan_read','plan_write','todo_read','todo_write']) assert.ok(names.includes(name), name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(!names.includes('submit_answer'));
});

test('plans and todos share read access with teacher but updates stay owned and schema failures are atomic', async t => {
  const { manager } = await workspace(t);
  const teacher = new ToolManager({ cwd: manager.cwd, planningState: manager.planningState }); t.after(() => teacher.stopAll());
  await manager.execute('alice', { name: 'plan_write', args: { content: 'Inspect then verify' } });
  await manager.execute('alice', { name: 'todo_write', args: { todos: [{ id: 'a', content: 'Inspect', status: 'completed' }, { id: 'b', content: 'Verify', status: 'in_progress' }] } });
  await manager.execute('bob', { name: 'plan_write', args: { content: 'Independent approach' } });
  assert.equal(JSON.parse((await teacher.execute('teacher', { name: 'plan_read', args: { member: 'alice' } })).output).entries[0].plan, 'Inspect then verify');
  assert.equal(JSON.parse((await teacher.execute('teacher', { name: 'todo_read', args: { member: 'alice' } })).output).entries[0].todos[0].status, 'completed');
  await assert.rejects(manager.execute('alice', { name: 'todo_write', args: { todos: [{ id: 'bad', content: 'Invalid', status: 'accepted' }] } }), /Invalid tool argument/);
  await assert.rejects(manager.execute('alice', { name: 'todo_write', args: { todos: [{ id: 'x', content: 'x', status: 'pending' }, { id: 'x', content: 'y', status: 'pending' }] } }), /duplicate/);
  assert.equal(manager.planningState.get('alice').todos.length, 2);
  assert.equal(manager.paused, false); assert.equal(manager.stopped, false);
  await manager.pauseAll(); let finished = false;
  const update = manager.execute('alice', { name: 'plan_write', args: { content: 'After resume' } }).then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(finished, false);
  await manager.resumeAll(); await update;
  assert.equal(manager.planningState.get('alice').plan, 'After resume');
});

test('media reads real bytes and PDF text, records bounded evidence without base64, rejects invalid inputs', async t => {
  const { manager, directory, activities } = await workspace(t);
  const image = await manager.execute('alice', { name: 'read_image', args: { path: 'image.png' } });
  assert.equal(image.media[0].data, png.toString('base64'));
  const pdf = await manager.execute('alice', { name: 'read_pdf', args: { path: 'evidence.pdf', include_document: true } });
  assert.match(pdf.output, /Class media evidence 5050/); assert.equal(pdf.media[0].mimeType, 'application/pdf');
  assert.ok(!JSON.stringify(activities).includes(png.toString('base64')));
  assert.ok(activities.find(activity => activity.result?.media)?.result.media[0].sha256);
  await fs.writeFile(path.join(directory, 'fake.png'), 'not an image');
  await assert.rejects(manager.execute('alice', { name: 'read_image', args: { path: 'fake.png' } }), /Unsupported image/);
  await assert.rejects(manager.execute('alice', { name: 'read_pdf', args: { path: 'evidence.pdf', start_page: 2 } }), /page count/);
  await assert.rejects(manager.execute('alice', { name: 'read_image', args: { path: '..' } }), /escapes workspace/);
});

test('escaped and tiny tool summaries remain bounded valid JSON and UTF-8', async t => {
  const { manager } = await workspace(t);
  for (const limit of [1, 2, 10, 40, 100, 300]) {
    const value = boundedJson({ text: '\\"\n中文🙂'.repeat(300) }, limit);
    assert.ok(Buffer.byteLength(value.output) <= limit); JSON.parse(value.output); assert.equal(value.truncated, true);
    manager.maxOutputBytes = limit;
    const pdf = await manager.execute('alice', { name: 'read_pdf', args: { path: 'evidence.pdf' } });
    assert.ok(Buffer.byteLength(pdf.output) <= limit); JSON.parse(pdf.output);
    const plan = await manager.execute('alice', { name: 'plan_write', args: { content: '"\\\n'.repeat(100) } });
    assert.ok(Buffer.byteLength(plan.output) <= limit); JSON.parse(plan.output);
    const browser = manager.browserTools._result({ title: '"\\\n'.repeat(100) });
    assert.ok(Buffer.byteLength(browser.output) <= limit); JSON.parse(browser.output);
  }
  assert.equal(utf8Prefix('中🙂文', 6), '中');
});

test('active PDF/web timeouts freeze across Class pause and remove their listener', async t => {
  const { manager } = await workspace(t); let timedOut = false;
  const originalListeners = manager.events.listenerCount('change');
  const cancel = activeTimeout(manager, 100, () => { timedOut = true; });
  await manager.pauseAll();
  await new Promise(resolve => setTimeout(resolve, 160)); assert.equal(timedOut, false);
  await manager.resumeAll(); await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(timedOut, true); cancel(); assert.equal(manager.events.listenerCount('change'), originalListeners);
});

test('screenshot artifacts preserve identical content digest despite unique filenames', async t => {
  const { manager } = await workspace(t);
  const result = () => ({ name: 'browser', output: '{"bytes":100}', media: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] });
  const first = await retainToolMedia(manager, result(), new AbortController().signal);
  const second = await retainToolMedia(manager, result(), new AbortController().signal);
  assert.notEqual(first.media[0].path, second.media[0].path); assert.equal(first.outputDigest, second.outputDigest);
  assert.deepEqual(await fs.readFile(path.join(manager.cwd, first.media[0].path)), png);
});

function toolResponse(protocol, name, args) {
  if (protocol === 'messages') return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'media-call', name, input: args }] };
  if (protocol === 'responses') return { status: 'completed', output: [{ type: 'function_call', call_id: 'media-call', name, arguments: JSON.stringify(args) }] };
  return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'media-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
}
function finalResponse(protocol) {
  if (protocol === 'messages') return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] };
  if (protocol === 'responses') return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] }] };
  return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }] };
}
for (const protocol of ['messages', 'responses', 'chat']) for (const type of ['image', 'pdf']) {
  test(`${protocol}: ${type} uses native media blocks, repeated call IDs reuse results`, async t => {
    const { manager } = await workspace(t); let requests = 0, executions = 0;
    const name = type === 'image' ? 'read_image' : 'read_pdf', args = type === 'image' ? { path: 'image.png' } : { path: 'evidence.pdf', include_document: true };
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (url, request) => {
      const body = JSON.parse(request.body); requests++;
      if (requests > 1) {
        const items = body.messages ?? body.input;
        if (protocol === 'messages') {
          const result = items.flatMap(item => Array.isArray(item.content) ? item.content : []).find(item => item.type === 'tool_result');
          assert.ok(result.content.some(part => part.type === (type === 'image' ? 'image' : 'document') && part.source.type === 'base64'));
          assert.ok(!result.content[0].text.includes('base64'));
        } else {
          const inputType = protocol === 'responses' ? type === 'image' ? 'input_image' : 'input_file' : type === 'image' ? 'image_url' : 'file';
          assert.ok(items.flatMap(item => Array.isArray(item.content) ? item.content : []).some(item => item.type === inputType));
          const result = items.find(item => item.role === 'tool' || item.type === 'function_call_output');
          assert.ok(result); assert.ok(!(result.content ?? result.output).includes('base64'));
        }
      }
      return Response.json(requests < 3 ? toolResponse(protocol, name, args) : finalResponse(protocol));
    };
    const client = new ModelProtocolClient({ protocol, baseUrl: 'https://isolated-fixture.invalid/v1', model: 'test', timeoutMs: null }, 'fixture-key');
    const result = await client.json('Return an object', { task: 'Read evidence' }, undefined, {
      tools: toolDefinitions(manager), executeTool: (name, args) => { executions++; return manager.execute('alice', { name, args }); },
    });
    assert.deepEqual(result, { ok: true }); assert.equal(executions, 1); assert.equal(requests, 3);
  });
}
