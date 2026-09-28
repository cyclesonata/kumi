export type FailureKind = "auth" | "config" | "rate-limit" | "request" | "provider" | "network" | "protocol" | "output";

/** A failure whose message Kumi wrote itself: safe to display, never a credential or raw provider payload. */
export class KumiError extends Error {
  override readonly name = "KumiError";
  constructor(readonly kind: FailureKind, message: string) { super(message); }
}
