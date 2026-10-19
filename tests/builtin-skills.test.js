import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_SKILL_IDS, isBuiltinSkill, ensureBuiltinSkillPresets, getBuiltinSkillMetadata, readBuiltinSkillResource, builtinSkillGuidance } from '../src/builtin-skills.js';
import { normalizeExtensions, prepareExtensionUpdate } from '../src/extension-config.js';
import { createProfileStore } from '../src/profile-store.js';
import { ExtensionRuntime } from '../src/extensions.js';

const agents = [{ id: 'alice', role: 'student' }, { id: 'teacher', role: 'teacher' }, { id: 'principal', role: 'principal' }];
const seeded = () => ensureBuiltinSkillPresets(normalizeExtensions());
const builtin = (changes = {}) => ({ ...seeded().skills[0], ...changes });
const custom = (id = 'custom') => ({ id, name: 'Custom skill', description: 'Keep this', content: 'Custom content', enabled: true, agentIds: ['alice'] });
const readableNames = {
  'solve-challenge': 'CTF解题规划',
  'performing-web-application-penetration-test': 'Web渗透测试',
  'conducting-api-security-testing': 'API安全测试',
  'testing-for-broken-access-control': '越权检测',
  'testing-for-business-logic-vulnerabilities': '业务逻辑漏洞分析',
  'testing-for-xss-vulnerabilities-with-burpsuite': 'XSS检测',
  'scanning-network-with-nmap-advanced': '网络扫描',
  'implementing-attack-surface-management': '攻击面发现',
  'mapping-attack-paths-with-bloodhound-ce': '域内攻击路径分析',
  'performing-binary-exploitation-analysis': '二进制漏洞分析',
  'reverse-engineering-malware-with-ghidra': 'Ghidra逆向分析',
  'analyzing-network-traffic-with-wireshark': '网络流量分析',
  'analyzing-memory-dumps-with-volatility': '内存取证',
  'performing-firmware-extraction-with-binwalk': '固件提取',
  'performing-steganography-detection': '隐写检测',
  'analyzing-linux-elf-malware': 'Linux程序分析',
  'reverse-engineering-android-malware-with-jadx': 'Android逆向分析',
  'reverse-engineering-dotnet-malware-with-dnspy': '.NET逆向分析',
  'performing-fuzzing-with-aflplusplus': '模糊测试',
};
const descriptionChanges = {
  'ctf-web': ['CTF Web 漏洞分析与利用流程', 'Web漏洞分析与利用(CTF版)'],
  'ctf-pwn': ['CTF 二进制漏洞与利用分析', '二进制漏洞与利用分析(CTF版)'],
  'ctf-reverse': ['CTF 程序逆向与校验逻辑还原', '程序逆向与逻辑分析(CTF版)'],
  'ctf-crypto': ['CTF 密码学题目分析与求解', '加解密分析(CTF版)'],
  'ctf-forensics': ['CTF 文件、内存与流量取证', '取证分析(CTF版)'],
  'ctf-misc': ['CTF 隐写、编码与杂项题目分析', '杂项求解(CTF版)'],
  'ctf-osint': ['CTF 公开信息检索与线索关联', '开源情报收集(CTF版)'],
  'ctf-malware': ['CTF 恶意样本分析与行为还原', '恶意样本分析(CTF版)'],
  'ctf-ai-ml': ['CTF 人工智能与机器学习安全题目分析', '人工智能专项赛题(CTF版)'],
  'ctf-writeup': ['整理 CTF 解题过程与可复现记录', 'wp整理(CTF版)'],
  'solve-challenge': ['识别 CTF 题型并组织解题流程', 'CTF题型识别与解题流程组织'],
};
async function temporaryProfileDirectory(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'class-builtin-skills-'));
  t.after(async () => {
    const actual = await fs.realpath(root);
    assert.equal(path.dirname(actual), parent);
    assert.ok(path.basename(actual).startsWith('class-builtin-skills-'));
    assert.equal((await fs.lstat(actual)).isSymbolicLink(), false);
    await fs.rm(actual, { recursive: true, force: true });
  });
  return root;
}
function runtime(skills, maxOutputBytes = 65536) {
  let connections = 0;
  const instance = new ExtensionRuntime({ maxOutputBytes, checkpoint: async () => {} }, {
    config: { skills }, clientFactory: () => { connections++; throw Error('Skill reads must never launch MCPs'); },
  });
  return { instance, connections: () => connections };
}
async function read(instance, id, args = {}, artifact) {
  const result = await instance.execute('alice', 'read_skill', { id, ...args }, undefined, artifact);
  return { result, page: JSON.parse(result.output) };
}

test('all packaged skills seed disabled without grants and keep immutable upstream resources', () => {
  const config = seeded();
  assert.equal(BUILTIN_SKILL_IDS.length, 29);
  assert.equal(config.skills.length, BUILTIN_SKILL_IDS.length);
  assert.deepEqual(normalizeExtensions(config), config);
  assert.strictEqual(ensureBuiltinSkillPresets(config), config);
  assert.deepEqual(normalizeExtensions().skills, [], 'Validation alone must not seed CLI configurations');
  for (const skill of config.skills) {
    assert.equal(skill.enabled, false);
    assert.deepEqual(skill.agentIds, []);
    assert.equal(isBuiltinSkill(skill), true);
    assert.match(skill.content, /^Class 使用指导/);
    assert.match(skill.content, /install_ctf_tools\.sh 未随包提供/);
    assert.match(skill.content, /write_file/);
    assert.ok(skill.content.endsWith(readBuiltinSkillResource(skill.builtin, 'SKILL.md')));
    assert.ok(skill.content.length <= 128 * 1024);
  }
  assert.match(builtinSkillGuidance('solve-challenge'), /不得另起调度或改变 teacher\/student/);
  assert.match(builtinSkillGuidance('performing-steganography-detection'), /Ruby gem/);
  assert.match(builtinSkillGuidance('analyzing-firmware-with-binwalk'), /v3 --help/);
  assert.match(builtinSkillGuidance('performing-memory-forensics-with-volatility3'), /主要覆盖 Windows/);
  assert.match(builtinSkillGuidance('analyzing-binaries-with-ghidra'), /ExportDecompilation.py 未随包提供/);
  assert.match(builtinSkillGuidance('performing-fuzzing-with-afl-plus-plus'), /实际 target、seed、harness 和运行上限/);
});

test('new presets use readable labels while CTF names and internal identities remain stable', () => {
  const config = seeded();
  assert.equal(config.skills.filter(skill => skill.builtin.startsWith('ctf-')).length, 10);
  assert.equal(Object.keys(readableNames).length, 19);
  for (const skill of config.skills) {
    const metadata = getBuiltinSkillMetadata(skill.builtin);
    assert.equal(skill.name, readableNames[skill.builtin] || skill.builtin, skill.builtin);
    assert.equal(metadata.name, skill.name);
    assert.equal(metadata.id, skill.builtin);
    assert.equal(skill.id, ('class-skill-' + skill.builtin).slice(0, 72));
    assert.equal(metadata.upstreamPath, metadata.source === 'ctf-skills' ? skill.builtin : 'skills/' + skill.builtin);
    if (descriptionChanges[skill.builtin]) {
      assert.equal(skill.description, descriptionChanges[skill.builtin][1], skill.builtin);
      assert.ok(metadata.legacyDescriptions.includes(descriptionChanges[skill.builtin][0]));
    }
    if (readableNames[skill.builtin]) assert.deepEqual(metadata.legacyNames, [skill.builtin]);
    assert.ok(skill.content.endsWith(readBuiltinSkillResource(skill.builtin, 'SKILL.md')));
  }
});

test('old default labels upgrade without changing saved identities, bodies, grants or revision', () => {
  const existing = { ...seeded(), revision: 23 };
  existing.skills = existing.skills.map((skill, index) => ({
    ...skill, id: 'saved-skill-' + index, name: skill.builtin,
    description: descriptionChanges[skill.builtin]?.[0] ?? skill.description,
    content: 'Saved edited body for ' + skill.builtin,
    enabled: index % 2 === 0, agentIds: ['teacher'],
  }));
  const before = structuredClone(existing), upgraded = ensureBuiltinSkillPresets(existing);
  assert.deepEqual(existing, before, 'Migration must not mutate the input profile');
  assert.equal(upgraded.revision, before.revision);
  assert.strictEqual(upgraded.mcps, existing.mcps);
  assert.equal(upgraded.skills.length, before.skills.length);
  upgraded.skills.forEach((skill, index) => assert.deepEqual(skill, {
    ...before.skills[index],
    name: readableNames[skill.builtin] || skill.builtin,
    description: descriptionChanges[skill.builtin]?.[1] ?? before.skills[index].description,
  }));
  assert.strictEqual(ensureBuiltinSkillPresets(upgraded), upgraded);
});

test('label upgrades preserve custom fields independently and require an explicit builtin marker', () => {
  const existing = seeded();
  const changes = {
    'performing-web-application-penetration-test': { name: 'performing-web-application-penetration-test', description: 'My Web notes' },
    'ctf-reverse': { name: 'My reverse workflow', description: descriptionChanges['ctf-reverse'][0] },
    'conducting-api-security-testing': { name: 'My API workflow', description: 'My API notes' },
  };
  existing.skills = existing.skills.map(skill => ({ ...skill, ...changes[skill.builtin] }));
  const selfAuthored = { ...custom(), name: 'solve-challenge', description: descriptionChanges['solve-challenge'][0] };
  existing.skills.push(selfAuthored);
  const before = structuredClone(existing), upgraded = ensureBuiltinSkillPresets(existing);
  assert.deepEqual(existing, before);
  const web = upgraded.skills.find(skill => skill.builtin === 'performing-web-application-penetration-test');
  assert.equal(web.name, 'Web渗透测试');
  assert.equal(web.description, 'My Web notes');
  const reverse = upgraded.skills.find(skill => skill.builtin === 'ctf-reverse');
  assert.equal(reverse.name, 'My reverse workflow');
  assert.equal(reverse.description, '程序逆向与逻辑分析(CTF版)');
  for (const skill of existing.skills) {
    if (!['performing-web-application-penetration-test', 'ctf-reverse'].includes(skill.builtin)) {
      assert.strictEqual(upgraded.skills.find(item => item.id === skill.id), skill);
    }
  }
  assert.strictEqual(ensureBuiltinSkillPresets(upgraded), upgraded);
});

test('both historical ctf-web descriptions migrate by exact match only', () => {
  for (const description of ['Web漏洞分析与利用', 'CTF Web 漏洞分析与利用流程', 'My Web notes', 'Web漏洞分析与利用（自定义）', 'Web漏洞分析与利用 ']) {
    const config = seeded();
    config.skills = config.skills.map(skill => skill.builtin === 'ctf-web' ? { ...skill, description, name: 'My Web workflow' } : skill);
    const result = ensureBuiltinSkillPresets(config).skills.find(skill => skill.builtin === 'ctf-web');
    assert.equal(result.description, ['Web漏洞分析与利用', 'CTF Web 漏洞分析与利用流程'].includes(description) ? 'Web漏洞分析与利用(CTF版)' : description);
    assert.equal(result.name, 'My Web workflow');
  }
});

test('seeding missing presets preserves custom identities, edited builtins, grants and revision', () => {
  const original = seeded(), first = original.skills[0];
  const edited = { ...first, name: 'Edited title', content: 'Edited body', enabled: true, agentIds: ['teacher'] };
  const existing = { revision: 19, mcps: [], skills: [custom(first.id), custom(first.id + '-2'), edited] };
  // Give the edited preset its own identity while keeping custom identity collisions.
  existing.skills[2] = { ...edited, id: 'edited-builtin' };
  const before = structuredClone(existing), migrated = ensureBuiltinSkillPresets(existing);
  assert.deepEqual(existing, before);
  assert.equal(migrated.revision, 19);
  assert.deepEqual(migrated.skills.slice(0, 3), before.skills);
  assert.equal(migrated.skills.filter(isBuiltinSkill).length, BUILTIN_SKILL_IDS.length);
  assert.strictEqual(ensureBuiltinSkillPresets(migrated), migrated);
  const collision = ensureBuiltinSkillPresets({ revision: 1, mcps: [], skills: [custom(first.id), custom(first.id + '-2')] });
  assert.equal(collision.skills.find(item => item.builtin === first.builtin).id, first.id + '-3');
  assert.deepEqual(collision.skills.slice(0, 2), [custom(first.id), custom(first.id + '-2')]);
});

test('builtin markers are explicit, unique and validated without consuming custom skill slots', () => {
  const selfAuthored = Array.from({ length: 128 }, (_, index) => custom('custom-' + index));
  const full = { ...seeded(), skills: [...selfAuthored, ...seeded().skills] };
  assert.equal(normalizeExtensions(full, agents).skills.length, 128 + BUILTIN_SKILL_IDS.length);
  assert.throws(() => normalizeExtensions({ ...full, skills: [...full.skills, custom('overflow')] }), /128/);
  assert.throws(() => normalizeExtensions({ skills: [builtin({ builtin: 'unknown' })] }), /类型/);
  assert.throws(() => normalizeExtensions({ skills: [builtin(), builtin({ id: 'duplicate' })] }), /只能配置一个/);
  assert.throws(() => normalizeExtensions({ skills: [builtin({ agentIds: ['principal'] })] }, agents), /授权/);
  assert.throws(() => normalizeExtensions({ skills: [builtin({ agentIds: ['missing'] })] }, agents), /授权/);
  assert.equal(normalizeExtensions({ skills: [builtin({ enabled: undefined })] }).skills[0].enabled, false);
  const impersonator = { ...custom(builtin().id), name: builtin().name };
  assert.equal(isBuiltinSkill(normalizeExtensions({ skills: [impersonator] }).skills[0]), false);
  const update = prepareExtensionUpdate({ ...full, skills: full.skills.map(item => isBuiltinSkill(item) ? { ...item, content: 'Saved body', enabled: true, agentIds: ['alice'] } : item) }, full, agents, {});
  for (const item of update.extensions.skills.filter(isBuiltinSkill)) {
    assert.equal(item.content, 'Saved body');
    assert.deepEqual(item.agentIds, ['alice']);
  }
});

test('resource lookups accept only exact bundled paths and never filesystem paths or cross-skill names', () => {
  const slug = BUILTIN_SKILL_IDS[0], metadata = getBuiltinSkillMetadata(slug);
  assert.ok(metadata.files.includes('SKILL.md'));
  assert.equal(getBuiltinSkillMetadata('unknown'), undefined);
  assert.equal(readBuiltinSkillResource('unknown', 'SKILL.md'), undefined);
  for (const resourcePath of ['', '.', '..', '../SKILL.md', './SKILL.md', '/SKILL.md', 'C:/SKILL.md', 'C:\\SKILL.md', '\\\\host\\share', 'references/../SKILL.md', 'references//file.md', 'https://example.com/file.md', '%2e%2e/SKILL.md', `${metadata.source}/${slug}/SKILL.md`, 'SKILL.md\0']) {
    assert.equal(readBuiltinSkillResource(slug, resourcePath), undefined, resourcePath);
  }
  for (const resourcePath of metadata.files) assert.equal(typeof readBuiltinSkillResource(slug, resourcePath), 'string');
  assert.throws(() => metadata.files.push('outside.txt'), TypeError);
});

test('runtime authorization gates metadata and resources while configured bodies remain editable', async () => {
  const item = builtin({ enabled: true, agentIds: ['alice'], content: 'Edited runtime body' });
  const sourceConfig = [item], { instance, connections } = runtime(sourceConfig);
  assert.equal(instance.config.skills[0].builtin, item.builtin);
  item.content = 'Mutation after snapshot'; item.agentIds.push('bob');
  assert.deepEqual(instance.definitionsFor('bob'), []);
  assert.deepEqual(instance.definitionsFor(), []);
  await assert.rejects(instance.execute('bob', 'read_skill', { id: item.id, path: '../SKILL.md' }), /not authorized/);
  const definition = instance.definitionsFor('alice').find(entry => entry.name === 'read_skill');
  assert.ok(definition.parameters.properties.path);
  assert.ok(!JSON.stringify(definition).includes('Edited runtime body'));
  for (const args of [{}, { path: 'SKILL.md' }]) {
    const { page } = await read(instance, item.id, args);
    assert.equal(page.content, 'Edited runtime body');
    assert.equal(page.path, 'SKILL.md');
    assert.equal(page.source.id, getBuiltinSkillMetadata(item.builtin).source);
    assert.deepEqual(page.resources, getBuiltinSkillMetadata(item.builtin).files.slice(0, 20));
  }
  await assert.rejects(instance.execute('alice', 'read_skill', { id: item.id, path: '../SKILL.md' }), /exact path/);
  const forged = runtime([{ ...custom(item.id), name: item.name }]).instance;
  const forgedPage = (await read(forged, item.id)).page;
  assert.equal(forgedPage.source, undefined);
  assert.equal(forgedPage.resources, undefined);
  await assert.rejects(forged.execute('alice', 'read_skill', { id: item.id, path: 'references/anything.md' }), /exact path/);
  assert.throws(() => runtime([builtin({ builtin: 'unknown' })]), /Unknown built-in skill/);
  assert.throws(() => runtime([builtin(), builtin({ id: 'duplicate' })]), /configuration count/);
  assert.equal(connections(), 0);
});

test('resource text, directory cursors, evidence and bounded content pagination stay independent', async () => {
  const slug = BUILTIN_SKILL_IDS.find(id => getBuiltinSkillMetadata(id).files.some(file => file !== 'SKILL.md'));
  assert.ok(slug, 'The bundle must include supporting resources');
  const item = { ...seeded().skills.find(entry => entry.builtin === slug), enabled: true, agentIds: ['alice'], content: '观测值\\"\n'.repeat(600) };
  const { instance, connections } = runtime([item], 2048);
  let offset = 0, assembled = '', pages = 0;
  do {
    const { page, result } = await read(instance, item.id, { offset, limit: 24000 });
    assert.equal(result.truncated, false);
    assert.ok(Buffer.byteLength(result.output) <= 2048);
    assert.ok(page.content.length > 0);
    assembled += page.content; offset = page.nextOffset;
    assert.ok(++pages < 1000);
  } while (offset !== null);
  assert.equal(assembled, item.content);
  const files = getBuiltinSkillMetadata(slug).files;
  let resourceOffset = 0;
  const listed = [];
  do {
    const { page, result } = await read(instance, item.id, { limit: 1, resourceOffset, resourceLimit: 1 });
    assert.equal(result.truncated, false);
    assert.equal(page.resources.length, 1);
    listed.push(...page.resources); resourceOffset = page.nextResourceOffset;
  } while (resourceOffset !== null);
  assert.deepEqual(listed, files);
  const resourcePath = files.find(file => file !== 'SKILL.md');
  let evidence = '';
  const { page } = await read(instance, item.id, { path: resourcePath, limit: 41 }, { write: async bytes => { evidence += bytes.toString('utf8'); } });
  assert.equal(page.content, readBuiltinSkillResource(slug, resourcePath).slice(0, 41));
  assert.deepEqual(JSON.parse(evidence), page);
  assert.equal(page.path, resourcePath);
  assert.equal(connections(), 0);
});

test('profile migration adds missing skills without rewriting disk or replacing edited saved entries', async t => {
  const root = await temporaryProfileDirectory(t);
  const first = builtin(), userSkill = custom(first.id);
  const existing = { ...first, id: 'edited-builtin', name: 'Saved name', content: 'Saved edited body', enabled: true, agentIds: ['alice'] };
  const legacy = JSON.stringify({ version: 1, agents: [], settings: {}, extensions: { revision: 7, mcps: [], skills: [userSkill, existing] } });
  const filename = path.join(root, 'profiles.json');
  await fs.writeFile(filename, legacy);
  let store = await createProfileStore(root);
  assert.equal(await fs.readFile(filename, 'utf8'), legacy);
  assert.equal(store.config.extensions.skills.filter(isBuiltinSkill).length, BUILTIN_SKILL_IDS.length);
  assert.deepEqual(store.config.extensions.skills.slice(0, 2), [userSkill, existing]);
  await store.save(store.config);
  store = await createProfileStore(root);
  assert.equal(store.config.extensions.revision, 7);
  assert.deepEqual(store.config.extensions.skills.slice(0, 2), [userSkill, existing]);
  assert.equal(store.config.extensions.skills.filter(isBuiltinSkill).length, BUILTIN_SKILL_IDS.length);
});

test('saved profile default labels upgrade in memory and persist only on explicit save', async t => {
  const root = await temporaryProfileDirectory(t), current = seeded();
  const planning = {
    ...current.skills.find(skill => skill.builtin === 'solve-challenge'),
    id: 'saved-planning', name: 'solve-challenge', description: descriptionChanges['solve-challenge'][0],
    content: 'Saved planning body', enabled: true, agentIds: ['alice'],
  };
  const web = {
    ...current.skills.find(skill => skill.builtin === 'ctf-web'),
    id: 'saved-web', name: 'My Web workflow', description: 'Web漏洞分析与利用',
    content: 'Saved Web body', enabled: false, agentIds: ['teacher'],
  };
  const userSkill = { ...custom(), name: 'solve-challenge', description: descriptionChanges['solve-challenge'][0] };
  const legacy = JSON.stringify({ version: 1, agents: [], settings: {}, extensions: { revision: 31, mcps: [], skills: [planning, web, userSkill] } });
  const filename = path.join(root, 'profiles.json');
  await fs.writeFile(filename, legacy);
  let store = await createProfileStore(root);
  assert.equal(await fs.readFile(filename, 'utf8'), legacy);
  const expected = [
    { ...planning, name: 'CTF解题规划', description: 'CTF题型识别与解题流程组织' },
    { ...web, description: 'Web漏洞分析与利用(CTF版)' },
    userSkill,
  ];
  assert.deepEqual(store.config.extensions.skills.slice(0, 3), expected);
  assert.equal(store.config.extensions.revision, 31);
  await store.save(store.config);
  store = await createProfileStore(root);
  assert.deepEqual(store.config.extensions.skills.slice(0, 3), expected);
  assert.equal(store.config.extensions.revision, 31);
  assert.equal(store.config.extensions.skills.filter(isBuiltinSkill).length, BUILTIN_SKILL_IDS.length);
});
