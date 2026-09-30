import type { AsyncLiveAdapter } from "../live.js";
import { ExtensionChannel } from "./extension-channel.js";
import { launchExtension } from "./extension-launcher.js";
import { routedAdapter } from "./router.js";

export interface ExtensionSetup {
  /** Where the extension keeps its endpoint, secret and renders; the bridge's state folder has one. */
  storageDirectory: string;
  /** Start Live's Extension Host with Kumi's extension when none answers (default true). */
  launch?: boolean;
  liveApp?: string;
  log?: (line: string) => void;
  /** How often to look for the extension again while Live is connected and the extension isn't. */
  retryMs?: number;
}

// A failed start (another Extension Host holds Live, or this Live has none) isn't retried for a while:
// looking for an extension Live loaded itself is cheap, starting a process that can't connect isn't.
const RELAUNCH_AFTER_MS = 5 * 60_000;

/** The Remote Script adapter with Kumi's Live extension routed in beside it, connecting in the background. */
export function withExtension<T extends AsyncLiveAdapter>(remoteScript: T, setup: ExtensionSetup): T {
  let lastLaunch = 0;
  const launch = setup.launch === false ? undefined : async () => {
    if (Date.now() - lastLaunch < RELAUNCH_AFTER_MS) return;
    lastLaunch = Date.now();
    await launchExtension({ storageDirectory: setup.storageDirectory, ...(setup.liveApp ? { liveApp: setup.liveApp } : {}), ...(setup.log ? { log: setup.log } : {}) });
  };
  // Only a real Live has an Extension Host to reach (a simulated or fake Remote Script doesn't).
  const realLive = () => { const status = remoteScript.status(); return status.connected && status.provenance === "real-live"; };
  const channel = new ExtensionChannel({ storageDirectory: setup.storageDirectory, enabled: realLive, ...(launch ? { launch } : {}), ...(setup.log ? { log: setup.log } : {}) });
  const attempt = () => { if (!channel.status()) void channel.connect(); };
  const timer = setInterval(attempt, setup.retryMs ?? 10_000);
  timer.unref();
  const adapter = routedAdapter(remoteScript, channel, () => clearInterval(timer));
  attempt();
  return adapter;
}
