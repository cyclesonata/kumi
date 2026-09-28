import { APICallError } from "@ai-sdk/provider";
import { KumiError } from "../core/errors.js";

const MAX_RETRY_WAIT_MS = 4_000;

/** Delay before the single permitted retry, or undefined when the failure is not worth retrying. */
export function retryDelayMs(error: unknown): number | undefined {
  if (!APICallError.isInstance(error) || !error.isRetryable) return undefined;
  const headers = error.responseHeaders ?? {};
  const afterMs = Number(headers["retry-after-ms"]);
  const afterSeconds = Number(headers["retry-after"]);
  const requested = Number.isFinite(afterMs) && afterMs > 0 ? afterMs : Number.isFinite(afterSeconds) && afterSeconds > 0 ? afterSeconds * 1000 : 750;
  return requested <= MAX_RETRY_WAIT_MS ? Math.max(250, requested) : undefined;
}

/** Map any inference failure to a message Kumi wrote; provider detail is bounded and never includes credentials. */
export function describeFailure(error: unknown, bindingId: string): KumiError {
  if (error instanceof KumiError) return error;
  const provider = bindingId.split("/")[0] ?? bindingId;
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 401 || status === 403) {
      return new KumiError("auth", `${provider} rejected the credentials (HTTP ${status}). Sign in again or check the API key.`);
    }
    if (status === 429) return new KumiError("rate-limit", `${provider} rate or usage limit reached (HTTP 429); try again later.`);
    if (status !== undefined && status >= 500) return new KumiError("provider", `${provider} is unavailable (HTTP ${status}); try again.`);
    if (status !== undefined) {
      const detail = providerDetail(error);
      return new KumiError("request", `${provider} rejected the request (HTTP ${status})${detail ? `: ${detail}` : ""}. Check the configured model.`);
    }
    return new KumiError("network", `Could not reach ${provider}; check the network connection.`);
  }
  return new KumiError("provider", "Inference failed; check the configured model, sign-in, and connection.");
}

/** The provider's own short explanation of a rejected request (e.g. an unsupported parameter). */
function providerDetail(error: APICallError): string {
  let detail = error.message;
  if (!detail.trim() || /^(bad request|not found|unprocessable entity|unknown error)$/i.test(detail.trim())) {
    try {
      const body: unknown = JSON.parse(error.responseBody ?? "");
      const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const nested = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>).message : record.error;
      const candidate = [record.detail, nested, record.message].find((value) => typeof value === "string" && value.trim());
      if (typeof candidate === "string") detail = candidate;
    } catch { /* keep the status text */ }
  }
  return detail.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9._~+/=-]{32,}/g, "[redacted]").trim().slice(0, 300);
}
