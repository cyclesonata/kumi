/**
 * Exa's search, which anyone may use without a key through its public MCP server: it finds pages by
 * what they're about, with the passages that matter, and reads a page as text (a PDF too, and a
 * page a browser would build). Kumi reads pages itself first; Exa's reader is for the rest.
 */
import { WebError, type WebClient } from "./net.js";

export const EXA_URL = "https://mcp.exa.ai/mcp";

/** A search result: its title, address, when it was published, and what it says that matters. */
export interface Found {
  title: string;
  url: string;
  published?: string;
  text?: string;
}

async function call(client: WebClient, tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<string> {
  const response = await client.fetch(EXA_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }), timeoutMs, maxBytes: 8 * 1024 * 1024, ...(signal ? { signal } : {}) });
  if (response.status !== 200) throw new WebError(response.status === 429 ? "Exa has had too many searches from here for now." : `Exa answered ${response.status}.`, response.status);
  const raw = response.body.toString("utf8");
  // Streamable HTTP: one JSON-RPC message, as JSON or as a server-sent event.
  const message = response.contentType === "text/event-stream"
    ? raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).reverse().find((line) => /"(result|error)"/.test(line))
    : raw;
  let parsed: { result?: { content?: { type?: string; text?: unknown }[]; isError?: boolean }; error?: { message?: unknown } };
  try { parsed = JSON.parse(message ?? "") as typeof parsed; } catch { throw new WebError("Exa answered in a way Kumi doesn't follow."); }
  if (parsed.error) throw new WebError(`Exa refused: ${String(parsed.error.message ?? "an error").slice(0, 200)}`);
  const text = (parsed.result?.content ?? []).map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : "")).filter(Boolean).join("\n");
  if (parsed.result?.isError) {
    const reason = /CRAWL_NOT_FOUND|NOT_FOUND/.test(text) ? "found nothing at that address" : /TIMEOUT/i.test(text) ? "timed out" : text.replace(/^Error[^:]*:\s*/, "").slice(0, 200) || "failed";
    throw new WebError(`Exa ${reason}.`);
  }
  return text;
}

/** Exa's results as text: a block for each, "Title:", "URL:", "Published:", then "Highlights:". */
export function parseExaResults(text: string): Found[] {
  const found: Found[] = [];
  for (const block of text.split(/\n+---\n+(?=Title: )/)) {
    const field = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(block)?.[1]?.trim();
    const url = field("URL");
    if (!url || !/^https?:\/\//.test(url)) continue;
    const published = field("Published");
    const highlights = /^Highlights:\n([\s\S]*)$/m.exec(block)?.[1]?.trim();
    found.push({ title: field("Title") || url, url, ...(published && published !== "N/A" ? { published: published.slice(0, 10) } : {}), ...(highlights ? { text: highlights } : {}) });
  }
  return found;
}

export async function exaSearch(client: WebClient, query: string, options: { about?: string; count: number; signal?: AbortSignal }): Promise<Found[]> {
  const text = await call(client, "web_search_exa", { query, numResults: options.count, objective: options.about || `The pages that best answer: ${query}` }, options.signal, 30_000);
  return parseExaResults(text);
}

/** A page as Exa reads it: its title and its text as Markdown. */
export async function exaRead(client: WebClient, url: string, signal?: AbortSignal): Promise<{ title?: string; text: string }> {
  const text = await call(client, "web_fetch_exa", { urls: [url], maxCharacters: 400_000 }, signal, 90_000);
  const lines = text.split("\n");
  const title = /^# (.+)$/.exec(lines[0] ?? "")?.[1]?.trim();
  // Its heading lines (the title, then URL, Published and Author) say what Kumi says already.
  let start = title ? 1 : 0;
  while (start < lines.length && /^(URL|Published|Author|Title): /.test(lines[start]!)) start++;
  const body = lines.slice(start).join("\n").trim();
  if (!body) throw new WebError("Exa found no text there.");
  return { ...(title ? { title } : {}), text: body };
}
