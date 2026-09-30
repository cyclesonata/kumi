/**
 * Searching the web without a key: Exa first (it finds pages by what they're about, with the
 * passages that matter), DuckDuckGo when Exa can't answer, and GitHub's own search for code.
 */
import { decodeEntities } from "./html.js";
import { exaSearch, type Found } from "./exa.js";
import { searchGithub } from "./github.js";
import { decodeText, WebError, type WebClient } from "./net.js";

export type { Found } from "./exa.js";

export interface Searched {
  /** Who answered: "Exa", "DuckDuckGo" or "GitHub". */
  via: string;
  results: Found[];
  /** Why the first choice didn't answer, when another did. */
  fellBack?: string;
}

export const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/";

/** DuckDuckGo's plain results page: each result's title, address and snippet, ads left out. */
export function parseDuckDuckGo(html: string): Found[] {
  const found: Found[] = [];
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const block of blocks) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const link = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    let url = decodeEntities(link[1]!);
    // Its links can go through DuckDuckGo's redirect, which carries the address in uddg.
    if (/duckduckgo\.com\/l\/\?/.test(url)) {
      try { url = new URL(url.startsWith("//") ? `https:${url}` : url).searchParams.get("uddg") ?? url; } catch { continue; }
    }
    if (!/^https?:\/\//.test(url)) continue;
    const words = (value: string | undefined) => (value ? decodeEntities(value.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "");
    const title = words(link[2]);
    const snippet = words(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1]);
    found.push({ title: title || url, url, ...(snippet ? { text: snippet } : {}) });
  }
  return found;
}

async function duckDuckGo(client: WebClient, query: string, count: number, signal?: AbortSignal): Promise<Found[]> {
  const response = await client.fetch(DUCKDUCKGO_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", referer: "https://html.duckduckgo.com/" },
    body: new URLSearchParams({ q: query, b: "" }).toString(), maxBytes: 2 * 1024 * 1024, ...(signal ? { signal } : {}) });
  // 202 is its "are you a person?" page.
  if (response.status !== 200) throw new WebError(response.status === 202 ? "DuckDuckGo asked Kumi to prove it's a person." : `DuckDuckGo answered ${response.status}.`, response.status);
  const html = decodeText(response.body, response.charset);
  const found = parseDuckDuckGo(html);
  if (!found.length && /anomaly|captcha|challenge/i.test(html)) throw new WebError("DuckDuckGo asked Kumi to prove it's a person.");
  return found.slice(0, count);
}

export async function searchWeb(client: WebClient, query: string, options: { about?: string; count: number; where: "web" | "github"; signal?: AbortSignal }): Promise<Searched> {
  if (options.where === "github") {
    const repos = await searchGithub(client, query, options.count, options.signal);
    return { via: "GitHub", results: repos.map((repo) => ({ title: repo.name, url: repo.url,
      text: [repo.description, repo.stars !== undefined ? `${repo.stars} stars` : undefined, repo.language, repo.updated ? `last changed ${repo.updated}` : undefined].filter(Boolean).join(" · ") })) };
  }
  let first: string;
  try {
    return { via: "Exa", results: await exaSearch(client, query, { ...(options.about ? { about: options.about } : {}), count: options.count, ...(options.signal ? { signal: options.signal } : {}) }) };
  } catch (error) {
    options.signal?.throwIfAborted();
    first = error instanceof Error ? error.message : "it failed";
  }
  try {
    return { via: "DuckDuckGo", results: await duckDuckGo(client, query, options.count, options.signal), fellBack: first };
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new WebError(`Kumi couldn't search the web just now. ${first} ${error instanceof Error ? error.message : ""}`.trim());
  }
}
