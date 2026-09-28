import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect as connectSocket } from "node:net";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CatchUp, ChangeRecord, ConnectionState, Integration, JsonObject, KernelTool, LiveFocus, Observation } from "../../core/contracts.js";
import { KumiError } from "../../core/errors.js";
import { connectMcp, type McpEndpoint } from "../../mcp/client.js";
import { AllowedTools, MODEL_TOOLS } from "../../mcp/allowed-tools.js";
import { discoveryArgs, discoveryPayload, INSTRUCTIONS, object, ObservationError, PARENTS, payload, queryKey, setIdentity, statusPayload } from "./context.js";
import { defaultSampleFolders, findSamples, folderPath, type Sample } from "./samples.js";
import { CHANGES, hexColor, HOST_TOOLS, newRecord, type ChangeContext, type SampleSelector, REFERENCE_FIELDS, UNDO_DESCRIPTION, UNDO_TOOL, undoNote, type ChangeKind, type KnownTrack } from "./changes.js";
import { startFocusFeed, type FocusFeed } from "./focus.js";
import { catchUpFrom, describeDiff, projectIdOf, since, type Baseline, type ProjectStore } from "./project.js";

/** Bridge tools Kumi uses to catch up on a Set; never offered to the model. */
const PROJECT_TOOLS = ["live_project_info", "live_project_snapshot_export", "live_project_snapshot_diff"];
/** Keys whose values are Live references: ref, parent, trackRef, parentRef, selectedTrackRef… */
const REF_KEY = /^(?:ref|parent)$|Refs?$/;
/** Live's references: an epoch, a kind and a path ("1232800184424618:track:4"). */
const LIVE_REF = /^\d+:[a-z][a-z_]{0,31}:/;
const MAKE_CHANGES = "make_changes";
const MAKE_CHANGES_DESCRIPTION = "Make changes in one call, in order: each step is one of your change tools with its input, and \"@name\" in an input stands for what an earlier step marked as: \"name\" made (a new track, a loaded device). It stops at the first step that fails and says what was done. With final: true and every step done, Kumi tells the producer what changed and the answer ends there, with no reply from you: use it when the changes complete the request, even a single change.";
const FIND_SAMPLES = "find_samples";
const FIND_SAMPLES_DESCRIPTION = "Find audio samples on this computer by words in their file and folder names (\"kick\", \"808\", \"vinyl\"), or pick some at random. Searches the folders the producer names, as full paths or ~/…, and otherwise where Live keeps samples: the User Library, Live's Core Library and Factory Packs. Returns each sample's name, path and length in seconds (for WAV and AIFF).";
const FIND_SAMPLES_SCHEMA: JsonObject = { type: "object", additionalProperties: false, properties: {
  folders: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 1024 }, description: "Folders to search, such as ~/Samples; Live's User Library when empty" },
  words: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 64 }, description: "Every word must appear in the file's name or its folders" },
  random: { type: "boolean", description: "Pick at random among the matches instead of the best ones" },
  limit: { type: "integer", minimum: 1, maximum: 50, description: "How many to return (20 when unset)" },
} };

const MAX_CHANGES_PER_TURN = 40;
const MAX_CHANGE_RECORDS = 500;

function noAccess(key: string, now: Date, project?: Observation["project"]): Observation {
  return { key, label: "Inference-only — No Live access", instructions: INSTRUCTIONS, tools: [], revision: "no-live", ...(project ? { project } : {}),
    context: JSON.stringify({ observedAt: now.toISOString(), mode: "inference-only", access: "No Live access; do not describe remembered Set data as current. /new or restart establishes a fresh connection." }) };
}
export function createInferenceOnlyIntegration(onConnection: (state: ConnectionState) => void): Integration {
  let closed = false;
  return {
    async start(signal) { signal.throwIfAborted(); if (closed) throw new Error("Integration is closed"); onConnection("disconnected"); },
    async observe(signal) { signal.throwIfAborted(); if (closed) throw new Error("Integration is closed"); return noAccess("inference-only", new Date()); },
    async close() { closed = true; },
  };
}
interface Options {
  onConnection: (state: ConnectionState) => void;
  bridgeConfig?: string;
  connect?: (signal: AbortSignal) => Promise<McpEndpoint>;
  now?: () => Date;
  generation?: string;
  onDispatch?: (name: string) => void;
  /** Basic focus: what the producer is looking at, reported when it changes. */
  onFocus?: (focus: LiveFocus | null) => void;
  focusIntervalMs?: number;
  /** A change Kumi made or undid in Live, for HISTORY. */
  onChange?: (change: ChangeRecord) => void;
  /** Bound on one apply or undo once sent; it runs to the end even if the turn is cancelled. */
  changeTimeoutMs?: number;
  /** Where Kumi keeps each saved Set's last-seen state; without it Kumi doesn't catch up. */
  projectStore?: ProjectStore;
  /** What changed in a saved Set while Kumi wasn't running. */
  onCatchUp?: (catchUp: CatchUp) => void;
  /** How often to look for Live while it's away. */
  reconnectIntervalMs?: number;
}

/** `restore` is the name or colour a rename or recolour replaced in Kumi's picture of the track, put back if it's undone. */
interface Applied { record: ChangeRecord; transactionId: string; undoKey?: string; restore?: { ref: string; field: "name" | "color"; value?: string } }

const resultText = (result: CallToolResult) => result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
const uncertain = (result: CallToolResult) => (result.structuredContent as JsonObject | undefined)?.state === "uncertain" || /uncertain/i.test(resultText(result));

export function createAbletonIntegration(options: Options): Integration {
  const generation = options.generation ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const lifetime = new AbortController();
  const refs = new Map<string, string>();
  // The model's names for Live's references: "parameter:12" for
  // "1232800184424618:parameter:1232800184424618:device:4:0:12". References were half of a read and
  // most of a plan, and the model reads and writes them token by token; Kumi maps them back.
  const shortRefs = new Map<string, string>(); const longRefs = new Map<string, string>(); const refCounts = new Map<string, number>();
  const cursors = new Map<string, string>();
  const unlisten: (() => void)[] = [];
  let endpoint: McpEndpoint | undefined;
  let tools: AllowedTools | undefined;
  let closed = false;
  let started = false;
  let available = false;
  let lost = false;
  let observationGeneration = 0;
  let currentEpoch: number | undefined;
  let currentSet: string | undefined;
  let closing: Promise<void> | undefined;
  let focusFeed: FocusFeed | undefined;
  /** Tracks from this turn's discovery (names and colours), for HISTORY's chips. */
  const known = new Map<string, KnownTrack>();
  /** Kumi's changes while this bridge connection lives; its transactions are what undo uses. */
  const changes = new Map<string, Applied>();
  /** Samples find_samples returned, by path, with the folder searched: what load_sample may load. */
  const samples = new Map<string, Sample>();
  let changesThisTurn = 0;
  /** Samples Kumi picked itself in this answer, so random picks don't repeat. */
  const picked = new Set<string>();
  const changeTimeoutMs = options.changeTimeoutMs ?? 30_000;
  /** The saved Set Kumi is keeping track of (unsaved Sets have no file, so nothing to remember). */
  let project: { identity: string; path?: string; name: string } | undefined;
  let catchUpContext: JsonObject | undefined;
  let saving: Promise<void> = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSaved = 0;
  let watcher: ReturnType<typeof setInterval> | undefined;
  let looking = false;
  let lastEpoch: number | undefined;
  let lostEpoch: number | undefined;
  let lastFreshBridge = 0;
  let closingStarted = false;
  /** Live came back after going away; the next observation may continue the same conversation. */
  let reconnected = false;
  /** The Set the conversation is about: its key, and its file when saved. */
  let previous: { key: string; name: string; identity: string; path?: string; project?: { id: string; name: string } } | undefined;

  const invalidate = () => { refs.clear(); cursors.clear(); known.clear(); currentEpoch = undefined; observationGeneration++; };
  /** The bridge itself is gone: a new connection (/new) is needed. */
  const loseAccess = () => { if (closed || (lost && !available)) return; lost = true; available = false; clearInterval(watcher); invalidate(); focusFeed?.stop(); options.onConnection("disconnected"); };
  /** Live is gone but the bridge is still here: wait for Live and carry on when it's back. */
  const loseLive = () => {
    if (closed || closingStarted || lost) return;
    lost = true; lostEpoch = lastEpoch; invalidate(); options.onConnection("disconnected");
    clearInterval(watcher);
    watcher = setInterval(() => { void lookForLive(); }, options.reconnectIntervalMs ?? 2_000);
    watcher.unref?.();
  };
  async function openEndpoint(signal: AbortSignal): Promise<McpEndpoint> {
    if (options.connect) return options.connect(signal);
    if (!options.bridgeConfig) throw new ObservationError("Bridge configuration is required; choose explicit inference-only mode otherwise");
    return connectMcp({ signal, bridgeConfig: options.bridgeConfig, allowTools: [...MODEL_TOOLS, ...HOST_TOOLS, ...PROJECT_TOOLS],
      ...(options.onDispatch ? { onDispatch: options.onDispatch } : {}) });
  }
  /** Whether Live's Remote Script answers on the bridge's port (a plain connect, closed at once). */
  function remoteScriptListening(): Promise<boolean> {
    let target: { host: string; port: number } | undefined;
    try {
      const config = options.bridgeConfig ? JSON.parse(readFileSync(options.bridgeConfig, "utf8")) as { bridge?: { host?: unknown; port?: unknown } } : undefined;
      const host = config?.bridge?.host; const port = config?.bridge?.port;
      if (typeof host === "string" && (host === "127.0.0.1" || host === "localhost" || host === "::1") && Number.isInteger(port)) target = { host, port: port as number };
    } catch { target = undefined; }
    if (!target) return Promise.resolve(false);
    return new Promise((resolve) => {
      const socket = connectSocket({ host: target!.host, port: target!.port });
      const done = (listening: boolean) => { socket.destroy(); resolve(listening); };
      socket.setTimeout(500, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  }
  /** Use this bridge connection from now on: its tools, its disconnect signal and the focus feed. */
  function attach(connected: McpEndpoint) {
    endpoint = connected;
    tools = new AllowedTools(connected, new Set([...HOST_TOOLS, ...PROJECT_TOOLS]));
    // A changed catalog is read again on next use (AllowedTools listens for it); only losing the bridge ends access.
    unlisten.push(connected.onDisconnect(loseAccess));
    focusFeed?.stop();
    if (options.onFocus) {
      // A fixed internal read, not a model tool call: it bypasses the model's allowlist,
      // which is emptied while the catalog refreshes.
      focusFeed = startFocusFeed({ read: (signal) => connected.call("live_discover", { kind: "selection", limit: 1 }, signal), onFocus: options.onFocus,
        // Failing reads are the first sign that Live went away; check, and wait for it if so.
        onFailure: () => { if (!lost) void readStatus(AbortSignal.timeout(1_500)).then((status) => { if (!status.connected) loseLive(); }).catch(() => {}); },
        ...(options.focusIntervalMs ? { intervalMs: options.focusIntervalMs } : {}) });
    }
  }
  async function lookForLive() {
    if (closed || !lost || !available || looking) return;
    looking = true;
    try {
      const status = await readStatus(AbortSignal.any([lifetime.signal, AbortSignal.timeout(1_500)]));
      if (status.connected) { back(status.epoch !== lostEpoch); return; }
      // The bridge won't carry on across a Live restart (its old transactions can't be reconciled),
      // so a restarted Live needs a fresh bridge: start one as soon as Live's Remote Script answers
      // on its port, and otherwise only now and then.
      const restarted = status.reason === "remote-bridge-or-live-epoch-changed" || await remoteScriptListening();
      if (!restarted && Date.now() - lastFreshBridge < 30_000) return;
      lastFreshBridge = Date.now();
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]);
      const fresh = await openEndpoint(signal);
      let ready = false;
      // A fixed status read on the new bridge, before anything else uses it.
      try { ready = statusPayload(await fresh.call("live_status", {}, signal)).connected === true; } catch { ready = false; }
      if (!ready || closed || !lost) { await fresh.close().catch(() => {}); return; }
      // Swap: stop listening to the old bridge before closing it, so closing isn't mistaken for losing it.
      const old = tools;
      for (const remove of unlisten.splice(0)) remove();
      attach(fresh);
      // The fresh bridge is the connection now, even if the old one dropped meanwhile.
      available = true;
      void old?.close().catch(() => {});
      back(true);
    } catch { /* still away */ } finally { looking = false; }
  }
  function back(restarted: boolean) {
    clearInterval(watcher); watcher = undefined;
    // A restarted Live has a new epoch; the bridge's transactions from before can't be undone.
    if (restarted) retireChanges("Live restarted since, so Kumi can't undo this; it's in the Set only if the Set was saved.");
    lost = false; reconnected = true;
    options.onConnection("connected");
  }
  /** Changes whose undo can no longer work stay in HISTORY as kept, with why. */
  function retireChanges(note: string) {
    for (const entry of changes.values()) {
      if (entry.record.state !== "applied" && entry.record.state !== "unsure") continue;
      entry.record = { ...entry.record, state: "expired", note };
      emitChange(entry.record);
    }
  }
  function changed() {
    invalidate(); options.onConnection("error");
    throw new ObservationError("Live epoch or Set identity changed; result discarded. Refresh before continuing.");
  }
  function assertLease(lease: number, signal: AbortSignal) {
    signal.throwIfAborted(); lifetime.signal.throwIfAborted();
    if (closed || lease !== observationGeneration) throw new ObservationError("Observation changed; late result discarded");
  }
  function assertEpoch(actual: unknown, expected: number) { if (actual !== expected) changed(); }
  /**
   * Changes in the Set can change what the bridge offers (a first clip brings clip tools). The
   * list is read again when needed; the Set, its references and the conversation stay current.
   */
  async function ensureCatalog(signal: AbortSignal) {
    if (!tools || tools.isValid) return;
    try { await tools.refresh(signal); }
    catch { signal.throwIfAborted(); await tools.refresh(signal); }
  }
  async function readStatus(signal: AbortSignal) {
    await ensureCatalog(signal);
    if (!tools?.has("live_status")) throw new ObservationError("Live status capability is unavailable");
    return statusPayload(await tools.call("live_status", {}, signal, { host: true }));
  }
  async function guardEpoch(signal: AbortSignal, expected: number, lease: number) {
    const status = await readStatus(signal);
    assertLease(lease, signal);
    if (!status.connected) { loseLive(); throw new ObservationError("No Live access; current observations were discarded"); }
    assertEpoch(status.epoch, expected);
    return status;
  }
  function registerRows(kind: string, rows: JsonObject[], args: JsonObject, nextCursor?: string) {
    for (const row of rows) {
      if (args.parent !== undefined && row.parentRef !== args.parent) throw new ObservationError("Discovery returned a different parent; result discarded");
      if (typeof row.ref === "string" && row.ref.length > 0 && row.ref.length <= 256) {
        refs.set(row.ref, kind);
        if (kind === "clip-slot" && typeof row.clipRef === "string" && row.clipRef.length <= 256) refs.set(row.clipRef, "session-clip");
        const color = hexColor(row.color);
        if (/track$/.test(kind) && typeof row.name === "string") known.set(row.ref, { name: row.name.slice(0, 256), ...(color ? { color } : {}) });
      }
    }
    if (refs.size > 4096) { invalidate(); throw new ObservationError("Too many current references; refresh and narrow the request"); }
    if (nextCursor) {
      if (nextCursor === args.cursor) throw new ObservationError("Discovery cursor repeated; narrow the request");
      cursors.set(nextCursor, queryKey(args));
      if (cursors.size > 128) { invalidate(); throw new ObservationError("Too many page cursors; refresh and narrow the request"); }
    }
  }
  function validateParentAndCursor(args: JsonObject) {
    const kind = String(args.kind);
    const parentKinds = PARENTS[kind];
    if (parentKinds || args.parent !== undefined) {
      const parentKind = typeof args.parent === "string" ? refs.get(args.parent) : undefined;
      if (!parentKind || (parentKinds ? !parentKinds.includes(parentKind) : parentKind !== "set")) {
        throw new ObservationError("A fresh authoritative parent is required; discover the parent in this turn, not from history");
      }
    }
    if (args.cursor !== undefined && (typeof args.cursor !== "string" || cursors.get(args.cursor) !== queryKey(args))) {
      throw new ObservationError("Cursor is stale or belongs to another query; rediscover without it");
    }
  }
  /** A track row's mixer, as a producer reads it: values and Live's text, without the bridge's internal references. */
  function shortRef(ref: string): string {
    if (!LIVE_REF.test(ref)) return ref;
    const known = shortRefs.get(ref); if (known) return known;
    // Counts go on after a clear, so a name never comes back meaning something else.
    if (shortRefs.size >= 50_000) { shortRefs.clear(); longRefs.clear(); }
    const kind = /^\d+:([a-z][a-z_]{0,31}):/.exec(ref)![1]!;
    const count = (refCounts.get(kind) ?? 0) + 1; refCounts.set(kind, count);
    const name = `${kind}:${count}`;
    shortRefs.set(ref, name); longRefs.set(name, ref);
    return name;
  }
  /** A copy with Live's references, under keys that hold them, as the model's short names. */
  function shorten(value: unknown, key = "", depth = 0): unknown {
    if (depth > 32) return value;
    if (typeof value === "string") return REF_KEY.test(key) ? shortRef(value) : value;
    if (Array.isArray(value)) return value.map((item) => shorten(item, key, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([child, item]) => [child, shorten(item, child, depth + 1)]));
    return value;
  }
  /** The model's input with its short names turned back into Live's references. */
  function lengthen(value: unknown, key = "", depth = 0): unknown {
    if (depth > 32) return value;
    if (typeof value === "string") return REF_KEY.test(key) ? longRefs.get(value) ?? value : value;
    if (Array.isArray(value)) return value.map((item) => lengthen(item, key, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([child, item]) => [child, lengthen(item, child, depth + 1)]));
    return value;
  }
  /** Mixer rows as the model needs them: the values and Live's text for them. */
  function slimMixers(content: JsonObject): JsonObject {
    if (!Array.isArray(content.items) || !content.items.some((item) => item && typeof item === "object" && "mixer" in (item as JsonObject))) return content;
    const keep = ["volume", "pan", "mute", "solo", "cueVolume", "sends", "volumeDisplay", "panDisplay", "cueVolumeDisplay", "sendDisplays"];
    const items = content.items.map((item) => {
      const row = item as JsonObject;
      if (!row.mixer || typeof row.mixer !== "object") return row;
      return { ...row, mixer: Object.fromEntries(Object.entries(row.mixer as JsonObject).filter(([key]) => keep.includes(key))) };
    });
    return { ...content, items };
  }
  function encode(result: CallToolResult, epoch: number, slim = false): { text: string; isError: boolean } {
    if (result.isError) return { text: JSON.stringify(result), isError: true };
    // Live's answer as plain JSON, not a string inside the bridge's envelope: escaped quotes cost the model too.
    let live: unknown;
    try { live = payload(result); } catch { live = result; }
    const text = JSON.stringify({ live: shorten(slim && live && typeof live === "object" && !Array.isArray(live) ? slimMixers(live as JsonObject) : live), observation: { observedAt: now().toISOString(), connectionGeneration: generation, epoch,
      coverage: "Bounded read; preserve truncated/nextCursor markers. Traversal completeness is not established." } });
    if (Buffer.byteLength(text) > 64 * 1024) return { text: "Result too large; narrow fields/parent/page.", isError: true };
    return { text, isError: false };
  }
  async function invoke(name: string, input: JsonObject, originalSignal: AbortSignal) {
    const signal = AbortSignal.any([originalSignal, lifetime.signal]);
    let reading = false;
    const lease = observationGeneration;
    try {
      signal.throwIfAborted();
      if (!available || lost || currentEpoch === undefined || !tools) throw new ObservationError("No current Live access; refresh or use /new before reading");
      const epoch = currentEpoch;
      await ensureCatalog(signal); assertLease(lease, signal);
      if (!tools.has(name)) throw new ObservationError("That read isn't available for the open Set right now");
      const named = lengthen(input) as JsonObject;
      const args = name === "live_discover" ? discoveryArgs(named) : named;
      if (name === "live_discover") validateParentAndCursor(args);
      else requireFreshReferences(args);
      reading = true;
      // A discovery answer carries its epoch, checked below, so only the check after it is needed.
      if (name !== "live_discover") await guardEpoch(signal, epoch, lease);
      let result = await tools.call(name, args, signal, { host: true });
      assertLease(lease, signal);
      // The model gets bounded reads: too big means narrowing the request, whatever the answer holds.
      if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) { refs.clear(); cursors.clear(); return { text: "Result too large; narrow fields/parent/page instead of requesting a whole Set dump.", isError: true }; }
      if (!result.isError && name === "live_discover") {
        assertEpoch(payload(result).epoch, epoch);
        const first = discoveryPayload(result, String(args.kind), epoch);
        if (args.kind === "set" && (first.items.length !== 1 || setIdentity(first.items[0]!) !== currentSet)) changed();
        registerRows(String(args.kind), first.items, args, first.nextCursor);
        // Kumi reads on for the model while the rows stay small: a big device's parameters come in
        // one answer, not a model reply per page.
        let items = first.items; let next = first.nextCursor; let pages = 1;
        while (next && pages < 3 && Buffer.byteLength(JSON.stringify(items)) < 32 * 1024) {
          const pageArgs = { ...args, cursor: next };
          const more = await tools.call(name, pageArgs, signal, { host: true }); assertLease(lease, signal);
          if (more.isError || Buffer.byteLength(JSON.stringify(more)) > 64 * 1024) break;
          // Anything odd about a later page ends reading on; the model gets what came, with its cursor.
          try {
            assertEpoch(payload(more).epoch, epoch);
            const page = discoveryPayload(more, String(args.kind), epoch);
            registerRows(String(args.kind), page.items, pageArgs, page.nextCursor);
            items = [...items, ...page.items]; next = page.nextCursor; pages++;
          } catch { break; }
        }
        if (pages > 1) {
          const { nextCursor: _cursor, ...rest } = payload(result);
          const merged: JsonObject = { ...rest, items, truncated: Boolean(next), ...(next ? { nextCursor: next } : {}) };
          result = { content: [{ type: "text", text: JSON.stringify(merged) }], structuredContent: merged };
        }
      }
      await guardEpoch(signal, epoch, lease);
      if (!result.isError) {
        if (name === "live_snapshot") {
          const data = payload(result); assertEpoch(data.epoch, epoch);
          if (setIdentity(object(object(data.snapshot).set)) !== currentSet) changed();
          // Snapshot refs intentionally do not satisfy fresh-discovery parent leases.
        } else if (name === "live_status") {
          const data = statusPayload(result);
          if (!data.connected) loseLive();
          assertEpoch(data.epoch, epoch);
        }
      }
      const encoded = encode(result, epoch, name === "live_discover");
      if (encoded.isError) { refs.clear(); cursors.clear(); }
      return encoded;
    } catch (error) {
      // A failed upstream read cannot authorize retries with cached refs/cursors.
      if (reading && lease === observationGeneration) { refs.clear(); cursors.clear(); }
      return { text: error instanceof ObservationError ? error.message : "Live read failed; refresh current observations and narrow the request before retrying.", isError: true };
    }
  }
  function requireFreshReferences(args: JsonObject, depth = 0) {
    for (const field of REFERENCE_FIELDS) {
      const value = args[field];
      if (value !== undefined && (typeof value !== "string" || !refs.has(value))) throw new ObservationError(`${field} must come from discovery in this turn; discover it again`);
    }
    // And the ones in a list, such as each parameter of several changed at once.
    if (depth < 2) for (const value of Object.values(args)) if (Array.isArray(value)) for (const item of value) if (item && typeof item === "object" && !Array.isArray(item)) requireFreshReferences(item as JsonObject, depth + 1);
  }
  function emitChange(record: ChangeRecord) {
    try { options.onChange?.(structuredClone(record)); } catch { /* a listener failure must not affect Live */ }
  }
  function remember(record: ChangeRecord, transactionId: string, restore?: Applied["restore"]) {
    changes.set(record.id, { record, transactionId, ...(restore ? { restore } : {}) });
    if (changes.size > MAX_CHANGE_RECORDS) changes.delete(changes.keys().next().value!);
    emitChange(record);
    scheduleSave(20_000);
  }
  async function exportPages(signal: AbortSignal): Promise<JsonObject[]> {
    const pages: JsonObject[] = [];
    let cursor: string | undefined;
    do {
      const page = payload(await tools!.call("live_project_snapshot_export", { profile: "local", limit: 200, ...(cursor ? { cursor } : {}) }, signal, { host: true }));
      pages.push(page);
      const next = object(page.page).nextCursor;
      cursor = typeof next === "string" && next ? next : undefined;
    } while (cursor && pages.length < 64);
    if (cursor) throw new ObservationError("The Set is too large to remember yet");
    return pages;
  }
  const artifactOf = (pages: readonly JsonObject[]) => { const id = object(pages[0]?.artifact ?? {}).id; return typeof id === "string" ? id : ""; };
  /** Save the Set's current state as what Kumi last saw; one save at a time. */
  function saveNow(bound = 30_000): Promise<void> {
    const work = saving.then(async () => {
      const known = project;
      if (!known?.path || !options.projectStore || !available || lost || closed) return;
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(bound)]);
      await ensureCatalog(signal);
      if (!tools!.has("live_project_snapshot_export")) return;
      const pages = await exportPages(signal);
      if (project !== known) return;
      await options.projectStore.save({ version: 1, path: known.path, name: known.name, savedAt: now().getTime(), artifactId: artifactOf(pages), pages });
      lastSaved = Date.now();
    }).catch(() => { /* remembering is best effort; Live and the conversation are unaffected */ });
    saving = work;
    return work;
  }
  function scheduleSave(delayMs: number) {
    if (!options.projectStore || closed) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void saveNow(); }, delayMs);
    saveTimer.unref?.();
  }
  /** Compare the Set with what Kumi last saw, say what changed, then remember it as it is now. */
  /** The open Set's file, which identifies a saved Set between sessions; none for an unsaved Set. */
  async function projectPath(signal: AbortSignal): Promise<string | undefined> {
    try {
      await ensureCatalog(signal);
      if (!tools!.has("live_project_info")) return undefined;
      const info = payload(await tools!.call("live_project_info", {}, AbortSignal.any([signal, AbortSignal.timeout(5_000)]), { host: true }));
      return typeof info.path === "string" && info.path && info.exists !== false ? info.path : undefined;
    } catch { return undefined; }
  }
  function catchUp(identity: string, name: string, afterReconnect = false): void {
    catchUpContext = undefined;
    const store = options.projectStore;
    const path = project?.identity === identity ? project.path : undefined;
    if (!store || !path) return;
    saving = saving.then(async () => {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60_000)]);
      await ensureCatalog(signal);
      if (!PROJECT_TOOLS.every((tool) => tools!.has(tool))) return;
      if (project?.identity !== identity) return;
      const pages = await exportPages(signal);
      const baseline: Baseline | undefined = await store.load(path);
      if (baseline && project?.identity === identity) {
        let described: { lines: string[]; more: number } | undefined = { lines: [], more: 0 };
        if (baseline.artifactId !== artifactOf(pages)) {
          try {
            const diff = payload(await tools!.call("live_project_snapshot_diff", { beforePages: baseline.pages, afterPages: pages, limit: 200 }, signal, { host: true }));
            described = describeDiff(diff, baseline.pages, pages);
            // Differences Kumi can't put into words (recomputed hashes, a moved return track) aren't worth a
            // catch-up, and "nothing changed" wouldn't be true either: say nothing.
            if (!described.lines.length) described = undefined;
          } catch { described = { lines: ["The Set changed, but it's too big for Kumi to compare yet"], more: 0 }; }
        }
        if (described) {
          const summary = { ...catchUpFrom(name, baseline, described), ...(afterReconnect ? { afterReconnect: true } : {}) };
          catchUpContext = { lastSeen: since(baseline.savedAt, now().getTime()), changes: summary.lines, ...(summary.more ? { more: summary.more } : {}) };
          try { options.onCatchUp?.(summary); } catch { /* a listener failure must not affect Live */ }
        }
      }
      await store.save({ version: 1, path, name, savedAt: now().getTime(), artifactId: artifactOf(pages), pages });
      lastSaved = Date.now();
    }).catch(() => { /* catching up is best effort */ });
  }
  const knownTrack = (ref: unknown) => (typeof ref === "string" ? known.get(ref) : undefined);
  /** New tracks go after the last one unless the model gave a position (the bridge's default is request order). */
  async function appendAtEnd(kind: ChangeKind, input: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const lacks = (items: unknown) => Array.isArray(items) && items.some((item) => item && typeof item === "object" && (item as JsonObject).index === undefined);
    if (kind.family !== "structure" || (!lacks(input.tracks) && !lacks(input.scenes))) return input;
    const probe = await tools!.call(kind.preview, input, signal, { host: true });
    if (probe.isError) return input;
    const prior = object(payload(probe).prior);
    const place = (items: unknown, count: number) => Array.isArray(items)
      ? items.map((item, index) => (item && typeof item === "object" && (item as JsonObject).index === undefined ? { ...(item as JsonObject), index: count + index } : item)) : items;
    const tracks = Array.isArray(prior.tracks) ? prior.tracks.length : 0; const scenes = Array.isArray(prior.scenes) ? prior.scenes.length : 0;
    return { ...input, ...(input.tracks !== undefined ? { tracks: place(input.tracks, tracks) } : {}), ...(input.scenes !== undefined ? { scenes: place(input.scenes, scenes) } : {}) };
  }
  /** Preview and apply one change as a single step, then record it for HISTORY. */
  function changeContext(signal: AbortSignal): ChangeContext {
    return {
      sample: (path) => samples.get(path),
      async pick(selector: SampleSelector) {
        const named = (selector.folders ?? []).map((folder) => folderPath(folder)).filter((folder): folder is string => Boolean(folder));
        const found = await findSamples({ folders: named.length ? named : defaultSampleFolders(), words: selector.words ?? [], limit: 50, random: selector.random === true || !(selector.words ?? []).length, signal });
        const choice = found.samples.find((sample) => !picked.has(sample.path));
        if (!choice) return undefined;
        picked.add(choice.path); samples.delete(choice.path); samples.set(choice.path, choice);
        return choice;
      },
    };
  }

  /**
   * Several changes in one call: each step runs exactly as its own tool would (the same checks,
   * HISTORY entry and undo), in order, and stops at the first that fails. "@name" in a step's
   * input stands for what an earlier step marked `as: "name"` made. One call instead of a model
   * round trip per change, which is most of the time a multi-step request takes.
   */
  async function makeChanges(input: JsonObject, signal: AbortSignal): Promise<{ text: string; isError: boolean; reply?: string }> {
    // A step with `each: { note: [36, 37, 38] }` runs once per value, with that input field set to it;
    // with several lists of one length (parameterRef and value), the i-th run takes the i-th of each.
    const steps: unknown[] = [];
    for (const [index, raw] of (Array.isArray(input.steps) ? input.steps : []).entries()) {
      const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : {};
      const each = item.each && typeof item.each === "object" && !Array.isArray(item.each) ? Object.entries(item.each as JsonObject) : [];
      if (!each.length) { steps.push(raw); continue; }
      const runs = Array.isArray(each[0]![1]) ? (each[0]![1] as unknown[]).length : -1;
      if (runs < 0 || each.some(([, values]) => !Array.isArray(values) || values.length !== runs)) return { text: `Step ${index + 1}: each gives input fields lists of one length, one value per run.`, isError: true };
      const base = item.input && typeof item.input === "object" && !Array.isArray(item.input) ? item.input as JsonObject : {};
      for (let run = 0; run < runs; run++) steps.push({ tool: item.tool, input: { ...base, ...Object.fromEntries(each.map(([field, values]) => [field, (values as unknown[])[run]])) } });
      if (steps.length > MAX_CHANGES_PER_TURN) break;
    }
    if (!steps.length || steps.length > MAX_CHANGES_PER_TURN) return { text: `Give 1 to ${MAX_CHANGES_PER_TURN} steps in all.`, isError: true };
    const made = new Map<string, string>();
    const done: JsonObject[] = [];
    // Steps in a row on one device become one change, in one Live request, when the bridge can:
    // samples onto a rack's pads, and parameters of a device.
    const schemaOf = (kind: ChangeKind) => object(object(tools?.tool(kind.preview)?.inputSchema ?? {}).properties ?? {});
    const batches = [
      { tool: "load_sample_to_pad", kind: CHANGES.find((kind) => kind.tool === "load_samples_to_pads")!, most: 16, what: "pads",
        offered: (kind: ChangeKind) => { const action = object(schemaOf(kind).action ?? {}); return Array.isArray(action.enum) && action.enum.includes("load-samples"); },
        input: (steps: JsonObject[]) => ({ deviceRef: steps[0]!.deviceRef ?? null, pads: steps.map((step) => ({ note: step.note ?? null, sample: step.sample ?? null, ...(step.instrument === "Drum Sampler" ? { instrument: "Drum Sampler" } : {}) })) }) },
      { tool: "set_device_parameter", kind: CHANGES.find((kind) => kind.tool === "set_device_parameters")!, most: 64, what: "parameters",
        offered: (kind: ChangeKind) => "values" in schemaOf(kind),
        input: (steps: JsonObject[]) => ({ deviceRef: steps[0]!.deviceRef ?? null, values: steps.map((step) => ({ parameterRef: step.parameterRef ?? null, value: step.value ?? null })) }) },
    ];
    const batchStep = (value: unknown, tool: string, device?: unknown) => {
      const item = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
      const stepInput = item.input && typeof item.input === "object" && !Array.isArray(item.input) ? item.input as JsonObject : {};
      return item.tool === tool && item.as === undefined && typeof stepInput.deviceRef === "string" && (device === undefined || stepInput.deviceRef === device);
    };
    const resolve = (value: unknown, step: number): unknown => {
      if (typeof value === "string" && /^@[a-z][a-z0-9_]{0,31}$/i.test(value)) {
        const found = made.get(value.slice(1));
        if (!found) throw new ObservationError(`step ${step} refers to ${value}, which no earlier step made`);
        return found;
      }
      if (Array.isArray(value)) return value.map((item) => resolve(item, step));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, step)]));
      return value;
    };
    for (let index = 0; index < steps.length;) {
      const step = index + 1;
      const raw = steps[index];
      const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : {};
      const stop = (error: string) => ({ text: JSON.stringify({ done, stopped: { step, tool: item.tool ?? null, error: error.slice(0, 600) }, ...(steps.length > step ? { skipped: steps.length - step } : {}) }), isError: true });
      // Earlier steps of this plan just confirmed Live is the same, so later ones skip that check.
      const settled = done.length > 0;
      let run = 1;
      const batch = batches.find((candidate) => batchStep(raw, candidate.tool) && batchStep(steps[index + 1], candidate.tool, (item.input as JsonObject).deviceRef));
      if (batch) {
        // A rack loaded just now changed the bridge's tools; read them again before asking.
        try { await ensureCatalog(signal); } catch { signal.throwIfAborted(); }
        if (batch.offered(batch.kind)) while (run < batch.most && index + run < steps.length && batchStep(steps[index + run], batch.tool, (item.input as JsonObject).deviceRef)) run++;
      }
      if (batch && run > 1) {
        let inputs: JsonObject[];
        try { inputs = steps.slice(index, index + run).map((other, offset) => resolve((other as JsonObject).input, step + offset) as JsonObject); }
        catch (error) { return stop(error instanceof Error ? error.message : "a reference didn't resolve"); }
        const outcome = await change(batch.kind, batch.input(inputs), signal, settled);
        let reply: JsonObject = {};
        try { reply = JSON.parse(outcome.text) as JsonObject; } catch { reply = {}; }
        if (outcome.isError) return stop(`${batch.what} ${step}–${step + run - 1}, as one change: ${outcome.text}`);
        const lines = Array.isArray(reply.lines) ? reply.lines : [];
        for (let offset = 0; offset < run; offset++) done.push({ step: step + offset, changed: typeof lines[offset] === "string" ? lines[offset] : reply.changed ?? null, change: reply.change ?? null });
        index += run;
        continue;
      }
      const kind = CHANGES.find((candidate) => candidate.tool === item.tool && !candidate.internal);
      if (!kind) return stop(`${String(item.tool).slice(0, 64)} isn't one of Kumi's change tools`);
      let stepInput: JsonObject;
      try { stepInput = resolve(item.input && typeof item.input === "object" && !Array.isArray(item.input) ? item.input : {}, step) as JsonObject; }
      catch (error) { return stop(error instanceof Error ? error.message : "a reference didn't resolve"); }
      const outcome = await change(kind, stepInput, signal, settled);
      let reply: JsonObject = {};
      try { reply = JSON.parse(outcome.text) as JsonObject; } catch { reply = {}; }
      if (outcome.isError) return stop(typeof reply.changed === "string" ? `${reply.changed}: ${outcome.text}` : outcome.text);
      if (typeof item.as === "string" && typeof reply.ref === "string") made.set(item.as, reply.ref);
      done.push({ step, changed: reply.changed ?? null, change: reply.change ?? null, ...(typeof reply.ref === "string" ? { ref: reply.ref } : {}), ...(Array.isArray(reply.lines) ? { lines: reply.lines } : {}) });
      index++;
    }
    const text = JSON.stringify({ done });
    if (input.final !== true) return { text, isError: false };
    // The plan finished the request: Kumi says what changed, sparing the producer a model reply.
    // A line for each thing changed: a change of several parameters gives one for each.
    const lines = done.flatMap((item) => Array.isArray(item.lines) ? item.lines : [item.changed]).filter((line): line is string => typeof line === "string" && line.length > 0);
    return { text, isError: false, reply: lines.length === 1 ? `Done: ${lines[0]}.` : `Done:\n${lines.map((line) => `- ${line}`).join("\n")}` };
  }

  /** `settled`: an earlier change in the same plan just confirmed Live's epoch, so it isn't read again. */
  async function change(kind: ChangeKind, named: JsonObject, originalSignal: AbortSignal, settled = false): Promise<{ text: string; isError: boolean }> {
    const signal = AbortSignal.any([originalSignal, lifetime.signal]);
    const input = lengthen(named) as JsonObject;
    const lease = observationGeneration;
    try {
      signal.throwIfAborted();
      if (!available || lost || currentEpoch === undefined || !tools) throw new ObservationError("No current Live access; refresh or use /new before changing anything");
      await ensureCatalog(signal); assertLease(lease, signal);
      if (!tools.has(kind.preview) || !tools.has(kind.apply)) throw new ObservationError(kind.unavailable ?? "That change isn't available for the open Set right now");
      if (changesThisTurn >= MAX_CHANGES_PER_TURN) throw new ObservationError(`That's ${MAX_CHANGES_PER_TURN} changes in one answer; stop and check with the producer before changing more`);
      requireFreshReferences(input);
      const prepared = kind.prepare ? await kind.prepare(input, changeContext(signal)) : input;
      if (typeof prepared === "string") return { text: prepared, isError: true };
      assertLease(lease, signal);
      const epoch = currentEpoch;
      if (!settled) await guardEpoch(signal, epoch, lease);
      const args = await appendAtEnd(kind, prepared, signal); assertLease(lease, signal);
      const previewed = await tools.call(kind.preview, args, signal, { host: true }); assertLease(lease, signal);
      if (previewed.isError) return { text: JSON.stringify(previewed), isError: true };
      const preview = payload(previewed);
      if (preview.epoch !== undefined && preview.epoch !== epoch) changed();
      const { transactionId, confirmation } = preview;
      if (typeof transactionId !== "string" || !transactionId || transactionId.length > 256 || typeof confirmation !== "string" || !confirmation || confirmation.length > 512) {
        throw new ObservationError("The bridge's preview was malformed; nothing was changed");
      }
      const summary = kind.summarize(preview, args, knownTrack);
      signal.throwIfAborted();
      changesThisTurn++;
      // From here the change may happen. It runs to the end (bounded) even if the turn is cancelled,
      // so every change that reaches Live is recorded, with its undo.
      const settle = AbortSignal.any([lifetime.signal, AbortSignal.timeout(changeTimeoutMs)]);
      let applied: CallToolResult;
      try {
        applied = await tools.call(kind.apply, { transactionId, confirmation, idempotencyKey: randomUUID() }, settle, { host: true });
      } catch {
        remember(newRecord(kind, summary, "unsure", now().getTime()), transactionId);
        return { text: "Live didn't confirm this change, so it may or may not have happened. Tell the producer to check Live; discover again before more changes.", isError: true };
      }
      if (applied.isError) {
        if (!uncertain(applied)) return { text: JSON.stringify(applied), isError: true };
        remember(newRecord(kind, summary, "unsure", now().getTime()), transactionId);
        return { text: `Live couldn't confirm this change: ${JSON.stringify(applied)}`, isError: true };
      }
      let result: JsonObject;
      try { result = payload(applied); } catch {
        remember(newRecord(kind, summary, "unsure", now().getTime()), transactionId);
        return { text: "Kumi couldn't read Live's answer to this change, so it can't confirm whether it happened. Tell the producer to check Live; discover again before more changes.", isError: true };
      }
      const settledSummary = kind.summarize(preview, args, knownTrack, result);
      const record = newRecord(kind, settledSummary, result.state === "applied" ? "applied" : "unsure", now().getTime());
      const field = kind.family === "rename" ? "name" : kind.family === "color" ? "color" : undefined;
      const replaced = field && typeof args.ref === "string" ? known.get(args.ref) : undefined;
      remember(record, transactionId, field && replaced ? { ref: args.ref as string, field, ...(replaced[field] !== undefined ? { value: replaced[field] } : {}) } : undefined);
      // A renamed track keeps its new name in later HISTORY entries.
      if (kind.family === "rename" && summary.track && typeof args.ref === "string" && known.has(args.ref)) known.set(args.ref, { ...known.get(args.ref)!, name: summary.track.name });
      // Likewise its new colour.
      if (kind.family === "color" && record.colors && typeof args.ref === "string" && known.has(args.ref)) known.set(args.ref, { ...known.get(args.ref)!, color: record.colors.to });
      if (kind.restructures) {
        refs.clear(); cursors.clear(); known.clear();
        for (const item of Array.isArray(result.created) ? result.created : []) {
          const created = item && typeof item === "object" ? item as JsonObject : {};
          if (typeof created.ref === "string" && created.ref.length <= 256 && (created.kind === "track" || created.kind === "scene")) {
            refs.set(created.ref, created.kind);
            if (created.kind === "track" && typeof created.name === "string") known.set(created.ref, { name: created.name.slice(0, 256) });
          }
        }
      }
      // What the change made (a new track, a loaded device) is usable at once, without discovering it.
      const produced = kind.produces?.(result);
      if (produced && produced.ref.length <= 256) refs.set(produced.ref, produced.kind);
      const { lines } = settledSummary;
      const reply = { changed: record.title, change: record.id, state: record.state, ...(produced ? { ref: shortRef(produced.ref) } : {}), ...(lines?.length ? { lines } : {}),
        ...(kind.restructures ? { note: "Track and scene positions moved; discover again before using earlier references (the new ones in live.created are current)." } : {}) };
      const full = JSON.stringify({ ...reply, live: shorten(result) });
      return { text: Buffer.byteLength(full) <= 16 * 1024 ? full : JSON.stringify(reply), isError: record.state !== "applied" };
    } catch (error) {
      return { text: error instanceof ObservationError ? error.message : "The change failed before anything happened in Live; discover again, then retry.", isError: true };
    }
  }
  /** Undo one change through the bridge's guarded undo. Refusals keep the change and say why. */
  async function undoChange(target: string, signal: AbortSignal): Promise<{ record?: ChangeRecord; text: string; isError: boolean }> {
    const entry = target === "last" ? [...changes.values()].reverse().find((item) => item.record.state === "applied") : changes.get(target);
    if (!entry) return { text: target === "last" ? "There's no change of Kumi's left to undo." : `There's no change ${target.slice(0, 32)} in this session.`, isError: true };
    if (entry.record.state === "undone") return { record: entry.record, text: JSON.stringify({ undone: entry.record.title, change: entry.record.id, already: true }), isError: false };
    if (entry.record.state === "expired") return { record: entry.record, text: entry.record.note ?? "Kumi can't undo this anymore.", isError: true };
    try { await ensureCatalog(signal); } catch { /* reported just below */ }
    if (!available || lost || !tools?.has("live_undo")) return { text: "Kumi can't reach Live right now, so it can't undo.", isError: true };
    signal.throwIfAborted();
    // One key per change, so a retry after an unconfirmed undo reconciles instead of undoing twice.
    entry.undoKey ??= randomUUID();
    const update = (next: Partial<ChangeRecord>) => {
      const { note: _note, ...rest } = entry.record;
      entry.record = { ...rest, ...next };
      emitChange(entry.record);
      return entry.record;
    };
    let result: CallToolResult;
    try {
      result = await tools.call("live_undo", { transactionId: entry.transactionId, confirmation: "undo", idempotencyKey: entry.undoKey }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(changeTimeoutMs)]), { host: true });
    } catch {
      return { record: update({ state: "unsure", note: "Live didn't answer the undo; try again." }), text: "Live didn't answer the undo; it can be retried.", isError: true };
    }
    if (result.isError) {
      const message = resultText(result).slice(0, 2048);
      if (uncertain(result)) return { record: update({ state: "unsure", note: "Live didn't confirm the undo; try again." }), text: message, isError: true };
      return { record: update({ state: "kept", note: undoNote(message) }), text: message, isError: true };
    }
    const body = payload(result);
    if (body.state !== "undone") return { record: update({ state: "unsure", note: "Live didn't confirm the undo; try again." }), text: JSON.stringify(body), isError: true };
    scheduleSave(20_000);
    // Only the field the change touched goes back: later changes to the track's other field stay.
    const restore = entry.restore; const current = restore ? known.get(restore.ref) : undefined;
    if (restore && current) {
      if (restore.field === "name") known.set(restore.ref, { ...current, name: restore.value ?? current.name });
      else { const { color: _color, ...rest } = current; known.set(restore.ref, restore.value ? { ...rest, color: restore.value } : rest); }
    }
    return { record: update({ state: "undone" }), text: JSON.stringify({ undone: entry.record.title, change: entry.record.id }), isError: false };
  }
  function definitions(): KernelTool[] {
    const reads: KernelTool[] = tools!.list().map((tool) => ({ name: tool.name, description: tool.description ?? "Read current Live state", inputSchema: tool.inputSchema,
      execute: (input, signal) => invoke(tool.name, input, signal) }));
    // A change whose target an earlier step can create is offered by any bridge that makes changes (has undo).
    const edits: KernelTool[] = CHANGES.filter((kind) => !kind.internal && ((kind.always && kind.inputSchema && tools!.has("live_undo")) || (tools!.has(kind.preview) && tools!.has(kind.apply)))).map((kind) => ({
      name: kind.tool, description: kind.description,
      inputSchema: kind.inputSchema ?? (kind.schema ? kind.schema(tools!.tool(kind.preview)!.inputSchema as JsonObject) : tools!.tool(kind.preview)!.inputSchema as JsonObject),
      execute: (input, signal) => change(kind, input, signal) }));
    const undo: KernelTool[] = tools!.has("live_undo") ? [{ name: UNDO_TOOL, description: UNDO_DESCRIPTION,
      inputSchema: { type: "object", properties: { change: { type: "string", minLength: 1, maxLength: 32, description: "A change id such as c3, or \"last\"" } }, required: ["change"], additionalProperties: false },
      execute: async (input, signal) => { const outcome = await undoChange(typeof input.change === "string" ? input.change : "last", signal); return { text: outcome.text, isError: outcome.isError }; } }] : [];
    const sampleSearch: KernelTool = { name: FIND_SAMPLES, description: FIND_SAMPLES_DESCRIPTION, inputSchema: FIND_SAMPLES_SCHEMA,
      execute: async (input, signal) => {
        const named = Array.isArray(input.folders) ? input.folders.filter((folder): folder is string => typeof folder === "string") : [];
        const folders = named.map((folder) => folderPath(folder));
        if (folders.some((folder) => !folder)) return { text: "Name folders by their full path, such as ~/Samples or /Users/me/Music/Drums.", isError: true };
        const words = Array.isArray(input.words) ? input.words.filter((word): word is string => typeof word === "string") : [];
        const limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? Math.min(50, Math.max(1, input.limit)) : 20;
        const found = await findSamples({ folders: folders.length ? folders as string[] : defaultSampleFolders(), words, limit, random: input.random === true, signal });
        for (const sample of found.samples) { samples.delete(sample.path); samples.set(sample.path, sample); }
        while (samples.size > 5_000) samples.delete(samples.keys().next().value!);
        return { text: JSON.stringify({ samples: found.samples.map((sample) => ({ name: sample.name, path: sample.path, ...(sample.seconds !== undefined ? { seconds: sample.seconds } : {}), kb: Math.round(sample.bytes / 1024) })),
          matched: found.matched, looked: found.scanned, ...(found.partial ? { partial: true } : {}), ...(found.missing.length ? { missing: found.missing } : {}),
          ...(folders.length ? {} : { searched: "the User Library, Live's Core Library and Factory Packs" }) }), isError: false };
      } };
    const batch: KernelTool[] = tools!.has("live_undo") && edits.length ? [{ name: MAKE_CHANGES, description: MAKE_CHANGES_DESCRIPTION,
      inputSchema: { type: "object", additionalProperties: false, required: ["steps"], properties: { steps: { type: "array", minItems: 1, maxItems: MAX_CHANGES_PER_TURN, items: {
        type: "object", additionalProperties: false, required: ["tool", "input"], properties: {
          tool: { type: "string", enum: edits.map((item) => item.name) }, input: { type: "object", description: "What that tool takes; \"@name\" for what an earlier step made" },
          as: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,31}$", description: "Name what this step makes (a new track, a loaded device) for later steps" },
          each: { type: "object", description: "Repeat this step: each field's list gives that input field its value run by run, e.g. {\"note\": [36, 37, 38, 39]}, or several lists of one length, e.g. {\"parameterRef\": [\"parameter:3\", \"parameter:9\"], \"value\": [0.5, 1]}", additionalProperties: { type: "array", maxItems: 40 } } } } },
        final: { type: "boolean", description: "These changes complete the request: Kumi says what changed and you aren't called again. Leave it out to see the results and carry on." } } },
      execute: (input, signal) => makeChanges(input, signal) }] : [];
    return [...reads, sampleSearch, ...edits, ...batch, ...undo];
  }
  return {
    async start(signal) {
      if (closed || started) throw new ObservationError("Integration cannot be started again");
      started = true; options.onConnection("connecting");
      const combined = AbortSignal.any([signal, lifetime.signal]);
      try {
        if (!options.connect && !options.bridgeConfig) throw new ObservationError("Bridge configuration is required; choose explicit inference-only mode otherwise");
        const fresh = await openEndpoint(combined);
        if (combined.aborted || closed) { await fresh.close(); combined.throwIfAborted(); throw new ObservationError("Connection closed"); }
        attach(fresh);
        available = true;
      } catch {
        options.onConnection("error");
        throw new ObservationError("MCP startup failed; verify the standalone bridge and explicit configuration");
      }
    },
    async observe(originalSignal) {
      const signal = AbortSignal.any([originalSignal, lifetime.signal]);
      signal.throwIfAborted();
      if (!started || closed) throw new ObservationError("Integration is not open");
      invalidate(); const lease = observationGeneration; changesThisTurn = 0; picked.clear();
      // While Live is away the conversation stays with its Set (and keeps being saved there).
      const away = () => noAccess(previous?.key ?? `${generation}:no-live`, now(), previous?.path && previous.project ? previous.project : undefined);
      if (!available || lost) return away();
      try {
        await tools!.refresh(signal); assertLease(lease, signal);
        const status = await readStatus(signal); assertLease(lease, signal);
        if (!status.connected) { loseLive(); return away(); }
        // Checked straight after reading the list: later notifications can't interleave with synchronous code.
        await ensureCatalog(signal); assertLease(lease, signal);
        if (!tools!.has("live_discover")) throw new ObservationError("Required Set discovery capability is unavailable");
        const epoch = status.epoch as number;
        const args = discoveryArgs({ kind: "set" });
        const result = await tools!.call("live_discover", args, signal, { host: true }); assertLease(lease, signal);
        assertEpoch(payload(result).epoch, epoch);
        const page = discoveryPayload(result, "set", epoch);
        if (page.items.length !== 1) throw new ObservationError("Current Set discovery did not return one authoritative Set");
        const row = page.items[0]!;
        const identity = setIdentity(row);
        await guardEpoch(signal, epoch, lease);
        currentEpoch = epoch; currentSet = identity; lastEpoch = epoch;
        registerRows("set", page.items, args, page.nextCursor);
        // The Set's tracks, with references usable in this turn: most requests then need no discovery first.
        let trackList: JsonObject[] | undefined; let moreTracks = false; let moreDevices = false;
        try {
          const trackArgs = discoveryArgs({ kind: "track", fields: ["name", "kind", "mediaKind"], limit: 100 });
          const tracksRead = await tools!.call("live_discover", trackArgs, signal, { host: true }); assertLease(lease, signal);
          if (!tracksRead.isError) {
            const trackPage = discoveryPayload(tracksRead, "track", epoch);
            registerRows("track", trackPage.items, trackArgs, trackPage.nextCursor);
            trackList = trackPage.items.map((item) => ({ ref: typeof item.ref === "string" ? shortRef(item.ref) : null, name: typeof item.name === "string" ? item.name.slice(0, 120) : null, type: item.kind === "group" ? "group" : item.mediaKind ?? item.kind ?? null }));
            moreTracks = Boolean(trackPage.nextCursor) || trackPage.truncated === true;
            // And the devices on them, so a request about a track's sound goes straight to its parameters.
            try {
              const deviceArgs = discoveryArgs({ kind: "device", fields: ["parentRef", "name", "className"], limit: 100 });
              const devicesRead = await tools!.call("live_discover", deviceArgs, signal, { host: true }); assertLease(lease, signal);
              if (!devicesRead.isError) {
                const devicePage = discoveryPayload(devicesRead, "device", epoch);
                registerRows("device", devicePage.items, deviceArgs);
                const onTrack = new Map<unknown, JsonObject[]>();
                for (const device of devicePage.items) {
                  if (typeof device.ref !== "string") continue;
                  const name = typeof device.name === "string" ? device.name.slice(0, 120) : null;
                  const type = typeof device.className === "string" && device.className !== name ? device.className.slice(0, 64) : undefined;
                  onTrack.set(device.parentRef, [...(onTrack.get(device.parentRef) ?? []), { ref: shortRef(device.ref), name, ...(type ? { type } : {}) }]);
                }
                trackList = trackList.map((entry, index) => { const devices = onTrack.get(trackPage.items[index]!.ref); return devices ? { ...entry, devices } : entry; });
                moreDevices = Boolean(devicePage.nextCursor) || devicePage.truncated === true;
              }
            } catch (error) { if (lease !== observationGeneration) throw error; }
          }
        } catch (error) { if (lease !== observationGeneration) throw error; trackList = undefined; }
        options.onConnection("connected");
        const name = typeof row.name === "string" && row.name.trim() ? row.name.slice(0, 256) : "(unnamed/unsaved)";
        // Its file says which saved Set this is (for its conversation and catching up). It's read for a
        // newly seen Set, and again when the name changes: Save As, or an unsaved Set's first save.
        const newSet = project?.identity !== identity;
        let path = newSet ? undefined : project!.path;
        if (newSet || project!.name !== name) { path = await projectPath(signal); assertLease(lease, signal); }
        // The conversation stays with the Set: the same Set keeps its key, and so does the same file after
        // Live restarts (an unsaved Set by its name). References from before are gone either way; the
        // model discovers again every turn.
        const sameFile = previous?.path !== undefined ? previous.path === path : previous?.name === name && name !== "(unnamed/unsaved)";
        const continues = previous !== undefined && (previous.identity === identity || (reconnected && sameFile));
        const key = continues ? previous!.key : JSON.stringify([generation, epoch, identity]);
        const afterReconnect = reconnected; reconnected = false;
        project = { identity, name, ...(path ? { path } : {}) };
        previous = { key, name, identity, ...(path ? { path, project: { id: projectIdOf(path), name } } : {}) };
        if (newSet) catchUp(identity, name, afterReconnect);
        else if (Date.now() - lastSaved > 5 * 60_000) scheduleSave(1_000);
        await ensureCatalog(signal); assertLease(lease, signal);
        const provenance = typeof status.provenance === "string" ? status.provenance : "unknown";
        const source = provenance === "real-live" && status.adapter === "remote-script" ? "Remote Script · real-live" : `unverified/synthetic fixture · ${provenance}`;
        return {
          key,
          revision: String(tools!.generation),
          label: `Current open Set: ${name} — ${source}`,
          instructions: INSTRUCTIONS, tools: definitions(),
          ...(project?.identity === identity && project.path ? { project: { id: projectIdOf(project.path), name } } : {}),
          context: JSON.stringify({ observedAt: now().toISOString(), connectionGeneration: generation, epoch,
            adapter: status.adapter, provenance, liveVersion: status.environment && typeof status.environment === "object" ? object(status.environment).liveVersion ?? null : null,
            set: { ref: typeof row.ref === "string" ? shortRef(row.ref) : row.ref, name, tempo: row.tempo ?? null, playing: row.playing ?? null, position: row.position ?? null, loop: row.loop ?? null },
            ...(trackList ? { tracks: trackList, ...(moreTracks ? { moreTracks: "More tracks than listed; discover the rest" } : {}), ...(moreDevices ? { moreDevices: "Not every device is listed; discover a track's devices" } : {}) } : {}),
            ...(catchUpContext && project?.identity === identity ? { sinceLastTime: catchUpContext } : {}),
            // What Kumi changed lately and where each change stands, HISTORY undos and stopped answers included.
            ...(changes.size ? { kumiChanges: [...changes.values()].slice(-12).map(({ record }) => ({ change: record.id, what: record.title, state: record.state, ...(record.note ? { note: record.note } : {}) })) } : {}),
            truncated: page.truncated, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            coverage: "Current open Set only. Bounded discovery; details and track counts require fresh paged reads. Names/paths are not durable identity.",
          }),
        };
      } catch (error) {
        if (lease !== observationGeneration) throw new ObservationError("Observation changed; late refresh discarded");
        refs.clear(); cursors.clear(); currentEpoch = undefined;
        throw new ObservationError(error instanceof ObservationError ? error.message : "Live observation refresh failed; old observations are not current");
      }
    },
    async undo(id, signal) {
      if (!started || closed) throw new KumiError("request", "Kumi isn't connected to Live, so it can't undo.");
      const outcome = await undoChange(id ?? "last", signal);
      if (!outcome.record) throw new KumiError("request", outcome.text);
      return outcome.record;
    },
    close() {
      if (closing) return closing;
      closingStarted = true;
      clearTimeout(saveTimer); clearInterval(watcher);
      // Remember the Set as Kumi leaves it, so next time's catch-up starts here (bounded).
      const remembered = project?.path && options.projectStore && available && !lost
        ? Promise.race([saveNow(2_000), new Promise<void>((resolve) => { setTimeout(resolve, 2_500).unref?.(); })]) : Promise.resolve();
      closing = remembered.then(() => {
        closed = true; available = false; lifetime.abort(); invalidate(); focusFeed?.stop();
        for (const remove of unlisten) remove();
        return tools ? tools.close() : endpoint ? endpoint.close() : Promise.resolve();
      });
      return closing;
    },
  };
}
