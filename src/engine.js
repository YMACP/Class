import { EventEmitter, setMaxListeners } from 'node:events';
import { createHash } from 'node:crypto';
import { CONTEXT_1M_UNSUPPORTED_MESSAGE } from './context-policy.js';
import { isPlanningTool } from './planning-tools.js';

const copy = value => structuredClone(value);
const cancelled = signal => signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'cancelled'));
function interruptible(promise, signal) {
  if (signal.aborted) return Promise.reject(cancelled(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(cancelled(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
// Full records belong in the journal. Model context and the live UI stay bounded.
function summary(value, depth = 0, budget = { remaining: 32000 }) {
  if (depth > 9 || budget.remaining <= 0) return '[see task evidence archive]';
  if (typeof value === 'string') {
    const limit = Math.min(8000, budget.remaining); budget.remaining -= Math.min(value.length, limit);
    return value.length > limit ? value.slice(0, limit) + '… [truncated; see task evidence archive]' : value;
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value.slice(-60)) { if (budget.remaining <= 0) break; result.push(summary(item, depth + 1, budget)); }
    return result;
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      if (budget.remaining <= 0) break;
      budget.remaining -= key.length + 8; Object.defineProperty(result, key, { value: summary(item, depth + 1, budget), enumerable: true });
    }
    return result;
  }
  budget.remaining -= 16; return value;
}
function appendBounded(array, value, limit) { array.push(value); if (array.length > limit) array.splice(0, array.length - limit); }
const normalized = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : value;
const digest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => normalized(item))).digest('hex');
// Preserve Unicode distinctions (x² vs x2), code indentation and string spaces.
// Only plain-text layout is collapsed; code-marked fields stay conservative.
function candidateText(value) {
  if (typeof value !== 'string') return value;
  const text = value.replace(/\r\n?/g, '\n');
  return /`|~{3}/.test(text) ? text : text.replace(/\s+/g, ' ').trim();
}
const candidateDigest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => candidateText(item))).digest('hex');

// Presentation records never become shared model evidence. Only explicit fields
// are rendered as text; tool arguments and arbitrary response fields stay in the
// structured, redacted evidence archive.
function outcomeText(entry) {
  const parts = [];
  const add = (label, value) => { if (typeof value === 'string' && value) parts.push(`${label}\n${value}`); };
  const list = (label, values) => { if (Array.isArray(values) && values.length) add(label, values.filter(value => typeof value === 'string').map(value => `• ${value}`).join('\n')); };
  add('成员', entry.memberName); add('成果正文', entry.content); add('证据说明', entry.evidence);
  add('老师给出的答案', entry.answer);
  if (entry.report !== entry.content) add('老师报告', entry.report);
  list('完成声明', entry.completionClaims); list('尚未解决的问题', entry.remainingIssues);
  list('已验证事实', entry.verifiedFacts); list('缺失项', entry.gaps); list('后续建议', entry.recommendations); list('证据引用', entry.evidenceRefs);
  for (const [index, group] of (entry.groups || []).entries()) {
    add(`老师合并结果 ${index + 1}`, group.content); add('证据说明', group.evidence); list('提出者', group.proposerIds);
  }
  if (entry.inputs) {
    add('老师接收的快照引用', entry.inputs.snapshotRef);
    for (const item of entry.inputs.discoveries || entry.inputs.candidates || []) {
      add(`收到的${item.type === 'discovery' ? '发现' : '候选答案'}（${item.studentId}，${item.submissionId || item.candidateId || ''}）`, item.content);
      add('原始提交引用', item.evidenceRecordRef);
    }
    for (const student of entry.inputs.students || []) {
      parts.push(`学生 ${student.studentId}：老师快照包含 ${student.tools} 条已结束工具记录、${student.inProgress} 项进行中的工具。`);
      for (const item of student.history || []) {
        add('完整公开进展引用', item.fullContentRef);
        add(`收到的阶段记录（${item.submissionId || item.type || ''}）`, item.content); add('原始提交引用', item.evidenceRecordRef);
      }
    }
  }
  return parts.join('\n\n');
}

/** Parallel same-task solving with recoverable review phases. */
export class ClassEngine extends EventEmitter {
  constructor({ students, teacher, voteTimeoutMs = 30000, taskTimeoutMs = 600000, discoveryWindowMs = 100, maxRounds = 100, tools, teacherTools, journal, eventLimit = 1000 } = {}) {
    super();
    if (!Array.isArray(students) || students.length < 2) throw new TypeError('At least two students are required');
    const ids = students.map(student => student.id);
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new TypeError('Student IDs must be unique nonempty strings');
    if (students.some(student => typeof student.solve !== 'function' || typeof student.vote !== 'function')) throw new TypeError('Each student needs solve and vote');
    if (typeof teacher?.merge !== 'function' || typeof teacher?.judge !== 'function') throw new TypeError('Teacher needs merge and judge');
    if (tools && teacherTools === tools) throw new TypeError('Teacher tools must be independent from student tools');
    for (const [name, value] of Object.entries({ voteTimeoutMs, taskTimeoutMs, discoveryWindowMs, maxRounds, eventLimit })) {
      if (value === null && ['taskTimeoutMs', 'maxRounds'].includes(name)) continue;
      if (!Number.isFinite(value) || value < 0 || (name !== 'discoveryWindowMs' && value === 0)) throw new TypeError(`Invalid ${name}`);
    }
    Object.assign(this, { students, teacher, voteTimeoutMs, taskTimeoutMs, discoveryWindowMs, maxRounds, tools, teacherTools, journal, eventLimit });
    this.running = false; this.memberFailures = new Map();
  }
  stop(reason = 'stopped') {
    if (this.running && !this.finished) { this.stopRequested = true; this.stopReason = reason; this.life.abort(new Error(reason)); this.notify(); }
  }
  fail(error) {
    if (!this.running || this.finished) return;
    this.fault ||= error; this.life.abort(error); this.notify();
  }
  getMemberFailures() { return [...this.memberFailures.values()].map(copy); }
  memberIdentity(member, role) {
    const redact=value=>this.journal?.redactText?this.journal.redactText(value):value;
    return { studentId: member.id || 'teacher', memberName: redact(member.name || member.id || 'teacher'), role };
  }
  async isolateMember(member, role, error) {
    if (this.life.signal.aborted || error?.fatalStorage || error?.code === 'STORAGE_ERROR' || !error?.memberRecoverable) throw error;
    const identity = this.memberIdentity(member, role);
    if (this.memberFailures.get(identity.studentId)?.status === 'isolated') return;
    const redact=value=>this.journal?.redactText?this.journal.redactText(value):value;
    const toolName = typeof error.toolName === 'string' ? redact(error.toolName).replace(/[\r\n\t]/g, ' ').slice(0, 200) : undefined;
    const reason=error.reasonCode==='MODEL_REQUEST_REJECTED'?'接口请求被拒绝，请检查配置后重试。'
      :error.reasonCode==='MODEL_CONTEXT_1M_UNSUPPORTED'?CONTEXT_1M_UNSUPPORTED_MESSAGE+' 修改成员配置前请先停止任务。'
      :error.reasonCode==='TOOL_RESULT_UNCERTAIN'?'工具执行结果不确定，已保留证据，等待确认后重试。'
      :error.reasonCode==='MODEL_TOKEN_BUDGET_EXHAUSTED'?'输出达到恢复令牌上限，已保留上下文，可重试。'
      :error.reasonCode==='MEMBER_NO_PROGRESS'?'同类问题反复出现且未取得新进展，已保留上下文并隔离该成员，其他成员继续。'
      :error.attempt===0?'该成员暂时无法继续，已保留上下文，请处理后重试。'
      :role==='teacher'?'老师自动恢复已耗尽，当前操作和成果已保留，请重试。':'该成员自动恢复已耗尽，已隔离，其他成员继续执行。';
    const failure = { ...identity, status: 'isolated', reason, code: error.code || 'MODEL_RECOVERY_EXHAUSTED', reasonCode: error.reasonCode, toolName, attempt:error.attempt, maxAttempts:error.maxAttempts, canRetry: true };
    await this.archive({ kind: 'member_recovery', action: 'isolated', ...failure, error: error.message, phase: this.phase, reviewRound: this.reviewRound, feedbackVersion: this.feedbackVersion });
    this.life.signal.throwIfAborted(); this.memberFailures.set(identity.studentId, failure); this.record('member.isolated', failure);
  }
  async retryMember(id) {
    if (!this.running || this.finished || this.life.signal.aborted) throw Object.assign(new Error('任务已停止，无法重试成员。'), { code: 'TASK_NOT_ACTIVE' });
    const failure = this.memberFailures.get(id);
    if (!failure || failure.status !== 'isolated' || this.memberRetries.has(id)) throw Object.assign(new Error('该成员当前不处于可重试的隔离状态。'), { code: 'MEMBER_NOT_ISOLATED' });
    this.memberRetries.add(id);
    try {
      const detail = { ...failure, status: 'retrying', reason: '正在使用保留的上下文重试该成员。', canRetry: false };
      await this.archive({ kind: 'member_recovery', action: 'retrying', ...detail, phase: this.phase });
      this.life.signal.throwIfAborted();
      this.recoveryVersions.set(id, (this.recoveryVersions.get(id) || 0) + 1);
      this.memberFailures.set(id, detail); this.record('member.retrying', detail); return copy(detail);
    } finally { this.memberRetries.delete(id); }
  }
  async recoveredMember(member) {
    const id=member.id||'teacher',failure=this.memberFailures.get(id);
    if (failure?.status !== 'retrying') return;
    const detail={...failure,status:'recovered',reason:'该成员已恢复，继续处理任务。',canRetry:false};
    await this.archive({kind:'member_recovery',action:'recovered',...detail,phase:this.phase});
    this.life.signal.throwIfAborted(); this.memberFailures.delete(id); this.record('member.recovered',detail);
  }
  async teacherOperation(operation) {
    const phase=this.phase;
    while (true) {
      this.life.signal.throwIfAborted();
      try {
        const result=await interruptible(Promise.resolve().then(operation),this.life.signal);
        await this.recoveredMember(this.teacher);return result;
      } catch(error) {
        await this.isolateMember(this.teacher,'teacher',error);
        this.phaseChanged('waiting_recovery');
        while(this.memberFailures.get(this.teacher.id||'teacher')?.status==='isolated')await this.wait();
        this.life.signal.throwIfAborted();this.phaseChanged(phase);
      }
    }
  }
  archive(record) {
    if (!this.journal) return Promise.resolve(null);
    const operation = this.journal.append(record);
    operation.catch(error => this.fail(error)); return operation;
  }
  record(type, data = {}) {
    const original = { ...copy(data), sequence: ++this.eventSequence, time: new Date().toISOString(), type };
    this.archive({ kind: 'event', studentId: data.studentId, event: original });
    const event = { ...summary(original), sequence: original.sequence, time: original.time, type };
    if (data.studentId) event.studentId = data.studentId;
    appendBounded(this.events, event, this.eventLimit);
    this.emit('event', copy(event)); this.notify(); return event;
  }
  upsertOutcome(value) {
    const index = this.outcomes.findIndex(entry => entry.id === value.id), previous = index < 0 ? {} : this.outcomes[index];
    if (index < 0 && !value.type) return null;
    const now = new Date().toISOString(), original = { ...previous, ...value, createdAt: previous.createdAt || value.createdAt || now, updatedAt: now };
    const entry = { ...summary(original, 0, { remaining: 12000 }) };
    // Give each meaningful section its own allowance: a verbose report must not
    // hide the teacher's recommendations or the submissions it actually reviewed.
    for (const key of ['content','report','answer','evidence']) if (original[key] !== undefined) entry[key] = summary(original[key], 0, { remaining: 1800 });
    for (const key of ['completionClaims','remainingIssues','verifiedFacts','gaps','recommendations','evidenceRefs']) {
      if (original[key] !== undefined) entry[key] = summary(original[key], 0, { remaining: 1200 });
    }
    for (const key of ['candidateIds','submissionIds']) if (Array.isArray(original[key])) entry[key] = original[key].slice(-200);
    if (original.inputs) entry.inputs = summary(original.inputs, 0, { remaining: 4000 });
    if (original.groups) entry.groups = summary(original.groups, 0, { remaining: 2000 });
    // A long body must never consume the identity, state or archive references.
    for (const key of ['id','type','studentId','memberName','role','operation','submissionType','submissionId','candidateId','status','validated','reason','round','reviewRound','reviewId','feedbackVersion','evidenceRef','snapshotRef','fullContentRef','createdAt','updatedAt']) {
      if (original[key] !== undefined) entry[key] = original[key];
    }
    if (typeof original.content === 'string' && entry.content !== original.content) entry.contentTruncated = true;
    if (index < 0) { this.outcomes.push(entry); if (this.outcomes.length > 200) { this.outcomes.shift(); this.outcomesOmitted++; } }
    else this.outcomes[index] = entry;
    this.archive({ kind: 'outcome', studentId: entry.studentId, entry });
    this.record('outcome.upsert', { entry }); return entry;
  }
  trackPresentation(operation) {
    this.presentationWrites.add(operation);
    operation.finally(() => this.presentationWrites.delete(operation)).catch(() => {});
    return operation;
  }
  publishOutcome(entry, options = {}) {
    return this.trackPresentation(this.writeOutcome(entry, options));
  }
  async writeOutcome(entry, { terminal = false } = {}) {
    const generation = this.generation;
    if (this.finished && !terminal) return null;
    if (this.journal?.writeTextArtifact) {
      try {
        const saved = await this.journal.writeTextArtifact({ text: outcomeText(entry), kind: 'outcome', memberId: entry.studentId, submissionId: entry.submissionId, reviewId: entry.reviewId });
        entry = { ...entry, fullContentRef: saved.reference };
      } catch (error) { this.fail(error); throw error; }
    }
    if (generation !== this.generation || (this.finished && !terminal)) return null;
    return this.upsertOutcome(entry);
  }
  publicProgress(studentId, detail, generation, signal) {
    signal.throwIfAborted();
    if (generation !== this.generation || this.finished) throw new Error('Task is no longer active');
    if (!detail || typeof detail.content !== 'string' || !detail.content.trim()) return Promise.resolve(null);
    const member = this.students.find(student => student.id === studentId) || this.teacher;
    const role = member === this.teacher ? 'teacher' : 'student';
    const identity = this.memberIdentity(member, role);
    const content = detail.content, operation = ['solve','vote','merge','judge'].includes(detail.operation) ? detail.operation : role === 'teacher' ? 'judge' : 'solve';
    const id = `progress-${++this.publicProgressSequence}`;
    const toolCallIds = Array.isArray(detail.toolCallIds) ? detail.toolCallIds.filter(value => typeof value === 'string').slice(0, 64) : [];
    return this.trackPresentation((async () => {
      const saved = await this.archive({ kind: 'public_progress', ...identity, operation, content, submissionId: id, toolCallIds, phase: this.phase, reviewRound: this.reviewRound });
      if (generation !== this.generation || this.finished) return null;
      const entry = await this.publishOutcome({
        id, type: 'student_submission', submissionType: 'progress', submissionId: id, ...identity, operation, status: 'reported',
        round: this.round, reviewRound: this.reviewRound, feedbackVersion: this.feedbackVersion, content, evidenceRef: saved?.reference,
      });
      // Public progress is an unverified member statement. The teacher can
      // inspect it alongside formal submissions; it is never a shared finding.
      if (entry && this.histories.has(studentId)) appendBounded(this.histories.get(studentId), {
        type: 'progress', content: summary(content), submissionId: id, evidenceRecordRef: saved?.reference, fullContentRef: entry.fullContentRef, verified: false,
      }, 30);
      return entry;
    })());
  }
  phaseChanged(phase) {
    this.phase = phase; this.phaseId++;
    this.record('phase.changed', { phase, phaseId: this.phaseId, reviewRound: this.reviewRound, feedbackVersion: this.feedbackVersion });
  }
  notify() { for (const wake of [...this.waiters]) wake(); }
  wait(signal = this.life.signal) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.waiters.delete(wake); signal.removeEventListener('abort', abort); };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(cancelled(signal)); };
      this.waiters.add(wake); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
  async delay(ms, signal = this.life.signal) {
    let timer;
    try { await interruptible(new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal); }
    finally { clearTimeout(timer); }
  }
  context(studentId, signal = this.life.signal, { gated = true } = {}) {
    const generation = this.generation;
    const ctx = {
      task: copy(this.task), studentId, signal, tools: this.tools,
      blackboard: copy(this.blackboard), blackboardOmitted: this.blackboardOmitted, history: copy(this.histories.get(studentId) || []),
      feedbackVersion: this.feedbackVersion, feedbackVersionUsed: this.feedbackVersion,
      feedbackHistory: this.feedbackHistory.slice(-5).map(entry => summary(entry, 0, { remaining: 6000 })), submissionFeedback: this.submissionFeedback.get(studentId) || '',
      readBlackboard: () => copy(this.blackboard), readFeedbackVersion: () => this.feedbackVersion,
      readRecoveryVersion: () => this.recoveryVersions.get(studentId) || 0,
      onPublicProgress: detail => this.publicProgress(studentId, detail, generation, signal),
      toolMetadata: { taskId: this.journal?.runId, phaseId: this.phaseId, phase: this.phase },
      onToolValidation: async detail => {
        signal.throwIfAborted();
        if(generation!==this.generation||this.finished)throw new Error('Task is no longer active');
        const {publicStudentId,publicMemberName,publicModel,publicToolName,...diagnostic}=detail;
        const saved=await this.archive({kind:'tool_validation',...copy(diagnostic),phase:this.phase,phaseId:this.phaseId});
        signal.throwIfAborted();
        if(generation!==this.generation||this.finished)throw new Error('Task is no longer active');
        const eventTypes={rejected:'tool.validation_error',recovered:'tool.validation_recovered',exhausted:'tool.validation_exhausted',normalized:'tool.validation_normalized',retrying:'tool.validation_retrying'};
        const reasons={rejected:'模型响应未通过校验，正在请求修正。',recovered:'模型响应问题已恢复，继续处理。',exhausted:'自动恢复已达到次数上限，该成员将隔离等待重试。',normalized:'工具调用已按规范兼容转换。',retrying:'正在使用保留的上下文自动重试。'};
        if(!Object.hasOwn(eventTypes,diagnostic.status))throw new Error('Invalid tool validation status');
        const redact=value=>this.journal?.redactText?this.journal.redactText(value):value;
        let reason=diagnostic.status==='exhausted'?reasons.exhausted:diagnostic.safeReason||reasons[diagnostic.status];
        if(diagnostic.status==='exhausted'&&diagnostic.attempt===0)reason=diagnostic.reasonCode==='MODEL_REQUEST_REJECTED'?'接口请求被拒绝，请检查配置后重试。':diagnostic.reasonCode==='TOOL_RESULT_UNCERTAIN'?'工具执行结果不确定，已保留证据，等待确认后重试。':diagnostic.reasonCode==='MODEL_TOKEN_BUDGET_EXHAUSTED'?'输出达到恢复令牌上限，已保留上下文，可重试。':'该成员暂时无法继续，已保留上下文，请处理后重试。';
        if(diagnostic.reasonCode==='MODEL_CONTEXT_1M_UNSUPPORTED')reason=CONTEXT_1M_UNSUPPORTED_MESSAGE;
        const eventType=diagnostic.reasonCode==='TOOL_EXECUTION_FAILED'?'tool.execution_feedback':eventTypes[diagnostic.status];
        this.record(eventType,{studentId:redact(publicStudentId),memberName:redact(publicMemberName),protocol:diagnostic.protocol,model:redact(publicModel),toolName:redact(publicToolName||''),attempt:diagnostic.attempt,maxAttempts:diagnostic.maxAttempts,reason:redact(reason),resolution:diagnostic.resolution,toolCallId:redact(diagnostic.toolCallId),phaseId:this.phaseId,reviewId:diagnostic.reviewId,totalFailures:diagnostic.totalFailures,noProgressFailures:diagnostic.noProgressFailures,operationFingerprint:diagnostic.operationFingerprint,recoveryStrategy:diagnostic.recoveryStrategy,...(diagnostic.fatal?{fatal:true}:{}),...(diagnostic.code?{code:diagnostic.code}:{}),...(diagnostic.reasonCode?{reasonCode:diagnostic.reasonCode}:{}),evidenceRef:saved?.reference});
      },
      markRequest: version => {
        if (generation !== this.generation || this.finished || signal.aborted) return;
        ctx.feedbackVersionUsed = version;
        if (studentId && version > (this.feedbackDelivered.get(studentId) ?? 0)) {
          this.feedbackDelivered.set(studentId, version); this.record('feedback.delivered', { studentId, feedbackVersion: version });
        }
      },
      checkpoint: async () => {
        while (gated && (this.paused || this.memberFailures.get(studentId)?.status === 'isolated') && !signal.aborted && generation === this.generation) await this.wait(signal);
        signal.throwIfAborted(); if (generation !== this.generation || this.finished) throw new Error('Task is no longer active');
      }
    };
    return ctx;
  }
  configureTools() {
    this.toolHooks = []; const generation = this.generation;
    for (const manager of [this.tools, this.teacherTools].filter(Boolean)) {
      const previous = { onActivity: manager.onActivity, evidenceReader: manager.evidenceReader, createOutputArtifact: manager.createOutputArtifact };
      this.toolHooks.push({ manager, previous });
      manager.onActivity = async activity => {
        if (generation !== this.generation || this.finished) return;
        try { const saved = await this.captureTool(activity); await previous.onActivity?.(activity); return saved; }
        catch (error) { this.fail(error); throw error; }
      };
      if (this.journal) {
        manager.evidenceReader = args => this.journal.read(args);
        manager.createOutputArtifact = meta => this.journal.createOutputArtifact(meta);
      }
    }
  }
  async captureTool(activity) {
    const generation = this.generation;
    const saved = await this.archive({ kind: 'tool', studentId: activity.studentId, activity });
    if (generation !== this.generation || this.finished) return saved;
    const member = this.evidence.get(activity.studentId);
    if (member) {
      const item = { ...summary(activity), callId: activity.callId, studentId: activity.studentId, type: activity.type, status: activity.status, evidenceRef: saved?.reference, outputRef: activity.outputRef ?? activity.result?.outputRef, outputDigest: activity.result?.outputDigest };
      if (['started','spawned'].includes(activity.type)) member.inProgress.set(activity.callId, item);
      else if (['completed','failed'].includes(activity.type)) {
        member.inProgress.delete(activity.callId); appendBounded(member.tools, item, 30); member.totalTools++;
      }
    }
    // Teacher verification can also supply explicitly cited evidence on retry.
    // Keep this index separate from each student's presentation/history state.
    if ((member || activity.studentId === (this.teacher.id || 'teacher')) && activity.type === 'completed' && !['sleep', 'read_evidence', 'session_search', 'session_get', 'memory_search', 'memory_get', 'memory_propose', 'memory_assess'].includes(activity.action?.name) && !isPlanningTool(activity.action?.name)) {
      const key = digest({ action: activity.action, output: activity.result?.output ?? activity.output, outputDigest: activity.result?.outputDigest, exitCode: activity.result?.exitCode });
      for (const reference of [activity.callId, saved?.reference, activity.result?.outputRef, activity.outputRef].filter(Boolean)) this.evidenceIdentities.set(reference, key);
      while (this.evidenceIdentities.size > 6000) this.evidenceIdentities.delete(this.evidenceIdentities.keys().next().value);
      if (!this.knownEvidence.has(key)) {
        this.knownEvidence.add(key); this.evidenceEpoch++;
        if (this.knownEvidence.size > 2000) this.knownEvidence.delete(this.knownEvidence.values().next().value);
      }
    }
    if (['shell','run_command'].includes(activity.action?.name) && ['spawned','completed','failed'].includes(activity.type)) {
      const agent = this.students.find(student => student.id === activity.studentId) || this.teacher;
      const identity = this.memberIdentity(agent, agent === this.teacher ? 'teacher' : 'student');
      this.record(`tool.${activity.type}`, {
        ...identity, toolName: activity.action.name, callId: activity.callId, toolCallId: activity.metadata?.toolCallId,
        phaseId: activity.metadata?.phaseId, reviewId: activity.metadata?.reviewId,
        exitCode: activity.result?.exitCode, success: activity.result?.success ?? (Number.isInteger(activity.result?.exitCode) ? activity.result.exitCode === 0 : undefined),
        signal: activity.result?.signal, executionStatus: activity.executionStatus ?? activity.result?.executionStatus,
        evidenceRef: saved?.reference, outputRef: activity.outputRef ?? activity.result?.outputRef,
      });
    }
    this.notify(); return saved;
  }
  launch(student) {
    if (this.paused || this.life.signal.aborted || this.inflight.has(student.id) || this.finished || this.memberFailures.get(student.id)?.status === 'isolated') return;
    const generation = this.generation, ctx = this.context(student.id), execution = { ctx };
    this.inflight.set(student.id, execution);
    execution.promise = Promise.resolve().then(() => student.solve(ctx)).then(async result => {
      if (generation !== this.generation || this.life.signal.aborted || this.finished) return;
      if (!result || !['discovery', 'answer', 'continue'].includes(result.type) || typeof result.content !== 'string' || !result.content.trim()) throw new Error(`Invalid solve result from ${student.id}`);
      execution.recording = true;
      const version = Number.isSafeInteger(result.feedbackVersion) ? result.feedbackVersion : ctx.feedbackVersionUsed;
      if (version > this.feedbackVersion || version < 0) throw new Error('Invalid student feedback version');
      const action = { ...copy(result), feedbackVersion: version, submissionId: `submission-${++this.submissionSequence}`,
        ...(result.type === 'answer' ? { candidateId: `candidate-${++this.candidateSequence}` } : {}) };
      const saved = await this.archive({ kind: 'student_result', studentId: student.id, submissionId: action.submissionId, candidateId: action.candidateId, result: action });
      if (generation !== this.generation || this.life.signal.aborted || this.finished) return;
      if (saved) action.evidenceRecordRef = saved.reference;
      await this.recoveredMember(student);
      appendBounded(this.histories.get(student.id), { ...summary(action), submissionId: action.submissionId, candidateId: action.candidateId, evidenceRecordRef: action.evidenceRecordRef }, 30);
      this.record('student.result', { studentId: student.id, submissionId: action.submissionId, candidateId: action.candidateId, result: action });
      if (result.type !== 'discovery') await this.publishOutcome({
        id: action.submissionId, type: 'student_submission', submissionType: result.type, studentId: student.id, memberName: student.name || student.id,
        submissionId: action.submissionId, candidateId: action.candidateId, status: result.type === 'answer' ? 'pending' : 'reported',
        round: this.round, reviewRound: this.reviewRound, feedbackVersion: version, evidenceRef: saved?.reference,
        content: action.content, evidence: action.evidence, completionClaims: action.completionClaims, remainingIssues: action.remainingIssues, evidenceRefs: action.evidenceRefs
      });
      if (generation !== this.generation || this.life.signal.aborted || this.finished) return;
      if (result.type === 'answer') this.receiveCandidate(student.id, action);
      else if (result.type === 'discovery') { this.pending.push({ ...summary(action), submissionId: action.submissionId, evidenceRecordRef: action.evidenceRecordRef, studentId: student.id }); this.paused = true; }
    }).catch(async error => {
      if (generation === this.generation && !this.life.signal.aborted && !this.finished) {
        try { await this.isolateMember(student, 'student', error); }
        catch(failure) { this.fail(failure); }
      }
    }).finally(() => {
      if (generation === this.generation && this.inflight.get(student.id) === execution) { this.inflight.delete(student.id); this.notify(); }
    });
  }
  candidateEvidence(candidate) {
    // Compare the full submission before presentation truncation. A corrected
    // answer can reuse its proof; the teacher decides whether it is now valid.
    // Only explicitly linked, recorded evidence participates: unrelated tool
    // activity and invented references cannot unlock an unchanged submission.
    const evidenceRefs = Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : [];
    const identities = evidenceRefs.map(ref => this.evidenceIdentities.get(typeof ref === 'string' ? ref : ref?.reference || ref?.id)).filter(Boolean);
    return candidateDigest({ content: candidate.content, evidence: candidate.evidence || '', evidenceRefs: [...new Set(identities)].sort(), completionClaims: candidate.completionClaims || [], remainingIssues: candidate.remainingIssues || [] });
  }
  deferCandidate(candidate, reason) {
    this.submissionFeedback.set(candidate.studentId, reason === 'stale_feedback'
      ? '该候选来自旧反馈版本。成果已保存；请先处理最新老师反馈，补充或修正后重新提交。'
      : '该候选的答案正文与提交依据均未变化，已经被否决，暂不重复送审。请根据老师反馈修改答案，或在 evidence 中补充相关依据、在 evidenceRefs 中明确引用已记录的新证据；仅调整普通文本的空白排版或执行无关工具不会解锁。可继续探索或分享发现。');
    this.record('candidate.deferred', { candidateId: candidate.candidateId, submissionId: candidate.submissionId, studentId: candidate.studentId, reason, feedbackVersion: candidate.feedbackVersion });
    if (candidate.submissionId) this.upsertOutcome({ id: candidate.submissionId, status: 'deferred', reason, reviewRound: this.reviewRound, feedbackVersion: candidate.feedbackVersion });
  }
  receiveCandidate(studentId, action) {
    const candidate = { ...summary(action), type: 'answer', content: summary(action.content), studentId, submissionId: action.submissionId, candidateId: action.candidateId || `candidate-${++this.candidateSequence}`, revision: action.revision ?? this.candidateSequence, feedbackVersion: action.feedbackVersion, evidenceRecordRef: action.evidenceRecordRef };
    candidate.evidenceKey = this.candidateEvidence(action);
    this.record('candidate.received', { candidateId: candidate.candidateId, submissionId: candidate.submissionId, studentId, feedbackVersion: candidate.feedbackVersion, candidate });
    if (candidate.feedbackVersion < this.feedbackVersion) { this.deferCandidate(candidate, 'stale_feedback'); return; }
    const prior = this.rejectedEvidence.get(candidate.evidenceKey);
    if (prior && prior.feedbackVersion <= this.feedbackVersion) { this.deferCandidate(candidate, 'no_new_evidence'); return; }
    this.submissionFeedback.delete(studentId); this.candidates.push(candidate); this.paused = true;
  }
  async pause() {
    this.paused = true; this.phaseChanged('pausing');
    await interruptible(Promise.resolve().then(() => this.tools?.pauseAll?.()), this.life.signal);
  }
  async collectSubmissions() {
    // Wait only for already returned actions to finish saving their presentation
    // records, never for solvers that may be parked at a paused tool checkpoint.
    const completed = [...this.inflight.values()].filter(execution => execution.recording).map(execution => execution.promise);
    if (completed.length) await interruptible(Promise.all(completed), this.life.signal);
  }
  async resume() {
    this.life.signal.throwIfAborted(); if (this.candidates.length || this.pending.length) return;
    this.phaseChanged('resuming');
    await interruptible(Promise.resolve().then(() => this.tools?.resumeAll?.()), this.life.signal);
    this.life.signal.throwIfAborted();
    // A response can arrive while an OS resume command is in progress.
    if (this.candidates.length || this.pending.length) { await this.pause(); return; }
    this.paused = false; this.phaseChanged('solving'); this.record('solving.resumed', { feedbackVersion: this.feedbackVersion }); this.notify();
  }
  async vote(proposal, student) {
    if (this.memberFailures.has(student.id)) return { studentId: student.id, excluded: true, reason: 'member_isolated' };
    const controller = new AbortController(), parent = this.life.signal;
    const abort = () => controller.abort(cancelled(parent));
    parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('vote_timeout')), this.voteTimeoutMs);
    try {
      const value = await interruptible(Promise.resolve().then(() => student.vote(copy(proposal), this.context(student.id, controller.signal, { gated: false }))), controller.signal);
      const approve = typeof value === 'boolean' ? value : value?.approve;
      if (typeof approve !== 'boolean') return { studentId: student.id, excluded: true, reason: 'invalid_vote' };
      if (this.memberFailures.has(student.id)) return { studentId: student.id, excluded: true, reason: 'member_isolated' };
      return { studentId: student.id, approve, reason: typeof value?.reason === 'string' ? value.reason : '' };
    } catch(error) {
      if(error?.fatalStorage||error?.code==='STORAGE_ERROR')throw error;
      if(controller.signal.aborted)return {studentId:student.id,excluded:true,reason:'timeout_or_cancelled'};
      await this.isolateMember(student,'student',error);
      return {studentId:student.id,excluded:true,reason:'member_isolated'};
    }
    finally { clearTimeout(timer); parent.removeEventListener('abort', abort); }
  }
  validateMerged(merged, discoveries) {
    if (!Array.isArray(merged) || !merged.length) throw new Error('Teacher merge must return nonempty groups');
    const originals = new Set(discoveries.map(item => item.studentId)), covered = new Set();
    for (const proposal of merged) {
      if (typeof proposal.content !== 'string' || !proposal.content.trim() || !Array.isArray(proposal.proposerIds) || !proposal.proposerIds.length || new Set(proposal.proposerIds).size !== proposal.proposerIds.length || proposal.proposerIds.some(id => !originals.has(id))) throw new Error('Invalid merged discovery provenance');
      if (proposal.proposerIds.some(id => covered.has(id))) throw new Error('Discovery assigned to multiple merged groups');
      proposal.proposerIds.forEach(id => covered.add(id));
    }
    if ([...originals].some(id => !covered.has(id))) throw new Error('Teacher omitted a discovery');
    return merged.map(proposal => ({ ...copy(proposal), sources: discoveries.filter(item => proposal.proposerIds.includes(item.studentId)).map(copy) }));
  }
  addBoard(entry) {
    this.blackboard.push(summary(entry));
    if (this.blackboard.length > 200) { this.blackboard.splice(0, this.blackboard.length - 200); this.blackboardOmitted++; }
  }
  async discuss() {
    if (this.maxRounds !== null && this.round >= this.maxRounds) throw new Error('discussion_round_limit');
    this.round++; this.record('discussion.pausing', { round: this.round });
    await this.pause(); await this.delay(this.discoveryWindowMs); await this.collectSubmissions();
    // Candidate priority applies before a new merge/vote starts.
    if (this.candidates.length) return;
    this.phaseChanged('discussing'); const discoveries = this.pending.splice(0);
    const ctx=this.context(this.teacher.id||'teacher',this.life.signal,{gated:false});
    const mergeId = `merge-${this.round}`, submissionIds = discoveries.map(item => item.submissionId).filter(Boolean);
    const mergeSnapshot = await this.archive({ kind: 'merge_snapshot', mergeId, round: this.round, submissionIds, discoveries });
    const mergeOutcome = {
      id: mergeId, type: 'teacher_merge', studentId: this.teacher.id || 'teacher', memberName: this.teacher.name || this.teacher.id || '老师',
      status: 'processing', round: this.round, reviewRound: this.reviewRound, submissionIds, evidenceRef: mergeSnapshot?.reference,
      content: '老师正在整理收到的发现，合并结果随后按原有规则讨论和投票。',
      inputs: { snapshotRef: mergeSnapshot?.reference, discoveries: discoveries.map(item => ({ type: item.type, studentId: item.studentId, submissionId: item.submissionId, content: item.content, evidenceRecordRef: item.evidenceRecordRef })) }
    };
    await this.publishOutcome(mergeOutcome);
    const merged = await this.teacherOperation(() => this.teacher.merge(copy(discoveries), ctx));
    const proposals = this.validateMerged(merged, discoveries);
    const mergedRecord = await this.archive({ kind: 'teacher_merge', mergeId, round: this.round, submissionIds, snapshotRef: mergeSnapshot?.reference, groups: merged });
    this.life.signal.throwIfAborted();
    await this.publishOutcome({ ...mergeOutcome, status: 'completed', evidenceRef: mergedRecord?.reference, content: merged.map(group => group.content).join('\n\n'), groups: merged });
    // Finish votes already in progress, retaining their results. Candidates
    // arriving meanwhile are queued and no discussion branch resumes tools.
    for (const proposal of proposals) {
      this.life.signal.throwIfAborted();
      const eligible = this.students.filter(student => !this.memberFailures.has(student.id));
      const id = `discovery-${++this.discoverySequence}`, automatic = eligible.length > 0 && proposal.proposerIds.filter(studentId => eligible.some(student => student.id === studentId)).length > eligible.length / 2;
      this.record('discovery.proposed', { id, ...proposal, automatic, mergeId, submissionIds: proposal.sources.map(item => item.submissionId).filter(Boolean) });
      const votes = automatic ? [] : await interruptible(Promise.all(this.students.filter(student => !proposal.proposerIds.includes(student.id)).map(student => this.vote(proposal, student))), this.life.signal);
      for(const vote of votes)if(this.memberFailures.has(vote.studentId)){vote.excluded=true;delete vote.approve;vote.reason='member_isolated';}
      const valid = votes.filter(vote => !vote.excluded), yes = valid.filter(vote => vote.approve).length;
      const accepted = automatic || (valid.length > 0 && yes > valid.length / 2);
      const entry = { ...proposal, id, type: 'discovery', status: accepted ? 'accepted' : 'rejected', accepted, automatic, votes, validVotes: valid.length, yesVotes: yes, round: this.round };
      if (accepted) {
        const key = digest({ discovery: proposal.content, evidence: proposal.evidence || '' });
        this.evidenceIdentities.set(id, key);
        if (!this.knownEvidence.has(key)) { this.knownEvidence.add(key); this.evidenceEpoch++; }
        if (this.knownEvidence.size > 2000) this.knownEvidence.delete(this.knownEvidence.values().next().value);
        while (this.evidenceIdentities.size > 6000) this.evidenceIdentities.delete(this.evidenceIdentities.keys().next().value);
      }
      this.addBoard(entry); this.record('discovery.decided', { ...entry, mergeId, submissionIds: proposal.sources.map(item => item.submissionId).filter(Boolean) });
    }
    if (!this.candidates.length && !this.pending.length) { await this.resume(); this.record('discussion.resumed'); }
  }
  async review() {
    await this.pause();
    // Do not await solver promises: a completed tool may be at the pause gate.
    await this.delay(0);
    await this.collectSubmissions();
    const batch = this.candidates.splice(0).filter(candidate => {
      if (candidate.feedbackVersion < this.feedbackVersion) { this.deferCandidate(candidate, 'stale_feedback'); return false; } return true;
    });
    if (!batch.length) { await this.resume(); return null; }
    this.reviewRound++; this.phaseChanged('reviewing'); await this.journal?.flush();
    const reviewId = `review-${this.reviewRound}`;
    const snapshot = {
      reviewId, reviewRound: this.reviewRound, feedbackVersion: this.feedbackVersion, capturedAt: new Date().toISOString(),
      task: copy(this.task), candidates: copy(batch), blackboard: this.blackboard.slice(-60).map(entry => summary(entry, 0, { remaining: 4000 })), blackboardOmitted: this.blackboardOmitted + Math.max(0, this.blackboard.length - 60),
      feedbackHistory: this.feedbackHistory.slice(-5).map(entry => summary(entry, 0, { remaining: 6000 })), evidenceEpoch: this.evidenceEpoch,
      students: this.students.map(student => {
        const evidence = this.evidence.get(student.id);
        const history = this.histories.get(student.id).slice(-10).map(action => ({ ...summary(action, 0, { remaining: 2000 }), submissionId: action.submissionId, candidateId: action.candidateId, evidenceRecordRef: action.evidenceRecordRef, fullContentRef: action.fullContentRef, ...(action.type === 'progress' ? { verified: false } : {}) }));
        const tools = evidence.tools.slice(-12).map(activity => ({ ...summary(activity, 0, { remaining: 2000 }), callId: activity.callId, evidenceRef: activity.evidenceRef, outputRef: activity.outputRef ?? activity.result?.outputRef, truncated: activity.result?.truncated }));
        return { studentId: student.id, history, tools, inProgress: [...evidence.inProgress.values()].map(item => summary(item, 0, { remaining: 2000 })), totalTools: evidence.totalTools, solverInFlight: this.inflight.has(student.id) };
      }),
      archive: this.journal ? { available: true, runId: this.journal.runId, note: 'These are bounded summaries. Read referenced evidence and output pages for earlier or truncated results. In-progress operations are not completed evidence.' } : { available: false }
    };
    const saved = await this.archive({ kind: 'review_snapshot', reviewId, snapshot }); if (saved) snapshot.evidenceRef = saved.reference;
    const candidateIds = batch.map(item => item.candidateId), submissionIds = batch.map(item => item.submissionId).filter(Boolean);
    const inputSubmissionIds = [...new Set([...submissionIds, ...snapshot.students.flatMap(student => student.history.map(item => item.submissionId).filter(Boolean))])];
    this.record('review.started', { reviewId, reviewRound: this.reviewRound, candidateIds, submissionIds, evidenceRef: saved?.reference });
    for (const candidate of batch) if (candidate.submissionId) this.upsertOutcome({ id: candidate.submissionId, status: 'reviewing', reviewId, reviewRound: this.reviewRound });
    const reviewOutcome = {
      id: reviewId, type: 'teacher_review', studentId: this.teacher.id || 'teacher', memberName: this.teacher.name || this.teacher.id || '老师',
      status: 'processing', round: this.round, reviewId, reviewRound: this.reviewRound, feedbackVersion: this.feedbackVersion, candidateIds, submissionIds: inputSubmissionIds,
      evidenceRef: saved?.reference, snapshotRef: saved?.reference, content: '老师正在综合本轮候选答案和收到的阶段成果进行验收。',
      inputs: {
        snapshotRef: saved?.reference,
        candidates: snapshot.candidates.map(item => ({ studentId: item.studentId, submissionId: item.submissionId, candidateId: item.candidateId, content: item.content, evidenceRecordRef: item.evidenceRecordRef })),
        students: snapshot.students.map(student => ({ studentId: student.studentId, submissionIds: student.history.map(item => item.submissionId).filter(Boolean),
          history: student.history.map(item => ({ submissionId: item.submissionId, type: item.type, content: item.content, evidenceRecordRef: item.evidenceRecordRef, fullContentRef: item.fullContentRef })),
          tools: student.tools.length, totalTools: student.totalTools, inProgress: student.inProgress.length, solverInFlight: student.solverInFlight }))
      }
    };
    await this.publishOutcome(reviewOutcome);
    const ctx = { ...this.context(this.teacher.id||'teacher', this.life.signal, { gated: false }), blackboard: snapshot.blackboard, reviewSnapshot: snapshot, histories: Object.fromEntries(snapshot.students.map(student => [student.studentId, student.history])), feedbackHistory: snapshot.feedbackHistory };
    const judged = await this.teacherOperation(() => this.teacher.judge({ ...copy(batch[0]), candidates: copy(batch) }, ctx));
    this.life.signal.throwIfAborted(); if (typeof judged?.valid !== 'boolean') throw new Error('Invalid teacher judgement');
    const judgementRecord = await this.archive({ kind: 'review', reviewId, candidateIds, submissionIds, judgement: judged });
    this.life.signal.throwIfAborted();
    const reviewed = await this.publishOutcome({ ...reviewOutcome, status: judged.valid ? 'accepted' : 'rejected', evidenceRef: judgementRecord?.reference,
      content: judged.report || (judged.valid ? '老师验收通过。' : '老师验收未通过。'), report: judged.report, answer: judged.answer,
      verifiedFacts: judged.verifiedFacts, gaps: judged.gaps, recommendations: judged.recommendations, evidenceRefs: judged.evidenceRefs });
    this.life.signal.throwIfAborted();
    for (const candidate of batch) if (candidate.submissionId) this.upsertOutcome({ id: candidate.submissionId, status: judged.valid ? 'accepted' : 'rejected', reviewId, reviewRound: this.reviewRound });
    if (judged.valid) {
      this.acceptedReview = { reviewId, reviewRound: this.reviewRound, candidateIds, submissionIds, evidenceRef: judgementRecord?.reference, reviewFullContentRef: reviewed.fullContentRef };
      this.record('review.passed', { ...this.acceptedReview }); await this.journal?.flush(); this.life.signal.throwIfAborted();
      return { status: 'completed', reason: 'answer_valid', answer: judged.answer ?? batch[0].content, report: judged.report ?? null };
    }
    this.phaseChanged('publishing_feedback'); this.feedbackVersion++;
    const entry = {
      id: `feedback-${this.feedbackVersion}`, type: 'teacher_feedback', reviewId, reviewRound: this.reviewRound, feedbackVersion: this.feedbackVersion,
      report: judged.report || '候选答案尚未满足原任务要求，请继续补充证据。',
      verifiedFacts: Array.isArray(judged.verifiedFacts) ? judged.verifiedFacts : [], gaps: Array.isArray(judged.gaps) ? judged.gaps : [],
      recommendations: Array.isArray(judged.recommendations) ? judged.recommendations : [], evidenceRefs: Array.isArray(judged.evidenceRefs) ? judged.evidenceRefs : [],
      candidateIds, sources: [...new Set(batch.map(item => item.studentId))]
    };
    for (const candidate of batch) this.rejectedEvidence.set(candidate.evidenceKey, { feedbackVersion: this.feedbackVersion });
    while (this.rejectedEvidence.size > 500) this.rejectedEvidence.delete(this.rejectedEvidence.keys().next().value);
    this.addBoard(entry); appendBounded(this.feedbackHistory, summary(entry), 20);
    this.record('review.rejected', { reviewId, reviewRound: this.reviewRound, candidateIds, submissionIds, evidenceRef: judgementRecord?.reference, fullContentRef: reviewed.fullContentRef, reason: entry.report });
    this.record('feedback.published', { entry, feedbackVersion: this.feedbackVersion, reviewRound: this.reviewRound }); await this.journal?.flush();
    for (const candidate of this.candidates.splice(0)) this.deferCandidate(candidate, 'stale_feedback');
    await this.resume(); return null;
  }
  async stopTools() {
    if (!this.stoppingTools) this.stoppingTools = Promise.all([this.tools, this.teacherTools].filter(Boolean).map(manager => manager.stopAll?.()));
    return this.stoppingTools;
  }
  async run(task) {
    if (this.running) throw new Error('Engine already running');
    this.running = true; this.task = copy(task); this.life = new AbortController(); this.generation = Symbol('run'); setMaxListeners(0, this.life.signal);
    Object.assign(this, {
      events: [], eventSequence: 0, blackboard: [], blackboardOmitted: 0, outcomes: [], outcomesOmitted: 0, pending: [], candidates: [],
      histories: new Map(this.students.map(student => [student.id, []])), inflight: new Map(), waiters: new Set(),
      memberFailures: new Map(), memberRetries: new Set(), recoveryVersions: new Map(), presentationWrites: new Set(), publicProgressSequence: 0,
      evidence: new Map(this.students.map(student => [student.id, { tools: [], inProgress: new Map(), totalTools: 0 }])),
      feedbackHistory: [], feedbackVersion: 0, feedbackDelivered: new Map(), submissionFeedback: new Map(),
      rejectedEvidence: new Map(), knownEvidence: new Set(), evidenceIdentities: new Map(), evidenceEpoch: 0,
      fault: null, paused: false, round: 0, reviewRound: 0, phaseId: 0, candidateSequence: 0, discoverySequence: 0, submissionSequence: 0, acceptedReview: null,
      stoppingTools: null, finished: false, stopRequested: false, stopReason: null
    });
    this.configureTools();
    const deadline = this.taskTimeoutMs === null ? undefined : setTimeout(() => this.fail(new Error('task_timeout')), this.taskTimeoutMs);
    let outcome = null;
    try {
      this.record('task.started', { studentIds: this.students.map(student => student.id) }); this.phaseChanged('solving');
      while (!outcome) {
        this.life.signal.throwIfAborted(); if (this.fault) throw this.fault;
        if (this.candidates.length) { outcome = await this.review(); continue; }
        if (this.pending.length) { await this.discuss(); continue; }
        if (this.paused) await this.resume();
        if (this.students.every(student => this.memberFailures.get(student.id)?.status === 'isolated')) {
          if (this.phase !== 'waiting_recovery') this.phaseChanged('waiting_recovery');
          await this.wait();continue;
        }
        if (this.phase === 'waiting_recovery') this.phaseChanged('solving');
        if (!this.paused) this.students.forEach(student => this.launch(student));
        await this.wait(); await this.delay(5); await this.journal?.flush();
      }
      await this.journal?.flush(); this.life.signal.throwIfAborted();
    } catch (error) {
      const failure=this.fault||error;
      outcome = { status: this.stopRequested && !this.fault ? 'stopped' : 'failed', reason: String(failure?.message || error), answer: null, report: null,...(['TOOL_ARGUMENT_REPAIR_EXHAUSTED','TOOL_CALL_PROTOCOL_INVALID'].includes(failure?.code)?{errorCode:failure.code,studentId:failure.studentId,toolName:failure.toolName}:{}) };
    } finally {
      clearTimeout(deadline); this.life.abort(new Error('task_finished')); this.paused = false; this.notify();
      try { await this.stopTools(); }
      catch (error) { outcome = { ...outcome, status: 'failed', reason: `${outcome?.reason || 'task_finished'}; ${error.message}` }; }
      // A returned solve may still be syncing its full text. Drain only those
      // recordings before the terminal event so stop/clear cannot race a writer.
      try {
        await Promise.allSettled([...this.inflight.values()].filter(execution => execution.recording).map(execution => execution.promise));
        while (this.presentationWrites.size) await Promise.allSettled([...this.presentationWrites]);
        await this.journal?.flush();
        if (this.fault && outcome?.status !== 'failed') outcome = { ...outcome, status: 'failed', reason: this.fault.message || String(this.fault) };
      }
      catch (error) { outcome = { ...outcome, status: 'failed', reason: `${outcome?.reason || 'task_finished'}; ${error.message}` }; }
    }
    // Emit a single terminal event after cleanup; late callbacks are inert.
    if (this.stopRequested && outcome.status === 'completed') outcome = { status: 'stopped', reason: this.stopReason, answer: null, report: null };
    this.finished = true;
    if (outcome.status === 'completed') {
      try {
        const final = await this.publishOutcome({ id: 'final-answer', type: 'final_answer', status: 'accepted', validated: true,
          studentId: this.teacher.id || 'teacher', memberName: this.teacher.name || this.teacher.id || '老师', ...this.acceptedReview,
          content: outcome.answer, report: outcome.report }, { terminal: true });
        outcome.fullContentRef = final.fullContentRef;
      } catch (error) { outcome = { ...outcome, status: 'failed', reason: `storage_error: ${error.message}` }; }
    }
    try { await this.archive({ kind: 'result', result: outcome, reviewRound: this.reviewRound, feedbackVersion: this.feedbackVersion }); }
    catch (error) { outcome = { ...outcome, status: 'failed', reason: `storage_error: ${error.message}` }; }
    this.record('task.finished', { status: outcome.status, reason: outcome.reason,...(outcome.errorCode?{errorCode:outcome.errorCode}:{}) });
    try { await this.journal?.flush(); }
    catch (error) { outcome = { ...outcome, status: 'failed', reason: `storage_error: ${error.message}` }; }
    this.running = false; for (const { manager, previous } of this.toolHooks) Object.assign(manager, previous);
    return { ...outcome, phase: outcome.status, memberFailures: this.getMemberFailures(), reviewRound: this.reviewRound, feedbackVersion: this.feedbackVersion, feedbackDelivered: Object.fromEntries(this.feedbackDelivered), blackboard: copy(this.blackboard), blackboardOmitted: this.blackboardOmitted, outcomes: copy(this.outcomes), outcomesOmitted: this.outcomesOmitted, events: copy(this.events), eventsDropped: Math.max(0, this.eventSequence - this.events.length) };
  }
}

export { ClassEngine as DiscussionEngine };
