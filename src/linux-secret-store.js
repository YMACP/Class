import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { storageError } from './storage-health.js';

export const LINUX_CREDENTIALS_FILE = 'credentials.aesgcm.json';
export const LINUX_KEY_FILE = 'credentials.key';
const protection = 'local-key-aes-256-gcm';
const aad = Buffer.from('class.credentials.local-key-aes-256-gcm.v1');
const maximumPlaintext = 1024 * 1024;
const problem = (code, message) => Object.assign(new Error(message), { code });

// This is a local file-permission boundary, NOT an OS keyring or DPAPI.
// Anyone able to read both this profile's key and ciphertext can decrypt it.
// Keeping the key in the profile also makes verified directory migration work
// on headless Linux without D-Bus, an unlocked desktop keyring, or extra tools.
function checkPrivate(info, directory = false) {
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) {
    throw problem('CREDENTIALS_UNSAFE_FILE', '凭据路径必须是普通文件或目录，不能是符号链接');
  }
  if (!directory && info.nlink !== 1) throw problem('CREDENTIALS_MULTIPLE_LINKS', '凭据文件不能具有多个硬链接');
  if (process.platform !== 'win32') {
    const uid = typeof process.geteuid === 'function' ? process.geteuid() : process.getuid();
    if (info.uid !== uid) throw problem('CREDENTIALS_WRONG_OWNER', '凭据文件和数据目录必须属于当前运行用户');
    if ((info.mode & 0o777) !== (directory ? 0o700 : 0o600)) {
      throw problem('CREDENTIALS_UNSAFE_PERMISSIONS', directory ? 'Linux 数据目录权限必须为 0700；请自行检查并修正权限' : 'Linux 凭据文件和密钥权限必须为 0600；请自行检查并修正权限');
    }
  }
}

async function privateDirectory(dataDir, create = false) {
  if (create) await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  checkPrivate(await fs.lstat(dataDir), true);
}

async function readPrivate(filename, limit) {
  checkPrivate(await fs.lstat(filename));
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await file.stat(); checkPrivate(info);
    if (info.size > limit) throw problem('CREDENTIALS_TOO_LARGE', '凭据文件超出大小限制');
    const bytes = await file.readFile();
    if (bytes.length > limit) { bytes.fill(0); throw problem('CREDENTIALS_TOO_LARGE', '凭据文件超出大小限制'); }
    return bytes;
  } finally { await file.close(); }
}

async function present(filename) {
  try { await fs.lstat(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function assertNoForeignCredentials(dataDir, filename) {
  if (await present(path.join(dataDir, filename))) {
    throw problem('CREDENTIALS_FOREIGN_PLATFORM', '发现其他操作系统格式的凭据，无法直接解密；原文件已保留，请使用独立数据目录重新配置');
  }
}

async function syncDirectory(dataDir) {
  if (process.platform === 'win32') return;
  const file = await fs.open(dataDir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await file.sync(); } finally { await file.close(); }
}

async function writeTemporary(filename, bytes) {
  const file = await fs.open(filename, 'wx', 0o600);
  let complete = false;
  try {
    checkPrivate(await file.stat());
    await file.writeFile(bytes); await file.sync();
    await file.close();
    complete = true;
  } finally {
    if (!complete) {
      await file.close().catch(() => {});
      await fs.unlink(filename).catch(() => {});
    }
  }
}

async function readKey(filename) {
  // Exclusive hard-link publication can briefly leave our complete temporary
  // file and its final name linked together. Never read until only one remains.
  for (let attempt = 0; ; attempt++) {
    try {
      const key = await readPrivate(filename, 32);
      if (key.length !== 32) { key.fill(0); throw problem('CREDENTIALS_INVALID_KEY', '本地凭据密钥损坏；不会自动替换密钥'); }
      return key;
    } catch (error) {
      if (error.code !== 'CREDENTIALS_MULTIPLE_LINKS' || attempt >= 20) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

async function profileKey(dataDir, allowCreate) {
  const filename = path.join(dataDir, LINUX_KEY_FILE);
  try { return await readKey(filename); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!allowCreate) throw problem('CREDENTIALS_KEY_MISSING', '本地凭据密钥丢失；请恢复同一数据目录的 credentials.key，密文不会被覆盖');
  const temporary = `${filename}.${randomUUID()}.tmp`, candidate = randomBytes(32);
  let created = false;
  try {
    // Publish only a fully written and fsynced key. link is exclusive: a
    // concurrent first save cannot replace the winning key with a new one.
    await writeTemporary(temporary, candidate); created = true;
    try { await fs.link(temporary, filename); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    candidate.fill(0);
    if (created) await fs.unlink(temporary);
  }
  await syncDirectory(dataDir);
  return readKey(filename);
}

function decodeBase64(value, expectedLength) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw problem('CREDENTIALS_INVALID_ENVELOPE', '凭据文件格式无效');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) throw problem('CREDENTIALS_INVALID_ENVELOPE', '凭据文件格式无效');
  return bytes;
}

async function readEnvelope(dataDir) {
  let bytes;
  try { bytes = await readPrivate(path.join(dataDir, LINUX_CREDENTIALS_FILE), 2 * maximumPlaintext); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); }
  catch { throw problem('CREDENTIALS_ENVELOPE_INVALID_JSON', '凭据文件格式无效'); }
  if (!envelope || envelope.version !== 1 || envelope.protection !== protection) throw problem('CREDENTIALS_INVALID_ENVELOPE', '凭据文件格式无效');
  const decoded = { nonce: decodeBase64(envelope.nonce, 12), tag: decodeBase64(envelope.tag, 16), blob: decodeBase64(envelope.blob) };
  if (decoded.blob.length > maximumPlaintext) throw problem('CREDENTIALS_TOO_LARGE', '凭据文件超出大小限制');
  return decoded;
}

function decrypt(envelope, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 });
  decipher.setAAD(aad); decipher.setAuthTag(envelope.tag);
  let partial;
  try {
    partial = decipher.update(envelope.blob);
    return Buffer.concat([partial, decipher.final()]);
  } catch { throw problem('CREDENTIALS_AUTHENTICATION_FAILED', '凭据认证失败：密钥不匹配或密文已损坏；原文件已保留'); }
  finally { partial?.fill(0); }
}

function parseSecrets(plain) {
  let secrets;
  try { secrets = JSON.parse(plain.toString('utf8')); }
  catch { throw problem('CREDENTIALS_PAYLOAD_INVALID_JSON', '凭据数据格式无效'); }
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets) || Object.values(secrets).some(value => typeof value !== 'string' || value.length > 16384)) {
    throw problem('CREDENTIALS_INVALID_PAYLOAD', '凭据数据格式无效');
  }
  return secrets;
}

export async function loadLinuxSecrets(dataDir) {
  try { await privateDirectory(dataDir); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  await assertNoForeignCredentials(dataDir, 'credentials.dpapi.json');
  const envelope = await readEnvelope(dataDir);
  if (!envelope) return {};
  const key = await profileKey(dataDir, false);
  let plain;
  try { plain = decrypt(envelope, key); return parseSecrets(plain); }
  finally { key.fill(0); plain?.fill(0); }
}

export async function saveLinuxSecrets(dataDir, secrets) {
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets) || Object.values(secrets).some(value => typeof value !== 'string' || value.length > 16384)) throw problem('CREDENTIALS_INVALID_PAYLOAD', '凭据数据格式无效');
  const plain = Buffer.from(JSON.stringify(secrets));
  if (plain.length > maximumPlaintext) { plain.fill(0); throw problem('CREDENTIALS_TOO_LARGE', '凭据数据过大'); }
  const filename = path.join(dataDir, LINUX_CREDENTIALS_FILE), temporary = `${filename}.${randomUUID()}.tmp`;
  let key, created = false;
  try {
    await privateDirectory(dataDir, true);
    await assertNoForeignCredentials(dataDir, 'credentials.dpapi.json');
    const previous = await readEnvelope(dataDir);
    key = await profileKey(dataDir, !previous);
    // Do not overwrite damaged credentials or silently rotate a lost key.
    if (previous) { const oldPlain = decrypt(previous, key); try { parseSecrets(oldPlain); } finally { oldPlain.fill(0); } }
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const envelope = { version: 1, protection, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), blob: encrypted.toString('base64') };
    await writeTemporary(temporary, JSON.stringify(envelope) + '\n'); created = true;
    await fs.rename(temporary, filename); created = false;
    await syncDirectory(dataDir);
  } catch (error) {
    if (created) await fs.unlink(temporary).catch(() => {});
    throw error.code?.startsWith('CREDENTIALS_') ? error : storageError(error, { operation: '保存 Linux 本地加密凭据', path: filename });
  } finally { plain.fill(0); key?.fill(0); }
}
