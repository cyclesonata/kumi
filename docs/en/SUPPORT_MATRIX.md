# Supported platforms

English · [简体中文](../zh-CN/SUPPORT_MATRIX.md) · [日本語](../ja/SUPPORT_MATRIX.md)

What Kumi and its bridge run on, which versions of Live they work with, and
what has been tested where. [Implementation status](IMPLEMENTATION_STATUS.md)
lists the evidence behind each "tested".

## Kumi

| System | Versions | Processors | Status |
| --- | --- | --- | --- |
| macOS | 13 (Ventura) or later | Apple silicon, Intel | Tested with Live on Apple silicon |
| Windows | 10 or 11 | x64, ARM64 | Installing and connecting to Live tested; see [Windows](#windows) |
| Linux | glibc distributions (not Alpine or other musl) | x64, ARM64 | Kumi installs and runs, without Live: there is no Live for Linux |

The installer brings Kumi's own Node, the exact Node 24 release that Kumi was
built and tested with, so you don't install Node yourself. If a later Kumi moves
to another Node major, `kumi update` says to run the installer again, which
brings it.

## Ableton Live

| Live | Status |
| --- | --- |
| 12.4 or later | Everything, including Kumi's Live extension: offline renders, MIDI clips written into the Arrangement, clearing a range, and **Ask Kumi about this**. Tested on Live 12.4.15 beta on macOS. |
| 12.0 to 12.3 | The bridge offers what that Live's API has; no extension, so none of the above. `kumi doctor` says so. Not tested. |
| 11 or earlier | Not supported. |

Editions: the bridge discovers what the Live it connects to offers, so devices
and content an edition lacks (Standard and Intro have fewer) stay unavailable
rather than guessed. Making Max for Live devices needs Max for Live (Suite, or
Standard with the add-on). The optional Willington provider works with one
exact Live build; see [Willington integration](WILLINGTON_INTEGRATION.md).

## Windows

Tested: the installer, `kumi update`, `kumi bridge` and `kumi uninstall` in
Windows PowerShell 5.1 on CI; and on a Windows 10 machine with Live 12.4.15
beta, `kumi bridge` into a User Library moved outside the user folder, the
Remote Script loading in Live, and Kumi connecting. CI's Windows runner is an
administrator account with default folders, so it can't show problems that
only an ordinary account or a moved library has.

Not yet confirmed on Windows:

- **Where Live keeps its Extensions folder.** Kumi uses
  `%LOCALAPPDATA%\Ableton\Extensions`; `KUMI_LIVE_EXTENSIONS_DIR` overrides it. Until
  that's confirmed, the extension's features are untested on Windows.
- **The full-screen app in Windows terminals.** Windows Terminal is recommended;
  see [terminals](KUMI_TUI.md#terminals).
- **`kumi update` from Kumi 1.6.0 or earlier** fails with a tar error when Git's
  `tar` comes before Windows' own on PATH (as in a PowerShell started from Git
  Bash). Run the installer line again, or run
  `$env:Path = "$env:SystemRoot\System32;$env:Path"` before `kumi update`.

## Node.js for source checkouts and the standalone bridge

| Node.js | Status |
| --- | --- |
| 22.x, 24.x | Supported; Node 24 LTS recommended |
| 25.x | Not supported: it reached end of life on June 1, 2026 |
| 26.x and later, 21.x and earlier, prereleases | Not supported until tested |

The engine range in every package is `>=22 <23 || >=24 <25`. A checkout's
`kumi` refuses other majors (except `kumi doctor`, which says what's wrong).
The bridge's server and `ableton-mcp-setup` refuse them too;
`ableton-mcp-diagnostics` reports them; `ableton-mcp-lifecycle` and
`ableton-mcp-migrate` still run, so an older installation can be inspected or
removed.

## MCP protocol

The bridge speaks MCP over stdio in two protocol eras: `2025-11-25`, with the
initialize handshake, and `2026-07-28`, with per-request metadata and
`server/discover`. In the modern era every result is complete, cache hints are
private with zero TTL, and nothing is pushed unasked; it doesn't offer MRTR,
Tasks or HTTP. Tests cover both eras; no particular MCP client or model is
certified. The [user guide](USER_GUIDE.md) covers connecting a client.

## Accessibility

`KUMI_UI=plain` (or piping the output) gives Kumi a plain line-by-line interface
that suits screen readers; see [plain mode](KUMI_TUI.md#plain-mode). The
bridge's own output is plain text in a fixed order, with no colour-only states
and nothing that needs a pointer. Neither has been tested with VoiceOver or
Narrator, and Live, plug-in windows and MCP clients behave as their own
makers decide.

## What CI covers

CI runs on GitHub's hosted macOS 15, Ubuntu 24.04 and Windows Server 2025
runners, with Node 22 and 24; none of them has Live. [Testing](TESTING.md#ci)
lists every job.
