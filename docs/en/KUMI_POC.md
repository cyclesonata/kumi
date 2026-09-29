# Kumi terminal POC

Kumi is a streaming producer-assistant conversation about the **current open
Ableton Live Set**: it reads the Set and makes the changes you ask for, each with
its own undo ([how changes work](KUMI_CHANGES.md)). For a saved Set it picks up
the conversation next time and says what changed meanwhile. Playback control,
recording, listening and learned preferences are not implemented yet. It runs its own agent core and the
independent Ableton MCP Beyond bridge for Live access.

## Install and sign in

You need **Node.js 22 or 24** (Node 25 has reached end of life); the Node 24 LTS installer from
[nodejs.org](https://nodejs.org) is fine. On any other version Kumi says so and
stops before doing anything. From the repository root:

```sh
npm run setup                                 # install and build Kumi and the bridge
npm run kumi                                  # start; sign in and choose a model inside
```

Inside Kumi, `/login` signs in: to ChatGPT with your plan (the browser opens and
the sign-in comes back on `localhost:1455`), or to Anthropic, OpenAI or OpenCode
with an API key, pasted into a box that shows only dots. Kumi checks a key with
its provider before keeping it. `/model` lists every provider's models, read from
the provider itself, so a model released today is there without a Kumi update.
With no model chosen yet, Kumi starts with the first model a signed-in provider
lists, and says which. `/effort` sets how hard the model thinks, from the levels
that model takes (lower answers sooner). `/logout` signs out. Choices apply from
your next message and are kept for next time. When an answer fails because a
sign-in is missing or was refused, Kumi says so, offers to sign in and then sends
your message again; a model the provider doesn't offer opens the list.

The same from a shell:

```sh
npm run kumi -- login openai-codex            # ChatGPT; add --device on a machine without a browser
npm run kumi -- login anthropic               # asks for the key without showing it; also openai, opencode
npm run kumi -- logout <provider>             # remove Kumi's sign-in there
npm run kumi -- model                         # show the model
npm run kumi -- model anthropic/<model>       # choose one; saved in ~/.kumi/settings.json
npm run kumi -- auth                          # which providers are usable; never prints secrets
npm run kumi -- doctor                        # check Node, sign-in, the bridge, Live and the terminal
npm run kumi -- --inference-only              # chat without Live
```

`login openai-codex --from-pi` imports the ChatGPT session from the earlier
Pi-based POC (`~/.pi/agent/auth.json`) once. Kumi and Pi then share that session;
when either refreshes it, the other may need to sign in again.

Sign-ins and keys live in Kumi's own owner-only store (`~/.kumi/auth.json`, mode
600; on Windows it relies on your user folder being private, as it is by default).
Tokens refresh automatically shortly before expiry, under a cross-process lock. A
key saved with `/login` is used first; without one, a key in the environment is
used, and Kumi can't sign out of that (unset it instead). Paste an API key only into Kumi's key box or its
`login` prompt: never into a message, a command argument, an issue, a log or a
repository file.

| Provider | Model | Sign-in |
| --- | --- | --- |
| ChatGPT plan | `openai-codex/<model>` | `/login` (browser), or `login openai-codex` |
| Anthropic API | `anthropic/<model>` | `/login` with an API key, or `ANTHROPIC_API_KEY` |
| OpenAI API | `openai/<model>` | `/login` with an API key, or `OPENAI_API_KEY` |
| OpenCode Zen / Go | `opencode/<model>`, `opencode-go/<model>` | `/login` with an API key (one for both), or `OPENCODE_API_KEY` |

Effort goes to ChatGPT and OpenAI models as their reasoning effort and to Claude
as its `effort`; each model offers its own levels, and "Default" leaves it to the
model. Changing model keeps the conversation: what was said, Kumi's steps and
their results carry over; the earlier model's private reasoning doesn't, because
it belongs to that model (Claude checks its own reasoning is never moved or
edited).

No Gateway key is needed. Claude and Gemini subscription sign-ins are not
offered: their providers do not permit them in third-party tools. OpenCode routes
GPT/Grok models to its Responses endpoint, Claude models to its Messages endpoint
and others to Chat Completions; Gemini models through OpenCode are not supported
yet.

| Optional setting | Meaning |
| --- | --- |
| `KUMI_MODEL` | `<provider>/<model>` for this run, overriding the chosen model |
| `KUMI_AUTH_FILE` | Credential store path; default `~/.kumi/auth.json` |
| `KUMI_SETTINGS_FILE` | Settings (chosen model and effort) path; default `~/.kumi/settings.json` |
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
Kumi starts only its fixed local Node MCP child and asks it to expose exactly
Kumi's tools; the bridge refuses everything else (playback, recording, audio
capture, files). The model gets reads (`server_status`, `live_status`,
`live_discover`, `live_snapshot`, `live_browser_search`, `live_note_read`) and
Kumi's change tools (`set_tempo`, `set_mixer`, `rename`, `add_tracks_and_scenes`,
`write_midi_clip`, `load_device`, `set_device_parameter`, `set_locators`,
`set_track_color`, `undo_change`). Each change runs the bridge's preview and
apply as one step and lands in HISTORY with its undo; see
[how Kumi changes your Set](KUMI_CHANGES.md). Only currently advertised tools are
offered. The bridge's audio, resource and prompt surfaces are not wired into Kumi
yet. A running Live process or an installed script is not
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
devices are on a specific track. Ask for a change, such as “Set the tempo to 124
and rename 3-Audio to Bass”: each change appears in HISTORY with **undo** beside
it. Rename a track manually in Live and ask again.

**Catching up.** Kumi remembers each saved Set as it last saw it and, the next
time you open Kumi on that Set, the welcome screen says what changed meanwhile
("Since you were last here · 3 days ago: Tempo 120 → 124 BPM; Added track
“Pad”"), and Kumi takes it into account in its answers. It compares the bridge's
privacy-redacted semantic snapshots of the Set, kept in `~/.kumi/projects` (one
folder per Set file, readable only by you; `KUMI_PROJECTS_DIR` moves it). Kumi
records the Set when it first sees it, a little after its own changes and when
it closes. Unsaved Sets have no file to tell them apart, so they aren't
remembered.
Kumi refreshes bounded status and Set observations before each turn, and discovers
fresh detail references rather than treating names or history as authority.

**Devices and racks.** Kumi loads any device in Live's Browser (every native
instrument, audio and MIDI effect, Max for Live devices, presets) onto a track
or into a rack's chain, and changes its parameters. Ask for "a layered pad:
Wavetable and Operator in an Instrument Rack, a Reverb after the Operator": the
chains play in parallel, the devices in a chain in series, a chain can hold
another rack, and NOW draws the chains with the new device lit. Kumi sets
macros and adds them, but Live doesn't let it map a macro or a modulator to a
parameter: you do that in Live ([racks](KUMI_CHANGES.md#racks)).

**Speed.** Kumi plans a request in one reply where it can: a whole plan of
changes goes in one call, and when the plan completes the request Kumi itself
lists what changed, so the model isn't asked again. Each turn's observation
lists the tracks and their devices, so most requests need no discovery. A
Drum Rack's pads, or a device's parameters, change in one Live request with
one undo. On real Live a drum kit of eight random samples takes about 11 s,
and a tempo change about 4 s
([how](KUMI_CHANGES.md#plans-in-one-reply)).

| Input | Behavior |
| --- | --- |
| Enter | Send |
| Ctrl-J or Alt-Enter (Shift-Enter in terminals that report it) | New line in the input box |
| `/` | A short menu of commands; arrows choose, Enter runs, Esc closes |
| `/help`, `/status` | Keys and commands; what Kumi is connected to, and the model |
| `/model`, `/effort` | Choose the model (from each provider's own list; type to filter) and how hard it thinks; from your next message |
| `/login`, `/logout` | Sign in (ChatGPT in the browser, or an API key shown only as dots) or out |
| `/undo`, or click **undo** in HISTORY | Undo Kumi's latest change, or that change |
| `/refresh` | Read fresh bounded observations without a model answer |
| `/copy` | Copy Kumi's last answer to the clipboard (through the terminal; to select text yourself, hold Shift while dragging, Option in iTerm2) |
| `/new` | Discard the conversation and reconnect with fresh observations |
| `/quit`, or Ctrl-C with an empty box | Close Kumi |
| Esc or Ctrl-C during work | Stop; the steps Kumi finished stay in the conversation, the one in progress is dropped |
| Ctrl-C while typing | Clear the input box |
| Page Up/Down, mouse wheel | Scroll the conversation; it stays put while new text arrives |

Only one operation runs at a time. A second message is refused while Kumi works,
and partly typed input is preserved while output streams. Kumi's steps read as
what it did ("looked at your Set") with their timing, never raw payloads. The
terminal is restored on exit, on crashes and on signals.

## Limits and failure behavior

- **Conversations** are kept for saved Sets, in `~/.kumi/projects` next to what Kumi
  last saw of each Set (readable only by you); the oldest exchanges drop off past
  about 256 KB. `/new` discards a Set's conversation. Unsaved Sets' conversations
  end with Kumi. There's no learned memory or skills yet.
- **Bars and beats:** Kumi doesn't see the Set's time signature yet (the bridge's
  Set row lacks it), so turning bars into beats for clips and locators assumes 4/4.
- **Long conversations** have no turn limit. Past about 160 KB (roughly 50k
  tokens), earlier turns' larger Live reads shrink to their opening and a note to
  read again, and earlier turns' Live observations are dropped; the producer's
  words, Kumi's answers, change confirmations and the turn just before stay whole.
  Past about 400 KB the oldest exchanges drop off, and the model is told so.
  Reads go stale as you work, so they go first; clearing happens at those
  thresholds rather than on every request, so provider prompt caches keep working.
- Prompts are capped at 16 KiB. A turn runs while it makes progress (streamed
  text, tool steps): it stops after 3 minutes without any, after 20 minutes in
  all, or at 48 model steps. MCP requests are capped at 15 seconds. A stopped or
  failed turn keeps the steps it finished, with a note that it stopped, so Kumi
  knows what it already changed; the step in progress is dropped, and a turn that
  finished no step leaves no trace. Each turn's observation also lists Kumi's
  latest changes and where they stand, including undos clicked in HISTORY. One
  automatic retry happens only for a retryable provider failure before any
  output of that step was shown.
  Cleanup is bounded and targets only Kumi's owned child, never Live.
- Discovery defaults to 25 rows and a 1,000-unit traversal budget. Parent and
  cursor references must come from the current observation. Partial pages remain
  partial; model-facing results over 64 KiB require a narrower query.
- A failed refresh produces no answer based on old observations. Known epoch or
  Set-identity changes reset the conversation; a changed tool catalog (new tools
  after a first clip, say) keeps it. Same-name/unsaved Set switches the bridge
  cannot distinguish are a limitation; use `/new` explicitly.
- **Live closing or crashing:** Kumi notices within a second, keeps the
  conversation and reconnects on its own within seconds of Live being back
  (starting a fresh bridge, which the bridge requires after a Live restart). Work
  in progress when Live went away is stopped; messages sent meanwhile are answered
  without Live and stay in the conversation. If the same Set file comes back, the
  conversation carries on, and a note says what differs from what Kumi last saw.
- Undo lasts as long as Live and Kumi's bridge connection: after Live restarts,
  `/new` or a Kumi restart, earlier changes show **no undo** and can be undone
  only in Live (Cmd-Z). One answer makes at most 40 changes.
- Catching up needs a saved Set; a Set is recognized by its file path (Save As
  starts afresh). Very large Sets (a comparison over about 1.5 MB) get "changed,
  too big to compare yet". Look-alike items the bridge can't match (empty tracks,
  say) are read by name and position, so a rename can occasionally show as a
  removal and an addition.
- After a disconnect, observations are discarded and inference-only conversation
  remains available with no Live tools. `/new` or restart reconnects; Kumi runs no
  hidden reconnect loop. The standalone bridge retains its own status-refresh
  behavior while its MCP process is connected.
- A missing or refused sign-in, or a model the provider doesn't offer, is said
  plainly with the fix offered (sign in, choose another model). An unbuilt Kumi,
  invalid configuration or startup failure is reported with the command that
  fixes it. Neither includes provider payloads or credentials.
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
npm run eval:changes --workspace @kumi/app      # opt-in: how the model uses the change tools (no Live)
npm run accept:live --workspace @kumi/app -- --set "<Set name>"   # opt-in: every change and its undo on real Live
```

`npm test` also holds Kumi to latency budgets, counted rather than timed:
reading the Set before an answer is one round trip to Live, a change three and
each later step of a plan two, a rack's pads or a device's parameters one change
whatever their number, a finished plan one model reply, and a burst of streamed
text one frame. On real Live each round trip waits for a display tick (about
100 ms) and each model reply takes seconds, so one more of either fails the
tests; raising a budget is a decision, not a side effect.

`accept:live` changes the open Set and undoes every change, so run it on a
disposable copy; it refuses any Set but the one named. It needs no sign-in, and
also times the reads a big Set depends on (tracks, and the Set snapshot Kumi
catches up from), without touching `~/.kumi`.

Next: a picture in NOW for the kinds of change that have none yet (locators,
new tracks, devices), bars instead of beats for locators, undo that
outlives the bridge connection, and the bridge's scale limits (see the evidence,
"Scale on real Live").
