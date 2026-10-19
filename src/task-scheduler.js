import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON } from './profile-store.js';
import { storageError } from './storage-health.js';

const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES = new Set(['pending', 'dispatched', 'started', 'missed', 'interrupted', 'cancelled', 'failed']);
const EDITABLE = new Set(['pending', 'missed', 'interrupted', 'failed']);
const INPUT_FIELDS = new Set(['name', 'description', 'goal', 'scheduledAt', 'timezone', 'payload']);
export const TASK_SCHEDULE_LIMITS = Object.freeze({ count:500, payloadBytes:2 * 1024 * 1024, fileBytes:64 * 1024 * 1024, name:200, description:12000, goal:6000 });
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
function text(value, label, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!allowEmpty && !value.trim())) fail(400, `${label}格式无效`);
  return value;
}
function timestamp(value) {
  // Require an explicit UTC offset: locale parsing must never move a schedule.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail(400, '预约时间必须为带时区偏移的ISO时间');
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(value.slice(11,13)) > 23 || Number(value.slice(14,16)) > 59 || Number(value.slice(17,19)) > 59) fail(400, '预约时间不是有效日期');
  const time = Date.parse(value); if (!Number.isFinite(time)) fail(400, '预约时间不是有效日期');
  return new Date(time).toISOString();
}
function timezone(value) {
  text(value, '时区', 100);
  if (!/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(value)) fail(400, '时区必须为有效的IANA时区名称');
  try { new Intl.DateTimeFormat('en-US', { timeZone:value }).format(0); } catch { fail(400, '时区必须为有效的IANA时区名称'); }
  return value;
}
function payload(value = {}) {
  // The server owns payload validation and credential removal. Store only JSON;
  // list() is an INTERNAL snapshot and must be filtered before public exposure.
  let nodes = 0;
  const visit = (item, depth) => {
    if (depth > 32 || ++nodes > 20000) fail(400, '预约任务附加配置过于复杂');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const entry of item) visit(entry, depth + 1); return; }
    if (!object(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail(400, '预约任务附加配置必须为JSON对象');
    for (const [key, entry] of Object.entries(item)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(400, '预约任务附加配置字段无效'); visit(entry, depth + 1); }
  };
  if (!object(value)) fail(400, '预约任务附加配置必须为JSON对象');
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > TASK_SCHEDULE_LIMITS.payloadBytes) fail(400, '预约任务附加配置不能超过2MiB');
  return JSON.parse(serialized);
}
function definition(input, currentTime, { future = true } = {}) {
  if (!object(input) || Object.keys(input).some(key => !INPUT_FIELDS.has(key))) fail(400, '预约任务包含无效字段');
  const scheduledAt = timestamp(input.scheduledAt);
  if (future && Date.parse(scheduledAt) <= currentTime) fail(400, '预约时间必须晚于当前时间');
  return { name:text(input.name, '任务名称', TASK_SCHEDULE_LIMITS.name).trim(), description:text(input.description, '任务说明', TASK_SCHEDULE_LIMITS.description), goal:text(input.goal, '任务目标', TASK_SCHEDULE_LIMITS.goal), scheduledAt, timezone:timezone(input.timezone), payload:payload(input.payload) };
}
function validateSaved(value) {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.items) || value.items.length > TASK_SCHEDULE_LIMITS.count) throw Error('预约任务记录格式无效');
  const seen = new Set();
  const items = value.items.map(item => {
    if (!object(item) || !RUN_ID.test(item.id) || item.runId !== item.id || seen.has(item.id) || !STATUSES.has(item.status)) throw Error('预约任务记录格式无效');
    seen.add(item.id);
    const result = { id:item.id, runId:item.id, ...definition(Object.fromEntries([...INPUT_FIELDS].map(key => [key, item[key]])), 0, { future:false }), status:item.status, createdAt:timestamp(item.createdAt), updatedAt:timestamp(item.updatedAt) };
    for (const key of ['dispatchedAt', 'startedAt']) if (item[key] !== undefined) result[key] = timestamp(item[key]);
    if (item.reason !== undefined) result.reason = text(item.reason, '预约状态说明', 500, true);
    if (['dispatched', 'started'].includes(item.status) && !result.dispatchedAt) throw Error('预约任务缺少持久化启动凭据');
    return result;
  });
  return { version:1, revision:value.revision, items };
}

/** One-shot schedules. onDue creates/accepts a run; it must not await its whole
 * lifetime. Each callback receives a durable, predetermined runId. Callbacks
 * are independent; only small record mutations share a serialization lock. */
export async function createTaskScheduler({ directory, onDue, lookupRun, now = Date.now, onError = () => {}, autoStart = true, markOverdueMissed = true, writeJSON = atomicJSON } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof onDue !== 'function' || typeof lookupRun !== 'function' || typeof now !== 'function') throw Error('预约任务管理器配置无效');
  const filename = path.join(directory, 'task-schedules.json');
  let data = { version:1, revision:0, items:[] }, tail = Promise.resolve(), timer = null, closed = false, closePromise;
  const inFlight = new Map();
  const clock = () => { const time = Number(now()); if (!Number.isFinite(time) || time < 0 || time > 253402300799999) throw Error('预约任务时钟无效'); return time; };
  const report = error => { try { Promise.resolve(onError(error)).catch(() => {}); } catch {} };
  const list = () => clone({ revision:data.revision, items:data.items });
  function serial(work, internal = false) {
    const job = tail.catch(() => {}).then(() => { if (closed && !internal) fail(409, '预约任务管理器已关闭'); return work(); });
    tail = job; return job;
  }
  function checkRevision(revision) { if (revision !== undefined && (!Number.isSafeInteger(revision) || revision !== data.revision)) fail(409, '预约任务已更新，请刷新后重试'); }
  function find(id) { if (typeof id !== 'string' || !RUN_ID.test(id)) fail(400, '预约任务编号无效'); const item = data.items.find(item => item.id === id); if (!item) fail(404, '预约任务不存在'); return item; }
  async function publish(items) {
    if (!Number.isSafeInteger(data.revision + 1)) throw Error('预约任务版本号超出范围');
    const next = { version:1, revision:data.revision + 1, items };
    if (Buffer.byteLength(JSON.stringify(next, null, 2) + '\n') > TASK_SCHEDULE_LIMITS.fileBytes) fail(400, '预约任务记录过大，请减少任务内容');
    await writeJSON(filename, next); data = next;
  }
  function arm(retry = false) {
    if (timer) clearTimeout(timer); timer = null;
    if (closed || !autoStart) return;
    const pending = data.items.filter(item => item.status === 'pending'); if (!pending.length) return;
    const delay = retry ? 1000 : Math.min(30000, Math.max(0, Math.min(...pending.map(item => Date.parse(item.scheduledAt))) - clock()));
    timer = setTimeout(() => { timer = null; tick().catch(error => { report(error); arm(true); }); }, delay);
    timer.unref?.();
  }
  async function settle(item, error) {
    let exists = !error;
    if (error) { try { exists = Boolean(await lookupRun(item.runId)); } catch (lookupError) { report(lookupError); } }
    await serial(async () => {
      const current = data.items.find(entry => entry.id === item.id);
      if (current?.status !== 'dispatched' || current.dispatchedAt !== item.dispatchedAt) return;
      const at = new Date(clock()).toISOString();
      const next = { ...current, status:exists ? 'started' : 'failed', updatedAt:at, ...(exists ? { startedAt:at } : { reason:'启动失败，请检查任务配置后手动重试。' }) };
      await publish(data.items.map(entry => entry.id === item.id ? next : entry));
    }, true);
    if (error) report(error);
  }
  function launch(item) {
    // A shutdown after reservation leaves a durable dispatched entry for safe
    // reconciliation, never an unrecorded operation or automatic replay.
    if (closed) return;
    const work = Promise.resolve().then(async () => {
      if (closed) return;
      let failure;
      try { await onDue({ schedule:clone(item), runId:item.runId }); }
      catch (error) { failure = error instanceof Error ? error : new Error('预约任务启动失败'); }
      await settle(item, failure);
    });
    inFlight.set(item.id, work);
    work.catch(report).finally(() => { if (inFlight.get(item.id) === work) inFlight.delete(item.id); arm(); });
  }
  async function reserve(ids, { revision, manual = false } = {}) {
    const reserved = await serial(async () => {
      checkRevision(revision);
      const items = ids ? ids.map(find) : data.items.filter(item => item.status === 'pending' && Date.parse(item.scheduledAt) <= clock());
      if (manual && items.some(item => !EDITABLE.has(item.status))) fail(409, '该预约任务已开始或已取消');
      if (!items.length) return [];
      // A lookup failure must not create a second run when the outcome of an
      // earlier dispatch is unknown. Each read is independent of task lifetime.
      const existing = await Promise.all(items.map(item => lookupRun(item.runId)));
      const at = new Date(clock()).toISOString(), replacements = new Map(), due = [];
      for (const [index, item] of items.entries()) {
        const next = { ...item, status:existing[index] ? 'started' : 'dispatched', updatedAt:at, dispatchedAt:item.dispatchedAt || at };
        delete next.reason; delete next.startedAt;
        if (existing[index]) next.startedAt = at; else { next.dispatchedAt = at; due.push(next); }
        replacements.set(item.id, next);
      }
      await publish(data.items.map(item => replacements.get(item.id) || item));
      return due;
    });
    for (const item of reserved) launch(item);
    arm(); return list();
  }
  async function tick() { return reserve(); }

  await fs.mkdir(directory, { recursive:true, mode:0o700 });
  try {
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > TASK_SCHEDULE_LIMITS.fileBytes) throw Error('预约任务记录文件无效');
    const raw = await fs.readFile(filename, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > TASK_SCHEDULE_LIMITS.fileBytes) throw Error('预约任务记录文件过大');
    data = validateSaved(JSON.parse(raw));
  } catch (error) { if (error.code !== 'ENOENT') throw storageError(error, { operation:'读取预约任务', path:filename }); }
  const bootTime = clock(), bootAt = new Date(bootTime).toISOString();
  let recovered = false;
  const reconciled = await Promise.all(data.items.map(async item => {
    if (!['pending', 'dispatched'].includes(item.status)) return item;
    let exists;
    try { exists = Boolean(await lookupRun(item.runId)); }
    catch (error) { report(error); recovered = true; return { ...item, status:'interrupted', updatedAt:bootAt, reason:'无法核实上次启动状态，请检查历史任务后手动开始。' }; }
    if (exists) { recovered = true; return { ...item, status:'started', dispatchedAt:item.dispatchedAt || bootAt, startedAt:bootAt, updatedAt:bootAt }; }
    if (item.status === 'dispatched') { recovered = true; return { ...item, status:'interrupted', updatedAt:bootAt, reason:'上次启动未确认完成，请手动开始；系统不会自动重复执行。' }; }
    // A directory migration reopens the same live scheduler. Its elapsed work
    // stays pending and the timer dispatches it immediately; only a real app
    // restart marks unattended elapsed work missed.
    if (markOverdueMissed && Date.parse(item.scheduledAt) <= bootTime) { recovered = true; return { ...item, status:'missed', updatedAt:bootAt, reason:'启动时已超过预约时间，请手动开始或重新安排。' }; }
    return item;
  }));
  if (recovered) await publish(reconciled);

  const controller = {
    filename, list, tick,
    async create(input, { revision } = {}) {
      const result = await serial(async () => {
        checkRevision(revision);
        if (data.items.length >= TASK_SCHEDULE_LIMITS.count) fail(400, '最多保存500条预约任务');
        if (!object(input)) fail(400, '预约任务格式无效');
        const { id:providedId, runId:providedRunId, ...fields } = input;
        const id = providedId ?? providedRunId ?? 'run-' + randomUUID();
        if (typeof id !== 'string' || !RUN_ID.test(id) || providedId !== undefined && providedId !== id || providedRunId !== undefined && providedRunId !== id) fail(400, '预约任务编号无效');
        if (data.items.some(item => item.id === id)) fail(409, '预约任务编号已存在');
        const time = clock(), normalized = definition(fields, time), at = new Date(time).toISOString();
        await publish([...data.items, { id, runId:id, ...normalized, status:'pending', createdAt:at, updatedAt:at }]);
        return list();
      }); arm(); return result;
    },
    async update(id, input, { revision } = {}) {
      const result = await serial(async () => {
        checkRevision(revision); const current = find(id);
        if (!EDITABLE.has(current.status)) fail(409, '仅未开始的预约任务可以修改');
        if (!object(input) || Object.keys(input).some(key => !INPUT_FIELDS.has(key))) fail(400, '预约任务包含无效字段');
        const normalized = definition({ ...Object.fromEntries([...INPUT_FIELDS].map(key => [key, current[key]])), ...input }, clock());
        const next = { id:current.id, runId:current.runId, ...normalized, status:'pending', createdAt:current.createdAt, updatedAt:new Date(clock()).toISOString() };
        await publish(data.items.map(item => item.id === id ? next : item)); return list();
      }); arm(); return result;
    },
    async cancel(id, { revision } = {}) {
      const result = await serial(async () => {
        checkRevision(revision); const item = find(id);
        if (!EDITABLE.has(item.status)) fail(409, '该预约任务已开始或已取消');
        await publish(data.items.map(entry => entry.id === id ? { ...entry, status:'cancelled', updatedAt:new Date(clock()).toISOString(), reason:'已取消预约。' } : entry)); return list();
      }); arm(); return result;
    },
    startNow(id, { revision } = {}) { return reserve([id], { revision, manual:true }); },
    async remove(id, { revision } = {}) {
      const result = await serial(async () => {
        checkRevision(revision); const item = find(id);
        if (item.status === 'dispatched' || inFlight.has(id)) fail(409, '预约任务正在启动，请稍后重试');
        await publish(data.items.filter(entry => entry.id !== id)); return list();
      }); arm(); return result;
    },
    close() {
      if (!closePromise) {
        closed = true; if (timer) clearTimeout(timer); timer = null;
        closePromise = (async () => { await tail.catch(() => {}); await Promise.allSettled([...inFlight.values()]); await tail.catch(() => {}); })();
      }
      return closePromise;
    },
  };
  arm(); return controller;
}
