import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createClassServer } from '../src/web-server.js';
import { createProfileStore } from '../src/profile-store.js';
import { loadSecrets } from '../src/secret-store.js';
import { prepareExtensionUpdate, normalizeExtensions, publicExtensions, extensionSecrets, ensureBuiltinBrowserPreset, ensureBuiltinMcpPresets, isBuiltinBrowserMcp, isBuiltinMcp, BUILTIN_MCP_TYPES } from '../src/extension-config.js';
import { loadCLIExtensions } from '../src/cli-extensions.js';
const agents = [{ id: 'teacher', role: 'teacher', name: '老师' }, { id: 'alice', role: 'student', name: '学生' }];
const draft = () => ({ revision: 0, mcps: [{ id: 'one', name: 'Local', enabled: true, transport: 'stdio', command: 'unused-fixture', args: [], agentIds: ['alice'], env: { TEST_KEY: 'test-private-token' } }], skills: [{ id: 'skill', name: 'Guide', content: '# Read the authorized evidence', agentIds: ['teacher'], mcpIds: ['one'] }] });
const platformKinds = platform => ['browser', 'burpsuite', 'tscan', 'jadx', ...(platform === 'win32' ? ['x64dbg', 'ida', 'cyberchef', 'wireshark', 'windbg'] : platform === 'linux' ? ['ghidra', 'gdb', 'wireshark', 'sagemath', 'pwntools', 'metasploit', 'bloodhound', 'zsteg', 'binwalk', 'aflpp'] : [])];
const currentPresetCount = platformKinds(process.platform).length;
const reverseEndpoints = { tscan: 'http://127.0.0.1:8088/mcp', jadx: 'http://127.0.0.1:8651/mcp', x64dbg: 'http://127.0.0.1:9094/', ida: 'http://127.0.0.1:8737/mcp', ghidra: 'http://127.0.0.1:8081/mcp', gdb: 'http://127.0.0.1:8000/mcp', metasploit: 'http://127.0.0.1:3000/' };
const localPresets = {
  cyberchef: { transport: 'stdio', command: 'cmd.exe', args: ['/d', '/s', '/c', 'cyberchef-mcp'] },
  wireshark: { transport: 'stdio', command: 'python', args: ['-m', 'wireshark_mcp', 'serve', '--transport', 'stdio', '--profile', 'analysis'] },
  windbg: { transport: 'stdio', command: 'python', args: ['-m', 'mcp_windbg', '--transport', 'stdio'] },
  sagemath: { transport: 'stdio', command: 'sagemath-mcp', args: ['--transport', 'stdio'] },
  pwntools: { transport: 'stdio', command: 'Class', args: ['--local-analysis-mcp', 'pwntools'] },
  bloodhound: { transport: 'stdio', command: 'bloodhound-mcp', args: [] },
  zsteg: { transport: 'stdio', command: 'Class', args: ['--local-analysis-mcp', 'zsteg'] },
  binwalk: { transport: 'stdio', command: 'Class', args: ['--local-analysis-mcp', 'binwalk'] },
  aflpp: { transport: 'stdio', command: 'aflpp-mcp', args: [] },
};
const reversePreset = (type, overrides = {}, platform = process.platform) => ({ id: 'class-' + type, name: ({ sagemath: 'sageMath', aflpp: 'AFL++' })[type] ?? type, builtin: type, ...(type === 'wireshark' && platform === 'linux' ? { transport: 'stdio', command: 'wireshark-mcp', args: ['serve', '--transport', 'stdio', '--profile', 'analysis'] } : localPresets[type] ?? { transport: 'http', url: reverseEndpoints[type], skipTlsVerify: false }), enabled: false, agentIds: [], ...overrides });
test('extension update requires explicit valid grants and rejects stale edits', () => {
  const input = draft(), saved = prepareExtensionUpdate(input, {}, agents, {});
  assert.deepEqual(saved.extensions.mcps[0].agentIds, ['alice']);
  assert.deepEqual(saved.extensions.skills[0].agentIds, ['teacher']);
  assert.equal(Object.hasOwn(saved.extensions.skills[0], 'mcpIds'), false);
  assert.ok(!JSON.stringify(saved.extensions).includes('test-private-token'));
  assert.equal(extensionSecrets(saved.secrets).one.env.TEST_KEY, 'test-private-token');
  assert.throws(() => prepareExtensionUpdate(input, saved.extensions, agents, saved.secrets), error => error.status === 409);
  input.mcps[0].agentIds = ['missing']; assert.throws(() => prepareExtensionUpdate(input, {}, agents, {}), /授权/);
  assert.throws(() => normalizeExtensions({ mcps: [draft().mcps[0], draft().mcps[0]] }), /重复/);
});
test('empty credentials preserve existing values; explicit clears and deletion remove them', () => {
  const first = prepareExtensionUpdate(draft(), {}, agents, { existing: 'keep' });
  const input = { ...first.extensions, mcps: [{ ...first.extensions.mcps[0], env: { TEST_KEY: '', SECOND: 'new' } }] };
  const second = prepareExtensionUpdate(input, first.extensions, agents, first.secrets);
  assert.deepEqual(extensionSecrets(second.secrets).one.env, { TEST_KEY: 'test-private-token', SECOND: 'new' });
  const third = prepareExtensionUpdate({ ...second.extensions, mcps: [{ ...second.extensions.mcps[0], clearEnv: ['TEST_KEY'] }] }, second.extensions, agents, second.secrets);
  assert.deepEqual(extensionSecrets(third.secrets).one.env, { SECOND: 'new' });
  const removed = prepareExtensionUpdate({ ...third.extensions, mcps: [] }, third.extensions, agents, third.secrets);
  assert.deepEqual(removed.secrets, { existing: 'keep' }); assert.equal(Object.hasOwn(removed.extensions.skills[0], 'mcpIds'), false);
  const invalid = draft(); invalid.mcps[0].env = JSON.parse('{"__proto__":"bad"}');
  assert.throws(() => prepareExtensionUpdate(invalid, {}, agents, {}), /名称/);
});

test('editing a saved HTTP header with different casing replaces its value instead of sending both', () => {
  const input={revision:0,mcps:[{id:'remote',name:'remote',transport:'http',url:'https://localhost/mcp',enabled:true,agentIds:['alice'],headers:{Authorization:'Bearer old-fixture'}}],skills:[]};
  const first=prepareExtensionUpdate(input,{},agents,{});
  const updated=prepareExtensionUpdate({...first.extensions,mcps:[{...first.extensions.mcps[0],headers:{authorization:'Bearer new=fixture'}}]},first.extensions,agents,first.secrets);
  assert.deepEqual(extensionSecrets(updated.secrets,updated.extensions).remote.headers,{authorization:'Bearer new=fixture'});
  const cleared=prepareExtensionUpdate({...updated.extensions,mcps:[{...updated.extensions.mcps[0],clearHeaders:['AUTHORIZATION']}]},updated.extensions,agents,updated.secrets);
  assert.equal(cleared.secrets['extension:remote'],undefined);
});

test('legacy Skill MCP associations are ignored without modifying the source configuration', () => {
  const legacy = draft(), before = structuredClone(legacy);
  const normalized = normalizeExtensions(legacy, agents), visible = publicExtensions(legacy, {}, agents);
  for (const value of [normalized, visible]) {
    assert.equal(Object.hasOwn(value.skills[0], 'mcpIds'), false);
    assert.equal(value.skills[0].content, legacy.skills[0].content);
    assert.deepEqual(value.skills[0].agentIds, ['teacher']);
    assert.deepEqual(value.mcps[0].agentIds, ['alice']);
  }
  assert.deepEqual(legacy, before);
});
test('interrupted two-file publication cannot send newly saved credentials to the previous endpoint', () => {
  const first = prepareExtensionUpdate(draft(), {}, agents, {});
  const next = { ...first.extensions, mcps: [{ ...first.extensions.mcps[0], command: 'replacement-fixture', env: { TEST_KEY: 'new-private-token' } }] };
  const second = prepareExtensionUpdate(next, first.extensions, agents, first.secrets);
  assert.throws(() => extensionSecrets(second.secrets, first.extensions), error => error.status === 409);
  assert.throws(() => extensionSecrets(first.secrets, second.extensions), error => error.status === 409);
  assert.equal(extensionSecrets(second.secrets, second.extensions).one.env.TEST_KEY, 'new-private-token');
  const renamed = { ...second.extensions, mcps: [{ ...second.extensions.mcps[0], name: 'New display name', agentIds: ['teacher'] }] };
  assert.equal(extensionSecrets(second.secrets, renamed).one.env.TEST_KEY, 'new-private-token');
});
test('UI extension API persists grants and encrypted secrets across restart and removes deleted Agent grants', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-extension-api-'));
  const token = randomUUID(); let app;
  t.after(async () => { await app?.close(); const actual = await fs.realpath(root); assert.equal(path.dirname(actual), parent); assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(actual, { recursive: true, force: true }); });
  const store = await createProfileStore(root);
  await store.save({ ...store.config, agents: agents.map(agent => ({ ...agent, baseUrl: 'http://127.0.0.1:1/v1', protocol: 'messages', model: 'fixture' })) });
  const start = async () => { app = await createClassServer({ dataDir: root, token }); };
  const api = async (route, body, method = body === undefined ? 'GET' : 'PUT', status = 200) => {
    const response = await fetch(app.url + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  await start();
  const defaults = await api('/api/extensions'); assert.equal(defaults.revision, 0);
  assert.equal(defaults.platform, process.platform);
  assert.deepEqual(defaults.mcps.filter(isBuiltinMcp).map(item => item.builtin), platformKinds(process.platform));
  assert.deepEqual(defaults.mcps.find(item => item.builtin === 'burpsuite'), { ...burp(), envKeys: [], headerKeys: [] });
  for (const type of platformKinds(process.platform).slice(2)) assert.deepEqual(defaults.mcps.find(item => item.builtin === type), { ...reversePreset(type), envKeys: [], headerKeys: [] });
  const input = draft();
  // Editable API clients retain immutable built-in entries when adding a custom one.
  const saved = await api('/api/extensions', { ...input, mcps: [...input.mcps, ...defaults.mcps], skills: [...input.skills, ...defaults.skills] }); assert.equal(saved.revision, 1); assert.deepEqual(saved.mcps[0].envKeys, ['TEST_KEY']);
  assert.ok(!JSON.stringify(saved).includes('test-private-token')); assert.ok(!JSON.stringify(await api('/api/state')).includes('test-private-token'));
  const profileFile = path.join(root, 'profiles.json'), profileText = await fs.readFile(profileFile, 'utf8');
  assert.ok(!profileText.includes('test-private-token')); assert.ok(!profileText.includes('mcpIds'));
  await api('/api/extensions', draft(), 'PUT', 409);
  await app.close();
  // Simulate an older saved profile; loading must keep its bytes and ignore links.
  const legacy = JSON.parse(profileText); legacy.extensions.skills[0].mcpIds = ['one'];
  const legacyText = JSON.stringify(legacy); await fs.writeFile(profileFile, legacyText);
  await start();
  const reloaded = await api('/api/extensions'); assert.deepEqual(reloaded.mcps[0].agentIds, ['alice']);
  assert.equal(Object.hasOwn(reloaded.skills[0], 'mcpIds'), false);
  assert.equal(await fs.readFile(profileFile, 'utf8'), legacyText);
  assert.equal(extensionSecrets(await loadSecrets(root)).one.env.TEST_KEY, 'test-private-token');
  await api('/api/agents/alice', undefined, 'DELETE');
  const pruned = await api('/api/extensions'); assert.deepEqual(pruned.mcps[0].agentIds, []); assert.equal(pruned.revision, 2);
});

const builtin = (overrides = {}) => ({ id: 'class-browser', name: 'browser', transport: 'builtin', builtin: 'browser', ...overrides });
const burp = (overrides = {}) => ({ id: 'class-burpsuite', name: 'burpsuite', builtin: 'burpsuite', transport: 'sse', url: 'http://127.0.0.1:9876', skipTlsVerify: false, enabled: false, agentIds: [], ...overrides });

test('builtin browser normalization is explicit, disabled by default and never grants the principal', async () => {
  assert.deepEqual(normalizeExtensions(), { revision: 0, mcps: [], skills: [] });
  assert.deepEqual((await loadCLIExtensions({ students: [{ id: 'alice' }, { id: 'bob' }] }, { environment: {} })).extensionConfig.mcps, []);
  const config = normalizeExtensions({ mcps: [builtin()] }, agents);
  assert.equal(config.mcps[0].enabled, false); assert.deepEqual(config.mcps[0].agentIds, []);
  assert.equal(config.mcps[0].transport, 'stdio'); assert.equal(config.mcps[0].command,'Class'); assert.deepEqual(config.mcps[0].args,['--browser-mcp']);
  const enabled = normalizeExtensions({ mcps: [builtin({ enabled: true, agentIds: ['alice'] })] }, agents);
  assert.equal(enabled.mcps[0].enabled, true); assert.deepEqual(enabled.mcps[0].agentIds, ['alice']);
  const withPrincipal = [...agents, { id: 'principal', role: 'principal', name: '校长' }];
  assert.throws(() => normalizeExtensions({ mcps: [builtin({ agentIds: ['principal'] })] }, withPrincipal), /授权/);
  assert.equal(publicExtensions(config, {}, withPrincipal).agents.some(agent => agent.role === 'principal'), false);
  for (const bad of [
    builtin({ builtin: 'unknown' }), builtin({ builtin: undefined }), builtin({ command: 'node' }), builtin({ args: ['run'] }),
    builtin({ cwd: path.resolve('.') }), builtin({ url: 'https://fixture.invalid' }), builtin({ env: { KEY: 'fixture-secret' } }),
    builtin({ headers: { Authorization: 'fixture-secret' } }), builtin({ env: [] }), builtin({ args: 'run' }),
  ]) assert.throws(() => normalizeExtensions({ mcps: [bad] }));
  assert.throws(() => normalizeExtensions({ mcps: [builtin(), builtin({ id: 'second' })] }), /只能配置一个.*browser/);
});

test('Burp preset normalization retains its SSE endpoint, defaults to disabled and uses an explicit builtin marker', () => {
  const config = normalizeExtensions({ mcps: [burp({ enabled: undefined, agentIds: undefined })] }, agents);
  assert.deepEqual(config.mcps, [burp()]);
  assert.equal(isBuiltinMcp(config.mcps[0]), true); assert.equal(isBuiltinBrowserMcp(config.mcps[0]), false);
  assert.equal(isBuiltinMcp(builtin()), true);
  assert.equal(isBuiltinMcp({ name: 'burpsuite', id: 'class-burpsuite' }), false);
  assert.equal(isBuiltinMcp({ builtin: 'unknown' }), false); assert.equal(isBuiltinMcp(null), false);
  const custom = burp({ name: 'My Burp', transport: 'http', url: 'https://localhost/custom', skipTlsVerify: true, enabled: true, agentIds: ['alice'] });
  assert.deepEqual(normalizeExtensions({ mcps: [custom] }, agents).mcps, [custom]);
  assert.throws(() => normalizeExtensions({ mcps: [burp({ agentIds: ['principal'] })] }, [...agents, { id: 'principal', role: 'principal' }]), /授权/);
  assert.throws(() => normalizeExtensions({ mcps: [burp(), burp({ id: 'second-burp' })] }), /只能配置一个.*burpsuite/);
  assert.throws(() => normalizeExtensions({ mcps: [burp({ builtin: 'unknown' })] }), /类型/);
  assert.throws(() => normalizeExtensions({ mcps: [burp({ transport: 'builtin' })] }), /类型/);
});

test('shared profile presets preserve colliding external identities, existing values and all 64 external slots', () => {
  const raw = { revision: 11, mcps: [
    { ...draft().mcps[0], id: 'class-browser', name: 'browser' },
    { ...draft().mcps[0], id: 'class-burpsuite', name: 'burpsuite' },
    { ...draft().mcps[0], id: 'class-burpsuite-2', name: 'Second custom Burp service' },
    { ...draft().mcps[0], id: 'class-tscan', name: 'tscan' },
    { ...draft().mcps[0], id: 'class-tscan-2', name: 'Second custom Tscan service' },
    { ...draft().mcps[0], id: 'class-jadx', name: 'jadx' },
  ], skills: draft().skills };
  const before = structuredClone(raw), normalized = normalizeExtensions(raw), seeded = ensureBuiltinMcpPresets(normalized, 'darwin');
  assert.equal(seeded.revision, 11); assert.deepEqual(seeded.mcps.slice(0, normalized.mcps.length), normalized.mcps);
  assert.deepEqual(seeded.skills, normalized.skills); assert.deepEqual(raw, before);
  assert.equal(seeded.mcps.find(isBuiltinBrowserMcp).id, 'class-browser-2');
  assert.deepEqual(seeded.mcps.find(item => item.builtin === 'burpsuite'), burp({ id: 'class-burpsuite-3' }));
  assert.deepEqual(seeded.mcps.find(item => item.builtin === 'tscan'), reversePreset('tscan', { id: 'class-tscan-3' }));
  assert.deepEqual(seeded.mcps.find(item => item.builtin === 'jadx'), reversePreset('jadx', { id: 'class-jadx-2' }));
  assert.strictEqual(ensureBuiltinMcpPresets(seeded, 'darwin'), seeded);
  const customized = normalizeExtensions({ revision: 12, mcps: [
    builtin({ id: 'saved-browser', name: 'Saved browser', transport: 'stdio', command: 'fixture-browser', args: ['--saved'], enabled: true, agentIds: ['teacher'] }),
    burp({ id: 'saved-burp', name: 'Saved Burp', transport: 'http', url: 'https://localhost/keep', skipTlsVerify: true, enabled: true, agentIds: ['alice'] }),
    reversePreset('tscan', { id: 'saved-tscan', name: 'Saved Tscan', transport: 'sse', url: 'https://localhost/keep-tscan', skipTlsVerify: true, enabled: true, agentIds: ['teacher'] }),
    reversePreset('jadx', { id: 'saved-jadx', name: 'Saved JADX', transport: 'http', url: 'https://localhost/keep-jadx', enabled: true, agentIds: ['alice'] }),
  ] });
  const customBefore = structuredClone(customized);
  assert.strictEqual(ensureBuiltinMcpPresets(customized, 'darwin'), customized); assert.deepEqual(customized, customBefore);
  for (const kept of customized.mcps) {
    const migrated = ensureBuiltinMcpPresets({ ...customized, mcps: [kept] }, 'darwin');
    assert.deepEqual(migrated.mcps.find(item => item.id === kept.id), kept);
    assert.equal(migrated.mcps.filter(isBuiltinMcp).length, platformKinds('darwin').length);
  }
  const external = Array.from({ length: 64 }, (_, index) => ({ ...draft().mcps[0], id: `external-${index}` }));
  const full = ensureBuiltinMcpPresets(normalizeExtensions({ mcps: external }), 'darwin');
  assert.equal(full.mcps.length, 64 + platformKinds('darwin').length); assert.equal(normalizeExtensions(full).mcps.length, full.mcps.length);
  assert.deepEqual(full.mcps.filter(isBuiltinMcp).map(item => item.builtin).sort(), platformKinds('darwin').sort());
  assert.throws(() => normalizeExtensions({ mcps: [...external, { ...draft().mcps[0], id: 'external-65' }, burp()] }), /64个外部/);
  assert.throws(() => normalizeExtensions({ mcps: [...full.mcps, { ...draft().mcps[0], id: 'external-65' }] }), /64个外部/);
});

test('platform preset matrix seeds only common and current-platform defaults without modifying its input', () => {
  assert.deepEqual(BUILTIN_MCP_TYPES, ['browser', 'burpsuite', 'tscan', 'jadx', 'x64dbg', 'ida', 'cyberchef', 'wireshark', 'windbg', 'ghidra', 'gdb', 'sagemath', 'pwntools', 'metasploit', 'bloodhound', 'zsteg', 'binwalk', 'aflpp']);
  for (const platform of ['win32', 'linux', 'darwin', 'freebsd']) {
    const input = normalizeExtensions(), before = structuredClone(input), seeded = ensureBuiltinMcpPresets(input, platform);
    assert.deepEqual(input, before); assert.equal(seeded.revision, 0);
    assert.deepEqual(seeded.mcps.map(item => item.builtin), platformKinds(platform));
    assert.strictEqual(ensureBuiltinMcpPresets(seeded, platform), seeded);
    assert.ok(seeded.mcps.every(item => item.enabled === false && item.agentIds.length === 0 && isBuiltinMcp(item)));
    for (const type of platformKinds(platform).slice(2)) assert.deepEqual(seeded.mcps.find(item => item.builtin === type), reversePreset(type, {}, platform));
    assert.deepEqual(normalizeExtensions(seeded), seeded);
  }
  assert.deepEqual(ensureBuiltinMcpPresets(normalizeExtensions()).mcps.map(item => item.builtin), platformKinds(process.platform));
});

test('platform migrations keep edited presets from other platforms and avoid existing external identities', () => {
  for (const platform of ['win32', 'linux']) {
    const opposite = platform === 'win32' ? 'linux' : 'win32';
    const ownTypes = platformKinds(platform).filter(type => !platformKinds(opposite).includes(type));
    const previous = ensureBuiltinMcpPresets(normalizeExtensions({ revision: 23, skills: draft().skills }), opposite);
    previous.mcps = previous.mcps.map(item => ({ ...item, name: 'Edited ' + item.builtin, enabled: true, agentIds: ['alice'], ...(item.transport === 'stdio' ? { command: 'fixture-browser', args: ['--keep'] } : { url: 'https://localhost/keep-' + item.builtin, skipTlsVerify: true }) }));
    previous.mcps.push(...ownTypes.flatMap(type => [
      { ...draft().mcps[0], id: 'class-' + type, name: type },
      { ...draft().mcps[0], id: 'class-' + type + '-2', name: 'External ' + type },
    ]));
    const normalized = normalizeExtensions(previous), before = structuredClone(normalized);
    const migrated = ensureBuiltinMcpPresets(normalized, platform);
    assert.deepEqual(normalized, before); assert.equal(migrated.revision, 23);
    assert.deepEqual(migrated.mcps.slice(0, before.mcps.length), before.mcps); assert.deepEqual(migrated.skills, before.skills);
    for (const type of ownTypes) assert.deepEqual(migrated.mcps.find(item => item.builtin === type), reversePreset(type, { id: 'class-' + type + '-3' }, platform));
    assert.deepEqual(migrated.mcps.find(item => item.builtin === 'wireshark'), before.mcps.find(item => item.builtin === 'wireshark'), 'A shared Wireshark preset keeps the other platform\'s edited launcher and grants');
    assert.equal(migrated.mcps.filter(isBuiltinMcp).length, BUILTIN_MCP_TYPES.length);
    assert.strictEqual(ensureBuiltinMcpPresets(migrated, platform), migrated);
    assert.strictEqual(ensureBuiltinMcpPresets(migrated, opposite), migrated);
    assert.strictEqual(ensureBuiltinMcpPresets(migrated, 'darwin'), migrated);
  }
});

test('all presets retain 64 external slots and reject duplicate markers, unknown types and invalid grants', () => {
  const external = Array.from({ length: 64 }, (_, index) => ({ ...draft().mcps[0], id: 'external-' + index }));
  const full = ensureBuiltinMcpPresets(ensureBuiltinMcpPresets(normalizeExtensions({ mcps: external }), 'win32'), 'linux');
  assert.equal(full.mcps.length, 64 + BUILTIN_MCP_TYPES.length); assert.deepEqual(normalizeExtensions(full), full);
  assert.deepEqual(full.mcps.filter(isBuiltinMcp).map(item => item.builtin), BUILTIN_MCP_TYPES);
  for (const entry of full.mcps.filter(isBuiltinMcp)) {
    assert.throws(() => normalizeExtensions({ mcps: [entry, { ...entry, id: entry.id + '-duplicate' }] }), /只能配置一个/);
  }
  assert.throws(() => normalizeExtensions({ mcps: [...full.mcps, { ...draft().mcps[0], id: 'overflow' }] }), /64个外部/);
  assert.throws(() => normalizeExtensions({ mcps: [...external, { ...draft().mcps[0], id: 'overflow' }, reversePreset('ida')] }), /64个外部/);
  for (const type of [...Object.keys(reverseEndpoints), ...Object.keys(localPresets)]) {
    assert.equal(isBuiltinMcp(reversePreset(type)), true); assert.equal(isBuiltinBrowserMcp(reversePreset(type)), false);
    assert.equal(isBuiltinMcp({ id: 'class-' + type, name: type }), false);
    const config = normalizeExtensions({ mcps: [reversePreset(type, { enabled: undefined, agentIds: undefined })] }, agents);
    assert.deepEqual(config.mcps, [reversePreset(type)]);
    assert.throws(() => normalizeExtensions({ mcps: [reversePreset(type, { agentIds: ['missing'] })] }, agents), /授权/);
    assert.throws(() => normalizeExtensions({ mcps: [reversePreset(type, { agentIds: ['principal'] })] }, [...agents, { id: 'principal', role: 'principal' }]), /授权/);
    assert.throws(() => normalizeExtensions({ mcps: [reversePreset(type, { transport: 'builtin' })] }), /类型/);
  }
  assert.throws(() => normalizeExtensions({ mcps: [reversePreset('ida', { builtin: 'unknown' })] }), /类型/);
});

test('CLI validates explicit platform presets without seeding absent presets or importing other agent grants', async () => {
  const empty = await loadCLIExtensions({ students: [{ id: 'alice' }] }, { environment: {} });
  assert.deepEqual(empty.extensionConfig.mcps, []);
  for (const type of Object.keys(reverseEndpoints)) {
    const loaded = await loadCLIExtensions({ students: [{ id: 'alice' }], extensions: { mcps: [reversePreset(type, { enabled: true, agentIds: ['alice', 'absent'] })] } }, { environment: {} });
    assert.deepEqual(loaded.extensionConfig.mcps, [reversePreset(type, { enabled: true, agentIds: ['alice'] })]);
    assert.deepEqual(loaded.extensionSecrets, {});
  }
});

test('browser transport settings and private values survive profile reload alongside the Burp preset', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-browser-config-'));
  t.after(async()=>{ const actual=await fs.realpath(root); assert.equal(path.dirname(actual),parent); assert.ok(path.basename(actual).startsWith('class-browser-config-')); assert.equal((await fs.lstat(actual)).isSymbolicLink(),false); await fs.rm(actual,{recursive:true,force:true}); });
  let store=await createProfileStore(root);
  for(const transport of ['stdio','http','sse']) {
    const preset=store.config.extensions.mcps.find(isBuiltinBrowserMcp);
    const entry={id:preset.id,name:'browser',builtin:'browser',transport,enabled:true,agentIds:['alice'],...(transport==='stdio'
      ? {command:'fixture-command',args:['--fixture'],env:{FIXTURE_SETTING:'first=second'}}
      : {url:'https://localhost/'+transport,skipTlsVerify:transport==='sse',headers:{Authorization:'Bearer fixture='+transport}})};
    const update=prepareExtensionUpdate({revision:store.config.extensions.revision,mcps:[entry],skills:[]},store.config.extensions,agents,store.secrets);
    await store.save({...store.config,extensions:update.extensions},update.secrets);
    store=await createProfileStore(root);
    assert.equal(store.config.extensions.mcps.length,currentPresetCount);
    assert.deepEqual(store.config.extensions.mcps.find(item=>item.builtin==='burpsuite'),burp());
    const saved=store.config.extensions.mcps.find(isBuiltinBrowserMcp); assert.equal(saved.transport,transport); assert.equal(saved.builtin,'browser'); assert.deepEqual(saved.agentIds,['alice']);
    const privateValue=extensionSecrets(store.secrets,store.config.extensions)[saved.id];
    if(transport==='stdio') assert.equal(privateValue.env.FIXTURE_SETTING,'first=second');
    else { assert.equal(saved.skipTlsVerify,transport==='sse'); assert.equal(privateValue.headers.Authorization,'Bearer fixture='+transport); }
    assert.equal((await fs.readFile(path.join(root,'profiles.json'),'utf8')).includes('Bearer fixture'),false);
  }
  for(const skipTlsVerify of ['true',1,null]) assert.throws(()=>normalizeExtensions({mcps:[{id:'remote',name:'remote',transport:'http',url:'https://localhost/',skipTlsVerify}]}),/HTTPS/);
});

test('profile preset avoids custom MCP identities and preserves all 64 external slots', () => {
  const raw = { revision: 9, mcps: [
    { ...draft().mcps[0], id: 'class-browser', name: 'browser' },
    { ...draft().mcps[0], id: 'class-browser-2', name: 'My browser service' },
  ] };
  const original = structuredClone(raw), normalized = normalizeExtensions(raw);
  const seeded = ensureBuiltinBrowserPreset(normalized);
  assert.equal(seeded.revision, 9); assert.deepEqual(seeded.mcps.slice(0, 2), normalized.mcps);
  assert.deepEqual(seeded.mcps[2], builtin({ id: 'class-browser-3', transport:'stdio', command:'Class', args:['--browser-mcp'], enabled: false, agentIds: [] }));
  assert.strictEqual(ensureBuiltinBrowserPreset(seeded), seeded); assert.deepEqual(raw, original);
  const external = Array.from({ length: 64 }, (_, index) => ({ ...draft().mcps[0], id: `external-${index}` }));
  const full = ensureBuiltinBrowserPreset(normalizeExtensions({ mcps: external }));
  assert.equal(full.mcps.length, 65); assert.equal(normalizeExtensions(full).mcps.length, 65);
  assert.equal(full.mcps.filter(isBuiltinBrowserMcp).length, 1);
  assert.throws(() => normalizeExtensions({ mcps: [...external, { ...draft().mcps[0], id: 'external-65' }] }), /64个外部/);
});

test('browser preset supports stdio environment variables and remote headers without exposing private values', () => {
  const previous = prepareExtensionUpdate(draft(), {}, agents, { unrelated: 'keep' });
  const current = ensureBuiltinBrowserPreset(previous.extensions);
  const secrets = previous.secrets;
  const updated = prepareExtensionUpdate({ ...current, mcps: current.mcps.map(item => isBuiltinBrowserMcp(item)
    ? { ...item, enabled: true, agentIds: ['alice'], env:{BROWSER_SETTING:'fixture-browser-setting'} } : { ...item, env: { SECOND: 'fixture-second-token' } }) }, current, agents, secrets);
  assert.equal(Object.hasOwn(updated.secrets, 'extension:class-browser'), true);
  assert.equal(updated.secrets.unrelated, 'keep');
  assert.deepEqual(extensionSecrets(updated.secrets, updated.extensions).one.env, { TEST_KEY: 'test-private-token', SECOND: 'fixture-second-token' });
  const visible = publicExtensions(updated.extensions, updated.secrets, agents).mcps.find(isBuiltinBrowserMcp);
  assert.deepEqual(visible.envKeys, ['BROWSER_SETTING']); assert.deepEqual(visible.headerKeys, []);
  assert.equal(JSON.stringify(visible).includes('fixture-browser-setting'), false);
  const remote = prepareExtensionUpdate({ ...updated.extensions, mcps:updated.extensions.mcps.map(item=>isBuiltinBrowserMcp(item)
    ? { id:item.id, name:item.name, builtin:'browser', transport:'http', url:'https://localhost/mcp', enabled:true, agentIds:item.agentIds, skipTlsVerify:true, headers:{Authorization:'Bearer fixture-header'} } : item) }, updated.extensions, agents, updated.secrets);
  assert.equal(ensureBuiltinBrowserPreset(remote.extensions).mcps.length, 2);
  assert.equal(remote.extensions.mcps.find(isBuiltinBrowserMcp).skipTlsVerify,true);
  assert.equal(extensionSecrets(remote.secrets,remote.extensions)['class-browser'].headers.Authorization,'Bearer fixture-header');
  assert.throws(()=>extensionSecrets(remote.secrets,updated.extensions), error=>error.status===409);
});

test('Burp connection edits, encrypted credentials and grants survive repeated profile reloads', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-burp-config-'));
  t.after(async () => { const actual = await fs.realpath(root); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('class-burp-config-')); assert.equal((await fs.lstat(actual)).isSymbolicLink(), false); await fs.rm(actual, { recursive: true, force: true }); });
  let store = await createProfileStore(root);
  assert.deepEqual(store.config.extensions.mcps.find(item => item.builtin === 'burpsuite'), burp());
  for (const transport of ['sse', 'http', 'stdio']) {
    const previousBrowser = structuredClone(store.config.extensions.mcps.find(isBuiltinBrowserMcp));
    const entry = { id: 'class-burpsuite', builtin: 'burpsuite', name: 'Saved Burp connection', transport, enabled: true, agentIds: ['alice'], ...(transport === 'stdio'
      ? { command: 'fixture-burp-command', args: ['--fixture'], env: { BURP_SETTING: 'private-burp-fixture' } }
      : { url: 'https://localhost/burp/' + transport, skipTlsVerify: true, headers: { Authorization: 'Bearer private-burp-' + transport } }) };
    const update = prepareExtensionUpdate({ ...store.config.extensions, mcps: store.config.extensions.mcps.map(item => item.builtin === 'burpsuite' ? entry : item) }, store.config.extensions, agents, store.secrets);
    await store.save({ ...store.config, extensions: update.extensions }, update.secrets);
    store = await createProfileStore(root);
    assert.equal(store.config.extensions.mcps.length, currentPresetCount);
    assert.deepEqual(store.config.extensions.mcps.find(isBuiltinBrowserMcp), previousBrowser);
    const saved = store.config.extensions.mcps.find(item => item.builtin === 'burpsuite');
    const { env, headers, ...expected } = entry;
    assert.deepEqual(saved, expected);
    const privateValue = extensionSecrets(store.secrets, store.config.extensions)[saved.id];
    if (transport === 'stdio') assert.equal(privateValue.env.BURP_SETTING, env.BURP_SETTING);
    else assert.equal(privateValue.headers.Authorization, headers.Authorization);
    const visible = publicExtensions(store.config.extensions, store.secrets, agents).mcps.find(item => item.builtin === 'burpsuite');
    assert.equal(JSON.stringify(visible).includes('private-burp-'), false);
    assert.equal((await fs.readFile(path.join(root, 'profiles.json'), 'utf8')).includes('private-burp-'), false);
    assert.strictEqual(ensureBuiltinMcpPresets(store.config.extensions), store.config.extensions);
  }
});

test('profiles retain all edited platform presets and encrypted headers across save and reload', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-platform-config-'));
  t.after(async () => { const actual = await fs.realpath(root); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('class-platform-config-')); assert.equal((await fs.lstat(actual)).isSymbolicLink(), false); await fs.rm(actual, { recursive: true, force: true }); });
  let store = await createProfileStore(root);
  assert.deepEqual(store.config.extensions.mcps.map(item => item.builtin), platformKinds(process.platform));
  const seeded = ensureBuiltinMcpPresets(ensureBuiltinMcpPresets(store.config.extensions, 'win32'), 'linux');
  const mcps = seeded.mcps.map(item => Object.hasOwn(reverseEndpoints, item.builtin)
    ? reversePreset(item.builtin, { name: 'Edited ' + item.builtin, enabled: true, agentIds: ['alice'], url: 'https://localhost/saved-' + item.builtin, skipTlsVerify: true, headers: { Authorization: 'Bearer private-platform-' + item.builtin } }) : item);
  const update = prepareExtensionUpdate({ ...seeded, mcps }, store.config.extensions, agents, store.secrets);
  await store.save({ ...store.config, extensions: update.extensions }, update.secrets);
  store = await createProfileStore(root);
  assert.deepEqual(store.config.extensions, update.extensions);
  assert.equal(store.config.extensions.mcps.filter(isBuiltinMcp).length, BUILTIN_MCP_TYPES.length);
  const privateValues = extensionSecrets(store.secrets, store.config.extensions);
  for (const type of Object.keys(reverseEndpoints)) assert.equal(privateValues['class-' + type].headers.Authorization, 'Bearer private-platform-' + type);
  const visible = publicExtensions(store.config.extensions, store.secrets, agents);
  assert.equal(JSON.stringify(visible).includes('private-platform-'), false);
  assert.equal((await fs.readFile(path.join(root, 'profiles.json'), 'utf8')).includes('private-platform-'), false);
  for (const type of Object.keys(reverseEndpoints)) assert.deepEqual(visible.mcps.find(item => item.builtin === type).headerKeys, ['Authorization']);
});

test('all local preset commands, grants and encrypted environment survive profile updates', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-local-presets-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), parent); assert.ok(path.basename(root).startsWith('class-local-presets-')); await fs.rm(root, { recursive: true, force: true }); });
  let store = await createProfileStore(root);
  const before = structuredClone(store.config.extensions);
  const seeded = ensureBuiltinMcpPresets(ensureBuiltinMcpPresets(before, 'win32'), 'linux');
  const edited = seeded.mcps.map(item => localPresets[item.builtin] ? { ...item, name: 'Saved ' + item.builtin, command: 'fixture-' + item.builtin, args: ['--keep', 'path with spaces'], enabled: true, agentIds: ['alice'], env: { PRIVATE_TEST: 'fixture-private-' + item.builtin } } : item);
  const update = prepareExtensionUpdate({ ...seeded, mcps: edited }, store.config.extensions, agents, store.secrets);
  await store.save({ ...store.config, extensions: update.extensions }, update.secrets);
  store = await createProfileStore(root);
  assert.deepEqual(store.config.extensions, update.extensions);
  const visible = publicExtensions(store.config.extensions, store.secrets, agents);
  assert.doesNotMatch(JSON.stringify(visible), /fixture-private-/);
  assert.doesNotMatch(await fs.readFile(path.join(root, 'profiles.json'), 'utf8'), /fixture-private-/);
  for (const type of Object.keys(localPresets)) {
    assert.equal(extensionSecrets(store.secrets, store.config.extensions)['class-' + type].env.PRIVATE_TEST, 'fixture-private-' + type);
    assert.deepEqual(visible.mcps.find(item => item.builtin === type).envKeys, ['PRIVATE_TEST']);
  }
  for (const item of before.mcps.filter(item => !localPresets[item.builtin])) assert.deepEqual(store.config.extensions.mcps.find(saved => saved.id === item.id), item);
});

test('legacy profiles gain platform presets without a write; omission resets them safely on save', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-extension-preset-'));
  t.after(async () => { const actual = await fs.realpath(root); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('class-extension-preset-')); assert.equal((await fs.lstat(actual)).isSymbolicLink(), false); await fs.rm(actual, { recursive: true, force: true }); });
  const profileFile = path.join(root, 'profiles.json');
  const customTscan = { ...draft().mcps[0], id: 'class-tscan', name: 'tscan', agentIds: [] };
  const legacy = JSON.stringify({ version: 1, agents: [], settings: {}, extensions: { revision: 5, mcps: [{ ...draft().mcps[0], id: 'class-browser', name: 'browser', agentIds: [] }, customTscan], skills: [] } });
  await fs.writeFile(profileFile, legacy);
  let store = await createProfileStore(root);
  assert.equal(await fs.readFile(profileFile, 'utf8'), legacy);
  let preset = store.config.extensions.mcps.find(isBuiltinBrowserMcp);
  assert.equal(preset.id, 'class-browser-2'); assert.equal(preset.enabled, false); assert.deepEqual(preset.agentIds, []);
  assert.deepEqual(store.config.extensions.mcps.find(item => item.builtin === 'burpsuite'), burp());
  assert.deepEqual(store.config.extensions.mcps.find(item => item.builtin === 'tscan'), reversePreset('tscan', { id: 'class-tscan-2' }));
  assert.deepEqual(store.config.extensions.mcps.find(item => item.id === 'class-tscan'), normalizeExtensions({ mcps: [customTscan] }).mcps[0]);
  const extensions = { ...store.config.extensions, mcps: store.config.extensions.mcps.map(item => isBuiltinMcp(item) ? { ...item, enabled: true, agentIds: ['alice'] } : item) };
  await store.save({ ...store.config, extensions }, { unrelated: 'fixture-keep' });
  store = await createProfileStore(root); preset = store.config.extensions.mcps.find(isBuiltinBrowserMcp);
  assert.equal(preset.enabled, true); assert.deepEqual(preset.agentIds, ['alice']);
  assert.deepEqual(store.config.extensions.mcps.find(item => item.builtin === 'burpsuite'), burp({ enabled: true, agentIds: ['alice'] }));
  assert.deepEqual(store.config.extensions.mcps.find(item => item.builtin === 'tscan'), reversePreset('tscan', { id: 'class-tscan-2', enabled: true, agentIds: ['alice'] }));
  // An older client knows only its own external entries and omits the presets.
  await store.save({ ...store.config, extensions: { ...store.config.extensions, mcps: store.config.extensions.mcps.filter(item => !isBuiltinMcp(item)) } });
  store = await createProfileStore(root); preset = store.config.extensions.mcps.find(isBuiltinBrowserMcp);
  assert.equal(preset.id, 'class-browser-2'); assert.equal(preset.enabled, false); assert.deepEqual(preset.agentIds, []);
  assert.deepEqual(store.config.extensions.mcps.find(item => item.builtin === 'burpsuite'), burp());
  assert.deepEqual(store.config.extensions.mcps.find(item => item.builtin === 'tscan'), reversePreset('tscan', { id: 'class-tscan-2' }));
  assert.equal(store.config.extensions.mcps.length, currentPresetCount + 2);
  assert.equal(store.config.extensions.mcps[0].transport, 'stdio');
  assert.equal((await loadSecrets(root)).unrelated, 'fixture-keep');
});
