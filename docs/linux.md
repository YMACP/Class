# Linux 构建与运行

[返回首页](../README.md) · [命令行配置](cli.md) · [Windows 使用指南](windows.md)

Class 1.1.0 提供 Linux amd64（x86-64）程序。界面、成员调度、持续评审、工具协议和记忆工作流与 Windows 使用同一套源码。平台适配包括数据路径、凭据保存、目录选择和程序启动。[Jev 判断器](jev.md) 默认关闭，使用独立配置和密钥，不改变老师的最终验收职责。

## 下载与启动

使用 glibc Linux，不适用于 Alpine/musl。当前版本的运行验证以对应验收报告为准，不表示已验证所有 Linux 发行版。Bun 的 glibc 运行时要求与 CPU 要求见 [官方安装说明](https://bun.sh/docs/installation)。

用 `uname -m` 确认设备为 `x86_64`，下载 Linux amd64 的 `Class` 到独立目录。若提供同次发布的 SHA256 清单，可先核对；赋予执行权限后运行：

```bash
chmod +x Class
./Class
```

若下载的是可选归档 `Class-1.1.0-linux-amd64.tar.gz`，先解压再运行；归档内程序已设置执行权限。不需要安装 Node.js、Bun 或 npm。保留随包的第三方许可证和说明。

程序仅监听本机地址，默认打开浏览器。无桌面自动打开需求时使用 `./Class --no-browser`；程序会输出本地浏览器入口文件路径。关闭浏览器不等于退出服务，使用页面的“退出服务”或终端 Ctrl+C。远程服务器的访问需要自行建立安全的端口转发，程序不会自动开放公网监听。

## 系统程序

- 默认浏览器与 `xdg-open` 用于打开界面。
- `zenity` 或 `kdialog` 用于图形目录选择；需要可用的桌面会话。无图形会话时可用 `--data-dir` 指定数据目录；调用图形目录选择会明确报错。
- Bash 用于命令工具；Chrome、Firefox 用于浏览器自动化，也保留 Chromium。默认优先查找 Chrome/Chromium，未找到时查找 Firefox；可通过 `CLASS_BROWSER_EXECUTABLE` 指定浏览器的完整绝对路径。

例如，Ubuntu 桌面的目录选择组件可用 `sudo apt install xdg-utils zenity` 安装。浏览器应安装与目标架构匹配的版本，并以普通用户运行，保留正常沙箱机制。模型账号、网络连接和可选外部命令由使用者配置；真实图片/PDF理解质量取决于模型接口。

Firefox 要求 149 或更新版本，以保持下载禁用。Class 不内置或自动下载浏览器，本次适配不增加运行时依赖。没有可用浏览器时，仅 `browser` 调用明确报错，其他任务仍可运行。各浏览器共用一套工具操作和暂停/恢复、取消、清理机制；实例按成员隔离，不接管日常浏览器。Linux Firefox 使用用户主目录下独立的 `class-browser-*` 临时配置，结束时清理。

## 数据与凭据

默认数据目录为 `$XDG_DATA_HOME/class`，未设置有效绝对路径时使用 `~/.local/share/class`。默认启动日志在 `$XDG_STATE_HOME/class/logs`，未设置时为 `~/.local/state/class/logs`。显式 `--data-dir`、`CLASS_DATA_DIR` 与界面迁移功能保留原有优先级；自定义数据目录的启动日志保留在该目录中。

本次更新的 amd64 版本在原数据目录不存在或无法访问时，会打开“重新选择数据目录”页面。“使用默认目录”会加载默认目录中的已有数据，没有数据时才初始化；“选择数据目录”可加载移动后的完整 Class 数据目录，也可自动初始化用户已经创建的空目录。对于当前用户拥有的空目录，Class 会先将权限设为 `0700` 并验证，再初始化配置、工作目录、历史记录和记忆存储。所选目录必须已经存在；未知非空目录或残缺、损坏的 Class 数据目录会被拒绝。只有新目录成功启动后才记住路径，不删除或覆盖其他目录的数据。目录被移动仍可重新选择，已删除的数据则不能通过此功能恢复。

正常界面中的“迁移到空目录”用于迁移当前数据，“加载已有目录”用于切换到已有配置和历史记录，仍不接受空目录；请等待当前任务结束后操作。

默认首次启动仍会自动创建数据目录。显式 `--data-dir` 指向不存在的目录时会进入恢复页面；首次希望直接使用新目录时，可先创建当前用户拥有的空目录并设置权限，例如：

```bash
mkdir -m 700 "$HOME/Class-data"
./Class --data-dir "$HOME/Class-data"
```

Linux 使用本地随机密钥与 AES-256-GCM 保存 API Key。`credentials.key` 和 `credentials.aesgcm.json` 均为 0600，数据目录为 0700，且必须属于当前用户。该模式依赖文件权限：同时拿到密钥和密文的人可解密，不等同 Windows DPAPI 或桌面系统密钥环。它可在没有 D-Bus/桌面密钥环的服务器上使用。

2026-09-27 更新后的 Linux amd64 版在界面迁移数据目录时，会先将当前用户拥有的空目标目录自动设为 0700，再进行迁移；非空目录、符号链接或其他用户的目录会被拒绝。无法设置并验证权限时，迁移停止，源数据保留。平时读取和保存凭据仍严格检查上述权限。

备份与迁移应保留完整数据目录及文件权限。程序不会在密钥丢失或密文损坏时覆盖原凭据；Windows 与 Linux 的凭据格式无法直接互相解密，跨系统需用独立目录重新配置模型密钥。

## 从源码构建

Linux amd64 开发环境安装 x64 版 Node.js 24+：

```bash
npm ci --ignore-scripts
npm start
# 构建与打包 Linux amd64
npm run package:linux
# 或使用等效命令
npm run package:linux:amd64
```

`npm ci` 按宿主系统及架构安装锁定的 Bun 1.4.2。`prepare:assets` 在 Linux 生成前端资源与不含 Windows 原生组件的占位模块，不需要 Roslyn/.NET。

Windows x64 可交叉构建 Linux amd64。`BUN_EXECUTABLE` 指定宿主 Bun；`BUN_COMPILE_EXECUTABLE` 可指定官方、同版本的 Linux x64 Bun 文件，构建会验证 ELF 架构与 glibc 加载器。Windows 构建进程的 `TEMP`/`TMP` 必须是可写的纯 ASCII 路径。

本轮产物与源码分离：`../class-releases/linux-amd64/Class`。可选 `.tar.gz` 及 `SHA256SUMS-linux-amd64.txt` 位于 `../class-releases/`；发布前应使用源码树外的 `CLASS_RELEASE_DIR` 指向独立暂存目录，验证后再替换正式程序。打包仅包含程序、说明、许可证及清单，并显式设置 POSIX 执行权限。

## 验收状态

构建、ELF 架构、压缩包权限和哈希检查属于静态验证，不能代替目标系统上的实际运行。构建清单中的 `nativeRunVerified: false` 记录制包时的状态；原生运行结论以对应版本的独立验收报告为准。

独立验收器可用 `build:verifier:linux:amd64` 构建，默认输出到源码同级的 `class-verification/linux-amd64/Class.Verify`。命令格式为 `./Class.Verify --suite all --exe /绝对路径/Class --report-dir /包目录之外的报告路径`，使用隔离测试数据和本地模拟模型；不读取真实用户数据，也不验证真实模型服务的识别质量。
