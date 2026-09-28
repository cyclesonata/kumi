# Kumi

[English](README.md) · 简体中文 · [日本語](README.ja.md)

以一只猫命名的个人音乐制作助手。此概念验证提供流式终端对话，可以检查当前
打开的 Ableton Live 工程并回答上下文追问。编辑、播放控制、录音、聆听音频和
记忆功能尚未实现。

## 开始使用

需要 **Node.js 22、24 或 25**（使用 [nodejs.org](https://nodejs.org) 的 LTS
安装程序即可）。在仓库根目录运行：

```sh
npm run setup                          # 安装并构建全部组件，约一分钟
npm run kumi -- login openai-codex     # 使用 ChatGPT 套餐登录（无浏览器环境用 --device）
npm run kumi                           # 讨论当前打开的 Live 工程
```

登录后会自动选择默认模型，可随时用 `npm run kumi -- model <provider>/<model>` 更改。
也可以使用 API 密钥：`openai/`、`anthropic/`、`opencode/` 模型分别使用
`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`OPENCODE_API_KEY`，运行
`npm run kumi -- auth` 可查看可用的提供方。退出后，对话历史会丢失。

安装桥接的 Remote Script 并在 Live 中将其选为控制界面（Control Surface）后，
Kumi 会自动找到桥接。在此之前 Kumi 仍可启动和对话，并提示尚未连接 Live。
首次安装桥接：[连接 Live（英文）](docs/en/KUMI_POC.md#connect-to-live)。

- [Kumi 设置、命令与限制（英文）](docs/en/KUMI_POC.md)
- [桥接配置](docs/zh-CN/USER_GUIDE.md) · [安全边界](docs/zh-CN/LIVE_SAFETY.md)
- [包含真实 Live 验收的验证记录（英文）](docs/evidence/kumi-poc.md)

在终端中全屏运行（对话、Live 面板和输入框）。输入 `/` 查看命令，Esc 停止当前
工作，Ctrl-C 先清空输入框，空时退出。
使用 `npm run typecheck` 和 `npm test` 进行测试，无需凭据或 Live。

## Ableton MCP Beyond — 独立桥接组件

[![Node 22 | 24 | 25](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2025-339933)](apps/mcp-server/package.json)

`@ableton-mcp/mcp-server` 仍可由其他 MCP 客户端独立使用，保留自己的锁文件、
Node 支持策略、安全契约和 CI。Kumi 目前使用桥接的 Live 读取工具，编辑与分析工具是下一步。

[桥接入口（英文）](apps/mcp-server/README.md) ·
[能力列表](docs/zh-CN/CAPABILITY_MATRIX.md) · [支持矩阵](docs/zh-CN/SUPPORT_MATRIX.md) ·
[运维](docs/zh-CN/OPERATIONS.md) · [恢复](docs/zh-CN/RECOVERY.md) · [交付](docs/zh-CN/DELIVERY.md)

托管仓库的更名由所有者另行完成。
[MIT 许可证](LICENSE.md)。本项目不代表与 Ableton AG 存在关联或获得其认可。
