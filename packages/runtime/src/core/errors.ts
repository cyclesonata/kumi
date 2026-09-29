export type FailureKind = "auth" | "billing" | "model" | "config" | "live" | "rate-limit" | "request" | "provider" | "network" | "protocol" | "output";

/**
 * A failure whose message Kumi wrote itself: safe to display, never a credential or raw provider
 * payload. `provider` says which provider it concerns, so an app can offer the fix (sign in there,
 * choose another model).
 */
export class KumiError extends Error {
  override readonly name = "KumiError";
  constructor(readonly kind: FailureKind, message: string, readonly provider?: string) { super(message); }
}
