# Kumi

[English](README.md) · 简体中文 · [日本語](README.ja.md)

以一只猫命名的个人音乐制作助手：在终端中全屏运行，围绕当前打开的 Ableton Live
工程对话。它回答关于工程的问题，并执行你要求的几乎所有 Live 脚本接口允许的修改：
速度、拍号、律动与音阶，调音台、路由与侧链，轨道、返回轨与场景，片段、音符与
MIDI 变换，设备、机架及其参数，以及它在你电脑上找到的采样。每项修改都显示在
HISTORY 中，并可单独撤销。在你要求时，它还能播放、录音，并通过重采样把声音转成
音频。它可以聆听音频（参考曲、采样或它自己的录音），并把你的混音与参考曲对比。
它还能观看 YouTube 或本地文件中的视频教程，并在工程中搭建出教程里做的内容。
它会把你的工作流程存为可重放的配方，也能通过观察你的操作学会流程。它会记下你告诉
它的简短笔记。它会记住每个已保存的工程，下次打开时接着之前的对话，并告诉你 Kumi
关闭期间发生了哪些变化。

## 开始使用

需要 **Node.js 22 或 24**（使用 [nodejs.org](https://nodejs.org) 的 Node 24 LTS
安装程序即可；Node 25 已停止维护）。在仓库根目录运行：

```sh
npm run setup                          # 安装并构建全部组件，约一分钟
npm run kumi -- login openai-codex     # 使用 ChatGPT 套餐登录（无浏览器环境用 --device）
npm run kumi -- bridge                 # 先关闭 Live：把桥接装入 Live（或更新它）
npm run kumi                           # 讨论当前打开的 Live 工程
npm run kumi -- doctor                 # 遇到问题时：检查所有环节并告诉你该运行什么
```

登录后会自动选择默认模型，可随时用 `npm run kumi -- model <provider>/<model>` 更改。
也可以使用 API 密钥：`openai/`、`anthropic/`、`opencode/` 模型分别使用
`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`OPENCODE_API_KEY`，运行
`npm run kumi -- auth` 可查看可用的提供方。关于未保存工程的对话会在关闭 Kumi 后结束。

要连接 Live，请先关闭 Live，再运行 `npm run kumi -- bridge`：它会安装（或更新）桥接的
Remote Script，然后等待你打开 Live。首次安装时，请在 Live 的
**Settings → Link, Tempo & MIDI** 中将 `AbletonMcpBridge` 选为控制界面（Control Surface）。
之后 Kumi 会自动找到桥接。在此之前 Kumi 仍可启动和对话，并提示尚未连接 Live
（[连接 Live（英文）](docs/en/KUMI_POC.md#connect-to-live)）。

- [Kumi 设置、命令与限制（英文）](docs/en/KUMI_POC.md)
- [桥接配置](docs/zh-CN/USER_GUIDE.md) · [安全边界](docs/zh-CN/LIVE_SAFETY.md)
- [包含真实 Live 验收的验证记录（英文）](docs/evidence/kumi-poc.md)

在终端中全屏运行（对话、Live 面板和输入框）。输入 `/` 查看命令，Esc 停止当前
工作，`/stop` 停止 Live，Ctrl-C 先清空输入框，空时退出。[更新日志（英文）](CHANGELOG.md)。
使用 `npm run typecheck` 和 `npm test` 进行测试，无需凭据或 Live。

## 测试环境与后续计划

目前 Kumi 只在 Ableton Live 12.4.15b4 上测试过，其他版本的 Live 尚未试用。接下来将支持
Renoise 和 Reaper。

## Ableton MCP Beyond — 独立桥接组件

[![Node 22 | 24](https://img.shields.io/badge/node-22%20%7C%2024-339933)](apps/mcp-server/package.json)

`@ableton-mcp/mcp-server` 仍可由其他 MCP 客户端独立使用，保留自己的锁文件、
Node 支持策略、安全契约和 CI。Kumi 使用桥接的 Live 读取、编辑、走带与录音工具（带经过验证的撤销），并自行分析音频。

[桥接入口（英文）](apps/mcp-server/README.md) ·
[能力列表](docs/zh-CN/CAPABILITY_MATRIX.md) · [支持矩阵](docs/zh-CN/SUPPORT_MATRIX.md) ·
[运维](docs/zh-CN/OPERATIONS.md) · [恢复](docs/zh-CN/RECOVERY.md) · [交付](docs/zh-CN/DELIVERY.md)

托管仓库的更名由所有者另行完成。
[MIT 许可证](LICENSE.md)。本项目不代表与 Ableton AG 存在关联或获得其认可。
