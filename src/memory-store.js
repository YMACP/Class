import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 3;
const CHUNK_SIZE = 8000;
const KINDS = new Set(['user', 'agent']);
const CATEGORIES = new Set(['fact', 'inference', 'preference', 'experience']);
const STATES = new Set(['active', 'paused', 'invalid']);
const VERDICTS = new Set(['usable', 'uncertain', 'expired', 'invalid']);

function required(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}`);
  return value;
}
function iso(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid memory timestamp');
  return date.toISOString();
}
function page(args = {}) {
  const limit = args.limit === undefined ? 20 : Number(args.limit);
  const offset = args.offset === undefined ? 0 : Number(args.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0 || offset > 10000000) throw new Error('Invalid memory pagination');
  return { limit, offset };
}
function paged(items, total, paging) {
  const hasMore = paging.offset + items.length < total;
  return { items, total, ...paging, hasMore, nextOffset: hasMore ? paging.offset + items.length : null };
}
function parse(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function memoryKind(kind) { return ['project', 'role', 'skill'].includes(kind) ? 'agent' : kind; }
function contentHash(content) { return createHash('sha256').update(content.replace(/\s+/gu, ' ').trim()).digest('hex'); }
function splitText(text) {
  if (!text) return [''];
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks;
}
function replaceProjectIds(value, oldId, newId) {
  if (Array.isArray(value)) return value.map(item => replaceProjectIds(item, oldId, newId));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'projectId' && item === oldId ? newId : replaceProjectIds(item, oldId, newId)]));
  return value;
}
function searchTerms(value) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase();
  const terms = [...text.matchAll(/[a-z0-9_]+/g)].map(match => match[0]);
  for (const match of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)) {
    const chars = Array.from(match[0]);
    if (chars.length === 1) terms.push(chars[0]);
    else for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i] + chars[i + 1]);
  }
  return [...new Set(terms)];
}
function matchQuery(value) {
  if (String(value ?? '').length > 2000) throw new Error('Memory query is too long');
  return searchTerms(value).slice(0, 32).map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}
function indexed(text) {
  const characters = [...new Set(text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? [])];
  return `${text}\n${searchTerms(text).join(' ')}\n${characters.join(' ')}`;
}
function excerpt(text, query) {
  const terms = searchTerms(query), lower = text.toLowerCase();
  const positions = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 100);
  return `${start ? '…' : ''}${text.slice(start, start + 1000)}${text.length > start + 1000 ? '…' : ''}`;
}
function collectSecrets(value, output = []) {
  if (typeof value === 'string' && value) output.push(value);
  else if (Array.isArray(value) || value instanceof Set) for (const item of value) collectSecrets(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectSecrets(item, output);
  return output;
}

/** One database per Class profile. Only trusted application code supplies contexts. */
export async function createMemoryStore({ directory, secrets = [] } = {}) {
  required(directory, 'memory directory', 32768);
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'memory.sqlite');
  let database;
  if (process.versions.bun) {
    const { Database } = await import('bun:sqlite');
    database = new Database(filename, { create: true });
  } else {
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(filename);
  }
  let closed = false, secretSource = secrets;
  function statement(sql, values, method) {
    const prepared = database.prepare(sql);
    try { return prepared[method](...values); }
    finally { prepared.finalize?.(); }
  }
  const all = (sql, values = []) => statement(sql, values, 'all');
  const get = (sql, values = []) => statement(sql, values, 'get');
  const run = (sql, values = []) => statement(sql, values, 'run');
  function transaction(action) {
    database.exec('BEGIN IMMEDIATE');
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
  }
  function redactString(value) {
    let text = String(value);
    const known = collectSecrets(typeof secretSource === 'function' ? secretSource() : secretSource).sort((a, b) => b.length - a.length);
    for (const secret of known) text = text.split(secret).join('[REDACTED]');
    return text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+={0,2}/gi, 'Bearer [REDACTED]')
      .replace(/((?:api[_-]?key|access[_-]?token|password|authorization)\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]');
  }
  function clean(value, depth = 0) {
    if (depth > 24) return '[TRUNCATED]';
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(?:api[_-]?key|access[_-]?token|password|secret|authorization)$/i.test(key) && item ? '[REDACTED]' : clean(item, depth + 1)]));
    return value ?? null;
  }
  function contextOf(context) {
    if (!context || typeof context !== 'object') throw new Error('Memory scope is required');
    if (context.admin === true) return { ...context, admin: true };
    return { projectId: context.projectId ? required(context.projectId, 'project metadata', 32768) : 'legacy:unknown', agentId: required(context.agentId, 'agent scope'), role: String(context.role || 'student'), admin: false };
  }
  function access(record, context) {
    return !!record && (context.admin || context.role === 'teacher' || record.agent_id === context.agentId || record.role === 'user' || record.shared === 1);
  }
  function memoryAccess(memory, context) {
    return !!memory && (context.admin || context.role === 'teacher' || memory.agent_id === null || memory.agent_id === context.agentId);
  }
  function effectiveStatus(memory) { return memory.duplicate_of || !STATES.has(memory.status) || memory.expires_at && memory.expires_at <= new Date().toISOString() ? 'invalid' : memory.status; }
  function activeMemory(memory) { return !!memory && effectiveStatus(memory) === 'active'; }
  function memoryWritable(memory, context) { return memoryAccess(memory, context) && (context.admin || context.role === 'teacher' || memory.kind === 'agent' && memory.agent_id === context.agentId); }
  function recordScope(context, args = {}, alias = 'r') {
    const clauses = [], values = [];
    if (!context.admin && context.role !== 'teacher') { clauses.push(`(${alias}.agent_id = ? OR ${alias}.role = 'user' OR ${alias}.shared = 1)`); values.push(context.agentId); }
    if (args.projectId) { clauses.push(`${alias}.project_id = ?`); values.push(String(args.projectId)); }
    for (const [key, column] of [['sessionId', 'session_id'], ['agentId', 'agent_id'], ['role', 'role'], ['kind', 'kind']]) {
      if (args[key]) { clauses.push(`${alias}.${column} = ?`); values.push(String(args[key])); }
    }
    if (args.from) { clauses.push(`${alias}.timestamp >= ?`); values.push(iso(args.from)); }
    if (args.to) { clauses.push(`${alias}.timestamp <= ?`); values.push(iso(args.to)); }
    return { clauses, values };
  }
  function memoryScope(context, args = {}, search = false) {
    const clauses = [], values = [];
    if (!context.admin && context.role !== 'teacher') { clauses.push('(m.agent_id = ? OR m.agent_id IS NULL)'); values.push(context.agentId); }
    for (const [key, column] of [['agentId', 'agent_id'], ['kind', 'kind'], ['category', 'category']]) {
      if (args[key]) { clauses.push(`m.${column} = ?`); values.push(String(args[key])); }
    }
    const now = new Date().toISOString();
    if (!context.admin) {
      clauses.push("m.status = 'active'", 'm.duplicate_of IS NULL', '(m.expires_at IS NULL OR m.expires_at > ?)'); values.push(now);
      if (args.status && args.status !== 'active') clauses.push('0=1');
    } else {
      if (args.status === 'invalid') { clauses.push("(m.status NOT IN ('active','paused') OR m.duplicate_of IS NOT NULL OR (m.expires_at IS NOT NULL AND m.expires_at <= ?))"); values.push(now); }
      else if (args.status) {
        clauses.push('m.status = ?', 'm.duplicate_of IS NULL', '(m.expires_at IS NULL OR m.expires_at > ?)'); values.push(String(args.status), now);
      } else if (search && !args.includeInactive) { clauses.push("m.status = 'active'", 'm.duplicate_of IS NULL', '(m.expires_at IS NULL OR m.expires_at > ?)'); values.push(now); }
    }
    if (args.from) { clauses.push('m.created_at >= ?'); values.push(iso(args.from)); }
    if (args.to) { clauses.push('m.created_at <= ?'); values.push(iso(args.to)); }
    return { clauses, values };
  }
  function sessionObject(row) {
    if (!row) return null;
    return { id: row.id, projectId: row.project_id, task: redactString(row.task), status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, team: clean(parse(row.team_json, [])), metadata: clean(parse(row.metadata_json, {})) };
  }
  function recordObject(row, query) {
    if (!row) return null;
    const text = redactString(row.text);
    return { id: row.id, reference: row.reference, sessionId: row.session_id, projectId: row.project_id, sequence: row.sequence, agentId: row.agent_id, role: row.role, kind: row.kind, timestamp: row.timestamp, text, payload: clean(parse(row.payload_json, {})), shared: row.shared === 1, chunkIndex: row.chunk_index, chunkCount: row.chunk_count, ...(query ? { snippet: excerpt(text, query) } : {}) };
  }
  function memoryObject(row) {
    if (!row) return null;
    return { id: row.id, kind: row.kind, category: row.category, agentId: row.agent_id, projectId: row.project_id, content: redactString(row.content), status: effectiveStatus(row), sourceRefs: parse(row.source_refs_json, []), createdAt: row.created_at, updatedAt: row.updated_at, lastVerifiedAt: row.last_verified_at, expiresAt: row.expires_at,
      reviewReason: row.review_reason ? redactString(row.review_reason) : null, reviewedAt: row.reviewed_at ?? null, reviewVerdict: row.review_verdict ?? null, reviewSourceRefs: parse(row.review_source_refs_json, []), ...(row.duplicate_of ? { duplicateOf: row.duplicate_of } : {}) };
  }
  function mutationResult(row, context, extra = {}) {
    if (context.admin || activeMemory(row)) return { ...memoryObject(row), ...extra };
    return { id: row.id, status: memoryObject(row).status, unavailable: true, ...extra };
  }
  function checkedRefs(value) {
    if (!Array.isArray(value) || value.length > 100 || value.some(ref => typeof ref !== 'string' || !ref || ref.length > 1200)) throw new Error('Invalid memory source references');
    return [...new Set(value)];
  }
  function tombstoned(type, id) { return !!get('SELECT 1 FROM tombstones WHERE type = ? AND id = ?', [type, id]); }
  function markDeleted(type, id, projectId) { run('INSERT OR IGNORE INTO tombstones(type,id,project_id,deleted_at) VALUES(?,?,?,?)', [type, id, projectId, new Date().toISOString()]); }
  function lookupRecord(reference) { return get('SELECT * FROM records WHERE reference = ? OR id = ? OR base_reference = ? ORDER BY chunk_index LIMIT 1', [reference, reference, reference]); }
  function validateSources(refs, target, context, visited = new Set()) {
    for (const reference of refs) {
      const record = lookupRecord(reference);
      if (record) {
        if (!access(record, context)) throw new Error('Memory source is outside the allowed scope');
        const targetCanRead = record.role === 'user' || record.shared === 1 || target.agentId !== null && record.agent_id === target.agentId;
        if (!targetCanRead) throw new Error('Memory sharing would expose a private source');
        continue;
      }
      let id = reference.startsWith('memory:') ? reference.slice(7) : reference;
      let source = get('SELECT * FROM memories WHERE id = ?', [id]);
      const aliases = new Set();
      while (source?.duplicate_of) {
        if (!memoryAccess(source, context)) throw new Error('Memory source does not exist or is not accessible');
        if (aliases.has(id) || visited.has(id) || id === target.id) throw new Error('Memory source chain contains a cycle');
        aliases.add(id); id = source.duplicate_of;
        source = get('SELECT * FROM memories WHERE id = ?', [id]);
      }
      if (!source || !memoryAccess(source, context)) throw new Error('Memory source does not exist or is not accessible');
      if (visited.has(id) || id === target.id) throw new Error('Memory source chain contains a cycle');
      if (!activeMemory(source)) throw new Error('Memory source is no longer active');
      if (source.agent_id !== null && source.agent_id !== target.agentId) throw new Error('Memory sharing would expose a private source');
      const next = new Set(visited); next.add(id);
      if (next.size > 32) throw new Error('Memory source chain is too deep');
      validateSources(parse(source.source_refs_json, []), target, context, next);
    }
  }
  function removeMemories(ids) {
    let changed = true;
    const deleted = new Set(ids);
    while (changed) {
      changed = false;
      for (const memory of all('SELECT * FROM memories')) {
        if (!deleted.has(memory.id) && (deleted.has(memory.duplicate_of) || [...parse(memory.source_refs_json, []), ...parse(memory.review_source_refs_json, [])].some(ref => deleted.has(ref) || ref.startsWith('memory:') && deleted.has(ref.slice(7))))) { deleted.add(memory.id); changed = true; }
      }
    }
    for (const id of deleted) {
      const memory = get('SELECT * FROM memories WHERE id = ?', [id]);
      if (!memory) continue;
      markDeleted('memory', id, memory.project_id);
      run('INSERT OR IGNORE INTO memory_content_tombstones(project_id,kind,agent_id,content_hash,deleted_at) VALUES(?,?,?,?,?)', [memory.project_id, memory.kind, memory.agent_id ?? '', memory.content_hash || contentHash(memory.content), new Date().toISOString()]);
      run('DELETE FROM memories_fts WHERE id = ?', [id]); run('DELETE FROM memories WHERE id = ?', [id]);
    }
    return deleted.size;
  }
  try {
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,team_json TEXT NOT NULL,metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,base_reference TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,project_id TEXT NOT NULL,sequence INTEGER NOT NULL,agent_id TEXT NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,timestamp TEXT NOT NULL,text TEXT NOT NULL,payload_json TEXT NOT NULL,shared INTEGER NOT NULL DEFAULT 0,chunk_index INTEGER NOT NULL,chunk_count INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS records_scope ON records(project_id,agent_id,session_id,sequence);
      CREATE INDEX IF NOT EXISTS records_base ON records(session_id,base_reference);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,agent_id TEXT,kind TEXT NOT NULL,category TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,source_refs_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_verified_at TEXT,expires_at TEXT);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(project_id,agent_id,status);
      CREATE TABLE IF NOT EXISTS tombstones(type TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(type,id));
      CREATE TABLE IF NOT EXISTS memory_content_tombstones(project_id TEXT NOT NULL,kind TEXT NOT NULL,agent_id TEXT NOT NULL,content_hash TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(kind,agent_id,content_hash));
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(id UNINDEXED,search_text,tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED,search_text,tokenize='unicode61 remove_diacritics 2');`);
    const version = get("SELECT value FROM memory_meta WHERE key='schema_version'");
    if (version && ![1, 2, SCHEMA_VERSION].includes(Number(version.value))) throw new Error('Unsupported memory database version');
    transaction(() => {
      const columns = new Set(all('PRAGMA table_info(memories)').map(column => column.name));
      for (const [name, definition] of [['content_hash', "TEXT NOT NULL DEFAULT ''"], ['review_reason', 'TEXT'], ['reviewed_at', 'TEXT'], ['review_verdict', 'TEXT'], ['review_source_refs_json', "TEXT NOT NULL DEFAULT '[]'"], ['duplicate_of', 'TEXT']]) {
        if (!columns.has(name)) database.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
      }
      run("UPDATE memories SET status='active' WHERE status IN ('candidate','confirmed')");
      run("UPDATE memories SET kind='agent' WHERE kind IN ('project','role','skill')");
      run("UPDATE memories SET status='invalid' WHERE status IN ('expired','superseded')");
      for (const row of all("SELECT id,content FROM memories WHERE content_hash=''")) run('UPDATE memories SET content_hash=? WHERE id=?', [contentHash(row.content), row.id]);
      if (all('PRAGMA table_info(memory_content_tombstones)').some(column => column.name === 'project_id' && column.pk)) {
        database.exec(`CREATE TABLE memory_content_tombstones_v3(project_id TEXT NOT NULL,kind TEXT NOT NULL,agent_id TEXT NOT NULL,content_hash TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(kind,agent_id,content_hash));
          INSERT OR IGNORE INTO memory_content_tombstones_v3 SELECT project_id,CASE WHEN kind IN ('project','role','skill') THEN 'agent' ELSE kind END,agent_id,content_hash,deleted_at FROM memory_content_tombstones ORDER BY deleted_at;
          DROP TABLE memory_content_tombstones;
          ALTER TABLE memory_content_tombstones_v3 RENAME TO memory_content_tombstones;`);
      }
      if (version && Number(version.value) < SCHEMA_VERSION) {
        const groups = new Map();
        for (const row of all("SELECT * FROM memories ORDER BY CASE WHEN duplicate_of IS NULL THEN 0 ELSE 1 END,CASE WHEN status='paused' THEN 0 WHEN status='invalid' OR expires_at <= ? THEN 1 ELSE 2 END,created_at,id", [new Date().toISOString()])) {
          const key = JSON.stringify([row.kind, row.agent_id, row.content_hash]);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(row);
        }
        for (const rows of groups.values()) {
          if (rows.length < 2) continue;
          const [canonical, ...duplicates] = rows;
          const ids = new Set(rows.map(row => row.id));
          const refs = [...new Set(rows.flatMap(row => parse(row.source_refs_json, [])))].filter(ref => !ids.has(ref.startsWith('memory:') ? ref.slice(7) : ref));
          run('UPDATE memories SET source_refs_json=? WHERE id=?', [JSON.stringify(refs), canonical.id]);
          // Preserve historical ids and original evidence for audit; only the
          // canonical copy remains eligible for automatic retrieval.
          for (const duplicate of duplicates) run("UPDATE memories SET status='invalid',duplicate_of=? WHERE id=?", [canonical.id, duplicate.id]);
        }
        // Merging former role/skill identities can close a previously valid
        // chain: A -> B -> C becomes A -> B -> alias(A). Keep usable evidence
        // on the canonical row without rewriting duplicate rows' audit refs.
        const graph = new Map(all('SELECT id,duplicate_of,source_refs_json FROM memories ORDER BY created_at,id').map(row => [row.id, { ...row, refs: parse(row.source_refs_json, []) }]));
        const reaches = (reference, targetId) => {
          const pending = [reference], visited = new Set();
          while (pending.length) {
            const ref = pending.pop();
            if (lookupRecord(ref)) continue;
            const id = ref.startsWith('memory:') ? ref.slice(7) : ref;
            if (id === targetId) return true;
            if (visited.has(id)) continue;
            visited.add(id);
            const node = graph.get(id);
            if (node?.duplicate_of) pending.push(`memory:${node.duplicate_of}`);
            else if (node) pending.push(...node.refs);
          }
          return false;
        };
        for (const node of graph.values()) {
          if (node.duplicate_of) continue;
          let changed = false;
          for (const ref of [...node.refs]) if (reaches(ref, node.id)) { node.refs = node.refs.filter(item => item !== ref); changed = true; }
          if (changed) run('UPDATE memories SET source_refs_json=? WHERE id=?', [JSON.stringify(node.refs), node.id]);
        }
        // A deletion made in any former workspace remains authoritative after
        // those workspaces share one profile-wide memory pool.
        const deletedCopies = all("SELECT m.id FROM memories m JOIN memory_content_tombstones t ON t.kind=m.kind AND t.agent_id=COALESCE(m.agent_id,'') AND t.content_hash=m.content_hash").map(row => row.id);
        removeMemories(deletedCopies);
      }
      database.exec("CREATE UNIQUE INDEX IF NOT EXISTS memories_global_identity ON memories(kind,COALESCE(agent_id,''),content_hash) WHERE duplicate_of IS NULL");
      run("INSERT INTO memory_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(SCHEMA_VERSION)]);
    });
  } catch (error) { database.close(); throw error; }

  const store = {
    setSecrets(value) { secretSource = value; },
    registerSession(meta) {
      const id = required(meta.id ?? meta.sessionId ?? meta.runId, 'session id');
      const projectId = required(meta.projectId, 'project id', 32768);
      if (tombstoned('session', id)) return { id, deleted: true, skipped: true };
      const prior = get('SELECT * FROM sessions WHERE id = ?', [id]);
      if (prior && prior.project_id !== projectId) throw new Error('A memory session cannot move to another project');
      run(`INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET task=excluded.task,status=excluded.status,finished_at=excluded.finished_at,team_json=excluded.team_json,metadata_json=excluded.metadata_json`,
        [id, projectId, redactString(meta.task ?? prior?.task ?? ''), String(meta.status ?? prior?.status ?? 'running'), iso(meta.startedAt ?? meta.createdAt, prior?.started_at ?? new Date().toISOString()), iso(meta.finishedAt, prior?.finished_at ?? null), JSON.stringify(clean(meta.team ?? parse(prior?.team_json, []))), JSON.stringify(clean({ ...parse(prior?.metadata_json, {}), ...(meta.metadata ?? {}), ...(meta.missingProject === undefined ? {} : { missingProject: !!meta.missingProject }) }))]);
      return sessionObject(get('SELECT * FROM sessions WHERE id = ?', [id]));
    },
    upsertRecords(sessionId, records) {
      required(sessionId, 'session id');
      if (!Array.isArray(records) || records.length > 10000) throw new Error('Invalid memory records');
      if (tombstoned('session', sessionId)) return { inserted: 0, updated: 0, skipped: records.length, records: [] };
      const session = get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
      if (!session) throw new Error('Memory session does not exist');
      return transaction(() => {
        const result = { inserted: 0, updated: 0, skipped: 0, records: [] };
        for (const [index, value] of records.entries()) {
          const text = redactString(String(value.text ?? value.content ?? ''));
          const payload = JSON.stringify(clean(value.payload ?? {}));
          const timestamp = iso(value.timestamp, session.started_at);
          const agentId = String(value.agentId ?? ''), role = String(value.role ?? 'student'), kind = String(value.kind ?? 'message');
          const hash = createHash('sha256').update(JSON.stringify([sessionId, agentId, role, kind, timestamp, text, payload])).digest('hex').slice(0, 32);
          const baseId = required(value.id ?? `record-${hash}`, 'record id');
          const baseReference = required(value.reference ?? `${sessionId}:${baseId}`, 'record reference', 1100);
          const sequence = Number(value.sequence ?? index);
          if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid memory record sequence');
          if (tombstoned('record', baseId) || tombstoned('record', baseReference)) { result.skipped++; continue; }
          const chunks = splitText(text);
          const existing = all('SELECT id,reference FROM records WHERE session_id = ? AND base_reference = ?', [sessionId, baseReference]);
          for (const old of existing) { run('DELETE FROM records_fts WHERE id = ?', [old.id]); run('DELETE FROM records WHERE id = ?', [old.id]); }
          for (const [chunkIndex, chunk] of chunks.entries()) {
            const id = chunks.length > 1 ? `${baseId}#${chunkIndex + 1}` : baseId;
            const reference = chunks.length > 1 ? `${baseReference}#${chunkIndex + 1}` : baseReference;
            const collision = get('SELECT session_id FROM records WHERE id = ? OR reference = ?', [id, reference]);
            if (collision) throw new Error('Memory record identity already belongs to another record');
            run('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, reference, baseReference, sessionId, session.project_id, sequence, agentId, role, kind, timestamp, chunk, chunkIndex === 0 ? payload : '{}', value.shared === true ? 1 : 0, chunkIndex, chunks.length]);
            run('INSERT INTO records_fts(id,search_text) VALUES(?,?)', [id, indexed(`${chunk}\n${chunkIndex === 0 ? payload : ''}`)]);
            result.records.push({ id, reference });
          }
          if (existing.length) result.updated++; else result.inserted++;
        }
        return result;
      });
    },
    sessionSearch(args = {}, context) {
      const ctx = contextOf(context), paging = page(args), scope = recordScope(ctx, args), query = matchQuery(args.query);
      if (redactString(String(args.query ?? '')) !== String(args.query ?? '')) return paged([], 0, paging);
      let join = query ? 'JOIN records_fts ON records_fts.id=r.id' : '';
      const literal = String(args.query ?? '').trim();
      const substring = () => { scope.clauses.push('(instr(lower(r.text),lower(?)) > 0 OR instr(lower(r.payload_json),lower(?)) > 0)'); scope.values.push(literal, literal); };
      if (query) { scope.clauses.push('records_fts MATCH ?'); scope.values.push(query); }
      else if (literal) substring();
      let where = scope.clauses.length ? `WHERE ${scope.clauses.join(' AND ')}` : '';
      let total = Number(get(`SELECT count(*) AS n FROM records r ${join} ${where}`, scope.values).n);
      // FTS token boundaries miss an identifier embedded in a long unbroken
      // output token. A literal, parameterized fallback keeps the original
      // scope predicates and runs only when no FTS result exists.
      if (query && total === 0) {
        join = ''; scope.clauses.pop(); scope.values.pop(); substring();
        where = `WHERE ${scope.clauses.join(' AND ')}`;
        total = Number(get(`SELECT count(*) AS n FROM records r ${where}`, scope.values).n);
      }
      const rows = all(`SELECT r.* FROM records r ${join} ${where} ORDER BY ${join ? 'bm25(records_fts),' : ''}r.timestamp DESC,r.sequence,r.chunk_index LIMIT ? OFFSET ?`, [...scope.values, paging.limit, paging.offset]);
      return paged(rows.map(row => recordObject(row, args.query)), total, paging);
    },
    sessionGet(args = {}, context) {
      if (typeof args === 'string') args = { sessionId: args };
      const ctx = contextOf(context), paging = page(args);
      let sessionId = args.sessionId ?? args.id;
      const reference = args.reference ?? args.ref;
      if (!sessionId && reference) {
        const sourceScope = recordScope(ctx, args);
        sourceScope.clauses.push('(r.reference = ? OR r.id = ? OR r.base_reference = ? OR json_extract(r.payload_json,\'$.outputRef\') = ?)');
        sourceScope.values.push(String(reference), String(reference), String(reference), String(reference));
        sessionId = get(`SELECT r.session_id FROM records r WHERE ${sourceScope.clauses.join(' AND ')} ORDER BY r.timestamp,r.sequence,r.base_reference,r.chunk_index,r.id LIMIT 1`, sourceScope.values)?.session_id;
      }
      if (!sessionId) return null;
      const session = get('SELECT * FROM sessions WHERE id = ?', [String(sessionId)]);
      if (!session || args.projectId && session.project_id !== args.projectId) return null;
      const scope = recordScope(ctx, { ...args, sessionId });
      const where = scope.clauses.join(' AND ');
      const total = Number(get(`SELECT count(*) AS n FROM records r WHERE ${where}`, scope.values).n);
      if (!total && !ctx.admin && ctx.role !== 'teacher') return null;
      let anchorOffset = null, anchorReference = null;
      const ordering = 'r.timestamp,r.sequence,r.base_reference,r.chunk_index,r.id';
      if (reference) {
        const identities = all(`SELECT r.id,r.reference,r.base_reference,json_extract(r.payload_json,'$.outputRef') AS output_reference FROM records r WHERE ${where} ORDER BY ${ordering}`, scope.values);
        anchorOffset = identities.findIndex(row => row.reference === reference || row.id === reference || row.base_reference === reference || row.output_reference === reference);
        if (anchorOffset < 0) return null;
        anchorReference = identities[anchorOffset].reference;
        if (args.offset === undefined) paging.offset = Math.max(0, anchorOffset - 3);
      }
      const records = all(`SELECT r.* FROM records r WHERE ${where} ORDER BY ${ordering} LIMIT ? OFFSET ?`, [...scope.values, paging.limit, paging.offset]).map(row => recordObject(row));
      return { ...paged(records, total, paging), records, session: sessionObject(session), anchorOffset, anchorReference };
    },
    listSessions(args = {}, context) {
      const ctx = contextOf(context), paging = page(args), clauses = [], values = [];
      if (args.projectId) { clauses.push('s.project_id=?'); values.push(String(args.projectId)); }
      if (!ctx.admin && ctx.role !== 'teacher') { clauses.push("EXISTS(SELECT 1 FROM records r WHERE r.session_id=s.id AND (r.agent_id=? OR r.role='user' OR r.shared=1))"); values.push(ctx.agentId); }
      if (args.query) { clauses.push('s.task LIKE ? ESCAPE \'\\\''); values.push(`%${String(args.query).replace(/[\\%_]/g, '\\$&')}%`); }
      if (args.status) { clauses.push('s.status=?'); values.push(String(args.status)); }
      if (args.from) { clauses.push('s.started_at>=?'); values.push(iso(args.from)); }
      if (args.to) { clauses.push('s.started_at<=?'); values.push(iso(args.to)); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = Number(get(`SELECT count(*) AS n FROM sessions s ${where}`, values).n);
      return paged(all(`SELECT s.* FROM sessions s ${where} ORDER BY s.started_at DESC,s.id LIMIT ? OFFSET ?`, [...values, paging.limit, paging.offset]).map(sessionObject), total, paging);
    },
    memorySearch(args = {}, context) { return findMemories(args, context, true); },
    listMemories(args = {}, context) { return findMemories(args, context, false); },
    memoryGet(args, context) {
      const ctx = contextOf(context), id = typeof args === 'string' ? args : args?.id;
      const row = get('SELECT * FROM memories WHERE id=?', [String(id ?? '')]);
      return memoryAccess(row, ctx) && (ctx.admin || activeMemory(row)) ? memoryObject(row) : null;
    },
    saveMemory(value, context) {
      const ctx = contextOf(context);
      let id = required(value.id ?? `memory-${randomUUID()}`, 'memory id');
      const manual = ctx.admin && !ctx.automatic;
      if (tombstoned('memory', id)) throw new Error('Deleted memory cannot be restored by import');
      let old = get('SELECT * FROM memories WHERE id=?', [id]);
      if (old?.duplicate_of) {
        if (!memoryWritable(old, ctx)) throw new Error('Memory is outside the allowed scope');
        if (manual) throw new Error('Edit the canonical memory instead of its superseded duplicate');
        id = old.duplicate_of; old = get('SELECT * FROM memories WHERE id=?', [id]);
        if (!old) throw new Error('Canonical memory does not exist');
      }
      if (old && !memoryWritable(old, ctx)) throw new Error('Memory is outside the allowed scope');
      const kind = memoryKind(value.kind ?? old?.kind ?? 'agent'), category = value.category ?? old?.category ?? 'fact';
      const status = value.status ?? old?.status ?? 'active';
      if (!KINDS.has(kind) || !CATEGORIES.has(category) || !STATES.has(status)) throw new Error('Invalid memory kind, category or status');
      const projectId = required(old?.project_id ?? value.projectId ?? ctx.projectId ?? 'profile:global', 'project metadata', 32768);
      const agentId = Object.hasOwn(value, 'agentId') ? value.agentId : old ? old.agent_id : ctx.admin || ctx.role === 'teacher' ? null : ctx.agentId;
      if (!ctx.admin && ctx.role !== 'teacher') {
        if (kind !== 'agent' || agentId === null) throw new Error('Only a teacher or administrator can write shared or user memory');
        if (agentId !== ctx.agentId) throw new Error('Cannot write another agent memory');
      }
      if (kind === 'user' && agentId !== null) throw new Error('User memory must be shared');
      if (agentId !== null) required(agentId, 'memory agent id');
      if (!manual && value.status !== undefined && value.status !== 'active') throw new Error('Only an administrator can change a memory lifecycle directly');
      if (old && (old.agent_id !== agentId || old.kind !== kind)) throw new Error('Memory scope cannot be changed');
      const content = redactString(required(value.content ?? (manual ? old?.content : undefined), 'memory content', 32000));
      const hash = contentHash(content);
      if (!manual && old && (hash !== old.content_hash || category !== old.category || value.expiresAt !== undefined && iso(value.expiresAt) !== old.expires_at || value.lastVerifiedAt !== undefined)) throw new Error('Automatic memory writes cannot alter an existing memory');
      if (get('SELECT 1 FROM memory_content_tombstones WHERE kind=? AND agent_id=? AND content_hash=?', [kind, agentId ?? '', hash])) throw new Error('Deleted memory content cannot be restored by automatic extraction');
      const suppliedRefs = value.sourceRefs === undefined ? parse(old?.source_refs_json, []) : checkedRefs(value.sourceRefs);
      if (!manual && !suppliedRefs.length) throw new Error('Agent memory requires source references');
      // A manual edit of this exact id may change its lifecycle. A new id from
      // an automatic retry must never override a paused/retired equivalent.
      const duplicate = get("SELECT * FROM memories WHERE kind=? AND COALESCE(agent_id,'')=? AND content_hash=? AND id<>? AND duplicate_of IS NULL ORDER BY CASE status WHEN 'paused' THEN 0 WHEN 'invalid' THEN 1 ELSE 2 END,created_at,id LIMIT 1", [kind, agentId ?? '', hash, id]);
      const target = old || duplicate;
      const targetId = target?.id ?? id;
      const previousRefs = parse(old?.source_refs_json, []);
      const onlyDisabling = manual && old && status !== 'active' && value.status !== undefined
        && hash === old.content_hash && category === old.category
        && (value.expiresAt === undefined || iso(value.expiresAt) === old.expires_at)
        && (value.lastVerifiedAt === undefined || iso(value.lastVerifiedAt) === old.last_verified_at)
        && suppliedRefs.length === previousRefs.length && suppliedRefs.every(ref => previousRefs.includes(ref));
      if (!onlyDisabling) validateSources(suppliedRefs, { id: targetId, projectId, kind, agentId }, ctx);
      const mergedRefs = manual && old ? suppliedRefs : [...new Set([...(target ? parse(target.source_refs_json, []) : []), ...suppliedRefs])];
      const now = new Date().toISOString();
      if (duplicate && old) throw new Error('Memory content already belongs to another memory in this scope');
      if (duplicate || old && !manual) return transaction(() => {
        // Preserve content, lifecycle, expiry and review fields on every retry.
        run('UPDATE memories SET source_refs_json=?,updated_at=? WHERE id=?', [JSON.stringify(mergedRefs), now, targetId]);
        return mutationResult(get('SELECT * FROM memories WHERE id=?', [targetId]), ctx, { deduplicated: true });
      });
      const expiresAt = iso(value.expiresAt === undefined ? old?.expires_at : value.expiresAt);
      const verified = value.lastVerifiedAt === undefined ? old?.last_verified_at ?? null : iso(value.lastVerifiedAt);
      return transaction(() => {
        run(`INSERT INTO memories(id,project_id,agent_id,kind,category,content,status,source_refs_json,created_at,updated_at,last_verified_at,expires_at,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET category=excluded.category,content=excluded.content,status=excluded.status,source_refs_json=excluded.source_refs_json,updated_at=excluded.updated_at,last_verified_at=excluded.last_verified_at,expires_at=excluded.expires_at,content_hash=excluded.content_hash`, [id, projectId, agentId, kind, category, content, status, JSON.stringify(mergedRefs), old?.created_at ?? now, now, verified, expiresAt, hash]);
        run('DELETE FROM memories_fts WHERE id=?', [id]); run('INSERT INTO memories_fts(id,search_text) VALUES(?,?)', [id, indexed(content)]);
        return mutationResult(get('SELECT * FROM memories WHERE id=?', [id]), ctx);
      });
    },
    reviewMemory(args, context) {
      const ctx = contextOf(context), id = required(args.id, 'memory id');
      const row = get('SELECT * FROM memories WHERE id=?', [id]);
      if (!memoryAccess(row, ctx)) throw new Error('Memory does not exist or is outside the allowed scope');
      if (!VERDICTS.has(args.verdict)) throw new Error('Invalid memory review verdict');
      const reason = redactString(required(args.reason, 'memory review reason', 1200));
      const sourceRefs = checkedRefs(args.sourceRefs ?? []);
      validateSources(sourceRefs, { id, projectId: row.project_id, agentId: row.agent_id, kind: row.kind }, ctx);
      const reviewedAt = new Date().toISOString(), appliedToMemory = memoryWritable(row, ctx);
      const assessment = { verdict: args.verdict, reason, sourceRefs, reviewedAt, appliedToMemory, verifiedCurrentFact: false };
      if (!appliedToMemory) return mutationResult(row, ctx, { assessment });
      const status = row.status === 'active' && ['expired', 'invalid'].includes(args.verdict) ? 'invalid' : row.status;
      run('UPDATE memories SET status=?,review_reason=?,reviewed_at=?,review_verdict=?,review_source_refs_json=?,updated_at=? WHERE id=?', [status, reason, reviewedAt, args.verdict, JSON.stringify(sourceRefs), reviewedAt, id]);
      return mutationResult(get('SELECT * FROM memories WHERE id=?', [id]), ctx, { assessment });
    },
    deleteMemory(id, context) {
      const ctx = contextOf(context), row = get('SELECT * FROM memories WHERE id=?', [String(id)]);
      if (!row) return { deleted: false, id };
      if (!memoryAccess(row, ctx) || !ctx.admin && ctx.role !== 'teacher' && row.agent_id !== ctx.agentId) throw new Error('Memory is outside the allowed scope');
      return transaction(() => ({ deleted: true, id, deletedMemories: removeMemories([row.duplicate_of ?? id]) }));
    },
    deleteSession(id, context) {
      required(id, 'session id');
      const ctx = contextOf(context), session = get('SELECT * FROM sessions WHERE id=?', [id]);
      if (!session) {
        if (!ctx.admin && ctx.role !== 'teacher') throw new Error('Only a teacher or administrator can delete an archived session');
        markDeleted('session', id, ctx.projectId ?? 'legacy:unknown');
        return { deleted: false, id, tombstoned: true };
      }
      if (!ctx.admin && ctx.role !== 'teacher') throw new Error('Only a teacher or administrator can delete an archived session');
      return transaction(() => {
        const rows = all('SELECT id,reference,base_reference FROM records WHERE session_id=?', [id]);
        const refs = new Set(rows.flatMap(row => [row.id, row.reference, row.base_reference]));
        const affected = all('SELECT id,source_refs_json,review_source_refs_json FROM memories').filter(memory => [...parse(memory.source_refs_json, []), ...parse(memory.review_source_refs_json, [])].some(ref => refs.has(ref))).map(memory => memory.id);
        const deletedMemories = removeMemories(affected);
        for (const row of rows) { markDeleted('record', row.id, session.project_id); markDeleted('record', row.reference, session.project_id); run('DELETE FROM records_fts WHERE id=?', [row.id]); }
        markDeleted('session', id, session.project_id); run('DELETE FROM sessions WHERE id=?', [id]);
        return { deleted: true, id, deletedRecords: rows.length, deletedMemories };
      });
    },
    status() {
      const counts = {}; for (const table of ['sessions', 'records', 'memories', 'tombstones']) counts[table] = Number(get(`SELECT count(*) AS n FROM ${table}`).n);
      counts.contentTombstones = Number(get('SELECT count(*) AS n FROM memory_content_tombstones').n);
      const projects = all('SELECT DISTINCT project_id AS id FROM sessions UNION SELECT DISTINCT project_id AS id FROM memories ORDER BY id').map(row => row.id);
      return { available: true, filename, schemaVersion: SCHEMA_VERSION, ...counts, projects };
    },
    migrateProject(oldId, newId) {
      required(oldId, 'old project id', 32768); required(newId, 'new project id', 32768);
      const result = { oldId, newId, sessions: 0, records: 0, memories: 0, tombstones: 0, contentTombstones: 0 };
      if (oldId === newId) return result;
      return transaction(() => {
        const sessionsToMigrate = all('SELECT id,team_json,metadata_json FROM sessions WHERE project_id=?', [oldId]);
        const recordsToMigrate = all('SELECT id,text,payload_json FROM records WHERE project_id=?', [oldId]);
        for (const table of ['sessions', 'records', 'memories', 'tombstones']) {
          result[table] = Number(get(`SELECT count(*) AS n FROM ${table} WHERE project_id=?`, [oldId]).n);
          run(`UPDATE ${table} SET project_id=? WHERE project_id=?`, [newId, oldId]);
        }
        result.contentTombstones = Number(get('SELECT count(*) AS n FROM memory_content_tombstones WHERE project_id=?', [oldId]).n);
        run('UPDATE memory_content_tombstones SET project_id=? WHERE project_id=?', [newId, oldId]);
        for (const row of sessionsToMigrate) {
          run('UPDATE sessions SET team_json=?,metadata_json=? WHERE id=?', [JSON.stringify(replaceProjectIds(parse(row.team_json, []), oldId, newId)), JSON.stringify(replaceProjectIds(parse(row.metadata_json, {}), oldId, newId)), row.id]);
        }
        for (const row of recordsToMigrate) {
          const payload = JSON.stringify(replaceProjectIds(parse(row.payload_json, {}), oldId, newId));
          if (payload === row.payload_json) continue;
          run('UPDATE records SET payload_json=? WHERE id=?', [payload, row.id]);
          run('DELETE FROM records_fts WHERE id=?', [row.id]);
          run('INSERT INTO records_fts(id,search_text) VALUES(?,?)', [row.id, indexed(`${redactString(row.text)}\n${JSON.stringify(clean(parse(payload, {})))}`)]);
        }
        return result;
      });
    },
    rebuild() {
      return transaction(() => {
        run('DELETE FROM records_fts'); run('DELETE FROM memories_fts');
        for (const row of all('SELECT id,text,payload_json FROM records')) run('INSERT INTO records_fts(id,search_text) VALUES(?,?)', [row.id, indexed(`${redactString(row.text)}\n${JSON.stringify(clean(parse(row.payload_json, {})))}`)]);
        for (const row of all('SELECT id,content FROM memories')) run('INSERT INTO memories_fts(id,search_text) VALUES(?,?)', [row.id, indexed(redactString(row.content))]);
        return store.status();
      });
    },
    exportData(args = {}, context) {
      const ctx = contextOf(context), recordFilter = recordScope(ctx, args), memoryFilter = memoryScope(ctx, { ...args, includeInactive: true });
      const where = recordFilter.clauses.length ? `WHERE ${recordFilter.clauses.join(' AND ')}` : '';
      const records = all(`SELECT r.* FROM records r ${where} ORDER BY r.session_id,r.timestamp,r.sequence,r.base_reference,r.chunk_index,r.id`, recordFilter.values).map(row => recordObject(row));
      const sessionIds = new Set(records.map(record => record.sessionId));
      const sessions = all('SELECT * FROM sessions ORDER BY started_at').filter(row => (!args.projectId || row.project_id === args.projectId) && (ctx.admin || ctx.role === 'teacher' || sessionIds.has(row.id))).map(sessionObject);
      const memories = all(`SELECT m.* FROM memories m ${memoryFilter.clauses.length ? `WHERE ${memoryFilter.clauses.join(' AND ')}` : ''}`, memoryFilter.values).map(memoryObject);
      const tombstones = ctx.admin ? all(`SELECT type,id,project_id AS projectId,deleted_at AS deletedAt FROM tombstones ${args.projectId ? 'WHERE project_id=?' : ''}`, args.projectId ? [args.projectId] : []).map(row => ({ ...row })) : [];
      const contentTombstones = ctx.admin ? all(`SELECT project_id AS projectId,kind,agent_id AS agentId,content_hash AS contentHash,deleted_at AS deletedAt FROM memory_content_tombstones ${args.projectId ? 'WHERE project_id=?' : ''}`, args.projectId ? [args.projectId] : []).map(row => ({ ...row })) : [];
      return { version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), sessions, records, memories, tombstones, contentTombstones };
    },
    close() { if (!closed) { database.close(); closed = true; } },
  };
  function findMemories(args, context, search) {
    const ctx = contextOf(context), paging = page(args), scope = memoryScope(ctx, args, search), query = matchQuery(args.query);
    if (redactString(String(args.query ?? '')) !== String(args.query ?? '')) return paged([], 0, paging);
    let join = query ? 'JOIN memories_fts ON memories_fts.id=m.id' : '';
    const literal = String(args.query ?? '').trim();
    const substring = () => { scope.clauses.push('instr(lower(m.content),lower(?)) > 0'); scope.values.push(literal); };
    if (query) { scope.clauses.push('memories_fts MATCH ?'); scope.values.push(query); }
    else if (literal) substring();
    let where = scope.clauses.length ? `WHERE ${scope.clauses.join(' AND ')}` : '';
    let total = Number(get(`SELECT count(*) AS n FROM memories m ${join} ${where}`, scope.values).n);
    if (query && total === 0) {
      join = ''; scope.clauses.pop(); scope.values.pop(); substring();
      where = `WHERE ${scope.clauses.join(' AND ')}`;
      total = Number(get(`SELECT count(*) AS n FROM memories m ${where}`, scope.values).n);
    }
    const items = all(`SELECT m.* FROM memories m ${join} ${where} ORDER BY ${join ? 'bm25(memories_fts),' : ''}m.updated_at DESC,m.id LIMIT ? OFFSET ?`, [...scope.values, paging.limit, paging.offset]).map(memoryObject);
    return paged(items, total, paging);
  }
  return store;
}
