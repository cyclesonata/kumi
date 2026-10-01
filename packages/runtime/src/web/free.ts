/**
 * The free services Kumi searches and reads with, without a key, taking turns as Hermes Agent's keyless
 * web tools do: each request starts with the next service, so no one service gets all of Kumi's
 * requests or runs out early, and one that's busy, down or can't answer hands the request on. A service
 * that says it has had too many requests from here rests for as long as it asks (two minutes when it
 * doesn't say); one that doesn't answer rests a minute. Exa and Parallel are public MCP servers;
 * Keenable and Firecrawl have public endpoints of their own. None is told anything about the producer:
 * Parallel gets a random id for this run of Kumi (its free tier counts by it), Keenable the name "kumi".
 */
import { randomBytes, randomInt } from "node:crypto";
import { exaRead, exaSearch, type Found } from "./exa.js";
import { mcpTool } from "./mcp-call.js";
import { serviceTrouble, WebError, type WebClient, type WebRequest, type WebResponse } from "./net.js";

export interface FreeService {
  readonly name: string;
  search(client: WebClient, query: string, options: { about?: string; count: number; signal?: AbortSignal }): Promise<Found[]>;
  /** A page (a PDF too, or a page a browser builds) as text. */
  read(client: WebClient, url: string, signal?: AbortSignal): Promise<{ title?: string; text: string }>;
}

export const PARALLEL_URL = "https://search.parallel.ai/mcp";
export const KEENABLE_URL = "https://api.keenable.ai";
export const FIRECRAWL_URL = "https://api.firecrawl.dev";

const SEARCH_MS = 20_000;
const READ_MS = 60_000;
const SESSION = randomBytes(16).toString("hex");

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const words = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : []);
const signalled = (signal: AbortSignal | undefined): Pick<WebRequest, "signal"> => (signal ? { signal } : {});

function parsed(text: string, service: string): Record<string, unknown> {
  try { return record(JSON.parse(text)); } catch { throw new WebError(`${service} answered in a way Kumi doesn't follow.`); }
}
function answer(response: WebResponse, service: string): Record<string, unknown> {
  if (response.status !== 200) throw serviceTrouble(service, response);
  return parsed(response.body.toString("utf8"), service);
}

/** Search results, from the shapes these services answer with: an address each, its title, what it says. */
function results(items: unknown, count: number, said: (item: Record<string, unknown>) => string): Found[] {
  if (!Array.isArray(items)) return [];
  return items.map(record).flatMap((item) => {
    const url = words(item.url);
    if (!/^https?:\/\//.test(url)) return [];
    const text = said(item); const published = words(item.publish_date ?? item.published_date ?? item.publishedDate);
    return [{ title: words(item.title) || url, url, ...(published ? { published: published.slice(0, 10) } : {}), ...(text ? { text } : {}) }];
  }).slice(0, count);
}

/** A page a service read: its title and text, or why there's none. */
function page(service: string, title: unknown, text: string): { title?: string; text: string } {
  if (!text) throw new WebError(`${service} found no text there.`);
  return { ...(words(title) ? { title: words(title) } : {}), text };
}

export const EXA: FreeService = { name: "Exa", search: exaSearch, read: exaRead };

export const PARALLEL: FreeService = {
  name: "Parallel",
  async search(client, query, options) {
    const text = await mcpTool(client, PARALLEL_URL, "Parallel", "web_search", { objective: (options.about || query).slice(0, 1000), search_queries: [query], session_id: SESSION },
      { timeoutMs: SEARCH_MS, ...signalled(options.signal) });
    return results(parsed(text, "Parallel").results, options.count, (item) => strings(item.excerpts).join("\n"));
  },
  async read(client, url, signal) {
    const text = await mcpTool(client, PARALLEL_URL, "Parallel", "web_fetch", { urls: [url], full_content: true, session_id: SESSION }, { timeoutMs: READ_MS, ...signalled(signal) });
    const data = parsed(text, "Parallel");
    const result = record(Array.isArray(data.results) ? data.results[0] : undefined);
    const body = words(result.full_content) || words(result.content) || strings(result.excerpts).join("\n\n").trim();
    if (!body) {
      // Its error's kind only: the error's content is the site's own text, which isn't for the model unfenced.
      const kind = words(record(Array.isArray(data.errors) ? data.errors[0] : undefined).error_type).replace(/[^\w .-]/g, "").slice(0, 60);
      throw new WebError(`Parallel couldn't read it${kind ? ` (${kind})` : ""}.`);
    }
    return page("Parallel", result.title, body);
  },
};

const KEENABLE_TITLE = { "x-keenable-title": "kumi" };
export const KEENABLE: FreeService = {
  name: "Keenable",
  async search(client, query, options) {
    const response = await client.fetch(`${KEENABLE_URL}/v1/search/public`, { method: "POST", headers: { ...KEENABLE_TITLE, "content-type": "application/json" },
      body: JSON.stringify({ query, max_results: options.count }), timeoutMs: SEARCH_MS, maxBytes: 4 * 1024 * 1024, ...signalled(options.signal) });
    return results(answer(response, "Keenable").results, options.count, (item) => words(item.snippet) || words(item.description));
  },
  async read(client, url, signal) {
    // live: the page as it is now, not only one Keenable has indexed (the pages read this way rarely are).
    const response = await client.fetch(`${KEENABLE_URL}/v1/fetch/public?${new URLSearchParams({ url, live: "true", max_chars: "400000" })}`,
      { headers: KEENABLE_TITLE, timeoutMs: READ_MS, maxBytes: 8 * 1024 * 1024, ...signalled(signal) });
    const data = answer(response, "Keenable");
    return page("Keenable", data.title, words(data.content));
  },
};

export const FIRECRAWL: FreeService = {
  name: "Firecrawl",
  async search(client, query, options) {
    const response = await client.fetch(`${FIRECRAWL_URL}/v2/search`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, limit: options.count }), timeoutMs: SEARCH_MS, maxBytes: 4 * 1024 * 1024, ...signalled(options.signal) });
    const data = answer(response, "Firecrawl"); const inner = data.data;
    const list = Array.isArray(inner) ? inner : record(inner).web ?? record(inner).results ?? data.web ?? data.results;
    return results(list, options.count, (item) => words(item.description) || words(item.snippet));
  },
  async read(client, url, signal) {
    const response = await client.fetch(`${FIRECRAWL_URL}/v2/scrape`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"] }), timeoutMs: READ_MS, maxBytes: 8 * 1024 * 1024, ...signalled(signal) });
    const data = record(answer(response, "Firecrawl").data);
    return page("Firecrawl", record(data.metadata).title, words(data.markdown));
  },
};

export interface Failure { service: string; error: WebError }

/** Every free service failed or was resting: what each said, and when the first will be back. */
export class NoFreeService extends WebError {
  constructor(readonly failures: readonly Failure[], readonly resting: readonly { service: string; busy: boolean }[], readonly backInMs: number | undefined) {
    super([...failures.map((failure) => failure.error.message), ...resting.map((rest) => `${rest.service} is resting.`)].join(" ") || "No free service answered.");
  }
}

const BUSY_REST_MS = 2 * 60_000;
const DOWN_REST_MS = 60_000;
const MAX_REST_MS = 24 * 60 * 60_000;

export class FreeServices {
  private cursor: number;
  /** Services resting, by what they rest from ("search Exa"): a service busy searching may still read. */
  private readonly rests = new Map<string, { until: number; busy: boolean }>();

  constructor(readonly services: readonly FreeService[] = [EXA, PARALLEL, KEENABLE, FIRECRAWL], private readonly now: () => number = Date.now, start = randomInt(services.length)) {
    this.cursor = start % services.length;
  }

  /**
   * The first answer `run` gets, starting with the next service in turn. An answer `empty` calls empty
   * (no results) goes on to the next service too, and is the answer when no service has more.
   */
  async first<T>(kind: "search" | "read", run: (service: FreeService) => Promise<T>, options: { signal?: AbortSignal; empty?: (value: T) => boolean } = {}): Promise<{ value: T; service: FreeService; failures: Failure[] }> {
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % this.services.length;
    const now = this.now();
    const order = [...this.services.slice(start), ...this.services.slice(0, start)];
    const rest = (service: FreeService) => this.rests.get(`${kind} ${service.name}`);
    const resting = order.filter((service) => (rest(service)?.until ?? 0) > now);
    const failures: Failure[] = [];
    let empty: { value: T; service: FreeService } | undefined;
    for (const service of order.filter((item) => !resting.includes(item))) {
      try {
        const value = await run(service);
        if (options.empty?.(value)) { empty ??= { value, service }; continue; }
        return { value, service, failures };
      } catch (error) {
        options.signal?.throwIfAborted();
        const trouble = error instanceof WebError ? error : new WebError(`${service.name} failed: ${error instanceof Error ? error.message.slice(0, 160) : "it failed"}.`);
        failures.push({ service: service.name, error: trouble });
        const wait = trouble.trouble.busy ? Math.min(MAX_REST_MS, trouble.trouble.retryAfterMs ?? BUSY_REST_MS) : trouble.trouble.unreachable ? DOWN_REST_MS : 0;
        if (wait > 0) this.rests.set(`${kind} ${service.name}`, { until: this.now() + wait, busy: trouble.trouble.busy === true });
      }
    }
    if (empty) return { ...empty, failures };
    const later = this.now();
    const back = order.map((service) => (rest(service)?.until ?? 0) - later).filter((wait) => wait > 0);
    throw new NoFreeService(failures, resting.map((service) => ({ service: service.name, busy: rest(service)?.busy ?? false })), back.length ? Math.min(...back) : undefined);
  }
}

/** The services Kumi takes turns with in this run of Kumi. */
export const FREE_SERVICES = new FreeServices();

const list = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
/** A wait in words: "a minute", "5 minutes", "11 hours". */
export function waitWords(ms: number): string {
  if (ms < 90_000) return "a minute";
  if (ms < 90 * 60_000) return `${Math.ceil(ms / 60_000)} minutes`;
  return `${Math.round(ms / 3_600_000)} hours`;
}

/** What each free service said, in one clause: "Exa has had too many requests from here; Parallel answered 503". */
export function freeTrouble(none: NoFreeService): string {
  const busy = none.resting.filter((rest) => rest.busy).map((rest) => rest.service);
  const down = none.resting.filter((rest) => !rest.busy).map((rest) => rest.service);
  return [
    ...none.failures.map((failure) => failure.error.message.replace(/ for now\.$|\.$/, "")),
    ...(busy.length ? [`${list(busy)} ${busy.length > 1 ? "have" : "has"} had too many requests from here`] : []),
    ...(down.length ? [`${list(down)} didn't answer a moment ago`] : []),
  ].join("; ");
}

/**
 * Whether this computer is likely offline: services were tried, none was resting from being busy (busy
 * means it answered), and every failure was a connection that never happened.
 */
export function offline(none: NoFreeService, last: unknown): boolean {
  const errors = [...none.failures.map((failure) => failure.error), last];
  return none.failures.length > 0 && none.resting.every((rest) => !rest.busy) && errors.every((error) => error instanceof WebError && error.trouble.unreachable === true && error.status === undefined);
}
