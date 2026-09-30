# Changelog

Kumi's releases. The Ableton bridge (`apps/mcp-server`) is versioned on its own;
each Kumi release names the bridge it ships with.

## 1.0.0 — 2026-09-29

The first release for producers to use day to day. Ships with bridge 1.0.48.

### Changes to the Set

- Kumi changes almost everything Live's scripting lets a script change. It
  started with tempo, the mixer, names, tracks and scenes, MIDI clips, Browser
  devices, parameters, locators and colours. Now it also handles:
  - the transport (loop, metronome, punch, playhead);
  - song settings (time signature, swing, quantization), Scale Mode and groove;
  - routing, arming and monitoring, extra mixer options and sidechains;
  - clip settings, audio clips (gain, pitch, warping, fades) and warp markers;
  - copying and moving clips, and Arrangement clips;
  - editing notes by id, quantizing, and 23 MIDI transforms and generators;
  - clip automation;
  - return tracks and duplicates, scene settings and scene capture;
  - devices on or off, moved (also across tracks and into racks) and deleted;
  - rack chains and variations, a Simpler's sample, audio import, Capture MIDI,
    device-specific settings and the Looper.
- Before a plan of three steps or more, or one that deletes, Kumi keeps a copy
  of the Set as last saved next to it, once for each saved version, and says
  where it is.
- Each change is in HISTORY with its undo. The few Live can't take back
  (deleting a device or return track, cropping a clip) are kept there with that
  said.
- Tools that needed bridge fixes aren't offered by an older bridge, and say to
  update it when a plan names one.

### Playing, recording and bouncing

- `play`, `fire_scene`, `launch_clip`, `record`, `jump_to_locator`, `select` and
  `show`, used only when you ask to hear, record or see something. NOW shows
  each as it happens.
- `wait` steps in a plan let a recording run. Resampling is one plan: an audio
  track fed from the source or "Resampling", armed, recorded in the Arrangement
  for the length you want, then disarmed.
- A plan that started playback or recording and then stopped short stops them
  again. `/stop` stops Live at any time. When Live refuses the ordinary stop,
  Kumi uses the bridge's emergency stop.
- Before recording, Kumi disarms any other armed track (Live 12.4 arms a MIDI
  track when it's made, and the bridge records onto one armed track only), each
  a change with its undo. A Session clip is launched, then recorded at once.
  `play back-to-arrangement` (bridge 1.0.35) presses Back to Arrangement, so a
  track that followed its Session clips plays the Arrangement again.
- The bridge says why it refused ("recording start requires the exact
  destination to be the only armed track") instead of "adapter request failed".
- A playhead, loop or locator past the end of the Set says where the Set ends
  and that nothing changed (bridge 1.0.36), instead of a change Kumi couldn't
  confirm.
- A track whose input became No Input (its source track was deleted) no longer
  counts as armed: Live can't disarm it and it records nothing, but it used to
  stop recording elsewhere (bridge 1.0.37).
- A loop or playhead change undoes after playing or recording since; the
  playhead goes back only while stopped. A routing change on a track that had
  No Input undoes too (bridge 1.0.38).
- When Live no longer offers what a track was routed from (an input with no
  audio device, a track that no longer makes sound), its undo is refused with
  that reason and nothing changed, instead of an undo Kumi couldn't confirm
  (bridge 1.0.39).
- Firing a scene is confirmed: Live 12.4 launches it on its next tick, and the
  bridge used to refuse it as unconfirmed right after the call (bridge 1.0.40).
  An empty scene, which would only stop what's playing, says it has no clips
  to play and launches nothing (bridge 1.0.41).
- Each device row says whether it's an instrument, an audio effect or a MIDI
  effect, and Live's selected device is named exactly, so FOCUS draws its
  icons and marks the right one of two same-named devices (bridge 1.0.45).
  Selecting a device in Live from Kumi was tried and left out: on real Live it
  lagged or landed elsewhere, so pointing at one stays inside Kumi.
- A track Kumi made as scratch (a render it recorded) is deleted on undo though
  its clip changed since, and an undo refused because something Kumi made
  was changed says nothing changed, rather than leaving the change uncertain
  (bridge 1.0.46).
- One recording can take several armed tracks when Kumi names them all, so
  several sources render in one pass (bridge 1.0.48).
- Kumi's instructions say where note ids come from (the clip's notes, listed
  like any other part of the Set).

### Listening

- `listen` hears audio files and the Set's audio clips. It measures loudness
  (LUFS, true peak, range), balance in ten bands with stereo width, dynamics,
  tempo and key. For a single sound it also finds pitch, harmonics, envelope
  and LFO movement.
- It compares audio with a reference at matched loudness, which helps with
  matching a mix or rebuilding a sound. The conversation shows a small spectrum
  and the differences in dB. The analysis runs on your computer; only numbers
  reach the model.

### Watching video tutorials

- `watch_video` watches a video you point Kumi to, a YouTube tutorial (or
  another site's) or a video file, so it can build what the video shows. It
  reads the title, chapters and words as timed lines. The words come from the
  captions or, without them, from the speech, transcribed on your computer with
  whisper.cpp. Kumi looks at frames where the narration names a device, a
  setting or a value, and looks again close up to read a value on screen. It can
  keep a stretch of the video's sound to compare with its own version.
- The conversation shows each video watched, with small pictures of the frames
  and their times; NOW says what Kumi is doing meanwhile.
- yt-dlp and the speech model are fetched when first needed, each checked
  against its published checksum, and so are ffmpeg (for frames, and for audio
  formats) and whisper.cpp on Windows and Linux; on a Mac they're yours
  (Homebrew), and `kumi doctor` says whether you have them. Videos are kept in
  `~/.kumi/videos`, so watching one again is quick.
- Kumi's agent core shows the model images from tools for the rest of that
  answer, then puts them away, keeping what was said around each.

### Max for Live devices

- `make_device` makes a MIDI effect you describe in your own words and puts it
  in your User Library's Kumi folder, for `load_device`. The model writes the
  device's name, knobs (ordinary Live parameters), code and tests; Kumi builds
  the device around them from a fixed frame. The frame parses MIDI, keeps count
  of held notes and runs timers, and hides files, the network and the rest of
  Max and Live from the code.
- Before it's made, Kumi runs the code on your computer against its tests and
  Kumi's own checks (no errors, no hanging notes, nothing running once every
  note is released), and refuses a device that fails, saying why so the model
  can fix it.
- The model reads the guide (what the code can use, the rules and the craft)
  only when it makes a device, so ordinary requests don't carry it.

### Recipes

- Kumi saves ways of working as recipes (`save_recipe`) and replays them
  (`run_recipe`, or `/recipes`), in any Set, with blanks filled when they run.
- `watch_me` learns a routine you do by hand. It compares the Set before and
  after, including the knobs you turned on devices you added, so Kumi can save
  it as a recipe.
- A plan or recipe names a device's parameters (`parameter: "Drive"` on the
  device an earlier step loaded), so saved routines keep their settings. A saved
  step can't hold a reference that only means something in the session it was
  saved in.

### Memory

- Kumi keeps short notes of what you tell it that Live can't show, about you and
  about each saved Set.
- Techniques: when Kumi builds a sound or a chain (from a tutorial, or a request
  of several steps), it drafts what made it work (the model's draft, or, when
  the model gives none, one from the build: what you asked for, the chain in
  order, the settings it changed), and keeps it only if your next
  moves say you liked the result (you played it, kept working on it, saved the
  Set, said so, or moved on and left it). It's dropped quietly if you undid it,
  deleted it or said no. Kept techniques are named in the model's instructions,
  read whole when a request fits, adapted, and Kumi says it's using one.
- Every save shows: a line of its own kind in the conversation (`✎` notes, `◆`
  techniques, `↻` recipes), a moment in NOW, and the latest three at the top of
  the HISTORY tab with a forget click on each. `/memory` lists and forgets all
  three kinds.
- The right pane: FOCUS and NOW on top, and in its bottom half a tabbed area,
  HISTORY its first tab, scrolled by the wheel or Shift+Tab and the arrows (Enter
  undoes a row). The tab showing is remembered. Later tabs slot in as modules.
- What Kumi couldn't do for lack of a tool or Live's scripting is logged on your
  computer for Kumi's developers (`~/.kumi/gaps.jsonl`), never read back and not
  part of what Kumi remembers.

### Conversations and reconnecting

- If Live closes, or Kumi's bridge to it drops, Kumi says so, keeps the
  conversation and reconnects on its own when Live is back (a late answer from
  the bridge to a stopped request used to drop the connection for good). A
  request Live's going away stopped is back in the input box, one Enter from sent
  again. After 30 seconds without Live, Kumi asks whether it's open with the
  bridge on. `/reconnect` tries again at once, and nothing about a connection
  problem suggests `/new` any more. The first answer after a reconnect is told
  that references from before are gone, so it doesn't try them first.
- Each Set's conversations are kept, the latest 20, an unsaved Set's too (they
  move with the Set when it's first saved), with the HISTORY of each. `/new`
  forgets this conversation and starts fresh, keeping the old one on screen
  under a line and in `/conversations`, which goes back to any of them. `/new`
  keeps the bridge, so earlier changes can still be undone.
- ↑ and ↓ go through what you sent before, kept across `/new` and restarts in
  `~/.kumi/input-history`, with keys and tokens left out.

### Models and sign-in

- `/model`, `/effort`, `/login` and `/logout` inside Kumi. Models are listed
  from each provider, so new ones appear without an update.
- Signing in covers ChatGPT plans and Anthropic, OpenAI or OpenCode API keys. A
  failed sign-in offers the fix and sends your message again.

### Speed

- Tool calls start while the model is still writing them. A plan's steps run as
  they arrive, and a finished plan needs no second model reply.
- The observation before each answer is one round trip to Live.
  `npm test` holds these to counted latency budgets.

### Setup

- On a nearly full disk, recording, making a device and fetching ffmpeg or a
  speech model are refused first, saying what's free and what to do, instead of
  failing partway.
- On an API key, `/status` says the tokens this session's answers took (in,
  cached, out).

- `npm run kumi -- bridge` installs the bridge into Live, or updates it, in one
  command. It runs the bridge's own lifecycle (plan, apply, rollback), refuses
  while Live is open, and waits for Live afterwards. `kumi doctor` and a failed
  start say when it's needed.
- `kumi update` brings the checkout up to date, rebuilds, and updates the
  bridge in Live when it's older. Kumi says when a newer version is out (asked
  of git once a day at most) and, as it starts, when Live's bridge is older.
- `kumi report` writes one file to send when something goes wrong: versions,
  the doctor, the last conversation's requests and tool calls, the gap log and
  the bridge's lines from Live's log, with keys, tokens, the home folder and the
  account name taken out.

### Also

- `kumi --version`. Kumi identifies itself as `kumi/1.0.0` to providers and the
  bridge.
