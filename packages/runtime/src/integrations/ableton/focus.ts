/** Kumi's basic focus feed: what the producer is looking at in Live, read a few times a second. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject, LiveFocus } from "../../core/contracts.js";
import { object, payload } from "./context.js";

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value.slice(0, 256) : undefined);
const KINDS = new Set(["midi", "audio", "group", "return", "main"]);

/** The plain-name focus fields of a selection row (the Remote Script's `_focus_fields`). */
export function parseFocus(row: JsonObject): LiveFocus | null {
  const focus: LiveFocus = {};
  const track = text(row.focusTrackName);
  if (track) {
    const color = typeof row.focusTrackColor === "string" && /^#[0-9a-f]{6}$/i.test(row.focusTrackColor) ? row.focusTrackColor : undefined;
    const kind = typeof row.focusTrackKind === "string" && KINDS.has(row.focusTrackKind) ? row.focusTrackKind as NonNullable<LiveFocus["track"]>["kind"] : undefined;
    focus.track = { name: track, ...(color ? { color } : {}), ...(kind ? { kind } : {}) };
  }
  const trackRef = text(row.selectedTrackRef); if (trackRef && focus.track) focus.trackRef = trackRef;
  const slotRef = text(row.highlightedClipSlotRef); if (slotRef) focus.slotRef = slotRef;
  const deviceRef = text(row.selectedDeviceRef); if (deviceRef) focus.deviceRef = deviceRef;
  const scene = typeof row.selectedSceneRef === "string" ? /:scene:(\d+)$/.exec(row.selectedSceneRef) : null; if (scene) focus.sceneIndex = Number(scene[1]);
  const sceneName = text(row.focusSceneName); if (sceneName) focus.scene = sceneName;
  if (typeof row.focusClipName === "string") focus.clip = row.focusClipName.slice(0, 256);
  const device = text(row.focusDeviceName); if (device) focus.device = device;
  const parameter = text(row.focusParameterName);
  if (parameter) {
    const value = text(row.focusParameterValue); const owner = text(row.focusParameterOwner);
    focus.parameter = { name: parameter, ...(value ? { value } : {}), ...(owner ? { owner } : {}) };
  }
  const chain = text(row.focusChainName); if (chain) focus.chain = chain;
  if (row.focusView === "Session" || row.focusView === "Arrangement") focus.view = row.focusView;
  if (row.focusDetail === "Clip" || row.focusDetail === "Device") focus.detail = row.focusDetail;
  if (typeof row.focusBrowser === "boolean") focus.browser = row.focusBrowser;
  if (Number.isSafeInteger(row.focusSelectedNotes) && (row.focusSelectedNotes as number) >= 0) focus.selectedNotes = row.focusSelectedNotes as number;
  return Object.keys(focus).length ? focus : null;
}

export interface FocusFeed {
  stop(): void;
}

/**
 * Reads the selection every `intervalMs` (never two reads at once) and reports focus only
 * when it changes. A failed read is skipped; the next one tries again. Stopping reports null.
 */
export function startFocusFeed(options: {
  read: (signal: AbortSignal) => Promise<CallToolResult>;
  onFocus: (focus: LiveFocus | null) => void;
  /** Two reads in a row failed (Live may have gone away); called once until a read works again. */
  onFailure?: () => void;
  intervalMs?: number;
  timeoutMs?: number;
}): FocusFeed {
  let stopped = false;
  let last = "null";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | undefined;
  let failures = 0;
  const report = (focus: LiveFocus | null) => {
    const key = JSON.stringify(focus);
    if (key === last) return;
    last = key;
    try { options.onFocus(focus); } catch { /* a listener failure must not stop the feed */ }
  };
  const tick = async () => {
    if (stopped) return;
    inflight = new AbortController();
    try {
      const page = payload(await options.read(AbortSignal.any([inflight.signal, AbortSignal.timeout(options.timeoutMs ?? 2_000)])));
      const items = Array.isArray(page.items) ? page.items : [];
      if (!stopped) report(items.length ? parseFocus(object(items[0])) : null);
      failures = 0;
    } catch {
      if (!stopped && ++failures === 2) { try { options.onFailure?.(); } catch { /* the feed keeps going */ } }
    }
    finally {
      inflight = undefined;
      if (!stopped) timer = setTimeout(() => { void tick(); }, options.intervalMs ?? 500);
    }
  };
  void tick();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      inflight?.abort();
      report(null);
    },
  };
}
