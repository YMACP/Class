import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';
import { storageError, storageDetails, createStorageGuard } from './storage-health.js';
export { storageError } from './storage-health.js';

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_PAGE_SIZE = 200;
const SENSITIVE_KEY = /^(?:api_?key|authorization|token|secret|password|access_?token)$/i;
const MAX_OUTPUT_PAGE_BYTES = 65536;

function knownValues(secrets) {
  if (!secrets) return [];
  const values = typeof secrets === 'string' ? [secrets] : typeof secrets[Symbol.iterator] === 'function' ? [...secrets] : Object.values(secrets);
  return values.filter(value => typeof value === 'string' && value).sort((a, b) => b.length - a.length);
}

function redact(text, secrets) {
  let value = text;
  for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
  return value.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/([#?&](?:token|api_?key|secret)=)[^\s&]+/gi, '$1[REDACTED]');
}

// Keep only a short undecided suffix between chunks. Token values can be
// arbitrarily long; once recognized, discard their continuation until a
// delimiter instead of retaining the whole line in memory.
class OutputRedactor {
  constructor(secrets) {
    const escaped = secrets.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.pattern = new RegExp([...escaped, 'Bearer\\s+', '[#?&](?:token|api_?key|secret)='].join('|'), 'gi');
    this.carry = Math.max(64, ...secrets.map(value => value.length + 1));
    this.pending = ''; this.token = null;
  }
  push(text, final = false) {
    this.pending += text;
    let output = '';
    while (this.pending.length) {
      if (this.token) {
        if (this.token === 'bearer_start') {
          this.pending = this.pending.replace(/^\s+/, '');
          if (!this.pending.length) break;
          this.token = 'bearer';
        }
        const boundary = this.pending.search(this.token === 'bearer' ? /[\s"',;]/ : /[\s&]/);
        if (boundary < 0) { this.pending = ''; break; }
        this.pending = this.pending.slice(boundary); this.token = null;
      }
      let safeEnd = final ? this.pending.length : Math.max(0, this.pending.length - this.carry);
      if (safeEnd > 0 && safeEnd < this.pending.length && /[\uD800-\uDBFF]/.test(this.pending[safeEnd - 1]) && /[\uDC00-\uDFFF]/.test(this.pending[safeEnd])) safeEnd--;
      if (!safeEnd) break;
      this.pattern.lastIndex = 0;
      const match = this.pattern.exec(this.pending);
      if (!match || match.index >= safeEnd) {
        output += this.pending.slice(0, safeEnd); this.pending = this.pending.slice(safeEnd); break;
      }
      output += this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (/^Bearer\s+$/i.test(match[0])) { output += 'Bearer [REDACTED]'; this.token = 'bearer_start'; }
      else if (/^[#?&](?:token|api_?key|secret)=$/i.test(match[0])) { output += match[0] + '[REDACTED]'; this.token = 'query'; }
      else output += '[REDACTED]';
    }
    return output;
  }
}

// Keep a record bounded before JSON serialization, including records supplied by
// integrations rather than ToolManager. Ordinary bounded tool output is retained.
function cleanRecord(record, secrets, budget) {
  const seen = new WeakSet();
  let remaining = budget, truncated = false;
  function visit(value, key = '', depth = 0) {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (remaining <= 0 || depth > 32) { truncated = true; return '[truncated]'; }
    if (typeof value === 'string') {
      // Responses and Chat carry arguments as JSON text. Treat their fields
      // like object arguments so a password unknown to the profile is still
      // removed. Broken JSON cannot be traversed safely; hide sensitive input
      // conservatively while the separate validation error retains context.
      if(['arguments','rawArguments','canonicalArguments'].includes(key)){
        try{return JSON.stringify(visit(JSON.parse(value),'',depth+1));}
        catch{
          if(/api_?key|authorization|access_?token|password|secret|\btoken\b/i.test(value))return '[REDACTED malformed tool arguments containing sensitive fields]';
        }
      }
      const text = redact(value, secrets), bytes = Buffer.from(text);
      if (bytes.length > remaining) {
        const prefix = bytes.subarray(0, Math.max(0, remaining - 32)).toString('utf8');
        remaining = 0; truncated = true; return prefix + '… [truncated]';
      }
      remaining -= bytes.length + 8;
      return text;
    }
    if (typeof value === 'bigint') return String(value);
    if (value === null || typeof value !== 'object') { remaining -= 16; return value; }
    if (seen.has(value)) { truncated = true; return '[circular]'; }
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
      result = [];
      for (const item of value) {
        if (remaining <= 0) { truncated = true; break; }
        result.push(visit(item, '', depth + 1));
      }
    } else {
      result = {};
      for (const [name, item] of Object.entries(value)) {
        if (remaining <= 0) { truncated = true; break; }
        remaining -= Buffer.byteLength(name) + 8;
        Object.defineProperty(result, redact(name, secrets), { value: visit(item, name, depth + 1), enumerable: true, configurable: true });
      }
    }
    seen.delete(value);
    return result;
  }
  const value = visit(record);
  return { value, truncated };
}

async function* recordsFrom(filename, { onIncompleteTail } = {}) {
  const input = createReadStream(filename, { highWaterMark: 64 * 1024 });
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let boundary;
      while ((boundary = pending.indexOf(10)) >= 0) {
        if (boundary > MAX_RECORD_BYTES) throw new Error('A journal record exceeds the supported size');
        const line = pending.subarray(0, boundary).toString('utf8');
        pending = pending.subarray(boundary + 1);
        if (line.trim()) yield JSON.parse(line);
      }
      if (pending.length > MAX_RECORD_BYTES) throw new Error('A journal record exceeds the supported size');
    }
    if (pending.length) {
      if (onIncompleteTail) onIncompleteTail(pending.length);
      else throw new Error('The task journal contains an incomplete final record');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally { input.destroy(); }
}

/** Append-only task evidence. Memory limits never change persistent references. */
export class RunJournal {
  constructor({ directory, secrets, runId, storageGuard, onRecord } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Journal directory must be an absolute path');
    this.directory = directory;
    this.filename = path.join(directory, 'journal.jsonl');
    this.runId = runId || path.basename(directory);
    this.secrets = knownValues(secrets);
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.initialized = false;
    this.failure = null;
    this.outputWriters = new Set();
    this.storageGuard = storageGuard || createStorageGuard(directory);
    this.onRecord = onRecord;
  }

  redactText(value) { return typeof value==='string'?redact(value,this.secrets):value; }

  async initialize() {
    if (this.initialized) return;
    for await (const record of recordsFrom(this.filename)) {
      if (!Number.isSafeInteger(record.sequence) || record.sequence !== this.sequence + 1) throw new Error('The task journal has invalid record sequencing');
      this.sequence = record.sequence;
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.initialized = true;
  }

  append(record) {
    const operation = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Journal record must be an object');
      await this.initialize();
      const sequence = this.sequence + 1;
      const reference = `journal:${this.runId}:${sequence}`;
      // JSON escaping can multiply byte size. Reduce the content budget until
      // even pathological control-character output fits, without dropping IDs.
      let budget = MAX_RECORD_BYTES - 4096, line;
      do {
        const cleaned = cleanRecord(record, this.secrets, budget);
        const activity = record.activity;
        const identifiers = activity && typeof activity === 'object' ? {
          callId: activity.callId, studentId: record.studentId ?? activity.studentId,
          outputRef: activity.result?.outputRef ?? activity.outputRef,
          outputBytes: activity.result?.outputBytes ?? activity.outputBytes,
          outputDigest: activity.result?.outputDigest,
        } : {};
        for (const key of Object.keys(identifiers)) {
          const item = identifiers[key];
          if (item === undefined) delete identifiers[key];
          else if (typeof item === 'string') identifiers[key] = redact(item.slice(0, 500), this.secrets);
        }
        const value = { ...cleaned.value, ...identifiers, sequence, reference, runId: this.runId, recordedAt: new Date().toISOString() };
        if (cleaned.truncated) { value.truncated = true; value.truncation = { reason: 'record_size_limit', maxBytes: MAX_RECORD_BYTES }; }
        line = JSON.stringify(value) + '\n';
        budget = Math.floor(budget / 2);
      } while (Buffer.byteLength(line) > MAX_RECORD_BYTES && budget >= 128);
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new Error('Journal record metadata exceeds the size limit');
      await this.storageGuard.check(Buffer.byteLength(line), { operation: '追加任务证据记录', path: this.filename });
      const file = await fs.open(this.filename, 'a', 0o600);
      try { await file.writeFile(line, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      this.sequence = sequence;
      // Optional indexes observe already-durable, redacted records. Their
      // failures must never poison the evidence journal or task lifecycle.
      try { Promise.resolve(this.onRecord?.(JSON.parse(line))).catch(() => {}); } catch {}
      return { reference, sequence };
    });
    const guarded = operation.catch(error => { this.failure = storageError(error, { operation: '追加任务证据记录', path: this.filename }); throw this.failure; });
    this.queue = guarded.catch(() => {});
    return guarded;
  }

  async flush() {
    await this.queue;
    if (this.failure) throw this.failure;
  }

  // Formal answers and reviews can exceed the journal's per-record limit.
  // Keep their complete redacted text in the same durable, pageable store as
  // evidence, without creating a tool call or changing the model context.
  async writeTextArtifact({ text } = {}) {
    if (typeof text !== 'string') throw new TypeError('Outcome text must be a string');
    const writer = await this.createOutputArtifact({ callId: `text-${randomUUID()}` });
    try {
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + 16384, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
        await writer.write(text.slice(start, end));
        start = end;
      }
      return await writer.close();
    } catch (error) {
      await writer.close().catch(() => {});
      throw error;
    }
  }

  async createOutputArtifact({ callId } = {}) {
    if (typeof callId !== 'string' || !/^[\w-]{1,160}$/.test(callId)) throw new Error('Invalid output callId');
    await this.flush();
    const reference = `output:${this.runId}:${callId}`;
    let file;
    const filename = path.join(this.directory, 'outputs', callId + '.txt');
    try {
      await this.storageGuard.check(0, { operation: '创建工具输出档案', path: filename });
      await fs.mkdir(path.join(this.directory, 'outputs'), { recursive: true, mode: 0o700 });
      file = await fs.open(filename, 'wx', 0o600);
    } catch (error) { this.failure = storageError(error, { operation: '创建工具输出档案', path: filename }); throw this.failure; }
    const decoder = new StringDecoder('utf8'), redactor = new OutputRedactor(this.secrets), digest = createHash('sha256');
    let bytes = 0, queue = Promise.resolve(), closed = false, closing;
    const fail = error => { this.failure = storageError(error, { operation: '保存工具输出档案', path: filename }); throw this.failure; };
    const writeText = async text => {
      if (!text) return;
      await this.storageGuard.check(Buffer.byteLength(text), { operation: '保存工具输出档案', path: filename });
      await file.writeFile(text, 'utf8'); bytes += Buffer.byteLength(text); digest.update(text, 'utf8');
    };
    const writer = {
      write: chunk => {
        if (closed) return Promise.reject(storageError(new Error('Output artifact is closed')));
        const operation = queue.then(async () => {
          if (this.failure) throw this.failure;
          await writeText(redactor.push(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
        }).catch(fail);
        queue = operation.catch(() => {});
        return operation;
      },
      close: () => {
        if (closing) return closing;
        closed = true;
        closing = (async () => {
          try {
            await queue;
            if (this.failure) throw this.failure;
            await writeText(redactor.push(decoder.end(), true));
            await file.sync();
            return { reference, bytes, sha256: digest.digest('hex') };
          } catch (error) { return fail(error); }
          finally { this.outputWriters.delete(writer); await file.close().catch(fail); }
        })();
        return closing;
      },
      abort: () => writer.close(),
    };
    this.outputWriters.add(writer);
    return writer;
  }

  async readOutput({ reference, offset = 0, limit = 32768 } = {}) {
    const prefix = `output:${this.runId}:`;
    const callId = typeof reference === 'string' && reference.startsWith(prefix) ? reference.slice(prefix.length) : '';
    if (!/^[\w-]{1,160}$/.test(callId)) throw new Error('Invalid output reference');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Output offset must be a nonnegative integer');
    if (!Number.isSafeInteger(limit) || limit < 4 || limit > MAX_OUTPUT_PAGE_BYTES) throw new Error(`Output limit must be from 4 to ${MAX_OUTPUT_PAGE_BYTES}`);
    // A failed writer must not make already persisted evidence unreadable.
    // Writes remain strict; read responses explicitly carry the storage warning.
    await this.queue;
    const storageWarning = this.failure ? cleanRecord(storageDetails(this.failure), this.secrets, 8192).value : undefined;
    let file;
    const filename = path.join(this.directory, 'outputs', callId + '.txt');
    try {
      file = await fs.open(filename, 'r');
      const { size } = await file.stat();
      const buffer = Buffer.alloc(Math.min(limit + 3, Math.max(0, size - offset)));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      let end = Math.min(limit, bytesRead);
      // End at a complete UTF-8 character so callers can pass nextOffset
      // verbatim, while respecting the requested byte limit.
      if (end < bytesRead) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      const output = buffer.subarray(0, end).toString('utf8');
      const nextOffset = offset + end < size ? offset + end : null;
      return { reference, output, offset, nextOffset, totalBytes: size, truncated: nextOffset !== null, ...(storageWarning ? { storageWarning } : {}) };
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Output evidence does not exist');
      throw storageError(error, { operation: '读取工具输出档案', path: filename });
    } finally { if (file) await file.close().catch(error => { throw storageError(error, { operation: '关闭工具输出档案', path: filename }); }); }
  }

  async read({ kind, studentId, callId, offset = 0, limit = 50, reference, byteOffset, maxBytes } = {}) {
    if (typeof reference === 'string' && reference.startsWith('output:')) return this.readOutput({ reference, offset: byteOffset ?? 0, limit: maxBytes ?? 32768 });
    const chunked = byteOffset !== undefined || maxBytes !== undefined;
    if (chunked && (typeof reference !== 'string' || !reference.startsWith(`journal:${this.runId}:`))) throw new Error('Chunked record reads require a journal reference');
    if (chunked && (!Number.isSafeInteger(byteOffset ?? 0) || (byteOffset ?? 0) < 0)) throw new Error('Evidence byteOffset must be a nonnegative integer');
    if (chunked && (!Number.isSafeInteger(maxBytes ?? 32768) || (maxBytes ?? 32768) < 4 || (maxBytes ?? 32768) > MAX_OUTPUT_PAGE_BYTES)) throw new Error('Evidence maxBytes must be from 4 to 65536');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Evidence offset must be a nonnegative integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new Error(`Evidence limit must be from 1 to ${MAX_PAGE_SIZE}`);
    for (const [name, value] of Object.entries({ kind, studentId, callId, reference })) if (value !== undefined && (typeof value !== 'string' || value.length > 300)) throw new Error(`Invalid evidence ${name}`);
    await this.queue;
    const storageWarning = this.failure ? cleanRecord(storageDetails(this.failure), this.secrets, 8192).value : undefined;
    const records = [];
    let total = 0, incompleteTailBytes = 0;
    try { for await (const record of recordsFrom(this.filename, { onIncompleteTail: bytes => { incompleteTailBytes = bytes; } })) {
      if (kind !== undefined && record.kind !== kind) continue;
      if (studentId !== undefined && (record.studentId ?? record.event?.studentId ?? record.activity?.studentId) !== studentId) continue;
      const recordCallId = record.callId ?? record.activity?.callId ?? record.result?.callId;
      if (callId !== undefined && recordCallId !== callId) continue;
      if (reference !== undefined && record.reference !== reference && recordCallId !== reference) continue;
      if (total >= offset && records.length < limit) records.push(record);
      total++;
    } } catch (error) { throw storageError(error, { operation: '读取任务证据记录', path: this.filename }); }
    const notices = {
      ...(storageWarning ? { storageWarning } : {}),
      ...(incompleteTailBytes ? { incompleteTailBytes, warning: '档案末尾存在未完整写入的记录，当前显示已完整保存的部分，原文件已保留。' } : {}),
    };
    if (chunked) {
      if (!records.length) throw new Error('Evidence record does not exist');
      const buffer = Buffer.from(JSON.stringify(records[0])), start = byteOffset ?? 0;
      let end = Math.min(buffer.length, start + (maxBytes ?? 32768));
      if (end < buffer.length) while (end > start && (buffer[end] & 0xc0) === 0x80) end--;
      const nextOffset = end < buffer.length ? end : null;
      return { reference, output: buffer.subarray(start, end).toString('utf8'), offset: start, nextOffset, totalBytes: buffer.length, truncated: nextOffset !== null, format: 'journal_record', ...notices };
    }
    return { records, nextOffset: offset + records.length < total ? offset + records.length : null, total, ...notices };
  }
}
