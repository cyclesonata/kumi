/** An integration that, when it can't reach Live for a setup reason, lets the session carry on without it. */
import type { Integration } from "../core/contracts.js";
import { KumiError } from "../core/errors.js";

/**
 * Starts `primary`; if it fails with a Live setup problem (a "live" failure: the bridge wouldn't
 * start, say), says why through `onFallback` and continues as `fallback` (chatting without Live).
 * Anything else fails as it would have. A new session (/new, a restart) tries `primary` again.
 */
export function withFallback(primary: Integration, fallback: () => Integration, onFallback: (message: string) => void): Integration {
  let current = primary;
  return {
    async start(signal) {
      try { await primary.start(signal); }
      catch (error) {
        if (!(error instanceof KumiError && error.kind === "live") || signal.aborted) throw error;
        await primary.close().catch(() => {});
        current = fallback();
        await current.start(signal);
        onFallback(error.message);
      }
    },
    observe: (signal, hints) => current.observe(signal, hints),
    close: () => current.close(),
    undo: (id, signal) => {
      if (!current.undo) throw new KumiError("request", "Kumi isn't connected to Live, so it can't undo.");
      return current.undo(id, signal);
    },
    audioFile: async (named, signal) => current.audioFile?.(named, signal),
    stopLive: async (signal) => (current.stopLive ? current.stopLive(signal) : false),
    deviceTree: async (trackRef, signal) => current.deviceTree?.(trackRef, signal),
    clipView: async (slotRef, signal) => current.clipView?.(slotRef, signal),
    sessionStrip: async (trackRef, scene, signal) => current.sessionStrip?.(trackRef, scene, signal),
    arrangementStrip: async (signal) => current.arrangementStrip?.(signal),
  };
}
