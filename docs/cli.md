# 命令行与模型配置

[返回首页](../README.md) · [开发环境](development.md) · [示例文件](../examples/README.md) · [工具恢复规则](tools.md)

在 Windows 的源码根目录运行，先使用与设备架构一致的 Node.js 完成 `npm ci`。真实任务需要填写可用的模型与接口，并通过环境变量提供用户自己的 API key。

## 创建自己的配置

示例的 `cwd` 为 `./workspace`，相对于配置文件所在目录：`examples/config.json` 指向 `examples/workspace/`，复制到源码根目录的 `config.local.json` 则指向根目录的 `workspace/`。下列步骤创建自己的工作区并复制公开示例任务；如文件已经存在，请保留自己的任务内容，不重复覆盖。

```powershell
Copy-Item examples/config.json config.local.json
New-Item -ItemType Directory -Path workspace -Force
Copy-Item examples/workspace/problem.txt workspace/problem.txt
# 编辑 config.local.json：设置 provider.model、provider.baseUrl、cwd="./workspace" 和 task
$env:CLASS_API_KEY = 'YOUR_API_KEY'
npm run cli -- --config config.local.json --output-dir D:\Class\runs
# 或覆盖任务：
npm run cli -- --config config.local.json --task '你的具体任务' --output-dir D:\Class\runs
```

`YOUR_API_KEY` 和示例模型名都是占位符，运行前需替换为自己服务商提供的值。不要提交 `config.local.json`、密钥或运行目录。

## 接口与成员配置

通过 provider.protocol 选择以下模式；省略时按 Chat 处理，兼容旧配置。请求为非流式，接口和模型需要支持所选协议及原生工具调用；普通进展可以直接用文字回复，旧 JSON 动作继续兼容。

| 模式 | protocol | 追加后缀 | 基础地址示例 | 最终请求地址 |
| --- | --- | --- | --- | --- |
| Messages | messages | /v1/messages | https://api.anthropic.com | https://api.anthropic.com/v1/messages |
| Responses | responses | /responses | https://api.openai.com/v1 | https://api.openai.com/v1/responses |
| Chat | chat | /chat/completions | https://api.openai.com/v1 | https://api.openai.com/v1/chat/completions |

Messages 会自动追加 /v1/messages；例如 baseurl 填写 https://gateway.example/relay，请求地址为 https://gateway.example/relay/v1/messages。如果旧配置的地址已经以 /v1 结尾，会先去除这段后缀再拼接，避免重复 /v1。基础地址两端空白和末尾斜杠会去除；已有 Chat 自定义路径继续保留，编辑保存时按新规则检查。

Messages 使用 x-api-key 与 anthropic-version 请求头；Responses、Chat 使用 Bearer 认证。工具调用和工具结果分别使用对应协议格式，同时兼容原有 JSON 工具动作。启用原生协作时不强制整条回复为 JSON；配置中的 jsonMode=true 仅在无协作工具的 JSON 请求中启用 Chat 的 response_format.json_object 或 Responses 的 text.format.json_object，Messages 不发送这两种参数。新增成员默认不启用强制 JSON 格式；已有成员的配置继续保留。

“添加成员”默认选择 Messages，模型名称下可设置思考深度，初始选择 Medium。Messages 的选项为 Low、Medium、High、xHigh、Max、Ultracode；Responses 和 Chat 的选项为 Low、Medium、High、Extra high、Max、Ultra。baseurl 初始为空，灰色的 `https://api.openai.com/v1` 仅为占位示例，必须填写实际接口地址。编辑成员会回填已保存的协议、地址和思考深度。

思考深度保存在成员的 `reasoningEffort` 字段；命令行也可通过 `provider.reasoningEffort` 设置。值为 `low`、`medium`、`high`、`xhigh`、`max`，以及 Messages 的 `ultracode` 或 Responses/Chat 的 `ultra`。Messages 发送 `thinking: {type: "adaptive"}` 和 `output_config.effort`，Responses 发送 `reasoning.effort`，Chat 发送 `reasoning_effort`；连接测试及后续工具调用使用同一设置。旧成员未设置此字段时继续沿用接口默认行为，打开编辑框后保存则使用框内所选档位。

可用档位取决于接口与模型，参见 [Claude effort 文档](https://platform.claude.com/docs/en/build-with-claude/effort)、[OpenAI reasoning 文档](https://developers.openai.com/api/docs/guides/reasoning)和 [Chat 参数文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。`Ultracode` / `Ultra` 在此作为服务商扩展值原样发送，不自动降档，也不启动额外子成员；选择前需确认接口支持。它们并非上述普通 API 的通用 effort 值，不能等同于客户端的同名多智能体模式。

可在 teacher.provider 或每个 students[i].provider 中覆盖 protocol、model、baseUrl、apiKeyEnv 等，以组合不同模型与协议；未填写的字段继承全局 provider。命令行默认优先读取 CLASS_API_KEY，未设置时兼容 DISCUSSION_API_KEY；配置中显式指定 apiKeyEnv 时只读取该变量。Web UI 通过输入框配置，并以 Windows DPAPI 加密保存。模型拒绝、截断、接口错误或协议结构损坏按原因进入纠正、重试或成员隔离，不自动当作赞成或有效答案；恢复范围与次数见下述规则。

### 上下文容量

添加或编辑成员时，可在“思考深度”下方的“上下文容量”中勾选 **1M**。该选项按成员保存为布尔字段 `context1M`；新成员及未配置此字段的旧成员默认关闭。命令行也可设置 `provider.context1M: true`，或在成员配置中覆盖。

开启后，Class 按约 1,000,000 token 的本地估算预算保留更多工具调用历史和跨轮次历史，预留输出、系统提示与工具声明所需空间，并按完整调用与结果组裁剪。不同模型的分词方式不同，这不是精确 token 计数，也不会扩大模型或接口实际支持的窗口。关闭后沿用原有历史保留策略；选项不改变单次输出长度、不增加模型调用次数，也不发送虚构的通用上下文参数或已退役的 beta 请求头。上下文包含输入与输出，参见 [OpenAI 上下文说明](https://developers.openai.com/api/docs/guides/conversation-state#managing-the-context-window) 和 [Claude 上下文说明](https://platform.claude.com/docs/en/build-with-claude/context-windows)。

“测试连接”仍只执行普通短请求，不探测或认证 1M 能力。实际任务中，只有接口明确返回不支持 1M，或明确给出低于 1M 的最大上下文容量时，才提示“当前模型或接口不支持 1M 上下文，请取消勾选「1M」后重试”。受影响成员按原有机制暂停，其他可用成员继续；修改成员配置前需先停止任务。普通输入过长、输出额度不足、鉴权、限流和网络错误仍按其本身原因处理，不推断成不支持 1M。未触发容量错误并不代表已验证模型支持 1M。
## 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| voteTimeoutMs | 30000 | 每名学生投票超时毫秒 |
| taskTimeoutMs | 600000 | 整个任务总时限毫秒 |
| discoveryWindowMs | 100 | 并发发现收集窗口毫秒 |
| maxRounds | 100 | 最大讨论轮数 |
| provider.timeoutMs | 60000 | 单次模型请求超时毫秒 |
| allowShell | false | 显式启用可执行程序工具 |

`examples/config.json` 演示配置可覆盖这些默认值。入口还支持 `--config <文件>`、`--task <任务>`、`--output-dir <目录>`、`--demo` 和 `--no-memory`；`--help` 显示命令格式。`--demo` 使用固定确定性团队，不需要模型 API key。
## 结果与审计

Web UI 的配置及运行记录存放在 %LOCALAPPDATA%\discussion，运行记录目录为 history/。重启时未完成任务标记为中断，不会自动重放。内存和界面仅保留有界的近期摘要，完整事件、工具成果与长输出写入独立脱敏档案，查询支持分页；不再仅因累计超过 5000 个事件结束任务。摘要淘汰或截断不表示原始档案不存在；磁盘写入失败会如实停止任务并保留错误。档案与输出随数据目录迁移，并与对应历史记录一起保留和清理。旧记录没有档案时仍可阅读黑板和结果。

原命令行每次运行默认生成 runs/Class-*/，可用 --output-dir <目录> 或 CLASS_RUNS_DIR 指定存放位置；验证建议使用项目外的独立目录：

- result.json：成功或失败、原因、答案、老师报告、近期黑板与事件摘要。
- blackboard.json：原始发现、合并提出者、每票理由、超时剔除与最终决议。
- events.jsonl：实时顺序事件。
- journal.jsonl 与 outputs/：脱敏追加记录及独立工具输出，保留来源与调用身份，供老师和分页查询使用。

已知供应商密钥在 CLI 写入文件前替换为 [REDACTED]。任务文本和工具读取内容可能含其他敏感数据；它们会传给已配置供应商，也可能出现在报告中。不要把整个 runs 目录当作公开日志。

Ctrl+C 会取消任务并停止托管工具。正常返回时失败使用非零退出码。
