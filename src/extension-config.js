import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { BUILTIN_SKILL_IDS, isBuiltinSkill } from './builtin-skills.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const PREFIX = 'extension:';
export const BUILTIN_MCP_TYPES = Object.freeze(['browser', 'burpsuite', 'tscan', 'jadx', 'x64dbg', 'ida', 'cyberchef', 'wireshark', 'windbg', 'ghidra', 'gdb', 'sagemath', 'pwntools', 'metasploit', 'bloodhound', 'zsteg', 'binwalk', 'aflpp']);
export const isBuiltinBrowserMcp = item => item?.builtin === 'browser';
export const isBuiltinMcp = item => BUILTIN_MCP_TYPES.includes(item?.builtin);
export const isLocalBrowserMcp = item => isBuiltinBrowserMcp(item) && item.transport === 'stdio' && item.command === 'Class' && item.args?.length === 1 && item.args[0] === '--browser-mcp';
export const isLocalAnalysisMcp = item => ['pwntools', 'zsteg', 'binwalk'].includes(item?.builtin) && item.transport === 'stdio' && item.command === 'Class' && item.args?.length === 2 && item.args[0] === '--local-analysis-mcp' && item.args[1] === item.builtin;
const credentialBinding = item => createHash('sha256').update(JSON.stringify(Object.fromEntries(['id','transport','command','args','cwd','url',...(item.skipTlsVerify ? ['skipTlsVerify'] : [])].filter(key => item[key] !== undefined).map(key => [key, item[key]])))).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
function text(value, label, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) invalid(`${label}格式无效`);
  return value;
}
function ids(value, label, validIds) {
  if (!Array.isArray(value) || value.length > 128 || value.some(id => typeof id !== 'string' || !ID.test(id) || validIds && !validIds.has(id))) invalid(`${label}包含无效项目`);
  return [...new Set(value)];
}
function entry(value, kind, validAgents) {
  if (!object(value)) invalid(`${kind}配置无效`);
  const id = value.id ?? randomUUID();
  if (typeof id !== 'string' || !ID.test(id)) invalid(`${kind} ID 无效`);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalid('启用状态必须是布尔值');
  return { id, name: text(value.name, `${kind}名称`, 100).trim(), enabled: value.enabled !== false, agentIds: ids(value.agentIds ?? [], 'Agent授权', validAgents) };
}
export function normalizeExtensions(value = {}, agents) {
  if (!object(value)) invalid('扩展配置无效');
  const validAgents = agents ? new Set(agents.filter(agent=>agent.role!=='principal').map(agent => agent.id)) : undefined;
  const mcps = value.mcps ?? [], skills = value.skills ?? [];
  if (!Array.isArray(mcps) || mcps.length > 64 + BUILTIN_MCP_TYPES.length || !Array.isArray(skills) || skills.length > 128 + BUILTIN_SKILL_IDS.length) invalid(`最多配置64个外部MCP、${BUILTIN_MCP_TYPES.length}个预置MCP、128个自建Skill和${BUILTIN_SKILL_IDS.length}个内置Skill`);
  const result = { revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0, mcps: [], skills: [] };
  for (let raw of mcps) {
    const item = entry(raw, 'MCP', validAgents);
    if (!['stdio', 'http', 'sse', 'builtin'].includes(raw.transport)) invalid('MCP连接类型无效');
    item.transport = raw.transport;
    if (raw.transport === 'builtin') {
      if (raw.builtin !== 'browser') invalid('内置MCP类型无效');
      if (['command', 'cwd', 'url'].some(key => raw[key] !== undefined && raw[key] !== '')
        || ['args', 'clearEnv', 'clearHeaders'].some(key => raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].length))
        || ['env', 'headers'].some(key => raw[key] !== undefined && (!object(raw[key]) || Object.keys(raw[key]).length))) invalid('内置browser不接受外部连接参数或凭据');
      raw = { ...raw, transport:'stdio', command:'Class', args:['--browser-mcp'] };
      item.transport = 'stdio';
    }
    if (raw.builtin !== undefined && !isBuiltinMcp(raw)) invalid('预置MCP类型无效');
    if (isBuiltinMcp(raw)) { item.builtin = raw.builtin; item.enabled = raw.enabled === true; }
    if (raw.skipTlsVerify !== undefined && typeof raw.skipTlsVerify !== 'boolean') invalid('跳过HTTPS校验必须是布尔值');
    if (raw.transport === 'stdio') {
      item.command = text(raw.command, '启动命令', 2048).trim();
      if (!Array.isArray(raw.args ?? []) || (raw.args ?? []).length > 128) invalid('MCP参数必须是数组');
      item.args = (raw.args ?? []).map(arg => text(arg, 'MCP参数', 4096, true));
      if (raw.cwd) { item.cwd = text(raw.cwd, 'MCP工作目录', 32768); if (!path.isAbsolute(item.cwd)) invalid('MCP工作目录必须是绝对路径'); }
    } else {
      item.url = text(raw.url, 'MCP地址', 8192).trim();
      let url; try { url = new URL(item.url); } catch { invalid('MCP地址必须是完整HTTP(S)地址'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) invalid('MCP地址必须使用HTTP(S)，且不能包含用户信息或片段');
      item.skipTlsVerify = raw.skipTlsVerify === true;
    }
    result.mcps.push(item);
  }
  if (new Set(result.mcps.map(item => item.id)).size !== result.mcps.length) invalid('MCP ID不能重复');
  for (const preset of BUILTIN_MCP_TYPES) if (result.mcps.filter(item => item.builtin === preset).length > 1) invalid(`只能配置一个预置${preset}`);
  if (result.mcps.filter(item => !isBuiltinMcp(item)).length > 64) invalid('最多配置64个外部MCP');
  for (const raw of skills) {
    const item = entry(raw, 'Skill', validAgents);
    if (raw.builtin !== undefined && !isBuiltinSkill(raw)) invalid('内置Skill类型无效');
    if (isBuiltinSkill(raw)) { item.builtin = raw.builtin; item.enabled = raw.enabled === true; }
    item.description = text(raw.description ?? '', 'Skill说明', 2000, true);
    item.content = text(raw.content, 'Skill正文', 128 * 1024);
    // Legacy MCP associations are ignored; skills and MCPs have independent grants.
    result.skills.push(item);
  }
  if (new Set(result.skills.map(item => item.id)).size !== result.skills.length) invalid('Skill ID不能重复');
  for (const preset of BUILTIN_SKILL_IDS) if (result.skills.filter(item => item.builtin === preset).length > 1) invalid(`只能配置一个内置Skill：${preset}`);
  if (result.skills.filter(item => !isBuiltinSkill(item)).length > 128) invalid('最多配置128个自建Skill');
  return result;
}
// Profile presets are separate from normalization: CLI and checkpoint callers
// must not acquire an extension merely by validating an otherwise empty config.
export function ensureBuiltinBrowserPreset(config) {
  if (config.mcps.some(isBuiltinBrowserMcp)) return config;
  const ids = new Set(config.mcps.map(item => item.id));
  let id = 'class-browser', suffix = 2;
  while (ids.has(id)) id = 'class-browser-' + suffix++;
  return { ...config, mcps: [...config.mcps, { id, name: 'browser', transport: 'stdio', builtin: 'browser', command:'Class', args:['--browser-mcp'], enabled: false, agentIds: [] }] };
}
export function ensureBuiltinMcpPresets(config, platform = process.platform) {
  let seeded = ensureBuiltinBrowserPreset(config);
  const presets = [
    { name: 'burpsuite', transport: 'sse', url: 'http://127.0.0.1:9876' },
    { name: 'tscan', transport: 'http', url: 'http://127.0.0.1:8088/mcp' },
    { name: 'jadx', transport: 'http', url: 'http://127.0.0.1:8651/mcp' },
  ];
  if (platform === 'win32') presets.push(
    { name: 'x64dbg', transport: 'http', url: 'http://127.0.0.1:9094/' },
    { name: 'ida', transport: 'http', url: 'http://127.0.0.1:8737/mcp' },
    // External dependencies are installed by the user; these commands only
    // start an installed MCP when an authorized member discovers its tools.
    { name: 'cyberchef', transport: 'stdio', command: 'cmd.exe', args: ['/d', '/s', '/c', 'cyberchef-mcp'] },
    { name: 'wireshark', transport: 'stdio', command: 'python', args: ['-m', 'wireshark_mcp', 'serve', '--transport', 'stdio', '--profile', 'analysis'] },
    { name: 'windbg', transport: 'stdio', command: 'python', args: ['-m', 'mcp_windbg', '--transport', 'stdio'] },
  );
  if (platform === 'linux') presets.push(
    { name: 'ghidra', transport: 'http', url: 'http://127.0.0.1:8081/mcp' },
    { name: 'gdb', transport: 'http', url: 'http://127.0.0.1:8000/mcp' },
    { name: 'wireshark', transport: 'stdio', command: 'wireshark-mcp', args: ['serve', '--transport', 'stdio', '--profile', 'analysis'] },
    { name: 'sagemath', displayName: 'sageMath', transport: 'stdio', command: 'sagemath-mcp', args: ['--transport', 'stdio'] },
    { name: 'pwntools', transport: 'stdio', command: 'Class', args: ['--local-analysis-mcp', 'pwntools'] },
    { name: 'metasploit', transport: 'http', url: 'http://127.0.0.1:3000/' },
    { name: 'bloodhound', transport: 'stdio', command: 'bloodhound-mcp', args: [] },
    { name: 'zsteg', transport: 'stdio', command: 'Class', args: ['--local-analysis-mcp', 'zsteg'] },
    { name: 'binwalk', transport: 'stdio', command: 'Class', args: ['--local-analysis-mcp', 'binwalk'] },
    { name: 'aflpp', displayName: 'AFL++', transport: 'stdio', command: 'aflpp-mcp', args: [] },
  );
  // Seed only missing entries. Moving a profile across operating systems must
  // preserve its saved endpoints, credentials and grants, including other presets.
  const ids = new Set(seeded.mcps.map(item => item.id));
  for (const { displayName, ...preset } of presets) {
    if (seeded.mcps.some(item => item.builtin === preset.name)) continue;
    const base = 'class-' + preset.name;
    let id = base, suffix = 2;
    while (ids.has(id)) id = base + '-' + suffix++;
    ids.add(id);
    seeded = { ...seeded, mcps: [...seeded.mcps, { id, ...preset, name: displayName || preset.name, builtin: preset.name, ...(preset.transport === 'stdio' ? {} : { skipTlsVerify: false }), enabled: false, agentIds: [] }] };
  }
  return seeded;
}
export function extensionSecrets(secrets = {}, config) {
  const result = Object.create(null);
  const builtins = new Set((config?.mcps ?? []).filter(item => item.transport === 'builtin').map(item => item.id));
  for (const [key, value] of Object.entries(secrets)) if (key.startsWith(PREFIX)) {
    if (builtins.has(key.slice(PREFIX.length))) continue;
    try {
      const parsed = JSON.parse(value);
      if (object(parsed) && object(parsed.env ?? {}) && object(parsed.headers ?? {})) result[key.slice(PREFIX.length)] = parsed;
    } catch { /* Invalid private values are not exposed or sent to servers. */ }
  }
  // Profile and encrypted credentials are separate atomic files. A process can
  // stop between publishing them: never send new credentials to an old endpoint.
  if (config) for (const item of config.mcps ?? []) {
    const privateValue = result[item.id];
    if (privateValue && item.enabled && item.agentIds?.length && privateValue.binding !== credentialBinding(item)) {
      throw Object.assign(new Error(`MCP“${item.name}”的凭据与连接配置不匹配，请在扩展管理中重新保存该配置`), { status: 409 });
    }
  }
  return result;
}
export function extensionSecretValues(secrets) {
  return Object.values(extensionSecrets(secrets)).flatMap(item => [...Object.values(item.env ?? {}), ...Object.values(item.headers ?? {})]).filter(value => typeof value === 'string' && value);
}
function mergePrivate(previous, incoming, clears, header = false) {
  if (incoming !== undefined && !object(incoming)) invalid('MCP环境变量和请求头必须是键值对象');
  if (clears !== undefined && (!Array.isArray(clears) || clears.some(key => typeof key !== 'string'))) invalid('清除密钥列表无效');
  const result = Object.assign(Object.create(null), previous);
  for (const key of clears ?? []) {
    if (header) for (const saved of Object.keys(result)) { if (saved.toLowerCase() === key.toLowerCase()) delete result[saved]; }
    else delete result[key];
  }
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid('MCP环境变量或请求头名称无效');
    if (!(header ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/ : /^[A-Za-z_][A-Za-z0-9_]{0,127}$/).test(key)) invalid('MCP环境变量或请求头名称无效');
    text(value, 'MCP密钥值', 8192, true);
    if (header && /[\r\n]/.test(value)) invalid('请求头不能包含换行');
    if (value) {
      if (header) for (const saved of Object.keys(result)) { if (saved.toLowerCase() === key.toLowerCase()) delete result[saved]; }
      result[key] = value; // Empty inputs keep the existing value.
    }
  }
  if (Object.keys(result).length > 64) invalid('MCP环境变量或请求头数量过多');
  return result;
}
export function prepareExtensionUpdate(body, current, agents, secrets) {
  if (!object(body)) invalid('扩展配置无效');
  const previous = normalizeExtensions(current);
  if (body.revision !== previous.revision) throw Object.assign(new Error('扩展配置已更新，请刷新后重试'), { status: 409 });
  const extensions = normalizeExtensions(body, agents);
  extensions.revision = previous.revision + 1;
  const savedSecrets = { ...secrets }, privateValues = extensionSecrets(secrets);
  const existing = new Set(previous.mcps.map(item => item.id));
  for (let index = 0; index < extensions.mcps.length; index++) {
    const item = extensions.mcps[index], raw = body.mcps[index], prior = privateValues[item.id] ?? {};
    const next = { env: mergePrivate(prior.env, raw.env, raw.clearEnv), headers: mergePrivate(prior.headers, raw.headers, raw.clearHeaders, true), binding: credentialBinding(item) };
    const serialized = JSON.stringify(next);
    if (serialized.length > 16000) invalid('单个MCP的加密配置过大');
    if (Object.keys(next.env).length || Object.keys(next.headers).length) savedSecrets[PREFIX + item.id] = serialized;
    else delete savedSecrets[PREFIX + item.id];
    existing.delete(item.id);
  }
  for (const id of existing) delete savedSecrets[PREFIX + id];
  return { extensions, secrets: savedSecrets };
}
// Enforce catalogue ownership at the editable API boundary. Low-level import
// helpers also serve CLI fixtures and migrations that deliberately omit presets.
export function assertBuiltinExtensionsPreserved(previous, next) {
  for (const kind of ['mcps', 'skills']) {
    const isBuiltin = kind === 'mcps' ? isBuiltinMcp : isBuiltinSkill;
    for (const prior of previous[kind].filter(isBuiltin)) {
      const item = next[kind].find(item => item.id === prior.id);
      if (!item || item.builtin !== prior.builtin) invalid('内置MCP和Skill不能删除或改为自建项目');
    }
    for (const item of next[kind].filter(isBuiltin)) {
      if (!previous[kind].some(prior => prior.id === item.id && prior.builtin === item.builtin)) invalid('不能自行添加或替换内置项目');
    }
  }
}
export function prepareExtensionDeletion(body, current, agents, secrets) {
  if (!object(body) || Object.keys(body).some(key => !['revision','kind','ids'].includes(key)) || !['mcps','skills'].includes(body.kind)
    || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 256 || body.ids.some(id => typeof id !== 'string' || !ID.test(id))) invalid('请选择要删除的MCP或Skill');
  const previous = normalizeExtensions(current);
  if (body.revision !== previous.revision) throw Object.assign(new Error('扩展配置已更新，请刷新后重试'), { status: 409 });
  const selected = new Set(body.ids), items = previous[body.kind];
  if ([...selected].some(id => !items.some(item => item.id === id))) throw Object.assign(new Error('所选扩展已变化，请刷新后重试'), { status: 409 });
  if (items.some(item => selected.has(item.id) && (body.kind === 'mcps' ? isBuiltinMcp(item) : isBuiltinSkill(item)))) invalid('内置MCP和Skill不能删除');
  return prepareExtensionUpdate({ ...previous, [body.kind]: items.filter(item => !selected.has(item.id)) }, previous, agents, secrets);
}
export function publicExtensions(config, secrets, agents) {
  const result = normalizeExtensions(config), values = extensionSecrets(secrets);
  return { ...result, platform: process.platform, mcps: result.mcps.map(item => ({ ...item, envKeys: Object.keys(values[item.id]?.env ?? {}), headerKeys: Object.keys(values[item.id]?.headers ?? {}) })), agents: agents.filter(agent=>agent.role!=='principal').map(({ id, name, role }) => ({ id, name, role })) };
}
