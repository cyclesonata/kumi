# Kumi

English · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

A personal producer assistant for Ableton Live. This proof of concept is a
full-screen terminal conversation about the open Live Set: it answers questions
about it and makes the changes you ask for (tempo, mixer, names, new tracks and
scenes, MIDI clips, loading devices, device parameters, locators, track
colours), each shown in HISTORY with its own undo. Playback control, recording,
listening and memory are not implemented yet.

## Quick start

You need **Node.js 22 or 24**; the Node 24 LTS installer from
[nodejs.org](https://nodejs.org) is fine (Node 25 has reached end of life). From the
repository root:

```sh
npm run setup                          # install and build everything, about a minute
npm run kumi -- login openai-codex     # sign in with your ChatGPT plan (--device without a browser)
npm run kumi                           # talk about the open Live Set
```

Signing in also picks a default model; change it any time with
`npm run kumi -- model <provider>/<model>`. API keys work too: `openai/`,
`anthropic/` and `opencode/` models use `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or
`OPENCODE_API_KEY`, and `npm run kumi -- auth` shows what is usable.

Kumi finds the Ableton bridge by itself once its Remote Script is installed and
selected as a Control Surface in Live. Until then Kumi still starts and chats,
and tells you Live isn't connected. First-time bridge install:
[Connect to Live](docs/en/KUMI_POC.md#connect-to-live).

- [Kumi setup, commands, privacy and limitations](docs/en/KUMI_POC.md)
- [Bridge setup and safety](docs/en/USER_GUIDE.md)
- [Verification evidence](docs/evidence/kumi-poc.md)

Kumi runs full screen in a terminal window: the conversation, a Live pane and the
input box. Type `/` for commands; Esc stops Kumi's work; Ctrl-C clears the input
box, then quits. **Quitting loses the conversation.** New observations are read
before each Live-aware turn; `/new` reconnects and clears history.

## Development

```sh
npm run typecheck
npm test                     # credential-free; no Live required
npm run probe:inference --workspace @kumi/app   # opt-in authenticated requests
```

`apps/kumi` owns the terminal; `packages/runtime` holds the session lifecycle, Kumi's
agent core (`kernel/`), provider transports (`providers/`, built on the AI SDK
provider packages), sign-in (`auth/`) and the restricted MCP integration. There is
no direct Live adapter import, shell tool, persistent memory, or beta Extensions SDK
integration.

## Ableton MCP Beyond — standalone bridge

[![Bridge CI](https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml?query=branch%3Amain)
[![Node 22 | 24](https://img.shields.io/badge/node-22%20%7C%2024-339933)](apps/mcp-server/package.json)

The existing `@ableton-mcp/mcp-server` component remains independently usable
with other MCP clients. Kumi uses its Live reads and editing tools, with their
verified undo; its analysis tools are next. It retains its own lockfile, Node support policy,
safety contracts and CI.

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
