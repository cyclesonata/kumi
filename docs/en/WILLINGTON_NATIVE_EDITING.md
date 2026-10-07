# Willington native editing candidate

This is a **developer guide, not a declaration of shipped Kumi support**.
[Willington PR #11](https://github.com/xonedsp/willington/pull/11) adds native
bindings for **Live 12.4.15b5 macOS ARM64**. Kumi does not bundle the candidate,
and `/willington` does not install or enable it. Other Live builds and Windows
are not supported by this candidate.

For disposable-fixture development, follow the upstream
[build and installation instructions](https://github.com/xonedsp/willington/blob/feat/native-editing/integrations/WillingtonEditing/README.md).
Installation requires an explicit verified library and deliberate write enablement;
transport must be stopped. After installation, the methods can be called through
`run_python` (`live_run_python` at the host boundary) when the full policy permits
Python. An absent method or exact-build refusal means unavailable, regardless of
Kumi's Willington switch.

Python calls do **not** create Kumi `HISTORY` entries. Native methods have their
own Live undo boundaries: several calls in one script can produce several undo
steps. The global Follow Action switch has no Live undo entry. Never use a blind
`song.undo()` as compensation for a failed script.

`run_python` supplies `song` and, with a current object `ref`, `obj`. Rediscover
references after reconnecting; do not copy object indexes from another Set.

## Group creation

`song.group_tracks(*tracks)` returns the new group, independently of UI selection.
Resolve 1–128 distinct, contiguous top-level audio/MIDI tracks in Song order.
Existing groups, nested groups, master/return tracks and foreign tracks are refused.

`song.ungroup_track(group)` accepts a top-level group with audio/MIDI members,
no devices and no nested groups. It can restore an immediate fixture edit, but
is not a general history inverse: later edits to its routing, automation, devices
or membership must not be discarded. Dedicated history would need to capture
and fence all of those changes.

## Scene and global Follow Actions

`scene.get_follow_actions()` returns JSON; `scene.set_follow_action(field, value)`
sets `enabled`, `action_a`, `action_b`, `chance_a`, `chance_b`, `jump_a`, `jump_b`,
`time`, `linked` or `loop_count`. Actions are 0–9, chances 0–100 and coupled to
sum to 100. Jumps are one-based scene numbers (0 is unset), through 8388608.
Time is quarter-note beats, minimum 0.25; loop counts are 1–1073741823.
Linked timing uses the longest clip and loop count. Retain and reread full state.

`song.get_follow_actions_enabled()` reads the global switch;
`song.set_follow_actions_enabled(True)` or `False` changes it. Keep the previous
boolean and restore it explicitly. No scene/global observer API is exposed.
Fixture scheduling was verified with UI launches; `Scene.fire()` did not
reproduce the UI scheduler in that experiment.

## Per-note MPE

Use a stable note ID from a fresh MIDI clip note read.
`clip.get_note_expression(note_id, dimension)` returns JSON; dimensions are
`pitch`, `slide`, `pressure`. `clip.replace_note_expression(note_id, dimension,
state_json)` accepts a state with boolean `exists` and an `events` list.

Each event is `[time, value, x1, y1, x2, y2]`: beats from the note's start,
pitch in cents (±4800), slide/pressure in MIDI units (0–127). Bounds are 65536
events, times 0–1576800, at most two coincident events, and curve coefficients
0–1. Absent and explicitly empty lanes differ. Preserve `exists` and all curve
coefficients for restoration, and confirm the same clip and note still exist.

## Arrangement automation

Resolve an owning track and continuous parameter; quantized and cross-track
parameters are refused. Methods are:

- `track.get_arrangement_automation(parameter, start, end)` — interval JSON.
- `track.insert_arrangement_event(parameter, event_json)` — insert a six-number
  event in absolute Song beats (0–1576800), with public parameter units.
- `track.delete_arrangement_events(parameter, start, end)` — delete a range.
- `track.get_arrangement_snapshot(parameter)` — complete opaque snapshot JSON.
- `track.restore_arrangement_snapshot(parameter, snapshot_json)` — explicit restore.

Retain a complete snapshot before mutation. Interval reads omit hidden initial
and out-of-range events and cannot serve as complete undo data. Snapshots retain
raw native values, curves, coincident events and envelope absence. Live can
normalize curve handles on insertion, including resetting a final point's handles;
verify readback instead of assuming the submitted handles were retained.

Snapshots are signed and bound to the originating parameter and adapter instance.
Reinstalling the adapter or restarting Live invalidates them. They are not durable
Kumi history: do not alter their contents or fall back to Live undo after a
signature refusal. Pending automation transforms are refused. UI selection and
event-object identity are outside the snapshot contract.

## Evidence and release boundary

Upstream [fixture evidence](https://github.com/xonedsp/willington/blob/feat/native-editing/evidence/native-editing/b5/README.md)
covers readback, native undo/redo, save/reopen, Max calls, MPE playback and notes
notifications, Arrangement playback, group routing, and UI scene scheduling.
The pending-transform refusal was tested through its native flag controller,
not an active UI drag. This is upstream evidence, not acceptance of Kumi tools.

Kumi's `scripts/vendor-willington.py` imports only a successful Bundle run from a
push to Willington main and verifies artifact/bundle digests and runtime inventory.
Keep that provenance chain and the maintainer's owner-PR gate intact. Do not copy
candidate binaries into the release vendor tree or advertise released capabilities.
Runtime hooks belong in a separate full-review PR after the carrying release is
vendored, with exact-library self-test receipts, real-Live evidence and a bridge
version bump. This documentation PR adds no runtime hooks or preview/apply/history tools.
