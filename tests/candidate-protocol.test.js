import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudent, createTeacher } from '../src/agents.js';
import { ClassEngine } from '../src/engine.js';
import { RunJournal } from '../src/run-journal.js';
import { ToolManager } from '../src/tools.js';

const proof = 'Pair 1 with 100, 2 with 99, and so on: 50 pairs * 101 = 5050.\n';
const evidence = 'Pair the endpoints: 50 pairs, each with sum 101.';

function untilAborted(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function toolResponse(protocol, id, name, args) {
  if (protocol === 'messages') {
    return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: args }] });
  }
  if (protocol === 'responses') {
    return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] });
  }
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } }] });
}

function requestInput(body) {
  const message = (body.input || body.messages).find(item => item.role === 'user' && typeof item.content === 'string');
  return JSON.parse(message.content);
}

function toolResult(protocol, body) {
  if (protocol === 'responses') return JSON.parse(body.input.find(item => item.type === 'function_call_output').output);
  if (protocol === 'chat') return JSON.parse(body.messages.find(item => item.role === 'tool').content);
  const block = body.messages.flatMap(item => Array.isArray(item.content) ? item.content : []).find(item => item.type === 'tool_result');
  return JSON.parse(block.content);
}

async function runProtocolScenario(t, protocol, correction) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'class-candidate-protocol-'));
  const workspace = path.join(directory, 'workspace');
  const journal = new RunJournal({ directory: path.join(directory, 'journal'), runId: 'candidate-protocol' });
  let engine;
  t.after(async () => {
    engine?.stop('test_cleanup');
    await journal.flush();
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temporaryRoot, 'cleanup must remain inside the temporary root');
    assert.ok(path.basename(resolved).startsWith('class-candidate-protocol-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'proof.txt'), proof);

  const tools = new ToolManager({ cwd: workspace, allowShell: false });
  const teacherTools = new ToolManager({ cwd: workspace, allowShell: false });
  const provider = { protocol, model: 'alice-model', baseUrl: 'https://class-model.invalid/v1', apiKey: 'test-key-only', timeoutMs: null };
  const students = [
    createStudent({ id: 'alice', name: 'Alice' }, provider, tools),
    createStudent({ id: 'bob', name: 'Bob', provider: { model: 'bob-model' } }, provider, tools),
  ];
  const teacher = createTeacher({ id: 'teacher', provider: { model: 'teacher-model' } }, provider, teacherTools);
  engine = new ClassEngine({ students, teacher, tools, teacherTools, journal, taskTimeoutMs: 5000, discoveryWindowMs: 0 });

  const studentInputs = [], reviewed = [];
  let references, capturedResult, studentRequests = 0, readRequests = 0;
  const candidate = (content, refs = []) => ({
    content, evidence, evidenceRefs: refs,
    completionClaims: ['Computed the sum of 1 through 100.'], remainingIssues: [],
  });
  const rejectReport = correction ? 'Correct the answer using the already saved proof.' : 'Read proof.txt and explicitly cite its recorded evidence.';

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    try {
      assert.equal(new URL(url).hostname, 'class-model.invalid');
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      const definitions = body.tools.map(item => item.function?.name || item.name);
      assert.ok(!definitions.includes('shell') && !definitions.includes('run_command'));
      if (body.model === 'bob-model') return untilAborted(options.signal);
      const input = requestInput(body);
      if (body.model === 'teacher-model') {
        reviewed.push(input);
        assert.ok(reviewed.length <= 2, 'only the initial and revised candidates should be reviewed');
        if (reviewed.length === 1) {
          return toolResponse(protocol, 'review-rejected', 'submit_review', {
            valid: false, report: rejectReport, gaps: ['The candidate still needs verification or correction.'],
            recommendations: [rejectReport],
          });
        }
        assert.equal(input.answer.content, 'The sum is 5050.');
        assert.deepEqual(input.answer.evidenceRefs, references);
        return toolResponse(protocol, 'review-passed', 'submit_review', {
          valid: true, answer: input.answer.content, report: 'The saved proof verifies the corrected complete answer.', evidenceRefs: references,
        });
      }
      assert.equal(body.model, 'alice-model');
      studentInputs.push(input);
      studentRequests++;
      assert.ok(studentRequests <= 3, 'review feedback must not replay completed tools or loop on the candidate');
      if (studentRequests === (correction ? 1 : 2)) {
        readRequests++;
        return toolResponse(protocol, 'read-proof', 'read_file', { path: 'proof.txt' });
      }
      if (studentRequests === (correction ? 2 : 3)) {
        capturedResult = toolResult(protocol, body);
        assert.equal(capturedResult.output, proof);
        assert.match(capturedResult.evidenceRef, /^journal:candidate-protocol:\d+$/);
        assert.match(capturedResult.outputRef, /^output:candidate-protocol:/);
        references = [capturedResult.evidenceRef, capturedResult.outputRef];
      }
      if (studentRequests === 3) {
        assert.equal(input.feedbackVersion, 1, 'the retry must actually send the latest feedback in its model request');
        assert.ok(input.blackboard.some(entry => entry.type === 'teacher_feedback' && entry.report === rejectReport));
        return toolResponse(protocol, 'answer-revised', 'submit_answer', candidate('The sum is 5050.', references));
      }
      return toolResponse(protocol, 'answer-initial', 'submit_answer', candidate(correction ? 'The sum is 5000.' : 'The sum is 5050.', references));
    } catch (error) {
      engine.fail(error);
      throw error;
    }
  });

  const result = await engine.run('Compute and verify the sum of the integers from 1 through 100.');
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.answer, 'The sum is 5050.');
  assert.equal(result.reviewRound, 2);
  assert.equal(result.feedbackVersion, 1);
  assert.equal(result.feedbackDelivered.alice, 1);
  assert.equal(readRequests, 1);
  assert.equal(reviewed.length, 2);
  assert.deepEqual(studentInputs.map(input => input.feedbackVersion), correction ? [0, 0, 1] : [0, 1, 1]);
  assert.equal(reviewed[0].answer.evidence, reviewed[1].answer.evidence);
  if (correction) {
    assert.deepEqual(reviewed[0].answer.evidenceRefs, reviewed[1].answer.evidenceRefs);
    assert.notEqual(reviewed[0].answer.content, reviewed[1].answer.content);
  } else {
    assert.equal(reviewed[0].answer.content, reviewed[1].answer.content);
    assert.deepEqual(reviewed[0].answer.evidenceRefs, []);
  }

  // Inspect the persisted public journal API, not internal engine maps or mocked activity.
  const reviews = await journal.read({ kind: 'review' });
  assert.deepEqual(reviews.records.map(record => record.judgement.valid), [false, true]);
  const submissions = await journal.read({ kind: 'student_result', studentId: 'alice' });
  assert.deepEqual(submissions.records.map(record => record.result.feedbackVersion), [0, 1]);
  const activity = await journal.read({ kind: 'tool', studentId: 'alice' });
  assert.deepEqual(activity.records.map(record => record.activity.type), ['started', 'completed']);
  assert.ok(activity.records.every(record => record.activity.action.name === 'read_file'));
  assert.equal(activity.records[1].reference, capturedResult.evidenceRef);
  assert.equal(activity.records[1].outputRef, capturedResult.outputRef);
  const savedOutput = await journal.readOutput({ reference: capturedResult.outputRef });
  assert.equal(savedOutput.output, proof);
  assert.equal(savedOutput.nextOffset, null);
  const events = (await journal.read({ kind: 'event', limit: 100 })).records.map(record => record.event);
  assert.equal(events.filter(event => event.type === 'review.rejected').length, 1);
  assert.equal(events.filter(event => event.type === 'review.passed').length, 1);
  assert.ok(events.some(event => event.type === 'feedback.delivered' && event.studentId === 'alice' && event.feedbackVersion === 1));
  assert.ok(!events.some(event => event.type === 'candidate.deferred'));
  const terminal = await journal.read({ kind: 'result' });
  assert.equal(terminal.records[0].result.status, 'completed');
}

for (const protocol of ['messages', 'responses', 'chat']) {
  test(`${protocol}: candidate review uses real agents, tools and persisted evidence`, { concurrency: false, timeout: 15000 }, async t => {
    await t.test('unchanged answer gains a recorded proof reference after rejection', async t => {
      await runProtocolScenario(t, protocol, false);
    });
    await t.test('corrected answer reuses the original recorded proof without another read', async t => {
      await runProtocolScenario(t, protocol, true);
    });
  });
}
