import fs from 'node:fs/promises';
import path from 'node:path';

const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function normalizeTaskSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['name', 'description', 'goal'].includes(key))) fail('任务只接受名称、描述和目标');
  const result = {};
  for (const [key, label, limit] of [['name', '任务名称', 200], ['description', '任务描述', 12000], ['goal', '任务目标', 6000]]) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > limit) fail(`${label}不能为空，且最多${limit}个字符`);
    result[key] = value[key].trim();
  }
  return result;
}
export function taskSpecText(spec) {
  return `任务名称：${spec.name}\n\n任务描述：\n${spec.description}\n\n任务目标：\n${spec.goal}\n\n请围绕上述完整任务独立求解，由老师依据任务目标制定验收条件并验收；只有证据支持全部目标完成时才能判定完成。`;
}
export function normalizeSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['at', 'timeZone'].includes(key))) fail('定时设置格式无效');
  if (typeof value.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value.at) || !/(Z|[+-]\d\d:\d\d)$/.test(value.at) || !Number.isFinite(Date.parse(value.at))) fail('请选择有效的任务启动时间');
  if (typeof value.timeZone !== 'string' || value.timeZone.length > 100) fail('请选择有效的时区');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); } catch { fail('请选择有效的时区'); }
  return { at: new Date(value.at).toISOString(), timeZone: value.timeZone };
}

// One task owns its default output directory. No copy, deletion or symlink of
// the user's project is involved; explicit project paths remain available.
export async function createRunWorkspace(root, runId) {
  if (!/^run-[0-9a-f-]{36}$/.test(runId)) fail('无效任务编号');
  const base = await fs.realpath(root);
  let current = base;
  for (const segment of ['.class-runs', runId]) {
    current = path.join(current, segment);
    await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(base, await fs.realpath(current)).startsWith('..')) throw Object.assign(new Error('任务工作目录不可用，原文件已保留'), { status: 409 });
  }
  return current;
}
