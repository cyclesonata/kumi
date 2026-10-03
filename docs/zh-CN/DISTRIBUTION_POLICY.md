# 发布与分发

[English](../en/DISTRIBUTION_POLICY.md) · 简体中文 · [日本語](../ja/DISTRIBUTION_POLICY.md)

Kumi 及其桥接如何送到用户手中，这能证明什么、不能证明什么，以及桥接的包可以包含哪些内容。制作发布版本的步骤见[开发者指南](DEVELOPER_GUIDE.md#发布)。

## 渠道

| 内容 | 位置 | 获取方式 |
| --- | --- | --- |
| Kumi | `user1303836/kumi` 的 GitHub Releases：`kumi.tar.gz`、`kumi-release.json` 和 `SHA256SUMS`，由 Installer 工作流附加到每个 `vX.Y.Z` 标签上 | `install.sh` 或 `install.ps1`，之后用 `kumi update` |
| 桥接（`@ableton-mcp/mcp-server`） | 包含在每个 Kumi 发行包中：既有 `npm pack` 生成的 tarball，也有已安装好的该 tarball | `kumi bridge`，它通过桥接的生命周期进行安装（[安装桥接](DELIVERY.md)） |
| 单独的桥接 | 没有自己的发布版本。用 `npm pack` 自行构建，或获取 CI 运行保留 90 天的 `exact-local-candidate` 产物 | 生命周期 CLI（[安装桥接](DELIVERY.md#独立桥接)） |

安装脚本从 `main` 分支读取；它们安装的发行包来自最新的已发布版本（或 `KUMI_VERSION` 指定的版本）。在维护者发布之前，发布版本只是草稿，只有已发布的版本才是“latest”。不会向 npm 发布任何内容：每个包都是 `private: true`，所以 `npm publish` 会拒绝。

## 只证明完整性，不证明身份

没有任何东西经过签名或公证，也没有原生安装程序（`.pkg`、`.msi`）。安装程序对照 `kumi-release.json` 中的 sha256 检查发行包，对照 nodejs.org 的 `SHASUMS256.txt` 检查 Node；`kumi update` 以同样的方式检查发行包，`kumi bridge` 则对照构建发行包时记录的哈希检查桥接的 tarball。与下载内容来自同一处的校验和只能证明字节完整送达，不能证明是谁制作的。

本软件采用 [MIT 许可证](../../LICENSE.md)。该许可证不授予任何 Ableton 商标权利，Kumi 与 Ableton 没有关联，也未获其认可。

## 桥接的包可以包含什么

- 编译后的运行时 JavaScript 和类型声明（没有 source map，没有测试）；
- Remote Script 及其 README、操作注册表，以及它们的哈希清单；
- Kumi 的 Live 扩展：它的清单、`package.json`、构建好的 `extension.js` 以及该文件的 sha256；
- 桥接的指南（`README.md` 和 `release-docs/`）；
- `release-manifest.json`、`package.json` 和 `LICENSE.md`。

除此之外别无他物：没有脚本、测试夹具、`node_modules`、凭据、配置、本地状态、日志、捕获的媒体或证据。`npm run package:verify` 会拒绝其明确列表之外的任何路径，`release-manifest.json` 则是确切载荷内容的唯一依据。CI 会打包桥接两次，第二次在全新的克隆中用全新的 `npm ci` 进行，并要求两次的字节完全相同。

## 发布清单

`release-manifest.json`（schema 为 `ableton-mcp-release/v2`）记录：包名和版本，源码提交以及工作树是否有未提交的修改，Node 版本范围和主版本，构建它所用的 Node、npm 和 TypeScript 版本以及运行器镜像，`package-lock.json` 和 CI 工作流的 SHA-256，构建方法，协议版本和注册表哈希，每个载荷文件的角色和 SHA-256，以及分发字段。

分发字段为 `channel: "local-npm-tarball"`、`published: false`、`signed: false` 和 `notarized: false`，`package:verify` 和生命周期都要求正好是这些值。这里的“本地”和“未发布”描述的是 tarball 本身：它用 `npm pack` 构建，按哈希从本地路径安装，从未发布到任何注册表。不过，它确实会随 GitHub Releases 上的 Kumi 发行包送到用户手中。生命周期仍接受较旧的 `ableton-mcp-private-release/v1` 清单，以便现有的安装可以升级或回滚。

## 合并门禁

`main` 分支有一套规则集：

- 修改通过拉取请求进入；不要求批准性审查；
- 必需的检查，必须在分支与 `main` 保持同步的状态下通过：`Required CI`、`Kumi / Node 22`、`Kumi / Node 24`、`Kumi / Windows / Node 24` 和 `Kumi / macOS / Node 24`；
- `main` 不能被删除或强制推送；
- 仓库管理员角色可以对拉取请求绕过这些规则。

Installer 工作流不是必需的检查，但在标签上，它的 `publish` 作业只有在发行包已在 macOS、Linux 和 Windows 上安装成功之后才会运行。[测试](TESTING.md#ci)介绍了每个作业。

## 待所有者决定的事项

- Kumi 在 macOS 和 Windows 上的发行包和安装程序的**签名与公证**。
- **再分发 Extensions SDK。** Kumi 的 Live 扩展是用本地提供的预发布版 Ableton Extensions SDK 构建的；由于其许可证限制再分发该 SDK，仓库从不提交它。构建出的 `extension.js` 把扩展与它用到的 SDK 代码打包在一起，并且会被提交，随桥接的包和 Kumi 发行包一起发布。这是否被允许，需要由所有者决定。
- `main` 规则集上的**管理员绕过**：保留还是移除。
