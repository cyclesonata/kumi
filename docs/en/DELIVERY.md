# Installing the bridge

English · [简体中文](../zh-CN/DELIVERY.md) · [日本語](../ja/DELIVERY.md)

The bridge has two parts: the `AbletonMcpBridge` Remote Script that Live
loads, and a local MCP server that Kumi (or another MCP client) starts. Both
come in one package, `@ableton-mcp/mcp-server`, and one tool installs them: the
bridge's lifecycle CLI, `ableton-mcp-lifecycle`. It plans before it changes
anything, records what it installed in a receipt, and can repair, roll back and
remove exactly that. With Kumi, `kumi bridge` runs it for you.

## With Kumi

Quit Live, then run `kumi bridge`. It:

1. refuses while Live is running, and asks you to confirm Live is closed
   (`--yes` confirms beforehand);
2. copies the bridge's package from the Kumi bundle (in a checkout, packs it
   with `npm pack` instead) into a folder of its own and checks its hash;
3. runs the lifecycle's `install`, or `upgrade` when a bridge is already there:
   first a plan, then the change;
4. puts Kumi's Live extension into Live's Extensions folder, which Live 12.4
   and later run;
5. waits up to ten minutes for Live to connect through the new bridge, running
   the lifecycle's `activate` every few seconds.

The first time you open Live afterwards, choose **AbletonMcpBridge** as a
Control Surface in **Settings → Link, Tempo & MIDI**. In a checkout with
uncommitted changes, `kumi bridge --allow-dirty` installs anyway (developers
only).

`kumi update` runs `kumi bridge` for you when the bridge in Live is older than
Kumi's and Live is closed. `kumi uninstall` offers to take the bridge and the
extension out of Live through the lifecycle's `uninstall`, and keeps the
bridge's files while Live still loads from them. `kumi doctor` checks the whole
chain. The [Kumi guide](KUMI_GUIDE.md#connect-to-live) covers this from a
producer's side.

| What | Where |
| --- | --- |
| The bridge's package | `~/.kumi/bridge/<version>-<time>/node_modules/@ableton-mcp/mcp-server` |
| Its state: secret, configuration, receipt, journal | `~/.kumi/bridge/state`, or the folder of the bridge configuration already installed |
| The Remote Script | `AbletonMcpBridge` in your User Library's Remote Scripts folder (see [Live's folders](#lives-folders)) |
| Kumi's Live extension | `kumi.kumi` in Live's Extensions folder |

`KUMI_REMOTE_SCRIPTS_DIR` and `KUMI_LIVE_EXTENSIONS_DIR` override the two Live
folders, `KUMI_HOME` moves `~/.kumi`, and `KUMI_BRIDGE_WAIT_SECONDS` sets how
long to wait for Live (`0` doesn't wait). Kumi finds the installed bridge
through `bridge-reference.json`, which the lifecycle writes beside the Remote
Script.

## The standalone bridge

For MCP clients other than Kumi. You need Node: Node 22 and 24 are supported,
and Node 24 LTS is recommended. You also need the bridge's tarball:

- **Build it:** in a clean checkout, `cd apps/mcp-server && npm ci && npm pack`.
  A tarball built from uncommitted changes installs only with
  `--allow-dirty-private-build`.
- **Or take it from CI:** every CI run keeps an `exact-local-candidate`
  artifact for 90 days, with `candidate-metadata.json` giving its sha256. On a
  pull request it is built from GitHub's merge commit, not the branch head.

Install the package where it will stay, then install the bridge into Live.
macOS (bash or zsh):

```sh
ARTIFACT=/absolute/path/to/ableton-mcp-mcp-server-x.y.z.tgz
ARTIFACT_SHA="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
INSTALL_ROOT="$HOME/Library/Application Support/AbletonMcp/package"
STATE="$HOME/Library/Application Support/AbletonMcp/state"
REMOTE_SCRIPTS="$HOME/Music/Ableton/User Library/Remote Scripts"
mkdir -p "$INSTALL_ROOT" "$REMOTE_SCRIPTS"
npm install --prefix "$INSTALL_ROOT" --ignore-scripts --no-audit --no-fund "$ARTIFACT"
PACKAGE_ROOT="$INSTALL_ROOT/node_modules/@ableton-mcp/mcp-server"
LIFECYCLE="$INSTALL_ROOT/node_modules/.bin/ableton-mcp-lifecycle"

"$LIFECYCLE" install --remote-scripts-dir "$REMOTE_SCRIPTS" --state-dir "$STATE" \
  --package-root "$PACKAGE_ROOT" --artifact "$ARTIFACT" --artifact-sha256 "$ARTIFACT_SHA"
# Read the plan, quit Live, then:
"$LIFECYCLE" install --remote-scripts-dir "$REMOTE_SCRIPTS" --state-dir "$STATE" \
  --package-root "$PACKAGE_ROOT" --artifact "$ARTIFACT" --artifact-sha256 "$ARTIFACT_SHA" \
  --apply --confirm-live-stopped
```

Windows (PowerShell):

```powershell
$Artifact = (Resolve-Path 'C:\absolute\path\to\ableton-mcp-mcp-server-x.y.z.tgz').Path
$ArtifactSha = (Get-FileHash -Algorithm SHA256 $Artifact).Hash.ToLowerInvariant()
$InstallRoot = Join-Path $env:LOCALAPPDATA 'AbletonMcp\package'
$State = Join-Path $env:LOCALAPPDATA 'AbletonMcp\state'
$RemoteScripts = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Ableton\User Library\Remote Scripts'
New-Item -ItemType Directory -Force $InstallRoot, $RemoteScripts | Out-Null
npm install --prefix $InstallRoot --ignore-scripts --no-audit --no-fund $Artifact
$PackageRoot = Join-Path $InstallRoot 'node_modules\@ableton-mcp\mcp-server'
$Lifecycle = Join-Path $InstallRoot 'node_modules\.bin\ableton-mcp-lifecycle.cmd'

& $Lifecycle install --remote-scripts-dir $RemoteScripts --state-dir $State `
  --package-root $PackageRoot --artifact $Artifact --artifact-sha256 $ArtifactSha
# Read the plan, quit Live (check Task Manager), then:
& $Lifecycle install --remote-scripts-dir $RemoteScripts --state-dir $State `
  --package-root $PackageRoot --artifact $Artifact --artifact-sha256 $ArtifactSha `
  --apply --confirm-live-stopped
```

If you moved your User Library, use its Remote Scripts folder instead (see
[Live's folders](#lives-folders)). Then open Live, choose **AbletonMcpBridge**
as a Control Surface, and run `activate` with the same three folder options.
The [user guide](USER_GUIDE.md) shows how to point an MCP client at the
installed server with `--config <state>/bridge-config.json`.

To upgrade, install the new tarball under a new prefix and run `upgrade` with
the new `--package-root`, `--artifact` and `--artifact-sha256`. To remove, run
`uninstall`, restart Live, update your MCP client's configuration, and only
then delete the npm prefix.

## Lifecycle CLI reference

```text
ableton-mcp-lifecycle <action> --remote-scripts-dir DIR [options]
```

| Action | What it does | Needs |
| --- | --- | --- |
| `install` | Creates an owner-only secret and bridge configuration, installs the Remote Script, writes the receipt | `--artifact`, `--artifact-sha256`; Live stopped |
| `activate` | Checks, without changing Live or the installation, that Live loaded this bridge and answers through it; records the result in the receipt | Live running, the Control Surface chosen |
| `upgrade` | Replaces the bridge with a newer package, keeping the secret and the previous version for `rollback` | A newer `--artifact`, its sha256, its `--package-root`; Live stopped |
| `repair` | Compares what's installed with the receipt; with `--apply`, moves changed files to quarantine and restores the package's own | — |
| `rollback` | Goes back to the version the last upgrade kept | Live stopped |
| `uninstall` | Removes the files the receipt owns; moves changed or unknown ones to quarantine; keeps the secret | Live stopped |
| `status` | Read-only report: receipt, file integrity, drift, permissions, whether rollback is possible | — |

| Option | Meaning |
| --- | --- |
| `--remote-scripts-dir DIR` | Live's Remote Scripts folder (required) |
| `--state-dir DIR` | Where the secret, configuration, receipt and journal live. Default `~/.config/ableton-mcp`, or `%APPDATA%\ableton-mcp` on Windows |
| `--package-root DIR` | The installed package to use. Default: the package this CLI belongs to |
| `--artifact FILE`, `--artifact-sha256 HEX` | The tarball, and its hash; the lifecycle checks the installed package against the tarball's own manifest |
| `--config FILE`, `--secret FILE` | Other paths for the configuration and secret (defaults: `bridge-config.json` and `bridge.secret` in the state folder) |
| `--host`, `--port`, `--realtime-port` | Loopback address and ports for a new installation: `127.0.0.1` (or `::1`), 9765 and 9766 by default |
| `--timeout-ms N` | The bridge's request timeout written to the configuration (default 5000) |
| `--apply` | Make the change. Without it, every action only plans |
| `--confirm-live-stopped` | You quit Live; needed by `install`, `upgrade`, `rollback` and `uninstall` with `--apply` |
| `--purge-secret` | With `uninstall`: also delete the secret, only if the lifecycle created it |
| `--enable-bridge-diagnostics` | With `install`: turn on the Remote Script's diagnostics log |
| `--allow-dirty-private-build` | Accept a package built from uncommitted changes (developers only) |

Each run prints one JSON result on stdout (`ableton-mcp-lifecycle/v1`) whose
`state` is `planned`, `completed`, `activation-required`, `blocked` or
`failed`. A refusal prints `ableton-mcp-lifecycle-error/v1` on stderr instead,
with paths removed. Blocked, failed and refused runs exit with 2. The receipt's
status is `installed-restart-required` after install, upgrade, repair and
rollback, `activated` once `activate` reached Live through the bridge, and
`uninstalled` after removal.

The lifecycle never quits or starts Live, never chooses a Control Surface,
never guesses Live's folders, and never follows a symlink or junction in the
paths it's given. It holds a lock while it works and keeps a journal of the
last change; a failure part-way puts back what was there. After an interrupted
run, read `status` and the journal before trying again, and use `repair` or
`rollback` as they indicate.

More about each action:

- **Install** checks the tarball's bytes against its hash and the package
  against the tarball's manifest, and that the ports are free, before it
  changes anything. It puts an empty file named `__pycache__` in the Remote
  Script's folder, so Live can't write or load compiled copies of it; anything
  else in that place counts as drift.
- **Activate** records `activated` only after an authenticated answer from the
  real Live with the expected registry hash. A simulator, a stale or wrong
  registry, or no answer gives `activation-required` and says what to do next.
  A recorded activation is history, not proof Live is connected now.
- **Upgrade** needs a strictly newer version and refuses drifted files. It
  keeps the previous version and configuration for `rollback`.
- **Repair** never creates a missing secret, because a new secret would be new
  authority over the bridge. Run it again and it changes nothing.
- **Uninstall** keeps the secret unless `--purge-secret`, and keeps the
  diagnostics log. Deleting is an ordinary unlink, not a secure erase.

**Diagnostics log.** With `--enable-bridge-diagnostics` at install, the Remote
Script writes short, redacted records to `bridge-diagnostics.log` in the state
folder: owner-only, queued and written in the background, at most 16 MiB.
Without the flag there's no log.

## Live's folders

| Folder | macOS | Windows |
| --- | --- | --- |
| Remote Scripts (default User Library) | `~/Music/Ableton/User Library/Remote Scripts` | `Documents\Ableton\User Library\Remote Scripts` (or under `OneDrive\Documents`) |
| Extensions (Live 12.4 or later) | `~/Library/Application Support/Ableton/Extensions` | `%APPDATA%\Ableton\Extensions` (not yet confirmed) |
| Control Surface setting | Live → Settings → Link, Tempo & MIDI | Options → Settings → Link, Tempo & MIDI |

If you moved your User Library, Live's **Settings → Library** shows where it
is; Kumi finds it by itself from Live's preferences. Never install into Live's
application folder.

## Checking an installation

```sh
ableton-mcp-diagnostics --config /absolute/path/to/bridge-config.json
```

It prints a JSON report. It exits with 1 for an unsupported Node or system, and
with 0 even when Live isn't reachable, so read its fields:

| Field | Means |
| --- | --- |
| `nodeSupported`, `platformSupported` | Node and the system are supported |
| `readiness.package` | The package and its Remote Script files are present and intact (not that Live loaded them; `status` checks the installed copy) |
| `readiness.configured` | The configuration is valid, names a bridge and has a readable secret |
| `readiness.authenticatedBridge` | The Remote Script answered over the authenticated connection, and discovery worked (`registryHash` shows its registry) |
| `readiness.realLiveOperational` | That answer came from real Live (`real-live` provenance), not a simulator |
| `ready` | All of the above |

The secret is never printed. Reinstalling isn't a way to fix a connection:
check that Live was restarted, the Control Surface is chosen, and the
configuration, secret and ports match.

## Moving a configuration to version 2

`ableton-mcp-migrate` keeps an old (legacy or version-1) client configuration
as it is by default. Given every bridge field and an existing owner-only secret,
it writes a version-2 bridge configuration:

```sh
ableton-mcp-migrate --input /absolute/old.json --output /absolute/bridge-v2.json \
  --bridge-host 127.0.0.1 --bridge-port 9765 --realtime-port 9766 \
  --secret-file /absolute/bridge.secret
```

It never creates a secret, accepts only loopback hosts, and refuses to replace
an existing file without `--force`.
