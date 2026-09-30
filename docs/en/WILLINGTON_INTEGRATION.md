# Optional Willington integration

This is an experimental, separately installed native provider for the exact Live build supported by Willington. Ordinary Kumi needs no native library or extension configuration. The default unavailable adapter and default simulator do not advertise these operations.

## Development alignment

Implemented against Kumi main `8bac909`. Reviewed DEVELOPMENT.md, DEVELOPER_GUIDE.md, LIVE_SAFETY.md, the API coverage issue #36, macro parameter issue #83 and partial-write recovery issue #90. Rechecked open installer PR [#104](https://github.com/user1303836/kumi/pull/104) at `9676710`; it does not implement these features. Its installer/runtime work remains separate. No open issues were returned at the final review. No PR or issue was posted.

The canonical protocol registry defines the extension operations; regenerate the capability manifest with `node apps/mcp-server/scripts/generate-capability-manifest.mjs`. Package the bridge and host from the same revision because they negotiate the registry hash.

## Implemented

- Modulators browser fallback: when the native category is empty or missing, use the stock device BrowserItems under Audio/MIDI Effects. Native nonempty results remain authoritative. Search and URI lookup use the same fallback.
- Rack discovery uses `macros_mapped` and the native rack parameter layout. Indexed recall/delete selects and invokes within one main-thread operation.
- `set_clip_follow_actions` / `live_follow_actions_preview` and `live_follow_actions_apply`: Session clips only, all ten fields captured, coupled chances normalized, strict identity/state checks, stopped playback, compensation on partial writes, explicit history undo and exact-key recovery.
- `edit_rack_mapping` / `live_willington_device_preview` and `live_willington_device_apply`: macro rename, selected variation rename, map/unmap and continuous/enum/boolean mapping ranges. Indices are zero-based. Continuous/enum endpoints use parameter units and may be inverted. Boolean endpoints are ordered integer on-interval thresholds from 0 to 127.

Rack transactions capture names or mapping/index/range, identities, macro values and unmapped parameter values. A mapped parameter's value settles on a later Live tick, so its state revision fences the mapping and driving macro values rather than the transient derived value. Undo refuses external edits and restores the captured state. It does not invoke global Live Undo.

## Local enablement

Install WillingtonBindings and WillingtonDeviceTools separately. DeviceTools must provide `get_macro_mapping` and `get_selected_variation_name`. Native packages check executable SHA and running Mach-O UUID; this work was tested on macOS ARM64 Live 12.4.15b4 only.

Disable standalone Willington control surfaces and restart Live before letting Kumi own the provider. Place an owner-only regular `willington.json` beside the installed AbletonMcpBridge entrypoint:

```json
{"version":1,"followActions":true,"deviceTools":true,"enableWrites":false}
```

Explicitly set `enableWrites` to true only for the supported installation. Follow Action writes also require a passing self-test receipt matching the installed library SHA. Unknown/malformed configuration, unsupported libraries, or another active owner leave the extension unavailable and ordinary bridge service active. Config changes require restarting Live. Remove the file to return to the standard bridge. Native libraries, local configuration and private fixtures are not bundled in Kumi's package.

## Evidence and limits

Automated tests cover negotiation absence, malformed fields, detached targets, stale apply, external changes before undo, partial-write compensation, provider ownership/teardown and lost Follow Action apply/undo acknowledgements. Simulator evidence is separate from real-Live evidence.

Real Live tests used a disposable saved fixture through the authenticated bridge and McpHost: Follow Action preview/apply/readback/history undo; macro rename; continuous inverted, enum inverted and boolean mappings; variation rename with Unicode text. Each edit was undone, and the owned Follow Action test clip was removed. These are stopped-playback tests, not evidence of save/reload persistence or musical Follow Action scheduling.

The following remain deliberately unavailable through Kumi:

- Variation overwrite: requires full stored macro contents and enabled-mask readback/restoration, not just the variation name.
- Direct Drum Sampler sample replacement: requires authoritative current sample identity/path and restoration of replacement-related state. Existing preset/browser workflows remain available.
- Modulator mapping: native patch processing is asynchronous. Kumi still needs bounded settled-state verification, exact target/source ownership capture, cancellation and restoration before this can become a history transaction.

These native methods existing in Willington is not sufficient evidence of an undoable Kumi operation. Do not advertise them by adding only a runtime descriptor or protocol entry.

## Kumi chat acceptance

The actual Kumi CLI (plain chat with the configured model) was exercised against
the disposable Live fixture. Macro rename, Follow Actions, chain pan mapping and
Modulators-category searches passed; each mutation was undone using `/undo`,
including the owned test clip. Independent bridge readback verified the results.
See [chat trial evidence](../evidence/willington-kumi-chat.json).

This trial found and fixed a discovery gap: `parameter` now accepts a current
chain parent and returns its mixer parameters with ranges and identities. Mapping
`targetRef` must come from discovery in the current turn. Rack history titles now
name the action in ordinary language. Full-screen TUI behavior, playback and
save/reload persistence were not exercised by this chat trial.
