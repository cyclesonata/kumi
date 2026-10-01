import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonObject } from "../src/core/contracts.js";
import { CHANGES, HOST_TOOLS, UNDO_TOOL, undoNote } from "../src/integrations/ableton/changes.js";
import { bridge, opened, signal, tool } from "./fixtures/synthetic-bridge.js";

test("a change tool previews and applies in one step, keeps confirmations away from the model and records the change", async () => {
  const b = await opened();
  try {
    const names = b.tools.map((item) => item.name);
    assert(names.includes("set_tempo") && names.includes("set_mixer") && names.includes(UNDO_TOOL));
    for (const name of names) assert(!/_apply$|_preview$|^live_undo$/.test(name), `${name} is not a bridge preview, apply or undo`);
    assert(!names.includes("live_audio_capture_apply") && !names.includes("live_transport_apply"), "tools outside Kumi's changes stay hidden");
    assert(!names.includes("set_device_parameter"), "a change is offered only while the bridge advertises it");
    assert.doesNotMatch(b.observation.instructions, /only read Live state/i);

    const result = await tool(b.tools, "set_tempo").execute({ tempo: 124 }, signal());
    assert.equal(result.isError, false, result.text);
    const reply = JSON.parse(result.text) as JsonObject;
    assert.equal(reply.changed, "Tempo 120 → 124 BPM"); assert.match(String(reply.change), /^c\d+$/);
    const apply = b.requests.find((request) => request.name === "live_tempo_apply")!;
    assert.equal(apply.args.confirmation, "apply"); assert.match(String(apply.args.idempotencyKey), /^[0-9a-f-]{36}$/);
    assert.equal(b.tempo, 124);
    assert.equal(b.records.length, 1);
    assert.deepEqual({ ...b.records[0], at: 0, id: "" }, { id: "", family: "tempo", title: "Tempo 120 → 124 BPM", state: "applied", from: 120, to: 124, at: 0 });
  } finally { await b.integration.close(); }
});

test("changes need references from this turn, the observation's tracks or discovery; HISTORY gets the track's name and colour from them", async () => {
  const b = await opened();
  try {
    const listed = (JSON.parse(b.observation.context) as { tracks: JsonObject[] }).tracks;
    assert.deepEqual(listed.map((track) => [track.ref, track.name]), [["track:1", "Fixture Bass"], ["track:2", "Fixture Drums"]], "the observation lists the tracks, by short names for Live's references");
    const stale = await tool(b.tools, "set_mixer").execute({ trackRef: "6:track:0", volume: 0.6 }, signal());
    assert.equal(stale.isError, true); assert.match(stale.text, /discovery in this turn/);
    assert(!b.requests.some((request) => request.name === "live_mixer_preview"), "nothing is previewed with a stale reference");
    const result = await tool(b.tools, "set_mixer").execute({ trackRef: "track:1", volume: 0.6, pan: -0.25 }, signal());
    assert.equal(result.isError, false, result.text);
    assert.equal(b.requests.find((request) => request.name === "live_mixer_preview")!.args.trackRef, "7:track:0", "Live gets its own reference back");
    assert.doesNotMatch(result.text, /secret-confirmation-token/, "the preview's confirmation never reaches the model");
    const apply = b.requests.find((request) => request.name === "live_mixer_apply")!;
    assert.equal(apply.args.confirmation, "secret-confirmation-token-0123456789", "Kumi passes the preview's own confirmation");
    const change = b.records.at(-1)!;
    assert.equal(change.title, "Fixture Bass volume down, pan left", "without Live's text, plain directions");
    assert.deepEqual(change.track, { name: "Fixture Bass", color: "#f7f47c" });
    assert.equal(change.from, 0.85); assert.equal(change.to, 0.6);
    await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:1", volume: 0.4, pan: -0.5 }, signal());
    assert.equal(b.records.at(-1)!.title, "Fixture Drums volume 0.0\u00a0dB → -9.3\u00a0dB, pan C → 25L", "with Live's own units when the bridge reports them, each value kept whole");
    await tool(b.tools, "rename").execute({ kind: "track", ref: "7:track:0", name: "Sub" }, signal());
    assert.equal(b.records.at(-1)!.title, "Renamed track “Fixture Bass” → “Sub”");
    await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.55 }, signal());
    assert.equal(b.records.at(-1)!.track?.name, "Sub", "later changes use the new name");
    b.deleteLastTrack();
    const next = await b.integration.observe(signal());
    const again = await tool(next.tools, "set_mixer").execute({ trackRef: "7:track:1", volume: 0.5 }, signal());
    assert.equal(again.isError, true, "a track deleted in Live since the last turn isn't listed any more, so its ref is refused");
  } finally { await b.integration.close(); }
});

test("the model reads and writes short names for Live's references, as plain JSON; Live gets its own back", async () => {
  const b = await opened();
  try {
    const read = await tool(b.tools, "live_discover").execute({ kind: "track" }, signal());
    const body = JSON.parse(read.text) as { live: { items: JsonObject[] } };
    assert.deepEqual(body.live.items.map((item) => [item.ref, item.parentRef]), [["track:1", "set:1"], ["track:2", "set:1"]], "the same names as the observation's");
    assert.doesNotMatch(read.text, /7:track|\\"/, "no long references, and no JSON inside a string");
    const renamed = await tool(b.tools, "rename").execute({ kind: "track", ref: "track:2", name: "Drums" }, signal());
    assert.equal(renamed.isError, false, renamed.text);
    assert.equal(b.requests.find((request) => request.name === "live_object_rename_preview")!.args.ref, "7:track:1");
    assert.equal((await tool(b.tools, "set_mixer").execute({ trackRef: "track:9", volume: 0.5 }, signal())).isError, true, "a name Kumi never gave is refused like any unknown reference");
  } finally { await b.integration.close(); }
});

test("a colour change shows the old and new colours; later changes, and its undo, keep Kumi's picture of the track right", async () => {
  const b = await opened();
  try {
    await tool(b.tools, "live_discover").execute({ kind: "track" }, signal());
    const result = await tool(b.tools, "set_track_color").execute({ ref: "7:track:0", colorIndex: 12 }, signal());
    assert.equal(result.isError, false, result.text);
    const colour = b.records.at(-1)!;
    assert.equal(colour.title, "Fixture Bass colour changed");
    assert.deepEqual(colour.colors, { from: "#f7f47c", to: "#e553a0" }, "before from discovery, after from Live's answer");
    assert.deepEqual(colour.track, { name: "Fixture Bass", color: "#e553a0" }, "the chip shows the track as it looks now");
    await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.6 }, signal());
    assert.equal(b.records.at(-1)!.track?.color, "#e553a0", "later changes use the new colour");
    await tool(b.tools, "rename").execute({ kind: "track", ref: "7:track:0", name: "Sub" }, signal());
    await b.integration.undo!(colour.id, signal());
    await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.5 }, signal());
    assert.deepEqual(b.records.at(-1)!.track, { name: "Sub", color: "#f7f47c" }, "the old colour once it's undone, and the later name stays");
  } finally { await b.integration.close(); }
});

test("find_samples is offered alongside Live's reads and finds samples in the folders named", async () => {
  const b = await opened();
  const folder = mkdtempSync(join(tmpdir(), "kumi-find-"));
  try {
    mkdirSync(join(folder, "Kicks")); writeFileSync(join(folder, "Kicks", "Kick Deep.wav"), Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"));
    writeFileSync(join(folder, "Snare Tight.wav"), Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"));
    const result = await tool(b.tools, "find_samples").execute({ folders: [folder], words: ["kick"] }, signal());
    assert.equal(result.isError, false, result.text);
    const body = JSON.parse(result.text) as { samples: { name: string; path: string }[]; matched: number };
    assert.deepEqual(body.samples.map((sample) => sample.name), ["Kick Deep"]); assert.equal(body.matched, 1);
    assert.equal(body.samples[0]!.path, join(folder, "Kicks", "Kick Deep.wav"));
    const relative = await tool(b.tools, "find_samples").execute({ folders: ["Samples"] }, signal());
    assert.equal(relative.isError, true); assert.match(relative.text, /full path/);
  } finally { rmSync(folder, { recursive: true, force: true }); await b.integration.close(); }
});

test("load_sample puts a sample find_samples returned into a new Simpler, as one change with its undo", async () => {
  const b = await opened();
  const folder = mkdtempSync(join(tmpdir(), "kumi-load-"));
  try {
    writeFileSync(join(folder, "Kick Deep.wav"), Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"));
    await tool(b.tools, "live_discover").execute({ kind: "track" }, signal());
    const invented = await tool(b.tools, "load_sample").execute({ trackRef: "7:track:0", sample: join(folder, "Kick Deep.wav") }, signal());
    assert.equal(invented.isError, true); assert.match(invented.text, /find_samples/);
    assert(!b.requests.some((request) => request.name === "live_device_preview"), "a path search didn't return goes nowhere");
    await tool(b.tools, "find_samples").execute({ folders: [folder], words: ["kick"] }, signal());
    const result = await tool(b.tools, "load_sample").execute({ trackRef: "7:track:0", sample: join(folder, "Kick Deep.wav") }, signal());
    assert.equal(result.isError, false, result.text);
    const preview = b.requests.find((request) => request.name === "live_device_preview")!;
    assert.deepEqual(preview.args, { action: "insert", trackRef: "7:track:0", deviceName: "Simpler", filePath: join(folder, "Kick Deep.wav"), allowedRoot: folder });
    const change = b.records.at(-1)!;
    assert.equal(change.title, "Loaded “Kick Deep” into a new Simpler on Fixture Bass"); assert.equal(change.family, "device");
    assert.equal((await b.integration.undo!(change.id, signal())).state, "undone");
    const schema = b.tools.find((item) => item.name === "load_sample")!.inputSchema as { required: string[] };
    assert.deepEqual(schema.required, ["trackRef", "sample"], "the model names a track and a found sample, nothing about files or roots");
  } finally { rmSync(folder, { recursive: true, force: true }); await b.integration.close(); }
});

test("load_sample_to_pad is offered before the Set has a Drum Rack, says what to do first, then loads onto the pad", async () => {
  const b = await opened();
  const folder = mkdtempSync(join(tmpdir(), "kumi-pad-"));
  try {
    writeFileSync(join(folder, "Kick Deep.wav"), Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"));
    assert.ok(b.tools.some((item) => item.name === "load_sample_to_pad"), "offered although the bridge doesn't advertise pads yet");
    await tool(b.tools, "find_samples").execute({ folders: [folder] }, signal());
    await tool(b.tools, "live_discover").execute({ kind: "track" }, signal());
    const early = await tool(b.tools, "load_sample_to_pad").execute({ deviceRef: "7:track:0", note: 36, sample: join(folder, "Kick Deep.wav") }, signal());
    assert.equal(early.isError, true); assert.match(early.text, /load one with load_device first/);
    b.addDrumRack();
    const result = await tool(b.tools, "load_sample_to_pad").execute({ deviceRef: "7:track:0", note: 36, sample: join(folder, "Kick Deep.wav") }, signal());
    assert.equal(result.isError, false, result.text);
    const preview = b.requests.find((request) => request.name === "live_drum_pad_preview")!;
    assert.deepEqual(preview.args, { action: "load-sample", deviceRef: "7:track:0", note: 36, filePath: join(folder, "Kick Deep.wav"), allowedRoot: folder });
    assert.equal(b.records.at(-1)!.title, "Loaded “Kick Deep” onto Drum Rack pad C1");
    assert.equal((await b.integration.undo!(b.records.at(-1)!.id, signal())).state, "undone");
  } finally { rmSync(folder, { recursive: true, force: true }); await b.integration.close(); }
});

test("make_changes runs a whole plan in one call, later steps using what earlier ones made, and stops at the first failure", async () => {
  const b = await opened();
  const folder = mkdtempSync(join(tmpdir(), "kumi-plan-"));
  try {
    for (const name of ["Kick A.wav", "Kick B.wav"]) writeFileSync(join(folder, name), Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"));
    const plan = tool(b.tools, "make_changes");
    assert.deepEqual((plan.inputSchema as { properties: { steps: { items: { properties: { tool: { enum: string[] } } } } } }).properties.steps.items.properties.tool.enum.includes("load_sample"), true);
    const result = await plan.execute({ steps: [
      { tool: "add_tracks_and_scenes", input: { tracks: [{ name: "Kick", kind: "midi" }], scenes: [] }, as: "kick" },
      { tool: "load_sample", input: { trackRef: "@kick", sample: { random: true, folders: [folder] } }, as: "simpler" },
      { tool: "set_tempo", input: { tempo: 126 } },
    ] }, signal());
    assert.equal(result.isError, false, result.text);
    const body = JSON.parse(result.text) as { done: { step: number; changed: string; ref?: string }[] };
    assert.deepEqual(body.done.map((step) => step.step), [1, 2, 3]);
    assert.equal(body.done[0]!.ref, "track:3", "the new track's ref comes back, by its short name");
    const insert = b.requests.find((request) => request.name === "live_device_preview")!;
    assert.equal(insert.args.trackRef, "7:track:2", "@kick became the track the first step made");
    assert.match(String(insert.args.filePath), /Kick [AB]\.wav$/, "Kumi picked a sample itself, no search first");
    assert.equal(b.tempo, 126); assert.equal(b.records.length, 3, "three HISTORY entries, each with its own undo");
    const again = await plan.execute({ steps: [
      { tool: "load_sample", input: { trackRef: "@nowhere", sample: { random: true, folders: [folder] } } },
    ] }, signal());
    assert.equal(again.isError, true); assert.match(again.text, /refers to @nowhere, which no earlier step made/);
    const failing = await plan.execute({ steps: [
      { tool: "set_tempo", input: { tempo: 124 } },
      { tool: "rename", input: { kind: "track", ref: "7:track:99", name: "Nope" } },
      { tool: "set_tempo", input: { tempo: 128 } },
    ] }, signal());
    const stopped = JSON.parse(failing.text) as { done: unknown[]; stopped: { step: number }; skipped: number };
    assert.equal(failing.isError, true); assert.equal(stopped.done.length, 1); assert.equal(stopped.stopped.step, 2); assert.equal(stopped.skipped, 1);
    assert.equal(b.tempo, 124, "the step after the failure didn't run");
  } finally { rmSync(folder, { recursive: true, force: true }); await b.integration.close(); }
});

test("a Drum Rack kit is one make_changes call: a step with each runs once per pad", async () => {
  const b = await opened();
  const folder = mkdtempSync(join(tmpdir(), "kumi-kit-"));
  try {
    for (const name of ["Kick.wav", "Snare.wav", "Hat.wav", "Clap.wav"]) writeFileSync(join(folder, name), Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"));
    const result = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "add_tracks_and_scenes", input: { tracks: [{ name: "Kit", kind: "midi" }], scenes: [] }, as: "track" },
      { tool: "load_device", input: { trackRef: "@track", itemId: "instruments/Drum Rack" }, as: "rack" },
      { tool: "load_sample_to_pad", input: { deviceRef: "@rack", sample: { random: true, folders: [folder] } }, each: { note: [36, 37, 38] } },
    ] }, signal());
    assert.equal(result.isError, false, result.text);
    const done = (JSON.parse(result.text) as { done: { step: number; ref?: string }[] }).done;
    assert.deepEqual(done.map((step) => step.step), [1, 2, 3, 4, 5], "the each step became three");
    assert.equal(done[1]!.ref, "device:1", "the rack Live loaded");
    const pads = b.requests.filter((request) => request.name === "live_drum_pad_preview").map((request) => request.args);
    assert.deepEqual(pads.map((args) => [args.deviceRef, args.note]), [["7:device:2:0", 36], ["7:device:2:0", 37], ["7:device:2:0", 38]]);
    assert.equal(new Set(pads.map((args) => args.filePath)).size, 3, "three different samples");
    assert.deepEqual(b.records.slice(-3).map((record) => record.title.replace(/“.*”/, "“…”")), ["Loaded “…” onto Drum Rack pad C1", "Loaded “…” onto Drum Rack pad C#1", "Loaded “…” onto Drum Rack pad D1"]);
    const wrong = await tool(b.tools, "make_changes").execute({ steps: [{ tool: "set_tempo", input: {}, each: { tempo: Array.from({ length: 501 }, () => 120) } }] }, signal());
    assert.equal(wrong.isError, true, "an each that runs past a turn's changes is refused whole"); assert.match(wrong.text, /steps in all/);
  } finally { rmSync(folder, { recursive: true, force: true }); await b.integration.close(); }
});

test("a plan that loads a rack can add chains to it at once, before the bridge's catalog notice arrives", async () => {
  const b = await opened({ lateRacks: true });
  try {
    const result = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "load_device", input: { trackRef: "track:1", itemId: "audio_effects/Audio Effect Rack" }, as: "rack" },
      { tool: "edit_rack", input: { rackRef: "@rack", action: "add-chain" }, as: "left" },
    ] }, signal());
    assert.equal(result.isError, false, result.text);
    assert.doesNotMatch(result.text, /no rack in the Set yet/);
    assert.equal(b.requests.filter((request) => request.name === "live_rack_preview").length, 1, "the chain was asked of Live");
  } finally { await b.integration.close(); }
});

test("racks: the observation shows chains with their devices; a plan adds a chain, loads into it and balances the chains", async () => {
  const b = await opened({ racks: true });
  try {
    const context = JSON.parse(b.observation.context) as { tracks: { name: string; devices?: JsonObject[] }[] };
    assert.deepEqual(context.tracks[0]!.devices, [
      { ref: "device:1", name: "Instrument Rack", type: "InstrumentGroupDevice", chains: [
        { ref: "chain:1", name: "Keys", devices: [{ ref: "device:2", name: "Operator" }] }, { ref: "chain:2", name: "Pad", devices: [] }] },
      { ref: "device:3", name: "Reverb" }], "a rack's chains, empty ones too, each with its devices; the track's own devices after");
    const result = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "edit_rack", input: { rackRef: "device:1", action: "add-chain" }, as: "bells" },
      { tool: "load_device", input: { chainRef: "@bells", itemId: "instruments/Collision" } },
      { tool: "set_chain_mixer", input: { chainRef: "chain:2", volume: 0.6 } },
      { tool: "edit_rack", input: { rackRef: "device:1", action: "add-macro" } },
    ] }, signal());
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(b.requests.filter((request) => request.name === "live_rack_preview").map((request) => request.args.action), ["insert-chain", "add-macro"]);
    assert.equal(b.requests.find((request) => request.name === "live_browser_load_preview")!.args.chainRef, "7:chain:0:0:2", "the new chain, from the step that made it");
    const [chain, load, mixer, macro] = b.records.slice(-4);
    assert.equal(chain!.title, "Added chain 3 to Instrument Rack"); assert.equal(chain!.state, "kept", "Live can't take a chain away"); assert.match(chain!.note ?? "", /delete it in Live/);
    assert.deepEqual(chain!.devices, { rack: "Instrument Rack", chains: [{ name: "Keys", devices: ["Operator"] }, { name: "Pad", devices: [] }, { name: "Chain", devices: [] }], chain: 2 });
    assert.equal(load!.title, "Loaded Collision into Instrument Rack (chain 3) on Fixture Bass"); assert.equal(load!.state, "applied");
    assert.equal(load!.devices?.index, 0); assert.equal(load!.devices?.chain, 2);
    assert.equal(mixer!.title, "Instrument Rack · chain “Pad” volume down");
    assert.equal(macro!.title, "Added a macro to Instrument Rack"); assert.deepEqual([macro!.from, macro!.to], [8, 9]);
    // A chain's devices can be read with the chain as their parent.
    const read = await tool(b.tools, "live_discover").execute({ kind: "device", parent: "chain:1" }, signal());
    assert.equal(read.isError, false, read.text);
    assert.equal(b.requests.filter((request) => request.name === "live_discover" && request.args.kind === "device").at(-1)!.args.parent, "7:chain:0:0:0");
    assert.match(read.text, /Operator/, "the chain's device");
  } finally { await b.integration.close(); }
});

test("each takes several lists of one length together: the same change on several tracks in one step", async () => {
  const b = await opened();
  try {
    const plan = tool(b.tools, "make_changes");
    const result = await plan.execute({ steps: [{ tool: "set_mixer", input: { pan: 0 }, each: { trackRef: ["track:1", "track:2"], volume: [0.6, 0.5] } }] }, signal());
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(b.requests.filter((request) => request.name === "live_mixer_preview").map((request) => [request.args.trackRef, request.args.volume, request.args.pan]), [["7:track:0", 0.6, 0], ["7:track:1", 0.5, 0]]);
    const uneven = await plan.execute({ steps: [{ tool: "set_mixer", input: {}, each: { trackRef: ["track:1", "track:2"], volume: [0.6] } }] }, signal());
    assert.equal(uneven.isError, true); assert.match(uneven.text, /lists of one length/);
    assert.equal(b.requests.filter((request) => request.name === "live_mixer_preview").length, 2, "an uneven step changes nothing");
  } finally { await b.integration.close(); }
});

test("make_changes with final answers for the model when every step is done, and not when one fails", async () => {
  const b = await opened();
  try {
    const plan = tool(b.tools, "make_changes");
    const one = await plan.execute({ steps: [{ tool: "set_tempo", input: { tempo: 124 } }], final: true }, signal());
    assert.equal(one.isError, false); assert.equal(one.reply, "Done: Tempo 120 → 124 BPM.");
    const two = await plan.execute({ steps: [{ tool: "set_tempo", input: { tempo: 126 } }, { tool: "set_mixer", input: { trackRef: "7:track:0", volume: 0.6 } }], final: true }, signal());
    assert.equal(two.reply, "Done:\n- Tempo 124 → 126 BPM\n- Fixture Bass volume down");
    assert.equal((await plan.execute({ steps: [{ tool: "set_tempo", input: { tempo: 127 } }] }, signal())).reply, undefined, "without final the model answers");
    const failed = await plan.execute({ steps: [{ tool: "rename", input: { kind: "track", ref: "7:track:99", name: "Nope" } }], final: true }, signal());
    assert.equal(failed.isError, true); assert.equal(failed.reply, undefined, "a failure goes back to the model");
  } finally { await b.integration.close(); }
});

test("pads of one rack in a row load as one change when the bridge can: one Live request, one undo, a line each in the answer", async () => {
  const b = await opened({ padBatches: true });
  const folder = mkdtempSync(join(tmpdir(), "kumi-batch-"));
  try {
    for (const name of ["Kick.wav", "Snare.wav", "Hat.wav", "Clap.wav"]) writeFileSync(join(folder, name), Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"));
    const checks = () => b.requests.filter((request) => request.name === "live_status").length;
    const before = checks();
    const result = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "add_tracks_and_scenes", input: { tracks: [{ name: "Kit", kind: "midi" }], scenes: [] }, as: "track" },
      { tool: "load_device", input: { trackRef: "@track", itemId: "instruments/Drum Rack" }, as: "rack" },
      { tool: "load_sample_to_pad", input: { deviceRef: "@rack", sample: { random: true, folders: [folder] } }, each: { note: [36, 37, 38] } },
      { tool: "set_tempo", input: { tempo: 126 } },
    ], final: true }, signal());
    assert.equal(result.isError, false, result.text);
    const previews = b.requests.filter((request) => request.name === "live_drum_pad_preview");
    assert.equal(previews.length, 1, "one preview for the three pads");
    const pads = previews[0]!.args.pads as JsonObject[];
    assert.deepEqual(pads.map((pad) => pad.note), [36, 37, 38]); assert.equal(previews[0]!.args.deviceRef, "7:device:2:0");
    assert.equal(new Set(pads.map((pad) => pad.filePath)).size, 3, "three different samples");
    const kit = b.records.find((record) => record.title.startsWith("Loaded 3 samples"));
    assert.equal(kit?.title, "Loaded 3 samples onto Drum Rack pads C1–D1", "one HISTORY entry for the pads");
    assert.match(result.reply ?? "", /^Done:\n- Added MIDI track “Kit”\n- Loaded Drum Rack on Kit\n- Loaded “\w+” onto Drum Rack pad C1\n- Loaded “\w+” onto Drum Rack pad C#1\n- Loaded “\w+” onto Drum Rack pad D1\n- Tempo 120 → 126 BPM$/);
    assert.equal(checks() - before, 1, "only the plan's first change checks Live is the same");
    assert.equal((await b.integration.undo!(kit!.id, signal())).state, "undone");
    const one = await tool(b.tools, "make_changes").execute({ steps: [{ tool: "load_sample_to_pad", input: { deviceRef: "7:device:2:0", note: 39, sample: { random: true, folders: [folder] } } }] }, signal());
    assert.equal(one.isError, false, one.text);
    assert.equal(b.requests.filter((request) => request.name === "live_drum_pad_preview").at(-1)!.args.action, "load-sample", "a single pad stays a single change");
  } finally { rmSync(folder, { recursive: true, force: true }); await b.integration.close(); }
});

test("parameters of one device in a row change as one change: one Live request, one undo, a line each in the answer", async () => {
  const b = await opened({ parameters: true });
  try {
    const device = (JSON.parse(b.observation.context) as { tracks: Array<{ devices?: JsonObject[] }> }).tracks[0]!.devices![0]!;
    assert.deepEqual(device, { ref: "device:1", name: "Operator" }, "the observation lists the track's device");
    const read = JSON.parse((await tool(b.tools, "live_discover").execute({ kind: "parameter", parent: "device:1" }, signal())).text) as { live: { items: JsonObject[] } };
    assert.deepEqual(read.live.items.map((item) => item.ref), ["parameter:1", "parameter:2", "parameter:3"]);
    const result = await tool(b.tools, "make_changes").execute({ steps: [{ tool: "set_device_parameter", input: { deviceRef: "device:1" }, each: { parameterRef: ["parameter:1", "parameter:3"], value: [0.5, 0.25] } }], final: true }, signal());
    assert.equal(result.isError, false, result.text);
    const previews = b.requests.filter((request) => request.name === "live_device_parameter_preview");
    assert.deepEqual(previews.map((request) => request.args), [{ deviceRef: "7:device:0:0", values: [{ parameterRef: "7:parameter:0", value: 0.5 }, { parameterRef: "7:parameter:2", value: 0.25 }] }], "one preview for both, with Live's references");
    assert.equal(b.records.at(-1)!.title, "Operator · 2 parameters");
    assert.equal(result.reply, "Done:\n- Operator · Osc-A Level 0 → 0.5\n- Operator · Ae Release 0 → 0.25");
    assert.equal((await b.integration.undo!(b.records.at(-1)!.id, signal())).state, "undone");
    const direct = await tool(b.tools, "make_changes").execute({ steps: [{ tool: "set_device_parameter", input: { deviceRef: "device:1", values: [{ parameterRef: "parameter:2", value: 0.75 }, { parameterRef: "parameter:3", value: 0.5 }, { parameterRef: "parameter:1", value: 0 }] } }], final: true }, signal());
    assert.equal(direct.isError, false, direct.text);
    assert.equal(b.records.at(-1)!.title, "Operator · 2 parameters", "the model may give values itself; one set to what it was isn't counted");
    assert.equal(direct.reply, "Done:\n- Operator · Filter Freq 0 → 0.75\n- Operator · Ae Release 0 → 0.5");
    const stale = await tool(b.tools, "make_changes").execute({ steps: [{ tool: "set_device_parameter", input: { deviceRef: "device:1" }, each: { parameterRef: ["parameter:1", "7:parameter:9"], value: [0.5, 0.5] } }] }, signal());
    assert.equal(stale.isError, true); assert.match(stale.text, /parameterRef must come from discovery/, "every parameter's reference is checked");
    assert.equal(b.requests.filter((request) => request.name === "live_device_parameter_preview").length, 2, "and nothing more reached Live");
    // A number written as text is that number; a value outside the range says what the range is and where it is now.
    const texted = await tool(b.tools, "set_device_parameter").execute({ deviceRef: "device:1", parameterRef: "parameter:2", value: "0.4" }, signal());
    assert.equal(texted.isError, false, texted.text);
    const outside = await tool(b.tools, "set_device_parameter").execute({ deviceRef: "device:1", parameterRef: "parameter:2", value: 800 }, signal());
    assert.equal(outside.isError, true);
    assert.match(outside.text, /outside authoritative bounds.* Values are the parameter's own, between its min and max, not what Live shows: Filter Freq takes 0 to 1 \(now 0\)\.$/);
  } finally { await b.integration.close(); }
});

test("a pad's sample can go into Live 12's Drum Sampler instead of Simpler, in a batch or on its own", async () => {
  const b = await opened({ padBatches: true });
  const folder = mkdtempSync(join(tmpdir(), "kumi-drum-sampler-"));
  try {
    for (const name of ["Kick.wav", "Snare.wav", "Hat.wav", "Clap.wav"]) writeFileSync(join(folder, name), Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"));
    const result = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "add_tracks_and_scenes", input: { tracks: [{ name: "DS Kit", kind: "midi" }], scenes: [] }, as: "track" },
      { tool: "load_device", input: { trackRef: "@track", itemId: "instruments/Drum Rack" }, as: "rack" },
      { tool: "load_sample_to_pad", input: { deviceRef: "@rack", sample: { random: true, folders: [folder] }, instrument: "Drum Sampler" }, each: { note: [36, 37] } },
    ], final: true }, signal());
    assert.equal(result.isError, false, result.text);
    const batch = b.requests.filter((request) => request.name === "live_drum_pad_preview").at(-1)!;
    assert.deepEqual((batch.args.pads as JsonObject[]).map((pad) => pad.instrument), ["Drum Sampler", "Drum Sampler"], "the bridge is asked for Drum Samplers");
    assert.match(b.records.at(-1)!.title, /^Loaded 2 samples onto Drum Rack pads C1–C#1 in Drum Samplers$/);
    assert.match(result.reply ?? "", /onto Drum Rack pad C1 in a Drum Sampler\n- Loaded “\w+” onto Drum Rack pad C#1 in a Drum Sampler$/);
    const single = await tool(b.tools, "load_sample_to_pad").execute({ deviceRef: "device:1", note: 38, sample: { random: true, folders: [folder] }, instrument: "Drum Sampler" }, signal());
    assert.equal(single.isError, false, single.text);
    assert.equal(b.requests.filter((request) => request.name === "live_drum_pad_preview").at(-1)!.args.instrument, "Drum Sampler");
    assert.match(b.records.at(-1)!.title, /pad D1 in a Drum Sampler$/);
    const simpler = await tool(b.tools, "load_sample_to_pad").execute({ deviceRef: "device:1", note: 39, sample: { random: true, folders: [folder] } }, signal());
    assert.equal(simpler.isError, false, simpler.text);
    assert.equal("instrument" in b.requests.filter((request) => request.name === "live_drum_pad_preview").at(-1)!.args, false, "Simpler is the default, unsaid");
    assert.doesNotMatch(b.records.at(-1)!.title, /Drum Sampler/);
  } finally { rmSync(folder, { recursive: true, force: true }); await b.integration.close(); }
});

test("random picks within one answer don't repeat", async () => {
  const b = await opened();
  const folder = mkdtempSync(join(tmpdir(), "kumi-picks-"));
  try {
    for (const name of ["Kick A.wav", "Kick B.wav"]) writeFileSync(join(folder, name), Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"));
    await tool(b.tools, "live_discover").execute({ kind: "track" }, signal());
    const paths: string[] = [];
    for (const trackRef of ["7:track:0", "7:track:1"]) {
      await tool(b.tools, "load_sample").execute({ trackRef, sample: { random: true, folders: [folder] } }, signal());
      paths.push(String(b.requests.filter((request) => request.name === "live_device_preview").at(-1)!.args.filePath));
    }
    assert.notEqual(paths[0], paths[1]);
    const third = await tool(b.tools, "load_sample").execute({ trackRef: "7:track:0", sample: { random: true, folders: [folder] } }, signal());
    assert.equal(third.isError, true); assert.match(third.text, /No sample matches/, "both are taken in this answer");
  } finally { rmSync(folder, { recursive: true, force: true }); await b.integration.close(); }
});

test("each turn's observation lists Kumi's latest changes and where they stand, so an undo in HISTORY isn't news to the model", async () => {
  const b = await opened();
  try {
    assert.equal((JSON.parse(b.observation.context) as JsonObject).kumiChanges, undefined, "nothing yet, nothing listed");
    await tool(b.tools, "set_tempo").execute({ tempo: 124 }, signal());
    const tempo = b.records.at(-1)!;
    await b.integration.undo!(tempo.id, signal());
    const next = await b.integration.observe(signal());
    assert.deepEqual((JSON.parse(next.context) as JsonObject).kumiChanges, [{ change: tempo.id, what: "Tempo 120 → 124 BPM", state: "undone" }]);
    assert.match(next.instructions, /kumiChanges/);
  } finally { await b.integration.close(); }
});

test("undo goes through the bridge's guarded undo; a refusal keeps the change, says why and reuses its key", async () => {
  const b = await opened();
  try {
    await tool(b.tools, "set_tempo").execute({ tempo: 130 }, signal());
    const undone = await tool(b.tools, UNDO_TOOL).execute({ change: "last" }, signal());
    assert.equal(undone.isError, false, undone.text);
    assert.equal(b.tempo, 120);
    const undo = b.requests.find((request) => request.name === "live_undo")!;
    assert.equal(undo.args.confirmation, "undo"); assert.equal(undo.args.transactionId, b.requests.find((request) => request.name === "live_tempo_apply")!.args.transactionId);
    assert.equal(b.records.at(-1)!.state, "undone");
    const nothing = await tool(b.tools, UNDO_TOOL).execute({ change: "last" }, signal());
    assert.equal(nothing.isError, true); assert.match(nothing.text, /no change of Kumi's left/);

    await tool(b.tools, "set_tempo").execute({ tempo: 140 }, signal());
    const id = b.records.at(-1)!.id;
    b.refuseUndo("Tempo changed since the transaction; undo refused");
    const refused = await b.integration.undo!(id, signal());
    assert.equal(refused.state, "kept"); assert.equal(refused.note, "It changed in Live since, so Kumi left it as it is.");
    assert.equal(b.records.at(-1)!.state, "kept");
    await b.integration.undo!(id, signal());
    const keys = b.requests.filter((request) => request.name === "live_undo").slice(-2).map((request) => request.args.idempotencyKey);
    assert.equal(keys[0], keys[1], "a retried undo reuses its key, so the bridge reconciles instead of undoing twice");
  } finally { await b.integration.close(); }
});

test("undoing a track Kumi made that has changed since is refused for good: kept, with why, not \"try again\"", async () => {
  const b = await opened();
  try {
    await tool(b.tools, "add_tracks_and_scenes").execute({ tracks: [{ name: "Bounce", kind: "audio" }], scenes: [] }, signal());
    const id = b.records.at(-1)!.id;
    // As the bridge says it: the reason is final, though its remediation calls the state uncertain.
    b.refuseUndo(JSON.stringify({ reason: "created Session structure was modified after apply; undo refused", remediation: "Session-structure undo is uncertain; inspect authoritative tracks and scenes." }));
    const kept = await b.integration.undo!(id, signal());
    assert.equal(kept.state, "kept");
    assert.match(kept.note ?? "", /^It changed after Kumi made it .* Delete it in Live if you don't need it\.$/);
    // A real uncertainty still says to try again.
    b.refuseUndo(JSON.stringify({ reason: "remote operation timed out", remediation: "Session-structure undo is uncertain; inspect authoritative tracks and scenes." }));
    await tool(b.tools, "add_tracks_and_scenes").execute({ tracks: [{ name: "Other", kind: "audio" }], scenes: [] }, signal());
    const unsure = await b.integration.undo!(b.records.at(-1)!.id, signal());
    assert.equal(unsure.state, "unsure");
  } finally { await b.integration.close(); }
});

test("the bridge offering new tools after a change keeps the Set, its references and undo current", async () => {
  const b = await opened();
  try {
    await tool(b.tools, "live_discover").execute({ kind: "track" }, signal());
    await tool(b.tools, "set_tempo").execute({ tempo: 128 }, signal());
    b.catalogChanged();
    const mixer = await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:1", volume: 0.5 }, signal());
    assert.equal(mixer.isError, false, mixer.text);
    b.catalogChanged();
    assert.equal((await tool(b.tools, "live_discover").execute({ kind: "track" }, signal())).isError, false);
    b.catalogChanged();
    const undone = await tool(b.tools, UNDO_TOOL).execute({ change: "last" }, signal());
    assert.equal(undone.isError, false, undone.text);
  } finally { await b.integration.close(); }
});

test("after Live restarts, earlier changes stay in HISTORY without their undo", async () => {
  const b = await opened();
  try {
    await tool(b.tools, "set_tempo").execute({ tempo: 131 }, signal());
    b.liveAway();
    assert.equal((await tool(b.tools, "set_tempo").execute({ tempo: 132 }, signal())).isError, true);
    b.liveBack();
    const deadline = Date.now() + 2_000;
    while (b.states.at(-1) !== "connected" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    const expired = b.records.at(-1)!;
    assert.equal(expired.state, "expired"); assert.match(expired.note ?? "", /Live restarted since, so Kumi can't undo this/);
    const again = await b.integration.undo!(expired.id, signal());
    assert.equal(again.state, "expired", "undo isn't attempted with a restarted Live");
  } finally { await b.integration.close(); }
});

test("a change that reached Live is recorded even when the turn is cancelled meanwhile", async () => {
  const b = await opened();
  try {
    const turn = new AbortController();
    const held = b.holdApply();
    const running = tool(b.tools, "set_tempo").execute({ tempo: 99 }, turn.signal);
    await held.began;
    turn.abort();
    held.release();
    await running;
    assert.equal(b.tempo, 99);
    assert.equal(b.records.at(-1)?.state, "applied", "the change is in HISTORY, with its undo");
  } finally { await b.integration.close(); }
});

test("an apply Live didn't confirm is recorded as unsure, and the model is told to check", async () => {
  for (const how of ["throw", "uncertain", "unreadable"] as const) {
    const b = await opened();
    try {
      b.failApply(how);
      const result = await tool(b.tools, "set_tempo").execute({ tempo: 125 }, signal());
      assert.equal(result.isError, true); assert.match(result.text, /confirm/);
      assert.equal(b.records.at(-1)?.state, "unsure");
    } finally { await b.integration.close(); }
  }
});

test("new tracks go after the last one; references after a new track are retired, earlier ones stay good", async () => {
  const b = await opened();
  try {
    await tool(b.tools, "live_discover").execute({ kind: "track" }, signal());
    const schema = tool(b.tools, "add_tracks_and_scenes").inputSchema as { properties: { tracks: { items: { properties: { index: { description: string } } } } } };
    assert.match(schema.properties.tracks.items.properties.index.description, /Leave it out to add after the last one/);
    const result = await tool(b.tools, "add_tracks_and_scenes").execute({ tracks: [{ name: "Pad", kind: "midi" }], scenes: [] }, signal());
    assert.equal(result.isError, false, result.text);
    const previews = b.requests.filter((request) => request.name === "live_session_structure_preview");
    assert.equal((previews.at(-1)!.args.tracks as JsonObject[])[0]!.index, 2, "placed after the two existing tracks");
    assert.equal(b.records.at(-1)!.title, "Added MIDI track “Pad”");
    assert.match(result.text, /earlier references still work/);
    const before = await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.7 }, signal());
    assert.equal(before.isError, false, "a track before the new one didn't move, so its reference is still good");
    const created = await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:2", volume: 0.7 }, signal());
    assert.equal(created.isError, false, "the new track's own reference is current");
    assert.equal(b.records.at(-1)!.track?.name, "Pad");
    // A track put first moves every track after it.
    const first = await tool(b.tools, "add_tracks_and_scenes").execute({ tracks: [{ name: "Intro", kind: "midi", index: 0 }], scenes: [] }, signal());
    assert.equal(first.isError, false, first.text);
    const moved = await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:1", volume: 0.6 }, signal());
    assert.equal(moved.isError, true, "positions after the new track moved, so those references need fresh discovery");
    assert.match(moved.text, /discovery in this turn/);
    const intro = await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.6 }, signal());
    assert.equal(intro.isError, false, "the new track's reference is current");
    assert.equal(b.records.at(-1)!.track?.name, "Intro");
  } finally { await b.integration.close(); }
});

test("one answer can make up to 500 changes, then checks with the producer", async () => {
  const b = await opened();
  try {
    for (let count = 0; count < 500; count++) assert.equal((await tool(b.tools, "set_tempo").execute({ tempo: 100 + count }, signal())).isError, false);
    const over = await tool(b.tools, "set_tempo").execute({ tempo: 150 }, signal());
    assert.equal(over.isError, true); assert.match(over.text, /check with the producer/);
    const next = await b.integration.observe(signal());
    assert.equal((await tool(next.tools, "set_tempo").execute({ tempo: 150 }, signal())).isError, false, "the next answer starts a fresh count");
  } finally { await b.integration.close(); }
});

test("every change kind has its own tool, a family, host-only bridge tools and a title from a bare preview", () => {
  const tools = new Set<string>();
  for (const kind of CHANGES) {
    assert(!tools.has(kind.tool), `${kind.tool} is unique`); tools.add(kind.tool);
    assert(!kind.tool.startsWith("live_"), "Kumi's change tools don't look like bridge tools");
    assert(HOST_TOOLS.has(kind.preview) && HOST_TOOLS.has(kind.apply));
    assert.match(kind.preview, /_preview$/); assert.match(kind.apply, /_apply$/);
    assert.doesNotMatch(kind.description, /confirm|idempotenc|transaction/i, "the model is never asked to confirm");
    const summary = kind.summarize({}, {}, () => undefined);
    assert(summary.title.trim().length > 3, `${kind.tool} has a title even without details`);
    assert(["tempo", "mixer", "rename", "structure", "clip", "device", "parameter", "locators", "color"].includes(kind.family));
  }
  assert(HOST_TOOLS.has("live_undo"));
  // Playing and recording are Kumi's tools now (used when the producer asks); capture, files, projects and realtime control stay off.
  assert(HOST_TOOLS.has("live_transport_apply") && HOST_TOOLS.has("live_recording_apply") && HOST_TOOLS.has("live_transport_action_apply"));
  for (const off of ["live_audio_capture_apply", "live_project_backup_apply", "live_realtime_arm_apply", "live_application_dialog_apply", "live_device_state_save"]) assert(!HOST_TOOLS.has(off), off);
});

test("note selections, note ranges and automation steps get titles of their own, and a selection no undo", () => {
  const notes = CHANGES.find((item) => item.tool === "edit_notes")!; const automation = CHANGES.find((item) => item.tool === "set_automation")!;
  assert.equal(notes.summarize({ action: "select", notes: 3 }, { action: "select", all: true }, () => undefined).title, "Clip: 3 notes selected");
  assert.equal(notes.summarize({ action: "delete-range", notes: 2 }, { action: "delete-range", fromPitch: 36, pitchSpan: 12, fromTime: 0, timeSpan: 4 }, () => undefined).title, "Clip: 2 notes deleted in a range");
  assert.equal(notes.summarize({ action: "duplicate" }, { action: "duplicate" }, () => undefined).title, "Clip: notes duplicated");
  assert.equal(notes.permanent?.({ action: "select", all: true }), "Selecting notes changes no notes: there's nothing to undo.");
  assert.equal(notes.permanent?.({ action: "delete-range" }), undefined, "a range deletion has its undo");
  assert.equal(automation.summarize({ action: "insert-step" }, { action: "insert-step", start: 0, length: 1, value: 0.5 }, () => undefined).title, "Clip: automation step drawn");
  assert.equal(automation.summarize({ action: "delete-envelope" }, { action: "delete-envelope" }, () => undefined).title, "Clip: automation lane removed");
});

test("a new clip's record carries its notes, for NOW's picture", () => {
  const kind = CHANGES.find((item) => item.tool === "write_midi_clip")!;
  const notes = [60, 64].map((pitch) => ({ pitch, start: 0, duration: 4, velocity: 96, channel: 1 }));
  const summary = kind.summarize({ proposed: { name: "Chord", length: 4, notes } }, {}, () => undefined);
  assert.equal(summary.title, "New MIDI clip “Chord” · 2 notes");
  assert.deepEqual(summary.clip, { length: 4, notes: notes.map(({ channel: _channel, ...note }) => note) });
  const many = kind.summarize({ proposed: { name: "Roll", length: 64, notes: Array.from({ length: 600 }, (_, index) => ({ pitch: 36, start: index / 10, duration: 0.1, velocity: 100 })) } }, {}, () => undefined);
  assert.equal(many.title, "New MIDI clip “Roll” · 600 notes"); assert.equal(many.clip?.notes.length, 512, "the picture keeps the first 512");
});

test("a device parameter's title uses Live's own text on both sides when the bridge read it", () => {
  const kind = CHANGES.find((item) => item.tool === "set_device_parameter")!;
  const preview = { device: { name: "Auto Filter", trackRef: "5:track:1" }, parameter: { name: "Frequency", currentValue: 0.6, proposedValue: 0.45, min: 0, max: 1, displayValue: "2.50 kHz" } };
  const bass = () => ({ name: "Bass" });
  const summary = kind.summarize(preview, {}, bass, { state: "applied", value: 0.45, displayValue: "1.21 kHz" });
  assert.equal(summary.title, "Auto Filter · Frequency 2.50\u00a0kHz → 1.21\u00a0kHz");
  assert.deepEqual([summary.from, summary.to, summary.range, summary.track], [0.6, 0.45, [0, 1], { name: "Bass" }], "the picture still has the numbers");
  assert.equal(kind.summarize(preview, {}, bass).title, "Auto Filter · Frequency 0.6 → 0.45", "without Live's text for the new value, plain numbers");
});

test("make_changes starts while the model is still writing it: each step runs once it's whole, and the result is the same", async () => {
  const b = await opened();
  try {
    let began = 0;
    const call = tool(b.tools, "make_changes").stream!(signal(), () => { began++; });
    const input = { steps: [
      { tool: "set_tempo", input: { tempo: 126 } },
      { tool: "set_mixer", input: { trackRef: "track:1", volume: 0.6 } },
      { tool: "rename", input: { kind: "track", ref: "track:2", name: "Drums {bus}" } },
    ], final: true };
    const text = JSON.stringify(input);
    const cut = text.indexOf("{\"tool\":\"set_mixer\"") + 12;
    call.push(text.slice(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(b.tempo, 126, "the first step ran while the rest was being written");
    assert.equal(began, 1); assert.equal(call.started, true);
    assert.ok(!b.requests.some((request) => request.name === "live_mixer_preview"), "a step runs only once it's whole");
    call.push(text.slice(cut));
    const result = await call.finish(input);
    assert.equal(result.isError, false, result.text);
    assert.deepEqual((JSON.parse(result.text) as { done: { step: number }[] }).done.map((step) => step.step), [1, 2, 3]);
    assert.match(result.reply ?? "", /^Done:\n- Tempo 120 → 126 BPM\n- Fixture Bass volume down\n- /);
    assert.equal(b.records.length, 3, "each with its own HISTORY entry and undo");
  } finally { await b.integration.close(); }
});

test("a streamed plan still sends a rack's pads as one change, and stops where a step turns out invalid", async () => {
  const b = await opened({ padBatches: true });
  const folder = mkdtempSync(join(tmpdir(), "kumi-stream-kit-"));
  try {
    for (const name of ["Kick.wav", "Snare.wav"]) writeFileSync(join(folder, name), Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"));
    const sample = { random: true, folders: [folder] };
    const kit = { steps: [
      { tool: "add_tracks_and_scenes", input: { tracks: [{ name: "Kit", kind: "midi" }], scenes: [] }, as: "track" },
      { tool: "load_device", input: { trackRef: "@track", itemId: "instruments/Drum Rack" }, as: "rack" },
      { tool: "load_sample_to_pad", input: { deviceRef: "@rack", note: 36, sample } },
      { tool: "load_sample_to_pad", input: { deviceRef: "@rack", note: 37, sample } },
    ] };
    const call = tool(b.tools, "make_changes").stream!(signal(), () => {});
    const text = JSON.stringify(kit);
    const padsFrom = text.indexOf("{\"tool\":\"load_sample_to_pad\"");
    const secondPad = text.indexOf("{\"tool\":\"load_sample_to_pad\"", padsFrom + 1);
    call.push(text.slice(0, secondPad));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(b.requests.some((request) => request.name === "live_browser_load_preview"), "the rack loaded while the pads were being written");
    assert.ok(!b.requests.some((request) => request.name === "live_drum_pad_preview"), "the first pad waits to see whether the next joins it");
    call.push(text.slice(secondPad));
    const result = await call.finish(kit);
    assert.equal(result.isError, false, result.text);
    const pads = b.requests.filter((request) => request.name === "live_drum_pad_preview");
    assert.equal(pads.length, 1); assert.equal(pads[0]!.args.action, "load-samples", "both pads in one Live request");

    const uneven = { steps: [{ tool: "set_tempo", input: { tempo: 128 } }, { tool: "set_mixer", input: {}, each: { trackRef: ["track:1", "track:2"], volume: [0.6] } }] };
    const later = tool(b.tools, "make_changes").stream!(signal(), () => {});
    later.push(JSON.stringify(uneven));
    const stopped = await later.finish(uneven);
    assert.equal(stopped.isError, true); assert.equal(b.tempo, 128, "the step before the invalid one had happened");
    assert.deepEqual((JSON.parse(stopped.text) as { stopped: { step: number; error: string } }).stopped.step, 2);
    assert.match(stopped.text, /lists of one length/);
    // Written whole (no pieces streamed), an invalid plan changes nothing, as ever.
    const whole = tool(b.tools, "make_changes").stream!(signal(), () => {});
    const refused = await whole.finish({ steps: [{ tool: "set_tempo", input: { tempo: 90 } }, uneven.steps[1]] });
    assert.equal(refused.isError, true); assert.equal(b.tempo, 128);
  } finally { rmSync(folder, { recursive: true, force: true }); await b.integration.close(); }
});

test("a parameter can be named rather than referenced, found on the device when the step runs: plans and recipes set devices they loaded", async () => {
  const b = await opened({ parameters: true });
  try {
    const context = JSON.parse(b.observation.context) as { tracks: { devices?: { ref: string; name: string }[] }[] };
    const operator = context.tracks[0]!.devices!.find((device) => device.name === "Operator")!.ref;
    const one = await tool(b.tools, "set_device_parameter").execute({ deviceRef: operator, parameter: "filter freq", value: 0.3 }, signal());
    assert.equal(one.isError, false, one.text);
    assert.equal(b.requests.filter((request) => request.name === "live_device_parameter_preview").at(-1)!.args.parameterRef, "7:parameter:1", "found by its name on the device");
    const plan = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "set_device_parameter", input: { deviceRef: operator, parameter: "Osc-A Level", value: 0.8 } },
      { tool: "set_device_parameter", input: { deviceRef: operator, parameter: "Ae Rel", value: 0.2 } },
    ] }, signal());
    assert.equal(plan.isError, false, plan.text);
    const batched = b.requests.filter((request) => request.name === "live_device_parameter_preview").at(-1)!;
    assert.deepEqual(batched.args.values, [{ parameterRef: "7:parameter:0", value: 0.8 }, { parameterRef: "7:parameter:2", value: 0.2 }], "named steps on one device still go as one change; a prefix finds the name");
    const unknown = await tool(b.tools, "set_device_parameter").execute({ deviceRef: operator, parameter: "Wobble", value: 1 }, signal());
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /no parameter called "Wobble"; its parameters include Osc-A Level, Filter Freq, Ae Release/);
  } finally { await b.integration.close(); }
});

test("a parameter named past the device's first page of parameters is found", async () => {
  const b = await opened({ parameters: true, manyParameters: true });
  try {
    const context = JSON.parse(b.observation.context) as { tracks: { devices?: { ref: string; name: string }[] }[] };
    const operator = context.tracks[0]!.devices!.find((device) => device.name === "Operator")!.ref;
    const set = await tool(b.tools, "set_device_parameter").execute({ deviceRef: operator, parameter: "Feedback", value: 0.4 }, signal());
    assert.equal(set.isError, false, set.text);
    assert.equal(b.requests.filter((request) => request.name === "live_device_parameter_preview").at(-1)!.args.parameterRef, "7:parameter:149");
  } finally { await b.integration.close(); }
});

test("an undo the bridge refused says the real reason in HISTORY", () => {
  assert.match(undoNote("Undo refused before anything changed in Live: request failed: Live doesn't offer Ext. In for this track now; nothing changed"), /^Live doesn't offer what it was routed from/);
  assert.match(undoNote("Undo refused before anything changed in Live: request failed: transaction-owned structure cleanup must proceed from the highest positional authority"), /^A track Kumi made after it is still there/);
  assert.match(undoNote("transport undo refused while playing: only the playhead changed; stop playback first"), /^Stop playback, then undo it/);
  assert.equal(undoNote("routing changed after apply; undo refused"), "It changed in Live since, so Kumi left it as it is.");
});

test("before a plan of three steps or more, or one that deletes, Kumi keeps a copy of the Set as last saved, once for each saved version", async () => {
  const folder = mkdtempSync(join(tmpdir(), "kumi-backup-"));
  const saved = join(folder, "Song.als"); writeFileSync(saved, "set");
  const b = await opened({ savedSet: saved });
  try {
    const plan = () => tool(b.tools, "make_changes");
    const backups = () => b.requests.filter((request) => request.name === "live_project_backup_apply").length;
    const small = await plan().execute({ steps: [{ tool: "set_tempo", input: { tempo: 121 } }, { tool: "set_tempo", input: { tempo: 122 } }] }, signal());
    assert.equal(small.isError, false, small.text);
    assert.equal(backups(), 0, "two steps: no copy");
    const big = await plan().execute({ steps: [121, 122, 123].map((tempo) => ({ tool: "set_tempo", input: { tempo } })), final: true }, signal());
    assert.equal(big.isError, false, big.text);
    assert.equal(b.requests.find((request) => request.name === "live_project_backup_preview")!.args.allowedRoot, folder, "next to the Set");
    assert.equal(JSON.parse(big.text).copy, join(folder, "Song.backup-5.als"));
    assert.match(String(big.reply), /kept a copy of your Set as last saved, next to it: Song\.backup-5\.als$/);
    await plan().execute({ steps: [124, 125, 126].map((tempo) => ({ tool: "set_tempo", input: { tempo } })) }, signal());
    assert.equal(backups(), 1, "the same saved version is copied once");
    // Saved again: a new version, copied before the next big plan.
    utimesSync(saved, new Date(), new Date(Date.now() + 5_000));
    const again = await plan().execute({ steps: [127, 128, 129].map((tempo) => ({ tool: "set_tempo", input: { tempo } })) }, signal());
    assert.equal(backups(), 2);
    assert.ok(JSON.parse(again.text).copyNote);
  } finally { await b.integration.close(); rmSync(folder, { recursive: true, force: true }); }
  // An unsaved Set has nothing to copy, and the plan goes ahead.
  const unsaved = await opened();
  try {
    const result = await tool(unsaved.tools, "make_changes").execute({ steps: [121, 122, 123].map((tempo) => ({ tool: "set_tempo", input: { tempo } })) }, signal());
    assert.equal(result.isError, false); assert.equal(JSON.parse(result.text).copy, undefined);
  } finally { await unsaved.integration.close(); }
});

test("chain mixer discovery accepts a fresh chain and mapping targets require fresh provenance", async () => {
  const b = await opened({ racks: true });
  try {
    const result = await tool(b.tools, "live_discover").execute({ kind: "parameter", parent: "7:chain:0:0:0" }, signal());
    assert.equal(result.isError, false, result.text);
    assert(b.requests.some(request => request.name === "live_discover" && request.args.kind === "parameter" && request.args.parent === "7:chain:0:0:0"));
    const before = b.requests.length;
    const stale = await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.5, targetRef: "7:parameter:stale" }, signal());
    assert.equal(stale.isError, true);
    assert.match(stale.text, /targetRef.*discovery/);
    assert(!b.requests.slice(before).some(request => request.name.endsWith("_preview") || request.name.endsWith("_apply")));
  } finally { await b.integration.close(); }
});


test("launch Legato can be planned before clips exist without bypassing bridge readiness", async () => {
  const b = await opened();
  try {
    const edit = tool(b.tools, "set_clip");
    assert.equal((edit.inputSchema.properties as JsonObject).legato && ((edit.inputSchema.properties as JsonObject).legato as JsonObject).type, "boolean");
    const result = await edit.execute({ clipRef: "clip:missing", legato: true }, signal());
    assert.equal(result.isError, true);
    assert.match(result.text, /Create a clip first/);
    assert.match(CHANGES.find(kind => kind.tool === "set_clip_follow_actions")!.description, /set_clip with legato: true/);
  } finally { await b.integration.close(); }
});


test("new MIDI clip aliases feed Legato and Follow Actions in the same plan", async () => {
  const b = await opened({ midiClips: true });
  try {
    const result = await tool(b.tools, "make_changes").execute({ steps: [
      { tool: "write_midi_clip", as: "a", input: { trackRef: "track:1", sceneIndex: 0, name: "A", length: 8, notes: [] } },
      { tool: "write_midi_clip", as: "b", input: { trackRef: "track:1", sceneIndex: 1, name: "B", length: 8, notes: [] } },
      { tool: "set_clip", input: { clipRef: "@a", legato: true } },
      { tool: "set_clip_follow_actions", input: { clipRef: "@b", followActionEnabled: true } },
    ] }, signal());
    assert.equal(result.isError, false, result.text);
    assert.equal(JSON.parse(result.text).done.length, 4);
    assert.equal(b.requests.find(r => r.name === "live_clip_properties_preview")?.args.clipRef, "7:clip:0:0");
    assert.equal(b.requests.find(r => r.name === "live_follow_actions_preview")?.args.clipRef, "7:clip:0:1");
  } finally { await b.integration.close(); }
});


test("a new MIDI clip is a valid note-discovery parent and set_clip uses the advertised schema", async () => {
  const b = await opened({ midiClips: true });
  try {
    const result = await tool(b.tools, "write_midi_clip").execute({ trackRef: "track:1", sceneIndex: 0, length: 8, notes: [] }, signal());
    assert.equal(result.isError, false, result.text);
    const clipRef = JSON.parse(result.text).ref;
    const notes = await tool(b.tools, "live_discover").execute({ kind: "note", parent: clipRef }, signal());
    assert.equal(notes.isError, false, notes.text);
    assert(b.requests.some(r => r.name === "live_discover" && r.args.kind === "note" && r.args.parent === "7:clip:0:0"));
    const observation = await b.integration.observe(signal());
    const schema = tool(observation.tools, "set_clip").inputSchema as JsonObject;
    assert.deepEqual((schema.properties as JsonObject).grooveRef, { type: ["string", "null"] });
  } finally { await b.integration.close(); }
});
