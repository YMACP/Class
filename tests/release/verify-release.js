// Isolated, end-to-end release verification. No real model endpoint or profile is used.
// Usage: node tests/release/verify-release.js [path/to/Class.exe]
//        node tests/release/verify-release.js --node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getReleaseDirectory } from '../../scripts/release-paths.js';
import { verificationHost, verifyNativeExecutable, defaultVerificationExecutable } from './windows-verification.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED_VERSION = '1.0.0';
const FAKE_KEY = 'class-release-verification-local-fake-key';
const FINAL_ANSWER = 'Class release verification complete: files, media, planning and isolated browser evidence passed.';
const expectedTools = ['write_file', 'edit_file', 'glob', 'grep', 'read_image', 'read_pdf', 'plan_write', 'plan_read', 'todo_write', 'todo_read', 'browser'];
const secrets = new Set([FAKE_KEY]);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const digest = data => createHash('sha256').update(data).digest('hex');
const running = child => child && child.exitCode === null && child.signalCode === null;
const safeMessage = error => {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.split(secret).join('[redacted]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/data:[^\s"']+/g, '[media omitted]').replace(/[A-Za-z0-9+/=]{160,}/g, '[long data omitted]').slice(0, 1600);
};

function pdfFixture() {
  const content = 'BT /F1 18 Tf 50 100 Td (CLASS RELEASE PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let text = '%PDF-1.4\n', offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(text + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function runHelper(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failed;
    child.stdout.on('data', chunk => { if (output.length < 16384) output += chunk.toString(); });
    child.stderr.resume();
    const timer = setTimeout(() => { failed = new Error('Owned process cleanup helper timed out'); child.kill('SIGKILL'); }, 15000);
    child.once('error', error => { failed = error; });
    child.once('close', code => { clearTimeout(timer); failed ? reject(failed) : code === 0 ? resolve(output) : reject(new Error('Owned process cleanup helper failed')); });
  });
}

async function forceOwnedProcesses(child, directory) {
  if (process.platform === 'win32') {
    // The random private path is present only in our launch arguments and our
    // children's TEMP/profile arguments. No unfiltered process data is returned.
    // Recheck process creation time before stopping a captured PID.
    const marker = directory.replaceAll("'", "''");
    const script = String.raw`$ErrorActionPreference='Stop'; $ownedRoot='${marker}'; $marker=[IO.Path]::GetFileName($ownedRoot); $stopped=0;
      $items=@(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%$marker%'" | Where-Object {$_.ProcessId -ne ${process.pid} -and $_.CommandLine.Contains($ownedRoot)});
      foreach($item in $items){
        $current=Get-CimInstance Win32_Process -Filter "ProcessId = $($item.ProcessId)";
        if(-not $current){continue};
        if($current.CreationDate -ne $item.CreationDate -or -not $current.CommandLine.Contains($ownedRoot)){throw 'Owned process identity changed'};
        if($item.ProcessId -eq ${child?.pid || 0} -and $item.ParentProcessId -ne ${process.pid}){throw 'Owned process parent changed'};
        & "$env:SystemRoot\System32\taskkill.exe" /PID $item.ProcessId /T /F 2>$null | Out-Null;
        if($LASTEXITCODE -ne 0 -and (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue)){throw 'Unable to stop owned process'};
        $stopped++;
      }; [Console]::Write($stopped)`;
    return Number((await runHelper(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])).trim());
  } else if (running(child)) {
    // detached=true gives the verifier its own process group on POSIX.
    try { process.kill(-child.pid, 'SIGKILL'); return 1; } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return 0;
}

function inputFrom(body) {
  for (const message of body.messages || []) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    try { const input = JSON.parse(message.content); if (input && typeof input === 'object' && 'task' in input) return input; } catch { /* Other user messages carry protocol guidance. */ }
  }
  throw new Error('Mock model did not receive the real task input');
}

function sendTool(response, id, name, args) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: `message-${id}`, type: 'message', role: 'assistant', model: 'release-fixture', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: args }], usage: { input_tokens: 10, output_tokens: 10 } }));
}

async function main() {
  const args = process.argv.slice(2);
  check(args.length <= 1, 'Usage: node tests/release/verify-release.js [Class.exe | --node]');
  const sourceMode = args[0] === '--node';
  const executable = sourceMode ? process.execPath : path.resolve(args[0] || defaultVerificationExecutable());
  check((await fs.stat(executable)).isFile(), 'Release executable does not exist');
  const host = verificationHost();
  const artifact = sourceMode ? undefined : verifyNativeExecutable(await fs.readFile(executable), host);
  const tempParent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(tempParent, 'class-release-verifier-'));
  const profile = path.join(directory, 'profile'), workspace = path.join(directory, 'workspace'), childTemp = path.join(directory, 'tmp');
  let child, exited, instance, mock, runId, summary, failure;
  const sockets = new Set();
  const abort = new AbortController();
  const cancelled = () => abort.abort(new Error('Release verification interrupted'));
  process.once('SIGINT', cancelled); process.once('SIGTERM', cancelled);
  let mockFailure;
  const state = { alice: 0, bob: 0, teacher: 0, reviews: 0, feedbackDelivered: false, pending: new Map(), evidenceRefs: new Set(), media: new Set(), calls: [], screenshotPath: undefined };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const pdf = pdfFixture();
  const start = Date.now();
  const assertRunning = () => {
    abort.signal.throwIfAborted();
    if (mockFailure) throw mockFailure;
    check(Date.now() - start < 240000, 'Release verification exceeded four minutes');
    if (child) check(running(child), 'Owned application exited before verification completed');
  };
  async function api(route, body, method = body === undefined ? 'GET' : 'POST', cleanup = false) {
    if (!cleanup) assertRunning();
    const response = await fetch(new URL(route, instance.url), {
      method, headers: { authorization: `Bearer ${instance.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: cleanup ? AbortSignal.timeout(20000) : AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
    });
    check(response.ok, `Application API ${route.split('?')[0]} returned HTTP ${response.status}`);
    return response.json();
  }
  async function collectToolResult(model, body) {
    const pending = state.pending.get(model);
    if (!pending) return;
    const block = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : []).find(item => item.type === 'tool_result' && item.tool_use_id === pending.id);
    check(block, `Missing native result for ${pending.name}`);
    check(!block.is_error, `Execution failed for ${pending.name}`);
    const content = Array.isArray(block.content) ? block.content : [{ type: 'text', text: block.content }];
    const text = content.find(item => item.type === 'text')?.text;
    let result;
    try { result = JSON.parse(text); } catch { throw new Error(`Invalid native tool result for ${pending.name}`); }
    check(result && !result.error && result.success !== false, `Unsuccessful native tool result for ${pending.name}`);
    check(typeof result.evidenceRef === 'string' && result.evidenceRef.startsWith('journal:'), `Missing persisted evidence for ${pending.name}`);
    state.evidenceRefs.add(result.evidenceRef);
    if (result.outputRef) state.evidenceRefs.add(result.outputRef);
    check(!result.media?.some(item => 'data' in item), 'Base64 leaked into JSON tool-result history');
    let output;
    try { output = JSON.parse(result.output); } catch { output = result.output; }
    if (pending.name === 'glob') check(output.files?.some(item => typeof item === 'string' ? item.endsWith('proof.txt') : item.path?.endsWith('proof.txt')), 'glob did not find the tool-created file');
    if (pending.name === 'grep') check(output.matches?.some(item => item.line === 1 && String(item.text ?? item.content ?? '').includes('release=passed')), 'grep did not report the edited line');
    if (pending.name === 'read_file') check(result.output === 'release=passed\n', 'Teacher read_file did not verify the final file');
    if (pending.name === 'plan_read' && model === 'release-teacher') check(output.entries?.length === 2 && output.entries.some(entry => entry.plan === 'Bob independently checks shared planning visibility.'), 'Teacher cannot read both students plans');
    if (pending.name === 'todo_read') check(output.entries?.[0]?.todos?.[0]?.status === 'completed', 'todo_read did not return the saved completion state');
    if (pending.name === 'read_pdf') {
      check(output.pages?.some(page => page.text.includes('CLASS RELEASE PDF')), 'PDF text extraction failed in the launched artifact');
      const document = content.find(item => item.type === 'document');
      check(document?.source?.type === 'base64' && document.source.media_type === 'application/pdf', 'PDF was not delivered as a native document block');
      check(digest(Buffer.from(document.source.data, 'base64')) === digest(pdf), 'Native PDF bytes changed');
      state.media.add('student-document');
    }
    if (pending.name === 'read_image' || (pending.name === 'browser' && pending.args.action === 'screenshot')) {
      const image = content.find(item => item.type === 'image');
      check(image?.source?.type === 'base64' && image.source.media_type === 'image/png', 'Image was not delivered as a native image block');
      const bytes = Buffer.from(image.source.data, 'base64');
      check(bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && bytes.length <= 5 * 1024 * 1024, 'Native image is not a bounded PNG');
      if (pending.name === 'browser') {
        state.screenshotPath = result.media?.[0]?.path;
        check(typeof state.screenshotPath === 'string' && /^\.class-artifacts[\\/]/.test(state.screenshotPath), 'Browser screenshot was not retained as a workspace artifact');
        check(digest(await fs.readFile(path.join(workspace, state.screenshotPath))) === digest(bytes), 'Saved browser screenshot differs from model input');
        state.media.add('browser-image');
      } else if (model === 'release-teacher') state.media.add('teacher-image');
      else { check(digest(bytes) === digest(png), 'read_image changed the fixture bytes'); state.media.add('student-image'); }
    }
    state.pending.delete(model);
  }
  function issue(model, response, name, toolArgs) {
    const id = `release-call-${state.calls.length + 1}`;
    state.calls.push({ model, name, action: toolArgs.action });
    if (!['submit_answer', 'submit_review'].includes(name)) state.pending.set(model, { id, name, args: toolArgs });
    sendTool(response, id, name, toolArgs);
  }
  try {
    await Promise.all([profile, workspace, childTemp].map(folder => fs.mkdir(folder, { mode: 0o700 })));
    await fs.writeFile(path.join(workspace, 'pixel.png'), png, { flag: 'wx' });
    await fs.writeFile(path.join(workspace, 'fixture.pdf'), pdf, { flag: 'wx' });
    mock = createServer(async (request, response) => {
      try {
        if (request.method === 'GET' && request.url === '/browser-fixture') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end('<!doctype html><title>Class release browser fixture</title><h1>Owned browser verified</h1><button>Fixture button</button>'); return;
        }
        if (request.method === 'GET' && request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
        check(request.method === 'POST' && request.url === '/v1/messages', 'Mock received an unexpected route');
        let size = 0; const chunks = [];
        for await (const chunk of request) { size += chunk.length; check(size <= 24 * 1024 * 1024, 'Model request exceeded the fixture size limit'); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        check(['release-alice', 'release-bob', 'release-teacher'].includes(body.model), 'Unknown mock model');
        if (!body.tools?.length) {
          const input = (body.messages || []).filter(message => message.role === 'user' && typeof message.content === 'string').map(message => { try { return JSON.parse(message.content); } catch { return null; } }).find(value => ['extract', 'reflect'].includes(value?.type));
          check(body.model === 'release-teacher' && input, 'Unexpected background request');
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"memories":[]}' }] })); return;
        }
        check([...expectedTools, 'web_fetch', 'web_search'].every(name => body.tools?.some(tool => tool.name === name)), 'The launched application did not declare every new tool');
        await collectToolResult(body.model, body);
        const input = inputFrom(body);
        if (body.model === 'release-bob') {
          if (state.bob++ === 0) issue(body.model, response, 'plan_write', { content: 'Bob independently checks shared planning visibility.' });
          // Keep the second student's real solve request pending until the engine
          // cancels it. This avoids fabricated answers or an artificial spin loop.
          return;
        }
        if (body.model === 'release-alice') {
          const steps = [
            ['plan_write', { content: 'Verify file operations, native media, working notes and the isolated browser.' }],
            ['todo_write', { todos: [{ id: 'release-check', content: 'Execute the release verification tool sequence', status: 'completed' }] }],
            ['write_file', { path: 'proof.txt', content: 'release=pending\n' }],
            ['edit_file', { path: 'proof.txt', old_text: 'pending', new_text: 'passed' }],
            ['glob', { pattern: '**/*.txt' }],
            ['grep', { pattern: '^release=passed$', glob: '**/*.txt', literal: false }],
            ['read_image', { path: 'pixel.png' }],
            ['read_pdf', { path: 'fixture.pdf', include_document: true }],
            ['plan_read', {}], ['todo_read', {}],
            ['browser', { action: 'open', url: `http://127.0.0.1:${mock.address().port}/browser-fixture` }],
            ['browser', { action: 'snapshot' }], ['browser', { action: 'screenshot' }], ['browser', { action: 'close', all: true }],
          ];
          if (state.alice < steps.length) { const [name, toolArgs] = steps[state.alice++]; issue(body.model, response, name, toolArgs); return; }
          const revised = state.alice++ > steps.length;
          check(state.alice <= steps.length + 2, 'Student replayed an already submitted candidate');
          if (revised) { check(input.feedbackVersion === 1 && input.blackboard?.some(entry => entry.type === 'teacher_feedback'), 'Rejected candidate did not receive the real teacher feedback'); state.feedbackDelivered = true; }
          issue(body.model, response, 'submit_answer', { content: revised ? FINAL_ANSWER : 'Release tools were exercised; final wording still needs teacher feedback.', evidence: 'Executed local fixture tools and retained their journal evidence.', evidenceRefs: [...state.evidenceRefs], completionClaims: ['Local fixture execution completed'], remainingIssues: [] });
          return;
        }
        check(input.answer && input.reviewSnapshot, 'Teacher did not receive a real review snapshot');
        const teacherSteps = [
          ['read_file', { path: 'proof.txt' }], ['plan_read', { member: 'all' }], ['read_image', { path: state.screenshotPath }],
        ];
        if (state.reviews === 0 && state.teacher < teacherSteps.length) { const [name, toolArgs] = teacherSteps[state.teacher++]; issue(body.model, response, name, toolArgs); return; }
        state.reviews++;
        check(state.reviews <= 2, 'Teacher was invoked for more than two candidate reviews');
        const valid = state.reviews === 2;
        if (valid) check(input.answer.content === FINAL_ANSWER && state.feedbackDelivered, 'Final candidate did not incorporate review feedback');
        issue(body.model, response, 'submit_review', { valid, ...(valid ? { answer: FINAL_ANSWER } : {}), report: valid ? 'All retained fixture evidence and the revised final answer passed.' : 'Verified the tool evidence. Revise the final answer to explicitly cover files, media, planning and isolated browser.', verifiedFacts: ['File and screenshot were independently read by the teacher.'], gaps: valid ? [] : ['The final answer does not state the verified scope.'], recommendations: valid ? [] : ['Revise the answer without repeating completed tool calls.'], evidenceRefs: [...state.evidenceRefs] });
      } catch (error) {
        mockFailure ??= new Error(`Mock verification failed: ${safeMessage(error)}`);
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        if (!response.destroyed) response.end(JSON.stringify({ error: 'Local release fixture assertion failed' }));
      }
    });
    mock.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const childArgs = [...(sourceMode ? [path.join(project, 'src', 'desktop.js')] : []), '--data-dir', profile, '--no-browser'];
    child = spawn(executable, childArgs, { cwd: workspace, windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp }, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError;
    child.stdout.resume(); child.stderr.resume();
    exited = new Promise(resolve => { child.once('error', error => { spawnError = error; }); child.once('close', (code, signal) => resolve({ code, signal })); });
    while (!instance) {
      if (spawnError) throw new Error('Could not start the selected application');
      assertRunning();
      try { instance = JSON.parse(await fs.readFile(path.join(profile, 'instance.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!instance) await delay(100);
    }
    check(instance.pid === child.pid, 'Instance file does not belong to the spawned application');
    const appUrl = new URL(instance.url);
    check(appUrl.protocol === 'http:' && appUrl.hostname === '127.0.0.1' && appUrl.port && !appUrl.username && !appUrl.password, 'Owned instance did not advertise a loopback HTTP endpoint');
    check(typeof instance.token === 'string' && instance.token.length >= 24, 'Owned instance lacks its access token'); secrets.add(instance.token);
    const health = await api('/health');
    check(health.app === 'class' && health.version === EXPECTED_VERSION, 'Release health/version check failed');
    const initial = await api('/api/state');
    check(initial.version === EXPECTED_VERSION && initial.agents.length === 0 && initial.history.length === 0, 'Fresh isolated profile is not empty');
    check(await fs.realpath(initial.dataDir) === await fs.realpath(profile), 'Application opened a profile outside the verification root');
    for (const [name, role] of [['teacher', 'teacher'], ['alice', 'student'], ['bob', 'student']]) {
      await api('/api/agents', { name: `Release ${name}`, role, model: `release-${name}`, baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, protocol: 'messages', apiKey: FAKE_KEY });
    }
    await api('/api/settings', { cwd: workspace, voteTimeoutMs: 30000 }, 'PUT');
    runId = (await api('/api/runs', { task: 'Verify the release using only the provided local fixtures and tools; preserve the Class teacher review workflow.' })).run.id;
    let run;
    do {
      assertRunning();
      run = (await api(`/api/runs/${runId}`)).run;
      if (run.memberFailures?.length) throw new Error('A member was isolated during release verification');
      if (['running', 'stopping'].includes(run.status)) await delay(150);
    } while (['running', 'stopping'].includes(run.status));
    check(run.status === 'completed' && run.result?.status === 'completed' && run.result.answer === FINAL_ANSWER, 'Release run did not complete with the verified answer');
    check(run.result.reviewRound === 2 && run.result.feedbackVersion === 1 && state.reviews === 2 && state.feedbackDelivered, 'Reject/resume/pass workflow was not preserved');
    check(state.media.size === 4, 'Not all native image/document round trips were observed');
    check(await fs.readFile(path.join(workspace, 'proof.txt'), 'utf8') === 'release=passed\n', 'Final workspace file is incorrect');
    const toolPage = await api(`/api/runs/${runId}/evidence?kind=tool&limit=200`);
    const completed = toolPage.records.filter(record => record.activity?.type === 'completed');
    check(expectedTools.every(name => completed.some(record => record.activity.action.name === name)), 'Journal does not contain every required completed tool');
    check(!toolPage.records.some(record => record.activity?.type === 'failed'), 'Journal contains failed tool executions');
    check(completed.filter(record => ['write_file', 'edit_file', 'read_pdf', 'glob', 'grep'].includes(record.activity.action.name)).length === 5, 'Rejected candidate repeated a completed operation');
    check(completed.every(record => !record.activity.result?.media?.some(item => 'data' in item)), 'Journal contains raw media bytes');
    const reviews = await api(`/api/runs/${runId}/evidence?kind=review&limit=200`);
    check(reviews.records.length === 2 && reviews.records[0].judgement.valid === false && reviews.records[1].judgement.valid === true, 'Persisted reviews do not show rejection followed by acceptance');
    const eventPage = await api(`/api/runs/${runId}/evidence?kind=event&limit=200`);
    check(eventPage.records.some(record => record.event?.type === 'feedback.delivered' && record.event.feedbackVersion === 1), 'Persisted events do not show feedback delivery');
    summary = { target: sourceMode ? 'source' : path.basename(executable), host, artifact, version: health.version, status: run.status, reviews: [false, true], tools: expectedTools, completedToolCalls: completed.length, nativeMediaRoundTrips: [...state.media].sort(), workflowUnchanged: true };
  } catch (error) { failure = error; }
  finally {
    try {
      if (running(child) && instance) {
        try { const result = await api('/api/shutdown', {}, 'POST', true); check(result.readyToExit === true, 'Application did not acknowledge shutdown'); }
        catch (error) { failure ??= error; }
      }
      if (running(child)) {
        try { await withTimeout(exited, 20000, 'Owned application did not exit after shutdown'); }
        catch { await forceOwnedProcesses(child, directory); await withTimeout(exited, 10000, 'Owned application did not exit after forced cleanup'); failure ??= new Error('Release required forced process cleanup'); }
      }
    } catch (error) { failure ??= error; }
    // Always inspect our own marker, even when shutdown or the exit code failed:
    // a crashed application can leave its temporary-profile browser orphaned.
    try { if (await forceOwnedProcesses(child, directory)) failure ??= new Error('Application shutdown left owned descendant processes'); }
    catch (error) { failure ??= error; }
    if (exited && !running(child)) { const result = await exited; if (result.code !== 0 || result.signal) failure ??= new Error('Owned application exited with an error'); }
    for (const socket of sockets) socket.destroy();
    if (mock?.listening) await withTimeout(new Promise(resolve => mock.close(resolve)), 5000, 'Local fixture server did not stop').catch(error => { failure ??= error; });
    try {
      const actual = await fs.realpath(directory);
      check(path.dirname(actual) === tempParent && path.basename(actual).startsWith('class-release-verifier-') && actual === directory, 'Refusing cleanup outside the owned temporary root');
      check(!(await fs.lstat(directory)).isSymbolicLink(), 'Refusing cleanup of a replaced temporary root');
      await fs.rm(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    } catch (error) { failure ??= error; }
    process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled);
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ ...summary, cleanShutdown: true, temporaryDataRemoved: true }, null, 2));
}

main().catch(error => { console.error(`Release verification failed: ${safeMessage(error)}`); process.exitCode = 1; });
