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
  English · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

**A lightweight studio producer agent for Ableton Live (support for other DAWs planned) that learns how you work.** Kumi works directly in your projects, assisting with tedious tasks to the things you don't have time for: rebuilding a sound from a YouTube tutorial, comparing your mix with a reference, writing a Max for Live device you describe, or reworking the rack you point at. Every change shows up with its own undo, so nothing happens behind your back, and it remembers the techniques you keep, so it fits you better with every session.

<p align="center">
  <img src="docs/assets/kumi-screenshot.png" alt="Kumi rebuilding a Drift bass from a video tutorial: the conversation with each step it took, FOCUS showing the new track's device chain, and HISTORY with an undo for every change" width="760">
</p>

## What it does

- **Changes almost anything in the Set:** tempo, scale and groove; the mixer, routing and sidechains; tracks, scenes and clips; notes and MIDI transforms; devices, racks and their parameters. Every change can be undone on its own.
- **Listens:** loudness, tonal balance, width, tempo and key of a mix, a sample or its own bounce, and how your mix compares with a reference.
- **Watches tutorials** from YouTube or a file, then builds what they show on a new track.
- **Plays, records and resamples** when you ask.
- **Takes full control of Live:** deletes what you ask for, writes MIDI straight into the Arrangement, renders offline, and answers for what you right-click in Live ("Ask Kumi about this"). A whole plan is one Cmd-Z. Big Sets of hundreds of tracks stay quick.
- **Makes Max for Live devices** you describe in plain words (MIDI effects, audio effects and instruments) and puts them on your tracks.
- **Looks things up:** searches the web and reads pages, PDFs, manuals and code on GitHub, so it can build an effect like one it has read about.
- **Shows where you are:** FOCUS follows what you touch in Live, as a device tree, a piano roll or a Session or Arrangement strip. Click a device to point at it: "this Saturator's too harsh".
- **Remembers:** notes about you and each Set, techniques it learns from what you keep, and recipes you can replay. Every save is shown, and one click forgets it.
- **Keeps your conversations** for each Set, and says what changed while it was closed.
- **Works with your model:** sign in with ChatGPT, or use an OpenAI, Anthropic or OpenCode API key.

## Get started

You need Ableton Live 12 Beta, on macOS 13 or later or on Windows 10 or 11. Kumi brings everything else it needs, Node included.

**macOS:** open Terminal and paste:

```sh
curl -fsSL https://raw.githubusercontent.com/user1303836/kumi/main/install.sh | sh
```

**Windows:** open PowerShell and paste:

```powershell
irm https://raw.githubusercontent.com/user1303836/kumi/main/install.ps1 | iex
```

Then, in a new terminal window:

```sh
kumi login      # sign in with ChatGPT, or an Anthropic, OpenAI or OpenCode key
kumi bridge     # with Live closed: connect Kumi to Live (once)
kumi            # open Kumi next to your Set
```

The first time you open Live afterwards, pick **AbletonMcpBridge** as a Control Surface in Live's **Settings → Link, Tempo & MIDI**. After that, Kumi finds Live by itself.

Something off? `kumi doctor` checks everything and says what to run. `kumi report` puts what went wrong in one file to send us. `kumi uninstall` removes Kumi.

Kumi tells you when there's a newer version as it starts. `/update` inside Kumi, or `kumi update` in a terminal, gets it and brings the bridge along; `kumi update --check` only asks, and `kumi update --rollback` goes back. To stop the check, put `"updateCheck": false` in `~/.kumi/settings.json`.

Inside Kumi, type `/` for commands. Esc stops what Kumi is doing, and `/stop` stops Live. While Kumi works, Enter tells it more (it reads it after the step under way), Tab sends a message for after, and `/btw` asks something on the side.

[Full guide](docs/en/KUMI_POC.md) · [Commands and screens](docs/en/KUMI_TUI.md) · [Changelog](CHANGELOG.md)

## Status

Kumi 1.6 has been tested with Ableton Live 12.4 (beta) on macOS and Windows. Support for Renoise and Reaper is next.

## Development

From a copy of this repository, with Node.js 22 or 24:

```sh
npm run setup     # install and build
npm run kumi      # run it (npm run kumi -- bridge, -- doctor, and so on)
npm run typecheck
npm test          # no Live or sign-in needed
node scripts/build-release.mjs   # the bundle the installer downloads (Node 24)
```

`apps/kumi` is the terminal app; `packages/runtime` holds Kumi's agent core, providers, memory, audio analysis and the Live integration. Kumi talks to Live through a local bridge, `apps/mcp-server` plus its Remote Script, which also works on its own with other MCP clients ([bridge guide](apps/mcp-server/README.md)).

## License

[MIT](LICENSE.md). Ableton Live is a trademark of Ableton AG; Kumi is not affiliated with or endorsed by Ableton.
