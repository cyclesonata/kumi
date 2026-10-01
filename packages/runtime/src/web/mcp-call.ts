/**
 * One tool of a public MCP server, asked over plain HTTP (Streamable HTTP, one request, no session):
 * how Kumi uses Exa's and Parallel's free search and reading.
 */
import { busyWords, serviceTrouble, WebError, type WebClient } from "./net.js";

export interface McpCall {
  signal?: AbortSignal;
  timeoutMs: number;
  /** A tool error's text in the producer's words ("found nothing at that address"), when the service has its own. */
  explain?: (text: string) => string | undefined;
}

/** The tool's text, or a WebError that says whether the service is busy. */
export async function mcpTool(client: WebClient, endpoint: string, service: string, tool: string, args: Record<string, unknown>, call: McpCall): Promise<string> {
  const response = await client.fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }), timeoutMs: call.timeoutMs, maxBytes: 8 * 1024 * 1024,
    ...(call.signal ? { signal: call.signal } : {}) });
  if (response.status !== 200) throw serviceTrouble(service, response);
  const raw = response.body.toString("utf8");
  // One JSON-RPC message, as JSON or as a server-sent event. Lines end only at CR and LF: page text can
  // hold U+2028, which isn't the end of a line here.
  const message = response.contentType === "text/event-stream"
    ? raw.split(/\r\n|\r|\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).reverse().find((line) => /"(result|error)"/.test(line))
    : raw;
  let parsed: { result?: { content?: { type?: string; text?: unknown }[]; isError?: boolean }; error?: { message?: unknown } };
  try { parsed = JSON.parse(message ?? "") as typeof parsed; } catch { throw new WebError(`${service} answered in a way Kumi doesn't follow.`); }
  if (parsed.error) {
    const text = String(parsed.error.message ?? "an error");
    if (busyWords(text)) throw new WebError(`${service} has had too many requests from here for now.`, undefined, { busy: true });
    throw new WebError(`${service} refused: ${text.slice(0, 200)}`);
  }
  const text = (parsed.result?.content ?? []).map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : "")).filter(Boolean).join("\n");
  if (parsed.result?.isError) {
    if (busyWords(text)) throw new WebError(`${service} has had too many requests from here for now.`, undefined, { busy: true });
    throw new WebError(`${service} ${call.explain?.(text) ?? (text.replace(/^Error[^:]*:\s*/, "").slice(0, 200) || "failed")}.`);
  }
  return text;
}
