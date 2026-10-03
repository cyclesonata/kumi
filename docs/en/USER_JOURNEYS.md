# Worked examples

English · [简体中文](../zh-CN/USER_JOURNEYS.md) · [日本語](../ja/USER_JOURNEYS.md)

Short sessions with the bridge's tools, as an MCP client sends them. Each step
shows a tool and its arguments. Values in angle brackets come from an earlier
answer: refs from `live_discover`, a `transactionId` from a preview. Pick your
own `idempotencyKey`, 8 to 128 characters, new for each apply. The
[user guide](USER_GUIDE.md) describes every tool and
[how changes work](USER_GUIDE.md#how-changes-work).

## Look at the Set

```text
live_status     {}
live_discover   {"kind": "track", "limit": 50}
live_discover   {"kind": "device", "parent": "<trackRef>"}
live_discover   {"kind": "parameter", "parent": "<deviceRef>"}
```

`live_status` should say `"connected": true` and `"provenance": "real-live"`.
Each discovery page returns `items`, and a `nextCursor` while there are more.
Refs look like `1232800184424618:track:4`. They hold until Live's epoch
changes, which happens when Live restarts or the bridge reconnects.

## Change the tempo, then undo it

```text
live_tempo_preview  {"tempo": 124}
live_tempo_apply    {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "tempo-124-a1"}
live_undo           {"transactionId": "<id>", "confirmation": "undo", "idempotencyKey": "tempo-undo-a1"}
```

The preview answers with `priorTempo`, `proposedTempo`,
`confirmation: "apply"` and `expiresAt`, and changes nothing. The apply answers
`"state": "applied"` with the tempo Live now has. Sending the same apply again
with the same key changes nothing and answers again. The `change_tempo_safely`
prompt and the `ableton://live-workflow` resource describe the same steps.

## Make a change in one call

```text
live_change  {"tool": "live_mixer_preview", "args": {"trackRef": "<trackRef>", "mute": true}, "idempotencyKey": "mute-bass-a1"}
```

The answer is the apply's, with the preview's under `preview`. Its
`transactionId` works with `live_undo` like any other.

## Load an instrument and shape it

```text
live_browser_search              {"category": "instruments", "query": "drift"}
live_browser_load_preview        {"itemId": "<itemId>", "trackRef": "<trackRef>"}
live_browser_load_apply          {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "load-drift-a1"}
live_discover                    {"kind": "device", "parent": "<trackRef>"}
live_discover                    {"kind": "parameter", "parent": "<deviceRef>"}
live_device_parameter_preview    {"deviceRef": "<deviceRef>", "values": [{"parameterRef": "<cutoffRef>", "value": 0.4}, {"parameterRef": "<resonanceRef>", "value": 0.2}]}
live_device_parameter_apply      {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "drift-tone-a1"}
```

The load goes after the track's devices; a track that already has an instrument
refuses a second one. Several parameters set in one preview make one change
with one undo.

## Write a clip and hear it

```text
live_discover              {"kind": "clip-slot", "parent": "<trackRef>"}
live_midi_clip_preview     {"trackRef": "<trackRef>", "sceneIndex": 0, "name": "Bass", "length": 4,
                            "notes": [{"pitch": 36, "start": 0, "duration": 0.5, "velocity": 100},
                                      {"pitch": 36, "start": 1.5, "duration": 0.5, "velocity": 90}]}
live_midi_clip_apply       {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "bass-clip-a1"}
live_clip_launch_preview   {"slotRef": "<slotRef>", "outputSafety": {"safe": true, "provenance": "monitors checked at a low level"}}
live_clip_launch_apply     {"transactionId": "<id>", "confirmation": "<confirmation>", "idempotencyKey": "bass-play-a1"}
live_clip_launch_stop      {"transactionId": "<id>", "confirmation": "<stopConfirmation>", "idempotencyKey": "bass-stop-a1"}
```

The slot must be empty. A MIDI clip preview expires after 30 seconds. The
launch preview hands out two unpredictable tokens: `confirmation` to launch
and `stopConfirmation` to stop. The stop ends only that clip; anything else
playing carries on.

## Delete a track, then get it back

```text
live_track_delete_preview  {"trackRef": "<trackRef>"}
live_track_delete_apply    {"transactionId": "<id>", "confirmation": "apply", "idempotencyKey": "drop-fx-a1"}
live_song_undo             {"confirmation": "undo-in-live", "idempotencyKey": "drop-fx-undo-a1"}
```

The preview lists what goes with the track (`alsoDeletes`: a group takes its
tracks). `live_undo` can't bring a deleted track back, but Live's own undo can.
`live_song_undo` undoes whatever Live did last, so use it straight away.

## Several changes as one Cmd-Z

```text
live_undo_step_begin  {"label": "Build the drop"}
...                   previews and applies
live_undo_step_end    {"stepId": "<stepId>"}
```

Every change in between is one step in Live's undo history. Each change keeps
its own `live_undo` too. The step closes by itself after two minutes, or the
`timeoutMs` you give, and when the connection goes.

## Guided plans

`plan_user_journey` returns a plan for one of five journeys and changes nothing.
A plan lists ordered stages, each with the tools to use, and marks a stage
`unavailable` when this Live lacks what it needs, with a fallback. The same
plans come as prompts, and the `ableton://journeys` resource lists them with
their availability.

| Journey | Prompt | The plan covers |
| --- | --- | --- |
| `create-beat-or-song` | `create_beat_or_song` | Tracks, scenes and a MIDI clip built from your description; optional Arrangement copy, note revisions and an audition |
| `sequence-advanced-drums` | `sequence_advanced_drums` | A drum pattern on the Drum Rack's real pad notes, with timing, probability and velocity variation |
| `design-owned-sound` | `design_owned_sound` | Finding and loading a device from the Browser, shaping its parameters, before-and-after audition |
| `compare-reference-mix` | `compare_reference_mix` | Comparing your audio with a reference you supply, optional Live context, one reversible mixer experiment |
| `diagnose-performance-setup` | `diagnose_performance_setup` | Reading playback, arm, monitoring, routing and mixer state, then routing and mixer fixes; optional recording or realtime control |

The plan takes these inputs:

- `traits` (required): 1–1,000 characters describing the music.
- `experienceLevel` (optional): `beginner` or `advanced`.
- `bars` (optional): 1–16.

The plan uses only general musical traits from your description: rhythm,
density, energy, timbre, space, dynamics, harmony, arrangement. If the
description names an artist, a song or a record, or asks for an exact copy,
nothing is taken from it. Every stage is then marked `blocked-by-intent`, and
the plan asks you to describe the sound without naming anyone. The same request
against the same Live state always gives the same plan.
