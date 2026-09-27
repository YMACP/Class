import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const WRITE_LIMIT = 4 * 1024 * 1024;
const SEARCH_FILE_LIMIT = 1024 * 1024;
const SEARCH_BYTE_LIMIT = 32 * 1024 * 1024;
const ENTRY_LIMIT = 20000;
const DEPTH_LIMIT = 64;
const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules']);
const locks = new Map();
const str = description => ({ type: 'string', description });
const nonempty = description => ({ ...str(description), minLength: 1 });
const flag = description => ({ type: 'boolean', description });
const paging = {
  offset: { type: 'integer', minimum: 0, maximum: 10000, description: 'Matching record offset, default 0. Pagination rescans the current filesystem; keep files unchanged between pages.' },
  limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum returned records, default 100.' },
  include_hidden: flag('Include dot files/directories, default false. .git, .hg, .svn and node_modules child directories are always skipped.'),
};
const definition = (name, description, properties, required) => ({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
export const fileToolDefinitions = [
  definition('write_file', 'Atomically create or explicitly overwrite a UTF-8 text file inside the workspace (max 4 MiB). Creates missing parent directories. Symlink/junction paths are rejected. Returns change counts and a bounded difference preview.', {
    path: nonempty('Workspace-relative file path.'), content: str('Complete UTF-8 content.'), overwrite: flag('Required true to replace an existing file; default false.'),
  }, ['path', 'content']),
  definition('edit_file', 'Atomically replace exact text in a workspace UTF-8 file (max 4 MiB). The original text must match exactly once unless replace_all is true. No fuzzy matching or newline normalization. Symlink/junction paths are rejected.', {
    path: nonempty('Workspace-relative file path.'), old_text: nonempty('Exact, nonempty original text including whitespace.'), new_text: str('Replacement text; may be empty.'), replace_all: flag('Replace every non-overlapping exact match, default false.'),
  }, ['path', 'old_text', 'new_text']),
  definition('glob', 'Find workspace files by glob. Supports *, ?, ** path segments and {a,b} alternatives; a pattern without / matches file basenames at any depth. Returns bounded pages; skips symlinks and common dependency/VCS directories. Stops at 20,000 entries or depth 64 and reports incomplete scans.', {
    pattern: nonempty('For example **/*.{js,ts}.'), path: nonempty('Workspace folder to search, default .'), ...paging,
  }, ['pattern']),
  definition('grep', 'Search UTF-8 text files line by line, using a literal string by default or a time-limited regular expression with literal:false. Returns file, 1-based line number and bounded line text. Skips binary/invalid UTF-8 files, symlinks and files above 1 MiB; scans at most 32 MiB or 20,000 entries. Reports omitted or truncated results.', {
    pattern: nonempty('Literal text or regular expression. Regex is per-line, without global/multiline flags.'), path: nonempty('Workspace file or folder, default .'), glob: nonempty('File filter, default **/*; same syntax as glob.'), literal: flag('Default true; false enables a regular expression in a time-limited worker.'), ignore_case: flag('Case insensitive matching, default false.'), ...paging,
  }, ['pattern']),
];

function argumentError(message) { return Object.assign(new Error(message), { code: 'TOOL_ARGUMENT_INVALID', memberRecoverable: true }); }
function assertInside(base, target) {
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Tool path escapes workspace');
}
function validateArgs(name, args) {
  const schema = fileToolDefinitions.find(item => item.name === name)?.parameters;
  if (!schema) throw argumentError('Unknown file tool: ' + name);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw argumentError('Tool arguments must be an object');
  for (const key of schema.required) if (!Object.hasOwn(args, key)) throw argumentError('Missing tool argument: ' + key);
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (!field) throw argumentError('Unsupported tool argument: ' + key);
    if (field.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== field.type) throw argumentError('Invalid tool argument: ' + key);
    if ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) throw argumentError('Invalid tool argument: ' + key);
    // old_text can intentionally consist entirely of spaces or newlines.
    if (field.minLength && (!value.length || (key !== 'old_text' && !value.trim()))) throw argumentError('Empty tool argument: ' + key);
  }
}
const checkpoint = (manager, signal) => manager.checkpoint(signal);
const relativeName = (base, target) => path.relative(base, target).split(path.sep).join('/');
async function optionalStat(target) {
  try { return await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writablePath(manager, value, signal, createParents = false) {
  await checkpoint(manager, signal);
  if (value.includes('\0')) throw argumentError('File path contains a NUL character');
  const base = await fs.realpath(manager.cwd);
  const target = path.resolve(base, value);
  assertInside(base, target);
  const parts = path.relative(base, target).split(path.sep);
  if (!parts[0]) throw argumentError('File path must name a file, not the workspace');
  if (process.platform === 'win32' && parts.some(part => /[:<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw argumentError('Unsupported Windows file path');
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    await checkpoint(manager, signal);
    current = path.join(current, parts[index]);
    let stat = await optionalStat(current);
    if (!stat && createParents && index < parts.length - 1) {
      const parent = await fs.realpath(path.dirname(current));
      assertInside(base, parent);
      try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await fs.lstat(current);
    }
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error('Writing through symlinks or junctions is not supported');
    assertInside(base, await fs.realpath(current));
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('File parent is not a directory');
    if (index === parts.length - 1 && !stat.isFile()) throw new Error('Target is not a regular file');
  }
  return { base, target };
}
function abortWait(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Tool cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function withLock(target, signal, action) {
  const key = process.platform === 'win32' ? target.toLowerCase() : target;
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  try { await abortWait(previous, signal); return await action(); }
  finally {
    release();
    void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  }
}
function decodeText(buffer) {
  if (buffer.includes(0)) throw new Error('Binary files are not supported');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new Error('File is not valid UTF-8 text'); }
}
async function snapshot(target, limit, manager, signal) {
  const stat = await optionalStat(target);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Target must be a regular file, without a symlink');
  if (stat.size > limit) throw new Error('File exceeds the ' + limit + '-byte limit');
  await manager._path(target);
  const handle = await fs.open(target, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile()) throw new Error('File changed while opening; retry after other writers finish');
    // Validate again after opening, before reading through the descriptor.
    await manager._path(target);
    const current = await fs.lstat(target);
    if (current.isSymbolicLink() || current.ino !== opened.ino || current.dev !== opened.dev) throw new Error('File changed while opening; retry after other writers finish');
    const chunks = [];
    let total = 0;
    while (true) {
      await checkpoint(manager, signal);
      const buffer = Buffer.allocUnsafe(Math.min(65536, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); total += bytesRead;
      if (total > limit) throw new Error('File exceeds the ' + limit + '-byte limit');
    }
    return { buffer: Buffer.concat(chunks, total), stat: opened };
  } finally { await handle.close(); }
}
function sameSnapshot(left, right) {
  if (!left || !right) return left === right;
  return left.stat.ino === right.stat.ino && left.stat.dev === right.stat.dev && left.buffer.equals(right.buffer);
}
async function commit(manager, value, original, content, signal) {
  const { base, target } = await writablePath(manager, value, signal, true);
  const parent = path.dirname(target);
  const parentIdentity = await fs.stat(parent);
  const temporary = path.join(parent, '.class-write-' + randomUUID() + '.tmp');
  let handle, created = false;
  try {
    await checkpoint(manager, signal);
    handle = await fs.open(temporary, 'wx', original?.stat.mode ?? 0o666); created = true;
    for (let offset = 0; offset < content.length; offset += 65536) {
      await checkpoint(manager, signal);
      await handle.writeFile(content.subarray(offset, offset + 65536));
    }
    await handle.sync(); await handle.close(); handle = null;
    await writablePath(manager, value, signal);
    const currentParent = await fs.stat(parent);
    if (currentParent.ino !== parentIdentity.ino || currentParent.dev !== parentIdentity.dev) throw new Error('File parent changed during writing');
    const current = await snapshot(target, WRITE_LIMIT, manager, signal);
    if (!sameSnapshot(original, current)) throw new Error('File changed during writing; retry after reading the latest contents');
    await checkpoint(manager, signal);
    // link is atomic and refuses an existing destination, including an external
    // writer creating the path after our last existence check.
    if (!original) { await fs.link(temporary, target); await fs.unlink(temporary); }
    else await fs.rename(temporary, target);
    created = false;
    return { base, target };
  } finally {
    if (handle) await handle.close();
    if (created) {
      // Never clean up via a parent that has been replaced by an outside link.
      try {
        assertInside(base, await fs.realpath(parent));
        const currentParent = await fs.stat(parent);
        if (currentParent.ino === parentIdentity.ino && currentParent.dev === parentIdentity.dev) await fs.unlink(temporary);
      } catch { /* Preserve the original write error; the unique temp may remain. */ }
    }
  }
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
function difference(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let left = before.length, right = after.length;
  while (left > start && right > start && before[left - 1] === after[right - 1]) { left--; right--; }
  const removed = before.slice(start, left), added = after.slice(start, right);
  return { firstChangedLine: before.slice(0, start).split('\n').length, removedCharacters: removed.length, addedCharacters: added.length, removedPreview: removed.slice(0, 1500), addedPreview: added.slice(0, 1500), previewTruncated: removed.length > 1500 || added.length > 1500 };
}
function result(manager, name, data, recordsKey) {
  const cap = manager.maxOutputBytes ?? 65536;
  let output = JSON.stringify(data, null, 2);
  let outputTruncated = false;
  if (recordsKey) {
    while (Buffer.byteLength(output) > cap && data[recordsKey].length) {
      data[recordsKey].pop(); data.returned = data[recordsKey].length;
      data.nextOffset = data.offset + data.returned;
      data.truncated = true; data.outputTruncated = true; outputTruncated = true;
      output = JSON.stringify(data, null, 2);
    }
  }
  if (Buffer.byteLength(output) > cap) {
    outputTruncated = true;
    // Keep structured output parseable even with a deliberately tiny budget.
    const concise = JSON.stringify({ truncated: true, ...(recordsKey ? { nextOffset: data.nextOffset, returned: data.returned } : { path: data.path, changed: data.changed }) });
    output = Buffer.byteLength(concise) <= cap ? concise : cap >= 18 ? '{"truncated":true}' : cap >= 2 ? '{}' : '0';
  }
  return { name, output, success: true, truncated: Boolean(data.truncated || data.diff?.previewTruncated || outputTruncated), outputTruncated, ...(recordsKey ? { nextOffset: data.nextOffset, returned: data.returned, scanTruncated: data.scanTruncated } : { summary: data }) };
}
async function mutate(manager, name, args, signal) {
  const first = await writablePath(manager, args.path, signal);
  return withLock(first.target, signal, async () => {
    const { base, target } = await writablePath(manager, args.path, signal);
    const original = await snapshot(target, WRITE_LIMIT, manager, signal);
    const before = original ? decodeText(original.buffer) : '';
    let after, replacements = 0;
    if (name === 'write_file') {
      if (original && args.overwrite !== true) throw new Error('File already exists; set overwrite:true to replace it');
      if (Buffer.byteLength(args.content, 'utf8') > WRITE_LIMIT) throw argumentError('Result exceeds the 4 MiB text-file limit');
      after = args.content;
    } else {
      if (!original) throw new Error('Cannot edit a missing file');
      let cursor = 0, match;
      while ((match = before.indexOf(args.old_text, cursor)) !== -1) {
        replacements++; cursor = match + args.old_text.length;
        if (replacements % 4096 === 0) await checkpoint(manager, signal);
      }
      if (!replacements) throw new Error('old_text does not exactly match the current file; no changes made');
      if (replacements > 1 && args.replace_all !== true) throw new Error('old_text matches ' + replacements + ' locations; provide unique text or set replace_all:true; no changes made');
      const replacementBytes = original.buffer.length + replacements * (Buffer.byteLength(args.new_text, 'utf8') - Buffer.byteLength(args.old_text, 'utf8'));
      if (replacementBytes > WRITE_LIMIT) throw argumentError('Result exceeds the 4 MiB text-file limit');
      after = args.replace_all ? before.split(args.old_text).join(args.new_text) : before.replace(args.old_text, () => args.new_text);
    }
    const bytes = Buffer.from(after, 'utf8');
    if (bytes.length > WRITE_LIMIT) throw argumentError('Result exceeds the 4 MiB text-file limit');
    decodeText(bytes);
    if (original && original.buffer.equals(bytes)) return result(manager, name, { path: relativeName(base, target), changed: false, replacements, bytes: bytes.length, sha256: sha256(bytes) });
    await commit(manager, args.path, original, bytes, signal);
    return result(manager, name, { path: relativeName(base, target), changed: true, action: original ? 'updated' : 'created', replacements, beforeBytes: original?.buffer.length ?? 0, afterBytes: bytes.length, beforeSha256: original ? sha256(original.buffer) : null, afterSha256: sha256(bytes), diff: difference(before, after) });
  });
}

function expandBraces(pattern) {
  let patterns = [pattern];
  for (let count = 0; count < 16; count++) {
    let expanded = false;
    const next = [];
    for (const item of patterns) {
      const start = item.indexOf('{');
      if (start === -1) { if (item.includes('}')) throw argumentError('Unbalanced glob braces'); next.push(item); continue; }
      const end = item.indexOf('}', start);
      if (end === -1 || item.slice(start + 1, end).includes('{')) throw argumentError('Glob braces must be balanced and not nested');
      const choices = item.slice(start + 1, end).split(',');
      if (choices.length < 2 || choices.some(choice => !choice)) throw argumentError('Glob braces require nonempty alternatives');
      for (const choice of choices) next.push(item.slice(0, start) + choice + item.slice(end + 1));
      expanded = true;
    }
    if (next.length > 64) throw argumentError('Too many glob alternatives (maximum 64)');
    patterns = next;
    if (!expanded) return patterns;
  }
  throw argumentError('Too many glob brace groups');
}
function segmentMatches(pattern, value) {
  let p = 0, v = 0, star = -1, retry = 0;
  while (v < value.length) {
    if (pattern[p] === '?' || pattern[p] === value[v]) { p++; v++; }
    else if (pattern[p] === '*') { star = p++; retry = v; }
    else if (star !== -1) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
function compileGlob(value) {
  if (value.length > 1024 || /[\[\]]/.test(value)) throw argumentError('Glob supports *, ?, ** and {a,b}; maximum pattern length is 1024');
  const normal = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normal.startsWith('/') || /^[A-Za-z]:/.test(normal) || normal.split('/').includes('..')) throw argumentError('Glob pattern must be relative and cannot contain ..');
  const alternatives = expandBraces(normal).map(item => {
    const parts = item.split('/');
    if (parts.some(part => !part) || parts.length > 64) throw argumentError('Invalid glob path segments');
    return parts.length === 1 ? ['**', ...parts] : parts;
  });
  return name => {
    const pieces = name.split('/');
    return alternatives.some(parts => {
      const seen = new Map();
      const match = (p, v) => {
        const key = p + ':' + v;
        if (seen.has(key)) return seen.get(key);
        const found = p === parts.length ? v === pieces.length
          : parts[p] === '**' ? match(p + 1, v) || (v < pieces.length && match(p, v + 1))
            : v < pieces.length && segmentMatches(parts[p], pieces[v]) && match(p + 1, v + 1);
        seen.set(key, found); return found;
      };
      return match(0, 0);
    });
  };
}
async function* walk(manager, root, includeHidden, state, signal, depth = 0) {
  await checkpoint(manager, signal);
  if (depth > DEPTH_LIMIT) { state.scanTruncated = true; state.skipped.depth++; return; }
  let directory;
  try { directory = await fs.opendir(root); }
  catch { state.skipped.unreadable++; return; }
  const entries = [];
  try {
    for await (const entry of directory) {
      await checkpoint(manager, signal);
      if (state.entries >= ENTRY_LIMIT) { state.scanTruncated = true; break; }
      state.entries++;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) { state.skipped.symlinks++; continue; }
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) { state.skipped.ignoredDirectories++; continue; }
      if (entry.isDirectory() || entry.isFile()) entries.push(entry);
    }
  } finally { try { await directory.close(); } catch (error) { if (error.code !== 'ERR_DIR_CLOSED') throw error; } }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    await checkpoint(manager, signal);
    const candidate = path.join(root, entry.name);
    let stat;
    try {
      stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) { state.skipped.symlinks++; continue; }
      await manager._path(candidate);
    } catch { state.skipped.unreadable++; continue; }
    if (stat.isFile()) yield candidate;
    else if (stat.isDirectory() && state.entries < ENTRY_LIMIT) yield* walk(manager, candidate, includeHidden, state, signal, depth + 1);
    else if (stat.isDirectory()) state.scanTruncated = true;
  }
}

// Source is embedded so Bun's standalone executable needs no worker sidecar.
const regexSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
let expression;
try { expression = new RegExp(workerData.pattern, workerData.ignoreCase ? 'iu' : 'u'); parentPort.postMessage({ ready: true }); }
catch (error) { parentPort.postMessage({ error: error.message }); }
parentPort.on('message', ({ text, maximum }) => {
  const matches = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (expression.test(lines[index])) {
      matches.push({ line: index + 1, text: lines[index].slice(0, 1000), lineTruncated: lines[index].length > 1000 });
      if (matches.length >= maximum) break;
    }
  }
  parentPort.postMessage({ matches });
});
`;
async function regexMatcher(pattern, ignoreCase, signal) {
  const worker = new Worker(regexSource, { eval: true, workerData: { pattern, ignoreCase } });
  const receive = send => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', failure); worker.off('exit', exited); signal?.removeEventListener('abort', aborted); };
    const failure = error => { cleanup(); reject(error); };
    const message = data => { cleanup(); data.error ? reject(argumentError('Invalid regular expression: ' + data.error)) : resolve(data); };
    const exited = code => failure(new Error('Regex worker exited unexpectedly (' + code + ')'));
    const aborted = () => failure(signal.reason || new Error('Tool cancelled'));
    const timer = setTimeout(() => failure(new Error('Regex search exceeded its 1-second per-file limit; use literal:true or simplify the pattern')), 1000);
    worker.on('message', message); worker.on('error', failure); worker.on('exit', exited); signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted(); else if (send) worker.postMessage(send);
  });
  try { await receive(); }
  catch (error) { await worker.terminate(); throw error; }
  return { match: async (text, maximum) => (await receive({ text, maximum })).matches, close: () => worker.terminate() };
}
async function literalMatches(manager, text, pattern, ignoreCase, maximum, signal) {
  const matches = [], needle = ignoreCase ? pattern.toLowerCase() : pattern;
  let start = 0, line = 1;
  while (start <= text.length) {
    if (line % 128 === 1) await checkpoint(manager, signal);
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    const value = text.slice(start, end).replace(/\r$/, '');
    if ((ignoreCase ? value.toLowerCase() : value).includes(needle)) {
      matches.push({ line, text: value.slice(0, 1000), lineTruncated: value.length > 1000 });
      if (matches.length >= maximum) break;
    }
    if (newline === -1) break;
    start = newline + 1; line++;
  }
  return matches;
}
async function search(manager, name, args, signal) {
  const base = await fs.realpath(manager.cwd);
  const root = await manager._path(args.path ?? '.');
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory() && (name !== 'grep' || !rootStat.isFile())) throw argumentError('Search path must be a directory' + (name === 'grep' ? ' or regular file' : ''));
  const matchesGlob = compileGlob(name === 'glob' ? args.pattern : args.glob ?? '**/*');
  if (name === 'grep' && args.pattern.length > 4096) throw argumentError('Search pattern exceeds the 4096-character limit');
  const offset = args.offset ?? 0, limit = args.limit ?? 100;
  const state = { entries: 0, scannedFiles: 0, scannedBytes: 0, scanTruncated: false, skipped: { binary: 0, large: 0, unreadable: 0, symlinks: 0, ignoredDirectories: 0, depth: 0 } };
  const records = [];
  let seen = 0, hasMore = false, matcher;
  try {
    if (name === 'grep' && args.literal === false) matcher = await regexMatcher(args.pattern, args.ignore_case === true, signal);
    const files = rootStat.isFile() ? [root] : walk(manager, root, args.include_hidden === true, state, signal);
    for await (const file of files) {
      await checkpoint(manager, signal);
      if (!matchesGlob(rootStat.isFile() ? path.basename(file) : relativeName(root, file))) continue;
      if (name === 'glob') {
        if (seen++ < offset) continue;
        if (records.length === limit) { hasMore = true; break; }
        records.push(relativeName(base, file)); continue;
      }
      let stat;
      try { stat = await fs.lstat(file); } catch { state.skipped.unreadable++; continue; }
      if (stat.isSymbolicLink() || !stat.isFile()) { state.skipped.symlinks++; continue; }
      if (stat.size > SEARCH_FILE_LIMIT) { state.skipped.large++; continue; }
      if (state.scannedBytes + stat.size > SEARCH_BYTE_LIMIT) { state.scanTruncated = true; break; }
      let source;
      try {
        await manager._path(file);
        const content = await snapshot(file, SEARCH_FILE_LIMIT, manager, signal);
        if (!content) { state.skipped.unreadable++; continue; }
        state.scannedBytes += content.buffer.length; state.scannedFiles++;
        if (state.scannedBytes > SEARCH_BYTE_LIMIT) { state.scanTruncated = true; break; }
        try { source = decodeText(content.buffer); } catch { state.skipped.binary++; continue; }
      } catch (error) { signal?.throwIfAborted(); state.skipped.unreadable++; continue; }
      const maximum = offset + limit + 1 - seen;
      const matches = matcher ? await matcher.match(source, maximum) : await literalMatches(manager, source, args.pattern, args.ignore_case === true, maximum, signal);
      for (const match of matches) {
        if (seen++ < offset) continue;
        if (records.length === limit) { hasMore = true; break; }
        records.push({ path: relativeName(base, file), ...match });
      }
      if (hasMore) break;
    }
  } finally { if (matcher) await matcher.close(); }
  const recordsKey = name === 'glob' ? 'files' : 'matches';
  const omitted = state.scanTruncated || state.skipped.large > 0 || state.skipped.unreadable > 0;
  return result(manager, name, { [recordsKey]: records, offset, returned: records.length, nextOffset: hasMore ? offset + records.length : null, truncated: hasMore || omitted || records.some(item => item.lineTruncated), hasMore, ...state, scope: 'Regular files only; no symlink traversal. Binary/invalid UTF-8, oversized files and excluded directories are reported in skipped. Narrow the path if scanTruncated is true.' }, recordsKey);
}

export async function executeFileTool(manager, studentId, name, args, signal) {
  validateArgs(name, args);
  await checkpoint(manager, signal);
  return name === 'write_file' || name === 'edit_file' ? mutate(manager, name, args, signal) : search(manager, name, args, signal);
}
