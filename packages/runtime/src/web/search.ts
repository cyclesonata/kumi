/**
 * Searching the web without a key: the free services in turn (free.ts: Exa, Parallel, Keenable,
 * Firecrawl), DuckDuckGo's plain page when none of them can answer, and GitHub's own search for code.
 * The same search again within 20 minutes is the one already made.
 */
import type { Found } from "./exa.js";
import { FREE_SERVICES, freeTrouble, NoFreeService, offline, waitWords, type FreeServices } from "./free.js";
import { decodeEntities, htmlToText } from "./html.js";
import { searchGithub } from "./github.js";
import { decodeText, WebError, type WebClient } from "./net.js";

export type { Found } from "./exa.js";

export interface Searched {
  /** Who answered: "Exa", "Parallel", "Keenable", "Firecrawl", "DuckDuckGo" or "GitHub". */
  via: string;
  results: Found[];
  /** Why the services tried first didn't answer, when another did. */
  fellBack?: string;
}

/** Searches kept for 20 minutes; the same search asked while it runs shares it. Only answers are kept. */
export class SearchCache {
  private readonly kept = new Map<string, { at: number; searched: Promise<Searched> }>();
  constructor(private readonly now: () => number = Date.now, private readonly keepMs = 20 * 60_000, private readonly most = 64) {}

  search(key: string, run: () => Promise<Searched>): Promise<Searched> {
    const now = this.now();
    for (const [old, entry] of this.kept) if (now - entry.at >= this.keepMs) this.kept.delete(old);
    const held = this.kept.get(key);
    if (held) return held.searched;
    const searched = run();
    this.kept.set(key, { at: now, searched });
    searched.catch(() => { if (this.kept.get(key)?.searched === searched) this.kept.delete(key); });
    while (this.kept.size > this.most) this.kept.delete(this.kept.keys().next().value!);
    return searched;
  }
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
    // Read as HTML, so an entity decoded into "<" stays text rather than becoming markup.
    const words = (value: string | undefined) => (value ? htmlToText(value, DUCKDUCKGO_URL).replace(/\s+/g, " ").trim() : "");
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

export async function searchWeb(client: WebClient, query: string, options: { about?: string; count: number; where: "web" | "github"; signal?: AbortSignal; services?: FreeServices }): Promise<Searched> {
  if (options.where === "github") {
    const repos = await searchGithub(client, query, options.count, options.signal);
    return { via: "GitHub", results: repos.map((repo) => ({ title: repo.name, url: repo.url,
      text: [repo.description, repo.stars !== undefined ? `${repo.stars} stars` : undefined, repo.language, repo.updated ? `last changed ${repo.updated}` : undefined].filter(Boolean).join(" · ") })) };
  }
  const services = options.services ?? FREE_SERVICES;
  const signal = options.signal ? { signal: options.signal } : {};
  let none: NoFreeService;
  try {
    const found = await services.first("search", (service) => service.search(client, query, { ...(options.about ? { about: options.about } : {}), count: options.count, ...signal }),
      { ...signal, empty: (results) => results.length === 0 });
    const said = found.failures.map((failure) => failure.error.message.replace(/ for now\.$|\.$/, "")).join("; ");
    return { via: found.service.name, results: found.value, ...(said ? { fellBack: said } : {}) };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof NoFreeService)) throw error;
    none = error;
  }
  try {
    return { via: "DuckDuckGo", results: await duckDuckGo(client, query, options.count, options.signal), fellBack: freeTrouble(none) || "the free search services are resting" };
  } catch (error) {
    options.signal?.throwIfAborted();
    const names = [...services.services.map((service) => service.name), "DuckDuckGo"];
    if (offline(none, error)) {
      throw new WebError(`Kumi couldn't reach any search service (${names.slice(0, -1).join(", ")} or DuckDuckGo): is this computer online?`, undefined, { unreachable: true });
    }
    const said = [freeTrouble(none), error instanceof Error ? error.message.replace(/\.$/, "") : "DuckDuckGo failed"].filter(Boolean).join("; ");
    throw new WebError(`Kumi couldn't search the web just now: ${said}. Try again in ${none.backInMs !== undefined ? `about ${waitWords(none.backInMs)}` : "a minute or two"}.`);
  }
}
