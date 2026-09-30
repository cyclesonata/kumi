<p align="center">
  <img src="docs/assets/kumi-logo.svg" alt="kumi" width="300">
</p>

<p align="center">
  <a href="https://github.com/user1303836/kumi/actions/workflows/kumi.yml"><img alt="CI" src="https://github.com/user1303836/kumi/actions/workflows/kumi.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/user1303836/kumi/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/user1303836/kumi?label=release"></a>
  <img alt="Ableton Live 12" src="https://img.shields.io/badge/Ableton%20Live-12-111111">
  <img alt="Node 22 | 24" src="https://img.shields.io/badge/node-22%20%7C%2024-339933">
  <a href="LICENSE.md"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文 · <a href="README.ja.md">日本語</a>
</p>

**为 Ableton Live 打造、会学习你工作方式的录音室搭档。** 用平常的话告诉 Kumi 你想要什么，它就在你的工程里动手完成，从繁琐的杂活，到你根本没时间琢磨的事情：照着 YouTube 教程重建一个声音、把你的混音与参考曲对比、编写你描述的 Max for Live 设备，或者改造你指着的那个机架。每项修改都有各自的撤销，不会有任何事在你背后发生；它还会记住你保留下来的技巧，所以每次使用都更贴合你。

<p align="center">
  <img src="docs/assets/kumi-screenshot.png" alt="Kumi 根据视频教程重建 Drift 贝斯：记录每一步的对话、显示新轨道设备链的 FOCUS，以及每项修改都可撤销的 HISTORY" width="760">
</p>

## 它能做什么

- **修改工程里几乎任何东西：** 速度、音阶与律动；调音台、路由与侧链；轨道、场景与片段；音符与 MIDI 变换；设备、机架及其参数。每项修改都可单独撤销。
- **聆听：** 混音、采样或它自己弹出的音频的响度、音色平衡、声像宽度、速度与调性，以及你的混音与参考曲的差别。
- **观看教程：** 观看 YouTube 或本地文件中的视频，并在新轨道上搭建出教程里做的内容。
- **播放、录音与重采样**，在你要求时进行。
- **制作 Max for Live 设备：** 按你的描述制作设备，并放到你的轨道上。
- **显示你在哪里：** FOCUS 跟随你在 Live 中触碰的对象，显示为设备树、钢琴卷帘，或 Session、Arrangement 视图的条带。点击某个设备即可指向它：“这个 Saturator 太刺耳了”。
- **记住：** 关于你和每个工程的笔记、从你保留的声音中学到的技巧，以及可重放的配方。每次保存都会显示，点一下就能让它忘掉。
- **保存对话：** 为每个工程保存对话，并告诉你它关闭期间发生了哪些变化。
- **用你的模型：** 使用 ChatGPT 登录，或使用 OpenAI、Anthropic、OpenCode 的 API 密钥。

## 开始使用

需要 **Node.js 22 或 24**（[nodejs.org](https://nodejs.org)）和 Ableton Live 12。

```sh
npm run setup                        # 安装并构建，约一分钟
npm run kumi -- login openai-codex   # 使用 ChatGPT 登录（或设置 API 密钥）
npm run kumi -- bridge               # 在 Live 关闭时：把 Kumi 连接到 Live
npm run kumi                         # 在你的工程旁打开 Kumi
```

首次使用时，请在 Live 的 **Settings → Link, Tempo & MIDI** 中将 **AbletonMcpBridge** 选为控制界面（Control Surface）。之后 Kumi 会自己找到 Live。

遇到问题？`npm run kumi -- doctor` 会检查所有环节并告诉你该运行什么。`npm run kumi -- report` 把出错的情况整理成一个可以发给我们的文件，`npm run kumi -- update` 让 Kumi 和桥接保持最新。

在 Kumi 中输入 `/` 查看命令。Esc 停止 Kumi 正在做的事，`/stop` 停止 Live。

[完整指南（英文）](docs/en/KUMI_POC.md) · [命令与界面（英文）](docs/en/KUMI_TUI.md) · [更新日志（英文）](CHANGELOG.md)

## 当前状态

Kumi 1.0 已在 macOS 上的 Ableton Live 12.4（测试版）中测试；Windows 支持正在测试中。接下来将支持 Renoise 和 Reaper。

## 开发

```sh
npm run typecheck
npm test          # 无需 Live 或登录
```

`apps/kumi` 是终端应用；`packages/runtime` 包含 Kumi 的代理核心、模型提供方、记忆、音频分析以及与 Live 的集成。Kumi 通过本地桥接（`apps/mcp-server` 及其 Remote Script）与 Live 通信，该桥接也可由其他 MCP 客户端单独使用（[桥接指南（英文）](apps/mcp-server/README.md)）。

## 许可证

[MIT](LICENSE.md)。Ableton Live 是 Ableton AG 的商标；Kumi 与 Ableton 没有关联，也未获其认可。
