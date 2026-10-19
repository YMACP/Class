import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompactionInput, COMPACTION_PROMPT, fitCompactedMemory, planInputCompaction, sanitizeContextData, validateCompactionSummary } from '../src/context-compaction.js';
import { estimateContextTokens } from '../src/context-policy.js';

test('summary validation rejects malformed output and never silently truncates', () => {
  assert.equal(validateCompactionSummary({ summary: '  Verified result; pending check.  ' }), 'Verified result; pending check.');
  assert.equal(validateCompactionSummary({ summary: 'x'.repeat(12000) }).length, 12000);
  for (const value of [null, [], 'text', {}, { summary: '' }, { summary: '  ' }, { summary: 1 }, { summary: 'x', thinking: 'private' }, { summary: 'x'.repeat(12001) }]) {
    assert.throws(() => validateCompactionSummary(value), /Invalid compaction summary/);
  }
  assert.match(COMPACTION_PROMPT, /untrusted historical data/);
  assert.match(COMPACTION_PROMPT, /verified facts versus unverified/);
});

test('projects chat, messages, and responses tool exchanges without hidden or media content', () => {
  const messages = [
    { role: 'assistant', content: 'Read the evidence.', reasoning_content: 'secret-chat', tool_calls: [{ id: 'chat-1', type: 'function', function: { name: 'read_evidence', arguments: '{"ref":"proof/chat"}' } }] },
    { role: 'tool', tool_call_id: 'chat-1', content: JSON.stringify({ output: 'verified chat output', evidenceRefs: ['proof/chat'], reasoning: 'secret-nested' }) },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret-messages', signature: 'secret-signature' }, { type: 'tool_use', id: 'msg-1', name: 'read_file', input: { path: 'proof.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'msg-1', content: [{ type: 'text', text: '{"output":"verified message output","refs":["proof/messages"]}' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'secret-image' } }] }] },
    { type: 'reasoning', id: 'private-r', encrypted_content: 'secret-encrypted', summary: [{ type: 'summary_text', text: 'secret-reasoning-summary' }] },
    { type: 'function_call', call_id: 'resp-1', name: 'web_search', arguments: '{"query":"test"}' },
    { type: 'function_call_output', call_id: 'resp-1', output: '{"output":"verified response output","refs":["proof/responses"]}' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,c2VjcmV0LWltYWdl' }] },
    { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'secret-audio-bytes', format: 'wav' } }, { type: 'file', file: { filename: 'proof.pdf', file_data: 'secret-file-bytes' } }] },
  ];
  const before = structuredClone(messages);
  const output = buildCompactionInput({ task: 'Verify only.', messages });
  const text = JSON.stringify(output);
  for (const word of ['secret-chat', 'secret-nested', 'secret-messages', 'secret-signature', 'secret-image', 'secret-encrypted', 'secret-reasoning-summary', 'c2VjcmV0LWltYWdl', 'secret-audio-bytes', 'secret-file-bytes']) assert.ok(!text.includes(word), word);
  for (const word of ['chat-1', 'msg-1', 'resp-1', 'read_file', 'web_search', 'proof/chat', 'proof/messages', 'proof/responses', 'verified chat output', 'verified message output', 'verified response output']) assert.ok(text.includes(word), word);
  assert.deepEqual(messages, before, 'projection must not change recoverable native history');
});

test('all auxiliary inputs share the budget and enormous current tasks are explicitly excerpted', () => {
  const task = 'GOAL:' + '当前目标和约束'.repeat(10000) + ':FINAL-CONSTRAINT';
  const output = buildCompactionInput({ task, previousSummary: 'old-summary '.repeat(10000), workingIndex: { notes: 'index '.repeat(10000) }, messages: [], maxTokens: 700 });
  assert.ok(estimateContextTokens(output) <= 700);
  assert.equal(output.task.truncated, true);
  assert.match(output.task.excerpt, /^GOAL:/);
  assert.match(output.task.excerpt, /:FINAL-CONSTRAINT$/);
  assert.equal(output.previousSummary.truncated, true);
  assert.equal(output.workingIndex.truncated, true);
});

test('bounded history retains oldest and newest complete exchanges with IDs and evidence refs', () => {
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `call-${i}`, type: 'function', function: { name: 'run', arguments: JSON.stringify({ command: `check-${i}` }) } }] });
    messages.push({ role: 'tool', tool_call_id: `call-${i}`, content: JSON.stringify({ output: `start-${i} ` + 'large output '.repeat(300) + ` end-${i}`, refs: [`proof-${i}`], outputRef: `archive-${i}`, callId: `receipt-${i}` }) });
  }
  const output = buildCompactionInput({ task: 'Current goal', messages, maxTokens: 2200 });
  assert.ok(estimateContextTokens(output) <= 2200);
  assert.ok(output.omittedRecords > 0);
  assert.equal(output.records[0].sourceIndex, 0);
  assert.equal(output.records.at(-1).sourceIndex, messages.length - 1);
  const calls = output.records.flatMap(record => record.toolCalls ?? []).map(call => call.id).sort();
  const results = output.records.flatMap(record => record.toolResults ?? []).map(result => result.callId).sort();
  assert.deepEqual(calls, results);
  assert.ok(output.records.some(record => record.evidenceRefs?.includes('proof-0')));
  assert.ok(output.records.some(record => record.evidenceRefs?.includes('proof-19')));
  assert.ok(output.records.some(record => record.evidenceRefs?.includes('archive-19')));
  assert.ok(output.records.some(record => record.evidenceRefs?.includes('receipt-19')));
});

test('interleaved parallel calls stay in one selection unit', () => {
  const messages = [
    { type: 'function_call', call_id: 'a', name: 'read', arguments: '{}' },
    { type: 'function_call', call_id: 'b', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'a', output: 'A'.repeat(5000) },
    { type: 'function_call_output', call_id: 'b', output: 'B'.repeat(5000) },
    { role: 'assistant', content: 'Latest known state.' },
  ];
  const output = buildCompactionInput({ task: 'Read', messages, maxTokens: 900 });
  const present = output.records.filter(record => record.sourceIndex < 4);
  assert.ok(present.length === 0 || present.length === 4);
  assert.ok(estimateContextTokens(output) <= 900);
});

test('repeated previous summaries remain bounded and invalid budgets fail explicitly', () => {
  let previousSummary = 'earlier state '.repeat(5000);
  for (let i = 0; i < 5; i++) {
    const input = buildCompactionInput({ task: 'Unchanged task', previousSummary, workingIndex: { previousSummary }, messages: [], maxTokens: 500 });
    assert.equal(input.task, 'Unchanged task');
    assert.ok(estimateContextTokens(input) <= 500);
    previousSummary = JSON.stringify(input);
  }
  for (const maxTokens of [0, -1, 0.5, NaN, Infinity, 1]) assert.throws(() => buildCompactionInput({ task: 'x', maxTokens }));
});

test('injected model summary and structured index share a strict final token budget', () => {
  const summary = { version: 1, summary: 'GOAL:' + '已验证待验证'.repeat(1800) + ':PENDING', note: 'Fallible working memory; use original evidence.' };
  const workingIndex = { facts: Array.from({ length: 10 }, (_, i) => ({ text: '事实'.repeat(450), references: ['fact:' + i] })),
    pending: Array.from({ length: 10 }, (_, i) => ({ text: '待办'.repeat(450), references: ['pending:' + i] })) };
  const originals = structuredClone({ summary, workingIndex });
  for (const maxTokens of [128, 300, 1200, 2400, 12000]) {
    const fitted = fitCompactedMemory({ summary, workingIndex, maxTokens });
    assert.ok(estimateContextTokens(fitted) <= maxTokens);
    assert.equal(typeof fitted.compactedConversation?.summary, 'string');
    assert.equal(fitted.compactedConversation.truncated, true);
    assert.match(fitted.compactedConversation.summary, /^GOAL:/);
    assert.match(fitted.compactedConversation.summary, /:PENDING$/);
    assert.equal(fitted.compactedWorkingState.truncated, true);
  }
  assert.deepEqual({ summary, workingIndex }, originals);
});

test('small auxiliary memories remain complete; a tiny budget safely omits them', () => {
  const summary = { version: 1, summary: 'Done A; verify B.', note: 'Not evidence.' }, workingIndex = { evidence: [{ references: ['proof:1'] }] };
  assert.deepEqual(fitCompactedMemory({ summary, workingIndex, maxTokens: 300 }), { compactedConversation: summary, compactedWorkingState: workingIndex });
  for (const maxTokens of [0, 1, 4, NaN, -1]) assert.deepEqual(fitCompactedMemory({ summary, workingIndex, maxTokens }), {});
  assert.deepEqual(fitCompactedMemory({ maxTokens: 100 }), {});
});

test('summary-only and index-only memories include the wrapper cost in their budget', () => {
  for (const maxTokens of [20, 64, 100, 500]) {
    const summaryOnly = fitCompactedMemory({ summary: { summary: '中'.repeat(12000) }, maxTokens });
    const indexOnly = fitCompactedMemory({ workingIndex: { text: '索引'.repeat(12000) }, maxTokens });
    assert.ok(estimateContextTokens(summaryOnly) <= maxTokens);
    assert.ok(estimateContextTokens(indexOnly) <= maxTokens);
    if (summaryOnly.compactedConversation) assert.equal(typeof summaryOnly.compactedConversation.summary, 'string');
  }
});

test('archival sanitizer preserves full public content while removing secrets and private payloads', () => {
  const publicText = 'PUBLIC-BEGIN:' + '公开证据'.repeat(20000) + ':PUBLIC-END';
  const input = { publicText, constraints: ['Do not modify the target.'],
    apiKey: 'field-secret', access_token: 'token-secret', headers: { Authorization: 'Bearer header-secret', Cookie: 'session=private-cookie' },
    output: JSON.stringify({ publicResult: 'Evidence is stored in proof:1', evidenceRefs: ['proof:1'], nested: JSON.stringify({ password: 'nested-secret', output: 'uses known-value' }),
      reasoning_content: 'hidden-secret', data: { description: 'ordinary public data' } }),
    blocks: [{ type: 'reasoning', text: 'private-thought' }, { type: 'text', text: 'public decision: inspect logs' },
      { type: 'image', source: { type: 'base64', data: 'image-secret' }, file_id: 'image-ref' },
      { type: 'input_audio', input_audio: { data: 'audio-secret', format: 'wav' } },
      { type: 'file', file: { filename: 'public.pdf', file_data: 'file-secret' } }],
    raw: new Uint8Array([80, 82, 73, 86, 65, 84, 69]), serializedBuffer: { type: 'Buffer', data: [1, 2, 3] },
    link: 'https://example.test/path?api_key=query-secret&mode=public',
    tokenBudget: 4096, signature: 'private-signature', 'label-known-value': 'known-value',
  };
  const before = structuredClone(input), output = sanitizeContextData(input, { secrets: ['known-value'] });
  assert.equal(output.publicText, publicText, 'archiving must not excerpt original public observations');
  assert.deepEqual(output.constraints, input.constraints);
  assert.equal(output.tokenBudget, 4096);
  assert.equal(output.link, 'https://example.test/path?api_key=[REDACTED]&mode=public');
  assert.equal(output.output.nested.output, 'uses [REDACTED]');
  assert.deepEqual(output.output.evidenceRefs, ['proof:1']);
  assert.deepEqual(output.output.data, { description: 'ordinary public data' });
  assert.equal(output.blocks[0].text, 'public decision: inspect logs');
  const encoded = JSON.stringify(output);
  for (const secret of ['field-secret', 'token-secret', 'header-secret', 'private-cookie', 'nested-secret', 'known-value', 'hidden-secret', 'private-thought', 'image-secret', 'audio-secret', 'file-secret', 'query-secret', 'private-signature']) {
    assert.ok(!encoded.includes(secret), secret);
  }
  assert.match(encoded, /image-ref/);
  assert.deepEqual(input, before);
});

test('sanitizing native tool JSON preserves similarly named public evidence fields and types', () => {
  const evidence = { type: 'digital_signature', signature_valid: true, encrypted_file_path: 'evidence/archive.enc',
    reasoning_status: 'verification completed', thinking_time_ms: 12,
    details: { type: 'encrypted_file', path: 'evidence/archive.enc' } };
  const message = { role: 'tool', tool_call_id: 'verify-signature', content: JSON.stringify(evidence) };
  assert.deepEqual(sanitizeContextData(message).content, evidence);
  const input = buildCompactionInput({ task: 'Check the signed file.', messages: [message] });
  assert.deepEqual(input.records[0].content.content, evidence);
});

test('exact private protocol fields and reasoning blocks remain excluded from archives', () => {
  const input = { visible: 'verified public result', thinking: 'private-one', redacted_thinking: 'private-two',
    reasoning: 'private-three', reasoning_content: 'private-four', reasoning_details: ['private-five'],
    encrypted_content: 'private-six', signature: 'private-seven',
    content: [{ type: 'thinking', thinking: 'private-eight' }, { type: 'redacted_thinking', data: 'private-nine' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'private-ten' }] },
      { type: 'thinking_delta', thinking: 'private-eleven' }, { type: 'signature_delta', signature: 'private-twelve' },
      { type: 'text', text: 'public decision' }] };
  assert.deepEqual(sanitizeContextData(input), { visible: 'verified public result', content: [{ type: 'text', text: 'public decision' }] });
});

test('archival sanitizer rejects circular or excessive nesting instead of silently losing public data', () => {
  const cycle = { value: 'public' }; cycle.next = cycle;
  assert.throws(() => sanitizeContextData(cycle), /circular/);
  let deep = { text: 'must not be silently dropped' };
  for (let i = 0; i < 70; i++) deep = { next: deep };
  assert.throws(() => sanitizeContextData(deep), /depth/);
  assert.throws(() => sanitizeContextData(JSON.stringify(deep)), /depth/);
  const shared = { text: 'same observation' };
  assert.deepEqual(sanitizeContextData([shared, shared]), [shared, shared]);
});

test('model compaction input redacts every source and retains auxiliary archive references', () => {
  const previousSummary = { summary: 'Previous credential fake-secret ' + 'work '.repeat(2000), archiveReferences: ['context:prior'], readWith: { name: 'context_read', args: { reference: 'context:prior' } } };
  const input = buildCompactionInput({ task: 'Never print fake-secret', previousSummary,
    workingIndex: { facts: [{ text: 'observed fake-secret', references: ['proof:complete'] }] },
    messages: [{ role: 'tool', tool_call_id: 'call-1', content: '{"output":"fake-secret","apiKey":"not-known-but-sensitive"}' }],
    secrets: ['fake-secret'], maxTokens: 900 });
  const encoded = JSON.stringify(input);
  assert.ok(!encoded.includes('fake-secret'));
  assert.ok(!encoded.includes('not-known-but-sensitive'));
  assert.deepEqual(input.sourceReferences, ['context:prior', 'proof:complete']);
  assert.ok(estimateContextTokens(input) <= 900);
});

test('bounded memory retains complete retrievable archive metadata or explicitly refuses its budget', () => {
  const archiveReferences = ['context:first', 'context:second'];
  const readWith = { name: 'context_read', args: { reference: 'context:second', offset: 0, limit: 16384 } };
  const summary = { version: 1, summary: 'BEGIN ' + 'verified evidence pending review '.repeat(2000) + ' END', archiveReferences, readWith };
  const workingIndex = { pending: 'check evidence '.repeat(5000) };
  for (const maxTokens of [256, 512, 1200]) {
    const output = fitCompactedMemory({ summary, workingIndex, maxTokens });
    assert.ok(estimateContextTokens(output) <= maxTokens);
    assert.deepEqual(output.compactedConversation.archiveReferences, archiveReferences);
    assert.deepEqual(output.compactedConversation.readWith, readWith);
    assert.match(output.compactedConversation.summary, /^BEGIN/);
    assert.match(output.compactedConversation.summary, /END$/);
  }
  for (const maxTokens of [0, 1, 20, 64]) {
    assert.throws(() => fitCompactedMemory({ summary, workingIndex, maxTokens }), { code: 'CONTEXT_REFERENCE_BUDGET' });
  }
  assert.throws(() => fitCompactedMemory({ summary: { ...summary, archiveReferences: Array.from({ length: 100 }, (_, i) => 'context:unbroken-' + i) }, maxTokens: 256 }), { code: 'CONTEXT_REFERENCE_BUDGET' });
});

test('first-input projection archives only optional histories while pinning current task and authority', () => {
  const oldText = 'old public observation '.repeat(1500);
  const latest = { id: 'feedback-2', type: 'teacher_feedback', feedbackVersion: 2, content: 'Check the missing negative case.' };
  const accepted = { id: 'fact-1', type: 'discovery', accepted: true, status: 'accepted', content: 'Accepted shared conclusion.', evidenceRef: 'proof:accepted' };
  const input = { task: 'Original task — inspect only.', constraints: ['No writes'], acceptanceCriteria: [{ id: 'a', description: 'Verify every route' }],
    feedbackVersion: 2, submissionFeedback: 'Keep the entire latest instruction.', resumeWarnings: [{ callId: 'write-1', reason: 'Do not replay.' }],
    customInput: { history: 'Unknown fields must remain whole.' }, answer: { content: 'Current candidate answer.' },
    history: [{ content: oldText, evidenceRef: 'proof:history' }], toolHistory: [{ output: oldText, callId: 'tool-1' }],
    feedbackHistory: [{ id: 'feedback-1', feedbackVersion: 1, content: oldText }, latest],
    blackboard: [accepted, { id: 'feedback-1', type: 'teacher_feedback', feedbackVersion: 1, content: oldText }, latest,
      { id: 'rejected-1', type: 'discovery', status: 'rejected', content: oldText, evidenceRef: 'proof:rejected' }],
    reviewSnapshot: { reviewId: 'review-3', feedbackVersion: 2, task: 'Snapshot original task.', candidates: [{ id: 'candidate-1', content: 'Current candidate.' }],
      students: [{ studentId: 'alice', history: [{ content: oldText }], tools: [{ output: oldText, evidenceRef: 'proof:tool' }], inProgress: [{ callId: 'active-1', status: 'running' }], solverInFlight: true }] },
  };
  const original = structuredClone(input), plan = planInputCompaction(input, { maxTokens: 3200 });
  assert.equal(plan.changed, true); assert.equal(plan.archiveRequired, true); assert.equal(plan.withinBudget, true);
  assert.ok(estimateContextTokens(plan.input) <= 3200);
  assert.deepEqual(input, original, 'the draft must not change the replayable original input');
  for (const key of ['task', 'constraints', 'acceptanceCriteria', 'feedbackVersion', 'submissionFeedback', 'resumeWarnings', 'customInput', 'answer']) assert.deepEqual(plan.input[key], input[key], key);
  assert.deepEqual(plan.input.blackboard[0], accepted);
  assert.deepEqual(plan.input.blackboard[2], latest);
  assert.deepEqual(plan.input.feedbackHistory.at(-1), latest);
  assert.deepEqual(plan.input.reviewSnapshot.candidates, input.reviewSnapshot.candidates);
  assert.deepEqual(plan.input.reviewSnapshot.students[0].inProgress, input.reviewSnapshot.students[0].inProgress);
  assert.equal(plan.input.reviewSnapshot.students[0].solverInFlight, true);
  assert.ok(plan.removed.some(item => item.path === '/history'));
  for (const item of plan.removed) {
    const keys = item.path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    assert.deepEqual(keys.reduce((object, key) => object[key], input), item.value);
    assert.equal(keys.reduce((object, key) => object[key], plan.input).contextCompacted, true);
  }
});

test('latest feedback is pinned by version and position; unknown authority cannot be compacted', () => {
  const long = 'authoritative '.repeat(3000);
  const feedbackHistory = [{ feedbackVersion: 7, content: long }, { feedbackVersion: 3, content: 'Arrival order alone is not authority.' }];
  const input = { task: 'Task', constraints: [long], feedbackHistory,
    blackboard: [{ id: 'new-shape', type: 'future-authority', content: long }, { type: 'discovery', status: 'accepted', content: long }] };
  const plan = planInputCompaction(input, { maxTokens: 500 });
  assert.equal(plan.changed, false); assert.equal(plan.withinBudget, false); assert.equal(plan.archiveRequired, false);
  assert.deepEqual(plan.input, input);
  assert.deepEqual(plan.removed, []);
  const small = { task: 'Small input', history: [{ content: 'short' }] };
  assert.deepEqual(planInputCompaction(small, { maxTokens: 500 }), { input: small, removed: [], changed: false, withinBudget: true, archiveRequired: false });
});

test('a giant original task is never excerpted by the continuation input planner', () => {
  const task = 'BEGIN TASK ' + '完整约束'.repeat(6000) + ' END TASK';
  const input = { task, history: [{ content: 'old history '.repeat(10000) }] };
  const plan = planInputCompaction(input, { maxTokens: 1000 });
  assert.equal(plan.withinBudget, false);
  assert.equal(plan.input.task, task);
  assert.equal(plan.changed, true);
  assert.equal(plan.archiveRequired, true);
  assert.throws(() => planInputCompaction(input, { maxTokens: 0 }), /budget/);
});
