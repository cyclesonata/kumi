# Kumi

English · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

A personal producer assistant for Ableton Live: a full-screen terminal
conversation about the open Live Set. It answers questions about the Set and
makes the changes you ask for, each shown in HISTORY with its own undo. That
covers almost anything Live's scripting allows:

- tempo, time signature, swing and scale;
- the mixer, routing and sidechains;
- tracks, returns and scenes;
- clips, notes and MIDI transforms;
- devices, racks and their parameters;
- samples it finds on your computer.

It also:

- plays, records and bounces audio (by resampling) when you ask;
- listens to audio, such as a reference track, a sample or its own recording,
  and compares a mix with a reference;
- watches video tutorials, from YouTube or a file, and builds what they show;
- makes Max for Live MIDI effects you describe, and puts them on your tracks;
- saves your ways of working as recipes to replay, including ones it learns by
  watching you;
- keeps short notes of what you tell it;
- keeps each Set's conversations, so next time it picks up where you left off
  (`/conversations` goes back to earlier ones), and for a saved Set says what
  changed while it was closed.

## Quick start

You need **Node.js 22 or 24**; the Node 24 LTS installer from
[nodejs.org](https://nodejs.org) is fine (Node 25 has reached end of life). From the
repository root:

```sh
npm run setup                          # install and build everything, about a minute
npm run kumi -- login openai-codex     # sign in with your ChatGPT plan (--device without a browser)
npm run kumi -- bridge                 # with Live closed: put the bridge into Live (or update it)
npm run kumi                           # talk about the open Live Set
npm run kumi -- doctor                 # if anything's off: checks everything and says what to run
```

Signing in also picks a default model; change it any time with
`npm run kumi -- model <provider>/<model>`. API keys work too: `openai/`,
`anthropic/` and `opencode/` models use `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or
`OPENCODE_API_KEY`, and `npm run kumi -- auth` shows what is usable.

To connect Live, quit it and run `npm run kumi -- bridge`: it installs the
bridge's Remote Script (or updates it), then waits while you open Live. The
first time, choose `AbletonMcpBridge` as a Control Surface in Live's
**Settings → Link, Tempo & MIDI**. Kumi then finds the bridge by itself. Until
then it still starts and chats, and tells you Live isn't connected
([Connect to Live](docs/en/KUMI_POC.md#connect-to-live)).

- [Kumi setup, commands, privacy and limitations](docs/en/KUMI_POC.md)
- [Bridge setup and safety](docs/en/USER_GUIDE.md)
- [Verification evidence](docs/evidence/kumi-poc.md)

Kumi runs full screen in a terminal window: the conversation, a Live pane and the
input box. Type `/` for commands; Esc stops Kumi's work; `/stop` stops Live;
Ctrl-C clears the input box, then quits. If Live closes, Kumi picks up where you
left off when it's back. It reads the Set fresh before each answer; `/new` starts
a fresh conversation, and the last one stays kept.

## Tested with, and what's next

So far Kumi has been tested only with Ableton Live 12.4.15b4; other versions of
Live haven't been tried yet. Support for Renoise and Reaper is up next.

## Development

```sh
npm run typecheck
npm test                     # credential-free; no Live required
npm run probe:inference --workspace @kumi/app   # opt-in authenticated requests
```

`apps/kumi` owns the terminal; `packages/runtime` holds the session lifecycle, Kumi's
agent core (`kernel/`), provider transports (`providers/`, built on the AI SDK
provider packages), sign-in (`auth/`), notes and recipes (`core/`), audio
analysis (`audio/`) and the restricted MCP integration. There is no direct Live
adapter import, shell tool or beta Extensions SDK integration.
[Changelog](CHANGELOG.md).

## Ableton MCP Beyond — standalone bridge

[![Bridge CI](https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml?query=branch%3Amain)
[![Node 22 | 24](https://img.shields.io/badge/node-22%20%7C%2024-339933)](apps/mcp-server/package.json)

The existing `@ableton-mcp/mcp-server` component remains independently usable
with other MCP clients. Kumi uses its Live reads, editing, transport and
recording tools, with their verified undo, and does its own audio analysis. It
retains its own lockfile, Node support policy, safety contracts and CI.

- [Standalone bridge entry](apps/mcp-server/README.md)
- [User guide](docs/en/USER_GUIDE.md) · [Safety](docs/en/LIVE_SAFETY.md)
- [Operations](docs/en/OPERATIONS.md) · [Recovery](docs/en/RECOVERY.md)
- [Capabilities](docs/en/CAPABILITY_MATRIX.md) · [Support matrix](docs/en/SUPPORT_MATRIX.md)
- [Delivery](docs/en/DELIVERY.md) · [Distribution policy](docs/en/DISTRIBUTION_POLICY.md)

The hosted repository still uses its existing name; its rename is owner-managed.

## License

[MIT](LICENSE.md). The local bridge artifact is unpublished, unsigned and
unnotarized. Ableton Live is a trademark of Ableton AG; this project is not
affiliated with or endorsed by Ableton.
