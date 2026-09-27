import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { storageError } from './run-journal.js';
import { inspectToolCall, toolDefinitions } from './tool-contract.js';
import { executeFileTool, fileToolDefinitions } from './file-tools.js';
import { executeWebTool, webToolDefinitions } from './web-tools.js';
import { BrowserTools } from './browser-tools.js';
import { executeMediaTool, mediaToolDefinitions, retainToolMedia, summarizeToolResult } from './media-tools.js';
import { executePlanningTool, planningToolDefinitions } from './planning-tools.js';
import { executeMemoryTool, isMemoryTool } from './memory-tools.js';

const fileTools = new Set(fileToolDefinitions.map(tool => tool.name));
const webTools = new Set(webToolDefinitions.map(tool => tool.name));
const mediaTools = new Set(mediaToolDefinitions.map(tool => tool.name));
const planningTools = new Set(planningToolDefinitions.map(tool => tool.name));

function abortError(signal) { return signal?.reason instanceof Error ? signal.reason : new Error('Tool cancelled'); }
function runProcess(command, args, { maxBytes = 4096, input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    p.stdout.on('data', chunk => { if (output.length < maxBytes) output += chunk.toString().slice(0, maxBytes - output.length); });
    p.stderr.on('data', chunk => { if (errors.length < maxBytes) errors += chunk.toString().slice(0, maxBytes - errors.length); });
    if (input !== undefined) { p.stdin.on('error', reject); p.stdin.end(input); }
    p.once('error', reject); p.once('close', code => code === 0 ? resolve(output) : reject(new Error(`Process control failed (${code}): ${(output + errors).slice(0, 1000)}`)));
  });
}
const powerShell = () => process.platform === 'win32' ? path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
const encoded = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
function childEnvironment() {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'ComSpec', 'COMSPEC', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (process.platform === 'win32' && !env.PATHEXT) env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  return env;
}

// Each operation opens a process handle and verifies its creation time before
// acting. A recycled PID can never stand in for a process in the owned tree.
const treeControlSource = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public class ClassOwnedProcess {
 public int Pid; public int Parent; public string Created;
}
public static class ClassOwnedTree {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] struct Entry {
  public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string executable;
 }
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
 [DllImport("kernel32.dll", CharSet=CharSet.Auto)] static extern bool Process32First(IntPtr h, ref Entry e);
 [DllImport("kernel32.dll", CharSet=CharSet.Auto)] static extern bool Process32Next(IntPtr h, ref Entry e);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);
 [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
 [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);
 static long Created(IntPtr h) { long c,e,k,u; if(!GetProcessTimes(h,out c,out e,out k,out u))throw new Win32Exception(); return c; }
 static bool Alive(IntPtr h) { return WaitForSingleObject(h,0)==258; }
 static IntPtr OpenRaw(int pid) {
  IntPtr h=OpenProcess(0x101801,false,pid);
  if(h==IntPtr.Zero&&Marshal.GetLastWin32Error()!=87)throw new Win32Exception();
  return h;
 }
 static IntPtr Open(ClassOwnedProcess p) {
  IntPtr h=OpenRaw(p.Pid);
  if(h==IntPtr.Zero)return h;
  if(!Alive(h)||Created(h).ToString()!=p.Created){CloseHandle(h);return IntPtr.Zero;}
  return h;
 }
 static List<Entry> Snapshot() {
  var result=new List<Entry>(); IntPtr h=CreateToolhelp32Snapshot(2,0);
  if(h==new IntPtr(-1))throw new Win32Exception();
  try { Entry e=new Entry(); e.size=(uint)Marshal.SizeOf(typeof(Entry)); if(Process32First(h,ref e))do{result.Add(e);}while(Process32Next(h,ref e)); }
  finally{CloseHandle(h);} return result;
 }
 public static ClassOwnedProcess[] Pause(ClassOwnedProcess root) {
  var saved=new List<ClassOwnedProcess>(); var known=new Dictionary<int,ClassOwnedProcess>();
  IntPtr rootHandle=Open(root); if(rootHandle==IntPtr.Zero)return saved.ToArray();
  try {
   int status=NtSuspendProcess(rootHandle); if(status!=0)throw new Exception("Unable to pause command process");
   saved.Add(root);known[root.Pid]=root;
   for(int pass=0;pass<32;pass++) {
    int before=saved.Count; long captured=DateTime.UtcNow.ToFileTimeUtc(); var entries=Snapshot(); bool added;
    do { added=false;
     foreach(var item in entries) {
      ClassOwnedProcess parent;
      if(known.ContainsKey((int)item.pid)||!known.TryGetValue((int)item.parent,out parent))continue;
      IntPtr ph=Open(parent); if(ph==IntPtr.Zero)continue;
      try {
       IntPtr h=OpenRaw((int)item.pid); if(h==IntPtr.Zero)continue;
       try {
        long created=Created(h);
        if(!Alive(h)||created>captured||created<long.Parse(parent.Created))continue;
        var child=new ClassOwnedProcess{Pid=(int)item.pid,Parent=(int)item.parent,Created=created.ToString()};
        if(NtSuspendProcess(h)!=0)throw new Exception("Unable to pause command descendant");
        saved.Add(child);known[child.Pid]=child;added=true;
       } finally {CloseHandle(h);}
      } finally {CloseHandle(ph);}
     }
    } while(added);
    if(saved.Count==before)return saved.ToArray();
   }
   throw new Exception("Command process tree did not settle");
  } catch { try{Resume(saved.ToArray());}catch{} throw; }
  finally {CloseHandle(rootHandle);}
 }
 public static void Resume(ClassOwnedProcess[] members) {
  string failure=null;
  for(int i=members.Length-1;i>=0;i--){IntPtr h=Open(members[i]);if(h==IntPtr.Zero)continue;try{if(NtResumeProcess(h)!=0)failure="Unable to resume command process";}finally{CloseHandle(h);}}
  if(failure!=null)throw new Exception(failure);
 }
 public static void Stop(ClassOwnedProcess root, ClassOwnedProcess[] members) {
  var all=new Dictionary<int,ClassOwnedProcess>(); foreach(var item in members)all[item.Pid]=item;
  foreach(var item in Pause(root))all[item.Pid]=item;
  var ordered=new List<ClassOwnedProcess>(all.Values); if(!all.ContainsKey(root.Pid))ordered.Insert(0,root);
  string failure=null;
  for(int i=ordered.Count-1;i>=0;i--){IntPtr h=Open(ordered[i]);if(h==IntPtr.Zero)continue;try{if(!TerminateProcess(h,1)&&Alive(h))failure="Unable to stop command process";}finally{CloseHandle(h);}}
  if(failure!=null)throw new Exception(failure);
 }
}
`;

async function captureProcessIdentity(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return null;
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=[Diagnostics.Process]::GetProcessById(${child.pid}); $created=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); $entry=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}'; if($entry.ParentProcessId -ne ${process.pid}){throw 'Command process ownership changed'}; @{Pid=${child.pid};Parent=${process.pid};Created=$created}|ConvertTo-Json -Compress`;
  try { const identity = JSON.parse((await runProcess(powerShell(), encoded(script))).trim()); return child.exitCode === null && child.signalCode === null ? identity : null; }
  catch (error) { if (child.exitCode !== null || child.signalCode !== null) return null; throw error; }
}
async function controlProcessTree(record, operation) {
  await record.identityReady;
  if (!record.identity) return;
  const payload = JSON.stringify({ root: record.identity, members: record.members || [] });
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition @'\n${treeControlSource}\n'@\n$p=([Console]::In.ReadToEnd()|ConvertFrom-Json); $root=New-Object ClassOwnedProcess; $root.Pid=$p.root.Pid; $root.Parent=$p.root.Parent; $root.Created=$p.root.Created; $members=@($p.members|ForEach-Object {$x=New-Object ClassOwnedProcess;$x.Pid=$_.Pid;$x.Parent=$_.Parent;$x.Created=$_.Created;$x}); ${operation === 'pause' ? '$result=@([ClassOwnedTree]::Pause($root)); ConvertTo-Json -InputObject $result -Compress' : operation === 'resume' ? '[ClassOwnedTree]::Resume([ClassOwnedProcess[]]$members)' : '[ClassOwnedTree]::Stop($root,[ClassOwnedProcess[]]$members)'}`;
  const result = await runProcess(powerShell(), encoded(script), { maxBytes: 1024 * 1024, input: payload });
  if (operation === 'pause') {
    record.members = JSON.parse(result.trim());
    if (!record.members.length && record.child.exitCode === null && record.child.signalCode === null) throw new Error('Command process identity changed before suspension');
  }
  else if (operation === 'resume') record.members = [];
}
async function suspendChild(child, resume = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') {
    if (!child.kill(resume ? 'SIGCONT' : 'SIGSTOP')) throw new Error('Unable to change child process suspension');
    return;
  }
  const method = resume ? 'NtResumeProcess' : 'NtSuspendProcess';
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ClassProcessControl { [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a,bool b,int p); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr p); [DllImport("ntdll.dll")] public static extern int ${method}(IntPtr p); }'; $h=[ClassProcessControl]::OpenProcess(0x0800,$false,${child.pid}); if($h -eq [IntPtr]::Zero){throw 'OpenProcess failed'}; try { $s=[ClassProcessControl]::${method}($h); if($s -ne 0){throw "${method} failed: $s"} } finally { [ClassProcessControl]::CloseHandle($h) | Out-Null }`;
  try { await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]); }
  catch (error) { if (child.exitCode === null && child.signalCode === null) throw error; }
}

/** Tools use a shared suspension gate. run_command controls its foreground
 * process tree. Background/detached work is outside the supported contract. */
export class ToolManager {
  constructor({ cwd = process.cwd(), allowShell = false, maxOutputBytes = 65536, onActivity, evidenceReader, createOutputArtifact, planningState = new Map(), webOptions = {}, browserOptions = {}, memory } = {}) {
    this.cwd = path.resolve(cwd); this.allowShell = allowShell;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("maxOutputBytes must be a positive integer");
    this.maxOutputBytes = maxOutputBytes; this.pauseVersion = 0;
    this.paused = false; this.stopped = false; this.events = new EventEmitter();
    this.events.setMaxListeners(0); this.controller = new AbortController(); this.children = new Set();
    this.control = Promise.resolve();
    this.onActivity = onActivity; this.evidenceReader = evidenceReader;
    this.createOutputArtifact = createOutputArtifact;
    this.activeExecutions = new Set();
    this.planningState = planningState; this.webOptions = webOptions; this.browserOptions = browserOptions;
    this.memory = memory;
    this.mediaId = randomUUID(); this.browserTools = new BrowserTools(this);
    this.availableShells = process.platform === 'win32' ? ['powershell'] : [];
    this.defaultShell = process.platform === 'win32' ? 'powershell' : 'bash';
    this.shellExecutables = process.platform === 'win32' ? { powershell: powerShell() } : {};
  }
  prepare({ signal } = {}) {
    if (!this.preparing) this.preparing = this._prepare(this._signal(signal));
    return this.preparing;
  }
  async _prepare(signal) {
    signal.throwIfAborted();
    if (!this.allowShell) return this;
    const candidates = [];
    if (process.platform === 'win32') {
      for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean)) candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
    }
    for (const directory of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) candidates.push(path.resolve(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'bash.exe' : 'bash'));
    if (process.platform !== 'win32') candidates.push('/bin/bash', '/usr/bin/bash');
    for (const candidate of [...new Set(candidates)]) {
      signal.throwIfAborted();
      try { if (!(await fs.stat(candidate)).isFile()) continue; } catch { continue; }
      if (await this._probeBash(candidate, signal)) { this.shellExecutables.bash = await fs.realpath(candidate); if (!this.availableShells.includes('bash')) this.availableShells.push('bash'); break; }
    }
    return this;
  }
  async _probeBash(executable, signal) {
    return new Promise((resolve, reject) => {
      let child, output = '', failed = false;
      try { child = spawn(executable, ['--noprofile', '--norc', '-c', "printf '%s' CLASS_BASH_READY"], { cwd: this.cwd, env: childEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { resolve(false); return; }
      const stop = () => { failed = true; child.kill('SIGKILL'); };
      const timeout = setTimeout(stop, 2000);
      signal.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', chunk => { if (output.length < 100) output += chunk.toString().slice(0, 100 - output.length); }); child.stderr.resume();
      child.once('error', () => { failed = true; });
      child.once('close', code => { clearTimeout(timeout); signal.removeEventListener('abort', stop); if (signal.aborted) reject(abortError(signal)); else resolve(!failed && code === 0 && output === 'CLASS_BASH_READY'); });
      if (signal.aborted) stop();
    });
  }
  _signal(signal) { return signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal; }
  async checkpoint(signal) {
    signal = this._signal(signal);
    while (this.paused) {
      signal.throwIfAborted();
      await this._wait(Infinity, signal);
    }
    signal.throwIfAborted();
  }
  _wait(ms, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); this.events.off('change', changed); signal?.removeEventListener('abort', aborted); };
      const changed = () => { cleanup(); resolve(); };
      const aborted = () => { cleanup(); reject(abortError(signal)); };
      this.events.once('change', changed); signal?.addEventListener('abort', aborted, { once: true });
      if (Number.isFinite(ms)) timer = setTimeout(changed, ms);
      if (signal?.aborted) aborted();
    });
  }
  async _path(value = '.') {
    const base = await fs.realpath(this.cwd);
    const candidate = await fs.realpath(path.resolve(base, value));
    const relative = path.relative(base, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Tool path escapes workspace');
    return candidate;
  }
  execute(studentId, action, options = {}) {
    const execution = this._executeManaged(studentId, action, options);
    this.activeExecutions.add(execution);
    execution.finally(() => this.activeExecutions.delete(execution)).catch(() => {});
    return execution;
  }
  async _executeManaged(studentId, { name, args = {} }, { signal, metadata = {} } = {}) {
    signal = this._signal(signal); await this.checkpoint(signal);
    await this.prepare({ signal });
    ({ name, args } = inspectToolCall(name, args, { definitions: toolDefinitions(this, { includeLegacy: true }) }));
    const callId = randomUUID(), startedAt = new Date().toISOString();
    const activity = { callId, studentId, action: { name, args }, startedAt, metadata };
    await this._activity({ ...activity, type: 'started', status: 'started', timestamp: startedAt });
    let result, artifact, outputArtifact;
    try {
      signal.throwIfAborted();
      if (['shell', 'run_command', 'read_file'].includes(name) && this.createOutputArtifact) {
        try { artifact = await this.createOutputArtifact(activity); }
        catch (error) { throw storageError(error); }
      }
      result = { ...await this._execute(studentId, name, args, signal, metadata, artifact, activity), callId };
      await retainToolMedia(this, result, signal);
      if (artifact) {
        try { outputArtifact = await artifact.close(); }
        catch (error) { throw storageError(error); }
        result.outputRef = outputArtifact.reference; result.outputBytes = outputArtifact.bytes; result.outputDigest = outputArtifact.sha256;
      }
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      if (['shell', 'run_command'].includes(name) && !error.executionStatus && !error.fatalStorage) error.executionStatus = 'not_started';
      if (artifact && !outputArtifact) {
        try { outputArtifact = await artifact.abort(error); }
        catch (storageFailure) { throw storageError(storageFailure); }
      }
      const completedAt = new Date().toISOString();
      const recorded = await this._activity({ ...activity, type: 'failed', status: 'failed', timestamp: completedAt, completedAt, error: error.message || String(error), executionStatus: error.executionStatus, ...(outputArtifact ? { outputRef: outputArtifact.reference, outputBytes: outputArtifact.bytes, incomplete: true } : {}) });
      error.callId = callId;
      if (recorded?.reference) error.evidenceRef = recorded.reference;
      if (outputArtifact) { error.outputRef = outputArtifact.reference; error.outputBytes = outputArtifact.bytes; }
      throw error;
    }
    const completedAt = new Date().toISOString();
    // Persist a completed operation before waiting at the pause gate. The
    // caller resumes with this exact result, without re-executing the tool.
    const failed = result.success === false;
    const recorded = await this._activity({ ...activity, type: failed ? 'failed' : 'completed', status: failed ? 'failed' : 'completed', timestamp: completedAt, completedAt, output: result.output, result: summarizeToolResult(result), success: result.success, exitCode: result.exitCode, executionStatus: result.executionStatus });
    if (recorded?.reference) result.evidenceRef = recorded.reference;
    await this.checkpoint(signal);
    return result;
  }
  async _activity(activity) {
    try { return await this.onActivity?.(activity); }
    catch (error) { throw storageError(error); }
  }
  async _execute(studentId, name, args, signal, metadata, artifact, activity) {
    if (fileTools.has(name)) return executeFileTool(this, studentId, name, args, signal);
    if (webTools.has(name)) return executeWebTool(this, studentId, name, args, signal);
    if (mediaTools.has(name)) return executeMediaTool(this, studentId, name, args, signal);
    if (planningTools.has(name)) return executePlanningTool(this, studentId, name, args, signal);
    if (isMemoryTool(name)) return executeMemoryTool(this, studentId, name, args, signal);
    if (name === 'browser') return this.browserTools.execute(studentId, name, args, signal);
    let output;
    if (name === 'sleep') {
      let remaining = Number(args.ms);
      if (!Number.isFinite(remaining) || remaining < 0 || remaining > 86400000) throw new Error('sleep.ms must be between 0 and 86400000');
      while (remaining > 0) {
        await this.checkpoint(signal);
        const start = performance.now(); await this._wait(remaining, signal);
        remaining -= performance.now() - start;
      }
      output = `Slept ${args.ms} ms of active time`;
    } else if (name === 'read_file') {
      const filename = await this._path(args.path); await this.checkpoint(signal);
      const file = await fs.open(filename, 'r');
      const chunks = []; let bytes = 0, keptBytes = 0;
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error('read_file requires a regular file');
        const byteLimit = artifact ? stat.size : Math.min(stat.size, this.maxOutputBytes);
        while (bytes < byteLimit) {
          await this.checkpoint(signal);
          const buffer = Buffer.alloc(Math.min(16384, byteLimit - bytes));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          const chunk = buffer.subarray(0, bytesRead);
          if (artifact) await artifact.write(chunk);
          const keep = chunk.subarray(0, Math.max(0, this.maxOutputBytes - keptBytes));
          if (keep.length) chunks.push(keep);
          keptBytes += keep.length; bytes += bytesRead;
        }
        output = Buffer.concat(chunks).toString('utf8');
        const truncated = (await file.stat()).size > keptBytes;
        return { name, output, truncated };
      } finally { await file.close(); }
    } else if (name === 'list_files') {
      const directory = await this._path(args.path); await this.checkpoint(signal);
      output = (await fs.readdir(directory)).sort().join('\n');
    } else if (name === 'read_evidence') {
      if (typeof this.evidenceReader !== 'function') throw new Error('Evidence reader is not configured');
      if (args.reference !== undefined && (typeof args.reference !== 'string' || !args.reference.trim())) throw new Error('read_evidence.reference must be a nonempty string');
      if (args.member !== undefined && (typeof args.member !== 'string' || !args.member.trim())) throw new Error('read_evidence.member must be a nonempty string');
      if (args.studentId !== undefined && (typeof args.studentId !== 'string' || !args.studentId.trim())) throw new Error('read_evidence.studentId must be a nonempty string');
      if (args.kind !== undefined && (typeof args.kind !== 'string' || !args.kind.trim())) throw new Error('read_evidence.kind must be a nonempty string');
      if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) throw new Error('read_evidence.offset must be a nonnegative integer');
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new Error('read_evidence.limit must be between 1 and 100');
      if (args.byteOffset !== undefined && (!Number.isSafeInteger(args.byteOffset) || args.byteOffset < 0)) throw new Error('read_evidence.byteOffset must be a nonnegative integer');
      if (args.maxBytes !== undefined && (!Number.isSafeInteger(args.maxBytes) || args.maxBytes < 4 || args.maxBytes > 65536)) throw new Error('read_evidence.maxBytes must be between 4 and 65536');
      const query = { ...args, ...(args.studentId || args.member ? { studentId: args.studentId || args.member } : {}) };
      let evidence = await this.evidenceReader(query, { studentId, signal, metadata });
      output = typeof evidence === 'string' ? evidence : JSON.stringify(evidence ?? null);
      // Keep the JSON envelope valid even for pages containing large tool
      // records. The full record/output remains addressable by reference.
      if (Buffer.byteLength(output) > this.maxOutputBytes && evidence && typeof evidence === 'object') {
        if (typeof evidence.output === 'string' && typeof evidence.reference === 'string') {
          let maxBytes = Math.min(args.maxBytes ?? 32768, Math.max(4, Math.floor(this.maxOutputBytes / 8)));
          evidence = await this.evidenceReader({ ...query, maxBytes }, { studentId, signal, metadata });
          output = JSON.stringify(evidence);
        } else if (Array.isArray(evidence.records)) {
          const records = [];
          for (const record of evidence.records) {
            const summary = { ...record };
            if (Buffer.byteLength(JSON.stringify(summary)) > this.maxOutputBytes / 2) {
              const activity = record.activity;
              for (const key of Object.keys(summary)) delete summary[key];
              Object.assign(summary, { reference: record.reference, sequence: record.sequence, kind: record.kind, studentId: record.studentId, recordedAt: record.recordedAt, callId: record.callId, outputRef: record.outputRef, truncated: true, readHint: 'Read this journal reference with byteOffset and maxBytes to retrieve the complete record in text chunks.',
                ...(activity ? { activity: { callId: activity.callId, type: activity.type, status: activity.status, action: { name: activity.action?.name }, result: { outputRef: activity.result?.outputRef, outputBytes: activity.result?.outputBytes, truncated: true } } } : {}) });
            }
            const page = { ...evidence, records: [...records, summary], nextOffset: (args.offset ?? 0) + records.length + 1 < evidence.total ? (args.offset ?? 0) + records.length + 1 : null, truncated: true };
            if (Buffer.byteLength(JSON.stringify(page)) > this.maxOutputBytes) break;
            records.push(summary);
          }
          evidence = { ...evidence, records, nextOffset: (args.offset ?? 0) + records.length < evidence.total ? (args.offset ?? 0) + records.length : null, truncated: true };
          output = JSON.stringify(evidence);
        }
      }
      if (Buffer.byteLength(output) > this.maxOutputBytes) output = JSON.stringify({ truncated: true, error: 'Evidence page exceeds the tool output limit; use a smaller page or an output reference with byteOffset and maxBytes.' });
      return { name, output, truncated: evidence?.truncated === true };
    } else if (name === 'shell' || name === 'run_command') {
      if (!this.allowShell) throw new Error('Shell tool disabled; enable allowShell explicitly');
      if (name === 'run_command') {
        const executable = this.shellExecutables[args.shell];
        if (!executable) throw Object.assign(new Error('The requested command interpreter is unavailable'), { executionStatus: 'not_started' });
        // A fixed launcher reads the original UTF-8 script from stdin. Script
        // length and Windows argument quoting cannot alter its contents.
        const launcher = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; $reader=New-Object IO.StreamReader([Console]::OpenStandardInput(),[Text.Encoding]::UTF8); $script=$reader.ReadToEnd(); $global:LASTEXITCODE=0; try { & ([ScriptBlock]::Create($script)); $ok=$?; if($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0){exit $LASTEXITCODE}; if(-not $ok){exit 1} } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }";
        return this._shell(studentId, { command: executable, args: args.shell === 'powershell' ? encoded(launcher) : ['--noprofile', '--norc', '-s'], cwd: args.cwd }, signal, artifact, { name, shell: args.shell, input: args.command, activity, controlledTree: true });
      }
      return this._shell(studentId, args, signal, artifact, { name, activity });
    } else throw new Error(`Unknown tool: ${name}`);
    const buffer = Buffer.from(output);
    return { name, output: buffer.subarray(0, this.maxOutputBytes).toString('utf8'), truncated: buffer.length > this.maxOutputBytes };
  }
  async _shell(studentId, args, signal, artifact, { name = 'shell', shell, input, activity, controlledTree = false } = {}) {
    if (typeof args.command !== 'string' || !args.command || (args.args !== undefined && (!Array.isArray(args.args) || args.args.some(x => typeof x !== 'string')))) throw new Error('shell requires executable command and string args array');
    const cwd = await this._path(args.cwd); await this.checkpoint(signal);
    const env = childEnvironment();
    while (this.paused) await this.checkpoint(signal);
    signal.throwIfAborted();
    const child = spawn(args.command, args.args || [], { cwd, env, shell: false, detached: controlledTree && process.platform !== 'win32', windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const record = { child, studentId, suspended: false, controlledTree, members: [] }; this.children.add(record);
    let resolveIdentity, resolveSpawn, rejectSpawn;
    record.identityReady = new Promise(resolve => { resolveIdentity = resolve; });
    const spawnHandled = new Promise((resolve, reject) => { resolveSpawn = resolve; rejectSpawn = reject; }); spawnHandled.catch(() => {});
    child.once('spawn', async () => {
      const spawnedAt = new Date().toISOString();
      try {
        if (controlledTree && process.platform === 'win32') record.identity = await captureProcessIdentity(child);
        resolveIdentity();
        if (activity) await this._activity({ ...activity, type: 'spawned', status: 'running', executionStatus: 'started', pid: child.pid, shell, timestamp: spawnedAt });
        resolveSpawn();
      } catch (error) { resolveIdentity(); rejectSpawn(error); this._kill(record).catch(() => {}); }
    });
    let inputFailure;
    if (input !== undefined) {
      child.stdin.on('error', error => { inputFailure = error; });
      child.stdin.end(Buffer.from(input, 'utf8'), error => { if (error) inputFailure = error; });
    }
    let bytes = 0, truncated = false, chunks = [], spawnError;
    const captures = [child.stdout, child.stderr].map(async stream => {
      try {
        for await (const c of stream) {
          const keep = c.subarray(0, Math.max(0, this.maxOutputBytes - bytes));
          if (keep.length) chunks.push(keep);
          bytes += keep.length; if (keep.length < c.length) truncated = true;
          if (artifact) await artifact.write(c);
        }
      } catch (error) {
        await this._kill(record).catch(() => {});
        throw error;
      }
    });
    // Observe failures immediately, while still waiting for process cleanup.
    const captured = Promise.all(captures); captured.catch(() => {});
    record.closed = new Promise(resolve => {
      child.once('error', error => { spawnError = error; resolveIdentity(); resolveSpawn(); });
      child.once('close', (code, sig) => { this.children.delete(record); resolve({ code, sig }); });
    });
    let cancelledDuringExecution = false;
    const cancel = () => { if (child.exitCode === null && child.signalCode === null) cancelledDuringExecution = true; this._kill(record).catch(error => { record.killError = error; }); };
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    const { code, sig } = await record.closed; signal.removeEventListener('abort', cancel);
    let captureError;
    try { await captured; } catch (error) { captureError = error; }
    try { await spawnHandled; } catch (error) { if (error.fatalStorage || !captureError) captureError = error; }
    // A failed spawn can also close stdout/stderr prematurely (notably on Bun).
    // Drain both streams, then report the actual spawn error before its symptom.
    if (spawnError) { spawnError.executionStatus = child.pid ? 'unknown' : 'not_started'; throw spawnError; }
    if (captureError) { captureError.executionStatus = cancelledDuringExecution ? 'cancelled' : child.pid ? 'unknown' : 'not_started'; throw captureError; }
    if (inputFailure && inputFailure.code !== 'EPIPE') { inputFailure.executionStatus = cancelledDuringExecution ? 'cancelled' : child.pid ? 'unknown' : 'not_started'; throw inputFailure; }
    return { name, ...(shell ? { shell } : {}), output: Buffer.concat(chunks).toString('utf8'), truncated, exitCode: code, signal: sig, success: !cancelledDuringExecution && code === 0 && !sig, executionStatus: cancelledDuringExecution ? 'cancelled' : code === null ? 'unknown' : 'completed' };
  }
  async adoptProcess(child, studentId) {
    const record = { child, studentId, suspended: false, controlledTree: true, members: [] };
    this.children.add(record);
    let resolveClosed;
    record.closed = new Promise(resolve => { resolveClosed = resolve; });
    child.once('close', (code, signal) => { this.children.delete(record); resolveClosed({ code, signal }); });
    record.identityReady = (async () => {
      if (!child.pid) await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      if (process.platform === 'win32') record.identity = await captureProcessIdentity(child);
    })();
    try {
      await record.identityReady;
      if (this.stopped) { await this._kill(record); throw Error('Tools stopped'); }
      // A browser can finish spawning during an existing pause; join that pause
      // before permitting the first navigation or page action.
      if (this.paused) await this.pauseAll();
      return record;
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) await this._kill(record);
      throw error;
    }
  }
  _serialized(action) { const result = this.control.then(action); this.control = result.catch(() => {}); return result; }
  pauseAll() {
    if (this.stopped) return this.control;
    this.paused = true; this.pauseVersion++; this.events.emit('change');
    this.browserTools.pauseAll();
    return this._serialized(async () => {
      if (this.stopped) return;
      for (const record of this.children) if (!record.suspended) {
        if (record.controlledTree) {
          if (process.platform === 'win32') await controlProcessTree(record, 'pause');
          else if (record.child.exitCode === null && record.child.signalCode === null) process.kill(-record.child.pid, 'SIGSTOP');
        } else await suspendChild(record.child);
        record.suspended = true;
      }
    });
  }
  resumeAll() {
    const version = this.pauseVersion;
    return this._serialized(async () => {
      if (this.stopped) return;
      for (const record of this.children) if (record.suspended) {
        if (record.controlledTree) {
          if (process.platform === 'win32') await controlProcessTree(record, 'resume');
          else if (record.child.exitCode === null && record.child.signalCode === null) process.kill(-record.child.pid, 'SIGCONT');
        } else await suspendChild(record.child, true);
        record.suspended = false;
      }
      if (this.pauseVersion === version) { this.paused = false; this.browserTools.resumeAll(); this.events.emit('change'); }
    });
  }
  _kill(record) {
    if (!record.killing) record.killing = this._killChild(record).catch(error => { record.killing = null; throw error; });
    return record.killing;
  }
  async _killChild(record) {
    const child = record.child;
    if (!child.pid) return;
    if (record.controlledTree && process.platform === 'win32') {
      try { await record.identityReady; } catch { /* Failed identification still requires cleanup of this owned child. */ }
      if (record.identity) { await controlProcessTree(record, 'stop'); return; }
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      try { await runProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']); }
      catch (error) { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); throw error; } }
    } else if (record.controlledTree) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  }
  async stopAll() {
    this.stopped = true;
    this.controller.abort(new Error('Tools stopped'));
    this.events.emit('change');
    await this.control;
    const records = [...this.children];
    await Promise.all(records.map(async r => { await this._kill(r); await r.closed; }));
    await this.browserTools.stopAll();
    const settled = await Promise.allSettled([...this.activeExecutions]);
    const storageFailure = settled.find(result => result.status === 'rejected' && result.reason?.fatalStorage);
    if (storageFailure) throw storageFailure.reason;
  }
}
