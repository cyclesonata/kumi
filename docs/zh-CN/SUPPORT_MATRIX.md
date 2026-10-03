# 支持的平台

[English](../en/SUPPORT_MATRIX.md) · 简体中文 · [日本語](../ja/SUPPORT_MATRIX.md)

Kumi 及其桥接能在哪些系统上运行、适用于哪些版本的 Live，以及在哪里测试过什么。每一项“已测试”背后的证据列在[实现状态](IMPLEMENTATION_STATUS.md)中。

## Kumi

| 系统 | 版本 | 处理器 | 状态 |
| --- | --- | --- | --- |
| macOS | 13（Ventura）或更高 | Apple 芯片、Intel | 已在 Apple 芯片上配合 Live 测试 |
| Windows | 10 或 11 | x64、ARM64 | 已测试安装和连接 Live；见 [Windows](#windows) |
| Linux | glibc 发行版（不包括 Alpine 或其他 musl 发行版） | x64、ARM64 | Kumi 可以安装和运行，但没有 Live：Live 没有 Linux 版 |

安装程序会带上 Kumi 自己的 Node，也就是构建和测试 Kumi 时所用的那个确切的 Node 24 版本，所以你不必自己安装 Node。如果以后的 Kumi 换用另一个 Node 主版本，`kumi update` 会提示你重新运行安装程序，由它带来新的 Node。

## Ableton Live

| Live | 状态 |
| --- | --- |
| 12.4 或更高 | 全部功能，包括 Kumi 的 Live 扩展：离线渲染、把 MIDI 片段写进编曲视图、清除一段范围，以及 **Ask Kumi about this**。已在 macOS 上的 Live 12.4.15 beta 中测试。 |
| 12.0 至 12.3 | 桥接提供该版本 Live 的 API 所具备的功能；没有扩展，因此上述功能都不可用。`kumi doctor` 会说明这一点。未测试。 |
| 11 或更早 | 不支持。 |

版本类型：桥接会探查它所连接的 Live 提供了什么，因此某个版本类型缺少的设备和内容（Standard 和 Intro 较少）会保持不可用，而不会靠猜测。制作 Max for Live 设备需要 Max for Live（Suite，或加装了该附加组件的 Standard）。可选的 Willington 提供方只适用于某一个确切的 Live 构建版本；见 [Willington 集成](WILLINGTON_INTEGRATION.md)。

## Windows

已测试：在 CI 上，于 Windows PowerShell 5.1 中测试了安装程序、`kumi update`、`kumi bridge` 和 `kumi uninstall`；在一台装有 Live 12.4.15 beta 的 Windows 10 电脑上，测试了用 `kumi bridge` 安装到已移出用户文件夹的 User Library、Remote Script 在 Live 中加载，以及 Kumi 连接。CI 的 Windows 运行器使用默认文件夹的管理员账户，因此无法暴露只在普通账户或移动过的库中才会出现的问题。

尚未在 Windows 上确认：

- **Live 把 Extensions 文件夹放在哪里。** Kumi 使用 `%LOCALAPPDATA%\Ableton\Extensions`；`KUMI_LIVE_EXTENSIONS_DIR` 可以覆盖它。在确认之前，扩展的各项功能在 Windows 上都未经测试。
- **全屏应用在 Windows 终端中的表现。** 推荐使用 Windows Terminal；见[终端](KUMI_TUI.md#终端)。
- **从 Kumi 1.6.0 或更早版本运行 `kumi update`** 时，如果 PATH 上 Git 的 `tar` 排在 Windows 自带的 tar 前面（例如在从 Git Bash 启动的 PowerShell 中），会因 tar 错误而失败。请重新运行那行安装命令，或在 `kumi update` 之前运行 `$env:Path = "$env:SystemRoot\System32;$env:Path"`。

## 源码副本与独立桥接所用的 Node.js

| Node.js | 状态 |
| --- | --- |
| 22.x、24.x | 支持；推荐 Node 24 LTS |
| 25.x | 不支持：已于 2026 年 6 月 1 日终止维护 |
| 26.x 及更高、21.x 及更早、预发布版 | 经过测试之前不支持 |

每个包的 engines 范围都是 `>=22 <23 || >=24 <25`。源码副本中的 `kumi` 会拒绝其他主版本（`kumi doctor` 除外，它会说明问题所在）。桥接的服务器和 `ableton-mcp-setup` 同样会拒绝；`ableton-mcp-diagnostics` 会报告它们；`ableton-mcp-lifecycle` 和 `ableton-mcp-migrate` 仍可运行，以便检查或移除旧的安装。

## MCP 协议

桥接通过 stdio 使用两代 MCP 协议：`2025-11-25`（使用 initialize 握手）和 `2026-07-28`（使用逐请求元数据和 `server/discover`）。在新一代协议中，每个结果都是完整的，缓存提示为 private 且 TTL 为零，也不会在未经请求时推送任何内容；不提供 MRTR、Tasks 或 HTTP。测试覆盖了这两代协议；没有对任何特定的 MCP 客户端或模型进行认证。如何连接客户端见[用户指南](USER_GUIDE.md)。

## 无障碍

`KUMI_UI=plain`（或把输出通过管道传出）会让 Kumi 使用逐行输出的纯文本界面，适合屏幕阅读器；见[纯文本模式](KUMI_TUI.md#纯文本模式)。桥接自身的输出是顺序固定的纯文本，没有仅靠颜色区分的状态，也没有需要鼠标指针的操作。两者都尚未用 VoiceOver 或 Narrator 测试过；Live、插件窗口和 MCP 客户端的表现则由各自的开发者决定。

## CI 覆盖的范围

CI 在 GitHub 托管的 macOS 15、Ubuntu 24.04 和 Windows Server 2025 运行器上，使用 Node 22 和 24 运行；这些运行器都没有 Live。[测试](TESTING.md#ci)列出了每个作业。
