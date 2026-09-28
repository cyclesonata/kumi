# Kumi terminal POC

Kumi is a streaming producer-assistant conversation that **inspects the current
open Ableton Live Set**. Editing, playback control, listening and memory are not
implemented yet. It runs its own agent core and the
independent Ableton MCP Beyond bridge for Live access.

## Install and sign in

You need **Node.js 22 or 24** (Node 25 has reached end of life); the Node 24 LTS installer from
[nodejs.org](https://nodejs.org) is fine. On any other version Kumi says so and
stops before doing anything. From the repository root:

```sh
npm run setup                                 # install and build Kumi and the bridge
npm run kumi -- login openai-codex            # or add --device on a machine without a browser
npm run kumi                                  # start
```

`login` opens the browser and receives the callback on `localhost:1455`. The first
sign-in also chooses `openai-codex/gpt-6-astra` as the model if you have not
chosen one; access depends on your account.

```sh
npm run kumi -- model                         # show the model
npm run kumi -- model anthropic/<model>       # choose another; saved in ~/.kumi/settings.json
npm run kumi -- auth                          # which providers are usable; never prints secrets
npm run kumi -- logout openai-codex           # remove the local sign-in
npm run kumi -- --inference-only              # chat without Live
```

`login openai-codex --from-pi` imports the ChatGPT session from the earlier
Pi-based POC (`~/.pi/agent/auth.json`) once. Kumi and Pi then share that session;
when either refreshes it, the other may need to sign in again.

Credentials live in Kumi's own owner-only store (`~/.kumi/auth.json`, mode 600).
Tokens refresh automatically shortly before expiry, under a cross-process lock.
Never paste an access/refresh token or API key into a prompt, command argument,
issue, log, or repository file.

| Provider | Model | Credential |
| --- | --- | --- |
| ChatGPT plan | `openai-codex/<model>` | `login openai-codex` |
| OpenAI API | `openai/<model>` | `OPENAI_API_KEY` |
| Anthropic API | `anthropic/<model>` | `ANTHROPIC_API_KEY` |
| OpenCode Zen / Go | `opencode/<model>`, `opencode-go/<model>` | `OPENCODE_API_KEY` |

No Gateway key is needed. Claude and Gemini subscription sign-ins are not
offered: their providers do not permit them in third-party tools. OpenCode routes
GPT/Grok models to its Responses endpoint, Claude models to its Messages endpoint
and others to Chat Completions; Gemini models through OpenCode are not supported
yet.

| Optional setting | Meaning |
| --- | --- |
| `KUMI_MODEL` | `<provider>/<model>` for this run, overriding the chosen model |
| `KUMI_AUTH_FILE` | Credential store path; default `~/.kumi/auth.json` |
| `KUMI_SETTINGS_FILE` | Settings (chosen model) path; default `~/.kumi/settings.json` |
| `KUMI_REMOTE_SCRIPTS_DIR` | Live's Remote Scripts folder, if not the standard one |
| `KUMI_TRACE=1` | Dispatch-name trace; no arguments or raw tool payloads |
| `KUMI_UI=plain` | Plain line-by-line output instead of the full-screen app |
| `KUMI_COLOR` | `truecolor`, `256`, `16` or `none`, when detection gets it wrong; `NO_COLOR` is honoured |

Kumi identifies itself to providers (`kumi/<version>` User-Agent, `originator: kumi`
for ChatGPT). Requests are stateless: conversation history, including encrypted
reasoning, lives in Kumi's process and is replayed per request. There are no
ambient instructions, skills, extensions, shell, filesystem, coding, or web tools.

## Connect to Live

Kumi reaches Live through the Ableton MCP Beyond bridge: a Remote Script inside
Live plus a local MCP server that Kumi starts. `npm run setup` builds it. Once the
bridge is installed and selected in Live, a plain `npm run kumi` finds it through
the installed Remote Script (`AbletonMcpBridge/bridge-reference.json`) and
connects; there is nothing to configure. Without it, Kumi starts anyway, chats
without Live and says how to connect.

First-time install on macOS (the [delivery guide](DELIVERY.md) is the full
reference, including Windows, upgrades and removal):

1. Quit Live normally, saving your work.
2. Package the bridge, then run the [macOS setup](DELIVERY.md#macos-15-bashzsh)
   and [install](DELIVERY.md#install) steps with that tarball:

   ```sh
   (cd apps/mcp-server && npm pack)
   ```

   From a checkout with local changes, add `--allow-dirty-private-build` to each
   lifecycle command.
3. Start Live, open **Settings → Link, Tempo & MIDI** and choose `AbletonMcpBridge`
   as a Control Surface.
4. Run the lifecycle [activation](DELIVERY.md#activation) check, then `npm run kumi`.

This is the one part of setup that still takes several steps. To use a specific
bridge configuration instead, pass it explicitly:

```sh
npm run diagnostics --prefix apps/mcp-server -- --config /absolute/path/bridge-config.json
npm run kumi -- --bridge-config /absolute/path/bridge-config.json
```

Keep the secret in the bridge's separate private file, never in the command.
Kumi starts only its fixed local Node MCP child. So far it uses these Live reads,
checked against its own exact list and the bridge's tool policy:

- `server_status`
- `live_status`
- `live_discover`
- `live_snapshot`

Only currently advertised tools from that list are registered; every call is
checked again. The bridge's editing, audio, resource and prompt surfaces are not
wired into Kumi yet. A running Live process or an installed script is not
connectivity proof: check the displayed Remote Script / `real-live` observation.
An unavailable or disconnected bridge is shown as **No Live access**. See the
bridge [user guide](USER_GUIDE.md), [safety guide](LIVE_SAFETY.md),
[operations](OPERATIONS.md) and [recovery](RECOVERY.md) for its details.

You can launch from elsewhere without changing asset resolution:

```sh
npm --prefix /absolute/path/to/checkout run kumi
```

## Use

In a terminal window Kumi runs full screen: the conversation on the left, a Live
pane on the right (FOCUS, NOW, HISTORY) and the input box at the bottom. Below
100 columns the Live pane folds into a strip above the input box. Piped output,
or `KUMI_UI=plain` (for screen readers, say), keeps the plain line-by-line mode.
See [the terminal UI design](KUMI_TUI.md).

Try “Describe the open Set: tracks, tempo, and transport state,” then ask which
devices are on a specific track. Rename a track manually in Live and ask again.
Kumi refreshes bounded status and Set observations before each turn, and discovers
fresh detail references rather than treating names or history as authority.

| Input | Behavior |
| --- | --- |
| Enter | Send |
| Ctrl-J or Alt-Enter (Shift-Enter in terminals that report it) | New line in the input box |
| `/` | A short menu of commands; arrows choose, Enter runs, Esc closes |
| `/help`, `/status` | Keys and commands; what Kumi is connected to |
| `/refresh` | Read fresh bounded observations without a model answer |
| `/new` | Discard the conversation and reconnect with fresh observations |
| `/quit`, or Ctrl-C with an empty box | Close Kumi |
| Esc or Ctrl-C during work | Stop; settled history is kept, unsettled work is discarded |
| Ctrl-C while typing | Clear the input box |
| Page Up/Down, mouse wheel | Scroll the conversation; it stays put while new text arrives |

Only one operation runs at a time. A second message is refused while Kumi works,
and partly typed input is preserved while output streams. Kumi's steps read as
what it did ("looked at your Set") with their timing, never raw payloads. The
terminal is restored on exit, on crashes and on signals.

## Limits and failure behavior

- **Ephemeral:** no saved history, memory, resume, learned skills or compaction.
  After 30 submitted turns (including failed/cancelled submissions), use `/new`.
- Prompts are capped at 16 KiB; turns at 120 seconds and 24 model steps; MCP
  requests at 15 seconds. A cancelled or failed turn leaves no trace in the
  conversation. One automatic retry happens only for a retryable provider failure
  before any output of that step was shown.
  Cleanup is bounded and targets only Kumi's owned child, never Live.
- Discovery defaults to 25 rows and a 1,000-unit traversal budget. Parent and
  cursor references must come from the current observation. Partial pages remain
  partial; model-facing results over 64 KiB require a narrower query.
- A failed refresh produces no answer based on old observations. Known epoch,
  Set-identity or catalog changes reset the conversation. Same-name/unsaved Set
  switches the bridge cannot distinguish are a limitation; use `/new` explicitly.
- After a disconnect, observations are discarded and inference-only conversation
  remains available with no Live tools. `/new` or restart reconnects; Kumi runs no
  hidden reconnect loop. The standalone bridge retains its own status-refresh
  behavior while its MCP process is connected.
- Missing login/model access, an unbuilt Kumi, invalid configuration or startup
  failure is reported with the command that fixes it, without provider payloads
  or credentials.
- Metadata is not audio: no listening, quality scoring, edits, playback control,
  recording, rack construction or song generation is implemented.

## Privacy and verification

Your prompts, in-memory conversation and returned Live metadata are sent to the
selected inference provider. Track/device names and tool results are untrusted
data, not instructions or permission grants. Reading Live is not local-only.
Kumi does not save conversation files; terminal scrollback and the provider's
retention policies are separate. The credential store intentionally persists.

Tested locally with macOS arm64 on Node 22.23.3 and 24.21.0 (and 25.9.0 before Node 25
was retired), Kumi's agent
core on AI SDK provider packages (`@ai-sdk/openai` 4.0.78), MCP SDK 1.30.1,
ChatGPT OAuth and Live **12.4.15b4** with bridge 1.0.7. Authenticated inference,
actual PTYs and Live acceptance passed, including external-edit refresh,
cancellation, disconnect/reconnect and shutdown. See
[evidence](../evidence/kumi-poc.md) for the exact uncommitted candidate, timings
and test scopes. This is not a cross-platform release certification or proof of
production usefulness.

```sh
npm run typecheck
npm test                            # no credentials or Live required
KUMI_TEST_BRIDGE=1 npm test           # also require real no-config MCP interoperability
npm run probe:inference --workspace @kumi/app   # opt-in authenticated requests
```

Next: wire the bridge's editing tools into Kumi, keeping its verification and
undo automatic rather than extra steps for the producer.
