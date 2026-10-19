import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Recipes are source-controlled, never inferred from a model response or an MCP
// error. The caller owns every child process through run(), including cleanup.
const locks = new Map();
const RECIPES = Object.freeze({
  wireshark: { package: 'wireshark-mcp', version: '3.1.0', module: 'wireshark_mcp', args: ['serve', '--transport', 'stdio', '--profile', 'analysis'] },
  windbg: { package: 'mcp-windbg', version: '1.5.1', module: 'mcp_windbg', args: ['--transport', 'stdio'] },
});
const MARKER = '.class-mcp-runtime.json';
const MARKER_VALUE = 'class-mcp-runtime-v1';
// Official astral-sh/uv release asset digests, pinned independently of downloads.
// https://github.com/astral-sh/uv/releases/tag/0.9.5
const UV = Object.freeze({
  win32: { archive: 'uv-x86_64-pc-windows-msvc.zip', entry: 'uv.exe', sha256: '515dc53d7553f1357d0abc1f70acd921fbb9e30230b1d9a08737236daa6ee920' },
  linux: { archive: 'uv-x86_64-unknown-linux-gnu.tar.gz', entry: 'uv-x86_64-unknown-linux-gnu/uv', sha256: '2cf10babba653310606f8b49876cfb679928669e7ddaa1fb41fb00ce73e64f66' },
});
const digest = value => createHash('sha256').update(value).digest('hex');
const known = new Set(['browser', 'burpsuite', 'tscan', 'jadx', 'x64dbg', 'ida', 'cyberchef', 'wireshark', 'windbg', 'ghidra', 'gdb', 'sagemath', 'pwntools', 'metasploit', 'bloodhound', 'zsteg', 'binwalk', 'aflpp']);
const result = (status, message, extra = {}) => ({ status, message, ...extra });
const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
const aborted = signal => signal?.throwIfAborted();
const cancelled = () => Object.assign(new Error('MCP环境准备已取消或超时'), { name: 'AbortError' });
const manual = message => Object.assign(new Error(message), { code: 'MCP_PREPARATION_MANUAL' });

async function wait(promise, signal) {
  aborted(signal);
  if (!signal) return promise;
  let listener;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { listener = () => reject(cancelled()); signal.addEventListener('abort', listener, { once: true }); })]);
  } finally { signal.removeEventListener('abort', listener); }
}

async function locked(key, signal, action) {
  const prior = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = prior.catch(() => {}).then(() => gate);
  locks.set(key, tail);
  try { await wait(prior.catch(() => {}), signal); aborted(signal); return await action(); }
  finally { release(); if (locks.get(key) === tail) tail.finally(() => { if (locks.get(key) === tail) locks.delete(key); }); }
}

async function regularFile(filename, platform) {
  try {
    if (!(await fs.stat(filename)).isFile()) return false;
    if (platform !== 'win32') await fs.access(filename, 1);
    return true;
  } catch { return false; }
}

// Searches PATH and a short explicit installation-location list; never walks a
// user's disk, launches a GUI, changes PATH, or invokes a shell for discovery.
async function findExecutable(names, candidates, { platform, env }) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const directories = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(p => pathApi.isAbsolute(p));
  const suffixes = platform === 'win32' ? ['', '.exe'] : [''];
  for (const candidate of candidates.filter(Boolean)) if (pathApi.isAbsolute(candidate) && await regularFile(candidate, platform)) return candidate;
  for (const name of names) for (const dir of directories) for (const suffix of suffixes) {
    const candidate = pathApi.join(dir, name + (name.toLowerCase().endsWith('.exe') ? '' : suffix));
    if (await regularFile(candidate, platform)) return candidate;
  }
  return null;
}

function installEnvironment(env, root, platform) {
  const clean = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (typeof env[key] === 'string') clean[key] = env[key];
  return { ...clean, TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'), PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', PIP_CONFIG_FILE: platform === 'win32' ? 'NUL' : '/dev/null', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PIP_CACHE_DIR: path.join(root, 'pip-cache'), UV_NO_CONFIG: '1', UV_CACHE_DIR: path.join(root, 'uv-cache'), UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_PYTHON_BIN_DIR: path.join(root, 'python-bin') };
}

async function directory(filename) {
  await fs.mkdir(filename, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(filename);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('MCP缓存目录不是独立目录');
  // A junction in an ancestor must not redirect an owned installation elsewhere.
  const actual = path.resolve(await fs.realpath(filename)), expected = path.resolve(filename);
  if ((process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) throw new Error('MCP缓存目录不能经过符号链接');
}

async function ownedCache(root) {
  await directory(root);
  const marker = path.join(root, MARKER);
  try {
    const info = await fs.lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || JSON.parse(await fs.readFile(marker, 'utf8')).owner !== MARKER_VALUE) throw new Error('MCP缓存目录归属不匹配');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await fs.readdir(root)).length) throw new Error('MCP缓存目录已存在其他内容');
    await fs.writeFile(marker, JSON.stringify({ owner: MARKER_VALUE, version: 1 }), { flag: 'wx', mode: 0o600 });
  }
  await directory(path.join(root, 'tmp'));
}

async function installationLock(root) {
  const filename = path.join(root, '.installation-lock.json'), token = randomUUID();
  let handle;
  try { handle = await fs.open(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Never infer ownership or delete an old lock solely from age/PID: another
    // process may be alive, a PID reused, or a prior writer interrupted. Normal
    // completion removes its own token. Crash leftovers require explicit repair.
    throw manual('MCP缓存正被其他Class进程使用，或上次准备异常中断；请等待其结束。若仍失败，确认其他Class进程均已退出后再清理mcp-runtimes中的.installation-lock.json');
  }
  try { await handle.writeFile(JSON.stringify({ owner: MARKER_VALUE, pid: process.pid, token, createdAt: new Date().toISOString() })); }
  catch (error) { await handle.close(); throw error; }
  await handle.close();
  return async () => {
    const info = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info?.isFile() || info.isSymbolicLink()) return;
    let current; try { current = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { return; }
    if (current.owner === MARKER_VALUE && current.token === token && current.pid === process.pid) await fs.unlink(filename);
  };
}

function defaultRecipe(server, platform) {
  const recipe = RECIPES[server.builtin];
  if (!recipe || server.transport !== 'stdio' || server.cwd || platform === 'linux' && server.builtin === 'windbg') return null;
  const pythonDefault = ['python', 'python3', 'python.exe', 'python3.exe'].includes(server.command) && same(server.args, ['-m', recipe.module, ...recipe.args]);
  const consoleDefault = server.builtin === 'wireshark' && server.command === 'wireshark-mcp' && same(server.args, recipe.args);
  return pythonDefault || consoleDefault ? recipe : null;
}

/**
 * prepare() is opt-in and should run only for a selected, authorized MCP after a
 * failed connection. It never persists a profile update or reports connectivity.
 * run(command, args, {env,cwd,signal,timeoutMs}) must supervise/stop its own process
 * tree and return {exitCode,stdout,stderr}. probe is a read-only test seam.
 */
export function createMcpPreparer({ cacheDir, platform = process.platform, arch = process.arch, env = process.env, run, probe, fetchImpl = globalThis.fetch, startTimer } = {}) {
  const root = path.resolve(cacheDir || path.join(os.homedir(), '.local', 'share', 'class', 'mcp-runtime-v1'));
  const locate = (names, candidates = []) => probe ? probe(names, candidates) : findExecutable(names, candidates, { platform, env });
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const pf = env.ProgramFiles || 'C:\\Program Files', pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA;

  async function bootstrapUv(invoke, signal) {
    const asset = arch === 'x64' && UV[platform];
    if (!asset) return null;
    const tar = await locate(['tar'], platform === 'win32' && env.SystemRoot ? [join(env.SystemRoot, 'System32', 'tar.exe')] : []);
    if (!tar) return null;
    const folder = path.join(root, 'uv-0.9.5'), binary = path.join(folder, ...asset.entry.split('/'));
    await directory(folder);
    const receiptFile = path.join(folder, 'receipt.json');
    try {
      const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
      if (receipt.archive === asset.sha256 && !((await fs.lstat(binary)).isSymbolicLink()) && receipt.binary === digest(await fs.readFile(binary))) return binary;
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    const response = await fetchImpl(`https://github.com/astral-sh/uv/releases/download/0.9.5/${asset.archive}`, { signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error('下载uv运行环境失败');
    const length = Number(response.headers?.get('content-length') || 0), maxBytes = 32 * 1024 * 1024;
    if (length > maxBytes) { await response.body.cancel(); throw new Error('uv下载超过上限'); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        aborted(signal);
        const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > maxBytes) throw new Error('uv下载超过上限');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const data = Buffer.concat(chunks);
    if (digest(data) !== asset.sha256) throw new Error('uv下载摘要不匹配');
    const archive = path.join(folder, asset.archive);
    const info = await fs.lstat(archive).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error('uv归档路径不是独立文件');
    await fs.writeFile(archive, data, { mode: 0o600 });
    // Only this exact file from the verified archive can be extracted. No shell
    // command is assembled and no publisher install script is executed.
    const targetDirectory = path.dirname(binary);
    await directory(targetDirectory);
    const oldBinary = await fs.lstat(binary).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (oldBinary?.isSymbolicLink()) throw new Error('uv可执行路径不是独立文件');
    await invoke(tar, ['-xf', archive, '-C', folder, '--', asset.entry], 30000);
    if (!(await fs.lstat(binary)).isFile()) throw new Error('uv归档中缺少可执行文件');
    if (platform !== 'win32') await fs.chmod(binary, 0o700);
    await fs.writeFile(receiptFile, JSON.stringify({ archive: asset.sha256, binary: digest(await fs.readFile(binary)) }), { mode: 0o600 });
    return binary;
  }

  async function installed(kind, secret) {
    const hints = secret?.env || {};
    if (kind === 'wireshark') return locate(['tshark'], [hints.WIRESHARK_MCP_TSHARK_PATH, ...(platform === 'win32' ? [join(pf, 'Wireshark', 'tshark.exe'), join(pf86, 'Wireshark', 'tshark.exe')] : ['/usr/bin/tshark', '/usr/local/bin/tshark'])]);
    if (kind === 'windbg') return locate(['cdb'], [join(pf86, 'Windows Kits', '10', 'Debuggers', 'x64', 'cdb.exe'), join(pf, 'Windows Kits', '10', 'Debuggers', 'x64', 'cdb.exe'), join(pf, 'Windows Kits', '8.1', 'Debuggers', 'x64', 'cdb.exe')]);
    if (kind === 'browser') return locate(platform === 'win32' ? ['msedge', 'chrome', 'firefox'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'firefox'], [hints.CLASS_BROWSER_EXECUTABLE, env.CLASS_BROWSER_EXECUTABLE, ...(platform === 'win32' ? [join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf, 'Mozilla Firefox', 'firefox.exe')] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/firefox', '/snap/bin/firefox'])]);
    if (kind === 'burpsuite') return locate(['burpsuite', 'BurpSuitePro', 'BurpSuiteCommunity', 'BurpSuiteProfessional'], platform === 'win32' ? [join(pf, 'BurpSuitePro', 'BurpSuitePro.exe'), local && join(local, 'Programs', 'BurpSuitePro', 'BurpSuitePro.exe'), join(pf, 'BurpSuiteCommunity', 'BurpSuiteCommunity.exe')] : ['/opt/BurpSuitePro/BurpSuitePro', '/opt/BurpSuiteCommunity/BurpSuiteCommunity', '/usr/bin/burpsuite']);
    if (kind === 'tscan') return locate(['TscanPlus', 'TscanPlus_Win_Amd64', 'TscanPlus_Linux_Amd64', 'tscan'], []);
    return null;
  }

  async function recipePrepare(server, recipe, executable, secret, signal, timeoutMs) {
    if (typeof run !== 'function') return result('manual', 'MCP依赖准备尚未配置进程管理器，请按配置指南安装依赖');
    return locked(root, signal, async () => {
      await ownedCache(root);
      aborted(signal);
      const unlock = await installationLock(root);
      try {
      const installEnv = installEnvironment(env, root, platform);
      const invoke = async (command, args, limit = timeoutMs) => {
        aborted(signal);
        const value = await run(command, args, { env: installEnv, cwd: root, signal, timeoutMs: Math.min(timeoutMs, limit) });
        aborted(signal);
        if ((value?.exitCode ?? value?.code ?? 0) !== 0) throw new Error('受控MCP环境命令执行失败');
        return String(value?.stdout ?? value?.output ?? '');
      };
      const folder = path.join(root, `${server.builtin}-${recipe.version}-${platform}-${arch}`);
      await directory(folder);
      const pointer = path.join(folder, 'environment.json');
      let environmentName = 'venv';
      try {
        const pointerInfo = await fs.lstat(pointer);
        if (!pointerInfo.isFile() || pointerInfo.isSymbolicLink()) throw new Error('MCP环境记录不是独立文件');
        const saved = JSON.parse(await fs.readFile(pointer, 'utf8'));
        if (saved.owner !== MARKER_VALUE || !/^venv(?:-[a-f0-9-]{36})?$/.test(saved.directory)) throw new Error('MCP环境记录无效');
        environmentName = saved.directory;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let venv = path.join(folder, environmentName);
      const pythonAt = location => path.join(location, platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'python.exe' : 'python');
      let python = pythonAt(venv);
      const priorVenv = await fs.lstat(venv).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (priorVenv) await directory(venv);
      const verifyScript = `import importlib.metadata, importlib.util; assert importlib.metadata.version(${JSON.stringify(recipe.package)}) == ${JSON.stringify(recipe.version)}; assert importlib.util.find_spec(${JSON.stringify(recipe.module)}) is not None`;
      let ready = false, usableVenv = false;
      if (await regularFile(python, platform)) {
        try { await invoke(python, ['-I', '-c', verifyScript], 10000); ready = true; } catch (error) { aborted(signal); }
        if (!ready) {
          try { await invoke(python, ['-I', '-c', 'import sys; assert sys.version_info >= (3, 10)'], 10000); usableVenv = true; } catch (error) { aborted(signal); }
        }
      }
      if (!ready) {
        // A cancelled package download leaves a usable venv; do not recreate it.
        // A partial/broken interpreter is preserved and replaced by a new owned
        // attempt, so uv never receives a nonempty destination or mixes runtimes.
        if (!usableVenv && priorVenv) {
          environmentName = 'venv-' + randomUUID(); venv = path.join(folder, environmentName); python = pythonAt(venv);
        }
        let uv = await locate(['uv']), systemPython;
        if (!uv) {
          const candidates = platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
          for (const name of candidates) {
            const found = await locate([name]);
            if (!found || found.includes('WindowsApps')) continue;
            try { await invoke(found, ['-I', '-c', 'import sys; assert sys.version_info >= (3, 10)'], 10000); systemPython = found; break; } catch (error) { aborted(signal); }
          }
          if (!systemPython) uv = await bootstrapUv(invoke, signal);
        }
        if (uv) {
          if (!usableVenv) await invoke(uv, ['--no-config', 'venv', '--python', '3.12', '--python-preference', 'managed', venv]);
          await invoke(uv, ['--no-config', 'pip', 'install', '--python', python, '--index-url', 'https://pypi.org/simple', '--only-binary', ':all:', `${recipe.package}==${recipe.version}`]);
        } else {
          if (!systemPython) return result('manual', '工具已安装，但无法自动准备Python环境；请按配置指南安装Python3.10+或uv后重试');
          if (!usableVenv) await invoke(systemPython, ['-I', '-m', 'venv', venv]);
          await invoke(python, ['-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-input', '--index-url', 'https://pypi.org/simple', '--only-binary=:all:', `${recipe.package}==${recipe.version}`]);
        }
        await invoke(python, ['-I', '-c', verifyScript], 10000);
      }
      const nextPointer = path.join(folder, 'environment-' + randomUUID() + '.json');
      await fs.writeFile(nextPointer, JSON.stringify({ owner: MARKER_VALUE, directory: environmentName }), { flag: 'wx', mode: 0o600 });
      await fs.rename(nextPointer, pointer);
      const nextSecret = { ...secret, env: { ...secret?.env }, headers: { ...secret?.headers } };
      const args = ['-m', recipe.module, ...recipe.args];
      if (server.builtin === 'wireshark') nextSecret.env.WIRESHARK_MCP_TSHARK_PATH = executable;
      else args.push('--cdb-path', executable);
      return result('prepared', ready ? '已找到Class管理的MCP运行环境，正在重新连接' : '已补齐MCP运行依赖，正在重新连接', { server: { ...server, command: python, args }, secret: nextSecret });
      } finally { await unlock(); }
    });
  }

  return {
    async prepare(server, { signal, secret = {}, timeoutMs = 120000 } = {}) {
      if (!server || !known.has(server.builtin)) return result('manual', '自定义MCP不自动安装依赖，请按其配置要求准备环境');
      if (signal?.aborted) return result('cancelled', 'MCP环境准备已取消或超时');
      const timeout = Math.max(1, Math.min(Number.isFinite(timeoutMs) ? timeoutMs : 120000, 300000));
      const controller = new AbortController();
      const cleanupTimer = typeof startTimer === 'function'
        ? startTimer(timeout, () => controller.abort())
        : (() => { const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.(); return () => clearTimeout(timer); })();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const active = controller.signal, recipe = defaultRecipe(server, platform);
        if (RECIPES[server.builtin] && !recipe) return result('manual', '该MCP使用自定义启动配置，保留原配置；请按配置指南检查依赖');
        if (recipe) {
          const executable = await wait(installed(server.builtin, secret), active);
          if (!executable) return result('missing-tool', server.builtin === 'wireshark' ? '未检测到TShark，已跳过；如已安装，请在MCP环境变量中配置WIRESHARK_MCP_TSHARK_PATH' : '未检测到WinDbg的cdb.exe，已跳过；请按配置指南安装调试工具或配置其路径');
          return await recipePrepare(server, recipe, executable, secret, active, timeout);
        }
        if (server.builtin === 'browser') {
          if (server.transport !== 'stdio' || server.command !== 'Class' || !same(server.args, ['--browser-mcp'])) return result('manual', 'browser使用自定义配置，请检查原有连接设置');
          if (!await wait(installed('browser', secret), active)) return result('missing-tool', '未检测到可用浏览器，已跳过；Class不会自动安装浏览器');
          return result('unchanged', '已检测到浏览器；内置browser不需要额外MCP依赖，请检查浏览器版本和启动权限');
        }
        if (['burpsuite', 'tscan'].includes(server.builtin)) {
          const expected = server.builtin === 'burpsuite' ? { transport: 'sse', url: 'http://127.0.0.1:9876' } : { transport: 'http', url: 'http://127.0.0.1:8088/mcp' };
          if (server.transport !== expected.transport || server.url?.replace(/\/$/, '') !== expected.url) return result('manual', '该MCP使用自定义服务地址，请检查该地址及其服务状态；不会修改本地环境');
          const present = await wait(installed(server.builtin, secret), active);
          return result(present ? 'manual' : 'missing-tool', server.builtin === 'burpsuite' ? (present ? '已检测到Burp Suite，请在MCP插件中启用服务；Class不会修改Burp插件或配置' : '未在常用位置检测到Burp Suite，已跳过；如已安装，请启动其MCP插件后重试') : (present ? '已检测到TscanPlus，请在AI辅助的MCP服务配置中启动服务' : '未在PATH中检测到TscanPlus，已跳过；如已安装，请手动启动其MCP服务后重试'));
        }
        return result('manual', '此MCP需要按配置指南启动工具或配置插件；保留原有环境，已跳过自动安装');
      } catch (error) {
        if (controller.signal.aborted || error.name === 'AbortError') return result('cancelled', 'MCP环境准备已取消或超时');
        if (error.code === 'MCP_PREPARATION_MANUAL') return result('manual', error.message);
        // Installer output can include proxy credentials; never forward it.
        return result('failed', 'MCP运行环境未准备成功，请检查网络、缓存目录权限及配置指南；原配置未更改');
      } finally { cleanupTimer?.(); signal?.removeEventListener('abort', onAbort); }
    },
  };
}
