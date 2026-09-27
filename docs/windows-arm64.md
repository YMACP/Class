# Windows ARM64

[返回首页](../README.md) · [Windows 使用指南](windows.md) · [开发与发布](development.md)

Class `1.0.0` 提供独立的 Windows ARM64 构建；主程序和原生目录选择器均以 ARM64 为目标，界面和业务流程与 x64 版一致。

## 使用要求

使用 Windows 11 ARM64 和 .NET Framework 4.8.1。Windows 11 22H2 起内置该组件；最初的 21H2 内置 4.8，若使用该版本则需要另装 4.8.1。[微软安装说明](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server)

下载 `Class-1.0.0-windows-arm64.zip`，通过同次发布的 `SHA256SUMS-windows-arm64.txt` 核对文件，完整解压后双击 `Class.exe`。保留包内 `THIRD_PARTY_NOTICES.txt` 和 `README.txt`。发布版无需安装 Node.js、Bun 或编译器；模型接口与可选外部工具仍需自行配置。

工作目录、成员配置、密钥和记忆管理操作见 [Windows 使用指南](windows.md)，两种架构使用同样的数据位置规则。

## 构建

在 Windows 源码目录安装依赖后，配置支持 ARM64 的 Roslyn 编译器，运行：

```powershell
npm ci
# 已安装的 Visual Studio / Build Tools 可由 vswhere 自动发现；也可明确指定：
# $env:CLASS_CSC_EXECUTABLE = 'D:\Class\build-tools\roslyn\tasks\net472\csc.exe'
npm run build:windows:arm64
npm run package:windows:arm64
```

`package:windows:arm64` 自带构建步骤，可单独运行。默认产物为源码同级的 `../class-releases/windows-arm64/Class.exe`、`../class-releases/Class-1.0.0-windows-arm64.zip` 和 `../class-releases/SHA256SUMS-windows-arm64.txt`。

原生 ARM64 源码运行应安装 ARM64 Node.js 24+；`npm ci` 按宿主架构安装锁定的 Bun 1.4.2。x64 宿主也可交叉编译；`BUN_COMPILE_EXECUTABLE` 可指定同版本 ARM64 Bun 的绝对路径，避免构建时下载目标运行时。编译器、环境变量和输出目录规则见 [开发文档](development.md)。

## 验收范围

已确认所用 Bun 版本提供原生 Windows ARM64 目标，现有目录选择器已实际交叉编译通过，检查了 ARM64 PE、GUI 子系统、CLR 头和嵌入 manifest。2026-09-27（Asia/Shanghai），程序及独立验收器在 GitHub Windows 11 ARM64 环境中通过全部五套发布验收，包括真实目录窗口打开/取消、凭据重启、浏览器、任务暂停恢复和数据迁移。程序哈希及具体范围见 [原生验收记录](native-acceptance.md)。

目标设备可使用独立的 `Class-1.0.0-windows-arm64-validation.zip` 验收包。完整解压到独立目录后双击 `Run-Verification.cmd`；无需安装 Node.js、Bun、Roslyn 或源码依赖，需要 Windows 11 ARM64、.NET Framework 4.8.1 和已安装的 Edge / Chrome。测试会短暂打开并取消自己的目录选择窗口，请在正常登录的桌面中运行。

验收包串行执行工作流与工具、记忆检索、记忆界面、便携运行和 Windows 平台五套发布测试，使用隔离临时数据及本地模拟模型，不读取真实 Class 用户数据、不调用真实模型接口。报告保存在 `%TEMP%\Class-verification-reports\class-verification-*`。只有五套均通过且正常清理才算通过；跨架构、缺少浏览器、窗口无法交互、超时或强制终止均判失败。它不包含全部源码单元测试，也不代替真实模型的识别质量测试。

也可从 PowerShell 指定报告目录（须位于验收包目录之外）：

```powershell
.\Class.Verify.exe --suite all --exe .\Class.exe --report-dir "$env:TEMP\Class-verification-reports"
```

开发者可在已生成资源并安装依赖的源码副本中，设置 `BUN_EXECUTABLE` 为宿主 Bun 1.4.2，交叉编译时设置 `BUN_COMPILE_EXECUTABLE` 为同版本目标 Bun，然后运行 `npm run build:verifier:arm64`。默认输出到源码同级的 `class-verification/windows-arm64/Class.Verify.exe`；自定义路径用 `node scripts/build-verifier.js --arch arm64 --out <源码树外路径>/Class.Verify.exe`。验证器为独立控制台程序，不改写正式 `Class.exe`。

更完整的源码原生回归需在 Windows 11 ARM64、ARM64 Node.js 与 Bun 环境中执行：

```powershell
npm test
npm run build:windows:arm64
npm run verify:windows
npm run verify:memory
npm run verify:ui
npm run verify:portable
npm run verify:platform
```

验收应覆盖原生目录选择、临时凭据加解密、浏览器和命令工具、任务暂停与恢复、记忆和界面流程。使用隔离数据目录与本地模拟接口；不要将 x64 上的交叉编译成功写成 ARM64 设备运行通过。
