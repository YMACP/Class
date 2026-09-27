# 示例配置与任务

本目录只包含可公开的占位配置和固定数学示例，不含真实 API key、用户任务或运行结果。

- `config.json`：1 名老师、3 名学生的 CLI 配置模板；模型名称是占位符，API key 通过 `CLASS_API_KEY` 环境变量读取。
- `workspace/problem.txt`：求 1 到 100 的整数之和的示例任务。

`cwd: "./workspace"` 相对于配置文件位置解析，因此本目录中的模板对应 `examples/workspace/`。建议按照 [命令行指南](../docs/cli.md) 将配置复制为源码根目录的 `config.local.json`，创建自己的根目录 `workspace/`，再修改模型、接口和任务。

无需模型的固定演示可在源码根目录执行：

```powershell
npm ci
npm run demo -- --output-dir D:\Class\verification\runs
```

演示只验证固定成功路径，不代表真实供应商调用已通过。完整开发与发布验证见 [开发指南](../docs/development.md)。
