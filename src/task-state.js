// Compact working state is an index into evidence, never a replacement for it.
const text = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const bounded = (value, max = 900) => { const s = text(value); return s.length <= max ? s : s.slice(0, max * .7) + '\n[…read original evidence…]\n' + s.slice(-max * .3); };
const refs = value => [...new Set([value?.evidenceRecordRef, value?.evidenceRef, value?.outputRef, value?.result?.evidenceRef, value?.result?.outputRef, value?.fullContentRef, value?.submissionId, value?.callId, value?.toolCallId, value?.result?.callId, ...(value?.evidenceRefs || [])].filter(item => typeof item === 'string'))].slice(0, 8);
export function taskDigest({ previous, blackboard = [], history = [], feedbackHistory = [], tools = [] } = {}) {
  const out = { version: 1, facts: [], pending: [], feedback: [], evidence: [], omitted: previous?.omitted || 0, note: 'Bounded working index. Statements are unverified unless marked; retrieve cited originals. Never infer task completion from this digest.' };
  for (const key of ['facts','pending','feedback','evidence']) out[key] = [...(previous?.[key] || [])];
  const add = (key, value) => { if (!value.text) return; const items = out[key]; const same = items.findIndex(item => item.text === value.text); if (same >= 0) items.splice(same, 1); items.push(value); };
  for (const item of blackboard) {
    if (item.type === 'teacher_feedback') continue;
    add(item.accepted || item.status === 'accepted' ? 'facts' : 'pending', { text: bounded(item.content), status: item.accepted || item.status === 'accepted' ? 'shared_finding' : 'unverified', references: [item.id, ...refs(item)].filter(Boolean) });
  }
  for (const item of history) {
    if (item.action?.type === 'tool') { tools = [...tools, { ...item.action, result: item.result }]; continue; }
    add('pending', { text: bounded(item.content), status: item.type === 'answer' ? 'candidate_not_verified' : 'reported_not_verified', references: refs(item) });
    for (const gap of item.remainingIssues || []) add('pending', { text: bounded(gap), status: 'open', references: refs(item) });
  }
  for (const item of feedbackHistory) {
    add('feedback', { text: bounded(item.report), feedbackVersion: item.feedbackVersion, references: refs(item) });
    for (const fact of item.verifiedFacts || []) add('facts', { text: bounded(fact), status: 'teacher_reported_verified', references: refs(item) });
    for (const gap of item.gaps || []) add('pending', { text: bounded(gap), status: 'teacher_gap', feedbackVersion: item.feedbackVersion, references: refs(item) });
  }
  for (const item of tools) add('evidence', { text: bounded({ tool: item.action?.name || item.name, status: item.type || item.status, result: item.result }), status: item.result?.executionStatus === 'unknown' ? 'uncertain' : item.result?.error || item.result?.success === false || item.type === 'failed' ? 'failed' : item.type === 'completed' ? 'recorded_not_independently_verified' : 'check_original', references: refs(item) });
  for (const key of ['facts','pending','feedback','evidence']) { const limit = key === 'feedback' ? 6 : 10; if (out[key].length > limit) { out.omitted += out[key].length - limit; out[key] = out[key].slice(-limit); } }
  return out;
}

export function normalizeCriteria(value) {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw Error('Acceptance criteria must contain 1–32 requirements');
  const ids = new Set();
  return value.map((item, index) => {
    if (!item || typeof item.description !== 'string' || !item.description.trim() || item.description.length > 4000 || !['tool','text','either'].includes(item.evidenceType)) throw Error('Each acceptance criterion requires description and evidenceType: tool, text or either');
    const id = item.id || `criterion-${index + 1}`;
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || ids.has(id)) throw Error('Acceptance criterion IDs must be unique');
    ids.add(id); return { id, description: item.description.trim(), evidenceType: item.evidenceType };
  });
}

export function checkAcceptance(criteria, judgement, { evidence = new Set(), textReferences = new Set(), inProgress = false } = {}) {
  const problems = [], items = judgement?.criteriaResults;
  if (!Array.isArray(items)) return ['老师尚未逐项提交验收结论。'];
  const ids = new Set();
  for (const item of items) { if (!item || ids.has(item.criterionId) || !criteria.some(c => c.id === item.criterionId)) problems.push('验收条目包含重复或未知条件。'); ids.add(item?.criterionId); }
  for (const criterion of criteria) {
    const item = items.find(entry => entry?.criterionId === criterion.id);
    if (!item || item.status !== 'passed' || typeof item.reason !== 'string' || !item.reason.trim()) { problems.push(`未通过：${criterion.description}`); continue; }
    const cited = item.evidenceRefs;
    if (!Array.isArray(cited) || !cited.length || cited.some(ref => typeof ref !== 'string' || (!evidence.has(ref) && !textReferences.has(ref)))) { problems.push(`证据引用无效：${criterion.description}`); continue; }
    if (criterion.evidenceType === 'tool' && !cited.some(ref => evidence.has(ref))) problems.push(`缺少已完成工具证据：${criterion.description}`);
    if (!cited.some(ref => evidence.has(ref)) && (item.evidenceKind !== 'text' || typeof item.reason !== 'string' || !item.reason.trim())) problems.push(`须明确说明文本推导依据：${criterion.description}`);
  }
  if (inProgress) problems.push('仍有执行中或执行结果不确定的操作，须先核查。');
  return [...new Set(problems)];
}

// Only state data is encoded: callers never pass provider configuration/keys.
export function encodeState(value) {
  if (value instanceof Map) return { $classMap: [...value].map(([k,v]) => [k, encodeState(v)]) };
  if (value instanceof Set) return { $classSet: [...value].map(encodeState) };
  if (Array.isArray(value)) return value.map(encodeState);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined && typeof v !== 'function').map(([k,v]) => [k, encodeState(v)]));
  return value;
}
export function decodeState(value, depth = 0) {
  if (depth > 80) throw Error('Snapshot is too deeply nested');
  if (Array.isArray(value)) return value.map(v => decodeState(v, depth + 1));
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$classMap')) return new Map(value.$classMap.map(([k,v]) => [k, decodeState(v, depth + 1)]));
    if (Object.hasOwn(value, '$classSet')) return new Set(value.$classSet.map(v => decodeState(v, depth + 1)));
    return Object.fromEntries(Object.entries(value).filter(([k]) => !['__proto__','constructor','prototype'].includes(k)).map(([k,v]) => [k, decodeState(v, depth + 1)]));
  }
  return value;
}
