# Windows 与 Linux 开发及发布

[返回首页](../README.md) · [命令行](cli.md) · [架构入口](architecture.md)

以下命令均在源码根目录运行。源码目录保持为 `class`；构建脚本通过自身位置定位源码，不依赖当前终端目录。

## 版本约定

Class 首次发布版本统一为 `1.0.0`。后续修改与重新打包均保持此版本，只有维护者明确要求时才更改版本号。源码包版本、服务版本、发布文件名和验收预期必须一致；Windows 文件属性采用四段格式 `1.0.0.0`。第三方依赖版本与数据格式版本独立维护。

## 开发环境

开发环境需要与设备架构一致的 Node.js 24+，先运行 `npm ci` 安装锁定依赖。PDF 文本提取使用 unpdf / PDF.js；Bun `1.4.2` 的 Windows x64 / ARM64 和 Linux amd64 / arm64 包列在 `optionalDependencies`，npm 按宿主系统及架构安装对应包。

下文 Windows 编译器及 ZIP 说明适用于 Windows。Linux 不依赖 .NET/Roslyn，使用 `npm run package:linux:amd64` 或 `npm run package:linux:arm64` 生成源码树外的 `Class` 程序与 `.tar.gz`。Linux 系统依赖、凭据保存和独立验收器见 [Linux 指南](linux.md)。

源码启动和打包均会编译目录选择组件。x64 保留系统 .NET Framework 4.x 的 C# 编译器；ARM64 需要支持 `/platform:arm64` 的 Roslyn，通过 `CLASS_CSC_EXECUTABLE` 指定 `csc.exe` 绝对路径，或由 `vswhere` 从已安装的 Visual Studio / Build Tools 查找。也可将锁定的 [Microsoft.Net.Compilers.Toolset 4.14.0](https://www.nuget.org/packages/Microsoft.Net.Compilers.Toolset/4.14.0) 解压到本地目录，指向其中 `tasks/net472/csc.exe`，无需安装该工具包；运行编译器的宿主须已具备 .NET Framework 4.7.2+。

现有选择器已用 .NET Framework 4.8 引用程序集交叉编译通过，无需 4.8.1 Developer Pack；ARM64 产物运行需要 Windows 11 ARM64 和 .NET Framework 4.8.1，Windows 11 22H2 起内置该运行时。[微软安装说明](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server)

浏览器兼容性验证使用已安装的浏览器：Windows 为 Edge、Chrome、Firefox，Linux 为 Chrome、Firefox；普通使用还保留 Chromium。Firefox 需要 149 或更新版本，以维持下载禁用。适配直接使用浏览器协议，不增加运行时依赖，不内置或自动下载浏览器；各浏览器共用独立配置和既有暂停、恢复、取消及清理机制。

```powershell
npm ci

# 自动生成原生目录选择组件与界面资源，并打开本地 Web UI
npm start

# 按宿主架构构建；优先使用 npm 安装的 Bun，也可用 BUN_EXECUTABLE 指定
npm run build:windows

# 明确指定目标架构；package 命令自动构建并打包
npm run build:windows:x64
npm run build:windows:arm64
npm run package:windows:x64
npm run package:windows:arm64
```

`npm start`、`npm test` 和需要源码资源的发布验证会自动执行资源准备；打包也会生成 `build/generated/` 内的原生目录选择组件与嵌入资源。应修改 `src/`、`public/` 或 `native/` 中的源文件，不手工维护生成资源。

`build:windows` / `package:windows` 默认使用宿主架构，可用 `CLASS_WINDOWS_ARCH=x64` 或 `arm64` 改变默认目标；显式架构命令优先。直接调用脚本时使用 `node scripts/build-windows.js --arch arm64` 或 `node scripts/package-windows.js --arch arm64`。

交叉编译可让 Bun 获取目标运行时，也可用 `BUN_COMPILE_EXECUTABLE` 指定同版本（当前 `1.4.2`）目标架构 `bun.exe` 的绝对路径，避免构建时从 GitHub 下载；脚本会校验其 PE 架构。`BUN_EXECUTABLE` 指构建宿主运行的 Bun，两者用途不同。构建临时目录需要纯 ASCII 路径；如系统临时目录含非 ASCII 字符，将 `TEMP`、`TMP` 指向自己创建的纯 ASCII 目录。更多 ARM64 验收要求见 [ARM64 说明](windows-arm64.md)。

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
   ├─ windows-arm64/Class.exe          # Windows ARM64 发布程序
   ├─ Class-1.0.0-windows-x64.zip
   ├─ Class-1.0.0-windows-arm64.zip
   ├─ SHA256SUMS-windows-x64.txt
   ├─ SHA256SUMS-windows-arm64.txt
   └─ SHA256SUMS.txt                   # x64 校验清单的兼容入口
```

运行 `npm run package:windows` 会自动构建再打包。ZIP 包含 `Class.exe`、`THIRD_PARTY_NOTICES.txt` 和对应架构的 `README.txt`；第三方许可来源见 [licenses/README.md](../licenses/README.md)。默认 EXE 路径为 `../class-releases/windows-<架构>/Class.exe`，ZIP 与对应的校验清单位于输出目录的上级；正式用户数据仍位于用户选择的数据目录。

可通过 `CLASS_RELEASE_DIR` 环境变量指定其他发布输出目录，例如 `D:\Class\releases\windows-x64`。构建脚本要求产物位于源码树之外；该变量只改变发布产物位置，不改变用户数据目录。

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

Windows ARM64 的完整源码回归应在 Windows 11 ARM64 上，使用 ARM64 Node.js 与 Bun 执行上述检查；独立的 `Class.Verify.exe` 发布验收器无需另装这些开发运行时。x64 宿主上的交叉编译与 PE 检查仅证明产物架构，不能代替原生运行验收。

2026-09-27（Asia/Shanghai），Windows 11 ARM64、Ubuntu 24.04 AMD64 / ARM64 各通过五套独立发布验收，共 15 套；这不等于在三个平台执行了全部 `npm test` 源码单元测试。报告、程序哈希和覆盖边界见 [原生验收记录](native-acceptance.md)。

这些检查使用临时目录、本地 HTTP 或模拟模型；浏览器检查启动独立无头 Edge/Chrome/Firefox，使用自有临时配置，不接触正式 Class 数据或付费模型。它们不等同于在全新 Windows 虚拟机中验证全部系统依赖，也不保证 SmartScreen、安全软件或组织策略不拦截程序。检查失败时先阅读实际报告，不以文件存在代替运行验证。
