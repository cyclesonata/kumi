import { liveCapabilitiesForOperations, type AsyncLiveAdapter, type LiveEvent, type LiveInvocation, type LiveOperationContext, type LiveStatus } from "../live.js";
import type { ExtensionChannel } from "./extension-channel.js";

/**
 * One adapter over Live's two scripting channels: the Remote Script (the Live Object Model) and Kumi's
 * Live extension (the Extensions SDK). The host keeps talking to a single adapter; this routes each
 * operation to the channel that has it:
 *
 * - an operation only the extension offers (offline render, Arrangement MIDI clips with notes,
 *   clearing a range, Browser-free pad samples, project import, grouped extension changes) goes there;
 * - an operation both offer goes to the Remote Script, whose identity fences and ownership tokens
 *   make verification and undo exact, unless it's listed in EXTENSION_FIRST (measured faster there);
 * - reads, snapshots and everything else stay on the Remote Script.
 *
 * `status()` lists both channels' operations while the extension is connected, so tools that need
 * the extension appear and disappear with it, as tools gated on bridge versions do.
 */
export const EXTENSION_FIRST: ReadonlySet<string> = new Set<string>();

export type RoutedStatus = LiveStatus & { channels?: { extension: { connected: boolean; reason?: string; version?: string; operations?: readonly string[] } } };

export function routeToExtension(operation: string, remoteScript: LiveStatus, extension: LiveStatus | undefined): boolean {
  if (!extension?.operations?.includes(operation)) return false;
  return !remoteScript.operations?.includes(operation) || EXTENSION_FIRST.has(operation);
}

export function mergedStatus(remoteScript: LiveStatus, extension: (LiveStatus & { extension?: Record<string, unknown> }) | undefined, reason: string): RoutedStatus {
  if (!remoteScript.connected || !extension) return { ...remoteScript, channels: { extension: { connected: false, reason } } };
  const own = new Set(remoteScript.operations ?? []);
  const added = (extension.operations ?? []).filter((operation) => operation !== "status" && !own.has(operation));
  const operations = [...(remoteScript.operations ?? []), ...added];
  const capabilities = [...new Set([...remoteScript.capabilities, ...liveCapabilitiesForOperations(added)])];
  const version = typeof extension.extension?.version === "string" ? extension.extension.version : undefined;
  return { ...remoteScript, operations, capabilities, channels: { extension: { connected: true, ...(version ? { version } : {}), operations: added } } };
}

/** Wraps the Remote Script adapter; every method not routed here is the Remote Script adapter's own. */
export function routedAdapter<T extends AsyncLiveAdapter>(remoteScript: T, extension: ExtensionChannel, onClose: () => void = () => undefined): T {
  const statusListeners = new Set<(status: LiveStatus) => void>();
  const notify = () => { const status = mergedStatus(remoteScript.status(), extension.status(), extension.reason); for (const listener of statusListeners) listener(status); };
  extension.subscribeStatus(() => notify());
  const own = remoteScript as unknown as Record<string, unknown>;
  // One subscription to the Remote Script's status, however many listen here.
  if (typeof own.subscribeStatus === "function") (own.subscribeStatus as (listener: (status: LiveStatus) => void) => () => void).call(remoteScript, () => notify());
  const routed: Record<string, unknown> = {
    status: () => mergedStatus(remoteScript.status(), extension.status(), extension.reason),
    invokeAsync: (invocation: LiveInvocation, context?: LiveOperationContext) => routeToExtension(invocation.operation, remoteScript.status(), extension.status())
      ? extension.invoke(invocation.operation, invocation.args, context)
      : remoteScript.invokeAsync(invocation, context),
    subscribe: (listener: (event: LiveEvent) => void) => {
      const fromScript = remoteScript.subscribe(listener); const fromExtension = extension.subscribe(listener);
      return () => { fromScript(); fromExtension(); };
    },
    subscribeStatus: (listener: (status: LiveStatus) => void) => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
    refreshStatusAsync: async (context?: LiveOperationContext) => {
      if (typeof own.refreshStatusAsync === "function") await (own.refreshStatusAsync as (context?: LiveOperationContext) => Promise<LiveStatus>).call(remoteScript, context);
      // Looking for the extension (maybe starting it) never holds up a status read; its tools appear when it connects.
      void extension.connect();
      return mergedStatus(remoteScript.status(), extension.status(), extension.reason);
    },
    close: async () => { onClose(); await extension.close(); await remoteScript.close(); },
  };
  return new Proxy(remoteScript, {
    get(target, property, receiver) {
      if (typeof property === "string" && Object.hasOwn(routed, property)) return routed[property];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
