import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { storageError } from './storage-health.js';
import { loadLinuxSecrets, saveLinuxSecrets, assertNoForeignCredentials, LINUX_CREDENTIALS_FILE } from './linux-secret-store.js';

// Windows CurrentUser DPAPI: the saved blob is usable only by the same account.
// Sensitive input travels over stdin, never through command-line arguments.
// The legacy entropy string is part of the encrypted format, not a product label.
// Keep it unchanged so existing credentials remain decryptable after renaming.
function dpapi(input, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('当前桌面版本仅支持 Windows 加密凭据存储');
  const method = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $entropy=[Text.Encoding]::UTF8.GetBytes('discussion.credentials.v1'); $result=[Security.Cryptography.ProtectedData]::${method}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 15000);
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 2 * 1024 * 1024) { failed = true; child.kill(); } });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => { failed = true; });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Windows 凭据加密组件启动失败')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || failed || !/^[A-Za-z0-9+/=\r\n]+$/.test(output)) return reject(new Error(decrypt ? '凭据解密失败，请使用保存它的 Windows 账户运行' : '凭据加密失败，配置未保存'));
      resolve(Buffer.from(output.trim(), 'base64'));
    });
    child.stdin.end(input.toString('base64'));
  });
}

export async function loadSecrets(dataDir) {
  if (process.platform === 'linux') return loadLinuxSecrets(dataDir);
  const filename = path.join(dataDir, 'credentials.dpapi.json');
  let raw;
  try { raw = await fs.readFile(filename, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') {
      if (process.platform === 'win32') await assertNoForeignCredentials(dataDir, LINUX_CREDENTIALS_FILE);
      return {};
    }
    throw error;
  }
  if (raw.length > 2 * 1024 * 1024) throw new Error('凭据文件超出大小限制');
  let envelope;
  try { envelope = JSON.parse(raw); }
  catch { throw Object.assign(new Error('凭据文件格式无效'), { code: 'CREDENTIALS_ENVELOPE_INVALID_JSON' }); }
  if (envelope.version !== 1 || typeof envelope.blob !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(envelope.blob)) throw new Error('凭据文件格式无效');
  const plain = await dpapi(Buffer.from(envelope.blob, 'base64'), true);
  try {
    let value;
    try { value = JSON.parse(plain.toString('utf8')); }
    catch { throw Object.assign(new Error('凭据数据格式无效'), { code: 'CREDENTIALS_PAYLOAD_INVALID_JSON' }); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error('凭据数据格式无效');
    return value;
  } finally { plain.fill(0); }
}

export async function saveSecrets(dataDir, secrets) {
  if (process.platform === 'linux') return saveLinuxSecrets(dataDir, secrets);
  if (process.platform === 'win32') await assertNoForeignCredentials(dataDir, LINUX_CREDENTIALS_FILE);
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets) || Object.values(secrets).some(v => typeof v !== 'string' || v.length > 16384)) throw new Error('凭据数据格式无效');
  const plain = Buffer.from(JSON.stringify(secrets));
  if (plain.length > 1024 * 1024) throw new Error('凭据数据过大');
  let encrypted;
  try { encrypted = await dpapi(plain); } finally { plain.fill(0); }
  const filename = path.join(dataDir, 'credentials.dpapi.json');
  const temporary = filename + '.' + randomUUID() + '.tmp';
  let file, created = false;
  try {
    await fs.mkdir(dataDir, { recursive: true });
    file = await fs.open(temporary, 'wx', 0o600); created = true;
    await file.writeFile(JSON.stringify({ version: 1, blob: encrypted.toString('base64') }) + '\n');
    await file.sync(); await file.close(); file = undefined;
    await fs.rename(temporary, filename);
  } catch (error) {
    await file?.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(() => {});
    throw storageError(error, { operation: '保存加密凭据', path: filename });
  }
}
