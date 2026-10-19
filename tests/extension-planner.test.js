import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionPlanner } from '../src/extension-planner.js';
import { JevJudge } from '../src/jev-judge.js';

const items = [
  { id: 'first', name: 'Packet analysis', description: 'Inspect captures' },
  { id: 'second', name: 'Browser', description: 'Operate a browser' },
  { id: 'third', name: 'Browser', description: 'A different browser service' },
];
const input = { kind: 'mcps', task: 'Inspect the login page', query: 'browser', items };
const decision = probabilities => ({ status: 'ok', applied: true, answers: Object.fromEntries(probabilities.map((probability, index) => [`relevant_${index}`, { type: 'boolean', probability }])) });
const planner = decide => new ExtensionPlanner({ judgment: { config: { enabled: true }, judge: { decide } } });
const choice = (value, confidence = 0.99) => ({ type: 'choice', choice: value, probabilities: { [value]: confidence } });
const nativeAnswers = (request, probabilities, values = {}) => Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key,
  question.type === 'noul' ? { noul: probabilities[Number(key.slice(9))] ?? 0.01 }
    : choice(values[key] || (key === 'loading' ? 'targeted' : 'unknown')),
]));

test('extension selection uses global Jev switch independently of four context checkboxes', async () => {
  const captured = [];
  const judge = new JevJudge({ enabled: true, features: { taskDispatch: false, toolCalls: false, toolResults: false, submissionReview: false } }, {
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body); captured.push(request);
      return Response.json({ answers: nativeAnswers(request, [0.01, 0.99, 0.98]) });
    },
  });
  const selected = await new ExtensionPlanner({ judgment: { config: { enabled: true }, judge } }).select(input);
  assert.equal(selected.source, 'jev');
  assert.deepEqual(selected.ids, ['second', 'third', 'first']);
  assert.deepEqual(selected.preferredIds, ['second', 'third']);
  assert.equal(selected.load, 'discover_tools');
  assert.equal(selected.strategy, 'targeted');
  assert.equal(judge.getStats().unclear, 1, 'unknown overlap answers do not invalidate confident independent relevance');
  assert.equal(captured.length, 1);
  await new ExtensionPlanner({ judgment: { config: { enabled: false }, judge } }).select(input);
  assert.equal(captured.length, 1);
  const disabledJudge = new JevJudge({}, { fetchImpl: () => assert.fail('disabled judge must not send') });
  assert.equal((await disabledJudge.decide('extensionSelection', { state: {}, questions: { one: { type: 'boolean', instructions: 'Useful?' } } })).status, 'disabled');
});

test('metadata allowlist, redaction and inherited cache exclude commands, bodies and secrets', async () => {
  const captured = [], secret = 'fixture-external-private-value';
  const judge = new JevJudge({ enabled: true }, { knownSecrets: [secret], fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); captured.push(request);
    return Response.json({ answers: nativeAnswers(request, [0.99]) });
  } });
  const helper = new ExtensionPlanner({ judgment: { config: { enabled: true }, judge } });
  const request = { kind: 'skills', task: secret, query: secret, items: [{ id: 'one', name: 'Example', description: secret,
    content: 'private skill body', command: 'private command', url: 'http://private-host', env: { SECRET: 'private env' }, headers: { Authorization: 'private header' }, agentIds: ['private agent'] }] };
  const result = await helper.select(request);
  await helper.select(request);
  assert.equal(result.load, 'read_skill');
  assert.equal(captured.length, 1);
  const payload = JSON.stringify(captured);
  for (const value of [secret, 'private skill body', 'private command', 'private-host', 'private env', 'private header', 'private agent']) assert.ok(!payload.includes(value), value);
  assert.deepEqual(Object.keys(captured[0].state.items[0]).sort(), ['description', 'id', 'name']);
  assert.match(payload, /REDACTED/);
  assert.equal(request.items[0].description, secret);
});

test('uncertain, failed, all-negative and invalid decisions preserve every fallback entry', async () => {
  for (const reply of [
    { status: 'timeout', applied: false }, { status: 'invalid', applied: false }, { status: 'unclear', applied: false },
    decision([0, 0.1, 0.04]), decision([0.94, 0.8, 0.5]), decision([NaN, 2, -1]), undefined,
  ]) {
    const result = await planner(async () => reply).select(input);
    assert.equal(result.source, 'fallback');
    assert.deepEqual(result.ids, items.map(item => item.id));
    assert.deepEqual(result.preferredIds, []);
  }
  assert.deepEqual((await planner(async () => { throw Error('private provider error'); }).select(input)).ids, items.map(item => item.id));
});

test('classification is bounded to two batches and leaves later capabilities reachable', async () => {
  const calls = [];
  const many = Array.from({ length: 75 }, (_, index) => ({ id: `item-${index}`, name: 'A'.repeat(500), description: 'B'.repeat(900) }));
  const result = await planner(async (point, request) => {
    calls.push({ point, request });
    return decision(request.state.items.map((_item, index) => index === 11 ? 0.99 : 0.01));
  }).select({ kind: 'mcps', task: 'T'.repeat(10000), query: 'Q'.repeat(900), items: many });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.preferredIds, ['item-11', 'item-23']);
  assert.equal(result.ids.length, 75);
  assert.equal(new Set(result.ids).size, 75);
  for (const { point, request } of calls) {
    assert.equal(point, 'extensionSelection');
    assert.equal(request.state.items.length, 12);
    assert.equal(Object.keys(request.questions).length, 25);
    for (let index = 0; index < 12; index++) {
      const duplicate = request.questions[`duplicate_${index}`];
      assert.equal(duplicate.type, 'choice');
      assert.equal(Object.hasOwn(duplicate.criteria, `item_${index}`), false);
      assert.equal(Object.keys(duplicate.criteria).length, 12);
    }
    assert.equal(request.state.task.length, 5000);
    assert.equal(request.state.query.length, 600);
    assert.equal(request.state.items[0].name.length, 200);
    assert.equal(request.state.items[0].description.length, 600);
  }
});

test('semantic overlap is judged without exact groups and never drops same-name items', async () => {
  let observed;
  const helper = planner(async (_point, request) => {
    observed = request;
    return { ...decision([0.01, 0.99, 0.98]), answers: { ...decision([0.01, 0.99, 0.98]).answers,
      duplicate_1: choice('item_2'), duplicate_2: choice('item_1'), loading: choice('targeted') } };
  });
  const result = await helper.select(input);
  assert.deepEqual(observed.state.duplicateGroups, []);
  assert.ok(observed.questions.duplicate_0);
  assert.ok(observed.questions.duplicate_1);
  assert.ok(observed.questions.duplicate_2);
  assert.deepEqual(result.duplicateHints, [{ ids: ['second', 'third'], preferredId: 'third' }]);
  assert.deepEqual(new Set(result.ids), new Set(items.map(item => item.id)));
  assert.deepEqual(result.preferredIds, ['second', 'third']);
  assert.equal(result.strategy, 'targeted');
});

test('unknown and low-confidence duplicate hints retain candidates and safe catalogue strategy', async () => {
  const result = await planner(async () => ({ ...decision([0.99, 0.99, 0.01]), status: 'unclear', applied: false,
    answers: { ...decision([0.99, 0.99, 0.01]).answers,
      duplicate_0: choice('unknown'), duplicate_1: choice('item_0', 0.94), duplicate_2: choice('item_2'),
      loading: choice('targeted', 0.9) },
  })).select(input);
  assert.equal(result.source, 'jev');
  assert.equal(result.strategy, 'catalogue');
  assert.deepEqual(result.duplicateHints, []);
  assert.deepEqual(result.ids, ['first', 'second', 'third']);
  assert.deepEqual(result.preferredIds, ['first', 'second']);
});

test('loading strategy has only two bounded options and uncertainty across batches retains catalogue', async () => {
  let count = 0;
  const more = Array.from({ length: 13 }, (_, index) => ({ id: `c${index}`, name: `Candidate ${index}` }));
  const result = await planner(async (_point, request) => {
    assert.deepEqual(Object.keys(request.questions.loading.criteria), ['targeted', 'catalogue']);
    const answer = decision(request.state.items.map(() => 0.99));
    answer.answers.loading = choice(++count === 1 ? 'targeted' : 'catalogue');
    return answer;
  }).select({ ...input, items: more });
  assert.equal(result.strategy, 'catalogue');
  assert.equal(result.ids.length, 13);
});

test('no invented output ID or freeform loading instruction can become an executable decision', async () => {
  const result = await planner(async () => ({ ...decision([0.99, 0.01, 0.01]),
    ids: ['outside-catalogue'], command: 'run this', load: 'execute_shell',
    answers: { ...decision([0.99, 0.01, 0.01]).answers, duplicate_0: choice('item_999'), loading: choice('execute_shell') },
  })).select({ ...input, duplicateGroups: [['first', 'second']] });
  assert.equal(result.load, 'discover_tools');
  assert.deepEqual(result.ids, ['first', 'second', 'third']);
  assert.deepEqual(result.duplicateHints, []);
  assert.equal(result.strategy, 'catalogue');
  assert.equal(Object.hasOwn(result, 'command'), false);
});

test('abort interrupts selection instead of continuing discovery or starting another batch', async () => {
  const controller = new AbortController();
  let calls = 0;
  const helper = planner(async (_point, _request, { signal }) => {
    calls++;
    assert.equal(signal, controller.signal);
    controller.abort(Error('cancelled'));
    return decision([0.99, 0.99, 0.99]);
  });
  await assert.rejects(helper.select(input, { signal: controller.signal }), /cancelled/);
  assert.equal(calls, 1);
  await assert.rejects(helper.select(input, { signal: controller.signal }), /cancelled/);
  assert.equal(calls, 1);
});
