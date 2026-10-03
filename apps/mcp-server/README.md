# Ableton MCP Beyond

The Ableton Live bridge behind Kumi, also usable on its own. It is a local MCP
server, `@ableton-mcp/mcp-server`, plus a Remote Script that runs inside
Live 12. Through it, any MCP client can:

- read the open Set;
- change almost anything in it, each change previewed, then applied, then undone
  when needed;
- play and record;
- analyze audio.

On Live 12.4 and later it also reaches Kumi's Live extension, for offline
renders and MIDI written straight into the Arrangement.

Started without a configuration, the server never connects to Live.

## Using Kumi?

Run `kumi bridge` with Live closed, then pick **AbletonMcpBridge** as a Control
Surface in Live. Kumi installs, starts and updates the bridge for you; see
[Get started](https://github.com/user1303836/kumi/blob/main/README.md#get-started).

Kumi starts the server itself and allows only the tools it uses. Its model calls
the read tools directly. Kumi's own tools make the changes, from tempo and the
mixer to clips, devices, deletions and recording, through previews and
applies. They also render audio and run Python inside Live. See
[how Kumi changes your Set](https://github.com/user1303836/kumi/blob/main/docs/en/KUMI_CHANGES.md).

## Quick start from source

You need Node.js 22 or 24 (24 LTS recommended). From the repository root:

```sh
cd apps/mcp-server
npm ci
npm run build
npm test
npm run demo                 # a short MCP session, no Live needed
node dist/src/cli.js         # the server, not connected to Live
```

To connect it to Live, follow
[Connect to Live](https://github.com/user1303836/kumi/blob/main/docs/en/USER_GUIDE.md#connect-to-live)
in the user guide. Then run:

```sh
node dist/src/cli.js --config /absolute/path/bridge-config.json
npm run diagnostics -- --config /absolute/path/bridge-config.json
```

## What's in the package

| Command | What it does |
| --- | --- |
| `ableton-mcp-server` | The MCP server on stdio: no arguments, or `--config PATH` |
| `ableton-mcp-setup` | Writes a server configuration |
| `ableton-mcp-install-remote-script` | Copies the Remote Script into Live's Remote Scripts folder |
| `ableton-mcp-diagnostics` | Checks Node, the package, the configuration and the connection to Live |
| `ableton-mcp-lifecycle` | Installs, activates, upgrades, repairs, rolls back and uninstalls a release |
| `ableton-mcp-migrate` | Converts an older configuration file |

## Before you connect a client

Every change has a preview and an apply, and most have an undo. A confirmation
the server hands out is not a person's approval. A client should show the
preview before anything that plays, records or deletes.

Limit what a client can do with `ABLETON_MCP_TOOL_POLICY` (`read-only`,
`edit-no-audio`, `performance` or `full`). `full` includes `live_run_python`,
which runs any Python inside Live. Deny it with
`ABLETON_MCP_TOOL_DENY=live_run_python` for a client you don't fully trust.

## Documentation

- [User guide](https://github.com/user1303836/kumi/blob/main/docs/en/USER_GUIDE.md):
  setup, configuration, policy and every tool.
- [Worked examples](https://github.com/user1303836/kumi/blob/main/docs/en/USER_JOURNEYS.md).
- [Live safety](https://github.com/user1303836/kumi/blob/main/docs/en/LIVE_SAFETY.md).
- [Operations](https://github.com/user1303836/kumi/blob/main/docs/en/OPERATIONS.md) and
  [recovery](https://github.com/user1303836/kumi/blob/main/docs/en/RECOVERY.md).
- [Installing a release](https://github.com/user1303836/kumi/blob/main/docs/en/DELIVERY.md).
- [Capabilities](https://github.com/user1303836/kumi/blob/main/docs/en/CAPABILITY_MATRIX.md)
  and [supported platforms](https://github.com/user1303836/kumi/blob/main/docs/en/SUPPORT_MATRIX.md).

Every guide is also in Japanese and Simplified Chinese:
[日本語](https://github.com/user1303836/kumi/blob/main/docs/ja/USER_GUIDE.md) ·
[简体中文](https://github.com/user1303836/kumi/blob/main/docs/zh-CN/USER_GUIDE.md).

A release tarball carries the same guides under `release-docs/`, matching its
version; prefer those when they differ from `main`. The package has its own
lockfile, build and tests, and doesn't need Kumi installed.

MIT licensed. Release tarballs are unsigned. Ableton Live is a trademark of
Ableton AG; this project is not affiliated with or endorsed by Ableton.
