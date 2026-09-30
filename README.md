<p align="center">
  <img src="docs/assets/kumi-logo.svg" alt="kumi" width="300">
</p>

<p align="center">
  <a href="https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/kumi.yml"><img alt="CI" src="https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/kumi.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/user1303836/ableton-mcp-beyond/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/user1303836/ableton-mcp-beyond?label=release"></a>
  <img alt="Ableton Live 12" src="https://img.shields.io/badge/Ableton%20Live-12-111111">
  <img alt="Node 22 | 24" src="https://img.shields.io/badge/node-22%20%7C%2024-339933">
  <a href="LICENSE.md"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

**A studio partner for Ableton Live that learns how you work.** Tell Kumi what you want in plain words and it does the work in your Set, from the tedious to the things you'd never have time to figure out: rebuilding a sound from a YouTube tutorial, comparing your mix with a reference, writing a Max for Live device you describe, or reworking the rack you point at. Every change shows up with its own undo, so nothing happens behind your back, and it remembers the techniques you keep, so it fits you better with every session.

## What it does

- **Changes almost anything in the Set:** tempo, scale and groove; the mixer, routing and sidechains; tracks, scenes and clips; notes and MIDI transforms; devices, racks and their parameters. Every change can be undone on its own.
- **Listens:** loudness, tonal balance, width, tempo and key of a mix, a sample or its own bounce, and how your mix compares with a reference.
- **Watches tutorials** from YouTube or a file, then builds what they show on a new track.
- **Plays, records and resamples** when you ask.
- **Makes Max for Live devices** you describe in plain words, and puts them on your tracks.
- **Shows where you are:** FOCUS follows what you touch in Live, as a device tree, a piano roll or a Session or Arrangement strip. Click a device to point at it: "this Saturator's too harsh".
- **Remembers:** notes about you and each Set, techniques it learns from what you keep, and recipes you can replay. Every save is shown, and one click forgets it.
- **Keeps your conversations** for each Set, and says what changed while it was closed.
- **Works with your model:** sign in with ChatGPT, or use an OpenAI, Anthropic or OpenCode API key.

## Get started

You need **Node.js 22 or 24** ([nodejs.org](https://nodejs.org)) and Ableton Live 12.

```sh
npm run setup                        # install and build, about a minute
npm run kumi -- login openai-codex   # sign in with ChatGPT (or set an API key)
npm run kumi -- bridge               # with Live closed: connect Kumi to Live
npm run kumi                         # open Kumi next to your Set
```

The first time, pick **AbletonMcpBridge** as a Control Surface in Live's **Settings → Link, Tempo & MIDI**. After that, Kumi finds Live by itself.

Something off? `npm run kumi -- doctor` checks everything and says what to run. `npm run kumi -- report` puts what went wrong in one file to send us, and `npm run kumi -- update` keeps Kumi and its bridge current.

Inside Kumi, type `/` for commands. Esc stops what Kumi is doing, and `/stop` stops Live.

[Full guide](docs/en/KUMI_POC.md) · [Commands and screens](docs/en/KUMI_TUI.md) · [Changelog](CHANGELOG.md)

## Status

Kumi 1.0 has been tested with Ableton Live 12.4 (beta) on macOS; Windows support is in testing. Support for Renoise and Reaper is next.

## Development

```sh
npm run typecheck
npm test          # no Live or sign-in needed
```

`apps/kumi` is the terminal app; `packages/runtime` holds Kumi's agent core, providers, memory, audio analysis and the Live integration. Kumi talks to Live through a local bridge, `apps/mcp-server` plus its Remote Script, which also works on its own with other MCP clients ([bridge guide](apps/mcp-server/README.md)).

## License

[MIT](LICENSE.md). Ableton Live is a trademark of Ableton AG; Kumi is not affiliated with or endorsed by Ableton.
