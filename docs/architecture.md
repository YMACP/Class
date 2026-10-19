# 架构与持续验收

[返回首页](../README.md) · [工具与恢复](tools.md) · [记忆机制](memory.md) · [任务状态与续跑](task-state.md) · [MCP 与 Skills](extensions.md)

Class 的调度核心与模型协议分离：`ClassEngine` 负责同题并行、发现讨论、候选审查、反馈和恢复；模型成员通过协议适配与工具执行器工作。当前发布目标为 Windows x64 和 Linux amd64，共用调度核心。

## 已实现的规则

- 至少两个学生，各自同时开始解同一道题，不是拆分成不同子任务。
- 任一学生提出重大发现后，暂停新的解题步骤和托管工具，收集 discoveryWindowMs 内到达的发现。
- 老师按实质语义合并相似发现，保留原文与全部提出者。来源丢失、伪造或重复分组会失败，不静默接受。
- 若同组发现的不同提出者人数 **严格超过全体学生半数**，无需投票，直接采纳。
- 否则排除该组的 **所有提出者**，其余学生独立投票，老师不投票。
- 投票超时、投票异常或无效格式的成员从本轮有效票分母中剔除；不会永久移出团队。
- 赞成票 **严格超过有效票的一半** 才通过。平票、少数票、零有效票均舍弃。
- 学生发现保留 accepted 与 rejected 记录，只有 accepted 可作为共同事实；老师反馈使用独立的 teacher_feedback 类型，无需学生投票。反馈内分别标明已核实事实、缺失项和建议，建议不等于事实。
- 黑板同时保留学生正式提交的答案与阶段成果、老师的合并与验收结论，标注成员、时间、轮次和处理状态，并关联该轮提交。最终综合答案在任务完成后置顶；停止、失败和历史任务仍可查看已留存成果。长内容可展开，完整成果以脱敏文本单独留存并通过运行档案分页查看；旧记录只展示实际留存的内容，不补造缺失原文。页面轮询不会因工具日志重建黑板，同一浏览器标签页刷新会保留展开和阅读位置。
- 投票结束后恢复工具和学生执行。投票期间迟到的新发现留到下一轮，不因等待已暂停工具而死锁。
- 候选答案进入队列，由协调器串行安排发现讨论与候选审查；全体学生可恢复暂停，保留同一实例、上下文、工具调用身份及已完成成果。验收阶段不终止学生工具，也不重做已执行的命令。
- 老师获得原任务、候选与来源、黑板、历史反馈和全员已有成果快照。未交卷学生的工具结果也可用于补齐答案；摘要中的证据引用可通过 read_evidence 查询，长输出可按 UTF-8 字节分页读取。冲突和缺失需继续核验，不能降低原任务标准。
- 审查未通过时，写入结构化反馈并恢复同一次任务。新反馈在学生的下一次实际模型请求边界注入，按成员记录版本；这表示上下文已交付，不保证模型必然理解。旧在途请求的成果保留，但未经最新反馈处理的候选不能立即再次触发审查。
- 同时到达的候选保留来源；否决后的候选会比较完整答案正文、证据说明、完成声明、未解决项和已识别的证据引用，忽略普通文本的空白排版差异，保留数学符号差异及带代码标记内容的内部空白。答案正文修改后，即使沿用原证据，也可再次送审，由老师判断是否真正改进；上述内容都未变化的重复候选暂缓送审，其他探索继续。答案不变但补充证据时，应在 evidence 中说明新依据，或在 evidenceRefs 中明确引用已有工具成果或已采纳发现；可引用其他学生或老师核验时产生的成果。无关工具活动、未知引用、同一成果的不同引用别名不会自动解锁旧候选。老师最终确认任务完成后才写入 completed，并保存综合去重后的最终答案与报告。
- 运行中的 phase 区分 solving、discussing、pausing、reviewing、publishing_feedback、resuming、waiting_recovery；三步进度条把循环审查归在“并行求解”，最终通过后完成“老师验收”。旧 answer_invalid 历史仍表示已失败，不能解释成新流程的临时否决。
- 用户可在求解、投票、审查、反馈发布及等待成员恢复时停止或清除任务。错误保留原因，不转换为答案无效；已完成的工具操作不因恢复而重做。
- Windows Web UI 不设固定任务时长、讨论轮数或单次模型请求时限，仍支持用户停止与退出；投票时限保留，发现合并窗口由程序内部协调。
- 原命令行的 taskTimeoutMs 是整个任务的总时限（包含讨论与老师验收）；maxRounds 是最大讨论轮数，不是每个学生的思考步数。两者以及 provider.timeoutMs 支持 null，表示不设置对应固定上限。
## 任务模式

课堂输入框左下角可选择“自动”“Web漏洞挖掘”“CTF题目求解”“二进制漏洞挖掘”“渗透测试”或扩展管理中新增的自定义模式。自动模式不追加模式提示词；四个专项模式分别完整加载 `src/web-pentest-prompt.js`、`src/ctf-solve-prompt.js`、`src/binary-audit-prompt.js`、`src/penetration-test-prompt.js` 中用户确认的提示词，通过静态导入进入Windows、Linux构建，不依赖桌面文档。`src/task-mode.js` 统一提供内置模式名称与正文，只在原文外围标明当前角色与阶段，不删减或概括正文，继续采用同题独立求解、黑板讨论和老师验收。校长只读取课堂快照，不因模式获得执行工具。Web模式关联3个MCP与8个Skill；CTF关联11个Skill及Windows的7个MCP、Linux的10个MCP；二进制模式关联11个Skill及Windows的5个MCP、Linux的6个MCP；渗透测试关联9个Skill及Windows的4个MCP、Linux的6个MCP。自定义模式按保存的扩展ID建立关联。临时授权和按需加载规则见 [扩展说明](extensions.md#模式关联与合并)。模式不改写全局扩展配置，不自动开启Jev或修改已选择的辅助判断环节。

模式在创建任务时确定，保存到历史记录、运行日志和恢复点；历史任务及续跑沿用原模式，旧记录缺省为自动。自定义模式连同名称、完整提示词和扩展引用保存为`taskModeDefinition`快照，删除目录项不改变已有任务；已删除的扩展或凭据不会因旧模式引用而恢复。新对话草稿可自由选择，查看已有任务时仅展示其固定模式。命令行配置的 `taskMode` 可选 `auto`、`web_pentest`、`ctf_solve`、`binary_audit`、`pentest`，省略时为自动；自定义模式使用`custom-UUID`及匹配的`taskModeDefinition`，缺少定义时明确拒绝。

升级前的Web任务若保存了在途模型会话，仅在原提示词、任务、成员、模型和协议的完整会话指纹匹配时迁移到新提示词。`src/legacy-task-mode.js` 只保存该兼容校验所需的旧正文；正常请求使用新全文。迁移保留原工具对话、完成记录和不确定状态，不重放已完成或结果不确定的操作。

Web 模式要求授权范围明确、实际触发与独立核验、可追溯证据和增量记录；原文与工具结果仍可按证据引用补读，未验证或受阻的方向不得直接当作确认漏洞。Jev 在该模式下额外保留包含复现条件、请求响应及待验证事项的工具结果段落。模式不增加工具依赖或调度阶段，模型判断仍需通过 Class 原有验收。

全文模式提示词会增加每次请求的输入长度。Class不裁剪其正文，Jev仍仅接收原有辅助判断所需的数据；模型实际支持的上下文长度继续受其服务端限制。

## 代码入口

- src/engine.js：不依赖具体模型的调度状态机，ClassEngine。
- src/task-state.js、src/checkpoint-store.js：结构化摘要、逐项验收和加密恢复点。
- src/model-protocol.js：模型接口地址规则与协议适配。
- src/agents.js：模型调用、学生动作、老师合并与验收、演示团队。
- src/task-mode.js：任务模式及按角色追加的 Web 漏洞挖掘准则。
- src/tools.js：工具与暂停/恢复控制，ToolManager。
- src/extension-config.js、src/extensions.js、src/mcp-client.js：按成员授权、按需加载 Skill 与 MCP 工具、连接及取消管理。
- src/browser-tools.js：统一浏览器工具、自动发现、成员隔离及浏览器生命周期；Edge/Chrome/Chromium 使用 CDP。
- src/firefox-browser.js：将现有浏览器操作映射到 Firefox 原生 WebDriver BiDi；复用上述生命周期，不增加调度阶段或自动化框架依赖。
- src/memory-store.js、src/memory-manager.js、src/memory-tools.js：本地会话和记忆存储、权限、索引、自动提取与评估及 Agent 工具。
- src/cli.js：原命令行入口。
- src/desktop.js：Windows 后台启动、单实例与退出。
- src/startup-support.js：浏览器打开与回退、启动日志和失败提示。
- src/web-server.js、src/profile-store.js：本地 API、任务生命周期与配置持久化。
- src/data-location.js：本地数据目录切换、迁移及启动位置记录。
- src/secret-store.js：Windows 账户加密凭据。
- public/：Web UI 源码。
- scripts/：界面嵌入、原生组件生成与 Windows x64、Linux amd64 打包。
- tests/release/：实际发布产物、记忆与浏览器界面的隔离验证。
- build/generated/：源码启动或打包自动生成的资源，不是手工编辑的源码。

以上路径均相对于仓库根目录；从本页查看源码时位于 `../src/`。

浏览器工具在 Windows 支持 Edge、Chrome、Firefox，在 Linux 支持 Chrome、Firefox 并保留 Chromium；默认优先发现原有 Chromium 系浏览器，再查找 Firefox，也可用 `CLASS_BROWSER_EXECUTABLE` 指定绝对路径。浏览器不随 Class 打包或自动下载；没有可用浏览器时在工具调用处报错，不阻止其他任务。Firefox 直接连接自身的 BiDi 接口，不需要额外驱动；要求 149 或更新版本，是为了维持所有受支持浏览器的下载禁用规则。协议依据见 [MDN：直接建立 BiDi 连接](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection) 和 [Firefox 149 下载控制](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/149#webdriver_bidi)。

接入其他平台时可直接 import ClassEngine，并提供学生 solve(ctx)、vote(proposal,ctx) 与老师 merge(discoveries,ctx)、judge(answer,ctx)。候选 answer 可附完成声明、未解决项和证据引用；老师 judge 的 valid:false 应附 report、verifiedFacts、gaps、recommendations、evidenceRefs，valid:true 可返回综合后的 answer 与 report。内置模型老师还会提取验收条件并返回 criteriaResults；自定义老师可通过 acceptanceRequired 与 extractCriteria 接入同样的逐项检查。事件通过 engine.on('event', listener) 订阅。旧版 DiscussionEngine、createDiscussionServer 导出名称以及 discussion.* 事件名称保留兼容；新接入使用 ClassEngine 与 createClassServer。任务结果的有效性依赖老师模型与提供的证据，不构成形式化正确性证明。持续反馈允许继续探索，不保证任意任务最终都能求解；新版桌面任务支持用户主动点击继续任务进行跨进程恢复，具体边界见[任务状态与安全续跑](task-state.md)。

源码中以下旧名称是有意保留的兼容约定：默认用户数据目录 `%LOCALAPPDATA%\discussion`、DPAPI 加密标识 `discussion.credentials.v1`、`DISCUSSION_*` 环境变量回退、旧导出别名、`discussion.*` 事件与错误码、旧实例及浏览器会话识别。它们不影响界面显示的 Class 名称；不要全局替换，否则可能影响旧密钥解密、配置读取和历史记录。源码文件夹改名不迁移用户数据目录。
