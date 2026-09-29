# Changelog

Kumi's releases. The Ableton bridge (`apps/mcp-server`) is versioned on its own;
each Kumi release names the bridge it ships with.

## 1.0.0 — 2026-09-29

The first release for producers to use day to day. Ships with bridge 1.0.34.

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

### Listening

- `listen` hears audio files and the Set's audio clips. It measures loudness
  (LUFS, true peak, range), balance in ten bands with stereo width, dynamics,
  tempo and key. For a single sound it also finds pitch, harmonics, envelope
  and LFO movement.
- It compares audio with a reference at matched loudness, which helps with
  matching a mix or rebuilding a sound. The conversation shows a small spectrum
  and the differences in dB. The analysis runs on your computer; only numbers
  reach the model.

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
  about each saved Set. `/memory` shows and forgets them.

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

- `npm run kumi -- bridge` installs the bridge into Live, or updates it, in one
  command. It runs the bridge's own lifecycle (plan, apply, rollback), refuses
  while Live is open, and waits for Live afterwards. `kumi doctor` and a failed
  start say when it's needed.

### Also

- `kumi --version`. Kumi identifies itself as `kumi/1.0.0` to providers and the
  bridge.
