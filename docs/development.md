# Windows 与 Linux 开发及发布

[返回首页](../README.md) · [命令行](cli.md) · [架构入口](architecture.md) · [Jev 判断器](jev.md)

以下命令均在源码根目录运行。源码目录保持为 `class`；构建脚本通过自身位置定位源码，不依赖当前终端目录。

## 版本约定

Class 首次发布版本为 `1.0.0`，Jev 集成版本为 `1.1.0`；本轮经维护者授权更新为 `1.2.0`。源码包版本、服务版本、发布文件名和验收预期必须一致；Windows 文件属性采用四段格式 `1.2.0.0`。第三方依赖版本与数据格式版本独立维护，历史验收记录保留当时版本。

当前仅支持构建和发布 Windows x64 与 Linux amd64。Jev 默认关闭，不改变现有课堂流程；配置、按项启用与回退方式见 [Jev 判断器](jev.md)。MCP、Skills 与命令行扩展配置见 [扩展说明](extensions.md)。

## 开发环境

开发环境需要 x64 版 Node.js 24+，先运行 `npm ci --ignore-scripts` 安装锁定依赖。PDF 文本提取使用 unpdf / PDF.js；Bun `1.4.2` 的 Windows x64 和 Linux amd64 包列在 `optionalDependencies`，npm 按宿主系统安装对应包。

下文 Windows 编译器及 ZIP 说明适用于 Windows。Linux 不依赖 .NET，使用 `npm run package:linux:amd64` 生成源码树外的 `Class` 程序与 `.tar.gz`。Linux 系统依赖、凭据保存和独立验收器见 [Linux 指南](linux.md)。

Windows 源码启动和打包会使用系统 .NET Framework 4.x 的 C# 编译器生成目录选择组件。Linux 使用系统可用的目录选择方式，不需要此组件。

浏览器兼容性验证使用已安装的浏览器：Windows 为 Edge、Chrome、Firefox，Linux 为 Chrome、Firefox；普通使用还保留 Chromium。Firefox 需要 149 或更新版本，以维持下载禁用。适配直接使用浏览器协议，不增加运行时依赖，不内置或自动下载浏览器；各浏览器共用独立配置和既有暂停、恢复、取消及清理机制。

```powershell
npm ci --ignore-scripts

# 自动生成原生目录选择组件与界面资源，并打开本地 Web UI
npm start

# 构建 Windows x64；优先使用 npm 安装的 Bun，也可用 BUN_EXECUTABLE 指定
npm run build:windows

# 明确指定目标架构；package 命令自动构建并打包
npm run build:windows:x64
npm run package:windows:x64
```

`npm start`、`npm test` 和需要源码资源的发布验证会自动执行资源准备；打包也会生成 `build/generated/` 内的原生目录选择组件与嵌入资源。应修改 `src/`、`public/` 或 `native/` 中的源文件，不手工维护生成资源。

`build:windows` / `package:windows` 仅接受 x64；直接调用脚本时使用 `node scripts/build-windows.js --arch x64` 或 `node scripts/package-windows.js --arch x64`。Linux 命令仅接受 amd64（x64）。

`BUN_EXECUTABLE` 指定构建宿主运行的 Bun；需要目标运行时时，也可用 `BUN_COMPILE_EXECUTABLE` 指定同版本（当前 `1.4.2`）目标 Bun 的绝对路径，脚本会检查目标架构。构建临时目录需要纯 ASCII 路径；如系统临时目录含非 ASCII 字符，将 `TEMP`、`TMP` 指向自己创建的纯 ASCII 目录。

## 源码目录

```text
class/
├─ src/                 # 核心调度、模型接口、工具、服务与记忆管理
├─ public/              # Web 界面与静态资源
├─ native/windows/      # Windows 原生组件源码
├─ scripts/             # 资源生成、构建与打包脚本
├─ tests/*.test.js       # 正式回归测试
├─ tests/release/        # 发布产物与界面验收
├─ examples/            # 不含真实凭据的示例配置与任务
├─ licenses/            # 第三方许可文件
├─ docs/                # 使用与开发文档
├─ build/               # 自动生成的构建资源
└─ node_modules/        # npm ci 安装的依赖
```

`build/` 与 `node_modules/` 均可由构建或依赖安装重新生成，不作为手工维护的源码。

## 发布目录

构建将运行时、服务、原生目录选择组件与 `public/` 界面资源嵌入 EXE，运行时不需要旁边放源码、网页文件或 Node.js。默认输出到源码同级目录：

```text
父目录/
├─ class/                              # 源码
│  └─ build/generated/                 # 自动生成的构建资源
└─ class-releases/
   ├─ windows-x64/Class.exe            # Windows x64 发布程序
   └─ linux-amd64/Class                # Linux amd64 发布程序
```

运行 `npm run package:windows` 会自动构建再打包。ZIP 包含 `Class.exe`、`THIRD_PARTY_NOTICES.txt` 和对应架构的 `README.txt`；第三方许可来源见 [licenses/README.md](../licenses/README.md)。默认 EXE 路径为 `../class-releases/windows-<架构>/Class.exe`，ZIP 与对应的校验清单位于输出目录的上级；正式用户数据仍位于用户选择的数据目录。

可选归档名称包含当前版本，例如 `Class-1.2.0-windows-x64.zip`、`Class-1.2.0-linux-amd64.tar.gz`。归档和校验清单是发布辅助文件，不是启动程序的依赖。

可通过 `CLASS_RELEASE_DIR` 环境变量指定其他发布输出目录，例如 `D:\Class\releases\windows-x64`。构建脚本要求产物位于源码树之外；该变量只改变发布产物位置，不改变用户数据目录。

更新发布程序时先将 `CLASS_RELEASE_DIR` 指向独立暂存目录，完成对应平台验收后再替换正式文件。版本号或文件头检查只能证明元数据与目标架构，不能代替运行验收。不要使用真实数据目录运行测试，也不要把配置、密钥、会话或记忆打入程序。

使用 `Class.exe --data-dir <绝对路径>` 或 `./Class --data-dir <绝对路径>` 指定隔离数据时，目标目录不存在会进入数据目录恢复页面。首次直接使用新目录前应先创建空目录，Linux 需由当前用户持有且权限为 `0700`；未显式指定目录的正常首次启动仍会自动初始化。恢复选项和“迁移到空目录”“加载已有目录”的区别见 [数据目录恢复](../README.md#数据目录恢复)。

修改界面后重新构建即可更新发布版。EXE、网页标签页与界面使用相同图标，矢量源文件为 `public/class-icon.svg`，Windows 多尺寸图标为 `public/class-icon.ico`。界面需要较新的 Edge、Chrome 或 Firefox。

## 命令行演示

保留原命令行入口：

```powershell
npm run demo -- --output-dir D:\Class\verification\runs
npm run cli -- --config config.local.json --output-dir D:\Class\verification\runs
```

演示使用明确的确定性 Agent，不冒充真实模型调用：三个学生独立提出配对求和方法，相似发现合并后超过全体半数直接采纳，学生提交 5050，老师验证通过后结束。演示仅覆盖固定成功路径；持续验收、并发与模型协议需要单独验证。

## 测试与发布验证

```powershell
npm test
npm run build:windows
npm run verify:windows
npm run verify:memory
npm run verify:ui
npm run verify:portable
npm run verify:platform
```

`npm test` 运行工具、存储、权限及候选答案复审回归。`verify:windows` 验证实际 EXE 和“否决后继续、再次验收通过”；`verify:memory` 验证实际 EXE 的记忆与跨会话流程；`verify:ui` 验证管理界面、布局和整理状态；`verify:portable` 验证独立发布产物，不依赖源码资产；`verify:platform` 检查目标架构与系统互操作。发布验证脚本位于 `tests/release/`，默认验证所选架构输出目录中的 EXE。

1.2.0 的扩展和异常退出续跑验收使用 `node tests/release/verify-state-release.js <Class程序绝对路径>`；MCP/Skills 页面验收使用 `node tests/release/verify-extensions-ui.js`。均使用隔离配置和本地模拟服务。Windows 的 Chromium 启动器使用 `--enable-automation`，避免管理员终端中的自动降权重启使浏览器脱离 Class 管理；主进程继承 Class 当前权限，不额外提权，也不关闭浏览器沙箱。源码验收直接运行 `npm test`，无需注入浏览器启动参数；设置 `CLASS_TEST_BROWSER_MCP=1` 可同时验证真实浏览器的 stdio MCP 暂停、恢复和退出清理。

独立验收器 `Class.Verify.exe` / `Class.Verify` 的 `--suite all` 依次运行 `release`、`memory`、`ui`、`portable`、`platform`、`recovery`、`browser` 共七套检查；也可用 `--suite browser` 单独运行浏览器矩阵。`browser` 要求 Windows 的 Edge/Chrome/Firefox 或 Linux 的 Chrome/Firefox 全部可用，缺少某种浏览器会使验收失败，不记作跳过成功。它使用隔离数据、本地模拟模型和实际浏览器验证统一工具操作、生命周期及任务工作流；源码模式入口为 `node tests/release/verify-browser-compatibility.js --node`。

特殊安装位置使用 `CLASS_TEST_BROWSER_EXECUTABLES` 指定完整 JSON 映射；这是验收变量，普通用户只需安装一种受支持浏览器。已有 UI 验收使用 CDP，运行 `all` 时将 `CLASS_BROWSER_EXECUTABLE` 指向 Edge/Chrome/Chromium，浏览器矩阵另行逐个选择对应程序。以下路径需按本机安装位置修改，报告目录应位于正式数据与发布目录之外：

```powershell
$env:CLASS_TEST_BROWSER_EXECUTABLES = @{
  edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
  firefox = 'C:\Program Files\Mozilla Firefox\firefox.exe'
} | ConvertTo-Json -Compress
$env:CLASS_BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
.\Class.Verify.exe --suite all --exe 'D:\Class\Class.exe' --report-dir 'D:\Class-validation'
```

```bash
export CLASS_TEST_BROWSER_EXECUTABLES='{"chrome":"/usr/bin/google-chrome","firefox":"/usr/bin/firefox"}'
export CLASS_BROWSER_EXECUTABLE=/usr/bin/google-chrome
./Class.Verify --suite all --exe /opt/class/Class --report-dir "$HOME/class-validation"
```

普通浏览器工具默认优先查找已有 Edge/Chrome/Chromium，未找到时使用 Firefox；未找到可用浏览器时仅工具调用返回错误，不阻止其他任务。实际验收结论和覆盖边界以对应构建的报告为准。

Windows x64 与 Linux amd64 的运行验收应分别在对应系统执行。构建成功和文件头检查只证明生成了目标架构程序，不能代替原生运行验收；历史版本的验收结果也不自动适用于 `1.2.0`。独立的 `Class.Verify.exe` / `Class.Verify` 验收器无需另装 Node.js 或 Bun。

这些检查使用临时目录、本地 HTTP 或模拟模型；浏览器检查启动独立无头 Edge/Chrome/Firefox，使用自有临时配置，不接触正式 Class 数据或付费模型。它们不等同于在全新 Windows 虚拟机中验证全部系统依赖，也不保证 SmartScreen、安全软件或组织策略不拦截程序。检查失败时先阅读实际报告，不以文件存在代替运行验证。
