# Optional Willington integration

English · [简体中文](../zh-CN/WILLINGTON_INTEGRATION.md) · [日本語](../ja/WILLINGTON_INTEGRATION.md)

Willington is a separately installed set of native providers that reach parts
of Live its Python API doesn't: Session clip Follow Actions, rack macro
mappings and names, and rack chain zones. Each provider is built for one exact
Live build on macOS ARM64 and is experimental. Ordinary Kumi and the bridge
need none of it: without it, these tools simply don't appear.

## What it adds

| Kumi tool | Bridge tools | Edit kinds | Provider |
| --- | --- | --- | --- |
| `set_clip_follow_actions` | `live_follow_actions_preview/apply` | All ten Follow Action fields of a Session clip | WillingtonBindings |
| `edit_rack_mapping` | `live_willington_device_preview/apply` | `macro-name`, `variation-name`, `macro-mapping` | WillingtonDeviceTools |
| `edit_rack_mapping` | `live_willington_device_preview/apply` | `selector-zone`, `key-zone`, `velocity-zone` | WillingtonRackZones |

The bridge offers only the edit kinds whose provider is installed with writes
enabled: `live_willington_device_preview` lists just those `kind` values. Every
edit needs the transport stopped.

Some rack improvements need no Willington: racks read with Live's own macro
layout, recalling or deleting a variation by index, and the fallback to the
stock modulator devices when Live's Browser has no Modulators category. They
work with any bridge.

## Install and enable

1. Install the providers you want into Live's Remote Scripts folder, beside
   AbletonMcpBridge: `WillingtonBindings` (Follow Actions),
   `WillingtonDeviceTools` (macros and variations; it must provide
   `get_macro_mapping` and `get_selected_variation_name`) and
   `WillingtonRackZones` (zones). Each checks that it runs in the exact Live
   build it was made for, and refuses to install on any other.
2. Turn off any standalone Willington control surface in Live and restart Live.
   The bridge won't share the providers with another owner.
3. Create `willington.json` beside the bridge's `__init__.py`, in
   `Remote Scripts/AbletonMcpBridge`. It must be a regular file, owner-only and
   at most 4 KiB, with exactly these keys:

   ```json
   {"version": 1, "followActions": true, "deviceTools": true, "rackZones": true, "enableWrites": false}
   ```

   | Key | Meaning |
   | --- | --- |
   | `version` | Always `1` |
   | `followActions` | Load WillingtonBindings |
   | `deviceTools` | Load WillingtonDeviceTools |
   | `rackZones` | Optional; load WillingtonRackZones |
   | `enableWrites` | Allow edits; `false` loads the providers without offering edits |

4. For Follow Action edits, WillingtonBindings also needs a passing self-test:
   `self-test.json` in its folder with `"status": "passed"` and
   `library_sha256` equal to the SHA-256 of its `libwillington.dylib`. Without
   it, Follow Action edits stay off and the other providers still work.
5. Restart Live. Config changes take effect only at Live's start.

Kumi updates keep `willington.json`. Delete it to go back to the plain bridge.

None of the providers is used, and the bridge carries on without them, when the
file is missing a key or has an unknown one, any provider it names fails to
load, another owner already holds them, or a standalone Follow Action, device
or zone surface is already installed. Live's log (Log.txt) says which: "Willington extensions
initialized; writes enabled", "Willington extensions unavailable: …; ordinary
bridge remains active" or "Willington Follow Action writes unavailable: …".

When the Remote Script stops, it turns Follow Action writes off and uninstalls
DeviceTools and RackZones. Follow Action bindings can't be uninstalled: they
stay registered in that Live process, and the bridge reuses them, writes off,
when it starts again.

## Follow Actions

`live_follow_actions_preview/apply` sets all ten fields of one Session clip:
enabled, linked, actions A and B, chances A and B, loop count, time, and jump
targets A and B.

- Actions are numbers: 0 none, 1 stop, 2 again, 3 previous, 4 next, 5 first,
  6 last, 7 any, 8 other, 9 jump. Jump targets are 1-based scene numbers.
- The two chances add up to 100; give one and the other is set to the rest.
- Linked timing uses the loop count; unlinked timing uses `time` in beats.
- The transport must be stopped and the clip not recording.
- It doesn't change scene Follow Actions or Live's global Follow Action switch.
  For launch Legato, use the clip settings tool (`set_clip` in Kumi).

The preview captures all ten fields. If a write fails partway, the earlier
fields go back. Undo restores the captured fields, and is refused if the clip
changed since.

## Macros, variations and mappings

`live_willington_device_preview/apply` with `ref` naming a rack:

| Kind | Arguments | Notes |
| --- | --- | --- |
| `macro-name` | `macroIndex` (0–15), `name` | Renames a macro |
| `variation-name` | `name` | Renames the selected variation; a named variation must be selected |
| `macro-mapping` | `targetRef`, `mappingIndex` (0–15, or `null` to unmap), `minimum`, `maximum`, `mappingKind` | Maps a parameter inside this rack to a macro |

Mapping kinds:

- `continuous` and `enum`: `minimum` and `maximum` in the parameter's own units,
  within its range; the range may be inverted. `enum` endpoints are whole
  numbers.
- `boolean`: integer macro thresholds from 0 to 127, `minimum` ≤ `maximum`.

`targetRef` must come from fresh discovery and lie inside this rack, its nested
devices or its chains' mixers. A transaction captures the names, or the
mapping, the parameter's value and the macro values, with the identities
involved. Live sets a mapped parameter's value a tick later, so a mapping is
fenced on the mapping and the macro values, not that value. Every write is read
back and, if it doesn't match, put back exactly. Undo restores the captured
state and is refused if the rack changed since. It's the transaction's own
undo, not Live's.

## Rack chain zones

`live_willington_device_preview/apply` with `ref` naming a rack and `targetRef`
one of its regular chains:

| Rack | Zones |
| --- | --- |
| Audio Effect Rack | `selector-zone` |
| Instrument Rack, MIDI Effect Rack | `selector-zone`, `key-zone`, `velocity-zone` |

Drum Racks and return chains are refused. A zone has four integer endpoints,
`minimum`, `fadeMinimum`, `fadeMaximum` and `maximum`, which must stay in order
(`minimum` ≤ `fadeMinimum` ≤ `fadeMaximum` ≤ `maximum`) within 0–127 (1–127
for velocity). An endpoint you leave out keeps its current value, so moving a
range may mean giving both fade endpoints too.

The preview captures all four endpoints. Apply and undo fence the rack and the
chain by identity and the whole zone state; a write that doesn't read back as
asked is put back exactly.

## Evidence

| Provider | Run | Live | Bridge | Covers |
| --- | --- | --- | --- | --- |
| Follow Actions | [kumi-clip-follow-actions-b5.json](../evidence/kumi-clip-follow-actions-b5.json), 2026-09-30 | 12.4.15b5, macOS arm64 | 1.0.53 | Kumi changes and undo on a saved test Set, transport stopped |
| Follow Actions, macros, mapping | [willington-kumi-chat.json](../evidence/willington-kumi-chat.json), 2026-09-30 | 12.4.15b4 ARM64 | 1.0.52 | A real Kumi chat: Follow Actions, macro rename, mapping, each undone |
| Rack zones | [rack-zones-b5.json](../evidence/rack-zones-b5.json), 2026-10-01 | 12.4.15b5 (2026-09-24 build), arm64 | 1.0.66 | Readback, write, undo and redo, Sets saved and reopened, the installed bridge and Kumi's undo |

Variation rename and the inverted continuous and enum mappings were tested
through the bridge directly. None of these runs covers playback: Follow Action
scheduling, how a zone sounds, or selector changes while playing. Follow Action
and macro edits weren't tested across saving and reopening a Set. Rack zones
aren't supported on 12.4.15b4 or any other build.

The bridge's automated tests cover the rest without Live: missing providers,
malformed config, stale and conflicting edits, partial writes, ownership and
reconnects, and lost replies.

## Deliberately unavailable

Willington has native methods for these, but Kumi doesn't offer them until
they can be undone safely:

- **Overwriting a variation**: needs reading and restoring the full stored macro
  values and enabled mask, not just the variation's name.
- **Replacing a Drum Sampler's sample directly**: needs the current sample's
  identity and path, and restoring what replacing it changes. Loading presets
  and samples through the Browser works.
- **Mapping a modulator**: the native change settles later, out of step with
  Live's thread. It needs settled-state checks, exact ownership of source and
  target, cancellation and restoration first.

A native method existing isn't enough for an undoable operation: don't offer
one by adding only a runtime descriptor or a protocol entry.
