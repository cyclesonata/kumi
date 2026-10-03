# Kumi guide

English · [简体中文](../zh-CN/KUMI_GUIDE.md) · [日本語](../ja/KUMI_GUIDE.md)

Kumi is a producer agent for the Ableton Live Set you have open, in your
terminal. It reads the Set, makes the changes you ask for and shows each one in
HISTORY. It plays, records and renders, listens to audio and compares it with a
reference, watches video tutorials, makes Max for Live devices, looks things up
on the web, and remembers how you work.

To install Kumi and connect it to Live, follow [Get started](../../README.md#get-started).
This guide covers everything after that. For the keys and the screen, see
[commands, keys and screens](KUMI_TUI.md); for how changes and undo work, see
[how Kumi changes your Set](KUMI_CHANGES.md).

## Sign in and choose a model

Inside Kumi, `/login` signs in: to ChatGPT with your plan (the browser opens and
the sign-in comes back on `localhost:1455`), or to Anthropic, OpenAI or OpenCode
with an API key, pasted into a box that shows only dots. Kumi checks a key with
its provider before keeping it; if the provider can't be reached, it keeps the
key and says it isn't checked yet. `/logout` signs out.

| Provider | Model names | Sign-in |
| --- | --- | --- |
| ChatGPT plan | `openai-codex/<model>` | `/login` (browser), or `kumi login openai-codex` (`--device` on a machine without a browser) |
| Anthropic API | `anthropic/<model>` | `/login` with an API key, or `ANTHROPIC_API_KEY` |
| OpenAI API | `openai/<model>` | `/login` with an API key, or `OPENAI_API_KEY` |
| OpenCode Zen and Go | `opencode/<model>`, `opencode-go/<model>` | `/login` with an API key (one for both), or `OPENCODE_API_KEY` |

A key saved with `/login` is used first; without one, Kumi uses the key in the
environment, and can't sign out of that (unset it instead). Paste an API key
only into Kumi's key box or its `kumi login` prompt, never into a message.
Claude and Gemini subscription sign-ins aren't offered, because their providers
don't permit them in third-party tools. OpenCode's Gemini models aren't
supported yet.

`/model` lists each provider's models, read from the provider itself, so a model
released today is there without a Kumi update. With no model chosen, Kumi uses
the first model of the first provider you're signed in to (in the order of the
table) and says which. `/effort` sets how hard the model thinks, from the levels
that model offers; lower answers sooner. Both apply from your next message and
are kept for next time. Changing model keeps the conversation, except the
earlier model's private reasoning, which belongs to that model.

When an answer fails because a sign-in is missing or was refused, Kumi offers to
sign in and then sends your message again. When the provider doesn't offer the
chosen model, Kumi offers to choose another.

## Connect to Live

Kumi reaches Live through its bridge: a Remote Script that runs inside Live and
a local MCP server that Kumi starts. `kumi bridge` puts it into Live:

1. Quit Live, saving your work.
2. Run `kumi bridge`. It asks you to confirm Live is closed (`--yes` confirms
   beforehand) and refuses while Live is running.
3. Open Live. The first time, open **Settings → Link, Tempo & MIDI** and choose
   **AbletonMcpBridge** as a Control Surface.

`kumi bridge` installs or updates the bridge through the bridge's own lifecycle,
with checks, receipts and rollback, and keeps its settings and secret across
updates. It never quits or starts Live. Afterwards it waits up to ten minutes
for Live to connect, and says when it does. `kumi update` runs it for you when
the bridge in Live is older than Kumi's and Live is closed; `kumi doctor` says
when to run it yourself.

Kumi finds Live's Remote Scripts folder in your User Library, including one
you moved elsewhere (it reads Live's own settings for that).
`KUMI_REMOTE_SCRIPTS_DIR` overrides it.

**Kumi's Live extension.** On Live 12.4 and later, `kumi bridge` also puts Kumi's
extension into Live's Extensions folder (on macOS
`~/Library/Application Support/Ableton/Extensions/kumi.kumi`; on Windows Kumi
uses `%LOCALAPPDATA%\Ableton\Extensions`, which isn't confirmed on Windows yet).
Live starts it the next time it opens. The extension writes MIDI clips straight
into the Arrangement, clears a stretch of a track, renders a track's clips
without playing them, and adds **Ask Kumi about this** to Live's right-click
menu (under **Extensions**), which pins what you clicked for your next message.
With Developer Mode on (Settings → Extensions), Live starts no extensions, so
the bridge starts Kumi's itself. Kumi works without the extension, and
`kumi doctor` says whether it's there and running.

Once the bridge is installed and chosen in Live, `kumi` finds it and connects;
there is nothing to configure. Without it, Kumi starts anyway, chats without
Live (**No Live access**) and says how to connect. `kumi --bridge-config
<absolute path>` uses a bridge configuration of your own; `kumi
--inference-only` chats without Live.

**Optional: Willington.** With the separately installed Willington provider,
Kumi can also edit Follow Actions, map rack macros and set chain zones. It runs
on one exact Live build on macOS ARM64; see [Optional Willington
integration](WILLINGTON_INTEGRATION.md).

## Working with Kumi

Kumi runs full screen: the conversation on the left, a Live pane on the right
and the input box at the bottom. FOCUS follows what you touch in Live, NOW shows
what Kumi is doing, and HISTORY lists every change with its undo. Below 100
columns the Live pane folds into a strip above the input box. `KUMI_UI=plain`,
or piping the output, gives plain line-by-line output instead, which suits
screen readers. [Commands, keys and screens](KUMI_TUI.md) has the details.

Try "Describe the open Set: tracks, tempo and transport", then ask which devices
are on a track. Ask for a change, such as "Set the tempo to 124 and rename
3-Audio to Bass": each change appears in HISTORY with **undo** beside it. Click a
device in FOCUS, or right-click something in Live and choose **Ask Kumi about
this**, to point at it: "this Saturator's too harsh".

While Kumi works, Enter tells it more (it reads your message after the step
under way), Tab sends a message for after the answer, and `/btw` asks something
on the side without interrupting. Esc stops the answer; the steps it finished
stay. `/stop` stops Live (clips, the transport and recording) at any time.

## Changes and undo

Kumi plans a request as one set of changes and runs it at once. Every change
lands in HISTORY with a title in plain words ("Tempo 120 → 124 BPM"). Click
**undo** beside it, type `/undo` for the latest, or ask Kumi. Undo restores
exactly what the change replaced. When it can't (the object is gone, or for
some settings, you changed the same thing again since), the row reads **kept**
with the reason. A whole plan is also one step in Live's own undo, so one Cmd-Z
in Live (Ctrl-Z on Windows) takes it back.

Some changes can't be taken back by Kumi (deleting a track, cropping a clip,
adding a rack chain). HISTORY marks them **kept**, and Live's own undo still
takes them back. Kumi deletes things when you ask, or when the request implies
it ("start over", "replace the drums").

**A copy before big changes.** When a plan reaches its third step, or a step
that deletes something, Kumi copies the Set as last saved next to it
(`Song.backup-<date>.als`) and says so, once for each saved version. Unsaved
work isn't in the file, so it isn't in the copy, and an unsaved Set gets none.

**Python in Live.** For what its other tools can't reach, Kumi can run Python
inside Live with Live's own API. A script's changes are one step in Live's
undo, but they get no HISTORY entry; Live's undo takes them back.

**What Live doesn't let scripts do:** save the Set, export or freeze a track,
map a macro or a modulator to a parameter (Willington can map macros), or edit
the Arrangement's automation lanes. Kumi says so and suggests a way round.

[How Kumi changes your Set](KUMI_CHANGES.md) lists every change Kumi can make.

## Playing, recording and rendering

Kumi plays and stops the Set, launches clips and scenes, moves the playhead and
records, when you ask or when it helps to check or show what it built. If a plan
stops partway (a step fails, or you press Esc), Kumi stops the playback and
recording it started. If Live refuses its ordinary stop, Kumi uses the bridge's
emergency stop.

Live gives scripts no bounce, so Kumi bounces by resampling: it adds an audio
track fed from the source track, or from "Resampling" for the whole mix, records
the length you want in the Arrangement, and disarms the track. The recording
stays in the Set as an audio clip. With the extension, Kumi can also render an
audio track's own clips to a file without playing them (before the track's
devices).

## Listening

Kumi hears audio files and the Set's audio clips: a reference track, a sample, a
bounce or a recording. It measures:

- loudness: integrated LUFS, true peak and loudness range;
- tonal balance in ten bands, from sub to air, and stereo width in each;
- dynamics, tempo and key;
- for a single sound, its pitch, harmonics, envelope and movement (an LFO's
  rate, at the tempo);
- for a part with notes, the notes themselves (from its first minute), to write
  as a MIDI clip.

Given a reference, it matches the loudness and says what differs most. The
conversation shows what it heard as a small spectrum, and a comparison as dB
over or under the reference. Kumi reads WAV and AIFF itself, and MP3, M4A, FLAC
and the like through macOS's `afconvert` or, elsewhere, `ffmpeg` (which Kumi
fetches on Windows the first time it's needed). The analysis runs on your
computer: only the numbers go to the model, never the audio.

## Matching a reference

Ask Kumi to make something sound like a reference ("make the bass sound like
this: ~/refs/bass.wav") and it treats it as a search, not a guess. It listens to
the reference, builds two to four different takes on their own tracks, and
renders them together quietly to score each against the reference (0 to 100,
with the biggest differences). It then refines the best, changes structure when
no knob closes a gap, and stops when it reaches the target, when new ideas stop
helping, or after 12 rounds or 45 minutes. It ends with the score before and
after and what still differs.

`/goal` and what to reach goes further: Kumi keeps searching, mostly with its
own fast knob search and with the model's bigger ideas every few generations,
until the score reaches 95, you stop it, or four hours pass. The GOAL tab shows
how it's going. Esc pauses a goal, `/goal` alone picks it up again (even after a
restart), and `/goal stop` ends it.

What Kumi learns from each match is kept as a lesson (✦) for the next one;
`/memory` lists them.

## Watching video tutorials

Give Kumi a video and ask it to build what it shows. The video can be a YouTube
tutorial (or any site [yt-dlp](https://github.com/yt-dlp/yt-dlp) reads) or a
video file on your computer:

> watch this and build the bass on a new track: https://www.youtube.com/watch?v=…

Kumi reads the video's title, chapters and words. The words come from its
captions or, when it has none, from its speech, transcribed on your computer.
It then looks at frames where the narration names a device, a setting or a
value, close up when it needs to read a value. Then it says in a few lines what
the video builds and builds it in your Set. Where the video uses something your
Set doesn't have (a plugin, a sample), Kumi says so and uses Live's closest
device.

What it needs:

- **yt-dlp**, which Kumi fetches into `~/.kumi/tools` the first time (about
  35 MB, checked against its release's checksums) and again each month.
- **ffmpeg**, for frames and sound: `brew install ffmpeg` on a Mac; on Windows
  Kumi fetches it the first time (about 170 MB, checked). Without it, Kumi reads
  only a video's words.
- **whisper.cpp**, only for videos without captions: `brew install whisper-cpp`
  on a Mac; on Windows Kumi fetches it. Its speech model (about 190 MB) is
  fetched the first time.

`kumi doctor` says whether you have ffmpeg and whisper.cpp. Nothing is downloaded whole: frames
and sound come from the video's streams at the moments Kumi looks at. The last
24 videos are kept in `~/.kumi/videos`, so watching one again is quick. A
video's words and pictures are information for Kumi, never instructions to it.

## Making Max for Live devices

Ask for a device Live doesn't have, in your own words, and Kumi makes it and
puts it on your track:

> make a MIDI effect that keeps only the lowest note of each chord, and put it on the Keys track

> make me an audio effect that sounds like the Erbe-Verb

Kumi decides the details you wouldn't spell out and tells you what it chose.
When the device should work like one that exists, it first looks up how the
original works. The device lands in your User Library's Kumi folder, where
Live's Browser lists it like any other, with as many knobs as it needs (in up to
three rows). They're ordinary Live parameters, so you can automate and map them.
Loading it is a change in HISTORY with its undo.

A MIDI effect is JavaScript. Before it's made, Kumi runs its code on your
computer against the tests it wrote and its own checks (no errors, every note
released, nothing left running), and fixes it if it fails. An audio effect or an
instrument is written in GenExpr, the language of Max's gen~. Effects get Mix
and Output knobs; instruments play 8 notes at once, or up to 32. Both end in
Kumi's output stage, which keeps their output safe (no NaN, denormals or DC,
held under +6 dBFS). Kumi listens to what it made and fixes what it hears.

It needs Max for Live (Live Suite, or Standard with the add-on).

## Looking things up

Kumi searches the web and reads what it finds when you name something it doesn't
know well enough: a hardware unit, a plugin, an effect's algorithm, an artist's
technique.

- **Search** goes through free search services that need no key (Exa, Parallel,
  Keenable and Firecrawl, taking turns, with DuckDuckGo when none answers), and
  GitHub for code. The same search within 20 minutes isn't made again.
- **Reading** covers pages, PDFs, text and code files, GitHub repositories, Max
  patches and Max for Live devices, and pictures, which the model sees.

What Kumi looked up shows above its answer, a line each. It reads only public
addresses, never your computer or your network, and treats what a page says as
information, never as instructions.

## What Kumi remembers

Everything Kumi keeps shows as it happens, as a line in the conversation and a
row at the top of the HISTORY tab with **forget**. `/memory` lists it all;
choose an item to forget it.

- **Notes** (✎): what you tell Kumi that Live can't show, such as what a track
  is for, what you're going for, your habits and what you like. Notes about you
  are in `~/.kumi/memory.json`; notes about a saved Set are in its folder in
  `~/.kumi/projects`. Up to 24 in each place, a sentence each; the oldest makes
  room. Kumi doesn't keep what the Set shows, what it did, or anything that
  reads as instructions or looks like a key, so text inside a Set can't become a
  standing order.
- **Techniques** (◆): what made something Kumi built work, kept to adapt to
  similar sounds later. Kumi keeps one only when your next moves say you liked
  the result (you played it, kept working with it, saved the Set or said so),
  and drops it quietly when you undo it or say no. Up to 40, in
  `~/.kumi/techniques.json`.
- **Recipes** (↻): ways of working you can replay in any Set, such as a vocal
  chain or a resampling loop. Ask Kumi to keep what it just did, describe a
  routine, or say "watch me", do it by hand in Live and say when you're done:
  Kumi turns what changed into a recipe with blanks for what differs each time.
  Ask for a recipe by name to run it, or use `/recipes`. Kept in
  `~/.kumi/recipes`, one file each.
- **Lessons** (✦): what Kumi learned matching sounds, used by the next match.
  Up to 60, in `~/.kumi/playbook.json`.

When a request needs something Kumi's tools or Live's scripting don't offer,
Kumi tells you, offers a way round and notes the missing capability in
`~/.kumi/gaps.jsonl` for Kumi's developers. It's never read back into a
conversation; `kumi report` includes it when you choose to send one.

## Conversations and catching up

Kumi keeps each saved Set's conversations in `~/.kumi/projects`: saved after
every answer, the latest 20 per Set, each up to about 256 KB (the oldest
exchanges drop off). Opening Kumi on a saved Set carries on its latest
conversation, with its last 100 changes in HISTORY (without undo). `/new` starts afresh and
keeps the last one; `/conversations` goes back to any of them. An unsaved Set's
conversation moves to the Set's own folder when you first save it.

Kumi also remembers each saved Set as it last saw it. Next time, the welcome
screen says what changed meanwhile ("Since you were last here · 3 days ago:
Tempo 120 → 124 BPM; Added track “Pad”"), and Kumi takes it into account. A Set
is recognized by its file path, so Save As starts afresh.

## When Live goes away

Kumi notices within a second when Live closes or crashes, says so and keeps the
conversation. It looks for Live every two seconds and reconnects on its own
when Live is back; a request that was running comes back into the input box, one
Enter from sent again. If Live is still away after 30 seconds, Kumi asks whether
it's open with AbletonMcpBridge chosen as a Control Surface. `/reconnect` tries
at once.

Kumi's undo lasts as long as its connection to Live: after Live restarts, a
reconnect or a Kumi restart, earlier changes read **no undo** and can be undone
only with Live's own undo. `/new` keeps the connection, so undo still works.

## Updating, reporting and uninstalling

```sh
kumi update              # the newest Kumi, and the bridge in Live when it's older
kumi update --check      # only say whether there's a newer Kumi
kumi update --rollback   # go back to the Kumi before the last update
kumi doctor              # check Node, sign-in, the bridge, Live, the extension and the terminal
kumi report              # a file to send when something goes wrong
kumi uninstall           # remove Kumi; add --all to remove your conversations, notes and sign-ins too
```

`update` fetches the newest release, checks it against its checksum and starts
it once to be sure it runs before putting it in place; the one before is kept
for `--rollback`. If the bridge in Live is older and Live is closed, it then runs
`kumi bridge`; if Live is open, it says to quit Live and run `kumi bridge`. In a
copy of the repository, `update` moves the checkout forward instead
(`git merge --ff-only`, refusing local changes) and runs `npm run setup`.
Inside Kumi, `/update` asks first, then closes Kumi, updates it and opens it
again with the same conversation.

Kumi checks for a newer version as it starts, at most once a day, and says
nothing when there's none or no network. `"updateCheck": false` in
`~/.kumi/settings.json`, or `KUMI_NO_UPDATE_CHECK=1`, turns that off.

`report` writes `~/kumi-report-<date and time>.txt`: Kumi's and the bridge's
versions, the doctor's checks, your settings, what Kumi did in your last
conversation, the gap log, and the bridge's lines from Live's own log. Keys and
tokens are taken out, your home folder shows as `~` and your account name as
`<user>`. Read it before sending.

`uninstall` removes Kumi, its Node, its launcher and the PATH entry it added,
and offers to take the bridge and the extension out of Live (only while Live is
closed). Your conversations, notes, recipes and sign-ins stay unless you add
`--all`.

## Limits

| What | Limit |
| --- | --- |
| A message you send | 16 KiB |
| One answer | 200 model steps; stops after 10 minutes without progress, or 60 minutes in all (longer for matching and goals) |
| Retries | Up to 3 for a provider failure, before any output of that step was shown |
| A request to the bridge | 65 seconds |
| Changes in one answer | 5,000 (a batch of pads or parameters counts once) |
| A `wait` step in a plan | 30 minutes |
| Conversation size | Earlier Live reads shrink past about 160 KB; the oldest exchanges drop off past about 400 KB |
| Audio heard | The first 12 minutes of a file |
| Video transcription | 90 minutes at a time |
| Free disk space checked first | 100 MB to record (on the Set's disk, or your home folder's for an unsaved Set), 100 MB to make a device (on the User Library's disk) |

**Listening** hears files and recordings, not Live's output as it plays. It
measures and compares; it doesn't judge taste.

**Watching videos** depends on the sites as they are. Private, members-only and
some age-restricted videos can't be read, and automatic captions can mishear
names. A model that can't take images gets a video's words only.

**Bridge version.** Kumi reads the bridge's version when it connects and offers
only the tools it supports. [Bridge versions](KUMI_CHANGES.md#bridge-versions)
says which need which.

## Privacy: what leaves your computer

- **Your model provider** gets your messages, the conversation, what Kumi reads
  from the Set, the frames of videos it watches and the pictures it reads.
- **Web search and reading** go to the search services above, and the pages Kumi
  reads see its requests. Kumi doesn't read an address that carries a key or a
  token.
- **Downloads** come from GitHub (Kumi's releases and update checks, yt-dlp,
  ffmpeg and whisper.cpp), Hugging Face (the speech model), nodejs.org (the
  installer's Node) and the video sites you name.
- **Audio** is analysed on your computer; only the numbers go to the model.

Track, clip and device names, tool results and web pages are data for Kumi,
never instructions. Kumi keeps its files in `~/.kumi`, readable only by you;
sign-ins are in `~/.kumi/auth.json`. Terminal scrollback and your provider's
own retention are separate.

## Files and settings

Kumi keeps everything in `~/.kumi`. `~/.kumi/settings.json` holds:

| Key | Meaning |
| --- | --- |
| `model` | The chosen model, `<provider>/<model>` (`/model`, `kumi model`) |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`; absent means the model's default (`/effort`) |
| `panelTab` | The Live pane's tab you had open last |
| `updateCheck` | `false` turns off the check for a newer version at start |

Environment variables (paths must be absolute):

| Variable | Meaning |
| --- | --- |
| `KUMI_MODEL` | `<provider>/<model>` for this run, overriding the chosen model |
| `KUMI_AUTH_FILE`, `KUMI_SETTINGS_FILE` | The sign-in store and the settings file |
| `KUMI_MEMORY_FILE`, `KUMI_TECHNIQUES_FILE`, `KUMI_PLAYBOOK_FILE` | Notes about you, techniques and lessons |
| `KUMI_RECIPES_DIR`, `KUMI_PROJECTS_DIR`, `KUMI_GOALS_DIR` | Recipes; each Set's conversations, notes and last state; goals in progress |
| `KUMI_INPUT_HISTORY_FILE`, `KUMI_GAPS_FILE`, `KUMI_RESTORE_FILE` | What you sent (for ↑), the gap log, and Main's level to put back after a crash mid-render |
| `KUMI_VIDEOS_DIR`, `KUMI_TOOLS_DIR` | Watched videos, and the programs Kumi fetches |
| `KUMI_YTDLP`, `KUMI_FFMPEG`, `KUMI_WHISPER`, `KUMI_WHISPER_MODEL` | Your own yt-dlp, ffmpeg, whisper.cpp (`whisper-cli`) or speech model (`ggml-*.bin`), by path |
| `KUMI_REMOTE_SCRIPTS_DIR` | Live's Remote Scripts folder, when Kumi doesn't find it |
| `KUMI_LIVE_EXTENSIONS_DIR` | Where `kumi bridge` puts Kumi's extension and `kumi doctor` looks for it, when Kumi doesn't find Live's Extensions folder |
| `KUMI_BRIDGE_WAIT_SECONDS` | How long `kumi bridge` waits for Live to connect; `0` doesn't wait |
| `KUMI_NO_UPDATE_CHECK` | Any value turns off the check for a newer version at start |
| `KUMI_UI=plain` | Plain line-by-line output instead of the full-screen app |
| `KUMI_COLOR` | `truecolor`, `256`, `16` or `none`, when detection gets it wrong; `NO_COLOR` is honoured |
| `KUMI_ICONS` | `glyphs` or `badges` (two-letter icons), when the terminal's symbols look wrong |
| `KUMI_TRACE=1` | Print the name of each bridge call (no arguments or results) |

The installer reads `KUMI_HOME` (install somewhere other than `~/.kumi`; set it
when installing, not afterwards), `KUMI_VERSION` (install a given release),
`KUMI_RELEASES` (where to download from; it wins over `KUMI_VERSION`) and
`KUMI_NO_MODIFY_PATH=1` (leave your PATH alone).
