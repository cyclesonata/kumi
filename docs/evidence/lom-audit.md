# What Live's scripting API offers, and what the bridge covers

A census of the Live Object Model inside real Live, so that "Kumi can't do that" means
Live's API can't, never that the bridge didn't get round to it.

> Taken once, on Live 12.4.15b5 (macOS arm64) with bridge 1.0.55, 2026-09-30, and not updated
> since. Every operation in the first table below is still in the bridge's registry. The
> [capability matrix](../en/CAPABILITY_MATRIX.md) draws on it.

## How it was taken

The Remote Script's `dev.lom-audit` operation (developers only; no Kumi tool offers it)
walks Live's own Python module from `Live`: every submodule, every class, and every
member's name, kind (method, property, nested class) and docstring. It ran on
**Live 12.4.15b5, macOS arm64, 2026-09-30**, through the bridge 1.0.55 host adapter, in
177 ms. The members, without docstrings, are in
[`lom-audit-12.4.15b5.json`](lom-audit-12.4.15b5.json), so a later Live can be diffed
against it.

- 134 classes in 44 submodules: 1043 members once listener plumbing
  (`add_…_listener`, `remove_…_listener`, `…_has_listener`), enums, vectors and the
  licensing and MIDI-map internals are set aside. 3455 members in all.
- **789 of the 1043 were already used by the Remote Script. 254 weren't.**

## The 254, sorted

**Made into operations** (registry batch of 2026-09-30):

| Live API | Operation |
| --- | --- |
| `Song.begin_undo_step`, `end_undo_step`, `redo` | `undo.step.begin`, `undo.step.end`, `song.redo` (with `song.undo`) |
| `Song.get_data`/`set_data`, `Track.get_data`/`set_data` | `data.get`, `data.set`: data saved inside the Set |
| `Song.jump_by` | `transport.action` `jump-by` |
| `Song.select_on_launch` | `song.set` `selectOnLaunch` |
| `Track.duplicate_device`, `Chain.duplicate_device` | `device.duplicate` (the LOM can copy a device after all; so can the Extensions SDK) |
| `Track.jump_in_running_session_clip` | `track.action` |
| `Track.is_showing_chains` | `track.view.set` `showChains` |
| `Clip.select_all_notes`, `deselect_all_notes`, `select_notes_by_id` | `note.select` |
| `Clip.remove_notes_extended` | `note.delete-range` |
| `Clip.set_fire_button_state`, `ClipSlot.…`, `Scene.…` | `fire-button.set` (gate and trigger launches, as a player would) |
| `Clip.View.select_envelope_parameter` | `clip.view.set` `envelopeParameterRef` |
| `Envelope.insert_step`, `value_at_time` | `automation.step.insert`, `automation.value-at` |
| `DeviceParameter.begin_gesture`/`end_gesture` | `device.parameter.set` `gesture` (records as automation while Live records) |
| `DriftDevice.mod_matrix_*` | `drift.set` mod matrix sources and targets |
| `RoarDevice`, `ShifterDevice`, `SpectralResonatorDevice`, `HybridReverbDevice.ir_time_shaping_on`, `CcControlDevice` custom targets, `SimplerDevice` playback mode, retrigger, slicing playback, voices, pad slicing, pitch bend range | `device.property.set` |
| `CcControlDevice.resend`, `SimplerDevice.warp_as`, `warp_double`, `warp_half` | `device.action` |
| `LooperDevice.double_length`, `half_length` | `looper.action` |
| `RackDevice.recall_last_used_variation` | `rack.action` |
| `Sample` warp-mode settings (Beats, Complex Pro, Texture, Tones), slicing style, division, count, sensitivity | `sample.set` |
| `Sample.insert_slice`, `move_slice`, `remove_slice`, `clear_slices`, `reset_slices` | `sample.slice` |
| `WavetableDevice` oscillator wavetables, effect modes, filter routing, unison | `wavetable.set` |
| `WavetableDevice.get/set_modulation_value`, `add_parameter_to_modulation_matrix` | `wavetable.modulation.set`: the one way Live's API routes a modulator to a parameter |
| `PluginDevice.get_parameter_names` | `plugin.parameter-names`: every parameter a plug-in has, configured or not |
| `MaxDevice.get_bank_count`/`get_bank_name`/`get_bank_parameters` | `device.banks.read` |
| `Clip.beat_to_sample_time`, `sample_to_beat_time`, `seconds_to_sample_time` | `clip.time-convert` |
| `Application.show_message`, `show_on_the_fly_message` | `application.message` |
| `Browser.preview_item`/`stop_preview` | `browser.preview.start`/`stop` (reserved until now) |

**Read as fields of existing rows** (cheap reads, no operation of their own):
`Song.last_event_time`, `session_record_status`, `can_jump_to_next_cue`/`prev_cue`,
`is_cue_point_selected`, `get_current_beats_song_time` (in `song.read`);
`TuningSystem` reference pitch and pseudo-octave (in `tuning.read`);
`Device.class_display_name`; `Clip.gain_display_string`, `is_overdubbing`, `sample_rate`,
`has_envelopes`, `automation_envelopes`; Simpler's modes, voices and slices; Wavetable's
settings and modulation targets; `RackDevice.has_macro_mappings`/`macros_mapped`/
`is_showing_chains`; `Track.can_be_frozen`/`is_grouped`/`is_part_of_selection`;
`Song.View.mod_mapping_device`/`mod_mapping_parameter`; `Application` version string,
variant and unavailable features.

**Left out, as trivia or not Kumi's business:** `Application.get_document` (the Remote
Script has the Song already), `has_option` (Options.txt), `number_of_push_apps_running`,
`control_surfaces`; `Browser.colors`, `filter_type`, `relation_to_hotswap_target`,
`BrowserItem.iter_children` (the bridge walks `children`); `Clip.replace_selected_notes`
and `remove_notes` (older forms of note edits the bridge does by id);
`Song.sync_parameter_changes` (used internally), `find_device_position` (the bridge places
devices itself); `Track.input_routings`/`output_routings` (the bridge reads the
`available_*_routing_*` forms); `RoutingChannel.layout`, `RoutingType.attached_object`;
`MaxDevice.get_value_item_icons`; `SimplerDevice.View` sample positions in samples (the
bridge reads Simpler's markers as parameters).

Still impossible through either API, and said so plainly: saving the Set, export, freeze,
creating group tracks, mapping a macro or an arbitrary modulator to a parameter (outside
Wavetable's matrix and Drift's), and editing Arrangement automation lanes.

Two notes on that list: the optional [Willington](../en/WILLINGTON_INTEGRATION.md) provider maps
macros natively, on one exact Live build, outside Live's API. And `live_run_python` (`run_python`
in Kumi) runs Python inside Live with this same API, so it reaches every member counted here but
nothing beyond it.
