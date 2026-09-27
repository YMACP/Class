import fs from 'node:fs/promises';
import path from 'node:path';

// Leave room for task summaries and recovery metadata. This is a safety margin,
// not a limit on task duration, rounds, or accumulated evidence.
export const STORAGE_RESERVE_BYTES = 32 * 1024 * 1024;

export function storageError(error, { operation, path: filename } = {}) {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.storageCode ||= failure.code || 'STORAGE_ERROR';
  failure.fatalStorage = true;
  if (failure.code !== 'STORAGE_LOW_SPACE') failure.code = 'STORAGE_ERROR';
  failure.operation ||= operation || failure.syscall || '本地数据读写';
  failure.storagePath ||= filename || failure.path;
  if (!failure.storageContextAdded) {
    failure.message = `${failure.operation}失败${failure.storagePath ? '（' + failure.storagePath + '）' : ''}：${failure.message}`;
    failure.storageContextAdded = true;
  }
  return failure;
}

export function storageDetails(error) {
  if (!error) return null;
  const filename = error.storagePath || error.path;
  return {
    code: error.storageCode || error.code || 'STORAGE_ERROR',
    operation: error.operation || error.syscall || '本地数据读写',
    ...(filename ? { path: filename, device: path.parse(path.resolve(filename)).root } : {}),
    message: error.message || String(error),
    ...Object.fromEntries(['availableBytes', 'requiredBytes', 'reserveBytes'].filter(key => Number.isFinite(error[key])).map(key => [key, error[key]])),
  };
}

export async function assertStorageSpace(directory, { requiredBytes = 0, reserveBytes = STORAGE_RESERVE_BYTES, operation = '检查存储空间' } = {}) {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0 || !Number.isSafeInteger(reserveBytes) || reserveBytes < 0) throw new Error('Invalid storage space requirement');
  let probe = path.resolve(directory), info;
  while (true) {
    try { info = await fs.statfs(probe, { bigint: true }); break; }
    catch (error) {
      const parent = path.dirname(probe);
      if (error.code === 'ENOENT' && parent !== probe) { probe = parent; continue; }
      throw storageError(error, { operation: '读取磁盘可用空间', path: directory });
    }
  }
  const available = BigInt(info.bavail) * BigInt(info.bsize);
  const required = BigInt(requiredBytes) + BigInt(reserveBytes);
  if (available < required) {
    throw storageError(Object.assign(new Error(`可用空间不足：剩余 ${Number(available)} 字节，需要至少 ${Number(required)} 字节（含 ${reserveBytes} 字节收尾余量）。请选择有足够空间的数据目录。`), {
      code: 'STORAGE_LOW_SPACE', availableBytes: Number(available), requiredBytes, reserveBytes,
    }), { operation, path: directory });
  }
  return { availableBytes: Number(available), requiredBytes, reserveBytes };
}

export function createStorageGuard(directory, { intervalMs = 1000, maxUncheckedBytes = 1024 * 1024, reserveBytes = STORAGE_RESERVE_BYTES } = {}) {
  let checkedAt = -Infinity, uncheckedBytes = 0, pending;
  return {
    async check(bytes = 0, { operation = '保存任务证据', path: filename = directory, force = false } = {}) {
      uncheckedBytes += bytes;
      if (pending) await pending;
      if (!force && Date.now() - checkedAt < intervalMs && uncheckedBytes < maxUncheckedBytes) return;
      if (!pending) {
        const budget = uncheckedBytes;
        pending = assertStorageSpace(directory, { requiredBytes: budget, reserveBytes, operation }).then(() => {
          checkedAt = Date.now(); uncheckedBytes = Math.max(0, uncheckedBytes - budget);
        }).catch(error => { throw storageError(error, { operation, path: filename }); }).finally(() => { pending = undefined; });
      }
      await pending;
    },
  };
}
