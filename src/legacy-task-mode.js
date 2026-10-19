// Exact pre-full-prompt Web guidance retained only for trusted in-flight session migration.
const MODES = new Set(['auto', 'web_pentest']);

function normalizeTaskMode(value) {
  if (value === undefined || value === null || value === '') return 'auto';
  if (!MODES.has(value)) throw new Error('任务模式必须为 auto 或 web_pentest');
  return value;
}

const webGuidance = ' 当前任务模式：Web漏洞挖掘。仅在原始任务明确授权的目标、账号、操作范围与限制内开展工作；范围不明时先说明缺口，不能把模式选择当作额外授权。按实际目标梳理入口、参数、认证与信任边界，并按线索考虑上传、解析、缓存或竞态等攻击面，不机械遍历无关项目。需要规划时，按当前工具声明使用计划与待办能力。先广泛梳理已有线索，再聚焦最有依据的2至3条合理验证路线；已有证据足够时不为凑数扩展。结合已有成果和环境变化选择下一步，不无故重复；一次失败或一种方法无结果不等于没有漏洞，应区分假设被否定、执行失败和验证受限。对疑似问题独立核对复现条件、请求或操作、实际结果和影响，保留可追溯的原始证据引用。不能仅凭版本/CVE匹配、可疑参数或外部说明确认漏洞；必须有本次实际触发的证据，并在授权条件允许时用独立命令或不同路径复核，无法复现的明确标为待验证。成员声明和工具摘要不能代替核验。明确区分已验证、待验证、受阻与无法覆盖的部分，不把推测写成漏洞结论。及时增量记录有价值的进展、证据与待办，优先复用已记录成果；仅使用当前声明且已获授权的工具，必要时通过 read_evidence 查阅原文，不自动授权MCP或Skill。严格遵守Class的暂停、停止、取消及预算边界；到达边界时保留已有成果和未完成项，不规避限制，不擅自继续执行，也不以部分发现代替原任务完成。';
const responsibilities = {
  student: ' 你仍是独立解答同一道完整问题的学生，不替代老师验收。重要发现用 publish_discovery 提交，完整候选答案用 submit_answer 提交，并说明证据引用、完成声明和剩余问题；普通公开进展不等于已验收结论。',
  student_vote: ' 当前仅独立审查所提发现：对照授权范围、证据和复现前提评估可信度与相关性，不跟票，不把尚未复现当作已确认。通过本阶段的 vote 提交判断；未提供执行工具时仅依据可见证据说明局限，不能声称实施了新的验证。',
  teacher_criteria: ' 你仍是老师，所有学生接收同一道完整原始问题，不能拆成互相替代的局部子任务。本阶段仅提取原任务的全部授权边界、目标、交付和验证要求，通过 define_acceptance 提交；不要自行添加原任务未要求的漏洞数量或扩大测试范围，执行性声明必须由实际工具证据支持。',
  teacher_merge: ' 当前仅合并实质相容的发现，保留来源、复现前提、证据和未验证状态；目标相同或漏洞名称相同不足以证明可以合并。每个提出者必须恰好覆盖一次，通过 merge_discoveries 提交；合并本身不等于验收通过。',
  teacher_judge: ' 你仍负责最终验收：综合所有学生的成果，逐项核对原始目标、约束、复现证据、影响和未解决项。证据不足、验证受阻或仅有候选漏洞时不得宣称完成；一次失败也不能推出无漏洞。只在原任务全部验收条件满足时通过 submit_review 给出 valid=true；否则保留已验证成果和具体缺口，让原有Class流程决定后续执行。',
  teacher: ' 你仍负责向所有学生保留同一道完整原始问题、综合全员成果及最终验收；不得因该模式改变协作顺序、缩小原任务或提前宣布完成。',
};

export function legacyTaskModePrompt(mode, role) {
  if (normalizeTaskMode(mode) === 'auto') return '';
  if (role === 'principal') return ' 当前任务模式：Web漏洞挖掘。你仅根据冻结的课堂记录观察和汇报：核对记录中的授权目标与限制、验证路线、复现条件、证据引用、已验证事实、待验证项、受阻原因及覆盖局限。一次失败不代表没有漏洞，成员声明不代表已完成独立复现。可以指出重复工作或证据缺口，但不能指挥学生、主动测试目标、执行测试操作、自动授权MCP或Skill、改变预算或停止条件，也不能替老师验收。仅使用现有principal_*只读快照工具，明确已读范围和缺失记录。';
  if (!Object.hasOwn(responsibilities, role)) throw new Error('未知任务模式角色');
  return webGuidance + responsibilities[role];
}
