# Willington native editing candidate

[Willington PR #11](https://github.com/xonedsp/willington/pull/11) implements
group creation, Arrangement automation editing, scene/global Follow Actions,
and per-note MPE for **Live 12.4.15b5 macOS ARM64**. It is an exact-build
development candidate, not part of Kumi's bundled Willington release.
`/willington` does not install or enable this candidate. The bridge now has an
optional provider lifecycle for future validated native-editing releases; the
current candidate still requires explicit standalone installation. No other
Live build or Windows support is implied.

The native methods can be called through `run_python` (`live_run_python` at the
host boundary) when the full policy permits Python and the candidate has been
separately installed and explicitly enabled in Live. Follow the upstream
[build and installation instructions](https://github.com/xonedsp/willington/blob/feat/native-editing/integrations/WillingtonEditing/README.md)
in a stopped disposable Set. An absent method or exact-build refusal means the
candidate is unavailable; do not infer availability from the `/willington` switch.

Python calls do **not** create Kumi `HISTORY` entries. The native methods have
their own Live undo boundaries, so a Python script containing several native
edits can produce several undo steps. The global Follow Action switch has no
Live undo entry at all. Do not use a blind `song.undo()` as rollback for a failed
script or as a substitute for an exact inverse.

## Calling the bindings

`run_python` supplies `song` and, when passed a current object `ref`, `obj`.
Discover references again after reconnecting. These examples describe individual
operations; each mutation needs stopped playback and enabled native writes.
Do not use object indexes copied from a different Set.

### Group creation

Resolve the intended tracks first, then call `song.group_tracks(*tracks)`.
It returns the new group, independent of UI selection. The input must be 1–128
distinct contiguous top-level audio/MIDI tracks in Song order. Existing groups,
nested groups, master/return tracks and foreign tracks are rejected.

`song.ungroup_track(group)` removes a top-level group with audio/MIDI members,
no devices and no nested groups. It is useful for immediate fixture restoration,
but is not a general Kumi history inverse: subsequent edits to the group, its
routing, automation or membership must not be discarded. A dedicated creation
transaction would need to capture and fence those changes before allowing undo.

### Scene and global Follow Actions

For a scene reference:

```python
import json
before = json.loads(obj.get_follow_actions())
obj.set_follow_action('loop_count', 2)
result = json.loads(obj.get_follow_actions())
```

Fields are `enabled`, `action_a`, `action_b`, `chance_a`, `chance_b`, `jump_a`,
`jump_b`, `time`, `linked`, `loop_count`. Chances are coupled and sum to 100.
Jumps use one-based scene numbers, with 0 meaning unset. Time uses quarter-note
beats; linked mode uses the longest clip and `loop_count`.

Read the global switch with `song.get_follow_actions_enabled()`, then set it
with `song.set_follow_actions_enabled(True)` or `False`. Retain its previous
boolean for explicit restoration. Reread after setters: the candidate exposes
no scene/global observer API. Native fixture scheduling was verified with UI
launches; `Scene.fire()` did not reproduce the UI scheduler in that experiment.

### Per-note MPE

For a MIDI clip reference, use a stable note ID from a fresh note read:

```python
import json
before = obj.get_note_expression(note_id, 'pressure')
obj.replace_note_expression(note_id, 'pressure', json.dumps({
    'exists': True,
    'events': [[0, 64, 0.5, 0.5, 0.5, 0.5]],
}))
result = json.loads(obj.get_note_expression(note_id, 'pressure'))
```

Each event is `[time, value, x1, y1, x2, y2]`. Time is beats from the note's
start; pitch uses cents (±4800), pressure and slide use 0–127 MIDI units.
Absent and explicitly empty lanes differ. Preserve `exists` and every curve
coefficient when restoring with `replace_note_expression(note_id, dimension,
before)`. Confirm the same clip and note still exist first. Candidate limits
include 65536 events, at most two coincident events, and curve coefficients 0–1.

### Arrangement automation

Resolve a track and a continuous parameter owned by that track. Quantized and
cross-track parameters are rejected. Read an interval with
`track.get_arrangement_automation(parameter, start, end)`; insert with
`track.insert_arrangement_event(parameter, json.dumps(event))`; delete a range
with `track.delete_arrangement_events(parameter, start, end)`. Event times are
absolute Song beats and values use the parameter's public units.

Before mutation, capture `before = track.get_arrangement_snapshot(parameter)`.
For immediate restoration use
`track.restore_arrangement_snapshot(parameter, before)`. Treat the entire JSON
string as opaque. Interval reads omit hidden initial/out-of-range events and
cannot serve as complete undo snapshots. Complete snapshots preserve native
values, curves, coincident events and envelope absence.

Snapshots are signed and bound to the originating parameter and adapter
instance. Reinstalling the adapter or restarting Live invalidates them, even
if the Set was saved and reopened. Do not persist them as durable Kumi history,
rewrite their event values, or fall back to Live undo after a signature refusal.
Pending automation transforms are refused. UI selection and event-object
identity are not part of the snapshot contract.

## Evidence and release boundary

The bridge accepts optional boolean `editing` in its existing owner-only
`willington.json` configuration. When true, it calls `WillingtonEditing.api.install()`
with no caller-supplied path. Default resolution accepts only validated exact-build
profiles. The current candidate therefore returns a typed unavailability error;
an older bundle with no editing package also leaves other providers running.
Integrity failures and missing dependencies inside the component fail closed.
`enableWrites` controls activation, and disconnect/disable uninstalls owned patches.
A separately installed editing surface is never silently taken over.

The status field `nativeEditingKinds` lists the available native Python families
only after successful provider installation and write enablement; otherwise it
is empty. It is separate from `willingtonKinds`, which continues to describe the
existing device preview/apply operations. It does not advertise new transactions
or history support. `/willington` keeps its existing config format for compatibility
with older installed bridges; developer opt-in to `editing` must be made in a
bridge version that supports the field.

The upstream [fixture evidence](https://github.com/xonedsp/willington/blob/feat/native-editing/evidence/native-editing/b5/README.md)
covers native readback, undo/redo, save/reopen, actual Max calls, MPE playback
and note notifications, Arrangement playback, group routing, and UI-launched
scene scheduling. The pending-transform refusal was exercised through the
native flag controller, not an active UI drag. This is upstream fixture
coverage, not acceptance of new Kumi preview/apply/history tools.

Kumi's `scripts/vendor-willington.py` accepts only a successful Bundle run from
a push to Willington main, verifies the artifact and bundle digests, and checks
the runtime inventory. Keep that provenance chain intact. Candidate libraries
must not be copied into the release vendor tree or advertised by the existing
device-editing capabilities. Release import, automatic switch integration and
dedicated revision-fenced transactions remain subsequent integration work.
