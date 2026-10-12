import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JudgmentLayer } from '../src/judgment-layer.js';

const allFeatures = { taskDispatch: true, toolCalls: true, toolResults: true, submissionReview: true };
const line = (index, width = 1300, ending = '\n') => `section ${index} ${String(index).padStart(3, '0')}`.padEnd(width, 'x') + ending;
const output = (count = 7) => Array.from({ length: count }, (_, index) => line(index)).join('');
const resultFor = text => ({ output: text, outputRef: 'output:local-test', evidenceRef: 'evidence:local-test', exitCode: 0, callId: 'call-test' });
const toolInput = result => ({ task: 'Identify the relevant diagnostic detail.', name: 'shell', args: { command: 'local fixture only' }, result });
const dispatchInput = () => ({ task: 'Update behavior and validate it.', blackboard: [{ content: 'A shared observation.', authors: ['one', 'two'], votes: { one: true } }] });
const submissionInput = () => ({ task: 'Review the implementation.', answer: { studentId: 'one', content: 'Changes are ready.', evidence: 'output:local-test' }, reviewSnapshot: { students: [{ studentId: 'one' }] } });

function fixture(config = {}, options = {}) {
  const requests = [];
  const { answer = () => 0.99, fetchImpl, ...callbacks } = options;
  const layer = new JudgmentLayer({ enabled: true, ...config }, {
    ...callbacks,
    fetchImpl: fetchImpl || (async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body, bytes: Buffer.byteLength(init.body) });
      return new Response(JSON.stringify({
        answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul: answer(id, body) }])),
        usage: { input_tokens: 25, output_tokens: 0 },
      }));
    }),
  });
  return { layer, requests };
}

test('disabled layer leaves all workflow values intact without contacting a provider', async () => {
  let requests = 0;
  const layer = new JudgmentLayer({}, { fetchImpl: async () => { requests++; throw Error('must not call'); } });
  const dispatch = dispatchInput(), submission = submissionInput(), result = resultFor(output());
  assert.strictEqual(await layer.taskDispatch(dispatch), dispatch);
  assert.strictEqual(await layer.submissionReview(submission), submission);
  assert.strictEqual(await layer.toolResult(toolInput(result)), result);
  assert.equal(await layer.beforeToolCall({ task: 'task', agentId: 'one', name: 'shell', args: {} }), undefined);
  assert.equal(requests, 0);
  assert.equal(layer.getStats().savedChars, 0);
});

test('routine optional submission fields reach the real adapter and remain advisory', async () => {
  const { layer, requests } = fixture();
  const input = submissionInput(), original = structuredClone(input);
  const reviewed = await layer.submissionReview(input);
  assert.equal(requests.length, 1, 'ordinary incomplete optional fields must not disable review silently');
  assert.equal(reviewed.judgeChecklist.evidenceIdentifiable, '是');
  assert.equal(reviewed.judgeChecklist.hasUnresolvedItems, '是');
  assert.match(reviewed.judgeChecklist.notice, /不是.*任务完成结论/);
  assert.strictEqual(reviewed.answer, input.answer);
  assert.strictEqual(reviewed.reviewSnapshot, input.reviewSnapshot);
  assert.deepEqual(input, original);
  assert.equal(Object.hasOwn(reviewed, 'accepted'), false);
  assert.equal(Object.hasOwn(reviewed, 'complete'), false);
  assert.equal(Object.hasOwn(requests[0].body.state.members[0], 'tools'), false);
});

test('legacy shadow configuration applies all selected features directly', async () => {
  const { layer, requests } = fixture({ mode: 'shadow', features: allFeatures });
  const dispatch = dispatchInput(), submission = submissionInput(), result = resultFor(output());
  assert.ok((await layer.taskDispatch(dispatch)).judgeGuidance);
  assert.ok((await layer.submissionReview(submission)).judgeChecklist);
  assert.ok((await layer.beforeToolCall({ task: 'task', agentId: 'one', name: 'shell', args: {} })).hints.length);
  assert.ok((await layer.toolResult(toolInput(result))).output.length < result.output.length);
  assert.equal(requests.length, 4);
  const stats = layer.getStats();
  assert.ok(stats.savedChars > 0);
  assert.equal(stats.filteredResults, 1);
  assert.equal(Object.hasOwn(stats, 'mode'), false);
  assert.equal(Object.hasOwn(stats, 'potentialSavedChars'), false);
});

test('each of the four selected features applies independently and unselected inputs stay intact', async () => {
  for (const selected of [null, ...Object.keys(allFeatures)]) {
    const features = Object.fromEntries(Object.keys(allFeatures).map(name => [name, name === selected]));
    const { layer, requests } = fixture({ features });
    const dispatch = dispatchInput(), submission = submissionInput(), source = resultFor(output());
    const dispatched = await layer.taskDispatch(dispatch);
    const reviewed = await layer.submissionReview(submission);
    const advice = await layer.beforeToolCall({ task: 'task', agentId: 'one', name: 'shell', args: {} });
    const filtered = await layer.toolResult(toolInput(source));
    if (selected === 'taskDispatch') assert.ok(dispatched.judgeGuidance);
    else assert.strictEqual(dispatched, dispatch);
    if (selected === 'submissionReview') assert.ok(reviewed.judgeChecklist);
    else assert.strictEqual(reviewed, submission);
    if (selected === 'toolCalls') assert.ok(advice.hints.length);
    else assert.equal(advice, undefined);
    if (selected === 'toolResults') assert.ok(filtered.output.length < source.output.length);
    else assert.strictEqual(filtered, source);
    assert.equal(requests.length, selected ? 1 : 0, 'only the selected point may contact Jev');
    assert.equal(layer.getStats().savedChars > 0, selected === 'toolResults');
  }
});

test('active filtering preserves original evidence, byte-exact retained passages and a recovery pointer', async () => {
  const { layer, requests } = fixture();
  const first = line('first', 1300, '\r\n'), last = line('last', 1300, '\r\n');
  const protectedPassage = ('ERROR: recorded diagnostic detail ' + 'y'.repeat(1200) + '\r\n');
  const text = first + line(1) + protectedPassage + line(3) + line(4) + last;
  const source = Object.freeze(resultFor(text));
  const filtered = await layer.toolResult(toolInput(source));
  assert.notStrictEqual(filtered, source);
  assert.equal(source.output, text);
  assert.ok(filtered.output.startsWith(first));
  assert.ok(filtered.output.endsWith(last));
  assert.ok(filtered.output.includes(protectedPassage));
  assert.equal(filtered.outputRef, source.outputRef);
  assert.equal(filtered.evidenceRef, source.evidenceRef);
  assert.equal(filtered.callId, source.callId);
  assert.deepEqual(filtered.judgeFilter.read, { name: 'read_evidence', args: { reference: source.outputRef, byteOffset: 0, maxBytes: 65536 } });
  assert.match(filtered.output, /read_evidence/);
  assert.equal(filtered.judgeFilter.originalChars, text.length);
  assert.equal(filtered.judgeFilter.retainedChars, filtered.output.length);
  assert.equal(layer.getStats().savedChars, text.length - filtered.output.length);
  assert.equal(layer.getStats().filteredResults, 1);
  assert.ok(requests[0].body.state.passages.every(passage => !passage.text.includes('ERROR:')));
});

test('evidence-only references use the existing reference-based recovery path', async () => {
  const { layer } = fixture();
  const result = { output: output(), evidenceRef: 'evidence:local-only' };
  const filtered = await layer.toolResult(toolInput(result));
  assert.deepEqual(filtered.judgeFilter.read, { name: 'read_evidence', args: { reference: result.evidenceRef } });
});

test('missing evidence, failures, media, structured output and source code bypass filtering', async () => {
  const { layer, requests } = fixture();
  const text = output();
  const cases = [
    { output: text }, resultFor('short'), { ...resultFor(text), error: 'tool problem' },
    { ...resultFor(text), success: false }, { ...resultFor(text), exitCode: 2 },
    { ...resultFor(text), media: [{}] }, { ...resultFor(text), images: ['image'] },
    resultFor(JSON.stringify({ records: text })),
    resultFor(line(0) + 'const payload = 1;\n' + text),
    resultFor(line(0) + '```text\n' + text + '```\n'),
    resultFor(line(0) + 'function evaluate() {\n' + text + '}\n'),
  ];
  for (const result of cases) assert.strictEqual(await layer.toolResult(toolInput(result)), result);
  for (const name of ['read_file', 'read_evidence', 'browser', 'session_search']) {
    const result = resultFor(text);
    assert.strictEqual(await layer.toolResult({ ...toolInput(result), name }), result);
  }
  assert.equal(requests.length, 0);
});

test('unclear, invalid, incomplete and failed provider replies preserve the entire original', async () => {
  const providers = [
    async (_url, init) => new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map(id => [id, { noul: 0.5 }])) })),
    async () => new Response(JSON.stringify({ answers: {} })),
    async () => new Response('{"answers":'),
    async () => new Response('provider private message', { status: 429 }),
    async () => { throw Error('provider unavailable'); },
  ];
  for (const fetchImpl of providers) {
    const { layer } = fixture({}, { fetchImpl });
    const source = resultFor(output());
    assert.strictEqual(await layer.toolResult(toolInput(source)), source);
    assert.equal(layer.getStats().savedChars, 0);
  }
});

test('confident but below the omission threshold never removes unique passages', async () => {
  const { layer } = fixture({}, { answer: () => 0.94 });
  const source = resultFor(output());
  assert.strictEqual(await layer.toolResult(toolInput(source)), source);
  assert.equal(layer.getStats().ok, 1);
  assert.equal(layer.getStats().savedChars, 0);
});

test('exact duplicate omission always points to a retained copy', async () => {
  const repeated = line('repeated');
  const source = resultFor(line(0) + repeated + repeated + line(3) + line(4) + line(5));
  const { layer } = fixture({}, { answer: () => 0.01 });
  const filtered = await layer.toolResult(toolInput(source));
  assert.equal(filtered.output.split(repeated).length - 1, 1);
  assert.match(filtered.output, /与第 2 段重复/);
  assert.deepEqual(filtered.judgeFilter.omittedChunks, [3]);
  const second = fixture();
  const classified = await second.layer.toolResult(toolInput(source));
  assert.ok(classified.output.includes(repeated), 'the duplicate is retained if its first occurrence was omitted');
  assert.doesNotMatch(classified.output, /与第 2 段重复/);
});

test('large tool results send only a bounded batch and never split overlong lines', async () => {
  const { layer, requests } = fixture();
  const longLine = 'unsplit:' + 'q'.repeat(9000) + '\n';
  const source = resultFor(line(0) + longLine + output(52));
  const filtered = await layer.toolResult(toolInput(source));
  assert.equal(requests.length, 1);
  assert.ok(Object.keys(requests[0].body.questions).length <= 20);
  assert.ok(requests[0].body.state.passages.every(passage => passage.text.length <= 1400));
  assert.ok(requests[0].bytes < 96 * 1024);
  assert.ok(filtered.output.includes(longLine));
  assert.ok(filtered.output.includes(line(50)), 'material outside the inspected batch remains intact');
  assert.equal(source.output.includes(longLine), true);
});

test('long multi-candidate reviews stay bounded without removing any teacher evidence', async () => {
  const { layer, requests } = fixture();
  const candidates = Array.from({ length: 22 }, (_, index) => ({
    studentId: `member-${index}`, content: 'c'.repeat(9000), evidence: 'e'.repeat(9000),
    completionClaims: ['a'.repeat(9000)], remainingIssues: ['b'.repeat(9000)], evidenceRefs: ['output:' + 'r'.repeat(9000)],
  }));
  const input = { task: 't'.repeat(14000), answer: { candidates }, blackboard: ['s'.repeat(18000)], feedbackHistory: ['f'.repeat(18000)], reviewSnapshot: { candidates, students: candidates.map(item => ({ studentId: item.studentId })) } };
  const reviewed = await layer.submissionReview(input);
  assert.equal(requests.length, 1, 'the bounded batch must fit the real adapter request limits');
  assert.ok(JSON.stringify(requests[0].body.state).length < 48000);
  assert.ok(requests[0].bytes <= 96 * 1024);
  assert.strictEqual(reviewed.answer.candidates, candidates);
  assert.strictEqual(reviewed.reviewSnapshot, input.reviewSnapshot);
  assert.equal(reviewed.answer.candidates.length, 22);
  assert.equal(requests[0].body.state.candidateCount, 22);
  assert.equal(requests[0].body.state.omittedCandidates, 6);
  assert.match(requests[0].body.state.caveat, /uncertain/);
});

test('Chinese tool passages respect the UTF-8 request budget and leave uninspected text intact', async () => {
  const { layer, requests } = fixture();
  const paragraphs = Array.from({ length: 30 }, (_, index) => `记录 ${index} ` + '资料'.repeat(645) + '\n');
  const source = resultFor(paragraphs.join(''));
  const filtered = await layer.toolResult({ task: '目标'.repeat(5000), name: 'shell', args: { description: '参数'.repeat(1500) }, result: source });
  assert.equal(requests.length, 1, 'Chinese text must fit the transport byte limit, not just the character limit');
  assert.ok(requests[0].bytes <= 96 * 1024);
  assert.ok(filtered.output.includes(paragraphs[28]));
  assert.equal(source.output, paragraphs.join(''));
});

test('Chinese multi-candidate reviews fit the provider request budget', async () => {
  const { layer, requests } = fixture();
  const candidates = Array.from({ length: 20 }, (_, index) => ({
    studentId: `member-${index}`, content: '正文'.repeat(5000), evidence: '依据'.repeat(5000),
    completionClaims: ['声明'.repeat(5000)], remainingIssues: ['待办'.repeat(5000)], evidenceRefs: ['引用'.repeat(5000)],
  }));
  const input = { task: '任务'.repeat(8000), answer: { candidates }, blackboard: ['共享'.repeat(9000)], feedbackHistory: ['反馈'.repeat(9000)] };
  const reviewed = await layer.submissionReview(input);
  assert.equal(requests.length, 1, 'Chinese review material must reach the actual adapter');
  assert.ok(requests[0].bytes <= 96 * 1024);
  assert.strictEqual(reviewed.answer.candidates, candidates);
});

test('dispatch adds only advisory pointers while preserving authors, votes and shared wording', async () => {
  const { layer, requests } = fixture({ features: allFeatures });
  const input = dispatchInput(), snapshot = structuredClone(input);
  const dispatch = await layer.taskDispatch(input);
  assert.equal(requests.length, 1);
  assert.deepEqual(dispatch.judgeGuidance.referenceFocus, ['blackboard:0']);
  assert.strictEqual(dispatch.blackboard, input.blackboard);
  assert.deepEqual(input, snapshot);
  assert.ok(dispatch.judgeGuidance.reminders.length > 0);
  assert.match(dispatch.judgeGuidance.notice, /权限许可/);
});

test('tool advice skips internal evidence reads and never authorizes or cancels an operation', async () => {
  const { layer, requests } = fixture({ features: allFeatures });
  const args = Object.freeze({ path: 'relative.txt' });
  const call = { task: 'task', agentId: 'one', name: 'read_file', args };
  assert.equal(await layer.beforeToolCall(call), undefined);
  assert.equal(requests.length, 0);
  const advice = await layer.beforeToolCall(call);
  assert.equal(requests.length, 1);
  assert.ok(advice.hints.length > 0);
  assert.match(advice.notice, /不是.*权限许可/);
  assert.equal(Object.hasOwn(advice, 'allowed'), false);
  assert.equal(Object.hasOwn(advice, 'cancel'), false);
  assert.deepEqual(args, { path: 'relative.txt' });
  for (const name of ['read_evidence', 'session_search', 'memory_get', 'sleep']) {
    assert.equal(await layer.beforeToolCall({ ...call, name }), undefined);
    assert.equal(await layer.beforeToolCall({ ...call, name }), undefined);
  }
  assert.equal(requests.length, 1);
});

test('a shared deadline cancels transport and returns both queued and active outputs unchanged', { timeout: 3000 }, async () => {
  let active = 0, peak = 0, started = 0;
  const { layer } = fixture({ timeoutMs: 80, maxConcurrency: 1 }, {
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      active++; started++; peak = Math.max(peak, active);
      const abort = () => { active--; reject(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }),
  });
  const sources = [resultFor(output(7)), resultFor(output(8))];
  const before = performance.now();
  const results = await Promise.all(sources.map(source => layer.toolResult(toolInput(source))));
  assert.strictEqual(results[0], sources[0]);
  assert.strictEqual(results[1], sources[1]);
  assert.equal(peak, 1);
  assert.equal(active, 0);
  assert.ok(started <= 2);
  assert.ok(performance.now() - before < 250, 'queued requests retain their original deadline');
  assert.equal(layer.getStats().timeouts, 2);
  assert.equal(layer.getStats().queued, 0);
});

test('caller cancellation propagates without converting a stopped run into a new result', async () => {
  const controller = new AbortController();
  let transportStarted;
  const ready = new Promise(resolve => { transportStarted = resolve; });
  const { layer } = fixture({}, { fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    transportStarted();
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const source = resultFor(output());
  const pending = layer.toolResult(toolInput(source), { signal: controller.signal });
  await ready;
  const reason = Error('run stopped by caller');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(layer.getStats().savedChars, 0);
  assert.equal(source.output, output());
});

test('statistics observer failures cannot break enabled or migrated workflows', async () => {
  for (const mode of [undefined, 'shadow', 'active']) {
    for (const onUpdate of [() => { throw Error('UI observer unavailable'); }, async () => { throw Error('UI observer unavailable'); }]) {
      const { layer } = fixture({ mode }, { onUpdate });
      const source = resultFor(output());
      const filtered = await layer.toolResult(toolInput(source));
      assert.ok(filtered.output.length < source.output.length);
    }
  }
  await delay(0);
});
