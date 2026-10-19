import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { atomicJSON } from './profile-store.js';
import { storageError } from './storage-health.js';

export const CHECKPOINT_SECRET_ID = 'checkpoint:key';
const RUN_ID = /^run-[0-9a-f-]{36}$/;
const MAX_PLAIN = 128 * 1024 * 1024, MAX_STORED = 64 * 1024 * 1024;
function checkedId(id) { if (typeof id !== 'string' || !RUN_ID.test(id)) throw new Error('无效的任务快照编号'); return id; }
function keyBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('任务快照密钥不可用');
  const key = Buffer.from(value, 'base64'); if (key.length !== 32) throw new Error('任务快照密钥不可用'); return key;
}
export function newCheckpointKey() { return randomBytes(32).toString('base64'); }
// Only the small encryption key goes through the existing OS credential store.
// Native provider replay data never enters public history JSON or memory indexing.
export class CheckpointStore {
  constructor({ directory, getKey }) { this.directory = directory; this.getKey = getKey; this.pending = new Map(); }
  filename(id) { return path.join(this.directory, checkedId(id) + '.json'); }
  async safeDirectory(create = false) {
    if (create) await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('任务快照目录不能是链接');
    if (process.platform === 'linux' && (info.mode & 0o777) !== 0o700) throw new Error('任务快照目录权限必须为0700');
  }
  async write(id, state, metadata = {}) {
    checkedId(id);
    const operation = (this.pending.get(id) ?? Promise.resolve()).then(async () => {
      const filename = this.filename(id);
      try {
        await this.safeDirectory(true);
        try { if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error('任务快照不能是链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const plaintext = Buffer.from(JSON.stringify({ state, metadata }));
        if (plaintext.length > MAX_PLAIN) throw new Error('任务快照超出大小限制');
        const compressed = gzipSync(plaintext, { level: 1 }); plaintext.fill(0);
        const key = keyBytes(await this.getKey(true)), iv = randomBytes(12);
        let body, tag;
        try {
          const cipher = createCipheriv('aes-256-gcm', key, iv);
          cipher.setAAD(Buffer.from(`Class checkpoint v1:${id}`));
          body = Buffer.concat([cipher.update(compressed), cipher.final()]); tag = cipher.getAuthTag();
        } finally { key.fill(0); compressed.fill(0); }
        if (body.length > MAX_STORED / 1.4) throw new Error('任务快照超出存储限制');
        const savedAt = new Date().toISOString();
        await atomicJSON(filename, { version: 1, runId: id, savedAt, iv: iv.toString('base64'), tag: tag.toString('base64'), body: body.toString('base64') });
        return { savedAt };
      } catch (error) { throw storageError(error, { operation: '保存安全续跑快照', path: filename }); }
    });
    this.pending.set(id, operation);
    try { return await operation; } finally { if (this.pending.get(id) === operation) this.pending.delete(id); }
  }
  async read(id) {
    const filename = this.filename(id);
    await this.pending.get(id);
    try { await this.safeDirectory(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let info; try { info = await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORED || info.nlink !== 1) throw new Error('任务快照文件无效');
    if (process.platform === 'linux' && (info.mode & 0o777) !== 0o600) throw new Error('任务快照文件权限必须为0600');
    const envelope = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (envelope.version !== 1 || envelope.runId !== id || ![envelope.iv, envelope.tag, envelope.body].every(value => typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value))) throw new Error('任务快照格式无效');
    const key = keyBytes(await this.getKey(false)), iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) { key.fill(0); throw new Error('任务快照校验无效'); }
    let compressed, plaintext;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(`Class checkpoint v1:${id}`)); decipher.setAuthTag(tag);
      compressed = Buffer.concat([decipher.update(Buffer.from(envelope.body, 'base64')), decipher.final()]);
      plaintext = gunzipSync(compressed, { maxOutputLength: MAX_PLAIN });
      return { ...JSON.parse(plaintext.toString('utf8')), savedAt: envelope.savedAt };
    } finally { key.fill(0); compressed?.fill(0); plaintext?.fill(0); }
  }
  async remove(id) {
    await this.pending.get(id)?.catch(() => {});
    try { await this.safeDirectory(); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await fs.unlink(this.filename(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
