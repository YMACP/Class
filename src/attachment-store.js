import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJSON } from './profile-store.js';

export const ATTACHMENT_LIMIT = 20 * 1024 * 1024;
export const ATTACHMENT_COUNT = 8;
export const ATTACHMENT_BODY_LIMIT = Math.ceil(ATTACHMENT_LIMIT / 3) * 4 + 4096;
const ID = /^attachment-[0-9a-f-]{36}$/;
const RUN_ID = /^run-[0-9a-f-]{36}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const problem = (status, message) => Object.assign(new Error(message), { status });
const inside = (root, target) => { const rel = path.relative(root, target); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
async function stat(target) { try { return await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function directory(root, segments, create = false) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw problem(409, '附件目录不能是符号链接');
  let target = await fs.realpath(root);
  const base = target;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || /[\\/]/.test(segment)) throw problem(400, '无效的附件目录');
    target = path.join(target, segment);
    let info = await stat(target);
    if (!info && create) { await fs.mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); info = await fs.lstat(target); }
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(base, await fs.realpath(target))) throw problem(409, '附件目录不能是符号链接');
  }
  return target;
}
async function readFile(filename, limit) {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw problem(409, '附件文件无效或已被替换');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino) throw problem(409, '附件文件已改变');
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw problem(413, '附件文件超过大小限制');
    return bytes;
  } finally { await handle.close(); }
}
const publicItem = item => ({ id: item.id, name: item.name, size: item.size, createdAt: item.createdAt, sha256: item.sha256, ...(item.path ? { path: item.path } : {}) });

/** Original uploads live in the profile; tools receive owned workspace copies. */
export class AttachmentStore {
  constructor(dataDir) { this.dataDir = dataDir; }
  async root(create = false) { return directory(this.dataDir, ['attachments'], create); }
  async load(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw problem(400, '无效的附件 ID');
    const root = await this.root(), folder = root && await directory(root, [id]);
    if (!folder) throw problem(404, '附件不存在，请重新上传');
    let item;
    try { item = JSON.parse((await readFile(path.join(folder, 'metadata.json'), 8192)).toString('utf8')); }
    catch (error) { if (error.status) throw error; throw problem(409, '附件元数据无法读取'); }
    if (item?.id !== id || typeof item.name !== 'string' || item.name.length > 255 || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > ATTACHMENT_LIMIT || !/^[0-9a-f]{64}$/.test(item.sha256) || (item.runId !== null && !RUN_ID.test(item.runId))) throw problem(409, '附件元数据无效');
    return { item, folder };
  }
  async pending() {
    const root = await this.root(); if (!root) return [];
    const result = [];
    for (const name of await fs.readdir(root)) if (ID.test(name)) { const { item } = await this.load(name); if (!item.runId) result.push(publicItem(item)); }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async upload(body) {
    if (Object.keys(body).some(key => !['name', 'contentBase64'].includes(key))) throw problem(400, '未知附件选项');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name)) throw problem(400, '附件名称无效');
    if (typeof body.contentBase64 !== 'string' || body.contentBase64.length > Math.ceil(ATTACHMENT_LIMIT / 3) * 4) throw problem(413, '每个附件最多 20 MiB');
    const bytes = Buffer.from(body.contentBase64, 'base64');
    if (bytes.length > ATTACHMENT_LIMIT) throw problem(413, '每个附件最多 20 MiB');
    if (bytes.toString('base64') !== body.contentBase64) throw problem(400, '附件内容不是有效的 Base64');
    if ((await this.pending()).length >= ATTACHMENT_COUNT) throw problem(409, '最多保留 8 个未提交附件，请先移除不需要的附件');
    const id = `attachment-${randomUUID()}`, root = await this.root(true), folder = await directory(root, [id], true);
    const item = { id, name, size: bytes.length, sha256: hash(bytes), createdAt: new Date().toISOString(), runId: null };
    try { await fs.writeFile(path.join(folder, 'content'), bytes, { flag: 'wx', mode: 0o600 }); await atomicJSON(path.join(folder, 'metadata.json'), item); }
    catch (error) { await fs.unlink(path.join(folder, 'content')).catch(() => {}); await fs.rmdir(folder).catch(() => {}); throw error; }
    return publicItem(item);
  }
  async removePending(id) {
    const { item, folder } = await this.load(id);
    if (item.runId) throw problem(409, '已提交的附件应随所属任务一起删除');
    await this.removeOriginal(item, folder);
    return { ok: true, deletedId: id };
  }
  async removeOriginal(item, folder) {
    const checked = await directory(this.dataDir, ['attachments', item.id]);
    if (!checked || path.relative(checked, folder)) throw problem(409, '附件目录已改变，原文件已保留');
    const bytes = await readFile(path.join(folder, 'content'), ATTACHMENT_LIMIT);
    if (bytes.length !== item.size || hash(bytes) !== item.sha256) throw problem(409, '附件原件已改变，原文件已保留');
    const names = await fs.readdir(folder);
    if (names.some(name => !['content', 'metadata.json'].includes(name))) throw problem(409, '附件目录包含其他文件，原文件已保留');
    await fs.unlink(path.join(folder, 'content')); await fs.unlink(path.join(folder, 'metadata.json')); await fs.rmdir(folder);
  }
  async prepare(ids = [], runId, cwd, { resume = false } = {}) {
    if (!Array.isArray(ids) || ids.length > ATTACHMENT_COUNT || new Set(ids).size !== ids.length || !RUN_ID.test(runId)) throw problem(400, '每个任务最多使用 8 个不同附件');
    const entries = [];
    for (const id of ids) {
      const { item, folder } = await this.load(id);
      if (item.runId && item.runId !== runId) throw problem(409, '附件已属于其他任务，请重新上传');
      if (resume && item.runId !== runId) throw problem(409, '续跑附件不属于当前任务');
      const bytes = await readFile(path.join(folder, 'content'), ATTACHMENT_LIMIT);
      if (bytes.length !== item.size || hash(bytes) !== item.sha256) throw problem(409, '附件原件校验失败，原文件已保留');
      entries.push({ item, folder, bytes });
    }
    const created = [];
    try {
      if (entries.length) {
        const target = await directory(cwd, ['.class-attachments', runId], true);
        for (const entry of entries) {
          const extension = path.extname(entry.item.name), filename = entry.item.id + (/^\.[a-z0-9]{1,12}$/i.test(extension) ? extension.toLowerCase() : '.bin');
          const destination = path.join(target, filename), existing = await stat(destination);
          if (existing) {
            const content = await readFile(destination, ATTACHMENT_LIMIT);
            if (content.length !== entry.item.size || hash(content) !== entry.item.sha256) throw problem(409, '任务附件的工作副本已改变，请保留并检查原文件');
          } else { await fs.writeFile(destination, entry.bytes, { flag: 'wx', mode: 0o600 }); created.push(destination); }
          entry.item = { ...entry.item, path: ['.class-attachments', runId, filename].join('/') };
        }
      }
    } catch (error) { for (const filename of created) await fs.unlink(filename).catch(() => {}); throw error; }
    return {
      attachments: entries.map(entry => publicItem(entry.item)),
      commit: async () => { for (const { item, folder } of entries) { const checked = await directory(this.dataDir, ['attachments', item.id]); if (!checked || path.relative(checked, folder)) throw problem(409, '附件目录已改变'); await atomicJSON(path.join(folder, 'metadata.json'), { ...item, runId }); } },
      rollback: async () => {
        if (!resume) for (const { item, folder } of entries) await atomicJSON(path.join(folder, 'metadata.json'), { ...item, runId: null, path: undefined });
        for (const filename of created) { const bytes = await readFile(filename, ATTACHMENT_LIMIT).catch(() => null); const entry = entries.find(entry => filename.endsWith(path.basename(entry.item.path))); if (bytes && entry && hash(bytes) === entry.item.sha256) await fs.unlink(filename); }
      }
    };
  }
  async removeRun(run, cwd) {
    for (const attachment of run.attachments || []) {
      let loaded;
      try { loaded = await this.load(attachment.id); } catch (error) { if (error.status === 404) continue; throw error; }
      if (loaded.item.runId !== run.id) throw problem(409, '附件归属不匹配，原文件已保留');
      // Changed/symlink workspace copies are user-owned from this point; preserve them.
      try {
        const target = await directory(cwd, ['.class-attachments', run.id]);
        const relative = loaded.item.path;
        if (target && typeof relative === 'string' && relative.startsWith(`.class-attachments/${run.id}/`) && path.posix.dirname(relative) === `.class-attachments/${run.id}`) {
          const filename = path.join(target, path.posix.basename(relative));
          const bytes = await readFile(filename, ATTACHMENT_LIMIT);
          if (bytes.length === loaded.item.size && hash(bytes) === loaded.item.sha256) await fs.unlink(filename);
        }
      } catch { /* Preserve anything no longer identifiable as our exact copy. */ }
      await this.removeOriginal(loaded.item, loaded.folder);
    }
    try { const target = await directory(cwd, ['.class-attachments', run.id]); if (target) await fs.rmdir(target); } catch { /* Never recursively remove workspace contents. */ }
  }
}
