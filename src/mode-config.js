import { randomUUID } from 'node:crypto';
import { normalizeTaskMode, normalizeTaskModeDefinition, BUILTIN_TASK_MODES } from './task-mode.js';
import { getModeExtensionPreset } from './mode-extensions.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const builtinNames = Object.fromEntries(Object.entries(BUILTIN_TASK_MODES).map(([id, item]) => [id, item.name]));

export function normalizeModes(value = {}) {
  if (!object(value) || !Array.isArray(value.items ?? []) || (value.items ?? []).length > 64) fail(400, '最多配置64个自定义模式');
  const items = (value.items ?? []).map(item => {
    if (!object(item) || item.builtin !== undefined && item.builtin !== false || Object.hasOwn(builtinNames, item.id)) fail(400, '内置模式不能修改或删除');
    try { return normalizeTaskModeDefinition(item.id, item); }
    catch (error) { fail(400, error.message); }
  });
  if (items.some(item => !item) || new Set(items.map(item => item.id)).size !== items.length) fail(400, '模式ID无效或重复');
  return { revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0, items };
}

export function publicModes(config, extensions, { metadataOnly = false, platform = process.platform } = {}) {
  const modes = normalizeModes(config);
  const builtins = Object.entries(builtinNames).map(([id, name]) => ({
    id, name, builtin: true, prompt: BUILTIN_TASK_MODES[id].prompt,
    ...Object.fromEntries(['mcps', 'skills'].map(kind => [kind, (extensions?.[kind] ?? []).filter(item => getModeExtensionPreset(id, platform)[kind].includes(item.builtin)).map(item => item.id)])),
  }));
  const items = [...builtins, ...modes.items.map(item => ({ ...item, builtin: false }))];
  return { revision: modes.revision, items: metadataOnly ? items.map(({ id, name, builtin }) => ({ id, name, builtin })) : items };
}

export function resolveModeDefinition(mode, config) {
  mode = normalizeTaskMode(mode);
  if (Object.hasOwn(builtinNames, mode)) return undefined;
  const saved = normalizeModes(config).items.find(item => item.id === mode);
  if (!saved) fail(400, '所选模式不存在，请刷新后重新选择');
  return normalizeTaskModeDefinition(mode, saved);
}

export function taskModeName(mode, definition) {
  return builtinNames[mode] ?? definition?.name ?? '自定义模式';
}

function revision(body, previous) {
  if (!object(body) || body.revision !== previous.revision) fail(409, '模式配置已更新，请刷新后重试');
}

export function addMode(body, current, extensions) {
  const previous = normalizeModes(current); revision(body, previous);
  if (body.extensionRevision !== extensions.revision) fail(409, '扩展配置已更新，请刷新后重试');
  if (Object.keys(body).some(key => !['revision','extensionRevision','name','prompt','mcps','skills'].includes(key))) fail(400, '新增模式包含未知字段');
  let item;
  const id = 'custom-' + randomUUID();
  try { item = normalizeTaskModeDefinition(id, { ...body, id }); }
  catch (error) { fail(400, error.message); }
  for (const kind of ['mcps','skills']) {
    const available = new Set(extensions[kind].map(entry => entry.id));
    if (item[kind].some(id => !available.has(id))) fail(400, '关联的MCP或Skill不存在，请刷新后重试');
  }
  if (Object.values(builtinNames).includes(item.name) || previous.items.some(existing => existing.name === item.name)) fail(400, '模式名称已存在');
  return normalizeModes({ revision: previous.revision + 1, items: [...previous.items, item] });
}

export function deleteModes(body, current) {
  const previous = normalizeModes(current); revision(body, previous);
  if (Object.keys(body).some(key => !['revision','ids'].includes(key)) || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 64 || body.ids.some(id => typeof id !== 'string')) fail(400, '请选择要删除的模式');
  if (body.ids.some(id => Object.hasOwn(builtinNames, id))) fail(400, '内置模式不能删除');
  const selected = new Set(body.ids), existing = new Set(previous.items.map(item => item.id));
  if ([...selected].some(id => !existing.has(id))) fail(409, '所选模式已变化，请刷新后重试');
  return { revision: previous.revision + 1, items: previous.items.filter(item => !selected.has(item.id)) };
}

// Remove dangling links when a custom extension is deleted. Existing run and
// checkpoint definitions remain independent snapshots; credentials never live
// in these mode records and are not restored by resuming a historical task.
export function pruneModeExtensions(config, extensions) {
  const previous = normalizeModes(config);
  let changed = false;
  const available = Object.fromEntries(['mcps','skills'].map(kind => [kind, new Set(extensions[kind].map(item => item.id))]));
  const items = previous.items.map(item => {
    const next = { ...item };
    for (const kind of ['mcps','skills']) {
      next[kind] = item[kind].filter(id => available[kind].has(id));
      if (next[kind].length !== item[kind].length) changed = true;
    }
    return next;
  });
  return changed ? { revision: previous.revision + 1, items } : previous;
}
