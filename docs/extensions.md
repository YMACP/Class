# MCP 与 Skills

Class 1.2.0 保留老师布置任务、学生独立解题和老师验收的流程。扩展只增加已绑定角色可调用的能力，不改变任务调度，也不自动扩大角色权限。

## 配置与授权

- 在扩展配置中添加 MCP 或 Skill，启用并绑定现有角色后生效。模式预设可在本次任务内为尚未授权的预设分配所选老师和学生，规则见下文。未获任务授权的角色看不到该扩展的目录、正文或工具定义，后端也会拒绝其调用。
- 每次任务使用一份配置快照。修改配置用于后续任务，进行中的任务保留开始时的设置。
- MCP 支持 `stdio`、Streamable HTTP（`http`）和旧式 HTTP+SSE（`sse`）。`stdio` 使用配置中的可执行程序和参数，默认运行目录是任务工作目录，可显式指定存在且可访问的绝对目录 `cwd`；通用连接入口不通过 shell 解析命令。仅受支持的内置默认预设可在所需工具已安装时，使用固定配方补齐 MCP 依赖，详见“按需准备与连接”。
- 添加或编辑 MCP 时，顶部切换传输方式。`stdio` 填写名称、命令、空格分隔的参数与环境变量；`http`/`sse` 填写名称、服务器地址与请求头。环境变量和请求头均使用每行一个 `KEY=VALUE`，按第一个等号分隔，值中可包含等号；不接受 JSON 文本输入。空白输入保留已保存的私密值，已有键可单独勾选删除。
- “跳过HTTPS校验”默认关闭，仅作用于当前 HTTP/SSE 服务，不改变其他连接或系统的证书验证设置。
- 环境变量和 HTTP 请求头由凭据存储提供，不放入模型提示词。需要密钥时使用环境变量或请求头，避免把密钥直接写进命令参数、URL、说明或 Skill 正文。
- 保存的凭据绑定对应的连接配置。若保存过程中程序意外退出，导致地址或命令与凭据不匹配，调用会停止并提示重新保存，避免把凭据发送到错误服务。
- 每张 MCP 卡片在启用/停用右侧提供“测试连接”。测试使用已保存的配置完成连接和工具列表检查，显示工具数量或失败原因；停用、未授权的 MCP 也可测试，不改变启用状态或成员授权，不执行服务中的工具。测试结束后关闭本次连接及其启动的本地 MCP 进程；不会关闭用户自行启动的远端服务。
- Skill 是 Markdown 指南，支持粘贴或导入正文；它不是可执行插件，不会自动运行其中的脚本。

## 模式关联与合并

扩展管理的“模式”页展示“Web漏洞挖掘”“CTF题目求解”“二进制漏洞挖掘”“渗透测试”和用户新增的模式，不展示“自动”卡片；课堂下拉框仍保留“自动”，沿用已启用且已授权的MCP、Skills及既定工作流，不附加模式提示词或预设扩展。点击模式卡片可查看关联的MCP、Skills及完整系统提示词；“添加模式”保存名称、关联项目和提示词后，可在课堂输入栏直接选择。模式只为本次任务合并关联能力，保留已有显式成员授权及按需加载逻辑，校长仍仅能使用旁路只读工具，Jev仍只做辅助判断。

每个任务将自定义模式定义保存到会话与续跑快照。删除模式不删除其MCP或Skills，也不改写旧会话；旧任务按原定义续跑。删除自建扩展会清理模式目录中的关联，历史快照中已有的引用不恢复被删除的连接、凭据或工具授权。配置修改沿用原有限制：主任务运行时不能修改，先停止任务再操作。

自建MCP、Skill和模式支持单个及批量删除，均需在确认模态框中确认。混合勾选时只对自建项目执行删除，内置项目始终保留；仅选中内置项目时垃圾桶不可用。后端同时检查内置身份、配置版本和整批有效性，避免绕过页面保护或使用过期选择误删。删除MCP同步清理该连接的私密配置，不卸载用户本机工具。

“自动”模式沿用用户已启用并授权的扩展，不额外加入模式预设。“Web漏洞挖掘”模式在本次任务的配置快照中加入以下能力：

| 类型 | 模式预设 |
| --- | --- |
| MCP | `browser`、`burpsuite`、`tscan` |
| Skill | `ctf-web`、Web渗透测试、API安全测试、越权检测、业务逻辑漏洞分析、XSS检测、网络扫描、攻击面发现 |

“CTF题目求解”模式使用 `src/ctf-solve-prompt.js` 中的完整已确认提示词，随源码静态加载，不依赖桌面Markdown文件。该内置模式不能删除；选择模式后为本次任务关联以下能力：

| 类型 | 模式预设 |
| --- | --- |
| Windows、Linux共同MCP | `browser`、`burpsuite`、`wireshark`、`jadx` |
| Windows追加MCP | `cyberchef`、`ida`、`x64dbg` |
| Linux追加MCP | `ghidra`、`gdb`、`sageMath`、`pwntools`、`zsteg`、`binwalk` |
| Skill | `solve-challenge`、`ctf-web`、`ctf-pwn`、`ctf-reverse`、`ctf-crypto`、`ctf-forensics`、`ctf-misc`、`ctf-osint`、`ctf-malware`、`ctf-ai-ml`、`ctf-writeup` |

CTF预设按Class所在系统选择，迁移过来的其他系统预设不会被模式自动开启；用户原先手动启用并授权的扩展仍保留。CLI选择CTF模式时也补齐相应内置目录，连接和读取仍按需进行。Jev沿用用户现有开关，对识别到的flag候选、密码学参数、偏移与验证证据保留完整输出；未启用Jev时走原有流程。

“二进制漏洞挖掘”使用 `src/binary-audit-prompt.js` 中的完整已确认提示词；“渗透测试”使用 `src/penetration-test-prompt.js` 中的完整已确认提示词。两者均为不可删除的内置模式，静态打包，不依赖桌面原文；模式的名称与正文由 `src/task-mode.js` 统一提供。

| 模式 | Windows MCP | Linux MCP | Skill |
| --- | --- | --- | --- |
| 二进制漏洞挖掘 | `wireshark`、`ida`、`x64dbg`、`windbg`、`cyberchef` | `wireshark`、`ghidra`、`gdb`、`pwntools`、`AFL++`、`binwalk` | 二进制漏洞分析、`ctf-reverse`、`ctf-pwn`、Ghidra逆向分析、Linux程序分析、模糊测试、固件提取、网络流量分析、内存取证、Android逆向分析、.NET逆向分析，共11项 |
| 渗透测试 | `browser`、`burpsuite`、`tscan`、`wireshark` | `browser`、`burpsuite`、`tscan`、`wireshark`、`metasploit`、`bloodhound` | 网络扫描、攻击面发现、Web渗透测试、API安全测试、越权检测、业务逻辑漏洞分析、XSS检测、网络流量分析、域内攻击路径分析，共9项 |

两模式同样按当前宿主系统筛选MCP，CLI补齐当前系统的内置目录，并保留用户手动启用及授权的其他扩展。表中关联只建立本次任务的可用目录，工具连接和Skill正文读取仍按需进行；例如读取.NET或内存取证Skill，不表示已安装dnSpy或Volatility。Jev仅在已开启的环节辅助判断，二进制模式保护识别到的崩溃、寄存器、偏移和样本证据，渗透测试模式保护识别到的请求响应、权限路径及服务识别证据；证据保护不代表自动确认漏洞。

用户已启用的内置和自建扩展一并保留，并继续遵守成员授权。模式预设已有明确授权时不扩大授权；尚无授权的模式预设仅为本次任务所选老师和学生提供，不分配给校长。模式选择不会修改扩展管理页的全局启用状态、授权或连接参数，切回“自动”后的新任务也不会继承上一任务的临时授权。

这里只建立可用目录，不在任务开始时批量启动全部 MCP 或读取全部 Skill 正文。同名不代表重复：只有实际连接、凭据和适用授权等一致的 MCP，或正文及资源身份一致的 Skill，才在当前成员的发现目录中合并；显式指定已授权 ID 仍可访问。Jev 的语义相似判断仅用于优先级提示，不能删除配置或扩张权限。

## 按需准备与连接

成员需要某项能力时才发现并连接对应 MCP。连接成功后复用本次任务的连接；失败时只对已选中、已授权的内置预设进行受限检查：

1. 本机未检测到对应工具时跳过，并提示配置方法，不安装整套浏览器、调试器或分析软件。
2. 对已安装工具且符合固定配方的默认预设，可在 Class 管理的独立目录准备运行环境和固定版本的 MCP 依赖，再重新连接。目前配方覆盖 Wireshark 的 TShark 与 Windows 的 WinDbg/CDB 接入；不使用模型生成的安装命令，不改写用户的自定义命令或全局扩展配置。
3. Burp、TscanPlus 等需要用户启动的应用服务，以及 IDA、JADX、Ghidra 等需要在应用内配置的插件，仍按卡片内配置指南操作。检测到工具不等于其插件或服务已启动；Class 会提示具体未完成步骤，不把它报告为连接成功。
4. 未支持的环境、下载失败或连接仍失败时保留明确结果，其他可用扩展继续工作。MCP 握手与工具目录成功也不等于目标文件已打开或所有分析功能已验证。

Jev 启用后，`search_tools` 和 `search_skills` 可把当前任务摘要、查询词及已授权目录的名称和说明交给 Jev 辅助排序。Jev 不接收扩展密钥、请求头、环境变量、启动命令或 Skill 正文，也不能授权成员或执行安装。未启用、超时或判断不确定时保留原有发现方式；明确指定 ID 的调用仍由原有授权检查决定。

## 内置 browser

扩展管理预置一个 `browser` MCP，默认停用且不授权任何成员。手动启用并选择老师或学生后，该成员可通过 `search_tools` 按需加载；校长不能获授权。默认传输为 `stdio`，命令为 `Class`，参数为 `--browser-mcp`。这一预置组合由运行中的 Class 解析为自身的 MCP 服务入口，不要求把 Class 加入 PATH，也不安装 Node、Python、Playwright 或浏览器。源码运行时复用当前 Node/Bun，发行版直接启动自身。

每个成员的 MCP 服务按需启动，浏览器仍在实际操作时启动，并沿用原有浏览器实现。服务和其浏览器随课堂暂停、继续及停止进行管理。也可将 browser 改为其他本地命令或 HTTP/SSE 地址；保存后保留同一个 browser 条目及授权。旧版进程内 browser 配置加载时转为上述 stdio 默认值。

电脑仍需安装受支持的浏览器：Windows 支持 Edge、Chrome、Firefox，Linux 支持 Chrome、Firefox（也兼容 Chromium）；Firefox 需 149 或更新版本。该授权只控制 MCP 入口，原生 `browser` 工具仍按原有方式提供，浏览器会话与 stdio 服务相互独立。加载旧版配置时会补齐缺失预设；管理API拒绝删除现有内置条目或修改其内置身份，同名或同 ID 的自建 MCP 不会被替换。最多保留 64 个自建 MCP，预置 browser 不占用此额度。

## 预置 burpsuite

扩展管理预置 `burpsuite` MCP，默认停用且不授权任何成员，传输方式为 `sse`，默认地址为 `http://127.0.0.1:9876`，不需要填写本地启动命令或 Burp 安装路径。用户先启动 Burp Suite，并安装、启用 [PortSwigger 官方 MCP 扩展](https://github.com/PortSwigger/mcp-server)，再在 Class 中启用该项、授权给所需老师或学生。若 Burp 使用了其他地址或端口，可通过“编辑配置”修改。

Class 只预置连接配置，不安装、启动或关闭 Burp。课堂中只有已授权成员按需发现工具时才建立 SSE 连接；用户也可手动点击“测试连接”检查服务。未被手动启用或模式纳入的服务不会自动访问。已有名称、地址、启用状态和授权在升级及重新保存时保留。预置 burpsuite 与 browser 均不占用 64 个自建 MCP 的额度；同名或同 ID 的自建条目不会被覆盖。Burp 暂未运行时，连接失败按现有 MCP 工具错误处理，不影响其他未使用它的任务。

## 预置 tscan

Windows 和 Linux 版均预置 `tscan` MCP，用于连接 [TscanPlus](https://github.com/TideSec/TscanPlus)。默认停用、无成员授权，传输方式为 `http`，地址为 `http://127.0.0.1:8088/mcp`。卡片提供编辑配置、启用/停用、测试连接和配置指南；用户仍通过“授权成员”选择可使用它的老师或学生。

用户先下载对应系统的 TscanPlus，进入“AI辅助 → MCP服务配置”，选择 Streamable HTTP，以 `127.0.0.1:8088` 启动服务，再回到 Class 测试连接、启用并授权。也可在 TscanPlus 所在目录通过命令行启动：

```powershell
# Windows PowerShell
.\TscanPlus_Win_Amd64.exe mcp serve -listen 127.0.0.1:8088 -transport streamable
```

```bash
# Linux
chmod +x ./TscanPlus_Linux_Amd64
./TscanPlus_Linux_Amd64 mcp serve -listen 127.0.0.1:8088 -transport streamable
```

默认本地服务的请求头留空。端口改变时同步修改 Class 中的地址；若选择 SSE，TscanPlus 参数改为 `-transport sse`，Class 传输方式改为 `sse`，地址使用 `http://127.0.0.1:8088/sse`。Linux 版 TscanPlus 需要 GTK3、WebKitGTK 4.1 等运行库，命令行模式同样依赖这些库。

Class 只保存连接预设，不安装、启动或关闭 TscanPlus，不将其可执行文件或依赖打包进 Class。连接和成员授权沿用现有 MCP 机制；未被手动启用或模式纳入时不会自动连接。升级仅补齐缺失预设，保留已编辑的名称、地址、启用状态、授权及凭据，不覆盖同名或同 ID 的自建 MCP，也不占用 64 个自建 MCP 的额度。

## 预置 jadx

Windows 和 Linux 版均预置 `jadx` MCP（Android反编译与代码分析工具），默认停用、无成员授权，使用 `http` 连接 `http://127.0.0.1:8651/mcp`。卡片提供配置指南、编辑配置及测试连接，沿用现有按需发现和成员授权机制。

1. 安装 [JADX-GUI 1.5.1+](https://github.com/skylot/jadx/releases) 与 [uv](https://docs.astral.sh/uv/getting-started/installation/)；Java 环境按所选 JADX 发行包的说明配置。
2. 从 [JADX AI MCP V6.4.1](https://github.com/zinja-coder/jadx-ai-mcp/releases/tag/V6.4.1) 下载 `jadx-ai-mcp-6.4.1.jar`、`jadx-mcp-server-6.4.1.zip` 并解压 ZIP。在 JADX 的 `Preferences → Plugins → Install plugin → Select Plugin jar` 选择 JAR 并安装，随后重启 JADX。
3. 打开目标 APK，在 `Plugins → JADX AI MCP Server → Server Status` 确认插件服务运行于 `8650`；未运行时点击 `Restart Server`。
4. 在含 `jadx_mcp_server.py` 的目录运行下列命令，保持终端和 JADX 开启。uv 首次运行会准备 Python 3.12 和脚本声明的依赖。

```text
uv run --python 3.12 jadx_mcp_server.py --http --host 127.0.0.1 --port 8651 --jadx-host 127.0.0.1 --jadx-port 8650
```

5. 回到 Class，保留 `http` 与 `http://127.0.0.1:8651/mcp`，请求头留空；测试连接后启用并授权。

插件的 `8650` 是供桥接服务访问的 REST 端口，Class 连接的是 `8651/mcp`。测试连接只验证 MCP 握手和工具目录，分析 APK 还需要 JADX 插件正常运行并打开目标。Class 不打包或自动安装、启动、关闭 JADX 与外部桥接服务。升级补齐缺失预设，保留用户已有地址、名称和授权。

## Windows 分析工具预设

Windows 版另提供 `cyberchef`（数据分析工具）、`wireshark`（网络流量分析工具）、`windbg`（二进制漏洞分析工具），均默认停用且无成员授权。每张卡片提供图标、编辑配置、启用/停用、测试连接及配置指南；授权继续使用卡片外的“授权成员”。它们不占用 64 个自建 MCP 的额度，不改变老师、学生、Jev 或课堂调度。Linux 新建配置不自动添加 CyberChef 和 WinDbg；Wireshark 使用下文的 Linux 启动配置。跨系统迁移时保留用户已有配置，不自动改写已有命令。

这些预设不把 Node.js、Python、Wireshark 或 Windows 调试器打包进 Class。用户可以按下表预先安装；Wireshark 与 WinDbg 的默认预设也可在工具已安装时使用上文的受限依赖准备流程。安装后重启 Class，使新的 PATH 生效。若使用独立 Python 环境，可将命令改为该环境中 `python.exe` 的完整路径；自定义配置由用户维护。

| 预设 | 预先安装 | 默认 stdio 命令与参数 |
| --- | --- | --- |
| [CyberChef](https://github.com/doublegate/CyberChef-MCP) | Node.js 26.x；`npm.cmd install -g cyberchef-mcp@4.2.0` | 命令 `cmd.exe`；参数 `/d /s /c cyberchef-mcp` |
| [Wireshark](https://github.com/bx33661/Wireshark-MCP) | Python 3.12、Wireshark 的 TShark 组件；`python -m pip install wireshark-mcp==3.1.0` | 命令 `python`；参数 `-m wireshark_mcp serve --transport stdio --profile analysis` |
| [WinDbg](https://github.com/svnscha/mcp-windbg) | Python 3.12、WinDbg/Windows 调试工具；`python -m pip install mcp-windbg==1.5.1` | 命令 `python`；参数 `-m mcp_windbg --transport stdio` |

CyberChef 指南使用环境变量 `CYBERCHEF_TOOL_SURFACE=index` 与 `CYBERCHEF_TRANSPORT=stdio`，通过发现工具和 `cyberchef_bake` 按需执行运算，避免一次展开全部工具。Windows npm 的 `.cmd` 入口由显式 `cmd.exe` 启动，其他 MCP 的通用启动逻辑保持不变。

Wireshark 默认使用 `analysis` 工具集分析已有 PCAP/PCAPNG 文件，无需打开 Wireshark 窗口；安装 MCP Python 包并不等于已安装 TShark。若 Wireshark 不在 PATH 中，在该卡片的环境变量中设置 `WIRESHARK_MCP_TSHARK_PATH` 和 `WIRESHARK_MCP_CAPINFOS_PATH`，分别填写 `tshark.exe` 和 `capinfos.exe` 的完整路径，值不加引号。配置指南包含默认安装位置的示例。

WinDbg 预设使用社区 `mcp-windbg`，通过 CDB/KD 调试器工作，无需预先打开 WinDbg GUI；它与微软 WinDbg 内置 MCP 是不同接入方式。仅该预设的 Windows stdio 子进程额外继承 `LOCALAPPDATA` 路径用于定位商店版调试器，可由其环境变量配置覆盖。找不到调试器时可在参数中显式指定 `--cdb-path` 或 `--kd-path`，含空格的路径使用双引号。

课堂运行时，只有已授权成员发现工具才启动对应进程，沿用现有暂停、恢复、停止和错误处理机制；手动“测试连接”会单独启动一次检查进程。未安装外部依赖时返回 MCP 连接或工具错误，不影响未调用这些预设的任务。

## Linux 分析工具预设

Linux 版新增以下八项，均默认停用、无授权，并提供专属图标、编辑配置、测试连接和配置指南。`sageMath` 与 `AFL++` 是显示名称，对应内置标识为 `sagemath`、`aflpp`。指南根据 Class 服务端返回的平台选择，Wireshark 不依赖打开网页的浏览器系统来判断 Windows 或 Linux。

| 预设 | 用途 | 默认连接 |
| --- | --- | --- |
| Wireshark | 网络流量分析工具 | `stdio`，命令 `wireshark-mcp`，参数 `serve --transport stdio --profile analysis` |
| sageMath | 数学与密码分析工具 | `stdio`，命令 `sagemath-mcp`，参数 `--transport stdio` |
| pwntools | 二进制题目分析工具 | `stdio`，命令 `Class`，参数 `--local-analysis-mcp pwntools` |
| metasploit | 渗透测试框架 | `http`，地址 `http://127.0.0.1:3000/` |
| bloodhound | 域环境关系分析工具 | `stdio`，命令 `bloodhound-mcp`，参数留空 |
| zsteg | 图片隐写分析工具 | `stdio`，命令 `Class`，参数 `--local-analysis-mcp zsteg` |
| binwalk | 固件分析与提取工具 | `stdio`，命令 `Class`，参数 `--local-analysis-mcp binwalk` |
| AFL++ | 模糊测试工具 | `stdio`，命令 `aflpp-mcp`，参数留空 |

Class 仅自带 pwntools、zsteg、binwalk 的轻量 MCP 适配器；对应的 Python 包、Ruby 工具和 Binwalk 程序仍需用户安装。其他五项使用外部 MCP 服务。Class 不打包 SageMath、TShark、Metasploit、BloodHound、AFL++ 或这些服务的运行库。TShark 已安装时，Wireshark 默认预设可使用受限依赖准备流程；其他项目按以下指南配置。所有预设继续沿用现有按需连接、成员授权和任务快照机制；升级补齐缺失条目，保留已有名称、连接参数、启用状态、授权和凭据，不覆盖自建条目。

以下命令面向 Linux；`apt` 示例适用于 Ubuntu / Debian，其他发行版使用对应包管理器。安装 [uv](https://docs.astral.sh/uv/getting-started/installation/) 后可运行 `uv tool update-shell` 更新终端 PATH，再重新登录或重开终端并重启 Class。若终端能启动而 Class 找不到命令，用 `command -v 工具名` 查到绝对路径，填入该卡片的“命令”。`Class --local-analysis-mcp …` 由 Class 解析自身入口，不要求把 Class 加入 PATH。

完成每项配置后，先保存并点击“测试连接”，再点击“启用”，勾选卡片 →“授权成员”→ 选择老师或学生 →“保存授权”。测试连接完成 MCP 握手和工具目录检查；pwntools、zsteg、binwalk 适配器还会检查依赖可用性，但不读取目标文件或执行用户分析脚本。具体分析功能、数据文件或数据库是否可用，仍需相应实际调用确认。

### Wireshark

安装 TShark 和固定版本的 [Wireshark MCP](https://github.com/bx33661/Wireshark-MCP)：

```bash
sudo apt install tshark
uv tool install --python 3.12 wireshark-mcp==3.1.0
command -v wireshark-mcp
command -v tshark
command -v capinfos
```

保留表中的命令及参数。默认 `analysis` 工具集处理已有 PCAP/PCAPNG 文件，不需要打开 Wireshark 或授予实时抓包权限。若 PATH 无法定位依赖，在环境变量中分别设置 `WIRESHARK_MCP_TSHARK_PATH`、`WIRESHARK_MCP_CAPINFOS_PATH` 为上面查询到的实际绝对路径。

### sageMath

[sagemath-mcp 0.9.5](https://github.com/XBP-Europe/sagemath-mcp) 可使用独立安装的数学运行库，首次下载体积较大，应在测试连接前完成：

```bash
uv tool install --python 3.12 'sagemath-mcp[passagemath]==0.9.5'
command -v sagemath-mcp
```

已有可用 SageMath 时，可改用 `uv tool install --python 3.12 sagemath-mcp==0.9.5`，并在 Class 环境变量中设置 `SAGEMATH_MCP_SAGE_BINARY` 为 `command -v sage` 显示的绝对路径。两种安装方式任选一种；均使用 `sagemath-mcp --transport stdio`。

### pwntools

安装 [官方 pwntools](https://docs.pwntools.com/en/stable/install.html) 到适配器默认查找的独立环境：

```bash
sudo apt install python3 python3-venv python3-dev build-essential binutils libssl-dev libffi-dev
python3 -m venv "$HOME/.local/share/class-mcp/pwntools"
"$HOME/.local/share/class-mcp/pwntools/bin/python" -m pip install pwntools==4.15.0
```

Class 命令保留 `Class`，参数保留 `--local-analysis-mcp pwntools`。默认 Python 路径为 `~/.local/share/class-mcp/pwntools/bin/python`；使用已有环境时，先激活环境并运行 `command -v python`，把结果填入环境变量 `CLASS_PWNTOOLS_PYTHON`。此处填写实际解释器的绝对路径，Class 不展开配置值中的 `~` 或 `$HOME`。适配器调用本机 pwntools，不依赖占位功能的第三方 pwntools MCP 包，也不提供操作系统级隔离。

### zsteg

安装 [官方 zsteg](https://github.com/zed-0xff/zsteg) 和用于类型识别的 `file`：

```bash
sudo apt install ruby ruby-dev build-essential file
gem install --user-install zsteg
command -v zsteg
printf "%s/bin/zsteg\n" "$(gem env user_gemhome)"
```

Class 命令为 `Class`，参数为 `--local-analysis-mcp zsteg`。Ruby 用户安装目录不一定在 PATH 中；若 `command -v` 无输出，在环境变量 `CLASS_ZSTEG_PATH` 中填写最后一行输出的绝对路径。该工具用于 PNG/BMP 隐写分析；连接测试不会读取图片。

### binwalk

先安装 [Rust 工具链](https://rustup.rs/)，再按 [官方 Cargo 安装方式](https://github.com/ReFirmLabs/binwalk/wiki/Cargo-Installation) 安装 Binwalk v3：

```bash
sudo apt install build-essential libfontconfig1-dev liblzma-dev binutils
cargo install binwalk --version 3.1.0 --locked
command -v binwalk
```

Class 命令为 `Class`，参数为 `--local-analysis-mcp binwalk`。若 PATH 无法找到 Binwalk，在环境变量 `CLASS_BINWALK_PATH` 中填写查询到的绝对路径。Cargo 不会安装所有外部解包器；提取特定固件格式前仍需安装 [官方列出的提取器依赖](https://github.com/ReFirmLabs/binwalk/blob/master/dependencies/README.md)。

### metasploit

使用 Rapid7 官方 `msfmcpd`。先按 [Ruby 官方安装说明](https://www.ruby-lang.org/en/documentation/installation/) 安装 Ruby 3.3.8，并按 [Metasploit 开发环境文档](https://docs.metasploit.com/docs/development/get-started/setting-up-a-metasploit-development-environment.html) 准备系统依赖。以下固定源码版本包含 MCP 入口：

```bash
sudo apt install git autoconf build-essential libpcap-dev libpq-dev zlib1g-dev libsqlite3-dev
git clone https://github.com/rapid7/metasploit-framework.git
cd metasploit-framework
git checkout b22ce1fbae63e8caeb3a773366a6d3336bd66fb8
gem install bundler -v 2.5.22
bundle _2.5.22_ install
MSF_API_TYPE=messagepack MSF_API_HOST=127.0.0.1 MSF_API_PORT=55553 MSF_API_SSL=true MSF_MCP_HOST=127.0.0.1 MSF_MCP_PORT=3000 ./msfmcpd --mcp-transport http
```

保持终端运行，在 Class 中选择 `http`、地址 `http://127.0.0.1:3000/`。请求头输入一行 `Authorization=Bearer ` 后紧接启动终端显示的实际令牌，不要使用文档中的示例令牌。默认每次启动都会生成新令牌；若需固定令牌，在外部服务启动前自行设置 `MSF_MCP_AUTH_TOKEN`，并同步保存到 Class。该环境变量属于 Metasploit 服务进程，不能放在 Class 的 HTTP 请求头里代替 Authorization。

未运行本地 MessagePack RPC 时，官方入口会自动启动它并生成凭据。已有 RPC 服务时，需设置其真实 `MSF_API_USER`、`MSF_API_PASSWORD`，可添加 `--no-auto-start-rpc` 复用；地址、端口和 SSL 设置应与现有 RPC 一致。数据库查询另需可用的 PostgreSQL 与 `msfdb init` / `msfdb start`，缺少数据库不代表全部工具可用。Ruby 找不到时用 `command -v ruby` 检查安装路径。

模块执行、check、会话写入及停止操作默认关闭。只有用户需要这些能力时，才在启动 `msfmcpd` 时添加 `--enable-dangerous-actions` 或设置 `MSF_MCP_DANGEROUS_ACTIONS=true`；Class 预设不启用这些选项。完整行为见 [固定版本官方 MCP 指南](https://github.com/rapid7/metasploit-framework/blob/b22ce1fbae63e8caeb3a773366a6d3336bd66fb8/docs/metasploit-framework.wiki/How-to-use-Metasploit-MCP-Server.md)。

### bloodhound

该接入需要 BloodHound CE 或 Enterprise 的 API，不能连接旧版 Legacy。先安装 Docker 与 Compose v2，按 [CE 官方指南](https://bloodhound.specterops.io/get-started/quickstart/community-edition-quickstart) 下载 [bloodhound-cli 0.2.1](https://github.com/SpecterOps/bloodhound-cli/releases/tag/v0.2.1) 中对应 Linux 架构的程序。在解压目录执行：

```bash
chmod +x ./bloodhound-cli
./bloodhound-cli install
# 以后使用以下命令启动已有部署
./bloodhound-cli up
uv tool install --python 3.12 git+https://github.com/mwnickerson/bloodhound_mcp@cdb17097e761c8a8622cb93bc3ba49a9e150bb6e
command -v bloodhound-mcp
```

打开 `http://127.0.0.1:8080/ui/login`，在 Administration → API Tokens 创建令牌。Class 命令为 `bloodhound-mcp`，参数留空，环境变量先填写：

```text
BLOODHOUND_DOMAIN=127.0.0.1
BLOODHOUND_PORT=8080
BLOODHOUND_SCHEME=http
```

再分别添加 `BLOODHOUND_TOKEN_ID` 和 `BLOODHOUND_TOKEN_KEY`，值填真实 Token ID 与 Token Key；没有预置令牌。远程或 Enterprise 部署应使用实际域名、端口和协议。`BLOODHOUND_VERIFY_TLS` 默认验证 HTTPS 证书。社区 [bloodhound_mcp](https://github.com/mwnickerson/bloodhound_mcp) 启动时会访问 API 校验身份，凭据错误会导致 MCP 启动失败。

### AFL++

使用固定提交的社区 [aflpp-mcp](https://github.com/kevin-valerio/aflpp-mcp/tree/72a4eb3d1e3ae03b217d4b09513483535e6e576c)。先安装 [Node.js](https://nodejs.org/en/download)，再按 [AFL++ 官方编译说明](https://github.com/AFLplusplus/AFLplusplus/blob/stable/docs/INSTALL.md) 准备工具链。此版本没有可直接全局安装的 npm `bin` 入口，需编译服务并创建启动脚本。AFL++ 源码另行克隆到 MCP 仓库内部：

```bash
sudo apt install git build-essential clang llvm-dev lld python3-dev automake
mkdir -p "$HOME/.local/share/class-mcp"
cd "$HOME/.local/share/class-mcp"
git clone https://github.com/kevin-valerio/aflpp-mcp.git
cd aflpp-mcp
git checkout 72a4eb3d1e3ae03b217d4b09513483535e6e576c
npm ci
npm run build
git clone https://github.com/AFLplusplus/AFLplusplus.git AFLplusplus
git -C AFLplusplus checkout b449e4c544eaac1a0a9b7d1f2f15d5921907585e
make -C AFLplusplus all
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/aflpp-mcp" <<'EOF'
#!/bin/sh
export AFLPP_MCP_ROOT="$HOME/.local/share/class-mcp/aflpp-mcp"
export AFLPP_DIR="$AFLPP_MCP_ROOT/AFLplusplus"
exec node "$AFLPP_MCP_ROOT/dist/index.js"
EOF
chmod +x "$HOME/.local/bin/aflpp-mcp"
```

将 `~/.local/bin` 加入 PATH 并重启 Class，命令填写 `aflpp-mcp`，参数及环境变量留空；脚本会设置上游要求的工作根目录。若 Class 找不到入口，使用 `command -v aflpp-mcp`，或运行 `printf "%s/.local/bin/aflpp-mcp\n" "$HOME"` 得到绝对路径后填入命令栏。`AFLPP_DIR` 必须位于 `AFLPP_MCP_ROOT` 内；路径限制不是操作系统沙箱。该服务提供构建插桩、语料和模糊测试任务接口，不包含在 Class 二进制中。上面的 `make all` 构建基础 AFL++ 与插桩工具；LLVM 最低 14，建议使用 18 或更新版本，额外的二进制仿真模式需按官方说明另行构建。

## 按需加载

Class 随程序内置 29 项 Skill：`ljagiello/ctf-skills` 的 11 项与
`mukul975/Anthropic-Cybersecurity-Skills` 的 18 项。固定提交、文件清单和中文
用途位于 `assets/builtin-skills/manifest.json`。Windows x64 与 Linux amd64
包含同一份技能资源，不需要网络下载或额外放置技能目录。

在“扩展管理”的 Skill 页启用所需技能，再勾选卡片并通过“授权成员”选择老师或学生。
新内置项默认停用且无授权；升级补齐缺失项，并将已知旧版默认名称和说明更新为当前文案。`ctf-` 名称保持不变，其余名称按功能简化；用户自定义名称、说明、正文、启用状态和成员授权均保留。
内置 Skill 可编辑、停用，不提供删除；自建 Skill 仍可删除。它们不占用 128 个
自建 Skill 的额度，也不会授予关联 MCP、改变课堂角色或启用 Jev。

`search_skills` 按需搜索已授权 Skill，只返回名称、说明和 ID 等目录元数据，不读取正文或执行任何脚本。`read_skill` 缺省读取已保存的正文；指定 `path` 可读取该技能包内列出的参考
文档、模板或脚本文本。正文使用 `offset`/`limit`，资源目录使用
`resourceOffset`/`resourceLimit` 分页；路径不能跨越技能包或读取任意本机文件。
模型最初只看到获授权技能的简短目录，正文和资源按需读取。`solve-challenge`
仅提供题型与路线参考，老师和学生仍使用 Class 原有调度与验收流程。

脚本读取不会执行。确需运行时，由成员审阅后用现有文件工具写入工作区，再通过
已获授权的执行工具调用；外部软件和依赖仍由用户配置。没有打包或运行
`install_ctf_tools.sh`，也不单独下载上游 LICENSE 文件；版权声明已合并到
`licenses/README.md` 和发布版的 `THIRD_PARTY_NOTICES.txt`。
声明也内嵌于两个可执行文件，启动后的本地服务可通过
`/third-party-notices.txt` 读取，因此仅分发可执行文件时仍保留声明。

1. 模型最初只看到自己获准使用的扩展简短目录。
2. `search_tools` 按 MCP 和关键词查找工具，返回匹配项并解锁工具定义。下一轮模型请求才携带这些定义。
3. `search_skills` 只查找技能目录；确认需要后通过 `read_skill` 读取正文，再按需读取相关资源。正文支持 `offset`/`limit` 分页，不会连接 MCP 或解锁工具。
4. MCP 和 Skill 分别授权给成员。需要 MCP 工具时，成员通过 `search_tools` 按需发现自己已获授权的工具；旧配置中的 Skill 关联字段不再生效。

每个角色独立维护连接与已解锁工具，最多保留 48 个解锁定义，超过后淘汰最早使用的定义；可重新搜索。单次发现最多 10 项，服务目录最多 512 项、32 页，单个 schema 上限 32 KiB。MCP 的工具列表变更通知会清除该角色对应服务的缓存和解锁定义。

恢复检查点会保留计划/待办以及每个成员发现过的工具身份。连接、进程和网页不会序列化；恢复后重新检查授权并向服务获取 schema，不重放旧工具调用。服务暂时不可用时可以稍后通过 `search_tools` 重试发现。

## 命令行入口

命令行配置可以使用同样的 `extensions: {mcps: [], skills: []}`，绑定 ID 必须与 `students[i].id` 或 `teacher.id` 一致（老师未指定时为 `teacher`）。需要私密参数时，通过环境变量 `CLASS_EXTENSION_SECRETS` 提供 JSON 对象，结构为 `{"MCP_ID":{"env":{"ENV_NAME":"值"},"headers":{"Authorization":"Bearer 值"}}}`；不写入命令行配置或运行记录。

也可以使用 `--extension-profile <Class数据目录>`，只读加载该目录中 `profiles.json` 的扩展设置和对应凭据。它不导入桌面成员、任务或其他配置，也不修改数据目录；CLI 成员 ID 仍须与原绑定 ID 一致。此参数与配置文件中的 `extensions` 二选一，避免相同 MCP ID 对应不同端点。未配置扩展时沿用原来的 CLI 行为。

## 执行与证据

扩展调用经过原有工具入口、活动记录、暂停门和取消信号。完整的脱敏文本结果通过原有输出文件机制保留，模型只得到限额内的结果，可以使用 `read_evidence` 按引用继续读取。支持 MCP 文本、结构化结果、嵌入文本资源与常见图片；图片沿用媒体保存及模型视觉输入机制。音频、未知二进制资源以及资源链接只说明类型，不自动下载或执行。

外部 MCP 请求默认使用 30 秒有效执行时间超时，Class 暂停期间不计时。内置 browser 复用浏览器动作超时，MCP 请求上限为 120 秒。`stdio` 服务按需启动，加入 Class 创建的进程管理范围，随暂停/继续或任务停止处理。停止不会按进程名查杀其他程序。

HTTP/SSE 远端服务不能由 Class 暂停其内部执行；暂停时 Class 不发起后续操作，已有结果会记录并等待恢复后交付。超时或取消会尽力发送 MCP 取消通知，但不能撤回远端已经产生的效果；此类工具状态标为不确定，不自动重试原调用。

## 信任边界

MCP 服务和 Skill 内容都可能来自第三方。Class 不支持服务端主动请求模型采样、读取本机 roots、弹出凭据询问或启动额外客户端能力；收到未实现的请求会拒绝。服务端工具参数由其完整 JSON Schema 定义，不使用内建工具的参数别名改写规则。

`stdio` 服务以当前用户权限运行，工作目录限制不是操作系统沙箱；它可能访问其他文件或网络。仅配置可信服务。已有本地程序与远端服务的访问控制仍由操作系统和服务自身负责。HTTP 不自动跟随重定向，旧式 SSE 的消息端点必须保持同源。当前版本不自动进行 OAuth 登录，使用配置好的请求头。

协议实现依据：[生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、[传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[工具](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)。客户端协商支持 `2025-06-18`、`2025-03-26` 和 `2024-11-05`。
