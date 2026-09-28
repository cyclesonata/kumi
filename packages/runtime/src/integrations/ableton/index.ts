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
import { CHANGES, hexColor, HOST_TOOLS, newRecord, REFERENCE_FIELDS, UNDO_DESCRIPTION, UNDO_TOOL, undoNote, type ChangeKind, type KnownTrack } from "./changes.js";
import { startFocusFeed, type FocusFeed } from "./focus.js";
import { catchUpFrom, describeDiff, projectIdOf, since, type Baseline, type ProjectStore } from "./project.js";

/** Bridge tools Kumi uses to catch up on a Set; never offered to the model. */
const PROJECT_TOOLS = ["live_project_info", "live_project_snapshot_export", "live_project_snapshot_diff"];
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
  function slimMixers(result: CallToolResult): CallToolResult {
    const content = result.structuredContent as JsonObject | undefined;
    if (!content || !Array.isArray(content.items) || !content.items.some((item) => item && typeof item === "object" && "mixer" in (item as JsonObject))) return result;
    const keep = ["volume", "pan", "mute", "solo", "cueVolume", "sends", "volumeDisplay", "panDisplay", "cueVolumeDisplay", "sendDisplays"];
    const items = content.items.map((item) => {
      const row = item as JsonObject;
      if (!row.mixer || typeof row.mixer !== "object") return row;
      return { ...row, mixer: Object.fromEntries(Object.entries(row.mixer as JsonObject).filter(([key]) => keep.includes(key))) };
    });
    const slim = { ...content, items };
    return { ...result, structuredContent: slim, content: [{ type: "text", text: JSON.stringify(slim) }] };
  }
  function encode(result: CallToolResult, epoch: number): { text: string; isError: boolean } {
    if (result.isError) return { text: JSON.stringify(result), isError: true };
    const text = JSON.stringify({ mcp: result, observation: { observedAt: now().toISOString(), connectionGeneration: generation, epoch,
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
      const args = name === "live_discover" ? discoveryArgs(input) : input;
      if (name === "live_discover") validateParentAndCursor(args);
      else requireFreshReferences(args);
      reading = true;
      await guardEpoch(signal, epoch, lease);
      const result = await tools.call(name, args, signal, { host: true });
      assertLease(lease, signal);
      // The model gets bounded reads: too big means narrowing the request, whatever the answer holds.
      if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) { refs.clear(); cursors.clear(); return { text: "Result too large; narrow fields/parent/page instead of requesting a whole Set dump.", isError: true }; }
      await guardEpoch(signal, epoch, lease);
      if (!result.isError) {
        if (name === "live_discover") {
          assertEpoch(payload(result).epoch, epoch);
          const page = discoveryPayload(result, String(args.kind), epoch);
          if (args.kind === "set" && (page.items.length !== 1 || setIdentity(page.items[0]!) !== currentSet)) changed();
          registerRows(String(args.kind), page.items, args, page.nextCursor);
        } else if (name === "live_snapshot") {
          const data = payload(result); assertEpoch(data.epoch, epoch);
          if (setIdentity(object(object(data.snapshot).set)) !== currentSet) changed();
          // Snapshot refs intentionally do not satisfy fresh-discovery parent leases.
        } else if (name === "live_status") {
          const data = statusPayload(result);
          if (!data.connected) loseLive();
          assertEpoch(data.epoch, epoch);
        }
      }
      const encoded = encode(name === "live_discover" ? slimMixers(result) : result, epoch);
      if (encoded.isError) { refs.clear(); cursors.clear(); }
      return encoded;
    } catch (error) {
      // A failed upstream read cannot authorize retries with cached refs/cursors.
      if (reading && lease === observationGeneration) { refs.clear(); cursors.clear(); }
      return { text: error instanceof ObservationError ? error.message : "Live read failed; refresh current observations and narrow the request before retrying.", isError: true };
    }
  }
  function requireFreshReferences(args: JsonObject) {
    for (const field of REFERENCE_FIELDS) {
      const value = args[field];
      if (value !== undefined && (typeof value !== "string" || !refs.has(value))) throw new ObservationError(`${field} must come from discovery in this turn; discover it again`);
    }
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
  async function change(kind: ChangeKind, input: JsonObject, originalSignal: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const signal = AbortSignal.any([originalSignal, lifetime.signal]);
    const lease = observationGeneration;
    try {
      signal.throwIfAborted();
      if (!available || lost || currentEpoch === undefined || !tools) throw new ObservationError("No current Live access; refresh or use /new before changing anything");
      await ensureCatalog(signal); assertLease(lease, signal);
      if (!tools.has(kind.preview) || !tools.has(kind.apply)) throw new ObservationError("That change isn't available for the open Set right now");
      if (changesThisTurn >= MAX_CHANGES_PER_TURN) throw new ObservationError(`That's ${MAX_CHANGES_PER_TURN} changes in one answer; stop and check with the producer before changing more`);
      requireFreshReferences(input);
      const prepared = kind.prepare ? kind.prepare(input, { sample: (path) => samples.get(path) }) : input;
      if (typeof prepared === "string") return { text: prepared, isError: true };
      const epoch = currentEpoch;
      await guardEpoch(signal, epoch, lease);
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
      const record = newRecord(kind, kind.summarize(preview, args, knownTrack, result), result.state === "applied" ? "applied" : "unsure", now().getTime());
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
      const reply = { changed: record.title, change: record.id, state: record.state,
        ...(kind.restructures ? { note: "Track and scene positions moved; discover again before using earlier references (the new ones in live.created are current)." } : {}) };
      const full = JSON.stringify({ ...reply, live: result });
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
    const edits: KernelTool[] = CHANGES.filter((kind) => tools!.has(kind.preview) && tools!.has(kind.apply)).map((kind) => ({
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
    return [...reads, sampleSearch, ...edits, ...undo];
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
      invalidate(); const lease = observationGeneration; changesThisTurn = 0;
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
            set: { ref: row.ref, name, tempo: row.tempo ?? null, playing: row.playing ?? null, position: row.position ?? null, loop: row.loop ?? null },
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
