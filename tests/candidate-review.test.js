import test from 'node:test';
import assert from 'node:assert/strict';
import { ClassEngine } from '../src/engine.js';

const original = {
  type: 'answer',
  content: 'The sum is 5000.',
  evidence: 'Pair the endpoints: 50 pairs, each with sum 101.',
  completionClaims: ['Computed the sum of the original range.'],
  remainingIssues: [],
};

function untilAborted(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

// Exercise the public run loop and the activity hook installed by the engine.
// Tool results are deterministic fixtures: no command, file, model or journal
// is invoked, and every background solver ends when the run is cancelled.
async function runScenario(steps, { onFirstReview } = {}) {
  const tools = {
    async pauseAll() {},
    async resumeAll() {},
    async stopAll() {},
  };
  const teacherTools = { ...tools };
  const events = [], reviews = [];
  let step = 0;
  const completeTool = async ({ callId, studentId = 'alice', output = 'Verified: 50 * 101 = 5050.', outputRef, toolName = 'read_file', outputDigest }) => {
    await (studentId === 'teacher' ? teacherTools : tools).onActivity({
      type: 'completed', studentId, callId,
      action: { name: toolName, args: { path: 'proof.txt' } },
      result: { output, ...(outputRef ? { outputRef } : {}), ...(outputDigest ? { outputDigest } : {}) },
    });
    return callId;
  };
  const students = [
    {
      id: 'alice',
      async solve(ctx) {
        await ctx.checkpoint();
        const action = steps[step++];
        if (!action) return untilAborted(ctx.signal);
        return typeof action === 'function' ? action({ ctx, completeTool }) : structuredClone(action);
      },
      async vote() { return { approve: true, reason: 'Verified independently.' }; },
    },
    {
      id: 'bob',
      async solve(ctx) { await ctx.checkpoint(); return untilAborted(ctx.signal); },
      async vote() { return { approve: true, reason: 'Verified independently.' }; },
    },
  ];
  const teacher = {
    id: 'teacher',
    async merge(discoveries) {
      return discoveries.map(item => ({
        content: item.content, evidence: item.evidence, proposerIds: [item.studentId],
      }));
    },
    async judge(candidate, ctx) {
      reviews.push({ candidate: structuredClone(candidate), feedbackVersion: ctx.feedbackVersion });
      if (reviews.length === 1) {
        return {
          valid: false, report: 'Revise the conclusion or provide relevant new evidence.', gaps: ['The conclusion is not yet verified.'],
          ...await onFirstReview?.({ completeTool, candidate, ctx }),
        };
      }
      return { valid: true, answer: candidate.content, report: 'The revision has been accepted.' };
    },
  };
  const engine = new ClassEngine({ students, teacher, tools, teacherTools, taskTimeoutMs: 1500, voteTimeoutMs: 100, discoveryWindowMs: 0 });
  engine.on('event', event => {
    events.push(event);
    if (event.type === 'candidate.deferred') engine.stop('test_candidate_deferred');
  });
  const result = await engine.run('Compute and verify the requested result.');
  assert.notEqual(result.reason, 'task_timeout', 'the scenario must finish without relying on the task deadline');
  return { result, events, reviews };
}

function assertReviewedAgain({ result, events, reviews }) {
  assert.equal(result.status, 'completed', `expected a second review, got ${result.status}: ${result.reason}`);
  assert.equal(reviews.length, 2);
  assert.equal(result.reviewRound, 2);
  assert.equal(result.feedbackVersion, 1);
  assert.equal(events.filter(event => event.type === 'candidate.deferred').length, 0);
}

function assertDeferred({ result, events, reviews }, reason = 'no_new_evidence') {
  assert.equal(result.status, 'stopped', 'the scenario stops immediately after the candidate is deferred');
  assert.equal(reviews.length, 1, 'a deferred candidate must not invoke the teacher again');
  assert.equal(result.reviewRound, 1);
  assert.deepEqual(events.filter(event => event.type === 'candidate.deferred').map(event => event.reason), [reason]);
}

for (const toolName of ['plan_write', 'todo_write', 'plan_read', 'todo_read']) test(`${toolName} cannot unlock an unchanged candidate as new verified evidence`, async () => {
  const scenario = await runScenario([original, async ({ completeTool }) => {
    const reference = await completeTool({ callId: 'self-reported-plan', toolName, output: 'All work marked complete by the student' });
    return { ...original, evidenceRefs: [reference] };
  }]);
  assertDeferred(scenario);
});

test('different screenshot bytes with equal summary use their digest as new evidence', async () => {
  const scenario = await runScenario([async ({ completeTool }) => {
    const reference = await completeTool({ callId: 'image-one', toolName: 'browser', output: '{"bytes":100}', outputDigest: 'first-image' });
    return { ...original, evidenceRefs: [reference] };
  }, async ({ completeTool }) => {
    const reference = await completeTool({ callId: 'image-two', toolName: 'browser', output: '{"bytes":100}', outputDigest: 'second-image' });
    return { ...original, evidenceRefs: [reference] };
  }]);
  assertReviewedAgain(scenario);
});

test('a corrected answer body is reviewed with unchanged evidence and claims', { timeout: 5000 }, async () => {
  const scenario = await runScenario([original, { ...original, content: 'The sum is 5050.' }]);
  assertReviewedAgain(scenario);
  assert.equal(scenario.result.answer, 'The sum is 5050.');
  assert.equal(scenario.reviews[1].candidate.evidence, original.evidence);
  assert.deepEqual(scenario.reviews[1].candidate.completionClaims, original.completionClaims);
});

test('a change after the 8000-character presentation limit is reviewed', { timeout: 5000 }, async () => {
  const prefix = 'Detailed derivation. '.repeat(500);
  assert.ok(prefix.length > 8000);
  assertReviewedAgain(await runScenario([
    { ...original, content: prefix + 'The sum is 5000.' },
    { ...original, content: prefix + 'The sum is 5050.' },
  ]));
});

test('mathematically distinct Unicode notation is not collapsed by compatibility normalization', { timeout: 5000 }, async () => {
  assertReviewedAgain(await runScenario([
    { ...original, content: 'The expression is x².' },
    { ...original, content: 'The expression is x2.' },
  ]));
});

test('a meaningful indentation change inside fenced code is reviewed', { timeout: 5000 }, async () => {
  assertReviewedAgain(await runScenario([
    { ...original, content: 'Implementation:\n```python\nif ready:\n    total += 1\nprint(total)\n```' },
    { ...original, content: 'Implementation:\n```python\nif ready:\n    total += 1\n    print(total)\n```' },
  ]));
});

test('a string-space change inside inline code is reviewed', { timeout: 5000 }, async () => {
  assertReviewedAgain(await runScenario([
    { ...original, content: 'Use `label = "a  b"` as the expression.' },
    { ...original, content: 'Use `label = "a b"` as the expression.' },
  ]));
});

test('an identical candidate is deferred after rejection', { timeout: 5000 }, async () => {
  assertDeferred(await runScenario([original, original]));
});

test('whitespace and line-break changes do not trigger another review', { timeout: 5000 }, async () => {
  assertDeferred(await runScenario([
    original,
    { ...original, content: '  The   sum\nis 5000.\n', evidence: 'Pair the endpoints:\n50 pairs, each with sum 101.  ' },
  ]));
});

test('new evidence text can support another review of the same answer', { timeout: 5000 }, async () => {
  assertReviewedAgain(await runScenario([
    original,
    { ...original, evidence: original.evidence + ' A separate complete enumeration confirms the result.' },
  ]));
});

test('an explicit reference to a newly captured tool result permits review', { timeout: 5000 }, async () => {
  assertReviewedAgain(await runScenario([
    original,
    async ({ completeTool }) => ({ ...original, evidenceRefs: [await completeTool({ callId: 'new-proof' })] }),
  ]));
});

test('an explicit reference may use another student\'s captured evidence', { timeout: 5000 }, async () => {
  assertReviewedAgain(await runScenario([
    original,
    async ({ completeTool }) => ({ ...original, evidenceRefs: [await completeTool({ callId: 'bob-proof', studentId: 'bob' })] }),
  ]));
});

test('a student may cite evidence captured by the teacher during a rejected review', { timeout: 5000 }, async () => {
  assertReviewedAgain(await runScenario([
    original,
    ({ ctx }) => {
      const feedback = ctx.readBlackboard().find(entry => entry.type === 'teacher_feedback');
      assert.deepEqual(feedback?.evidenceRefs, ['teacher-proof']);
      return { ...original, evidenceRefs: feedback.evidenceRefs };
    },
  ], {
    async onFirstReview({ completeTool }) {
      const reference = await completeTool({ callId: 'teacher-proof', studentId: 'teacher' });
      return { evidenceRefs: [reference] };
    },
  }));
});

test('an explicit reference to an accepted discovery permits review', { timeout: 5000 }, async () => {
  const scenario = await runScenario([
    original,
    { type: 'discovery', content: 'A separately checked derivation confirms the result.', evidence: 'Independent proof.' },
    ({ ctx }) => {
      const accepted = ctx.readBlackboard().find(entry => entry.type === 'discovery' && entry.accepted);
      assert.ok(accepted, 'the discovery must pass the actual merge and voting path before it is cited');
      return { ...original, evidenceRefs: [accepted.id] };
    },
  ]);
  assertReviewedAgain(scenario);
  assert.equal(scenario.events.filter(event => event.type === 'discovery.decided' && event.accepted).length, 1);
});

test('unrelated activity from another student does not unlock a duplicate', { timeout: 5000 }, async () => {
  assertDeferred(await runScenario([
    original,
    async ({ completeTool }) => {
      await completeTool({ callId: 'bob-unrelated', studentId: 'bob', output: 'Unrelated directory inventory.' });
      return { ...original };
    },
  ]));
});

test('an unknown evidence reference cannot manufacture new proof', { timeout: 5000 }, async () => {
  assertDeferred(await runScenario([
    original,
    { ...original, evidenceRefs: ['invented-proof-reference'] },
  ]));
});

test('a fresh call identity for the same captured result is not new proof', { timeout: 5000 }, async () => {
  assertDeferred(await runScenario([
    async ({ completeTool }) => ({ ...original, evidenceRefs: [await completeTool({ callId: 'proof-first' })] }),
    async ({ completeTool }) => ({ ...original, evidenceRefs: [await completeTool({ callId: 'proof-repeated' })] }),
  ]));
});

test('an output reference alias for the same captured result is not new proof', { timeout: 5000 }, async () => {
  const outputRef = 'output:test-run:proof-artifact';
  assertDeferred(await runScenario([
    async ({ completeTool }) => ({ ...original, evidenceRefs: [await completeTool({ callId: 'proof-call', outputRef })] }),
    { ...original, evidenceRefs: [outputRef] },
  ]));
});

test('reference order and duplicate references do not trigger another review', { timeout: 5000 }, async () => {
  assertDeferred(await runScenario([
    async ({ completeTool }) => {
      await completeTool({ callId: 'proof-a', output: 'Proof A.' });
      await completeTool({ callId: 'proof-b', output: 'Proof B.' });
      return { ...original, evidenceRefs: ['proof-a', 'proof-b'] };
    },
    { ...original, evidenceRefs: ['proof-b', 'proof-a', 'proof-b'] },
  ]));
});

test('a substantive revision with an old feedback version is still deferred', { timeout: 5000 }, async () => {
  assertDeferred(await runScenario([
    original,
    { ...original, content: 'The sum is 5050.', feedbackVersion: 0 },
  ]), 'stale_feedback');
});

test('legacy answers without structured evidence can still be revised', { timeout: 5000 }, async () => {
  assertReviewedAgain(await runScenario([
    { type: 'answer', content: 'The sum is 5000.' },
    { type: 'answer', content: 'The sum is 5050.' },
  ]));
});
