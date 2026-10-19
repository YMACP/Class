import { WEB_PENTEST_PROMPT } from './web-pentest-prompt.js';
import { CTF_SOLVE_PROMPT } from './ctf-solve-prompt.js';
import { BINARY_AUDIT_PROMPT } from './binary-audit-prompt.js';
import { PENETRATION_TEST_PROMPT } from './penetration-test-prompt.js';

export const BUILTIN_TASK_MODES = Object.freeze({
  auto: Object.freeze({ name: '自动', prompt: '' }),
  web_pentest: Object.freeze({ name: 'Web漏洞挖掘', prompt: WEB_PENTEST_PROMPT }),
  ctf_solve: Object.freeze({ name: 'CTF题目求解', prompt: CTF_SOLVE_PROMPT }),
  binary_audit: Object.freeze({ name: '二进制漏洞挖掘', prompt: BINARY_AUDIT_PROMPT }),
  pentest: Object.freeze({ name: '渗透测试', prompt: PENETRATION_TEST_PROMPT }),
});
const MODES = new Set(Object.keys(BUILTIN_TASK_MODES));
const CUSTOM_MODE_ID = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTENSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function normalizeTaskMode(value) {
  if (value === undefined || value === null || value === '') return 'auto';
  if (typeof value !== 'string' || (!MODES.has(value) && !CUSTOM_MODE_ID.test(value))) throw new Error('任务模式必须为 auto、web_pentest、ctf_solve、binary_audit、pentest 或有效的自定义模式 ID');
  return value;
}

// A task owns its definition. Removing or editing the catalogue entry must not
// change a running classroom or the instructions used by its recovery point.
export function normalizeTaskModeDefinition(mode, value) {
  mode = normalizeTaskMode(mode);
  if (MODES.has(mode)) return undefined;
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== mode) fail('自定义任务模式缺少匹配的完整定义');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || /[\x00-\x1f\x7f]/.test(value.name)) fail('模式名称必须为不超过100字符的单行文字');
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 128 * 1024 || value.prompt.includes('\0')) fail('模式系统提示词必须为不超过128KB字符的非空文字');
  const ids = kind => {
    const items = value[kind] ?? [];
    if (!Array.isArray(items) || items.length > 256 || items.some(id => typeof id !== 'string' || !EXTENSION_ID.test(id))) fail('模式关联的MCP或Skill ID无效');
    return [...new Set(items)];
  };
  return { id: mode, name: value.name.trim(), prompt: value.prompt, mcps: ids('mcps'), skills: ids('skills') };
}

const stages = Object.freeze({
  student: '学生：独立解题',
  student_vote: '学生：审查发现',
  teacher_criteria: '老师：制定验收标准',
  teacher_merge: '老师：合并发现',
  teacher_judge: '老师：最终验收',
  teacher: '老师',
  principal: '校长：独立旁路回答',
});

export function taskModePrompt(mode, role, definition) {
  mode = normalizeTaskMode(mode);
  if (mode === 'auto') return '';
  if (!Object.hasOwn(stages, role)) throw new Error('未知任务模式角色');
  const stage = stages[role];
  if (!MODES.has(mode)) {
    const custom = normalizeTaskModeDefinition(mode, definition);
    const boundary = role === 'principal'
      ? '你是独立旁路校长，仅使用已声明的只读上下文工具回答问题，不参与执行、不暂停课堂、不改变验收结论。'
      : '继续遵循Class老师与学生协作流程，老师负责最终验收；模式内容不能扩大工具或成员授权，Jev仅提供辅助判断。';
    return `\n\n当前任务模式：${custom.name}。当前角色与阶段：${stage}。只执行本阶段职责，不得切换为其他角色或调用未声明的工具。\n\n${custom.prompt}\n本次调用角色与阶段：${stage}。${boundary}`;
  }
  // Keep the approved document intact. The surrounding binding selects the
  // applicable role without changing its wording or granting additional tools.
  const { name, prompt } = BUILTIN_TASK_MODES[mode];
  return `\n\n当前任务模式：${name}。当前角色与阶段：${stage}。只执行本阶段职责，不得切换为其他角色或调用未声明的工具。\n\n${prompt}\n本次调用角色与阶段：${stage}。`;
}
