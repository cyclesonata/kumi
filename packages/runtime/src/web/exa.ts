/**
 * Exa's search, which anyone may use without a key through its public MCP server: it finds pages by
 * what they're about, with the passages that matter, and reads a page as text (a PDF too, and a
 * page a browser would build). It's one of the free services Kumi takes turns with (free.ts).
 */
import { mcpTool } from "./mcp-call.js";
import { WebError, type WebClient } from "./net.js";

export const EXA_URL = "https://mcp.exa.ai/mcp";

/** A search result: its title, address, when it was published, and what it says that matters. */
export interface Found {
  title: string;
  url: string;
  published?: string;
  text?: string;
}

const explain = (text: string) => (/CRAWL_NOT_FOUND|NOT_FOUND/.test(text) ? "found nothing at that address" : /TIMEOUT/i.test(text) ? "timed out" : undefined);

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
  const text = await mcpTool(client, EXA_URL, "Exa", "web_search_exa", { query, numResults: options.count, objective: options.about || `The pages that best answer: ${query}` },
    { timeoutMs: 20_000, explain, ...(options.signal ? { signal: options.signal } : {}) });
  return parseExaResults(text);
}

/** A page as Exa reads it: its title and its text as Markdown. */
export async function exaRead(client: WebClient, url: string, signal?: AbortSignal): Promise<{ title?: string; text: string }> {
  const text = await mcpTool(client, EXA_URL, "Exa", "web_fetch_exa", { urls: [url], maxCharacters: 400_000 }, { timeoutMs: 90_000, explain, ...(signal ? { signal } : {}) });
  const lines = text.split("\n");
  const title = /^# (.+)$/.exec(lines[0] ?? "")?.[1]?.trim();
  // Its heading lines (the title, then URL, Published and Author) say what Kumi says already.
  let start = title ? 1 : 0;
  while (start < lines.length && /^(URL|Published|Author|Title): /.test(lines[start]!)) start++;
  const body = lines.slice(start).join("\n").trim();
  if (!body) throw new WebError("Exa found no text there.");
  return { ...(title ? { title } : {}), text: body };
}
