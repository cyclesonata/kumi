import { APICallError } from "@ai-sdk/provider";
import { KumiError } from "../core/errors.js";

const MAX_RETRY_WAIT_MS = 30_000;
/** How many times a model call is tried again (a busy or overloaded provider usually answers soon). */
export const MAX_RETRIES = 3;

/**
 * Delay before retry number `attempt` (from 0), or undefined when the failure is not worth retrying:
 * what the provider asks for, up to 30 s, or 0.75 s, 2.25 s, 6.75 s when it doesn't say.
 */
export function retryDelayMs(error: unknown, attempt = 0): number | undefined {
  if (!APICallError.isInstance(error) || !error.isRetryable) return undefined;
  const headers = error.responseHeaders ?? {};
  const afterMs = Number(headers["retry-after-ms"]);
  const afterSeconds = Number(headers["retry-after"]);
  const requested = Number.isFinite(afterMs) && afterMs > 0 ? afterMs : Number.isFinite(afterSeconds) && afterSeconds > 0 ? afterSeconds * 1000 : 750 * 3 ** attempt;
  return requested <= MAX_RETRY_WAIT_MS ? Math.max(250, requested) : undefined;
}

/** Providers by the name producers know them; the binding id's prefix otherwise. */
const PROVIDER_NAMES: Record<string, string> = { "openai-codex": "ChatGPT", openai: "OpenAI", anthropic: "Anthropic", opencode: "OpenCode Zen", "opencode-go": "OpenCode Go" };

/**
 * Map any inference failure to a message Kumi wrote, tagged with the provider it concerns so the
 * app can offer the fix (sign in again, choose another model). Provider detail is bounded and never
 * includes credentials.
 */
export function describeFailure(error: unknown, bindingId: string): KumiError {
  if (error instanceof KumiError) return error;
  const provider = bindingId.split("/")[0] ?? bindingId;
  const model = bindingId.slice(provider.length + 1) || bindingId;
  const name = PROVIDER_NAMES[provider] ?? provider;
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    const detail = providerDetail(error);
    if (status === 401) return new KumiError("auth", `${name} didn't accept Kumi's sign-in (HTTP 401): sign in again, or check the key.`, provider);
    if (status === 403) return new KumiError("auth", `${name} says this sign-in can't use ${model} (HTTP 403)${detail ? `: ${detail}` : ""}.`, provider);
    if (status === 402) return new KumiError("billing", `${name} needs billing sorted before it answers (HTTP 402)${detail ? `: ${detail}` : ""}.`, provider);
    if (status === 404) return new KumiError("model", `${name} doesn't offer ${model} to this sign-in (HTTP 404); choose another model.`, provider);
    if (status === 429) return new KumiError("rate-limit", `${name}'s rate or usage limit was reached (HTTP 429); try again in a moment${detail ? ` (${detail})` : ""}.`, provider);
    if (status === 529 || status === 503) return new KumiError("provider", `${name} is overloaded right now (HTTP ${status}); try again in a moment.`, provider);
    if (status !== undefined && status >= 500) return new KumiError("provider", `${name} is having trouble (HTTP ${status}); try again.`, provider);
    if (status !== undefined) return new KumiError("request", `${name} turned the request down (HTTP ${status})${detail ? `: ${detail}` : ""}.`, provider);
    return new KumiError("network", `Kumi couldn't reach ${name}; check the connection.`, provider);
  }
  return new KumiError("provider", "The model didn't answer; check the model, sign-in and connection.", provider);
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
