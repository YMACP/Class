import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModeExtensions, exactDuplicateGroups, MODE_EXTENSION_PRESETS } from '../src/mode-extensions.js';
import { ensureBuiltinMcpPresets } from '../src/extension-config.js';
import { ensureBuiltinSkillPresets } from '../src/builtin-skills.js';

const team = [
  { id: 'teacher', role: 'teacher' },
  { id: 'alice', role: 'student' },
  { id: 'principal', role: 'principal' },
];
const defaults = () => ensureBuiltinSkillPresets(ensureBuiltinMcpPresets({ revision: 7, mcps: [], skills: [] }, 'win32'));
const remote = (id, extra = {}) => ({ id, name: id, transport: 'http', url: 'http://localhost:8080/mcp', skipTlsVerify: false, enabled: true, agentIds: ['alice'], ...extra });
const skill = (id, extra = {}) => ({ id, name: id, description: '', content: '# Exact guide', enabled: true, agentIds: ['alice'], ...extra });

test('automatic mode leaves all defaults off and creates no profile or CLI presets', () => {
  const profile = defaults(), before = structuredClone(profile);
  const snapshot = buildModeExtensions(profile, { agents: team, grantModeDefaults: true });
  assert.deepEqual(snapshot, profile);
  assert.notEqual(snapshot, profile);
  snapshot.mcps[0].agentIds.push('alice');
  assert.deepEqual(profile, before);
  assert.deepEqual(buildModeExtensions({}, { taskMode: 'web_pentest', agents: team, grantModeDefaults: true }), { revision: 0, mcps: [], skills: [] });
  assert.throws(() => buildModeExtensions({}, { taskMode: 'unknown' }), /任务模式/);
});

test('web mode selects only present mode built-ins without widening any existing grants', () => {
  const profile = defaults();
  profile.mcps.find(item => item.builtin === 'burpsuite').agentIds = ['another-student'];
  profile.skills.find(item => item.builtin === 'ctf-web').agentIds = ['alice'];
  profile.mcps.push(remote('user-mcp', { agentIds: ['alice'] }));
  profile.skills.push(skill('user-skill', { agentIds: ['teacher'] }));
  const before = structuredClone(profile);
  const snapshot = buildModeExtensions(profile, { taskMode: 'web_pentest', agents: team, grantModeDefaults: true });
  assert.deepEqual(profile, before);
  for (const kind of ['mcps', 'skills']) for (const item of snapshot[kind]) {
    const original = profile[kind].find(other => other.id === item.id);
    if (MODE_EXTENSION_PRESETS.web_pentest[kind].includes(item.builtin)) {
      assert.equal(item.enabled, true);
      assert.deepEqual(item.agentIds, original.agentIds.length ? original.agentIds : ['teacher', 'alice']);
    } else assert.deepEqual(item, original);
    assert.ok(!item.agentIds.includes('principal'));
  }
  assert.equal(snapshot.revision, 7);
  assert.deepEqual(snapshot.mcps.find(item => item.id === 'user-mcp'), profile.mcps.at(-1));
  assert.deepEqual(snapshot.skills.find(item => item.id === 'user-skill'), profile.skills.at(-1));
});

test('mode grants require explicit caller policy and never assign a principal or unselected member', () => {
  const profile = defaults();
  for (const options of [{}, { grantModeDefaults: false }, { grantModeDefaults: 'true' }]) {
    const snapshot = buildModeExtensions(profile, { taskMode: 'web_pentest', agents: team, ...options });
    assert.ok(snapshot.mcps.every(item => item.agentIds.length === 0));
    assert.ok(snapshot.skills.every(item => item.agentIds.length === 0));
  }
  const snapshot = buildModeExtensions(profile, { taskMode: 'web_pentest', grantModeDefaults: true, agents: [team[1], team[1], team[2]] });
  assert.deepEqual(snapshot.mcps.find(item => item.builtin === 'browser').agentIds, ['alice']);
  assert.deepEqual(buildModeExtensions(profile, { taskMode: 'web_pentest', grantModeDefaults: true }).mcps[0].agentIds, []);
});

test('exact MCP duplicates require same effective transport, endpoint, TLS and private values', () => {
  const config = { mcps: [remote('first', { url: 'HTTP://LOCALHOST:80' }), remote('second', { url: 'http://localhost/' }),
    remote('different-transport', { transport: 'sse', url: 'http://localhost/' }),
    remote('different-tls', { url: 'http://localhost/', skipTlsVerify: true }),
    remote('different-query', { url: 'http://localhost/?mode=other' }),
    remote('different-private', { url: 'http://localhost/' }),
    remote('disabled', { url: 'http://localhost/', enabled: false })], skills: [] };
  const secrets = {
    first: { env: { B: '2', A: '1' }, headers: { Authorization: 'Bearer private-a' }, binding: 'id-specific-a' },
    second: { env: { A: '1', B: '2' }, headers: { authorization: 'Bearer private-a' }, binding: 'id-specific-b' },
    'different-private': { env: { A: '1', B: '2' }, headers: { Authorization: 'Bearer private-b' } },
  };
  const result = exactDuplicateGroups(config, { secrets, agentId: 'alice' });
  assert.deepEqual(result.mcps, [{ primaryId: 'first', duplicateIds: ['second'], ids: ['first', 'second'] }]);
  assert.ok(!JSON.stringify(result).includes('private-a'));
  assert.deepEqual(exactDuplicateGroups(config, { secrets: Object.fromEntries(Object.entries(secrets).map(([id, value]) => ['extension:' + id, JSON.stringify(value)])), agentId: 'alice' }), result);
  assert.deepEqual(exactDuplicateGroups(config, { secrets, agentId: 'teacher' }), { mcps: [], skills: [] });
});

test('deduplication respects each member grants and does not confuse similar names with equivalence', () => {
  const config = { mcps: [remote('first', { name: 'Same label', agentIds: ['alice', 'teacher'] }), remote('second', { name: 'Other label' }), remote('third', { name: 'Same label', url: 'http://localhost:9999/mcp' })], skills: [] };
  assert.deepEqual(exactDuplicateGroups(config).mcps, []);
  assert.deepEqual(exactDuplicateGroups(config, { agentId: 'teacher' }).mcps, []);
  assert.deepEqual(exactDuplicateGroups(config, { agentId: 'alice' }).mcps[0].ids, ['first', 'second']);
  config.mcps[1].agentIds = ['teacher', 'alice'];
  assert.deepEqual(exactDuplicateGroups(config).mcps[0].ids, ['first', 'second']);
});

test('stdio launch semantics, arguments, working directory and scoped adapters stay distinct', () => {
  const local = (id, extra = {}) => remote(id, { transport: 'stdio', command: 'python', args: ['-m', 'fixture'], ...extra });
  const config = { mcps: [local('first'), local('second'), local('arg', { args: ['-m', 'other'] }), local('cwd', { cwd: process.cwd() }),
    local('browser', { builtin: 'browser', command: 'Class', args: ['--browser-mcp'] }),
    local('custom-browser', { command: 'Class', args: ['--browser-mcp'] })], skills: [] };
  assert.deepEqual(exactDuplicateGroups(config, { agentId: 'alice' }).mcps.map(group => group.ids), [['first', 'second']]);
});

test('Skill duplicate detection includes complete content and built-in resource identity', () => {
  const config = { mcps: [], skills: [skill('first'), skill('second', { name: 'A different display name' }), skill('other', { content: '# Exact guide\nExtra step' }),
    skill('built-in', { builtin: 'ctf-web' }), skill('different-resources', { builtin: 'ctf-pwn' }), skill('disabled', { enabled: false })] };
  assert.deepEqual(exactDuplicateGroups(config, { agentId: 'alice' }).skills.map(group => group.ids), [['first', 'second']]);
  config.skills[1].agentIds = ['teacher'];
  assert.deepEqual(exactDuplicateGroups(config, { agentId: 'alice' }).skills, []);
});

test('invalid credentials and ambiguous header casing never get treated as duplicates', () => {
  const config = { mcps: [remote('first'), remote('second')], skills: [] };
  for (const secrets of [
    { first: { headers: { X: 'one', x: 'two' } }, second: { headers: { X: 'one', x: 'two' } } },
    { 'extension:first': '{invalid', 'extension:second': '{invalid' },
    { first: { env: { X: 1 } }, second: { env: { X: 1 } } },
  ]) assert.deepEqual(exactDuplicateGroups(config, { secrets }).mcps, []);
  assert.deepEqual(exactDuplicateGroups(config, { agentId: null }), { mcps: [], skills: [] });
});
