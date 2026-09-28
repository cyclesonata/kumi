import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ChangeRecord, JsonObject, KernelTool } from "../src/core/contracts.js";
import type { McpEndpoint } from "../src/mcp/client.js";
import { CHANGES, HOST_TOOLS, UNDO_TOOL } from "../src/integrations/ableton/changes.js";
import { createAbletonIntegration } from "../src/integrations/ableton/index.js";

// Synthetic bridge responses shaped like the real ones recorded in .pi/kumi-evidence (previews
// return prior and proposed values, a transaction id and a confirmation; applies return a state).
function bridge() {
  const requests: { name: string; args: JsonObject }[] = [];
  const records: ChangeRecord[] = [];
  let tempo = 120;
  let live = true; let epoch = 7;
  let tracks = [{ name: "Fixture Bass", color: 0xf7f47c }, { name: "Fixture Drums", color: 0x10ff00 }];
  let undoRefusal: string | undefined;
  let applyFailure: "throw" | "uncertain" | "unreadable" | undefined;
  let gate: { sent: () => void; wait: Promise<void> } | undefined;
  const names = ["server_status", "live_status", "live_discover", "live_snapshot", "live_undo",
    "live_tempo_preview", "live_tempo_apply", "live_mixer_preview", "live_mixer_apply",
    "live_session_structure_preview", "live_session_structure_apply", "live_object_rename_preview", "live_object_rename_apply", "live_audio_capture_apply", "live_transport_apply",
    "live_track_properties_preview", "live_track_properties_apply", "live_device_preview", "live_device_apply"];
  const catalog: Tool[] = names.map((name) => ({ name, description: `bridge ${name}`, inputSchema: name === "live_session_structure_preview"
    ? { type: "object", properties: { tracks: { type: "array", items: { type: "object", properties: { name: { type: "string" }, kind: { type: "string" }, index: { type: "integer", description: "request order" } } } }, scenes: { type: "array" } } }
    : { type: "object", properties: {}, additionalProperties: true } }));
  const wrap = (value: JsonObject): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  const refusal = (text: string, extra: JsonObject = {}): CallToolResult => ({ isError: true, content: [{ type: "text", text }], structuredContent: { message: text, ...extra } });
  const pending = new Map<string, { name: string; args: JsonObject }>();
  const catalogListeners = new Set<() => void>();
  let transactions = 0;
  const endpoint: McpEndpoint = {
    pid: null, serverInfo: { name: "kumi-synthetic-bridge", version: "1" }, stderrStatus: () => ({ bytes: 0, truncated: false }),
    async list() { return { tools: catalog }; },
    async call(name, args, signal) {
      signal.throwIfAborted(); requests.push({ name, args: structuredClone(args) });
      if (name === "live_status") return wrap({ connected: live, adapter: "remote-script", provenance: "fake-live", epoch: live ? epoch : null });
      if (name === "live_discover") {
        const set = { ref: "7:set:song", objectIdentity: "song", name: "Fixture Set", tempo };
        const items = args.kind === "set" ? [set] : args.kind === "track"
          ? tracks.map((track, index) => ({ ref: `7:track:${index}`, parentRef: set.ref, name: track.name, color: track.color })) : [];
        return wrap({ epoch: 7, kind: args.kind, items, revision: "r1", truncated: false });
      }
      if (name.endsWith("_preview")) {
        const id = `tx${++transactions}`;
        pending.set(id, { name, args });
        const base = { transactionId: id, epoch: 7, confirmation: name === "live_mixer_preview" ? "secret-confirmation-token-0123456789" : "apply" };
        if (name === "live_tempo_preview") return wrap({ ...base, priorTempo: tempo, proposedTempo: args.tempo });
        if (name === "live_mixer_preview") return wrap({ ...base, trackRef: args.trackRef, prior: { volume: 0.85, pan: 0 }, ...(args.volume === 0.4 ? { priorDisplay: { volume: "0.0 dB", pan: "C" } } : {}), proposed: { volume: args.volume, pan: args.pan } });
        if (name === "live_object_rename_preview") return wrap({ ...base, target: { kind: args.kind, ref: args.ref, currentName: tracks[Number(String(args.ref).split(":").at(-1))]?.name }, proposedName: args.name });
        if (name === "live_track_properties_preview") return wrap({ ...base, ref: args.ref, prior: { colorIndex: 4 }, proposed: { colorIndex: args.colorIndex } });
        if (name === "live_device_preview") return wrap({ ...base, action: args.action, payload: { trackRef: args.trackRef, deviceName: args.deviceName }, sample: { path: args.filePath, size: 18 } });
        const proposed = [...(Array.isArray(args.tracks) ? args.tracks as JsonObject[] : []).map((item) => ({ kind: "track", name: item.name, trackKind: item.kind, index: item.index ?? 0 }))];
        return wrap({ ...base, prior: { tracks: tracks.map((track, index) => ({ ref: `7:track:${index}`, name: track.name, index })), scenes: [] }, proposed });
      }
      if (name.endsWith("_apply")) {
        const transaction = pending.get(String(args.transactionId));
        assert(transaction, "apply names a previewed transaction");
        if (gate) { const held = gate; gate = undefined; held.sent(); await held.wait; }
        if (applyFailure === "throw") throw new Error("socket closed");
        if (applyFailure === "uncertain") return refusal("Apply is uncertain; perform fresh discovery.", { state: "uncertain" });
        if (applyFailure === "unreadable") return { content: [{ type: "text", text: "not json" }] };
        if (transaction.name === "live_tempo_preview") tempo = Number(transaction.args.tempo);
        if (transaction.name === "live_session_structure_preview") {
          const added = (transaction.args.tracks as JsonObject[]).map((item) => ({ name: String(item.name), color: 0 }));
          tracks = [...tracks, ...added];
          return wrap({ transactionId: args.transactionId, state: "applied", created: added.map((item, index) => ({ kind: "track", ref: `7:track:${tracks.length - added.length + index}`, name: item.name })) });
        }
        if (transaction.name === "live_mixer_preview" && transaction.args.volume === 0.4) return wrap({ transactionId: args.transactionId, state: "applied", display: { volume: "-9.3 dB", pan: "25L" } });
        if (transaction.name === "live_device_preview") return wrap({ transactionId: args.transactionId, state: "applied", result: { ref: "7:device:0:0", objectIdentity: "device-identity", samplePath: "/staged/Kick Deep.wav" } });
        if (transaction.name === "live_track_properties_preview") {
          const track = tracks[Number(String(transaction.args.ref).split(":").at(-1))]!;
          track.color = 0xe553a0;
          return wrap({ transactionId: args.transactionId, state: "applied", color: track.color });
        }
        return wrap({ transactionId: args.transactionId, state: "applied" });
      }
      if (name === "live_undo") {
        if (undoRefusal) return refusal(undoRefusal);
        const transaction = pending.get(String(args.transactionId));
        if (transaction?.name === "live_tempo_preview") tempo = 120;
        return wrap({ transactionId: args.transactionId, state: "undone", idempotent: false });
      }
      return wrap({});
    },
    onCatalogChanged(listener) { catalogListeners.add(listener); return () => { catalogListeners.delete(listener); }; },
    onDisconnect() { return () => {}; },
    async close() {},
  };
  const states: string[] = [];
  const integration = createAbletonIntegration({ connect: async () => endpoint, onConnection: (state) => states.push(state), onChange: (change) => records.push(change), changeTimeoutMs: 2_000, reconnectIntervalMs: 10 });
  return {
    integration, requests, records, states, get tempo() { return tempo; },
    liveAway: () => { live = false; },
    liveBack: () => { live = true; epoch++; },
    refuseUndo: (text: string) => { undoRefusal = text; },
    /** The bridge re-negotiates its tools after content changes and says so. */
    catalogChanged: () => { for (const listener of catalogListeners) listener(); },
    failApply: (how: "throw" | "uncertain" | "unreadable") => { applyFailure = how; },
    holdApply: () => {
      let sent!: () => void; let release!: () => void;
      const began = new Promise<void>((resolve) => { sent = resolve; });
      gate = { sent, wait: new Promise<void>((resolve) => { release = resolve; }) };
      return { began, release };
    },
  };
}
const signal = () => new AbortController().signal;
function tool(tools: readonly KernelTool[], name: string) { const found = tools.find((item) => item.name === name); assert(found, `${name} is offered`); return found; }
async function opened() {
  const b = bridge();
  await b.integration.start(signal());
  const observation = await b.integration.observe(signal());
  // Keep the fixture's getters live (a spread would copy their current values).
  return Object.assign(b, { tools: observation.tools, observation });
}

test("a change tool previews and applies in one step, keeps confirmations away from the model and records the change", async () => {
  const b = await opened();
  try {
    const names = b.tools.map((item) => item.name);
    assert(names.includes("set_tempo") && names.includes("set_mixer") && names.includes(UNDO_TOOL));
    for (const name of names) assert(!/_apply$|_preview$|^live_undo$/.test(name), `${name} is not a bridge preview, apply or undo`);
    assert(!names.includes("live_audio_capture_apply") && !names.includes("live_transport_apply"), "tools outside Kumi's changes stay hidden");
    assert(!names.includes("load_device"), "a change is offered only while the bridge advertises it");
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

test("changes need references from this turn's discovery; HISTORY gets the track's name and colour from it", async () => {
  const b = await opened();
  try {
    const stale = await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.6 }, signal());
    assert.equal(stale.isError, true); assert.match(stale.text, /discovery in this turn/);
    assert(!b.requests.some((request) => request.name === "live_mixer_preview"), "nothing is previewed with a stale reference");
    await tool(b.tools, "live_discover").execute({ kind: "track" }, signal());
    const result = await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.6, pan: -0.25 }, signal());
    assert.equal(result.isError, false, result.text);
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
    const next = await b.integration.observe(signal());
    const again = await tool(next.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.5 }, signal());
    assert.equal(again.isError, true, "a new turn needs fresh discovery again");
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

test("new tracks go after the last one, and a structure change retires earlier references", async () => {
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
    const old = await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.7 }, signal());
    assert.equal(old.isError, true, "positions moved, so earlier references need fresh discovery");
    const created = await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:2", volume: 0.7 }, signal());
    assert.equal(created.isError, false, "the new track's own reference is current");
    assert.equal(b.records.at(-1)!.track?.name, "Pad");
  } finally { await b.integration.close(); }
});

test("one answer can make at most 40 changes", async () => {
  const b = await opened();
  try {
    for (let count = 0; count < 40; count++) assert.equal((await tool(b.tools, "set_tempo").execute({ tempo: 100 + count }, signal())).isError, false);
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
  assert(!HOST_TOOLS.has("live_audio_capture_apply") && !HOST_TOOLS.has("live_recording_apply") && !HOST_TOOLS.has("live_transport_apply"));
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
