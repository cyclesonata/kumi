import assert from "node:assert/strict";
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
  let tracks = [{ name: "Fixture Bass", color: 0xf7f47c }, { name: "Fixture Drums", color: 0x10ff00 }];
  let undoRefusal: string | undefined;
  let applyFailure: "throw" | "uncertain" | undefined;
  let gate: { sent: () => void; wait: Promise<void> } | undefined;
  const names = ["server_status", "live_status", "live_discover", "live_snapshot", "live_undo",
    "live_tempo_preview", "live_tempo_apply", "live_mixer_preview", "live_mixer_apply",
    "live_session_structure_preview", "live_session_structure_apply", "live_object_rename_preview", "live_object_rename_apply", "live_audio_capture_apply", "live_transport_apply"];
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
      if (name === "live_status") return wrap({ connected: true, adapter: "remote-script", provenance: "fake-live", epoch: 7 });
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
        if (name === "live_mixer_preview") return wrap({ ...base, trackRef: args.trackRef, prior: { volume: 0.85, pan: 0 }, proposed: { volume: args.volume, pan: args.pan } });
        if (name === "live_object_rename_preview") return wrap({ ...base, target: { kind: args.kind, ref: args.ref, currentName: tracks[Number(String(args.ref).split(":").at(-1))]?.name }, proposedName: args.name });
        const proposed = [...(Array.isArray(args.tracks) ? args.tracks as JsonObject[] : []).map((item) => ({ kind: "track", name: item.name, trackKind: item.kind, index: item.index ?? 0 }))];
        return wrap({ ...base, prior: { tracks: tracks.map((track, index) => ({ ref: `7:track:${index}`, name: track.name, index })), scenes: [] }, proposed });
      }
      if (name.endsWith("_apply")) {
        const transaction = pending.get(String(args.transactionId));
        assert(transaction, "apply names a previewed transaction");
        if (gate) { const held = gate; gate = undefined; held.sent(); await held.wait; }
        if (applyFailure === "throw") throw new Error("socket closed");
        if (applyFailure === "uncertain") return refusal("Apply is uncertain; perform fresh discovery.", { state: "uncertain" });
        if (transaction.name === "live_tempo_preview") tempo = Number(transaction.args.tempo);
        if (transaction.name === "live_session_structure_preview") {
          const added = (transaction.args.tracks as JsonObject[]).map((item) => ({ name: String(item.name), color: 0 }));
          tracks = [...tracks, ...added];
          return wrap({ transactionId: args.transactionId, state: "applied", created: added.map((item, index) => ({ kind: "track", ref: `7:track:${tracks.length - added.length + index}`, name: item.name })) });
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
  const integration = createAbletonIntegration({ connect: async () => endpoint, onConnection: () => {}, onChange: (change) => records.push(change), changeTimeoutMs: 2_000 });
  return {
    integration, requests, records, get tempo() { return tempo; },
    refuseUndo: (text: string) => { undoRefusal = text; },
    /** The bridge re-negotiates its tools after content changes and says so. */
    catalogChanged: () => { for (const listener of catalogListeners) listener(); },
    failApply: (how: "throw" | "uncertain") => { applyFailure = how; },
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
    assert.equal(change.title, "Fixture Bass volume down, pan left");
    assert.deepEqual(change.track, { name: "Fixture Bass", color: "#f7f47c" });
    assert.equal(change.from, 0.85); assert.equal(change.to, 0.6);
    await tool(b.tools, "rename").execute({ kind: "track", ref: "7:track:0", name: "Sub" }, signal());
    assert.equal(b.records.at(-1)!.title, "Renamed track “Fixture Bass” → “Sub”");
    await tool(b.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.55 }, signal());
    assert.equal(b.records.at(-1)!.track?.name, "Sub", "later changes use the new name");
    const next = await b.integration.observe(signal());
    const again = await tool(next.tools, "set_mixer").execute({ trackRef: "7:track:0", volume: 0.5 }, signal());
    assert.equal(again.isError, true, "a new turn needs fresh discovery again");
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
  for (const how of ["throw", "uncertain"] as const) {
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
