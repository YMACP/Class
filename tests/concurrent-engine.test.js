import test from 'node:test';
import assert from 'node:assert/strict';
import { ClassEngine } from '../src/engine.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const answer = content => ({ type: 'answer', content, evidence: 'isolated fixture evidence' });
function untilAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}
function tools(overrides = {}) {
  return { paused: false, stopped: false, pauses: 0, resumes: 0,
    async pauseAll() { this.paused = true; this.pauses++; },
    async resumeAll() { this.paused = false; this.resumes++; },
    async stopAll() { this.stopped = true; }, ...overrides,
  };
}
function fixture(t, { solve = async () => answer('accepted'), judge = async candidate => ({ valid: true, answer: candidate.content }), studentTools = tools(), teacherTools = tools() } = {}) {
  const engine = new ClassEngine({ students: [
    { id: 'alice', solve, async vote() { return true; } },
    { id: 'bob', async solve(ctx) { return untilAbort(ctx.signal); }, async vote() { return true; } },
  ], teacher: { id: 'teacher', async merge(items) { return items.map(item => ({ content: item.content, proposerIds: [item.studentId] })); }, judge },
    tools: studentTools, teacherTools, taskTimeoutMs: null, discoveryWindowMs: 0,
  });
  let completion;
  t.after(async () => { engine.stop('fixture cleanup'); await completion; });
  return { engine, studentTools, teacherTools, start() { return completion = engine.run('Owned concurrency fixture'); } };
}
function event(engine, type) {
  return new Promise(resolve => {
    const listener = value => { if (value.type === type) { engine.off('event', listener); resolve(value); } };
    engine.on('event', listener);
  });
}

test('pausing one run retains an in-flight student result while another run completes', { timeout: 5000 }, async t => {
  const entered = deferred(), response = deferred(); let reviews = 0;
  const first = fixture(t, { async solve(ctx) { entered.resolve(ctx); return response.promise; }, async judge(candidate) { reviews++; return { valid: true, answer: candidate.content }; } });
  const completion = first.start(); await entered.promise;
  await first.engine.requestPause();
  assert.equal(first.studentTools.paused, true); assert.equal(first.teacherTools.paused, true);
  const recorded = event(first.engine, 'student.result'); response.resolve(answer('retained while paused')); await recorded; await tick();
  assert.equal(reviews, 0);
  const other = fixture(t); const otherResult = await other.start();
  assert.equal(otherResult.status, 'completed'); assert.equal(first.engine.running, true); assert.equal(first.engine.userPaused, true);
  assert.equal(first.studentTools.stopped, false);
  await first.engine.requestResume();
  assert.equal((await completion).answer, 'retained while paused');
});

test('teacher rejection cannot automatically override user pause or start another solve', { timeout: 5000 }, async t => {
  const entered = deferred(), judgement = deferred(); let solves = 0, reviews = 0;
  const run = fixture(t, { async solve() { return answer(`revision ${++solves}`); }, async judge(candidate, ctx) {
    if (++reviews === 1) { entered.resolve(ctx); return judgement.promise; }
    return { valid: true, answer: candidate.content };
  } });
  const completion = run.start(), teacherContext = await entered.promise;
  await run.engine.requestPause();
  let teacherPassed = false, votePassed = false;
  const teacherGate = teacherContext.checkpoint().then(() => { teacherPassed = true; });
  const voteGate = run.engine.context('bob', undefined, { gated: false }).checkpoint().then(() => { votePassed = true; });
  const feedback = event(run.engine, 'solving.resumed'); judgement.resolve({ valid: false, report: 'Provide revision' }); await feedback; await tick();
  assert.equal(teacherPassed, false); assert.equal(votePassed, false);
  assert.equal(solves, 1); assert.equal(reviews, 1);
  assert.equal(run.studentTools.paused, true); assert.equal(run.teacherTools.paused, true);
  assert.equal(run.studentTools.resumes, 0);
  await run.engine.requestResume(); await teacherGate; await voteGate;
  assert.equal((await completion).answer, 'revision 2');
});

test('user resume during internal review releases only teacher tools; success waits for a later user resume', { timeout: 5000 }, async t => {
  const entered = deferred(), judgement = deferred();
  const run = fixture(t, { async judge(candidate, ctx) { entered.resolve(ctx); return judgement.promise; } });
  const completion = run.start(); await entered.promise;
  await run.engine.requestPause(); await run.engine.requestResume();
  assert.equal(run.engine.userPaused, false); assert.equal(run.engine.paused, true);
  assert.equal(run.teacherTools.paused, false); assert.equal(run.studentTools.paused, true);
  assert.equal(run.studentTools.resumes, 0);
  await run.engine.requestPause();
  const recorded = event(run.engine, 'review.passed'); judgement.resolve({ valid: true, answer: 'review result retained' }); await recorded; await tick();
  assert.equal(run.engine.running, true); assert.equal(run.studentTools.stopped, false);
  assert.ok(!run.engine.events.some(item => item.type === 'task.finished'));
  await run.engine.requestResume();
  assert.equal((await completion).status, 'completed');
});

test('user pause racing an automatic OS resume re-pauses tools and stop aborts all pause gates', { timeout: 5000 }, async t => {
  const resuming = deferred(), finishResume = deferred(); let solves = 0;
  const studentTools = tools({ async resumeAll() { resuming.resolve(); await finishResume.promise; this.paused = false; this.resumes++; } });
  const run = fixture(t, { studentTools, async solve() { solves++; return answer('needs work'); }, async judge() { return { valid: false, report: 'Continue work' }; } });
  const completion = run.start(); await resuming.promise;
  const paused = run.engine.requestPause(); finishResume.resolve(); await paused; await tick();
  assert.equal(run.engine.userPaused, true); assert.equal(studentTools.paused, true); assert.equal(run.teacherTools.paused, true);
  assert.equal(solves, 1);
  const checkpoint = run.engine.context('teacher', undefined, { gated: false }).checkpoint();
  const rejected = assert.rejects(checkpoint, /fixture stop/);
  run.engine.stop('fixture stop'); await rejected;
  assert.equal((await completion).status, 'stopped');
  assert.equal(studentTools.stopped, true); assert.equal(run.teacherTools.stopped, true);
});
