import { normalizeExtensions, isLocalBrowserMcp, isLocalAnalysisMcp } from './extension-config.js';
import { getBuiltinSkillMetadata } from './builtin-skills.js';
import { normalizeTaskMode, normalizeTaskModeDefinition } from './task-mode.js';

const preset = (mcps, skills) => Object.freeze({ mcps: Object.freeze(mcps), skills: Object.freeze(skills) });
const ctfCommonMcps = Object.freeze(['browser', 'burpsuite', 'wireshark', 'jadx']);
const ctfPlatformMcps = Object.freeze({
  win32: Object.freeze(['cyberchef', 'ida', 'x64dbg']),
  linux: Object.freeze(['ghidra', 'gdb', 'sagemath', 'pwntools', 'zsteg', 'binwalk']),
});
const binaryPlatformMcps = Object.freeze({
  win32: Object.freeze(['ida', 'x64dbg', 'windbg', 'cyberchef']),
  linux: Object.freeze(['ghidra', 'gdb', 'pwntools', 'aflpp', 'binwalk']),
});
const pentestPlatformMcps = Object.freeze({
  win32: Object.freeze([]),
  linux: Object.freeze(['metasploit', 'bloodhound']),
});
const platformModeMcps = Object.freeze({ ctf_solve: ctfPlatformMcps, binary_audit: binaryPlatformMcps, pentest: pentestPlatformMcps });
export const MODE_EXTENSION_PRESETS = Object.freeze({
  auto: preset([], []),
  web_pentest: preset(['browser', 'burpsuite', 'tscan'], [
    'ctf-web',
    'performing-web-application-penetration-test',
    'conducting-api-security-testing',
    'testing-for-broken-access-control',
    'testing-for-business-logic-vulnerabilities',
    'testing-for-xss-vulnerabilities-with-burpsuite',
    'scanning-network-with-nmap-advanced',
    'implementing-attack-surface-management',
  ]),
  ctf_solve: preset([...ctfCommonMcps, ...ctfPlatformMcps.win32, ...ctfPlatformMcps.linux], [
    'solve-challenge', 'ctf-web', 'ctf-pwn', 'ctf-reverse', 'ctf-crypto',
    'ctf-forensics', 'ctf-misc', 'ctf-osint', 'ctf-malware', 'ctf-ai-ml', 'ctf-writeup',
  ]),
  binary_audit: preset(['wireshark', ...binaryPlatformMcps.win32, ...binaryPlatformMcps.linux], [
    'performing-binary-exploitation-analysis', 'ctf-reverse', 'ctf-pwn',
    'reverse-engineering-malware-with-ghidra', 'analyzing-linux-elf-malware',
    'performing-fuzzing-with-aflplusplus', 'performing-firmware-extraction-with-binwalk',
    'analyzing-network-traffic-with-wireshark', 'analyzing-memory-dumps-with-volatility',
    'reverse-engineering-android-malware-with-jadx', 'reverse-engineering-dotnet-malware-with-dnspy',
  ]),
  pentest: preset(['browser', 'burpsuite', 'tscan', 'wireshark', ...pentestPlatformMcps.linux], [
    'scanning-network-with-nmap-advanced', 'implementing-attack-surface-management',
    'performing-web-application-penetration-test', 'conducting-api-security-testing',
    'testing-for-broken-access-control', 'testing-for-business-logic-vulnerabilities',
    'testing-for-xss-vulnerabilities-with-burpsuite', 'analyzing-network-traffic-with-wireshark',
    'mapping-attack-paths-with-bloodhound-ce',
  ]),
});

// Profiles moved between operating systems retain their saved entries. Only
// the current host's mode defaults are enabled; explicit user choices stay intact.
export function getModeExtensionPreset(mode, platform = process.platform) {
  mode = normalizeTaskMode(mode);
  const selected = MODE_EXTENSION_PRESETS[mode], byPlatform = platformModeMcps[mode];
  if (!byPlatform) return selected;
  const platformOnly = new Set(Object.values(byPlatform).flat());
  return preset(selected.mcps.filter(id => !platformOnly.has(id) || (byPlatform[platform] ?? []).includes(id)), selected.skills);
}

// Build a task-local snapshot, never a profile update. In particular this must
// not seed catalogue entries into a deliberately minimal CLI configuration.
// Existing explicit grants stay intact, even when only part of that team was
// selected for the task. Empty grants are filled only by an explicit caller
// policy, and only for this mode's selected extensions. Missing extension IDs
// are ignored: a saved mode never resurrects deleted tools or credentials.
export function buildModeExtensions(config = {}, { taskMode = 'auto', taskModeDefinition, agents = [], grantModeDefaults = false, platform = process.platform } = {}) {
  const mode = normalizeTaskMode(taskMode), custom = normalizeTaskModeDefinition(mode, taskModeDefinition);
  const selected = custom ?? getModeExtensionPreset(mode, platform);
  const result = normalizeExtensions(config);
  const team = [...new Set(agents.filter(agent => agent?.role === 'teacher' || agent?.role === 'student').map(agent => agent.id))];
  for (const kind of ['mcps', 'skills']) {
    const selectedIds = new Set(selected[kind]);
    result[kind] = result[kind].map(item => !selectedIds.has(custom ? item.id : item.builtin) ? item : {
      ...item,
      enabled: true,
      agentIds: grantModeDefaults === true && item.agentIds.length === 0 ? [...team] : item.agentIds,
    });
  }
  return result;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sortedEntries = value => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));

function privateValues(secrets, id) {
  let raw = secrets?.[id];
  if (raw === undefined && Object.hasOwn(secrets || {}, 'extension:' + id)) {
    try { raw = JSON.parse(secrets['extension:' + id]); }
    catch { return undefined; }
  }
  if (raw === undefined) raw = {};
  if (!object(raw) || !object(raw.env ?? {}) || !object(raw.headers ?? {})) return undefined;
  const env = raw.env ?? {}, headers = raw.headers ?? {};
  if ([...Object.values(env), ...Object.values(headers)].some(value => typeof value !== 'string')) return undefined;
  const lowerHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    // Ambiguous duplicate header casing must never cause two connections to
    // collapse into one; their effective handling depends on the transport.
    if (Object.hasOwn(lowerHeaders, lower)) return undefined;
    Object.defineProperty(lowerHeaders, lower, { value, enumerable: true });
  }
  return { env: sortedEntries(env), headers: sortedEntries(lowerHeaders) };
}

function mcpIdentity(item, secrets) {
  const values = privateValues(secrets, item.id);
  if (!values) return undefined;
  const transport = item.transport === 'builtin' && item.builtin === 'browser' ? 'builtin-browser' : item.transport;
  if (!['http', 'sse', 'stdio', 'builtin-browser'].includes(transport)) return undefined;
  let endpoint;
  if (transport === 'http' || transport === 'sse') {
    let url; try { url = new URL(item.url); } catch { return undefined; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return undefined;
    endpoint = { url: url.href, skipTlsVerify: item.skipTlsVerify === true };
  } else if (transport === 'stdio') {
    if (typeof item.command !== 'string' || !Array.isArray(item.args ?? []) || (item.args ?? []).some(value => typeof value !== 'string')) return undefined;
    // The Class adapters resolve to the current executable and inherit scoped
    // environment variables. A custom command with the same visible spelling
    // need not launch the same process or have those inherited variables.
    const adapter = isLocalBrowserMcp(item) ? 'browser'
      : isLocalAnalysisMcp(item) ? item.builtin
      : item.builtin === 'windbg' && process.platform === 'win32' ? 'windbg' : '';
    endpoint = { command: item.command.trim(), args: item.args ?? [], cwd: item.cwd ?? '', adapter };
  } else endpoint = {};
  return { transport, endpoint, values };
}

function skillIdentity(item) {
  if (typeof item.content !== 'string') return undefined;
  if (item.builtin !== undefined) {
    const resource = getBuiltinSkillMetadata(item.builtin);
    if (!resource) return undefined;
    return { content: item.content, resource: { id: resource.id, source: resource.source, commit: resource.commit, files: resource.files } };
  }
  return { content: item.content, resource: null };
}

// This is deliberately stricter than similarity or name matching. Jev can
// recommend a capability, but only these exact groups are safe to coalesce.
// Returned values contain public IDs only, never connection credentials.
export function exactDuplicateGroups(config = {}, { secrets = {}, agentId } = {}) {
  const result = { mcps: [], skills: [] };
  if (agentId !== undefined && (typeof agentId !== 'string' || !agentId)) return result;
  for (const kind of ['mcps', 'skills']) {
    const groups = new Map();
    for (const item of config[kind] ?? []) {
      if (!item || item.enabled !== true || !Array.isArray(item.agentIds) || !item.agentIds.length
        || typeof item.id !== 'string' || (agentId !== undefined && !item.agentIds.includes(agentId))) continue;
      const identity = kind === 'mcps' ? mcpIdentity(item, secrets) : skillIdentity(item);
      if (!identity) continue;
      const grants = agentId === undefined ? [...new Set(item.agentIds)].sort() : [agentId];
      const key = JSON.stringify({ identity, grants });
      const ids = groups.get(key) || [];
      if (!ids.includes(item.id)) ids.push(item.id);
      groups.set(key, ids);
    }
    result[kind] = [...groups.values()].filter(ids => ids.length > 1).map(ids => ({ primaryId: ids[0], duplicateIds: ids.slice(1), ids }));
  }
  return result;
}
