# Ableton Live safety

English · [简体中文](../zh-CN/LIVE_SAFETY.md) · [日本語](../ja/LIVE_SAFETY.md)

The safety contract every Live interaction is held to. Read this before
connecting the server to a real Set.

The default adapter is `UnavailableLiveAdapter`: disconnected, no Live I/O,
and not selectable by caller metadata, MCP arguments, simulator output, or the
mere presence of Live on disk. A production bridge requires an explicit
loopback configuration, an owner-only secret, matching protocol/registry, and
reported operation capability.

## Deployment trust boundary

The bridge is Kumi's own adapter to Live: local, loopback-only, owner-controlled,
with Kumi as its one client. It trusts the local OS account. Kumi's harness, not
the model, runs the bridge's previews and applies: the model asks for a change by
name, Kumi previews it, keeps the preview's confirmation to itself, applies it,
and records it in HISTORY with its undo. Undo and verification are the safety net
producers rely on; ceremony that only defended against a hostile MCP client has
gone where it cost Kumi speed (a change is one request; see below). Output-safety
evidence is optional: a client that gives none gets the bridge's own, so playing,
launching and recording never wait on it.

## Universal mutation boundary

Every mutation requires:

- fresh authenticated status and exact negotiated operations;
- authoritative epoch-scoped refs and state;
- bounded inputs and purpose-specific authority;
- a read-only preview where applicable;
- exact confirmation, expiry, and idempotency;
- an atomic Live-main-thread precondition recheck;
- fresh postcondition verification;
- transaction-owned compensation/undo/cleanup only;
- explicit **uncertain** state after timeout, lost acknowledgement, external
  edit, failed verification, or failed cleanup.

A client must never replace uncertain authority with a new preview or key. The
host may reconcile only the exact original transaction/key/arguments against
the Remote Script ledger in the same bridge and Live epoch, followed by fresh
postcondition verification. Unsupported attributes or enum values are
unavailable evidence, not safe defaults.

A change reaches Live as one request (`mutate`). After a preview, the host asks
the Remote Script for the state digest that change will be checked against
(`authority.digest`): the epoch, the Set's track and scene structure, the song
state, and the state of exactly what the change names (a track without its
clips and devices, a clip without its notes, a device's own row), plus playback
for playback-bound operations, locators for locator operations and the touched
tracks' Arrangement clips for Arrangement operations. The apply sends the
operation, its arguments, the transaction and idempotency keys and that digest.
On Live's main thread, in the same tick, the Remote Script recomputes the digest
and applies only if nothing changed since the preview; otherwise it refuses with
"Live state changed since the preview" and nothing has happened. A refusal before
anything ran always says so ("…; nothing changed"), so the host records it as
not dispatched rather than uncertain. On a retry with the same key, such a refusal
proves only that the retry didn't run: the first attempt may have, so the change
stays uncertain. An undo that fails its checks before sending anything to Live
leaves the change applied, and the next undo checks again. The bridge keeps a bounded executed-result
ledger across TCP reconnections, so a lost response is reconciled exactly by its
idempotency key instead of replayed. (The earlier three-step authority, a read-only `authority.preflight`, its
one-use confirmation through `authority.prepare`, then the invoke, is still
there for the tests that exercise it.)

Deletions are explicit. Deleting something no transaction of Kumi's made (a clip,
an Arrangement clip, a scene, a track, a locator, a device, a return) needs
`explicitDeletion: true` and exact identity fences for the object and where it
lives; HISTORY keeps the deletion, since only Live's own undo brings it back.
Undo of what a transaction made is the transaction's own, fenced to the object's
identity, not its content: it takes back the change however the object changed
since (a renamed track, a knob moved again), and refuses only when the reference
now holds another object.

A plan is also one step in Live's own undo: Kumi opens a step before the plan's
first change and closes it after its last. The Remote Script owns the open step
and closes it when its connection goes, when its time is up, on reconnect and on
shutdown, so Live is never left with an open step. Live's own undo and redo
(`song.undo`, `song.redo`) are offered only for what the producer did in Live,
never as Kumi's undo.

Reads are bounded by work, not size: a discovery page or a windowed snapshot
stops when a 30 ms budget on Live's thread is spent and says where to go on
(`truncated`, `nextCursor`), so no request holds Live's UI however big the Set.

Kumi's Live extension (Live 12.4's Extensions SDK) is a second channel. The bridge
reaches it on 127.0.0.1 with a secret the extension writes, owner-only, into its
data folder; every request is signed, registry-validated and refused past its
deadline. Its changes are verified and undone through the Remote Script where
Live allows (a written Arrangement clip is deleted, fenced to its content) and
kept otherwise. Live runs the extension with Node's permission model: it can
read and write only its own folders.

## Implemented mutation classes

Guarded workflows cover transport; clip launch and exact stop; MIDI clips and
notes; Arrangement clips and locators; mixer and routing; Session automation;
devices and Browser loading; Session/Arrangement recording; project backup;
realtime control; and consent-bound audio capture. Each has narrower checks in
its user/operations documentation.

- Session-structure creation returns exact object identities; compensation and
  undo recheck those identities and call Live's indexed deletion APIs rather
  than deleting a stale proxy or reused path.
- `live_undo` is transaction-specific and refuses a changed epoch or
  postcondition.
- Arbitrary device and Arrangement clip deletion is unavailable: cleanup
  requires the exact transaction-created object identity, hierarchy, and
  creation-time fingerprint, and refuses modified or substituted objects.
- Device insertion and Browser loading require an empty exact device owner, and
  cleanup requires the created device to remain its sole sibling, so an indexed
  deletion can never select an unrelated sibling.
- Moves never mint destructive cleanup authority: a pre-existing clip remains
  pre-existing after a move, source and destination content fingerprints are
  fenced, and recovery uses only the exact unchanged inverse-move transaction.
  Moving a transaction-created clip atomically consumes its prior cleanup
  token without minting deletion authority for the moved result.
- MIDI capture is advertised only while every Session slot is empty, so a
  partially failing Capture MIDI implementation cannot change pre-existing clip
  content without an exact restoration path.

Read-only operations include status, capability negotiation, snapshot,
discovery, previews, project inspection, subscription reads, realtime stats,
caller PCM analysis/reference comparison, and caller-declared Live-context
diagnosis. A read-only tool never starts playback or recording.

Semantic Set pages are constructed from explicit allowlists. They exclude Live
refs/object identities, epochs/revisions, confirmations, tokens, transactions,
idempotency, secrets, MACs, and recovery authority; no privacy profile emits an
absolute path. Snapshot IDs and pagination cursors are descriptive coordinates,
not cross-run identity or mutation authority. Offline diff uses only unique
semantic evidence, retains ambiguity and truncation limits, and always reports
`mergeProposed=false`. It never edits `.als` or treats opaque plug-in/Max state
as portable.

## Compound batches and device-state recall

Batch and device-state mutations are sequential, not all-or-nothing Live-wide
commits. Each step retains its exact dispatch arguments and acknowledged result.
A lost reply is reconciled against the execution ledger using the original
transaction/key/arguments, followed by fresh identity and postcondition checks;
matching values alone never establish execution or ownership. Apply, compensation,
and undo have separate retained checkpoints. An uncertain compensation resumes
compensation, never forward application. A reply followed by a failed readback
remains uncertain and does not authorize a second write with refreshed revisions.

Batch deployment policy applies to every contained operation at preview, apply,
and undo, including before each step. Created-track cleanup additionally compares
the creation-time fingerprint returned by the adapter; later edits never become
owned deletion state. Clean pre-dispatch refusals may compensate completed steps,
but failed verification or compensation retains recovery-protected uncertainty.
Host checkpoints are in memory: do not restart the host or replace the key to
resolve uncertainty. After inspection, explicit recovery finalization retires the
record without claiming to restore Live state. Exact-candidate real-Live validation
of these compound paths remains pending; simulator ledger tests are not that proof.

## Imported media staging

Audio import (`live_audio_import_*`) and Simpler sample replacement
(`live_simpler_*`) stage a verified, read-only copy of the authorized source
file in a persistent, owner-controlled managed directory:
`~/.config/ableton-mcp/import-staging` on Linux/macOS and
`%APPDATA%\ableton-mcp\import-staging` on Windows (override with the
`ABLETON_MCP_IMPORT_STAGING_DIR` environment variable, which must be an
absolute path). The directory is created owner-only (`0o700`) and its ownership
is verified before use; staged files are written non-writable and are the only
bytes Live is ever offered, so a rename-swap in the allowed source directory
cannot substitute unauthorized content.

Live references imported audio in place: after a successful apply, the staged
copy *is* the created clip's or Simpler's media, held in the managed directory
until the user collects files into the project or deletes the clip. Staged
copies are therefore released only on paths with no consumer — preview
failure, transaction expiry, eviction or recovery finalization, pre-dispatch
apply refusals, failed apply, and undo (after the created clip is deleted or
the original sample restored) — never on apply success, host shutdown, or
wall-clock age. Operators may prune the managed directory manually once the
referencing clips are gone.

## Audible Session actions

A clip launches whatever plays or records, like pressing its slot in Live; its
preview-captured track/scene/slot/clip identities are carried to and rechecked on
Live's thread. Scene audition (`live_session_audition_*`) still requires a stopped,
unarmed, unmonitored baseline. Owned stop clears only the preflighted target;
`live_session_emergency_stop` independently requires exact fresh active target
keys and recording state, atomically clears Session clips, transport, Session
Record, and Arrangement Record, and survives host restart.

## Recording authority

A recording start preview requires explicit intent and an exact armed
destination for either lane; other tracks may be armed too (Live records onto
every armed track). Apply carries the exact prior Session/Arrangement recording
booleans and destination identity into the mapper; all are rechecked on Live's mutation thread before
record state changes. Acknowledgement loss is uncertain and never blindly
replayed. Stop uses the same fenced operation; independent emergency stop
clears both modes.

## Realtime authority

A configured UDP port grants no standing authority. `realtime.arm` selects an
endpoint, token, 1–30 second TTL, channel set, optional sender ports, and exact
published parameter refs. Live compares the exact parameter/owner/track/sibling
identities atomically before granting a token and again before every queued
write, so traversal-index replacement or reparenting revokes authority. Packets
are bounded to 512 bytes and 64/s with burst 16. *Accepted* does not mean
*applied*. Disarm generation-fences queued work. See
[REALTIME_CONTROL.md](REALTIME_CONTROL.md).

## Audio analysis and capture

Public analysis accepts normalized PCM, never paths or URLs, and returns only
bounded aggregates. It runs in disposable secret-stripped workers and can be
cancelled by killing the worker. Caller PCM is never attributed to Live unless
the relationship is explicitly declared — and a declaration remains unverified.

Live capture is a separate real-Live-only capability. Preview requires an exact
source clip slot and a distinct empty audio slot, a saved disposable Set,
stopped non-recording/unarmed/non-input-monitored state, a restorable route, a
one-to-nine second duration, explicit `ephemeral-analysis-and-delete` consent,
and output safety. A ten-second mapper watchdog, slot/track/transport stop,
bridge shutdown hook, MCP cancellation recovery, and an independent
post-restart emergency tool bound the recording authority. Cleanup deletes only
the exact owned clip and unlinks the verified WAV/ASD after private quarantine;
no arbitrary deletion or forensic-erasure claim is made. See
[AUDIO_INTELLIGENCE.md](AUDIO_INTELLIGENCE.md).

## Bridge safety

The bridge is numeric-loopback-only. Requests and responses use canonical
HMAC-SHA256, challenge/bridge-epoch binding, positive sequence and replay
checks, bounded frames/collections, and deadlines. Socket workers never touch
Live objects; the scheduled Control Surface callback drains Live work on the
main thread. Reconnect creates a new reference epoch. Shutdown releases
subscriptions, listeners, clients, workers, queued callbacks, realtime
authority, and refs. For active capture it reasserts exact stop/restoration
but, because a Remote Script cannot unlink PCM, preserves the owned clip/path
as a visible recovery residual rather than destroying that identity.

## Real-Live evidence boundary

Fake-Live, simulator, package, property, and benchmark results prove controlled
contracts, not Live behavior. Tracked evidence separately records installed
real-Live observations through Phase 8 on macOS Live 12.4.5b8, including normal
cleanup and failure recovery. It does not prove Windows Live behavior, hardware
output safety, accessibility, signing, or notarization.

If visible Live state conflicts with authenticated status or fresh discovery,
stop the client, preserve redacted evidence, use independent emergency recovery
if an owned audible lifecycle is active, and treat the discrepancy as a defect.
