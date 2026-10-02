# Kumi

Kumi 1.1 is a producer assistant for the **current open Ableton Live Set**, in
your terminal. It reads the Set and makes the changes you ask for, each with its
own undo ([how changes work](KUMI_CHANGES.md)). When you ask, it plays, records
and bounces audio. It listens to audio, such as a reference track, a sample or
its own recording, and compares one with another. It saves your ways of
working as [recipes](#recipes-and-watching-you-work) to replay, including ones
it learns by watching you. For a saved Set it picks up the conversation next
time and says what changed meanwhile. It keeps short notes of what you tell it
that Live can't show ([what Kumi remembers](#what-kumi-remembers)), makes Max for
Live devices you describe, and looks things up on the web
([looking things up](#looking-things-up)). It runs its own agent core and the
independent Ableton MCP Beyond bridge for Live access.

## Install and sign in

On macOS, open Terminal and paste:

```sh
curl -fsSL https://raw.githubusercontent.com/user1303836/kumi/main/install.sh | sh
```

On Windows, open PowerShell and paste:

```powershell
irm https://raw.githubusercontent.com/user1303836/kumi/main/install.ps1 | iex
```

The installer puts Kumi and its own Node 24 in `~/.kumi` (`KUMI_HOME` moves it),
checks each download against its published checksum, and adds `kumi` to your
PATH. It needs no admin rights, git, npm or Node of your own, and never touches
the files Kumi keeps for you there. Running it again repairs or updates Kumi.
Then, in a new terminal window, `kumi` starts Kumi.

From a copy of this repository instead, with **Node.js 22 or 24**:
`npm run setup`, then `npm run kumi` (and `npm run kumi -- <command>` wherever
this guide says `kumi <command>`). On any other Node, Kumi says so and stops
before doing anything.

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
kumi login openai-codex            # ChatGPT; add --device on a machine without a browser
kumi login anthropic               # asks for the key without showing it; also openai, opencode
kumi logout <provider>             # remove Kumi's sign-in there
kumi model                         # show the model
kumi model anthropic/<model>       # choose one; saved in ~/.kumi/settings.json
kumi auth                          # which providers are usable; never prints secrets
kumi doctor                        # check Node, sign-in, the bridge, Live and the terminal
kumi update                        # bring Kumi up to date, and the bridge in Live when it's older
kumi update --check                # only say whether there's a newer Kumi
kumi update --rollback             # go back to the Kumi before the last update
kumi report                        # a file to send when something goes wrong
kumi uninstall                     # remove Kumi (your files stay unless you add --all)
kumi --inference-only              # chat without Live
```

`update` fetches the newest release, checks it against its checksum and starts
it once to be sure it runs, then puts it in place and keeps the one before for
`--rollback`. Then it updates the bridge in Live if it's older than Kumi's,
asking you to quit Live first. In a copy of the repository, `update` moves the
checkout forward on its branch instead (`git merge --ff-only`; it leaves a
checkout with changes of its own alone) and runs `npm run setup`. Inside Kumi,
`/update` asks first, then closes Kumi, updates it the same way and opens it
again, and the Set's conversation carries on.

Kumi says when there's a newer version as it starts: at most once a day it asks
in the background (GitHub's latest release, or git for a checkout) and says
nothing when there's none or no network. `"updateCheck": false` in
`~/.kumi/settings.json`, or `KUMI_NO_UPDATE_CHECK=1`, turns that off. When the
bridge in Live is older than Kumi's, Kumi says so as it starts.

`uninstall` removes Kumi, its Node, its launcher and the lines it added to your
shell's startup files, and offers to take the bridge out of Live (the bridge
stays, with what Live needs, while Live is open or when you say no).

`report` writes `~/kumi-report-<date>.txt`: Kumi's and the bridge's versions,
the doctor's checks, what Kumi did in your last conversation (your requests, its
tool calls and what they answered, HISTORY), the gap log, and the bridge's lines
and Python errors from Live's own log. Keys and tokens are taken out, your home
folder shows as `~` and your account name as `<user>`; read it before sending.

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
| `KUMI_MEMORY_FILE` | Notes about you; default `~/.kumi/memory.json` |
| `KUMI_INPUT_HISTORY_FILE` | What you sent, for the up arrow (keys and tokens left out); default `~/.kumi/input-history` |
| `KUMI_TECHNIQUES_FILE` | Techniques Kumi learned from what it built that you liked; default `~/.kumi/techniques.json` |
| `KUMI_PLAYBOOK_FILE` | Kumi's own lessons from matching sounds; default `~/.kumi/playbook.json` |
| `KUMI_GOALS_DIR` | Goals in progress, one per Set, so `/goal` picks them up after a restart; default `~/.kumi/goals` |
| `KUMI_RESTORE_FILE` | Main's level while Kumi renders, to put it back after a crash; default `~/.kumi/audition-restore.json` |
| `KUMI_GAPS_FILE` | What Kumi couldn't do for lack of a tool, logged for Kumi's developers (not a memory); default `~/.kumi/gaps.jsonl` |
| `KUMI_RECIPES_DIR` | Your recipes, one file each; default `~/.kumi/recipes` |
| `KUMI_PROJECTS_DIR` | Each saved Set's last state, conversation and notes; default `~/.kumi/projects` |
| `KUMI_VIDEOS_DIR` | Videos Kumi watched (their words, frames and sound); default `~/.kumi/videos` |
| `KUMI_TOOLS_DIR` | Programs Kumi fetches for itself (yt-dlp, a speech model); default `~/.kumi/tools` |
| `KUMI_YTDLP`, `KUMI_FFMPEG`, `KUMI_WHISPER` | A yt-dlp, ffmpeg or whisper.cpp (`whisper-cli`) of your own, by path |
| `KUMI_WHISPER_MODEL` | A whisper.cpp speech model of your own (a `ggml-*.bin` file), by path |
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
Live plus a local MCP server that Kumi starts. `npm run setup` builds it, and one
command puts it into Live:

1. Quit Live, saving your work.
2. Run `kumi bridge`.
3. Open Live. The first time, open **Settings → Link, Tempo & MIDI** and choose
   `AbletonMcpBridge` as a Control Surface.
4. Run `npm run kumi`.

`bridge` packs the bridge from this checkout and runs its own lifecycle: a plan
that changes nothing, then the install or update, with the lifecycle's checks,
receipts and rollback. Live's Remote Script and the bridge's settings go where
the bridge keeps them, and an update keeps the installed bridge's settings and
secret. It never quits or starts Live. It refuses while Live is open, and asks
you to confirm Live is closed (`--yes` confirms beforehand). Afterwards it waits
for Live and records that the bridge reaches it. Run it again whenever Kumi
updates its bridge. `kumi doctor` and a failing start both say when to. From a
checkout with uncommitted changes, add `--allow-dirty` (developers only). The
[delivery guide](DELIVERY.md) has the lifecycle in full, for Windows, repair,
rollback and removal.

On Live 12.4 and later, `kumi bridge` also puts Kumi's Live extension into Live's
Extensions folder (`~/Library/Application Support/Ableton/Extensions/kumi.kumi`
on macOS). Live starts it the next time it opens; it writes MIDI clips with
their notes straight into the Arrangement, clears a stretch of a track, renders
an audio track's clips to a file without playing them, and adds **Ask Kumi
about this** to Live's right-click menu (under **Extensions**), which pins what
you clicked for your next message. Nothing else to set up: no Developer Mode,
no file to drop into Settings. Kumi works without it (older Live, or before Live
restarts), and `kumi doctor` says which:

```text
  ok    Kumi's extension is running in Live
  note  Live hasn't started Kumi's extension
        → Restart Live: it starts extensions when it opens. With Developer Mode on (Settings → Extensions), Kumi starts it itself while Kumi runs
  fix   Kumi's extension isn't in Live (it renders tracks without playing them and writes MIDI clips in the Arrangement)
        → Run: kumi bridge, then restart Live
```

`kumi uninstall` takes the extension out of Live along with the bridge.

Once installed and selected in Live, a plain `npm run kumi` finds the bridge
through the installed Remote Script (`AbletonMcpBridge/bridge-reference.json`)
and connects; there is nothing to configure. Without it, Kumi starts anyway,
chats without Live and says how to connect. To use a specific bridge
configuration instead, pass it explicitly:

```sh
npm run diagnostics --prefix apps/mcp-server -- --config /absolute/path/bridge-config.json
kumi --bridge-config /absolute/path/bridge-config.json
```

Keep the secret in the bridge's separate private file, never in the command.
Kumi starts only its fixed local Node MCP child and asks it to expose exactly
Kumi's tools; the bridge refuses everything else (audio capture, project files
and backups, realtime control, dialogs). The model gets Live reads (the Set, its
tracks, devices, clips, notes, the song's settings, the Browser) and Kumi's own
tools for changes, playing and recording, listening, samples, recipes and notes.
Each change runs the bridge's preview and apply as one step and lands in HISTORY
with its undo; see [how Kumi changes your Set](KUMI_CHANGES.md) for the full list.
Only tools the bridge currently advertises are offered, and a tool that needs a
newer bridge than the installed one isn't offered at all
([bridge versions](KUMI_CHANGES.md#bridge-versions)). A running Live process or
an installed script is not connectivity proof: check the displayed Remote Script
/ `real-live` observation.
An unavailable or disconnected bridge is shown as **No Live access**. See the
bridge [user guide](USER_GUIDE.md), [safety guide](LIVE_SAFETY.md),
[operations](OPERATIONS.md) and [recovery](RECOVERY.md) for its details.

You can launch from elsewhere without changing asset resolution:

```sh
npm --prefix /absolute/path/to/checkout run kumi
```

## Use

In a terminal window Kumi runs full screen: the conversation on the left, a Live
pane on the right and the input box at the bottom. The pane's top half is FOCUS
(where you are in Live) and NOW; its bottom half is a tabbed area, HISTORY its
first tab, which scrolls with the mouse wheel, or Shift+Tab then the arrows (Enter
undoes the row, Esc goes back to typing). In FOCUS's tree, Tab, the arrows and
Enter point at a device for your next messages. Below
100 columns the Live pane folds into a strip above the input box. Piped output,
or `KUMI_UI=plain` (for screen readers, say), keeps the plain line-by-line mode.
See [the terminal UI design](KUMI_TUI.md).

Try “Describe the open Set: tracks, tempo, and transport state,” then ask which
devices are on a specific track. Ask for a change, such as “Set the tempo to 124
and rename 3-Audio to Bass”: each change appears in HISTORY with **undo** beside
it. Rename a track manually in Live and ask again.

**A copy before big changes.** Before a plan of three steps or more, or one that
deletes something, Kumi keeps a copy of the Set as last saved, next to it
(`Song.backup-<date>.als`), and says so. It makes one copy for each saved
version. Unsaved work isn't in the file, so it isn't in the copy; Kumi's own
changes have their undo in HISTORY, and Live keeps its own backups of each save
in the project's Backup folder.

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

**Playing, recording and bouncing.** Kumi plays and stops the Set, launches
clips and scenes, and moves the playhead when you ask to hear something. It
records when you ask. It never plays or records on its own. Live gives scripts
no bounce, freeze or export, so Kumi bounces by resampling, all in one plan. It
adds an audio track fed from the source track, or from "Resampling" for the
whole mix, and arms it. Then it records the length you want in the Arrangement
and disarms the track. The recording stays in the Set as an audio clip for the
next round of effects. If a plan stops partway (a step fails, or you press Esc),
Kumi stops the recording and playback it started. `/stop` stops Live, meaning
clips, the transport and recording, at any time, even while Kumi answers. If
Live refuses its ordinary stop, Kumi uses the bridge's emergency stop.

**Listening.** Kumi hears audio files and the Set's audio clips: a reference
track, a sample, a bounce or a recording. It measures:

- loudness: integrated LUFS, true peak and loudness range;
- tonal balance in ten named bands, from sub to air, and stereo width in each;
- dynamics, tempo and key;
- for a single sound, its pitch, harmonics (which waveform it's like), envelope
  and movement (an LFO's rate, at the tempo).

Given a reference, it matches the loudness and says what differs most, so it can
match a mix's EQ and compression or rebuild a sound. The conversation shows what
it heard as a small spectrum, and a comparison as dB over or under the
reference. It reads WAV and AIFF itself, and MP3, M4A, FLAC and the like through
macOS's `afconvert`, or elsewhere `ffmpeg`, which Kumi fetches on Windows and
Linux the first time it's needed. The analysis runs on your computer: only the
numbers go to the model, never the audio.

**Hearing the Set.** Ask about a track or the mix ("is the bass muddy?", "what
clashes with the kick?") and Kumi hears it in Live directly, with nothing to set up:

- **While Live plays**, it listens to what's playing, a few seconds, and leaves
  Main and the transport alone.
- **While Live is stopped**, it plays the loop (or a few bars from the playhead,
  or the part you name) with Main silenced, and puts Main back.
- **Several tracks at once:** each one's sound, and where two sit in the same band
  at similar levels.
- **How:** Kumi Ears, a small Max for Live device Kumi brings (`kumi bridge` puts it
  in your User Library's Kumi folder). Kumi places it at the end of a track's chain
  when it needs to hear it and takes it away after. Sound passes through it
  untouched, and nothing is recorded into your Set.
- Auditions and goals hear their candidates the same way: no scratch tracks, no
  arming. Without Max for Live, Kumi records to listen instead, as before.

## Live's own commands

Some things Live's scripting doesn't offer at all. For those, Kumi uses Live's own
menus, as you would:

- grouping and ungrouping tracks
- freezing, unfreezing and flattening
- **bouncing without playing** (Bounce to New Track, Bounce Track in Place)
- consolidating
- converting audio to MIDI (melody, harmony, drums)
- separating stems
- slicing to a MIDI track
- saving the Set, or collecting all and saving
- exporting audio or a MIDI clip

How it works:

- Kumi selects what the command works on, presses the command, and says what changed.
  When Live opens a dialog (Export, say), Kumi reads it and answers it.
- Live comes to the front for a moment and the front goes back after. Each command
  takes milliseconds.
- HISTORY lists each command. Live's own undo (Cmd-Z) takes it back.
- **On a Mac:** this uses Accessibility. The first time, macOS asks: turn on the app
  Kumi runs in (your terminal) in System Settings › Privacy & Security › Accessibility.
  `kumi doctor` says whether it's on.
- **On Windows:** this uses UI Automation and needs nothing set up.

## Recipes and watching you work

Kumi saves ways of working as recipes you can replay any time, in any Set: a
vocal chain, a drum bus, a sidechain, a resampling loop, a session layout. There
are three ways to make one:

- **After Kumi does it.** Ask it to keep what it just did as a recipe.
- **By describing it.** Describe a routine you repeat, and Kumi writes it down.
- **By showing it.** Say "watch me". Kumi notes the Set as it is, you do the
  routine by hand in Live, and you say when you're done. Kumi then sees what
  changed: tracks added with their routing and arming, devices loaded with the
  knobs you turned from Live's defaults, recordings and mixer moves. It turns
  that into a recipe with blanks for what differs each time, such as the track
  to work on, and says what the recipe will do. Switches and modes (on/off, a
  filter type) can't be compared with a default, so Kumi reads them in Live if
  they matter.

Ask for a recipe by name ("resample the Reese twice") to run it; it runs as one
plan, with each change in HISTORY and undoable. `/recipes` lists them. Choose one
to run it (Kumi asks what to run it on when it has blanks) or forget it. Recipes
are kept in `~/.kumi/recipes`, one file each, readable only by you.

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
| Enter | Send; while Kumi works, it reads the message after the step under way, and the answer carries on with it |
| Tab while Kumi works | Send the message once the answer is done instead; waiting messages show above the box, and Alt-↑ takes the last one back |
| `/btw` and a question | Ask something on the side, any time: answered from the conversation so far, without tools, in a panel (↑↓ scroll, ←→ earlier ones, c copies, Esc closes); neither joins the conversation. `/btw` alone shows the last answer again |
| Ctrl-J or Alt-Enter (Shift-Enter in terminals that report it) | New line in the input box |
| `/` | A short menu of commands; arrows choose, Enter runs, Esc closes |
| `/help`, `/status` | Keys and commands; what Kumi is connected to, and the model (on an API key, also the tokens this session's answers took; prices aren't in the providers' model lists, so Kumi shows tokens, not a cost) |
| `/model`, `/effort` | Choose the model (from each provider's own list; type to filter) and how hard it thinks; from your next message |
| `/login`, `/logout` | Sign in (ChatGPT in the browser, or an API key shown only as dots) or out |
| `/memory` | What Kumi remembers, about you and this Set; choose a note to forget it |
| `/goal` and what to reach | Go after a sound until Kumi gets there (a reference and words); `/goal` alone picks a paused one up, `/goal stop` ends it, Esc pauses it; the GOAL tab shows how it's going |
| `/undo`, or click **undo** in HISTORY | Undo Kumi's latest change, or that change |
| `/stop` | Stop Live: clips, the transport and recording (works while Kumi answers) |
| `/recipes` | Your recipes; choose one to run or forget it |
| `/refresh` | Read fresh bounded observations without a model answer |
| `/copy` | Copy Kumi's last answer to the clipboard (through the terminal; to select text yourself, hold Shift while dragging, Option in iTerm2) |
| `/new` | Forget this conversation and start fresh; what's above stays on screen under a line, and the conversation stays kept |
| `/conversations` | This Set's kept conversations (the latest 20), with when and the first request; choose one to carry on with it |
| `/reconnect` | Connect to Live again over a fresh bridge, keeping the conversation (Kumi also reconnects on its own) |
| ↑ and ↓ | Go through what you sent before, across `/new` and restarts (secrets are kept out of it) |
| `/quit`, or Ctrl-C with an empty box | Close Kumi |
| Esc or Ctrl-C during work | Stop; the steps Kumi finished stay in the conversation, the one in progress is dropped; messages still waiting go back into the box |
| Ctrl-C while typing | Clear the input box |
| Page Up/Down, mouse wheel | Scroll the conversation; it stays put while new text arrives. Nothing is cut: answers keep their steps, and a conversation brought back comes back whole |
| Ctrl-Home, Ctrl-End | Go to the start of the conversation, and back to the latest |

Only one answer runs at a time: a message sent while Kumi works goes into it at
its next step, or waits for it (Tab). Partly typed input is preserved while output
streams. Kumi's steps read as what it did ("looked at your Set") with their timing,
never raw payloads. A step at work has its own animation by kind (searching,
reading a page, looking at the Set, building a device, changing, listening,
watching, playing, recording, code), its words shimmer and its time counts up;
NOW plays a wider version of it. The same step done several times in a row
folds into one line ("read a page ×3") 3 seconds after the last. While Live
plays, a yellow light blinks on its beat in the header, beside the tempo. The
terminal is restored on exit, on crashes and on signals.

## Arrangements

Ask Kumi to turn a loop into a track: "arrange this", "make a 3-minute arrangement from these
scenes", or "arrange it like this reference" with a file.

- **Your material.** Session scenes (a section plays a scene's clips, or chosen clips per
  track), a track's clips, or bars already in the Arrangement (their MIDI clips).
- **The form.** Named sections with their lengths in bars. Without one from you, Kumi picks one
  that suits the genre and tempo. With a reference, it hears the reference's form (its sections
  in bars, their energy, which ones come back) and mirrors it.
- **Variation.** Tracks come in and go out section by section. Transitions are a gap before a
  drop (tracks stop for the last beat or bar), a track's fill clip at a section's end, and a
  riser or crash ending where the next section starts: a clip from an effects track, or one of
  your samples Kumi finds and brings in. Kumi writes no new parts unless you ask.
- **In Live.** Your clips are copied into the Arrangement after what's there already (or where
  you say), each section gets a locator, and the playhead goes to the start. Kumi then says in
  a few lines what it built.
- **Undo.** The whole arrangement is one line in HISTORY with one undo, and one Cmd-Z in Live.
- **Limits.** Live's scripting can't draw automation in the Arrangement, so filter sweeps and
  volume rides are yours to draw. Audio clips already in the Arrangement can't be copied there:
  drag them into Session slots first. Bars from the Arrangement need Kumi's Live extension
  (Live 12.4). While Live plays, the locators wait.

See [how arranging works](KUMI_CHANGES.md#arrangements).

## Watching video tutorials

Give Kumi a video and ask it to build what the video shows. The video can be a
YouTube tutorial (or any site [yt-dlp](https://github.com/yt-dlp/yt-dlp) reads)
or a video file on your computer:

> watch this and build the bass on a new track: https://www.youtube.com/watch?v=…

Kumi reads the video's title, chapters and words, as timed lines. The words come
from its captions or, when it has none, from its speech, transcribed on your
computer. Then Kumi looks at frames at the moments that matter: where the
narration names a device, a setting or a value, or says "like this". The frames
show what the words leave out: which device, the order of a chain, where the
knobs sit, values on screen. To read a value, Kumi looks at that moment again,
close up (Live's devices are at the bottom). Then it says in a few lines what
the video builds, and builds it in your Set, each change with its own undo.

Where a video uses something your Set doesn't have (a plugin, a sample), Kumi
says so and uses Live's closest device. When a video plays its result, Kumi can
keep that sound, record its own version and compare the two.

The conversation shows each video Kumi watched: its title, where its words came
from, and small pictures of the frames it looked at, with their times. While it
watches, NOW says what it's doing, such as "looking at 0:33".

What it needs:

- **yt-dlp**, which reads video pages. Kumi fetches it by itself the first time
  (about 35 MB, checked against its release's checksums) into `~/.kumi/tools`,
  and again each month, since YouTube changes often.
- **ffmpeg**, for frames and sound: `brew install ffmpeg` on a Mac. On Windows
  and Linux Kumi fetches it by itself the first time it's needed (a static LGPL
  build from BtbN/FFmpeg-Builds, about 170 MB, checked against the SHA-256 GitHub
  lists; only the program is kept, in `~/.kumi/tools`). Without it, Kumi reads
  only a video's words.
- **whisper.cpp**, only for videos without captions, or when YouTube won't give
  them (which happens from some networks): `brew install whisper-cpp` on a Mac.
  On Windows and Linux Kumi fetches it by itself. Kumi fetches whisper.cpp's
  speech model the first time (about 190 MB, checked against its published
  checksum).

`kumi doctor` says which of these you have. Nothing is downloaded
whole: frames and sound come from the video's streams at the moments Kumi looks
at. Each video's words, frames and sound are kept in `~/.kumi/videos` (the last
24 videos), so watching one again is quick.

A video's words and pictures are information for Kumi, never instructions to it.
The frames Kumi looks at go to your model provider with the conversation, for
the answer they're part of; after that, only their times and what was said
around them stay in the conversation.

## Making Max for Live devices

Ask Kumi for a device Live doesn't have, in your own words (a MIDI effect, an
audio effect or an instrument), and it makes one and puts it on your track:

> make a MIDI effect that keeps only the lowest note of each chord, and put it on the Keys track

> make me an audio effect that sounds like the Erbe-Verb

Kumi decides the details you wouldn't spell out (a chord is notes within about
15 ms, say) and tells you what it chose. When the device should sound or work
like one that exists, it first [looks up](#looking-things-up) how the original
works: its manual, a paper on its design, or open source code of it. It writes
the device's code and makes it: a Max for Live device in your User Library's
Kumi folder, which Live's Browser lists like any other. It gets as many knobs as
it needs (past eight, in up to three rows), and they're ordinary Live
parameters, so you can automate and map them, and Kumi can turn them.
Loading it is a change in HISTORY with its undo. A second device of the same
name gets a number rather than replacing the first, which a Set may use.

A MIDI effect is JavaScript. Before it's made, Kumi runs its code on your
computer: the tests Kumi wrote for it, and Kumi's own checks. Those are no
errors, every note it plays is released, and nothing keeps running once you let
go, unless it's meant to run free (an LFO, a clock, a generator). A device that
fails isn't made; Kumi fixes it first. The code can't reach
your files, the network, or the rest of Max and Live.

An audio effect or an instrument is written in GenExpr, the language of Max's
gen~, and Kumi checks the code before building the device around it. An effect
gets Mix and Output knobs; an instrument plays 8 notes at once, or up to 32 if
you ask. Inside, nothing is capped: feedback can sustain or self-oscillate. Every
device ends in Kumi's output stage, which keeps the device's own output safe (no
NaN, denormals or DC, held under +6 dBFS); on an effect the dry signal passes
untouched, so at Mix 0 your track sounds exactly as it did without it. Kumi
listens to what it made with `audition` and fixes what it hears.

It needs Max for Live (Live Suite, or Standard with the add-on).

## Looking things up

Kumi can search the web and read what it finds, to build or explain what you
name and it doesn't know well enough: a hardware unit, a plugin, a synth, an
effect's algorithm, an artist's technique.

- `search_web` searches the web through free search services that need no key,
  taking turns as Hermes Agent does: Exa, Parallel, Keenable and Firecrawl, each
  search starting with the next. One that's busy or doesn't answer hands the search
  to the next and rests (as long as it asks, when it says), and DuckDuckGo answers
  when none of them can. The same search within 20 minutes isn't made again. For
  code it searches GitHub's repositories.
- `read_web` reads a page, a PDF, a text or code file, a GitHub repository (its
  files and README) or a file in one, a Max patch or Max for Live device (its
  controls and its gen~ code first), or a picture, which the model sees. A long
  page comes a stretch at a time, and pages are kept for 20 minutes.

What Kumi looked up shows above its answer, a quiet line each ("Read “Building
the Erbe-Verb” · a PDF"). Kumi reads only public addresses, never this computer
or your network, checked again as each connection is made, redirects included.
It treats what a page says as information, never as instructions.

## What Kumi remembers

Kumi keeps short notes of what you tell it that Live can't show, and uses them in
later conversations: what a track or sound is for ("the Reese is the main bass"),
what you're going for in a song or a section, your habits (naming, colours,
routing), and what you like or dislike, in sounds and in how Kumi works. It
decides for itself, as it answers, with no extra wait. Everything it keeps shows
as it happens: a line of its own in the conversation (`✎ Noted about you: …`,
`◆ Kept a technique: Neuro from a Reese`, `↻ Saved a recipe: Drum bus`), a moment
in NOW, and a row at the top of the HISTORY tab with a **forget** click.

- **Two places.** Notes about you, true in any project, are in `~/.kumi/memory.json`.
  Notes about a saved Set are in its folder in `~/.kumi/projects`, next to its
  conversation. Both are readable only by you. Notes about a Set that isn't saved
  yet are kept once it is.
- **Short.** Up to 24 notes in each place, a sentence each. A note that's now
  wrong, or says the same as another, is replaced rather than added to.
- **Not kept:** anything the Set shows (Kumi reads it fresh every turn), what
  Kumi did (HISTORY has it), one-off requests, Kumi's own guesses, and anything
  it only read in the Set, a tool result or a file. A note that reads as
  instructions to the assistant, or holds something like a key, isn't kept, and
  one found in the files isn't read back, so text inside a Set (a track name
  written as an instruction, say) can't become a standing order.
- **`/memory`** shows everything Kumi keeps: notes about you and this Set,
  techniques and recipes. Choosing a note or a technique offers to forget it, and a
  recipe to run or forget it. You can also tell Kumi one is wrong, or to forget it.
- **Cost.** Notes are loaded when a conversation starts, as part of the model's
  instructions, so they stay in the provider's prompt cache. A note kept
  alongside the answer costs no second model reply and no request to Live
  (`npm test` holds it to that); one kept before the answer is written still
  lets the model answer.
- `KUMI_MEMORY_FILE` moves the notes about you elsewhere.

### Techniques

A technique is what made something Kumi built work, kept to adapt to similar
sounds later: the idea (the chain and why each part), the settings that mattered,
what to use when a part isn't there, what it fits, and where it came from (a
tutorial or your conversation). A recipe replays exact steps; a technique is
adapted. For example, the Reese-to-neuro chain from a tutorial becomes a neuro bass
on another track, with Auto Filter standing in for a plugin you don't have.

- **Learned quietly.** When a plan builds a sound or a chain, the model writes a
  draft of it into that plan, without a word about it. When it doesn't, and the
  answer loaded two devices or more, Kumi drafts one from the build itself: your
  words for what it fits, the chain in order, and the settings it changed.
  Kumi keeps the draft only
  if your next moves say you liked the result: you played it, kept working on it
  or around it (knobs included), saved the Set, said so, or moved on to other
  things and left it in place (after a couple of requests, or ten minutes). It's
  dropped, without a word, if you undid most of it, deleted its track, said no
  ("not like that", "start over"), or stopped the answer that built it. No extra
  model call decides this.
- **Shown when kept.** `◆ Kept a technique: …` in the conversation, a moment in
  NOW, and a MEMORY row with its forget. A technique that refines one already kept
  (the same name, or one the model read) updates it rather than adding another.
- **Used by name.** Only each technique's name and what it fits are in the model's
  instructions; it reads one whole when a request fits, adapts it, and says so
  ("using your parallel-filter technique from the Apollo tutorial, adapted").
  Kumi's line says `◆ Using your technique: …`.
- **Kept like notes:** in `~/.kumi/techniques.json`, readable only by you, up to 40
  (the one used least lately makes room). The same filter keeps out anything that
  reads as instructions or holds something like a key. Asked in so many words
  ("remember how we did that"), Kumi keeps one at once.

### What Kumi couldn't do

When a request needs something Kumi's tools or Live's scripting don't offer
(freezing a track, say), Kumi tells you and offers the way round, and notes the
missing capability in `~/.kumi/gaps.jsonl` (readable only by you, the latest 500
kept) for Kumi's developers. It's never read back into a conversation and isn't
part of what Kumi remembers about you; a later `kumi report` will bundle it for
sending, when you choose.

## Limits and failure behavior

- **A nearly full disk** makes recordings, saves and downloads fail partway, often
  without saying why. Kumi checks first and says what's free and what to do:
  recording needs 500 MB on the disk Live records to (the Set's), a Max for Live
  device 100 MB on the User Library's disk, and a program Kumi fetches (ffmpeg, a
  speech model) room for itself on Kumi's.
- **Conversations** are kept per Set in `~/.kumi/projects`, next to what Kumi last
  saw of each Set (readable only by you): saved after every answer, the latest 20
  per Set, the oldest exchanges dropping off past about 256 KB. An unsaved Set's
  are kept under `unsaved` and move to the Set's own folder when it's first saved.
  Opening Kumi on a saved Set carries on its latest conversation; `/new` starts
  afresh and keeps the last one, and `/conversations` goes back to any of them.
  Kumi's changes (HISTORY) are kept with each conversation and come back without
  undo. A kept conversation the chosen model can't continue is shown, and a fresh
  one starts.
- **What Live's scripting can't do:** map a macro or modulator to a parameter, set a
  macro's range, or show Kumi the Arrangement's automation lanes for editing. Kumi
  says so and suggests the way round. Saving, grouping, freezing, bouncing and
  exporting go through Live's own menus (below).
- **Deleting:** Kumi deletes a device or a return track only when you ask, and
  can't bring it back (Live's own undo can). Everything else it removes by undoing
  its own change.
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
- A failed refresh produces no answer based on old observations. Opening another
  Set switches to that Set's conversation; a changed tool catalog (new tools
  after a first clip, say) keeps it. Same-name/unsaved Set switches the bridge
  cannot distinguish are a limitation; use `/new` explicitly.
- **Live closing or crashing:** Kumi notices within a second, says so ("Live
  closed. Kumi will pick up where you left off when it's back."), keeps the
  conversation and reconnects on its own within seconds of Live being back
  (starting a fresh bridge, which the bridge requires after a Live restart). The
  same happens when Kumi's bridge itself drops while Live stays open. The
  conversation carries on even when Live comes back with a blank Set; only a
  different saved Set switches to that Set's conversation. A request that was
  running is stopped; when Live is back it's in the input box, one Enter from
  sent again. Messages sent meanwhile are answered without Live and stay in the
  conversation. If Live is still away after 30 seconds, Kumi asks whether it's
  open with AbletonMcpBridge chosen as a Control Surface; `/reconnect` tries
  again at once. Kumi never suggests `/new` for a connection problem.
- Undo lasts as long as Live and Kumi's bridge connection: after Live restarts, a
  fresh bridge (a reconnect) or a Kumi restart, earlier changes show **no undo**
  and can be undone only in Live (Cmd-Z). `/new` keeps the bridge, so they can
  still be undone. One answer makes at most 500 changes (a batch of pads or parameters counts once).
- Catching up needs a saved Set; a Set is recognized by its file path (Save As
  starts afresh). Look-alike items the bridge can't match (empty tracks,
  say) are read by name and position, so a rename can occasionally show as a
  removal and an addition.
- After a disconnect, observations are discarded and the conversation carries on
  without Live tools until Live is back. Kumi looks for Live every 2 seconds and
  starts a fresh bridge as soon as Live's Remote Script answers (otherwise every
  30 seconds). An answer from the bridge that arrives after Kumi stopped waiting
  for it (Live quitting mid-request does this) no longer drops the connection.
- A missing or refused sign-in, or a model the provider doesn't offer, is said
  plainly with the fix offered (sign in, choose another model). An unbuilt Kumi,
  invalid configuration or startup failure is reported with the command that
  fixes it. Neither includes provider payloads or credentials.
- **Listening** hears files, recordings and the Set's tracks and mix (through Kumi
  Ears, which needs Max for Live). It measures and compares; it doesn't judge taste. The model says what it heard
  from those numbers. Very long files are heard in part (up to 12 minutes).
- **Watching videos** depends on the sites as they are: yt-dlp keeps up with
  them, and Kumi fetches it afresh each month. Private, members-only and some
  age-restricted videos can't be read. Automatic captions and transcription can
  mishear names; Kumi checks them against the frames. A model that can't take
  images (some OpenCode models) gets a video's words only. A long video's words
  come a stretch at a time, and it is transcribed up to 90 minutes at once.
- **Bridge version:** tools that needed bridge fixes (playing, recording,
  editing notes, the transport and song settings, deleting, and more) need
  bridge 1.0.34 or later. With an older bridge Kumi offers the rest, and
  `kumi doctor` says how to upgrade.

## Privacy and verification

Your prompts, in-memory conversation and returned Live metadata are sent to the
selected inference provider. Track/device names and tool results are untrusted
data, not instructions or permission grants. Reading Live is not local-only.
Kumi keeps saved Sets' conversations and its notes in `~/.kumi`, readable only by
you; terminal scrollback and the provider's retention policies are separate.
When Kumi looks something up, its searches go to Exa, Parallel, Keenable or
Firecrawl (or DuckDuckGo), and it reads pages itself; a PDF, a page built by
scripts, or a site that turns Kumi away is read through those services' readers in
turn, and each one asked sees that address. Kumi doesn't read an address that
carries a key or token. The
credential store intentionally persists.

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
new tracks, devices), undo that outlives the bridge connection, and the bridge's
scale limits (see the evidence, "Scale on real
Live").
