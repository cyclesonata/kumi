/** A bridge in memory, shaped like the real one's responses, for the Ableton integration's tests. */
import assert from "node:assert/strict";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ChangeRecord, JsonObject, KernelTool } from "../../src/core/contracts.js";
import type { McpEndpoint } from "../../src/mcp/client.js";
import { createAbletonIntegration } from "../../src/integrations/ableton/index.js";

// Synthetic bridge responses shaped like the real ones recorded in .pi/kumi-evidence (previews
// return prior and proposed values, a transaction id and a confirmation; applies return a state).
export function bridge(options: { padBatches?: boolean; parameters?: boolean; racks?: boolean } = {}) {
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
    "live_track_properties_preview", "live_track_properties_apply", "live_device_preview", "live_device_apply", "live_drum_pad_preview", "live_drum_pad_apply",
    "live_browser_load_preview", "live_browser_load_apply", ...(options.parameters ? ["live_device_parameter_preview", "live_device_parameter_apply"] : []),
    ...(options.racks ? ["live_rack_preview", "live_rack_apply", "live_chain_mixer_preview", "live_chain_mixer_apply"] : [])];
  // Like the bridge, drum pad tools appear once the Set has a Drum Rack.
  let drumRack = false;
  const catalog: Tool[] = names.map((name) => ({ name, description: `bridge ${name}`, inputSchema: name === "live_session_structure_preview"
    ? { type: "object", properties: { tracks: { type: "array", items: { type: "object", properties: { name: { type: "string" }, kind: { type: "string" }, index: { type: "integer", description: "request order" } } } }, scenes: { type: "array" } } }
    : name === "live_drum_pad_preview" && options.padBatches ? { type: "object", properties: { action: { type: "string", enum: ["set", "delete-all-chains", "load-sample", "load-samples"] } }, additionalProperties: true }
    : name === "live_device_parameter_preview" ? { type: "object", properties: { deviceRef: { type: "string" }, parameterRef: { type: "string" }, value: { type: "number" }, values: { type: "array" } }, additionalProperties: true }
    : { type: "object", properties: {}, additionalProperties: true } }));
  const wrap = (value: JsonObject): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  const refusal = (text: string, extra: JsonObject = {}): CallToolResult => ({ isError: true, content: [{ type: "text", text }], structuredContent: { message: text, ...extra } });
  const pending = new Map<string, { name: string; args: JsonObject }>();
  const catalogListeners = new Set<() => void>();
  let transactions = 0;
  const endpoint: McpEndpoint = {
    pid: null, serverInfo: { name: "kumi-synthetic-bridge", version: "1" }, stderrStatus: () => ({ bytes: 0, truncated: false }),
    async list() { return { tools: catalog.filter((tool) => drumRack || !tool.name.startsWith("live_drum_pad_")) }; },
    async call(name, args, signal) {
      signal.throwIfAborted(); requests.push({ name, args: structuredClone(args) });
      if (name === "live_status") return wrap({ connected: live, adapter: "remote-script", provenance: "fake-live", epoch: live ? epoch : null });
      if (name === "live_discover") {
        const set = { ref: "7:set:song", objectIdentity: "song", name: "Fixture Set", tempo };
        const items = args.kind === "set" ? [set] : args.kind === "track"
          ? tracks.map((track, index) => ({ ref: `7:track:${index}`, parentRef: set.ref, name: track.name, color: track.color }))
          : args.kind === "device" && options.racks ? [
            { ref: "7:device:0:0", parentRef: "7:track:0", name: "Instrument Rack", className: "InstrumentGroupDevice", chainList: [{ ref: "7:chain:0:0:0", name: "Keys" }, { ref: "7:chain:0:0:1", name: "Pad" }] },
            { ref: "7:device:0:0:0:0", parentRef: "7:chain:0:0:0", name: "Operator", className: "Operator" },
            { ref: "7:device:0:1", parentRef: "7:track:0", name: "Reverb", className: "Reverb" }]
          : args.kind === "device" && options.parameters ? [{ ref: "7:device:0:0", parentRef: "7:track:0", name: "Operator", className: "Operator" }]
          : args.kind === "parameter" && options.parameters ? ["Osc-A Level", "Filter Freq", "Ae Release"].map((name, index) => ({ ref: `7:parameter:${index}`, parentRef: "7:device:0:0", name, value: 0, min: 0, max: 1 })) : [];
        // Like the bridge, a parent narrows the rows to those it holds.
        return wrap({ epoch: 7, kind: args.kind, items: args.parent === undefined ? items : (items as JsonObject[]).filter((item) => item.parentRef === args.parent), revision: "r1", truncated: false });
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
        if (name === "live_drum_pad_preview" && args.action === "load-samples") return wrap({ ...base, action: args.action, deviceRef: args.deviceRef, pads: (args.pads as JsonObject[]).map((pad) => ({ padRef: `7:drum_pad:0:0:${String(pad.note)}`, note: pad.note, sample: { path: pad.filePath } })) });
        if (name === "live_drum_pad_preview") return wrap({ ...base, action: args.action, padRef: `7:drum_pad:0:0:${String(args.note)}`, note: args.note, sample: { path: args.filePath } });
        if (name === "live_browser_load_preview") return wrap({ ...base, trackRef: args.trackRef ?? "7:track:0", item: { name: String(args.itemId).split("/").at(-1) }, ...(args.chainRef ? { chainRef: args.chainRef, chainName: "Keys", rackName: "Instrument Rack" } : {}) });
        if (name === "live_rack_preview") return wrap({ ...base, action: args.action, rackRef: args.rackRef, rackName: "Instrument Rack", prior: args.action === "add-macro" ? { visibleMacroCount: 8 } : {}, impact: args.action === "insert-chain" ? "momentary-rack-action-no-undo" : "edits-rack" });
        if (name === "live_chain_mixer_preview") return wrap({ ...base, chainRef: args.chainRef, chainName: "Pad", rackName: "Instrument Rack", prior: { volume: 0.85, pan: 0 }, proposed: { volume: args.volume, pan: args.pan } });
        if (name === "live_device_parameter_preview") {
          const device = { ref: args.deviceRef, name: "Operator", trackRef: "7:track:0" };
          const row = (parameterRef: unknown, value: unknown) => ({ ref: parameterRef, name: ["Osc-A Level", "Filter Freq", "Ae Release"][Number(String(parameterRef).split(":").at(-1))], currentValue: 0, proposedValue: value, min: 0, max: 1 });
          return wrap(Array.isArray(args.values) ? { ...base, device, parameters: (args.values as JsonObject[]).map((item) => row(item.parameterRef, item.value)) } : { ...base, device, parameter: row(args.parameterRef, args.value) });
        }
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
        if (transaction.name === "live_drum_pad_preview" && transaction.args.action === "load-samples") return wrap({ transactionId: args.transactionId, state: "applied", result: { pads: (transaction.args.pads as JsonObject[]).map((pad) => ({ ref: `7:drum_pad:0:0:${String(pad.note)}`, route: "hotswap" })) } });
        if (transaction.name === "live_drum_pad_preview") return wrap({ transactionId: args.transactionId, state: "applied", result: { ref: `7:drum_pad:0:0:${String(transaction.args.note)}`, route: "chain", samplePath: "/staged/Kick Deep.wav" } });
        if (transaction.name === "live_device_parameter_preview") return wrap({ transactionId: args.transactionId, state: "applied", ...(Array.isArray(transaction.args.values) ? { parameters: (transaction.args.values as JsonObject[]).map((item) => ({ ref: item.parameterRef, value: item.value, revision: 2 })) } : { value: transaction.args.value }) });
        if (transaction.name === "live_browser_load_preview") {
          // Like the bridge, a Drum Rack in the Set brings the pad tools.
          if (String(transaction.args.itemId).endsWith("Drum Rack")) { drumRack = true; for (const listener of catalogListeners) listener(); }
          if (transaction.args.chainRef) return wrap({ transactionId: args.transactionId, state: "applied", deviceRef: "7:device:0:0:2:0",
            placement: { owner: "chain", rack: "Instrument Rack", chain: 2, index: 0, chains: [{ name: "Keys", devices: ["Operator"] }, { name: "Pad", devices: [] }, { name: "Bells", devices: ["Collision"] }] } });
          return wrap({ transactionId: args.transactionId, state: "applied", deviceRef: `7:device:${String(transaction.args.trackRef).split(":").at(-1)}:0` });
        }
        if (transaction.name === "live_rack_preview") {
          if (transaction.args.action === "insert-chain") return wrap({ transactionId: args.transactionId, state: "applied", chainRef: "7:chain:0:0:2",
            placement: { owner: "rack", rack: "Instrument Rack", chain: 2, chains: [{ name: "Keys", devices: ["Operator"] }, { name: "Pad", devices: [] }, { name: "Chain", devices: [] }] } });
          return wrap({ transactionId: args.transactionId, state: "applied", visibleMacroCount: 9 });
        }
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
  let settledDepth = 0; let deepest = 0;
  const answer = endpoint.call.bind(endpoint);
  endpoint.call = async (name: string, args: JsonObject, signal: AbortSignal) => {
    const depth = settledDepth + 1; deepest = Math.max(deepest, depth);
    try { return await answer(name, args, signal); } finally { settledDepth = Math.max(settledDepth, depth); }
  };
  const states: string[] = [];
  const integration = createAbletonIntegration({ connect: async () => endpoint, onConnection: (state) => states.push(state), onChange: (change) => records.push(change), changeTimeoutMs: 2_000, reconnectIntervalMs: 10 });
  return {
    integration, requests, records, states, get tempo() { return tempo; },
    /** How many Live round trips `work` waited for one after another; concurrent ones count once. */
    async roundTrips<T>(work: () => Promise<T>): Promise<{ value: T; trips: number; calls: number }> {
      const before = requests.length; settledDepth = 0; deepest = 0;
      const value = await work();
      return { value, trips: deepest, calls: requests.length - before };
    },
    liveAway: () => { live = false; },
    liveBack: () => { live = true; epoch++; },
    refuseUndo: (text: string) => { undoRefusal = text; },
    /** The bridge re-negotiates its tools after content changes and says so. */
    catalogChanged: () => { for (const listener of catalogListeners) listener(); },
    addDrumRack: () => { drumRack = true; for (const listener of catalogListeners) listener(); },
    deleteLastTrack: () => { tracks = tracks.slice(0, -1); },
    failApply: (how: "throw" | "uncertain" | "unreadable") => { applyFailure = how; },
    holdApply: () => {
      let sent!: () => void; let release!: () => void;
      const began = new Promise<void>((resolve) => { sent = resolve; });
      gate = { sent, wait: new Promise<void>((resolve) => { release = resolve; }) };
      return { began, release };
    },
  };
}
export const signal = () => new AbortController().signal;
export function tool(tools: readonly KernelTool[], name: string) { const found = tools.find((item) => item.name === name); assert(found, `${name} is offered`); return found; }
export async function opened(options: { padBatches?: boolean; parameters?: boolean; racks?: boolean } = {}) {
  const b = bridge(options);
  await b.integration.start(signal());
  const observation = await b.integration.observe(signal());
  // Keep the fixture's getters live (a spread would copy their current values).
  return Object.assign(b, { tools: observation.tools, observation });
}
