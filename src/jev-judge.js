import { createHash } from 'node:crypto';
import { normalizeJudgeConfig } from './judge-config.js';

const POINTS = new Set(['taskDispatch', 'toolCalls', 'toolResults', 'submissionReview']);
const MAX_STATE_CHARS = 48_000;
const MAX_REQUEST_BYTES = 96 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CACHE = 256;
const MAX_QUEUE = 32;
const REDACTED = '[REDACTED]';
const PRIVATE_FIELD = /(?:api[_-]?key|authorization|credential|password|passwd|secret|(?:access|refresh|id)[_-]?token|private[_-]?key)|^token$/i;
const LABEL = /^[a-zA-Z][a-zA-Z0-9_.-]{0,47}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const usageCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : 0;
const zeroUsage = () => ({ inputTokens: 0, outputTokens: 0 });
const fail = status => Object.assign(Error('Jev request did not produce a usable decision'), { judgeStatus: status });

function redact(text, known) {
  let clean = text;
  for (const secret of known) if (secret) clean = clean.split(secret).join(REDACTED);
  return clean
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,})/g, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ' + REDACTED)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1' + REDACTED + '@')
    .replace(/((?:["']?)[\w.-]*(?:api[_-]?key|password|passwd|secret|token|authorization)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi, '$1' + REDACTED);
}

// Build bounded, plain JSON before either hashing it or sending it elsewhere.
function safeJSON(value, known) {
  let nodes = 0;
  const visit = (item, depth = 0) => {
    if (++nodes > 4096 || depth > 12) throw fail('invalid');
    if (typeof item === 'string') {
      if (item.length > MAX_STATE_CHARS) throw fail('invalid');
      return redact(item, known);
    }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    // Match JSON's optional-field semantics without invoking user toJSON code.
    // Arrays retain positional meaning; omitted object properties do not become
    // artificial null observations for the classifier.
    if (Array.isArray(item)) return Array.from(item, child => visit(child === undefined ? null : child, depth + 1));
    if (!object(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw fail('invalid');
    const entries = Object.entries(item).filter(([, child]) => child !== undefined).map(([key, child]) => {
      if (key.length > 128) throw fail('invalid');
      return [redact(key, known), PRIVATE_FIELD.test(key) ? REDACTED : visit(child, depth + 1)];
    });
    return Object.fromEntries(entries);
  };
  const clean = visit(value);
  if (JSON.stringify(clean).length > MAX_STATE_CHARS) throw fail('invalid');
  return clean;
}

function questionsFor(raw, known) {
  if (!object(raw)) throw fail('invalid');
  const entries = Object.entries(raw);
  if (entries.length < 1 || entries.length > 32) throw fail('invalid');
  return Object.fromEntries(entries.map(([id, question]) => {
    if (!LABEL.test(id) || redact(id, known) !== id || !object(question) || typeof question.instructions !== 'string'
      || question.instructions.length > 2000 || !question.instructions.trim()) throw fail('invalid');
    const instructions = redact(question.instructions, known);
    if (question.type === 'boolean') {
      if (question.criteria !== undefined && (!object(question.criteria)
        || Object.keys(question.criteria).some(key => !['true', 'false'].includes(key)))) throw fail('invalid');
      const criteria = question.criteria && Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => {
        if (typeof value !== 'string' || value.length > 1500) throw fail('invalid');
        return [key, redact(value, known)];
      }));
      return [id, { type: 'boolean', instructions, ...(criteria ? { criteria } : {}) }];
    }
    if (question.type !== 'choice' || !object(question.criteria)) throw fail('invalid');
    const choices = Object.entries(question.criteria);
    if (choices.length < 2 || choices.length > 24) throw fail('invalid');
    const criteria = Object.fromEntries(choices.map(([key, value]) => {
      if (!LABEL.test(key) || redact(key, known) !== key || typeof value !== 'string' || value.length > 1500) throw fail('invalid');
      return [key, redact(value, known)];
    }));
    return [id, { type: 'choice', instructions, criteria }];
  }));
}

// A duplicate answer key is ambiguous, even if JSON.parse would accept it.
function parseJSON(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw fail('invalid'); }
  let at = 0;
  const whitespace = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const quoted = () => {
    const start = at++;
    while (at < text.length) { if (text[at++] === '\\') at++; else if (text[at - 1] === '"') break; }
    return JSON.parse(text.slice(start, at));
  };
  const visit = (depth = 0) => {
    if (depth > 20) throw fail('invalid');
    whitespace();
    if (text[at] === '{') {
      at++; whitespace(); const keys = new Set();
      while (text[at] !== '}') {
        const key = quoted();
        if (keys.has(key)) throw fail('invalid');
        keys.add(key); whitespace(); at++; visit(depth + 1); whitespace();
        if (text[at] !== ',') break;
        at++; whitespace();
      }
      at++;
    } else if (text[at] === '[') {
      at++; whitespace();
      while (text[at] !== ']') { visit(depth + 1); whitespace(); if (text[at] !== ',') break; at++; whitespace(); }
      at++;
    } else if (text[at] === '"') quoted();
    else while (at < text.length && !/[\s,\]}]/.test(text[at])) at++;
  };
  visit();
  return parsed;
}

function answersFor(raw, questions) {
  if (!object(raw) || Object.keys(raw).length !== Object.keys(questions).length
    || Object.keys(raw).some(id => !Object.hasOwn(questions, id))) throw fail('invalid');
  let unclear = false;
  const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const answer = raw[id];
    if (!object(answer)) throw fail('invalid');
    if (question.type === 'boolean') {
      const p = answer.noul;
      if (!probability(p) || (answer.type !== undefined && !['boolean', 'noul'].includes(answer.type))) throw fail('invalid');
      if (p > 0.2 && p < 0.8) unclear = true;
      return [id, { type: 'boolean', probability: p }];
    }
    if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)
      || (answer.type !== undefined && answer.type !== 'choice')) throw fail('invalid');
    let probabilities;
    if (answer.probabilities !== undefined) {
      if (!object(answer.probabilities) || Object.keys(answer.probabilities).some(key => !Object.hasOwn(question.criteria, key))) throw fail('invalid');
      probabilities = Object.fromEntries(Object.entries(answer.probabilities).map(([key, p]) => {
        if (!probability(p)) throw fail('invalid');
        return [key, p];
      }));
      if (!probability(probabilities[answer.choice]) || Object.values(probabilities).reduce((sum, p) => sum + p, 0) > 1.001) throw fail('invalid');
    } else if (probability(answer.confidence)) probabilities = { [answer.choice]: answer.confidence };
    // A picked label without evidence of confidence is observable, never actionable.
    if (!probabilities || probabilities[answer.choice] < 0.8 || ['other', 'none', 'unknown', 'unclear'].includes(answer.choice)) unclear = true;
    return [id, { type: 'choice', choice: answer.choice, ...(probabilities ? { probabilities } : {}) }];
  }));
  return { status: unclear ? 'unclear' : 'ok', answers };
}

function endpoint(config) {
  const base = config.baseUrl;
  const path = new URL(base).pathname;
  return path === '/' ? `${base}/v1/systemone` : path === '/v1' ? `${base}/systemone` : base;
}

async function readBody(response, signal) {
  if (!response.body) throw fail('invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw fail('invalid');
      chunks.push(value);
    }
    return parseJSON(Buffer.concat(chunks).toString('utf8'));
  } finally {
    // Cancellation also stops oversized or incomplete response streams.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One instance belongs to one run. It never modifies approvals, rounds or task completion. */
export class JevJudge {
  #config;
  #fetch;
  #observer;
  #known;
  #cache = new Map();
  #queue = [];
  #active = 0;
  #stats = { calls: 0, requests: 0, cacheHits: 0, ok: 0, unclear: 0, disabled: 0, timeouts: 0, aborted: 0, failures: 0, rateLimited: 0, inputTokens: 0, outputTokens: 0, totalLatencyMs: 0, savedChars: 0 };

  constructor(config = {}, { fetchImpl = globalThis.fetch, onDecision, knownSecrets = [] } = {}) {
    this.#config = normalizeJudgeConfig(config);
    this.#fetch = fetchImpl;
    this.#observer = onDecision;
    const supplied = typeof knownSecrets === 'function' ? knownSecrets : () => knownSecrets;
    this.#known = () => [...new Set([this.#config.apiKey, ...supplied()]
      .filter(value => typeof value === 'string' && value.length > 0))].sort((a, b) => b.length - a.length);
  }

  getStats() { return { ...this.#stats, inFlight: this.#active, queued: this.#queue.length, cacheEntries: this.#cache.size }; }
  recordSavedChars(value) {
    if (this.#config.enabled && Number.isSafeInteger(value) && value > 0) this.#stats.savedChars += value;
  }

  #acquire(signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#active < this.#config.maxConcurrency) { this.#active++; return Promise.resolve(); }
    if (this.#queue.length >= MAX_QUEUE) return Promise.reject(fail('rate_limited'));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abort: undefined };
      entry.abort = () => { this.#queue = this.#queue.filter(item => item !== entry); reject(signal.reason); };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.#queue.push(entry);
    });
  }

  #release() {
    this.#active--;
    while (this.#queue.length) {
      const next = this.#queue.shift();
      next.signal.removeEventListener('abort', next.abort);
      if (next.signal.aborted) { next.reject(next.signal.reason); continue; }
      this.#active++;
      next.resolve();
      break;
    }
  }

  async #request(state, questions, signal) {
    signal.throwIfAborted();
    const config = this.#config;
    const payload = {
      model: config.model, state,
      questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { ...question, type: question.type === 'boolean' ? 'noul' : 'choice' }])),
    };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw fail('invalid');
    this.#stats.requests++;
    const response = await this.#fetch(endpoint(config), {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw fail(response.status === 429 ? 'rate_limited' : [401, 402, 403].includes(response.status) ? 'auth' : 'error');
    }
    const result = await readBody(response, signal);
    if (!object(result)) throw fail('invalid');
    const usage = { inputTokens: usageCount(result.usage?.input_tokens), outputTokens: usageCount(result.usage?.output_tokens) };
    this.#stats.inputTokens += usage.inputTokens;
    this.#stats.outputTokens += usage.outputTokens;
    return { ...answersFor(result.answers, questions), usage };
  }

  async decide(point, request, { signal } = {}) {
    const started = performance.now();
    this.#stats.calls++;
    const safePoint = POINTS.has(point) ? point : 'unknown';
    let result = { status: 'invalid', answers: null, usage: zeroUsage(), cached: false };
    const controller = new AbortController();
    const abort = () => controller.abort(fail('aborted'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(fail('timeout')), this.#config.timeoutMs);
    let budgetAbort;
    const budget = new Promise((_, reject) => {
      budgetAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', budgetAbort, { once: true });
    });
    // A pre-aborted or disabled request may never race this promise.
    budget.catch(() => {});
    try {
      if (!this.#config.enabled || (safePoint !== 'unknown' && !this.#config.features[safePoint])) result.status = 'disabled';
      else {
        controller.signal.throwIfAborted();
        if (safePoint === 'unknown' || !object(request)) throw fail('invalid');
        const known = this.#known();
        const state = safeJSON(request.state, known);
        const questions = questionsFor(request.questions, known);
        const key = createHash('sha256').update(JSON.stringify({ point, state, questions })).digest('hex');
        const cached = this.#cache.get(key);
        if (cached) {
          this.#cache.delete(key); this.#cache.set(key, cached);
          this.#stats.cacheHits++;
          result = { ...structuredClone(cached), usage: zeroUsage(), cached: true };
        } else {
          await this.#acquire(controller.signal);
          // A transport keeps its slot until it actually settles, including after an abort.
          // Native fetch receives the signal and tears down its request, rather than only timing out the caller.
          const work = this.#request(state, questions, controller.signal).finally(() => this.#release());
          const response = await Promise.race([work, budget]);
          controller.signal.throwIfAborted();
          const remembered = { status: response.status, answers: structuredClone(response.answers) };
          this.#cache.set(key, remembered);
          if (this.#cache.size > MAX_CACHE) this.#cache.delete(this.#cache.keys().next().value);
          result = { ...response, cached: false };
        }
      }
    } catch (error) {
      const status = controller.signal.aborted ? controller.signal.reason?.judgeStatus : error?.judgeStatus;
      result = { status: ['timeout', 'aborted', 'rate_limited', 'auth', 'invalid'].includes(status) ? status : 'error', answers: null, usage: zeroUsage(), cached: false };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', budgetAbort);
    }
    const latencyMs = Math.round(performance.now() - started);
    const output = { ...result, applied: result.status === 'ok', latencyMs };
    this.#stats.totalLatencyMs += latencyMs;
    if (['ok', 'unclear', 'disabled', 'aborted'].includes(result.status)) this.#stats[result.status]++;
    else if (result.status === 'timeout') this.#stats.timeouts++;
    else { this.#stats.failures++; if (result.status === 'rate_limited') this.#stats.rateLimited++; }
    // Only bounded metadata is observable. Provider bodies, prompts, labels, endpoint and keys never enter logs.
    const metadata = { point: safePoint, status: output.status, applied: output.applied, cached: output.cached, latencyMs, usage: { ...output.usage } };
    try { Promise.resolve(this.#observer?.(metadata)).catch(() => {}); } catch {}
    return output;
  }
}
