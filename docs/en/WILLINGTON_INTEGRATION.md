# Optional Willington integration

Willington is an optional, separately installed native provider selected for the exact connected Live build. Rack Zones is validated for Live 12.4.15b5 on macOS ARM64. Ordinary Kumi needs no native library or extension configuration. The default unavailable adapter and default simulator do not advertise these operations.

## Implemented

- Modulators browser fallback: when the native category is empty or missing, use the stock device BrowserItems under Audio/MIDI Effects. Native nonempty results remain authoritative. Search and URI lookup use the same fallback.
- Rack discovery uses `macros_mapped` and the native rack parameter layout. Indexed recall/delete selects and invokes within one main-thread operation.
- `set_clip_follow_actions` / `live_follow_actions_preview` and `live_follow_actions_apply`: Session clips only, all ten fields captured, coupled chances normalized, strict identity/state checks, stopped playback, compensation on partial writes, explicit history undo and exact-key recovery.
- `edit_rack_mapping` / `live_willington_device_preview` and `live_willington_device_apply`: macro rename, selected variation rename, map/unmap and continuous/enum/boolean mapping ranges. Indices are zero-based. Continuous/enum endpoints use parameter units and may be inverted. Boolean endpoints are ordered integer on-interval thresholds from 0 to 127.

Rack transactions capture names or mapping/index/range, identities, macro values and unmapped parameter values. A mapped parameter's value settles on a later Live tick, so its state revision fences the mapping and driving macro values rather than the transient derived value. Undo refuses external edits and restores the captured state. It does not invoke global Live Undo.

## Local enablement

Install the multi-version bundle with `WillingtonRuntime`, `WillingtonBindings` and `WillingtonDeviceTools` as sibling folders in your User Library’s `Remote Scripts` directory. Include `WillingtonRackZones` to enable rack zones. Manual installations must include `WillingtonRuntime` and preserve the bundle’s `build/<profile-id>/` directories and manifests. DeviceTools must provide `get_macro_mapping` and `get_selected_variation_name`. Native packages check executable SHA and running Mach-O UUID; retained real-Live evidence covers macOS ARM64 Live 12.4.15b4 and a matching b5 profile (see [b5 runtime transaction evidence](../evidence/kumi-clip-follow-actions-b5.json)).

Disable standalone Willington control surfaces and restart Live before letting Kumi own the provider. Place an owner-only regular `willington.json` beside the installed AbletonMcpBridge entrypoint. Kumi updates preserve this file and its permissions:

```json
{"version":1,"followActions":true,"deviceTools":true,"enableWrites":false}
```

Explicitly set `enableWrites` to true only for the supported installation. Follow Action writes also require a passing self-test receipt matching the installed library SHA. A missing validated profile skips only that component; the same configuration can enable Follow Actions and DeviceTools on b4 and also Rack Zones on b5. Typed no-profile refusals are remembered and logged once per component per Live process. Unknown/malformed configuration, missing artifacts, integrity failures, unexpected startup failures or another active owner leave the native extensions unavailable and ordinary bridge service active. Initialization logs report the cause, active components and components with writes enabled. A missing or stale Follow Action self-test disables Follow writes while independent DeviceTools and RackZones remain available. Disconnect disables Follow writes and uninstalls DeviceTools and RackZones. Follow bindings have no uninstall API: their native code and Clip properties remain registered for the Live process, and Kumi reuses the disabled registration on reconnect. A fresh matching self-test receipt is still required when enabling writes. Config changes require restarting Live. Remove the file to return to the standard bridge. Native libraries, local configuration and private fixtures are not bundled in Kumi's package.

To opt into zones, add `"rackZones": true` to the configuration above. Supported
kinds are selector zones on Audio Effect Racks and selector, key and velocity zones
on Instrument and MIDI Effect Racks, targeting regular chains. Writes require
stopped playback and `enableWrites: true`; preview/apply/history undo fence the
complete zone state and rack/chain identity.

## Follow Action self-test

Repeat after switching Live builds or replacing the selected Follow library. This
procedure works with the distributed bundle; no source checkout or `manage.py`
is needed. The standalone test creates a fixture track and performs native writes
and Live Undo in the current Set, so use a disposable Set.

1. Disable `AbletonMcpBridge` and standalone Willington surfaces in Live’s Control
   Surface settings, then quit Live. Native Follow properties remain registered
   until the process exits.
2. Start the intended Live build, open a disposable Set with playback stopped,
   and select only `WillingtonBindings` as the Willington Control Surface, with
   MIDI input/output None. Its installed `status.json` should report
   `"status": "registered"`.
3. Queue the test with this command, replacing the folder argument with the
   installed Bindings directory. It refuses pending commands and removes the
   old receipt so it cannot be mistaken for this run.

   ```sh
   python3 - '/path/to/User Library/Remote Scripts/WillingtonBindings' <<'PYTEST'
   import json, os, sys
   from pathlib import Path
   folder = Path(sys.argv[1]).expanduser()
   assert (folder / '__init__.py').is_file(), 'Not an installed Bindings folder'
   command = folder / 'command.json'
   assert not command.exists(), 'A command is already pending'
   (folder / 'self-test.json').unlink(missing_ok=True)
   temporary = folder / 'command.json.tmp'
   temporary.write_text(json.dumps({'action': 'self_test'}) + '\n')
   os.replace(temporary, command)
   PYTEST
   ```

4. Wait for the new `self-test.json` to finish with `"status": "passed"` and a
   `library_sha256`. A running or failed report does not enable writes. Inspect
   `command-error.json` if the command fails. The hash must match the selected
   `build/<profile-id>/libwillington.dylib` (or root library for a legacy install);
   `shasum -a 256 '/full/path/to/libwillington.dylib'` prints that digest. Keep
   the receipt in the installed Bindings folder.
5. Set the standalone `WillingtonBindings` Control Surface to None, quit Live,
   and restart before enabling `AbletonMcpBridge` again. Discard the disposable
   Set. Do not select standalone Willington surfaces alongside Kumi: both would
   attempt to own native bindings. Kumi rechecks the receipt against its selected
   library before enabling Follow writes with `enableWrites: true`.

## Evidence and limits

Automated tests cover negotiation absence, malformed fields, detached targets, stale apply, external changes before undo, partial-write compensation, provider ownership/reconnect, deployment-policy changes before undo, failures before undo dispatch, float32 timing/mapping readback, canonical macro references, URI-fenced Browser lookup and lost apply/undo acknowledgements. Rack state reads are scoped to the rack; ordinary snapshots do not read native Follow fields; Follow tools request them only for their exact Session clip. The advertised rack edit kinds reflect the enabled DeviceTools and RackZones providers. Simulator evidence is separate from real-Live evidence.

Real Live tests used a disposable saved fixture through the authenticated bridge and McpHost: Follow Action preview/apply/readback/history undo; macro rename; continuous inverted, enum inverted and boolean mappings; variation rename with Unicode text. Each edit was undone, and the owned Follow Action test clip was removed. These are stopped-playback tests, not evidence of save/reload persistence or musical Follow Action scheduling.

Rack Zones completion results and receipt digests are in the [public validation
summary](../evidence/rack-zones-b5.json): 42 signal-gating checks, 49 fade
measurements with 14 directional comparisons, and seven actual Max `live.object`
write/read/restore cycles. Measurements use normalized Live meters; exact linear
gain, silence at fade endpoints, held-note edits, overlapping multi-chain
crossfades and other builds/platforms are not claimed. Earlier Kumi transaction
and save/reopen evidence remains in that summary. The raw completion receipts
and harness are retained in the private Willington repository at the immutable
commit recorded in the summary; public readers do not need that repository to
read the results, but cannot independently inspect those raw receipts here.

The following remain deliberately unavailable through Kumi:

- Variation overwrite: requires full stored macro contents and enabled-mask readback/restoration, not just the variation name.
- Direct Drum Sampler sample replacement: requires authoritative current sample identity/path and restoration of replacement-related state. Existing preset/browser workflows remain available.
- Modulator mapping: native patch processing is asynchronous. Kumi still needs bounded settled-state verification, exact target/source ownership capture, cancellation and restoration before this can become a history transaction.

These native methods existing in Willington is not sufficient evidence of an undoable Kumi operation. Do not advertise them by adding only a runtime descriptor or protocol entry.
