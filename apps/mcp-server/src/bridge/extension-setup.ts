import type { AsyncLiveAdapter } from "../live.js";
import { ExtensionChannel } from "./extension-channel.js";
import { launchExtension, type LaunchOutcome } from "./extension-launcher.js";
import { routedAdapter } from "./router.js";

export interface ExtensionSetup {
  /** Where the extension keeps its endpoint, secret and renders when the bridge starts it; the bridge's state folder has one. */
  storageDirectory: string;
  /** Where it keeps them when Live runs it (installed in Live's Extensions folder); looked at first. */
  installedStorage?: string;
  /** Start Live's Extension Host with Kumi's extension when none answers (default true). */
  launch?: boolean;
  liveApp?: string;
  log?: (line: string) => void;
  /** How often to look for the extension again while Live is connected and the extension isn't. */
  retryMs?: number;
  /** Stands in for launchExtension (tests). */
  launcher?: (options: Parameters<typeof launchExtension>[0]) => Promise<LaunchOutcome>;
}

// Starting is tried at most this often (Live's own host, another bridge's, or an extension that went
// away): looking for an extension Live runs itself is cheap, starting a process isn't.
const RELAUNCH_AFTER_MS = 5 * 60_000;

/** The Remote Script adapter with Kumi's Live extension routed in beside it, connecting in the background. */
export function withExtension<T extends AsyncLiveAdapter>(remoteScript: T, setup: ExtensionSetup): T {
  let lastLaunch = 0; let failedEpoch: number | null | undefined; let channel: ExtensionChannel | undefined;
  const launch = setup.launch === false ? undefined : async () => {
    // A host that couldn't reach Live (Developer Mode off: Live lets in only the host it starts) isn't
    // started again until Live starts again, when its Remote Script comes back with another epoch.
    const epoch = remoteScript.status().epoch;
    if (failedEpoch !== undefined && epoch === failedEpoch) return;
    if (Date.now() - lastLaunch < RELAUNCH_AFTER_MS) return;
    lastLaunch = Date.now();
    const outcome = await (setup.launcher ?? launchExtension)({ storageDirectory: setup.storageDirectory, onShared: (folder) => channel?.share(folder), ...(setup.liveApp ? { liveApp: setup.liveApp } : {}), ...(setup.log ? { log: setup.log } : {}) });
    if (outcome === "failed") { failedEpoch = epoch; lastLaunch = 0; } else failedEpoch = undefined;
  };
  // Only a real Live has an Extension Host to reach (a simulated or fake Remote Script doesn't).
  const realLive = () => { const status = remoteScript.status(); return status.connected && status.provenance === "real-live"; };
  channel = new ExtensionChannel({ storageDirectory: setup.storageDirectory, ...(setup.installedStorage ? { installedStorage: setup.installedStorage } : {}), enabled: realLive, ...(launch ? { launch } : {}), ...(setup.log ? { log: setup.log } : {}) });
  const attempt = () => { if (!channel!.status()) void channel!.connect(); };
  const timer = setInterval(attempt, setup.retryMs ?? 10_000);
  timer.unref();
  const adapter = routedAdapter(remoteScript, channel, () => clearInterval(timer));
  attempt();
  return adapter;
}
