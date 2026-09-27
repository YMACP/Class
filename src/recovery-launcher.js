import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const RECOVERY_LAUNCHER = process.platform === 'win32' ? '启动Class.vbs' : '启动Class.sh';
export function desktopLaunchSpec({ noBrowser = false } = {}) {
  const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desktop.js');
  const sourceRuntime = /^(?:node|bun)(?:\.exe)?$/i.test(path.basename(process.execPath));
  return { executable: process.execPath, args: sourceRuntime && syncFs.existsSync(desktop) ? [desktop] : [], noBrowser };
}
export function quoteWindowsArgument(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw Error('Invalid recovery launcher argument');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
const vbsString = value => '"' + value.replace(/"/g, '""') + '"';
const shellString = value => "'" + value.replace(/'/g, "'\\''") + "'";

export async function writeRecoveryLauncher(directory, spec = desktopLaunchSpec()) {
  if (!spec || !path.isAbsolute(spec.executable) || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string')) throw Error('Invalid recovery launch specification');
  const args = [...spec.args, '--data-dir', directory, ...(spec.noBrowser ? ['--no-browser'] : [])];
  let bytes;
  if (process.platform === 'win32') {
    const command = [spec.executable, ...args].map(quoteWindowsArgument).join(' ');
    const variable = 'CLASS_RECOVERY_COMMAND_' + randomUUID().replaceAll('-', '');
    // Run expands the single environment reference once. Literal percent signs
    // inside paths remain data in the expanded command; no cmd.exe is involved.
    const script = 'Option Explicit\r\nDim launcher, environment\r\nSet launcher = CreateObject("WScript.Shell")\r\nSet environment = launcher.Environment("Process")\r\nenvironment(' + vbsString(variable) + ') = ' + vbsString(command) + '\r\nlauncher.Run ' + vbsString('%' + variable + '%') + ', 0, False\r\n';
    bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]);
  } else {
    for (const arg of [spec.executable, ...args]) if (/[\0\r\n]/.test(arg)) throw Error('Invalid recovery launcher argument');
    bytes = Buffer.from('#!/bin/sh\nexec ' + [spec.executable, ...args].map(shellString).join(' ') + '\n');
  }
  const filename = path.join(directory, RECOVERY_LAUNCHER), temporary = path.join(directory, '.class-launcher-' + randomUUID() + '.tmp');
  const file = await fs.open(temporary, 'wx', 0o700);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await fs.link(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return filename;
}
