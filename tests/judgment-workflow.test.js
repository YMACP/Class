import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudent, createTeacher } from '../src/agents.js';
import { ClassEngine } from '../src/engine.js';
import { JudgmentLayer } from '../src/judgment-layer.js';
import { RunJournal } from '../src/run-journal.js';
import { ToolManager } from '../src/tools.js';

const task = 'Compute and verify the sum of the integers from 1 through 100.';
const proof = 'Pair 1 with 100, 2 with 99, and so on: 50 pairs of 101.\n'
  + Array.from({ length: 160 }, (_, index) => `Catalog ornament ${String(index).padStart(3, '0')}: blue ribbons and green leaves decorate the outside of the notebook.\n`).join('')
  + 'VERIFIED: 50 * 101 = 5050.\n';
const derivation = Array.from({ length: 40 }, (_, index) => `Pair ${index + 1} has equal endpoint sum 101; its terms are distinct from the other pairs.\n`).join('');
const initialAnswer = `The sum is 5000.\n${derivation}`;
const correctedAnswer = `The sum is 5050.\n${derivation}`;
const bobProof = 'The arithmetic series formula also gives 100 * 101 / 2 = 5050.\n';

function untilAborted(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

function toolResponse(protocol, id, name, args) {
  if (protocol === 'messages') return Response.json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: args }] });
  if (protocol === 'responses') return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] });
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } }] });
}

function requestInput(body) {
  return JSON.parse((body.input || body.messages).find(item => item.role === 'user' && typeof item.content === 'string').content);
}

function lastToolResult(protocol, body) {
  if (protocol === 'responses') return JSON.parse(body.input.filter(item => item.type === 'function_call_output').at(-1).output);
  if (protocol === 'chat') return JSON.parse(body.messages.filter(item => item.role === 'tool').at(-1).content);
  return JSON.parse(body.messages.flatMap(item => Array.isArray(item.content) ? item.content : []).filter(item => item.type === 'tool_result').at(-1).content);
}

async function runJudgmentScenario(t, protocol, scenario = 'enabled') {
  const allFeatures = { taskDispatch: true, toolCalls: true, toolResults: true, submissionReview: true };
  const features = scenario === 'select-none' ? Object.fromEntries(Object.keys(allFeatures).map(name => [name, false]))
    : scenario === 'submission-only' ? { taskDispatch: false, toolCalls: false, toolResults: false, submissionReview: true } : allFeatures;
  const applies = point => !['disabled', 'error'].includes(scenario) && features[point];
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'class-judgment-workflow-'));
  const workspace = path.join(directory, 'workspace');
  const journal = new RunJournal({ directory: path.join(directory, 'journal'), runId: 'judgment-workflow' });
  let engine, tools, teacherTools, scenarioFailure;
  t.after(async () => {
    engine?.stop('test_cleanup');
    await Promise.all([tools?.stopAll(), teacherTools?.stopAll()]);
    await journal.flush();
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temporaryRoot, 'cleanup must remain inside the temporary root');
    assert.ok(path.basename(resolved).startsWith('class-judgment-workflow-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'proof.txt'), proof);
  await fs.writeFile(path.join(workspace, 'bob.txt'), bobProof);

  const judgeRequests = [], decisions = [];
  const judgment = new JudgmentLayer({
    enabled: scenario !== 'disabled', ...(scenario === 'legacy-shadow' ? { mode: 'shadow' } : {}),
    protocol: 'system-one', baseUrl: 'https://class-judge.invalid/v1/systemone', model: 'jev-fixture',
    apiKey: 'dedicated-judge-fixture-key', timeoutMs: 5000, minOutputChars: 6000,
    features,
  }, {
    onDecision: record => decisions.push(record),
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).hostname, 'class-judge.invalid');
      assert.equal(options.headers.authorization, 'Bearer dedicated-judge-fixture-key');
      const body = JSON.parse(options.body);
      judgeRequests.push(body);
      if (scenario === 'error') throw new Error('Isolated judgment transport failure');
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, {
        noul: id.startsWith('chunk_') || id === 'verification' || id === 'traceable' ? 0.99 : 0.01,
      }])), usage: { input_tokens: 12, output_tokens: 0 } });
    },
  });
  tools = new ToolManager({ cwd: workspace, allowShell: true });
  teacherTools = new ToolManager({ cwd: workspace, allowShell: false });
  const provider = { protocol, model: 'alice-model', baseUrl: 'https://class-model.invalid/v1', apiKey: 'model-fixture-key', timeoutMs: null };
  const students = [
    createStudent({ id: 'alice', name: 'Alice' }, provider, tools, { judgment }),
    createStudent({ id: 'bob', name: 'Bob', provider: { model: 'bob-model' } }, provider, tools, { judgment }),
  ];
  const teacher = createTeacher({ id: 'teacher', provider: { model: 'teacher-model' } }, provider, teacherTools, { judgment });
  engine = new ClassEngine({ students, teacher, tools, teacherTools, journal, taskTimeoutMs: 20000, discoveryWindowMs: 0 });

  const studentInputs = [], reviewed = [];
  let aliceRequests = 0, bobRequests = 0, references, projected, bobResult, recovered;
  let notifyBobReady;
  const bobReady = new Promise(resolve => { notifyBobReady = resolve; });
  const candidate = content => ({
    content, evidence: 'The saved command output records all 50 pairs of sum 101.', evidenceRefs: references,
    completionClaims: ['Computed the sum of 1 through 100.'], remainingIssues: [],
  });

  // Both HTTP transports are local mocks; only the fixture command and durable
  // evidence store are real. No model service or existing Class data is used.
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    try {
      assert.equal(new URL(url).hostname, 'class-model.invalid');
      const body = JSON.parse(options.body);
      const input = requestInput(body);
      assert.equal(input.task, task);
      if (body.model === 'bob-model') {
        bobRequests++;
        if (bobRequests === 1) return toolResponse(protocol, 'bob-read', 'read_file', { path: 'bob.txt' });
        bobResult = lastToolResult(protocol, body);
        assert.equal(bobResult.output, bobProof);
        notifyBobReady();
        return untilAborted(options.signal);
      }
      if (body.model === 'teacher-model') {
        reviewed.push(input);
        assert.ok(reviewed.length <= 2, 'the teacher must review exactly the initial and revised answers');
        const expected = reviewed.length === 1 ? initialAnswer : correctedAnswer;
        assert.equal(input.answer.content, expected, 'Jev must not truncate the full candidate delivered to the teacher');
        assert.equal(input.answer.candidates[0].content, expected);
        assert.deepEqual(input.answer.candidates, input.reviewSnapshot.candidates);
        assert.deepEqual(input.answer.evidenceRefs, references);
        assert.deepEqual(input.reviewSnapshot.students.map(student => student.studentId).sort(), ['alice', 'bob']);
        assert.deepEqual(Object.keys(input.histories).sort(), ['alice', 'bob']);
        const peer = input.reviewSnapshot.students.find(student => student.studentId === 'bob');
        assert.equal(peer.totalTools, 1, 'the unfinished peer and its evidence must remain part of the review');
        assert.ok(peer.tools.some(item => item.evidenceRef === bobResult.evidenceRef));
        if (applies('submissionReview')) assert.equal(input.judgeChecklist.evidenceIdentifiable, '是');
        else assert.equal(input.judgeChecklist, undefined);
        if (reviewed.length === 1) {
          return toolResponse(protocol, 'reject-answer', 'submit_review', {
            valid: false, report: 'Correct the arithmetic using the saved proof; do not run the command again.',
            verifiedFacts: ['The endpoint pairs each sum to 101.'], gaps: ['The submitted total is incorrect.'],
            recommendations: ['Read the archived output and correct the total.'],
          });
        }
        return toolResponse(protocol, 'accept-answer', 'submit_review', {
          valid: true, answer: 'The sum is 5050.', report: 'The corrected answer and both students\' evidence agree.', evidenceRefs: references,
        });
      }
      assert.equal(body.model, 'alice-model');
      studentInputs.push(input);
      aliceRequests++;
      assert.ok(aliceRequests <= 4, 'rejection must continue this task without replaying completed work');
      if (applies('taskDispatch')) assert.ok(input.judgeGuidance.reminders.length);
      else assert.equal(input.judgeGuidance, undefined);
      if (aliceRequests === 1) {
        const shell = process.platform === 'win32' ? 'powershell' : 'bash';
        const command = process.platform === 'win32'
          ? "[Console]::Write([System.IO.File]::ReadAllText((Join-Path (Get-Location) 'proof.txt')))"
          : 'cat proof.txt';
        return toolResponse(protocol, 'produce-proof', 'run_command', { shell, command });
      }
      if (aliceRequests === 2) {
        projected = lastToolResult(protocol, body);
        assert.equal(projected.success, true);
        assert.match(projected.outputRef, /^output:judgment-workflow:/);
        references = [projected.evidenceRef, projected.outputRef];
        if (applies('toolResults')) {
          assert.ok(projected.output.length < proof.length / 2, 'the model must actually receive a shorter output');
          assert.ok(projected.judgeFilter.omittedChunks.length > 0);
          assert.ok(!projected.output.includes('Catalog ornament 080:'));
          assert.ok(projected.output.includes('VERIFIED: 50 * 101 = 5050.'));
          assert.equal(projected.judgeFilter.reference, projected.outputRef);
        } else {
          assert.equal(projected.output, proof, 'disabled, unselected and failed judgments must preserve the complete output');
          assert.equal(projected.judgeFilter, undefined);
        }
        await Promise.race([bobReady, untilAborted(options.signal)]);
        return toolResponse(protocol, 'initial-answer', 'submit_answer', candidate(initialAnswer));
      }
      if (aliceRequests === 3) {
        assert.equal(input.feedbackVersion, 1);
        assert.ok(input.blackboard.some(item => item.type === 'teacher_feedback'));
        const read = projected.judgeFilter?.read || { name: 'read_evidence', args: { reference: projected.outputRef, byteOffset: 0, maxBytes: 65536 } };
        return toolResponse(protocol, 'recover-proof', read.name, read.args);
      }
      recovered = lastToolResult(protocol, body);
      assert.equal(typeof recovered.output, 'string', `the supplied read_evidence hint must be executable: ${JSON.stringify(recovered)}`);
      assert.equal(JSON.parse(recovered.output).output, proof, 'read_evidence must recover the exact original text, including omitted passages');
      assert.equal(recovered.judgeFilter, undefined, 'archive reads must never be filtered again');
      return toolResponse(protocol, 'corrected-answer', 'submit_answer', candidate(correctedAnswer));
    } catch (error) {
      scenarioFailure = error;
      engine.fail(error);
      throw error;
    }
  });

  const result = await engine.run(task);
  if (scenarioFailure) throw scenarioFailure;
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.answer, 'The sum is 5050.');
  assert.equal(result.reviewRound, 2);
  assert.equal(result.feedbackVersion, 1);
  assert.equal(result.feedbackDelivered.alice, 1);
  assert.equal(aliceRequests, 4);
  assert.deepEqual(studentInputs.map(input => input.feedbackVersion), [0, 0, 1, 1]);
  const reviews = (await journal.read({ kind: 'review' })).records;
  assert.deepEqual(reviews.map(record => record.judgement.valid), [false, true], 'the teacher remains the final authority despite Jev advice');
  const submissions = (await journal.read({ kind: 'student_result', studentId: 'alice' })).records;
  assert.deepEqual(submissions.map(record => record.result.feedbackVersion), [0, 1]);
  const completed = (await journal.read({ kind: 'tool', studentId: 'alice', limit: 100 })).records.filter(record => record.activity.type === 'completed');
  assert.deepEqual(completed.map(record => record.activity.action.name), ['run_command', 'read_evidence'], 'feedback must not rerun the original command');
  assert.equal(completed[0].reference, projected.evidenceRef);
  assert.equal(completed[0].outputRef, projected.outputRef);
  assert.equal(completed[0].activity.result.judgeFilter, undefined, 'the journal is written before context filtering');
  const saved = await journal.readOutput({ reference: projected.outputRef, limit: 65536 });
  assert.equal(saved.output, proof);
  assert.equal(saved.nextOffset, null);
  const snapshots = (await journal.read({ kind: 'review_snapshot' })).records;
  assert.equal(snapshots.length, 2);
  for (let index = 0; index < snapshots.length; index++) {
    assert.deepEqual(reviewed[index].reviewSnapshot.candidates, snapshots[index].snapshot.candidates);
    assert.deepEqual(reviewed[index].reviewSnapshot.students, snapshots[index].snapshot.students);
  }

  const stats = judgment.getStats();
  assert.equal(stats.filteredResults, applies('toolResults') ? 1 : 0);
  assert.equal(Object.hasOwn(stats, 'mode'), false);
  assert.equal(Object.hasOwn(stats, 'potentialSavedChars'), false);
  if (['disabled', 'select-none'].includes(scenario)) assert.equal(judgeRequests.length, 0, 'disabled Jev or no selected features must not send any request');
  else {
    assert.ok(judgeRequests.length > 0);
    assert.equal(decisions.some(item => item.point === 'toolResults'), features.toolResults);
    assert.equal(judgeRequests.filter(item => item.state.candidates).length, 2);
    if (scenario === 'error') assert.ok(stats.failures > 0);
    else {
      assert.ok(judgeRequests.find(item => item.state.candidates).state.candidates[0].content.length < initialAnswer.length);
      assert.deepEqual(new Set(decisions.map(item => item.point)), new Set(Object.keys(features).filter(name => features[name])));
    }
  }
  assert.equal(stats.savedChars > 0, applies('toolResults'));
}

for (const protocol of ['messages', 'responses', 'chat']) {
  test(`${protocol}: Jev filters model context while preserving evidence and teacher review`, { concurrency: false, timeout: 30000 }, async t => {
    await runJudgmentScenario(t, protocol);
  });
}

for (const scenario of ['disabled', 'legacy-shadow', 'select-none', 'submission-only', 'error']) {
  test(`chat: ${scenario} Jev preserves the same rejection, recovery and acceptance workflow`, { concurrency: false, timeout: 30000 }, async t => {
    await runJudgmentScenario(t, 'chat', scenario);
  });
}
