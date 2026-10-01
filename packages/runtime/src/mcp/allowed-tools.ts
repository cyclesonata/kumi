import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "../core/contracts.js";
import type { McpEndpoint } from "./client.js";

/** Tools the model may call directly: reads. */
export const MODEL_TOOLS: ReadonlySet<string> = new Set(["server_status", "live_status", "live_snapshot", "live_discover", "live_browser_search", "live_note_read",
  "live_song_state", "live_performance_read", "live_key_estimate", "live_take_lane_read", "live_warp_marker_read", "live_arrangement_automation_read", "live_browser_roots", "live_browser_inspect"]);
const MAX_RESULT_BYTES = 64 * 1024;
/** The page older Remote Scripts allow (see `call`). */
const SMALL_PAGE = 100;
// Kumi's own reads of a big Set (every track, every parameter of a plug-in) come whole; what the model
// sees stays within MAX_RESULT_BYTES, because tokens cost the producer money.
const MAX_HOST_RESULT_BYTES = 256 * 1024 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;

/** Host-owned authorization boundary; model instructions and annotations confer no authority. */
export class AllowedTools {
  private catalog = new Map<string, Tool>();
  private valid = false;
  private closed = false;
  /** This bridge's Remote Script refused a page over 100 rows: ask for 100 at a time. */
  private smallPages = false;
  private invalidation = 0;
  private signature = "";
  private revision = 0;
  private unlisten: (() => void)[];
  private closing: Promise<void> | undefined;

  /** `hostTools` are called only by Kumi itself (behind its change tools), never listed for the model. */
  constructor(private readonly endpoint: McpEndpoint, private readonly hostTools: ReadonlySet<string> = new Set()) {
    const invalidate = () => { this.valid = false; this.catalog.clear(); this.invalidation++; };
    this.unlisten = [endpoint.onCatalogChanged(invalidate), endpoint.onDisconnect(invalidate)];
  }
  get generation() { return this.revision; }
  get isValid() { return this.valid && !this.closed; }
  /** The model's tools (reads) currently advertised. */
  list(): Tool[] { return this.isValid ? structuredClone([...this.catalog.values()].filter((tool) => MODEL_TOOLS.has(tool.name))) : []; }
  has(name: string): boolean { return this.isValid && this.allowed(name) && this.catalog.has(name); }
  /** One advertised tool, model or host, for its schema. */
  tool(name: string): Tool | undefined { const found = this.isValid ? this.catalog.get(name) : undefined; return found ? structuredClone(found) : undefined; }
  private allowed(name: string): boolean { return MODEL_TOOLS.has(name) || this.hostTools.has(name); }

  /**
   * Reads the catalog again. Callers at the same moment (reads sent together) share one reading: a second
   * reading would invalidate the first, and each would fail the other. A change announced while it reads
   * starts it over, a few times.
   */
  refresh(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.closed) return Promise.reject(new Error("MCP catalog is closed"));
    this.reading ??= (async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          try { return await this.enumerate(signal); }
          catch (error) { if (attempt >= 3 || this.closed || signal.aborted || !(error instanceof Error && /changed during enumeration/.test(error.message))) throw error; }
        }
      } finally { this.reading = undefined; }
    })();
    const shared = this.reading;
    return new Promise<void>((resolve, reject) => {
      const stop = () => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
  }
  private reading: Promise<void> | undefined;

  private async enumerate(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("MCP catalog is closed");
    this.valid = false;
    this.catalog.clear();
    const invalidation = ++this.invalidation;
    const names = new Set<string>();
    const cursors = new Set<string>();
    const next = new Map<string, Tool>();
    let cursor: string | undefined;
    let bytes = 0;
    let pages = 0;
    while (true) {
      if (++pages > 64) throw new Error("MCP catalog has too many pages");
      const page = await this.endpoint.list(cursor, signal);
      signal.throwIfAborted();
      if (this.closed || invalidation !== this.invalidation) throw new Error("MCP catalog changed during enumeration; refresh again");
      bytes += Buffer.byteLength(JSON.stringify(page));
      if (bytes > MAX_CATALOG_BYTES || names.size + page.tools.length > 512) throw new Error("MCP catalog exceeds the bounded size");
      for (const tool of page.tools) {
        if (names.has(tool.name)) throw new Error("MCP catalog contains a duplicate tool name");
        names.add(tool.name);
        if (this.allowed(tool.name)) next.set(tool.name, structuredClone(tool));
      }
      cursor = page.nextCursor;
      if (cursor === undefined) break;
      if (!cursor || cursor.length > 4096 || cursors.has(cursor)) throw new Error("MCP catalog cursor repeated or invalid");
      cursors.add(cursor);
    }
    const signature = JSON.stringify([...next.values()].sort((left, right) => left.name.localeCompare(right.name)));
    if (signature !== this.signature) { this.signature = signature; this.revision++; }
    this.catalog = next;
    this.valid = true;
  }

  /**
   * `host`: a call Kumi itself checked against a fresh catalog (see `has`). It is still limited to
   * allowed tools, but its result stands even if the catalog changes meanwhile: Live's answer
   * doesn't depend on the tool list, and a change's outcome must never be dropped.
   */
  async call(name: string, args: JsonObject, signal: AbortSignal, options: { host?: boolean } = {}): Promise<CallToolResult> {
    signal.throwIfAborted();
    if (!this.allowed(name)) throw new Error("Tool is not in Kumi's allowed tool list");
    if (this.closed) throw new Error("MCP catalog is closed");
    if (!options.host && !this.isValid) throw new Error("MCP catalog is invalid; refresh before calling tools");
    if (!options.host && !this.catalog.has(name)) throw new Error("Tool is not currently available or permitted");
    // The model's arguments stay small; Kumi's own calls can carry a Set comparison, however big the Set.
    if (Buffer.byteLength(JSON.stringify(args)) > (options.host ? MAX_HOST_RESULT_BYTES : 16 * 1024)) throw new Error("Tool arguments are too large; narrow the request");
    const invalidation = this.invalidation;
    // A Remote Script older than its host (Live keeps the one it loaded when it started) refuses
    // discovery pages over 100 rows: such a page is asked again at 100, and from then on for this bridge.
    const big = name === "live_discover" && typeof args.limit === "number" && args.limit > SMALL_PAGE;
    let result = await this.endpoint.call(name, big && this.smallPages ? { ...args, limit: SMALL_PAGE } : args, signal);
    if (big && !this.smallPages && result.isError) {
      const retried = await this.endpoint.call(name, { ...args, limit: SMALL_PAGE }, signal);
      if (!retried.isError) { this.smallPages = true; result = retried; }
    }
    signal.throwIfAborted();
    if (!options.host && (!this.isValid || invalidation !== this.invalidation)) throw new Error("MCP catalog changed during the call; result discarded");
    // Kumi's own calls (a Set export, a large clip's apply) may be bigger; what reaches the model is bounded where it's encoded.
    if (Buffer.byteLength(JSON.stringify(result)) > (options.host ? MAX_HOST_RESULT_BYTES : MAX_RESULT_BYTES)) {
      return { isError: true, content: [{ type: "text", text: "Result too large; narrow fields/parent/page instead of requesting a whole Set dump." }] };
    }
    return result; // Preserve isError, structuredContent, content and original schemas/names.
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.valid = false; this.catalog.clear(); this.invalidation++;
    for (const remove of this.unlisten) remove();
    this.unlisten = [];
    this.closing = this.endpoint.close();
    return this.closing;
  }
}
