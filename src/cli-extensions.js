import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeExtensions, extensionSecrets, extensionSecretValues, ensureBuiltinMcpPresets } from './extension-config.js';
import { loadSecrets } from './secret-store.js';
import { normalizeTaskMode, normalizeTaskModeDefinition } from './task-mode.js';
import { buildModeExtensions, getModeExtensionPreset } from './mode-extensions.js';
import { ensureBuiltinSkillPresets } from './builtin-skills.js';
import { MAX_PROFILE_BYTES } from './profile-store.js';

// CLI uses its own task/member configuration. A profile import reads only the
// explicitly selected profile's extension settings and encrypted credentials.
export async function loadCLIExtensions(config, { profileDirectory, environment = process.env, loadProfileSecrets = loadSecrets } = {}) {
  let extensionConfig, profileSecrets, privateValues = {};
  if (profileDirectory) {
    if (config.extensions !== undefined) throw Error('Use either config.extensions or --extension-profile, not both');
    const directory = path.resolve(profileDirectory), filename = path.join(directory, 'profiles.json');
    if ((await fs.stat(filename)).size > MAX_PROFILE_BYTES) throw Error('Extension profile is too large (maximum 64MiB)');
    const raw = await fs.readFile(filename, 'utf8');
    if (Buffer.byteLength(raw) > MAX_PROFILE_BYTES) throw Error('Extension profile is too large (maximum 64MiB)');
    const profile = JSON.parse(raw);
    if (profile.version !== 1 || !Array.isArray(profile.agents)) throw Error('Unsupported extension profile');
    extensionConfig = normalizeExtensions(profile.extensions);
    profileSecrets = await loadProfileSecrets(directory);
  } else {
    extensionConfig = normalizeExtensions(config.extensions);
    if (environment.CLASS_EXTENSION_SECRETS) {
      if (environment.CLASS_EXTENSION_SECRETS.length > 1048576) throw Error('CLASS_EXTENSION_SECRETS exceeds size limit');
      try { privateValues = JSON.parse(environment.CLASS_EXTENSION_SECRETS); } catch { throw Error('CLASS_EXTENSION_SECRETS must be a JSON object'); }
      if (!privateValues || typeof privateValues !== 'object' || Array.isArray(privateValues)) throw Error('CLASS_EXTENSION_SECRETS must be a JSON object');
    }
  }
  const members = new Set([config.teacher?.id || 'teacher', ...(config.students || []).map(student => student.id)]);
  const taskMode = normalizeTaskMode(config.taskMode);
  const taskModeDefinition = normalizeTaskModeDefinition(taskMode, config.taskModeDefinition);
  if (taskMode !== 'auto') extensionConfig = buildModeExtensions(getModeExtensionPreset(taskMode) ? ensureBuiltinSkillPresets(ensureBuiltinMcpPresets(extensionConfig)) : extensionConfig, {
    taskMode, taskModeDefinition, agents: [{ id: config.teacher?.id || 'teacher', role: 'teacher' }, ...(config.students || []).map(student => ({ id: student.id, role: 'student' }))], grantModeDefaults: true,
  });
  // Importing a profile does not import its team or grant aliases to CLI roles.
  for (const kind of ['mcps', 'skills']) extensionConfig[kind] = extensionConfig[kind].map(item => ({ ...item, agentIds: item.agentIds.filter(id => members.has(id)) }));
  // Re-check credential bindings after mode activation, including a previously
  // disabled preset; a dormant stale endpoint must not receive credentials.
  if (profileSecrets) privateValues = extensionSecrets(profileSecrets, extensionConfig);
  const enabled = new Set(extensionConfig.mcps.filter(item => item.enabled && item.agentIds.length).map(item => item.id));
  privateValues = Object.fromEntries(Object.entries(privateValues).filter(([id]) => enabled.has(id)));
  const envelope = Object.fromEntries(Object.entries(privateValues).map(([id, value]) => ['extension:' + id, JSON.stringify(value)]));
  const knownSecrets = extensionSecretValues(envelope).flatMap(value => [value, ...(/^Bearer\s+\S+$/i.test(value) ? [value.replace(/^\S+\s+/, '')] : [])]);
  return { extensionConfig, extensionSecrets: privateValues, knownSecrets };
}
