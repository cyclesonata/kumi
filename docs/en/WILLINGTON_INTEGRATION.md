# Optional Willington integration

This is an experimental, separately installed native provider for the exact Live build supported by Willington. Ordinary Kumi needs no native library or extension configuration. The default unavailable adapter and default simulator do not advertise these operations.

## Implemented

- Modulators browser fallback: when the native category is empty or missing, use the stock device BrowserItems under Audio/MIDI Effects. Native nonempty results remain authoritative. Search and URI lookup use the same fallback.
- Rack discovery uses `macros_mapped` and the native rack parameter layout. Indexed recall/delete selects and invokes within one main-thread operation.
- `set_clip_follow_actions` / `live_follow_actions_preview` and `live_follow_actions_apply`: Session clips only, all ten fields captured, coupled chances normalized, strict identity/state checks, stopped playback, compensation on partial writes, explicit history undo and exact-key recovery.
- `edit_rack_mapping` / `live_willington_device_preview` and `live_willington_device_apply`: macro rename, selected variation rename, map/unmap and continuous/enum/boolean mapping ranges. Indices are zero-based. Continuous/enum endpoints use parameter units and may be inverted. Boolean endpoints are ordered integer on-interval thresholds from 0 to 127.

Rack transactions capture names or mapping/index/range, identities, macro values and unmapped parameter values. A mapped parameter's value settles on a later Live tick, so its state revision fences the mapping and driving macro values rather than the transient derived value. Undo refuses external edits and restores the captured state. It does not invoke global Live Undo.

## Local enablement

Install WillingtonBindings and WillingtonDeviceTools separately. DeviceTools must provide `get_macro_mapping` and `get_selected_variation_name`. Native packages check executable SHA and running Mach-O UUID; retained real-Live evidence covers macOS ARM64 Live 12.4.15b4 and a matching b5 profile (see [b5 runtime transaction evidence](../evidence/kumi-clip-follow-actions-b5.json)).

Disable standalone Willington control surfaces and restart Live before letting Kumi own the provider. Place an owner-only regular `willington.json` beside the installed AbletonMcpBridge entrypoint. Kumi updates preserve this file and its permissions:

```json
{"version":1,"followActions":true,"deviceTools":true,"enableWrites":false}
```

Explicitly set `enableWrites` to true only for the supported installation. Follow Action writes also require a passing self-test receipt matching the installed library SHA. Unknown/malformed configuration, unsupported libraries, or another active owner leave the extension unavailable and ordinary bridge service active. Initialization logs include the cause. A missing or stale Follow Action self-test disables Follow writes while independent DeviceTools and RackZones remain available. Disconnect disables Follow writes and uninstalls DeviceTools. Follow bindings have no uninstall API: their native code and Clip properties remain registered for the Live process, and Kumi reuses the disabled registration on reconnect. A fresh matching self-test receipt is still required when enabling writes. Config changes require restarting Live. Remove the file to return to the standard bridge. Native libraries, local configuration and private fixtures are not bundled in Kumi's package.

## Evidence and limits

Automated tests cover negotiation absence, malformed fields, detached targets, stale apply, external changes before undo, partial-write compensation, provider ownership/reconnect, deployment-policy changes before undo, failures before undo dispatch, float32 timing/mapping readback, canonical macro references, URI-fenced Browser lookup and lost apply/undo acknowledgements. Rack state reads are scoped to the rack; ordinary snapshots do not read native Follow fields; Follow tools request them only for their exact Session clip. The advertised rack edit kinds reflect the enabled DeviceTools and RackZones providers. Simulator evidence is separate from real-Live evidence.

Real Live tests used a disposable saved fixture through the authenticated bridge and McpHost: Follow Action preview/apply/readback/history undo; macro rename; continuous inverted, enum inverted and boolean mappings; variation rename with Unicode text. Each edit was undone, and the owned Follow Action test clip was removed. These are stopped-playback tests, not evidence of save/reload persistence or musical Follow Action scheduling.

The following remain deliberately unavailable through Kumi:

- Variation overwrite: requires full stored macro contents and enabled-mask readback/restoration, not just the variation name.
- Direct Drum Sampler sample replacement: requires authoritative current sample identity/path and restoration of replacement-related state. Existing preset/browser workflows remain available.
- Modulator mapping: native patch processing is asynchronous. Kumi still needs bounded settled-state verification, exact target/source ownership capture, cancellation and restoration before this can become a history transaction.

These native methods existing in Willington is not sufficient evidence of an undoable Kumi operation. Do not advertise them by adding only a runtime descriptor or protocol entry.
