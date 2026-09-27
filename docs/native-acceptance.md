# Class 1.0.0 原生发布验收

[返回首页](../README.md) · [开发与发布](development.md) · [Linux 使用指南](linux.md) · [Windows ARM64](windows-arm64.md)

## 当前发布：恢复页面标签页标题

2026-09-27，Windows x64 与 Linux amd64 重新构建，版本保持 `1.0.0`。本次唯一生产源码变更是将恢复页面的 HTML 标题改为 `Class`，与正式页面一致；页面内部的“重新选择数据目录”标题保留。

恢复服务原有 10 项测试通过。Windows 使用隔离数据启动实际 EXE，验证恢复页面返回 `<title>Class</title>`、页面内部标题不变并正常退出。两个构建均检查目标架构和内嵌的新标题，旧标签页标题已移除。本次未重新运行 Linux 原生环境；下文的完整功能验收对应此前的文件哈希。

| 当前文件 | SHA256 |
| --- | --- |
| Windows x64 `Class.exe` | `c97ab5ef933d617e7f66e76243ee0e062a3032a5b87f4e6a805032958eedd5ff` |
| Linux amd64 `Class` | `b4dfd4a1357bff2e109c373bf469630b3fbefdbee156bd513ae182a40236e5e7` |

本轮构建归档保存 `title-verification.json` 与 `formal-release-replacement.json`，后者记录最终替换文件与候选构建的哈希对应关系。以下均为历史验收。

## 历史：Windows x64 / Linux amd64 恢复页面初始化空目录验收

2026-09-27，Class 1.0.0 的恢复页面支持选择已经存在的空目录，并初始化配置、工作目录、历史记录与记忆存储。已有 Class 数据仍直接加载；未知非空目录、残缺配置以及选择期间发生变化的目录不会被当作空目录覆盖。Linux 会先将当前用户拥有的空目录权限设为 `0700`，取得本实例的目录锁并重新验证后才初始化；成功启动后才登记所选路径。

Windows x64 的 `release`、`memory`、`ui`、`portable`、`platform`、`recovery` 六套验收通过，`browser` 在保持主程序和验收器不变的单独复测中通过。Ubuntu 24.04 AMD64 七套一次全部通过。[Linux 本轮运行与报告](https://github.com/dsgymz/class_test/actions/runs/36319057811)

两个平台各完成 **17 项目录恢复检查**。新增覆盖真实页面选择空目录、Linux `0755` 空目录自动调整为 `0700`、初始化后重启、从新目录加载已有数据并重启，以及拒绝未知非空、缺少配置但保留凭据、仅有运行文件的目录。验证初始化时不会提前生成凭据；正常页面“加载已有目录”仍拒绝空目录，已有加载与迁移行为保留。

| 目标 | 主程序 SHA256 | 验收器 SHA256 |
| --- | --- | --- |
| Windows x64 | `527139d74ace950b1709b1fdee89cb5cf70a94a2e05ff024c08710813365ea0f` | `180f2fef34cd5347e5b577c8ca2937fdd022bfe5b44a50a6d48c9a473ecb89fd` |
| Linux amd64 | `553b0f274b87ca4cb38ff470edd811c735f27a60ae6c782f1ae4de65b5a55e20` | `4cb5c1b2afcdb6fd1b83d87be9f95722b3d2d7954411db19b2c7a2cfc9bd816b` |

Windows 汇总为本轮构建归档的 `windows-acceptance.json`，关联 `class-verification-TBMVuF/verification-summary.json` 与 `windows-browser-r2.json`。首次浏览器套件中，Firefox 的工具与生命周期检查通过，但应用内第一次启动 Firefox 时退出并产生崩溃转储；相同两个二进制在单独浏览器套件中复测 Edge、Chrome、Firefox，全部通过。首次退出原因尚未确认，临时目录路径较长仅为待验证假设，未据此修改浏览器代码。通过的套件均正常退出，无强制停止或清理失败。

源码测试 **296 项通过、14 项平台相关检查跳过**，包括新增的目录身份、独占锁、并发插入文件、排他发布和写入失败保护测试。本次仅修改三个生产文件：`src/desktop.js`、`src/data-recovery-server.js`、`src/startup-data-recovery.js`；其余 28 个生产源码文件与此前浏览器版本完全一致。版本与依赖保持不变。验收使用隔离数据和本地模拟模型，未测试真实外部模型或其他 Linux 发行版。

以下为更早的历史验收记录。

## 历史：Windows x64 / Linux amd64 浏览器兼容性验收

2026-09-27，Class 1.0.0 完成 Windows x64 的 Edge、Chrome、Firefox 和 Ubuntu 24.04 AMD64 的 Chrome、Firefox 原生验收。[Linux 运行及报告](https://github.com/dsgymz/class_test/actions/runs/36315563960)

Windows 原有 `release`、`memory`、`ui`、`portable`、`platform`、`recovery` 六套回归通过，新增 `browser` 三浏览器验收通过。Linux 在最终运行中七套全部通过，保留原有 14 项平台检查、8 项目录权限检查和 12 项数据目录恢复检查。所有通过的套件正常退出，无强制终止或清理失败。

| 环境 | 实际验证的浏览器 |
| --- | --- |
| Windows x64 | Edge 154.0.4258.37、Chrome 153.0.8010.53、Firefox 151.0 |
| Ubuntu 24.04 AMD64 | Chrome 153.0.8010.52、Firefox 156.0（原生 DEB） |

每种浏览器覆盖全部 10 类工具操作、截图、学生实例隔离、暂停期间的进程冻结与活动时间计时、恢复、取消、真实导航超时及临时配置清理。每种浏览器还在实际编译后的 Class 中完成 15 次工具调用，验证老师驳回后继续使用同一标签页、保留截图和工具证据、修改答案后通过评审，且不重放已完成操作。

| 目标 | 主程序 SHA256 | 最终浏览器验收器 SHA256 |
| --- | --- | --- |
| Windows x64 | `f3c8c80344a97c7575092ff7f6833df60b226d20e4c76182d14d46f88d5d6d58` | `e66a1dafff0f6b77f29a58f9b69d7c76e92474cee1efcd443ede8eaa28639b94` |
| Linux amd64 | `ce0ae4b89b78ee442d1b6383d8216e2dce30a51132e1b05038599c21d4a679b5` | `16d962a9bee8367d4848d680b44de2b921d7f15a3a8d52d4ad4323bec60d0619` |

Windows 汇总为本轮构建归档的 `windows-acceptance.json`，关联原六套报告和 `windows-browser-r3.json`。新验收脚本曾因模拟 Windows 系统目录、过度约束浏览器临时文件以及运行中修改 Linux HOME 而失败；这些仅涉及测试环境，修正后针对同一主程序补充验证。Windows 原六套无需重复运行，Linux 最终七套以本节链接的成功运行及 `browser-compatibility-acceptance.json` 为准。

源码测试 268 项通过，13 项 Linux 平台相关检查跳过。本次生产代码仅修改 `src/browser-tools.js` 并新增 `src/firefox-browser.js`；调度、评审、记忆与其他业务模块未改动，依赖清单和版本保持不变。相比上一份发布程序，Windows 增加 9,216 字节，Linux 增加 8,192 字节，不包含浏览器、驱动下载器或新的运行依赖。

Firefox 需要 149 或更新版本，以保留下载禁用能力。Linux 本轮验证原生 DEB 浏览器；Snap 安装和其他发行版未做原生验收。模型使用本地模拟服务，未测试外部真实模型的服务质量。下文为历史验收，当前文件以本节哈希为准。

## 历史：Windows x64 / Linux amd64 数据目录恢复验收

2026-09-27，两个更新后的 1.0.0 主程序分别在本机 Windows x64 和 GitHub Ubuntu 24.04 AMD64 完成 `release`、`memory`、`ui`、`portable`、`platform`、`recovery` 六套原生验收，**共 12 套全部通过**，无强制终止或清理失败。[Linux 本次运行及报告](https://github.com/dsgymz/class_test/actions/runs/36311511549)

新增恢复验收在两个平台各完成 12 项检查：移动/删除数据目录后的恢复入口、二次启动复用、无效及占用目录拒绝、真实浏览器选择并加载已有目录、凭据/历史/记忆检索和内置工作目录恢复、记住选择后重启、恢复后继续迁移、初始化空默认目录、加载带失效旧指针的默认目录，以及正常界面加载其他已有目录后重启。全部使用隔离配置与本地模拟模型，不访问用户真实数据。

| 目标 | 主程序 SHA256 | 验收器 SHA256 |
| --- | --- | --- |
| Windows x64 | `76b36ec0a57e05f952aa80ec43d8427a39c822da4e9f91db220b42b47a24205c` | `b5955b1c494f3becf42762ca7267d87c705f91eb5ed165f12b0323e45b7f41fd` |
| Linux amd64 | `6f7231766bbfe91942456cac79d4320b64ce334cbc11f2d0c826fd9c5fcb3b99` | `d30bdce622c465ad9772cf6fbeeedd821766ffccaaf548f110eb8e6f21d4aaed` |

Windows 原生汇总为本轮本地构建归档中的 `class-verification-jCHqvC/verification-summary.json`。Linux artifact 为 `Class-1.0.0-linux-amd64-startup-recovery-reports-36311511549-1`，包含 `startup-recovery-acceptance.json` 和 `class-verification-EpOo58/verification-summary.json`。

本机源码测试 232 项通过，13 项平台相关检查跳过；Linux 原生验收保留此前 14 项平台检查和 8 项目录权限回归。模型识别质量、其他 Linux 发行版以及本轮未构建的 ARM64 不在本次验收范围内。下文为此前版本的历史验收记录，其哈希不对应本次更新文件。

## Linux amd64 目录权限修复验收

2026-09-27，更新后的 Linux amd64 1.0.0 在 Ubuntu 24.04 完成五套原生验收，全部通过。[本次运行及原始报告](https://github.com/dsgymz/class_test/actions/runs/36306629618)

- 原有 14 项平台检查全部通过，另增加 8 项目录权限回归：已有空目录 `0755`、`0775`，尚不存在的目录，以及非空、符号链接、所有者不符、权限设置报错、权限设置后仍不合要求的拒绝场景。
- 通过实际 Class HTTP 接口迁移已有的空 `0755` 目录，验证权限变为 `0700`，源数据保留、凭据可解密，并从原启动入口重启成功。所有者不符及权限设置失败使用隔离故障注入验证。
- 主程序 SHA256：`73aea5defe60b43ec22a3034c9f51a2c12082f1c9f625f1fb51727ea5f83a223`；验收器 SHA256：`b303ac1da5be808fbe89d31f16c98f7ea1f9cbc15007e27f8b33ffc922a445ab`。
- 报告 artifact：`Class-1.0.0-linux-amd64-permissions-reports-36306629618-1`，包含 `permissions-acceptance.json` 和 `class-verification-7sN7V4/verification-summary.json`。所有套件退出码为 0，无强制终止或清理失败。
- 本次仅更新 Linux amd64；Windows x64 EXE 未改动。模型调用仍使用本地模拟服务，不代表真实外部模型识别质量验证。

以下保留首次三平台验收的历史记录及当时文件哈希。

## 首次三平台验收

2026-09-27（Asia/Shanghai），Class 1.0.0 在 Windows 11 ARM64、Ubuntu 24.04 AMD64 和 Ubuntu 24.04 ARM64 原生环境完成发布验收。每个平台运行 `release`、`memory`、`ui`、`portable`、`platform` 五套独立验收，共 **15 套全部通过**。[GitHub Actions 运行及原始报告](https://github.com/dsgymz/class_test/actions/runs/36258965980)

## 实际结果

三个平台的目标架构、宿主架构和运行时架构均匹配。全部套件退出码为 0，没有中断、强制终止或清理失败；应用、模拟模型服务及隔离测试目录均正常清理。

下表为各套件报告的检查项数量，全部通过。`release` 记录的是实际完成的工具调用数量，不能与其余列相加作为测试总数。

| 原生环境 / GitHub runner | release | memory | ui | portable | platform |
| --- | --- | --- | --- | --- | --- |
| Windows 11 ARM64 / `windows-11-arm` | 18 次工具调用 | 14 项 | 9 项 | 5 项 | 9 项 |
| Ubuntu 24.04 AMD64 / `ubuntu-24.04` | 18 次工具调用 | 14 项 | 9 项 | 4 项 | 14 项 |
| Ubuntu 24.04 ARM64 / `ubuntu-24.04-arm` | 18 次工具调用 | 14 项 | 9 项 | 4 项 | 14 项 |

覆盖范围包括：

- **工作流与工具**：编译后的实际程序接受本地 HTTP 模拟模型调用，执行文件、搜索、计划/待办、浏览器、图片/PDF 输入等工具；老师先驳回，学生恢复并修订，随后通过评审。
- **记忆**：任务结束自动生成两类画像；重启并切换工作目录后，通过原生工具检索画像和历史原文、评估记忆，继续遵守老师的驳回与恢复流程。
- **界面**：真实浏览器操作记忆筛选、分页、编辑、暂停/启用、来源查看、设置、反思和删除；各平台均通过 9 项检查。
- **便携运行**：仅复制程序和许可证到源码树外，在应用的 PATH 中排除 Node.js、Bun、npm 等开发运行时后，完成真实 HTTP 工作流并加载内嵌界面资源。
- **平台功能**：真实目录窗口打开/取消、凭据保存与重启解密、命令暂停/恢复/取消、SQLite 持久化和数据目录迁移。Linux 额外验证首次并发保存凭据、不安全权限及符号链接拒绝、迁移后新旧目录凭据均可独立解密。

## 本轮实际运行的文件

以下 SHA256 来自本轮验收报告，分别标识主程序与独立验收器。文件名中的 `Class.exe` / `Class.Verify.exe` 用于 Windows，`Class` / `Class.Verify` 用于 Linux。

| 目标 | 主程序 SHA256 | 验收器 SHA256 |
| --- | --- | --- |
| Windows ARM64 | `1cf0fca97cc7a2fc10ed0dbef6798fbefaa5342445c1cde999d4ab045d2ac3e4` | `96ea31fe8340045fe4fd9c80d8abace023b70550971a200edee25183b936068e` |
| Linux amd64 | `9c60c10390b09e4845c56c9b32bc516ef4ddb19d65a854588cfb139b9f4a3edc` | `ccc1d5838905b10a94ea2831593fd96d8f40309ab13e3dfcced8d9e9f7bbc711` |
| Linux arm64 | `3fd4e7ea3501b4fe013f0944646b0004f60b0a4ea02417ca78f9769b7b8ddf1f` | `ad71bf9be9c75544d8b94ba2f620f7cd9a13a528eca79be33bd8e163502924f3` |

在上面的 GitHub Actions 运行中，可下载对应的报告 artifact：

- `Class-1.0.0-windows-arm64-reports-36258965980-1`：汇总位于 `class-verification-SnxaAM/verification-summary.json`。
- `Class-1.0.0-linux-amd64-reports-36258965980-1`：汇总位于 `class-verification-CuHTem/verification-summary.json`。
- `Class-1.0.0-linux-arm64-reports-36258965980-1`：汇总位于 `class-verification-ahFU1c/verification-summary.json`。

各汇总记录套件输出、退出结果和子报告位置；界面子报告还包含截图。应同时核对目标架构、程序哈希、五套结果及清理状态。

## 结论边界

- 本轮运行 **不包含 Windows x64 云端验收**，也没有在三个目标平台执行全部 `npm test` 源码单元测试。
- Linux 本轮验证的是 **Ubuntu 24.04**，不包含 Ubuntu 22.04、其他发行版、Alpine/musl 或 macOS。
- 模型调用使用本地模拟服务与测试凭据；图片/PDF 检查覆盖媒体输入与传递流程，**没有验证外部真实模型的识别质量或服务兼容性**。
- 浏览器与目录窗口检查属于自动化测试，不能替代人工桌面体验评估，也不代表所有系统策略和外部工具组合均已验证。
- 构建清单的 `nativeRunVerified: false` 及验收包中“待验收”的说明是制包时的快照。本记录及原始运行报告记录之后完成的原生验收，不回写或伪造构建阶段结果。
- 仅更新说明文档并重新打包会改变压缩包 SHA256，不会改变上表中的主程序 SHA256；下载时还需使用同次发布的校验清单核对具体压缩包。
