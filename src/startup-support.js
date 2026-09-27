import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaultStartupLogDirectory, startupLogDirectory } from './platform-paths.js';

const fallbackDirectory = defaultStartupLogDirectory();
let logDirectory = fallbackDirectory;
const secrets = new Set();

export function configureStartupLog(dataDir) { logDirectory = startupLogDirectory(dataDir); }
export function redactStartupSecret(secret) { if (secret) secrets.add(secret); }
function safe(text) {
  let value = String(text);
  for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
  return value.replace(/([#?&](?:token|api_?key|secret)=)[^\s&]+/gi, '$1[REDACTED]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/\b[a-f0-9]{64}\b/gi, '[REDACTED]');
}

export function startupFailureMessage(error) {
  // JSON parser messages can quote a damaged credentials/profile file. Never display that excerpt.
  return error instanceof SyntaxError ? '本地配置文件格式损坏，无法读取。请根据启动日志中的数据目录检查配置文件，或使用新的数据目录启动。' : safe(error?.message || '未知启动错误');
}

export function startupLog(event, detail = '') {
  const line = `${new Date().toISOString()} pid=${process.pid} ${event}${detail ? ' ' + safe(detail) : ''}\n`;
  for (const directory of [logDirectory, fallbackDirectory]) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      const filename = path.join(directory, 'startup.log');
      if (fs.existsSync(filename) && fs.statSync(filename).size > 1024 * 1024) {
        fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').slice(-512 * 1024), { mode: 0o600 });
      }
      fs.appendFileSync(filename, line, { mode: 0o600 });
      return filename;
    } catch { /* A read-only or invalid selected profile must still have a fallback log. */ }
  }
  return path.join(fallbackDirectory, 'startup.log');
}

function powershellPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function command(executable, args, input, timeoutMs = 15000) {
  const label = process.platform === 'win32' ? 'Windows launcher' : 'Browser launcher';
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false, output = '';
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(output.trim()); };
    const timer = timeoutMs ? setTimeout(() => { child.kill(); finish(new Error(label + ' timed out')); }, timeoutMs) : undefined;
    child.stdin.on('error', () => {});
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 8192) { child.kill(); finish(new Error(label + ' returned too much output')); } });
    child.stderr.on('data', () => {});
    child.once('error', error => finish(new Error(label + ' could not start (' + (error.code || 'unknown') + ')')));
    child.once('close', code => finish(code === 0 ? null : new Error(label + ' exited with code ' + code)));
    child.stdin.end(input || '');
  });
}

export async function launchBrowser(url, { platform = process.platform, commandRunner = command } = {}) {
  if (platform === 'win32') {
    // Pass the authenticated address through stdin, never shell interpolation or logs.
    const result = await commandRunner(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'\n$address=[Console]::In.ReadToEnd()\n$reason='default-launch-failed'\n$broken=$false\n$choice=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' -ErrorAction SilentlyContinue\nif($choice.ProgId){$broken= -not (Test-Path -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\'+$choice.ProgId))}\nif($broken){$reason='broken-default-association'}else{\n  try{Start-Process -FilePath $address -ErrorAction Stop;[Console]::Out.Write('browser=default');exit 0}catch{}\n}\n$candidates=@()\nforeach($name in @('chrome.exe','msedge.exe')){\n  foreach($hive in @('HKCU','HKLM')){\n    try{$p=(Get-Item -LiteralPath ($hive+':\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\'+$name) -ErrorAction Stop).GetValue('');if($p){$candidates+=@{name=$name;path=$p.Trim('\"')}}}catch{}\n  }\n}\nforeach($base in @($env:LOCALAPPDATA,$env:ProgramFiles,[Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))){\n  if($base){$candidates+=@{name='chrome.exe';path=(Join-Path $base 'Google\\Chrome\\Application\\chrome.exe')};$candidates+=@{name='msedge.exe';path=(Join-Path $base 'Microsoft\\Edge\\Application\\msedge.exe')}}\n}\nforeach($candidate in $candidates){\n  if(Test-Path -LiteralPath $candidate.path -PathType Leaf){\n    try{Start-Process -FilePath $candidate.path -ArgumentList @($address) -ErrorAction Stop;[Console]::Out.Write('browser='+$candidate.name+' fallback='+$reason);exit 0}catch{}\n  }\n}\nthrow 'No working browser could be launched'"], url);
    startupLog('browser-launch-route', /^(browser=(?:default|chrome\.exe|msedge\.exe))( fallback=(?:broken-default-association|default-launch-failed))?$/.test(result) ? result : 'launcher-completed');
  } else {
    await commandRunner(platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  }
}

function html(value) { return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }

export function writeBrowserEntry(dataDir, url, { platform = process.platform } = {}) {
  const file = path.join(dataDir, '打开Class.html');
  const restart = platform === 'linux' ? '启动 Class（或在终端运行 ./Class）' : '双击 Class.exe';
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>打开 Class</title><style>body{font:18px system-ui;max-width:680px;margin:12vh auto;padding:24px;background:#f4f6f5;color:#173f32}a{display:inline-block;padding:16px 24px;background:#205d48;color:white;border-radius:12px;text-decoration:none}p{line-height:1.7}</style><h1>Class 已在本机启动</h1><p>点击下方按钮打开工作空间。若服务已经退出，请先${html(restart)}。</p><a href="${html(url)}">打开 Class 工作空间</a><p>此文件包含本机访问凭据，请勿分享。</p></html>`;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, body, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

export async function showStartupError(message, { silent = false, platform = process.platform } = {}) {
  // Linux binaries have a console; preserve the authenticated browser fallback
  // there even when no graphical notification service is installed.
  if (platform === 'linux') { console.error(message); return; }
  if (silent || platform !== 'win32') return;
  try {
    // Keep the visible notice alive until the user dismisses it; there is no console window.
    await command(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $message=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); [Windows.Forms.MessageBox]::Show($message,'Class',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Warning)|Out-Null"], Buffer.from(message).toString('base64'), 0);
  } catch (error) {
    startupLog('error-notice-failed', error.message);
  }
}
