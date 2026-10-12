import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_JUDGE_CONFIG, normalizeJudgeConfig } from '../src/judge-config.js';
import { JevJudge } from '../src/jev-judge.js';

const booleanRequest = state => ({ state, questions: { keep: { type: 'boolean', instructions: 'Does this contain required evidence?' } } });
const nativeAnswer = (noul = 0.98) => ({ answers: { keep: { noul } }, usage: { input_tokens: 18, output_tokens: 0 } });
async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const captured = { path: request.url, headers: request.headers, body: JSON.parse(body), response };
    requests.push(captured);
    await handler(captured, requests.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}
const respond = (response, body, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
};

test('judge config is disabled by default, strict and strips unknown and secret fields', () => {
  const config = normalizeJudgeConfig({ extra: 'not persisted', features: { extra: true } });
  assert.deepEqual(config, DEFAULT_JUDGE_CONFIG);
  assert.equal(config.enabled, false);
  assert.equal(Object.hasOwn(config, 'mode'), false);
  for (const mode of ['shadow', 'active']) {
    assert.deepEqual(normalizeJudgeConfig({ enabled: true, mode }), normalizeJudgeConfig({ enabled: true }), 'legacy modes must normalize to the same enabled configuration');
  }
  const publicConfig = normalizeJudgeConfig({ apiKey: 'fixture-key' }, { includeSecret: false });
  assert.equal(publicConfig.apiKey, '');
  assert.equal(publicConfig.hasApiKey, true);
  assert.equal(normalizeJudgeConfig({ hasApiKey: true }, { includeSecret: false }).hasApiKey, false);
  for (const raw of [null, [], { mode: 'off' }, { enabled: 'true' }, { timeoutMs: 0 }, { maxConcurrency: 99 }, { features: { toolCalls: 'yes' } }]) {
    assert.throws(() => normalizeJudgeConfig(raw));
  }
  for (const baseUrl of ['file:///secret', 'https://user:secret@host/', 'https://host/?apiKey=fixture-secret', 'https://host/#secret']) {
    assert.throws(() => normalizeJudgeConfig({ baseUrl }), error => !error.message.includes('fixture-secret') && !error.message.includes(baseUrl));
  }
});

test('legacy and submitted protocol/model values normalize without changing other Jev settings', () => {
  const options = { enabled: true, baseUrl: 'http://127.0.0.1:12345/v1/systemone', apiKey: 'fixture-key',
    timeoutMs: 2500, maxConcurrency: 3, minOutputChars: 8000,
    features: { taskDispatch: true, toolCalls: true, toolResults: false, submissionReview: false } };
  const expected = normalizeJudgeConfig(options);
  for (const values of [
    { protocol: 'openai', model: 'old-classifier' },
    { protocol: 'system-one', model: 'custom-model' },
    { protocol: 'unknown', model: '' },
    { protocol: null, model: { value: 'ignored' } },
  ]) assert.deepEqual(normalizeJudgeConfig({ ...options, ...values }), expected);
  assert.equal(expected.protocol, 'system-one');
  assert.equal(expected.model, 'jev-latest');
});

test('disabled judge and disabled decision points never call the provider', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; throw Error('unexpected request'); };
  const disabled = new JevJudge({}, { fetchImpl });
  assert.equal((await disabled.decide('toolResults', booleanRequest('text'))).status, 'disabled');
  const enabled = new JevJudge({ enabled: true }, { fetchImpl });
  assert.equal((await enabled.decide('toolCalls', booleanRequest('text'))).status, 'disabled');
  assert.equal((await enabled.decide('taskDispatch', booleanRequest('text'))).status, 'disabled');
  assert.equal((await enabled.decide('untrusted raw text', booleanRequest('text'))).status, 'invalid');
  assert.equal(calls, 0);
});

test('System One applies enabled judgments directly and migrates both legacy modes', async t => {
  const { baseUrl, requests } = await fixture(t, ({ response }) => respond(response, nativeAnswer()));
  const options = { enabled: true, baseUrl, model: 'fixture-jev', apiKey: 'fixture-private-key' };
  const judge = new JevJudge(options);
  const result = await judge.decide('toolResults', booleanRequest({ result: 'evidence' }));
  assert.equal(result.status, 'ok');
  assert.equal(result.applied, true);
  assert.equal(Object.hasOwn(result, 'mode'), false);
  assert.deepEqual(result.answers.keep, { type: 'boolean', probability: 0.98 });
  assert.equal(requests[0].path, '/v1/systemone');
  assert.equal(requests[0].headers.authorization, 'Bearer fixture-private-key');
  assert.deepEqual(requests[0].body, {
    model: 'jev-latest', state: { result: 'evidence' },
    questions: { keep: { type: 'noul', instructions: 'Does this contain required evidence?' } },
  });
  assert.deepEqual(result.usage, { inputTokens: 18, outputTokens: 0 });
  judge.recordSavedChars(4000);
  assert.equal(judge.getStats().savedChars, 4000);
  for (const mode of ['shadow', 'active']) {
    const migrated = new JevJudge({ ...options, baseUrl: baseUrl + '/v1', mode });
    assert.equal((await migrated.decide('toolResults', booleanRequest('evidence'))).applied, true);
    migrated.recordSavedChars(1200);
    migrated.recordSavedChars(-1);
    assert.equal(migrated.getStats().savedChars, 1200);
  }
  const disabled = new JevJudge({ ...options, enabled: false, mode: 'active' });
  disabled.recordSavedChars(1200);
  assert.equal(disabled.getStats().savedChars, 0);
  assert.equal(requests[1].path, '/v1/systemone');
});

test('legacy OpenAI configuration sends fixed native requests and validates choice probabilities', async t => {
  const { baseUrl, requests } = await fixture(t, ({ response }) => respond(response, {
    answers: { verdict: { type: 'choice', choice: 'complete', probabilities: { complete: 0.98, unclear: 0.02 } } },
    usage: { input_tokens: 25, output_tokens: 12 },
  }));
  const judge = new JevJudge({ enabled: true, protocol: 'openai', baseUrl: baseUrl + '/v1', model: 'test-classifier' });
  const result = await judge.decide('submissionReview', {
    state: { required: ['answer', 'evidence'], submitted: 'answer and evidence' },
    questions: { verdict: { type: 'choice', instructions: 'Are the submission fields present?', criteria: { complete: 'Both present', unclear: 'Uncertain' } } },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.applied, true);
  assert.equal(result.answers.verdict.choice, 'complete');
  assert.equal(requests[0].path, '/v1/systemone');
  assert.equal(requests[0].body.model, 'jev-latest');
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['model', 'questions', 'state']);
  assert.equal(requests[0].body.questions.verdict.type, 'choice');
  assert.deepEqual(result.usage, { inputTokens: 25, outputTokens: 12 });
});

test('state and questions are redacted before sending, cache and observer expose no input text', async t => {
  const { baseUrl, requests } = await fixture(t, ({ response }) => respond(response, nativeAnswer()));
  const records = [];
  const key = 'fixture-credential-very-private';
  const other = 'other-provider-secret-123456';
  const judge = new JevJudge({ enabled: true, baseUrl, apiKey: key }, { knownSecrets: [other], onDecision: record => records.push(record) });
  const request = {
    state: { apiKey: key, nested: { password: 'unspecified-pass', token: 'opaque-unlisted-value' }, text: `Authorization: Bearer xyz123secret ${other}; password="hidden123" https://name:password@example.com/ sk-fakeshapedcredential123456789` },
    questions: { keep: { type: 'boolean', instructions: `Check ${key} without revealing ${other}` } },
  };
  const result = await judge.decide('toolResults', request);
  assert.equal(result.status, 'ok');
  const transmitted = JSON.stringify(requests[0].body);
  for (const secret of [key, other, 'unspecified-pass', 'opaque-unlisted-value', 'xyz123secret', 'hidden123', 'sk-fakeshapedcredential123456789', 'name:password']) assert.ok(!transmitted.includes(secret), secret);
  assert.match(transmitted, /REDACTED/);
  assert.equal(request.state.apiKey, key, 'the caller state was not changed');
  const observed = JSON.stringify({ records, stats: judge.getStats(), result, judge });
  for (const secret of [key, other, 'required evidence', baseUrl, 'hidden123']) assert.ok(!observed.includes(secret));
  assert.deepEqual(Object.keys(records[0]).sort(), ['point', 'status', 'applied', 'cached', 'latencyMs', 'usage'].sort());
});

test('uncertain, missing, unknown, duplicate and invalid answers always fall back', async t => {
  const bad = [
    {}, { answers: {} }, { answers: { keep: { noul: -0.1 } } }, { answers: { keep: { noul: 1.1 } } },
    { answers: { keep: { noul: null } } }, { answers: { keep: { noul: '1' } } },
    { answers: { keep: { probability: 1 } } }, { answers: { keep: { noul: 1, type: 'choice' } } },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"answers":{"keep":{"probability":1}}}' } }] },
    { answers: { keep: { noul: 1 }, injected: { noul: 1 } } },
    '{"answers":{"keep":{"noul":0},"keep":{"noul":1}}}',
  ];
  const { baseUrl, requests } = await fixture(t, ({ response }, index) => respond(response, index <= bad.length ? bad[index - 1] : nativeAnswer(0.5)));
  const judge = new JevJudge({ enabled: true, baseUrl });
  for (let index = 0; index < bad.length; index++) {
    const result = await judge.decide('toolResults', booleanRequest('identical uncached request'));
    assert.equal(result.status, 'invalid', String(index));
    assert.equal(result.applied, false);
    assert.equal(result.answers, null);
  }
  const unclear = await judge.decide('toolResults', booleanRequest('unclear'));
  assert.equal(unclear.status, 'unclear');
  assert.equal(unclear.applied, false);
  assert.equal(requests.length, bad.length + 1);
});

test('invalid choices and partial boolean batches cannot authorize any action', async t => {
  const bodies = [
    { answers: { choose: { choice: 'execute-unlisted', probabilities: { 'execute-unlisted': 1 } } } },
    { answers: { choose: { choice: 'keep', probabilities: { keep: 2 } } } },
    { answers: { choose: { choice: 'keep', probabilities: { keep: 0.9, other: 0.9 } } } },
    { answers: { choose: { choice: 'keep' } } },
    { answers: { choose: { choice: 'other', probabilities: { other: 1 } } } },
  ];
  const { baseUrl } = await fixture(t, ({ response }, index) => respond(response, bodies[index - 1]));
  const judge = new JevJudge({ enabled: true, baseUrl });
  for (let i = 0; i < bodies.length; i++) {
    const result = await judge.decide('submissionReview', { state: i, questions: { choose: { type: 'choice', instructions: 'Choose a classification', criteria: { keep: 'Keep', other: 'Unsure' } } } });
    assert.equal(result.applied, false);
    assert.equal(result.status, i < 3 ? 'invalid' : 'unclear');
  }
  const partial = new JevJudge({ enabled: true }, { fetchImpl: async () => new Response(JSON.stringify(nativeAnswer(0.99))) });
  const result = await partial.decide('toolResults', { state: '', questions: { ...booleanRequest('').questions, second: { type: 'boolean', instructions: 'Can this be omitted?' } } });
  assert.equal(result.status, 'invalid');
  assert.equal(result.answers, null);
});

test('rate limits, authentication errors and provider text never leak or retry', async t => {
  const records = [];
  const { baseUrl, requests } = await fixture(t, ({ response }, index) => respond(response, { error: 'provider-private-text sk-secretmustnotleak123456789' }, index === 1 ? 429 : 401));
  const judge = new JevJudge({ enabled: true, baseUrl }, { onDecision: record => records.push(record) });
  const limited = await judge.decide('toolResults', booleanRequest('a'));
  const auth = await judge.decide('toolResults', booleanRequest('b'));
  assert.equal(limited.status, 'rate_limited');
  assert.equal(auth.status, 'auth');
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify({ limited, auth, records }), /provider-private-text|secretmustnotleak/);
  assert.equal(judge.getStats().rateLimited, 1);
});

test('one run shares a hashed bounded cache, with point and questions in the identity', async () => {
  let requests = 0;
  const judge = new JevJudge({ enabled: true }, { fetchImpl: async () => { requests++; return new Response(JSON.stringify(nativeAnswer())); } });
  const request = booleanRequest({ item: 'same' });
  const first = await judge.decide('toolResults', request);
  first.answers.keep.probability = 0;
  const cached = await judge.decide('toolResults', request);
  assert.equal(cached.cached, true);
  assert.equal(cached.answers.keep.probability, 0.98);
  assert.deepEqual(cached.usage, { inputTokens: 0, outputTokens: 0 });
  await judge.decide('submissionReview', request);
  await judge.decide('toolResults', { ...request, questions: { keep: { type: 'boolean', instructions: 'A different predicate?' } } });
  assert.equal(requests, 3);
  for (let index = 0; index < 260; index++) await judge.decide('toolResults', booleanRequest(index));
  assert.equal(judge.getStats().cacheEntries, 256);
  assert.equal((await judge.decide('toolResults', request)).cached, false);
  assert.equal(judge.getStats().inputTokens, requests * 18);
});

test('concurrency is bounded across all callers in a run', { timeout: 5000 }, async t => {
  let active = 0, peak = 0;
  const { baseUrl } = await fixture(t, async ({ response }) => {
    active++; peak = Math.max(peak, active);
    await delay(20);
    active--;
    respond(response, nativeAnswer());
  });
  const judge = new JevJudge({ enabled: true, baseUrl, maxConcurrency: 2, timeoutMs: 1500 });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => judge.decide('toolResults', booleanRequest(index))));
  assert.ok(results.every(result => result.status === 'ok'));
  assert.equal(peak, 2);
  assert.equal(judge.getStats().inFlight, 0);
  assert.equal(judge.getStats().queued, 0);
});

test('pending requests have a fixed upper bound and caller abort clears the whole queue', async () => {
  const controller = new AbortController();
  const judge = new JevJudge({ enabled: true, maxConcurrency: 1 }, {
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const pending = Array.from({ length: 35 }, (_, index) => judge.decide('toolResults', booleanRequest(index), { signal: controller.signal }));
  assert.equal(judge.getStats().inFlight, 1);
  assert.equal(judge.getStats().queued, 32);
  assert.equal((await pending[34]).status, 'rate_limited');
  controller.abort();
  const results = await Promise.all(pending);
  assert.equal(results.filter(result => result.status === 'rate_limited').length, 2);
  assert.equal(results.filter(result => result.status === 'aborted').length, 33);
  assert.equal(judge.getStats().queued, 0);
  assert.equal(judge.getStats().inFlight, 0);
});

test('queue waiting shares the original deadline and expired queued calls never start', { timeout: 5000 }, async t => {
  const { baseUrl, requests } = await fixture(t, () => {});
  const judge = new JevJudge({ enabled: true, baseUrl, timeoutMs: 180, maxConcurrency: 1 });
  const started = performance.now();
  const results = await Promise.all([judge.decide('toolResults', booleanRequest(1)), judge.decide('toolResults', booleanRequest(2))]);
  assert.ok(results.every(result => result.status === 'timeout'));
  assert.ok(performance.now() - started < 320, 'queued work did not receive a fresh timeout');
  await delay(30);
  assert.equal(requests.length, 1);
  assert.equal(judge.getStats().inFlight, 0);
  assert.equal(judge.getStats().queued, 0);
});

test('timeout aborts an incomplete body and caller cancellation removes pending work', { timeout: 5000 }, async t => {
  let closed = 0;
  const { baseUrl } = await fixture(t, ({ response }) => {
    response.on('close', () => { if (!response.writableEnded) closed++; });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"answers":');
  });
  const judge = new JevJudge({ enabled: true, baseUrl, timeoutMs: 120, maxConcurrency: 1 });
  const controller = new AbortController();
  const running = judge.decide('toolResults', booleanRequest(1));
  const queued = judge.decide('toolResults', booleanRequest(2), { signal: controller.signal });
  controller.abort();
  assert.equal((await queued).status, 'aborted');
  assert.equal((await running).status, 'timeout');
  await delay(30);
  assert.equal(closed, 1, 'native fetch actually closed its response stream');
  assert.equal(judge.getStats().inFlight, 0);
  const before = judge.getStats().requests;
  assert.equal((await judge.decide('toolResults', booleanRequest(3), { signal: controller.signal })).status, 'aborted');
  assert.equal(judge.getStats().requests, before);
});

test('oversized requests, responses and redirects fail closed without following the destination', async t => {
  let destinationHits = 0;
  const destination = await fixture(t, ({ response }) => { destinationHits++; respond(response, nativeAnswer()); });
  const source = await fixture(t, ({ response }, index) => {
    if (index === 1) { response.writeHead(302, { location: destination.baseUrl }); response.end(); }
    else respond(response, JSON.stringify({ answers: {}, padding: 'x'.repeat(70_000) }));
  });
  const judge = new JevJudge({ enabled: true, baseUrl: source.baseUrl });
  assert.equal((await judge.decide('toolResults', booleanRequest('redirect'))).status, 'error');
  assert.equal(destinationHits, 0);
  assert.equal((await judge.decide('toolResults', booleanRequest('large response'))).status, 'invalid');
  const before = source.requests.length;
  assert.equal((await judge.decide('toolResults', booleanRequest('x'.repeat(49_000)))).status, 'invalid');
  assert.equal(source.requests.length, before);
});

test('observer failures never change a valid decision', async () => {
  const fetchImpl = async () => new Response(JSON.stringify(nativeAnswer()));
  for (const onDecision of [() => { throw Error('observer'); }, async () => { throw Error('observer'); }]) {
    const judge = new JevJudge({ enabled: true }, { fetchImpl, onDecision });
    assert.equal((await judge.decide('toolResults', booleanRequest('ok'))).applied, true);
  }
});

test('optional state fields follow JSON semantics without mutating input or admitting invalid types', async () => {
  const requests = [];
  const judge = new JevJudge({ enabled: true }, { fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify(nativeAnswer()));
  } });
  const state = { required: 'value', missing: undefined, apiKey: undefined, nested: { missing: undefined }, list: ['first', undefined, , 'last'] };
  assert.equal((await judge.decide('submissionReview', booleanRequest(state))).status, 'ok');
  const expected = { required: 'value', nested: {}, list: ['first', null, null, 'last'] };
  assert.deepEqual(requests[0].state, expected);
  assert.equal(Object.hasOwn(state, 'missing'), true);
  assert.equal(state.list[1], undefined);
  assert.equal(2 in state.list, false);
  assert.equal((await judge.decide('submissionReview', booleanRequest(expected))).cached, true);
  for (const invalid of [undefined, { method() {} }, { value: Symbol('unsupported') }, { value: NaN }]) {
    assert.equal((await judge.decide('submissionReview', booleanRequest(invalid))).status, 'invalid');
  }
  assert.equal(requests.length, 1);
});
