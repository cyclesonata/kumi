# Developer guide

English · [简体中文](../zh-CN/DEVELOPER_GUIDE.md) · [日本語](../ja/DEVELOPER_GUIDE.md)

How the repository fits together, how to work on each part, and how to release.
[Testing](TESTING.md) has every test command and what CI runs.

## Layout

| Folder | What's in it |
| --- | --- |
| `apps/kumi` | The `kumi` command and the terminal app (`src/tui/`); `scripts/` holds the opt-in checks against a model or real Live |
| `packages/runtime` | Kumi's agent core: `kernel/` (the agent loop), `providers/` and `auth/` (models and sign-in), `core/` (sessions, memory, techniques, recipes, goals, matching), `integrations/ableton/` (Kumi's Live tools), `audio/`, `video/`, `web/`, `devices/` (Max for Live devices), `mcp/` (the bridge client) |
| `apps/mcp-server` | The bridge, `@ableton-mcp/mcp-server`: an MCP server over stdio, with its own lockfile, tests and CI. Also the lifecycle, setup, migration and diagnostics commands |
| `remote-script` | The bridge's Remote Script, which runs inside Live (`ableton_mcp_remote_script.py`, the `AbletonMcpBridge/` entry point, Python tests) |
| `apps/live-extension` | Kumi's Live extension for Live 12.4 and later, on Live's Extensions SDK |
| `protocol` | `ableton-live-v1.operations.json`, the operation registry the bridge and the Remote Script share |
| `scripts` | `build-release.mjs` (the installer's bundle) and `test-isolated.mjs` |
| `install.sh`, `install.ps1` | The installers |

The root is an npm workspace of `apps/kumi` and `packages/runtime`. The bridge is
deliberately separate: it builds, tests and packs on its own, and works without
Kumi.

## How the parts talk

```text
kumi (apps/kumi, packages/runtime)
  │  MCP over stdio: Kumi starts the bridge as a child process
  ▼
bridge (apps/mcp-server)
  │  ableton-loopback/v1: authenticated TCP on 127.0.0.1
  ├──► Remote Script inside Live (remote-script/)
  │  local channel to the Extension Host
  └──► Kumi's Live extension (apps/live-extension), Live 12.4+
```

- Kumi starts the bridge with the `full` deployment policy and an allow list of
  exactly the tools it uses (`ABLETON_MCP_TOOL_ALLOW`). The model calls a few
  bridge reads directly (`MODEL_TOOLS` in `packages/runtime/src/mcp/allowed-tools.ts`);
  Kumi's own tools call the rest.
- The bridge's router (`apps/mcp-server/src/bridge/router.ts`) sends each
  operation to the Remote Script, or to the extension when only the extension
  has it. The bridge can start Live's Extension Host itself when Live's
  Developer Mode keeps it from starting extensions.
- `kumi bridge` installs the bridge into Live through the bridge's lifecycle
  command, and finds it later through
  `Remote Scripts/AbletonMcpBridge/bridge-reference.json`.

## Setup

With Rust, Cargo, Python 3.11 or later, and git:

```sh
cargo build --release --locked --workspace --bins
cargo run --release -p kumi --
cargo run --release -p kumi -- bridge --allow-dirty   # Live must be closed
```

The existing npm setup/start commands use this checkout when Cargo is available. Without Cargo,
they hand off to the matching published native release. Node.js 22 or 24 is needed for the
TypeScript reference build and tests, not for the native application.

A checkout shares `~/.kumi` (settings, sign-ins, conversations, the bridge's
state) with an installed Kumi. `--allow-dirty` lets `kumi bridge` install the
bridge from a checkout with uncommitted changes. On Windows without Developer Mode or an
elevated shell, tests that create symlinks skip or fail; CI's runners can.

## Working on Kumi

**A change family** (a kind of change with its own HISTORY row and undo) is an
entry in `BASE_CHANGES` (`packages/runtime/src/integrations/ableton/changes.ts`)
or `MORE_CHANGES` (`more-changes.ts`), which `CHANGES` combines: the Kumi tool
name, the bridge's preview and apply, a family (one of the fixed set of pictures
HISTORY and NOW draw), a description for the model,
and a `summarize` that turns the preview into plain words. Give it `since` (the
first bridge release it works with, in `bridge-version.ts`) when older bridges
refuse it, and `permanent` when Live gives no way back. Tests check every family
for a unique tool, a title from a bare preview, descriptions that never ask the
model to confirm, and host-only bridge tools. Run it on real Live with its undo
(`accept:live`) before offering it.

**An action** (something that isn't a change to the Set, with nothing to undo,
such as playing) goes in `ACTIONS` in `actions.ts`.

When the bridge's tools change, regenerate the synthetic bridge the change eval
uses: `node apps/kumi/scripts/make-bridge-tools.mjs` (needs a built bridge).

The terminal app's design and foundations are in
[commands, keys and screens](KUMI_TUI.md#design-notes).

## Working on the bridge

| Path | What it is |
| --- | --- |
| `src/host.ts` | MCP dispatch, strict tool schemas, transactions, undo and recovery |
| `src/tool-catalog.ts` | The single tool catalog: schemas, annotations, the capabilities each tool needs, and its deployment policy class |
| `src/live.ts`, `src/registry.ts` | Live types and adapters; loading and validating the registry and its hash |
| `src/bridge/` | The authenticated loopback client (`remote-adapter.ts`), the router, and the extension channel, launcher and folders |
| `src/transactions/` | Batches, device state, Session MIDI and discovery helpers |
| `src/mcp-protocol.ts`, `src/stdio.ts` | MCP wire handling for both protocol versions |
| `src/analysis*.ts`, `src/audio-*.ts`, `src/reference-analysis.ts` | Audio analysis in isolated workers |
| `src/delivery.ts`, `src/lifecycle*.ts`, `src/setup.ts`, `src/migrate.ts`, `src/diagnostics.ts` | Configuration, secrets, install, upgrade, rollback and diagnostics |
| `src/als.ts`, `src/project*.ts`, `src/library-search.ts` | Saved Sets, Set snapshots and diffs, Live's library database |
| `src/follow-actions.ts` | The optional [Willington](WILLINGTON_INTEGRATION.md) Follow Actions |

**Contract rules.**

- The wire protocol is `ableton-loopback/v1`: canonical JSON (sorted keys,
  negative zero normalized), HMAC-SHA256 on requests and responses, bounded
  frames and collections, sequence numbers, and an epoch that changes each time
  the Remote Script starts. The details are in `remote-script/README.md`.
- The registry in `protocol/` is the only list of operations. The host and the
  Remote Script each hash it and must agree, or Live never connects; a host
  test runs the Remote Script's hashing to hold them equal. Never copy
  operation names or the hash into another source file. After changing the
  registry, run `npm run capability:manifest` in `apps/mcp-server`.
- Changes go through purpose-specific operations with a preview, an apply and
  an undo. The one exception is `python.run` (`live_run_python`), which runs
  Python on Live's main thread with Live's undo as the only way back; it has its
  own policy class, `python`, allowed only by the `full` profile.
- The bridge's internal `get(ref)` is a bounded serializer over fixed rows, not
  a general reader of Live's object model; MCP reads stay purpose-specific.
- The Remote Script does all its work with Live on Live's main thread: it
  serves the sockets itself inside Live's display tick, within a time budget.
  Its only other threads write the diagnostics file and receive realtime UDP. A
  new epoch invalidates every earlier reference and cursor. A Live shape
  the Remote Script doesn't recognize is reported unavailable, never faked.
- stdout carries only the MCP protocol. Diagnostics go to stderr, without
  request data.
- The process-backed adapter is asynchronous (`snapshotAsync`, `invokeAsync`,
  …), while the shared interface and the simulator still have synchronous
  methods; `McpHost.handleAsync` is the path for process-backed tools. Test
  compatibility work against both until the synchronous surface goes.
- Tests never need a running Live, a device, a particular machine or local-only
  material. Every new operation gets tests, including bad input and recovery.

**MCP versions.** The bridge speaks both `2025-11-25` (initialize, then
requests) and `2026-07-28` (per-request `params._meta` with the protocol version
and client capabilities, plus `server/discover`); one process uses one or the
other. Unknown versions get `-32022`; bad metadata `-32602`. Modern results carry
`resultType: "complete"` and also return JSON in `structuredContent`. The modern
version has no push: `live_subscribe` works only in the older one, and modern
clients poll. Client metadata never grants access to Live. See the
[specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).

## Working on the Live extension

`apps/live-extension` builds against Live's Extensions SDK, whose licence
forbids redistributing it, so it isn't in the repository: put a copy at
`vendor/ableton-extensions-sdk-1.0.0-beta.1/` in the repository root (the build
reads `package 3/dist/index.cjs` inside it). `apps/live-extension` isn't part of
the root workspace: run `npm ci` there, then `npm run build`, which writes
`dist/extension.js` and its `.sha256`; commit both. Without
the SDK, the build stops and the committed bundle stays; tests check the bundle
against its checksum. Measurements of how Live runs the extension are in
[the evidence](../evidence/live-extension.md).

## Releasing

**Commits** have plain-English subjects that say what changed for the producer
("Kumi: talk to it while it works"). A bridge or Remote Script change bumps
`apps/mcp-server/package.json` (and its lockfile), starts its subject with the
new version ("Bridge 1.0.71: …"), bumps the fake bridge's version in
`apps/kumi/scripts/eval-changes.mjs`, and adds a `### Bridge x.y.z` block under
`## Unreleased` in `CHANGELOG.md`. If the bridge's tools changed, regenerate
`apps/kumi/scripts/bridge-tools.json`; if the extension changed, rebuild and
commit its bundle. Work goes on a branch and reaches `main` by pull request.

**A Kumi release:**

1. On the branch, one commit titled "Kumi X.Y.Z: the changelog, READMEs and
   versions" sets the version in the root `package.json` and lockfile,
   `apps/kumi/package.json` (its version and its `@kumi/runtime` dependency),
   `packages/runtime/package.json` and `packages/runtime/src/version.ts` (a test
   holds the four equal); the Status line of the three READMEs; the ships-with
   line under "Bridge versions" in the three `KUMI_CHANGES.md`; and the
   `CHANGELOG.md`'s `## Unreleased` becomes `## X.Y.Z — date`, with a line
   that says which bridge it ships with.
2. Merge the pull request with a merge commit titled "Kumi X.Y.Z (#PR)".
3. Tag the merge commit `vX.Y.Z` and push the tag. The Installer workflow builds
   the bundle, tests installing it on macOS, Linux and Windows, and attaches
   `kumi.tar.gz`, `kumi-release.json` and `SHA256SUMS` to a draft release
   "Kumi X.Y.Z".
4. Write the release notes and publish the release. Only then do the installers,
   `kumi update` and the update check see it.

`kumi-release.json` records the exact Node 24 release the bundle was built
with, and the installer downloads that Node from nodejs.org beside Kumi. A
release on a new Node major makes `kumi update` ask users to run the installer
again.

**The bridge** has no release of its own: it ships inside each Kumi release, and
each CI run on `main` keeps a packed candidate for 90 days.
[Distribution](DISTRIBUTION_POLICY.md) covers what a release contains and how
it's checked.

## Docs

Every doc in `docs/en` has a Japanese and a Chinese copy in `docs/ja` and
`docs/zh-CN`, and the READMEs have `README.ja.md` and `README.zh-CN.md`. A
change to one language goes into all three in the same pull request. The
bridge's docs (its README and the fourteen `docs/en` pages listed in
`apps/mcp-server/scripts/release-documentation.mjs`) are packed with it, so
their names are fixed and their links must resolve. Checks in
`apps/mcp-server` (see [Testing](TESTING.md#docs)) hold the Node versions the
docs state, the tool names the three user guides list, and file counts.

## Prior art

The bridge started from other Ableton MCP servers:
[bschoepke/ableton-live-mcp](https://github.com/bschoepke/ableton-live-mcp),
[uisato/ableton-mcp-extended](https://github.com/uisato/ableton-mcp-extended),
[Simon-Kansara/ableton-live-mcp-server](https://github.com/Simon-Kansara/ableton-live-mcp-server),
[jasper-zheng/ableton-sdk-mcp](https://github.com/jasper-zheng/ableton-sdk-mcp)
and [ahujasid/ableton-mcp](https://github.com/ahujasid/ableton-mcp).
