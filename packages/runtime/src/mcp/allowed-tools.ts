import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "../core/contracts.js";
import type { McpEndpoint } from "./client.js";

const ALLOWED = new Set(["server_status", "live_status", "live_snapshot", "live_discover"]);
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;

/** Host-owned authorization boundary; model instructions and annotations confer no authority. */
export class AllowedTools {
  private catalog = new Map<string, Tool>();
  private valid = false;
  private closed = false;
  private invalidation = 0;
  private signature = "";
  private revision = 0;
  private unlisten: (() => void)[];
  private closing: Promise<void> | undefined;

  constructor(private readonly endpoint: McpEndpoint) {
    const invalidate = () => { this.valid = false; this.catalog.clear(); this.invalidation++; };
    this.unlisten = [endpoint.onCatalogChanged(invalidate), endpoint.onDisconnect(invalidate)];
  }
  get generation() { return this.revision; }
  get isValid() { return this.valid && !this.closed; }
  list(): Tool[] { return this.isValid ? structuredClone([...this.catalog.values()]) : []; }
  has(name: string): boolean { return this.isValid && ALLOWED.has(name) && this.catalog.has(name); }

  async refresh(signal: AbortSignal): Promise<void> {
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
        if (ALLOWED.has(tool.name)) next.set(tool.name, structuredClone(tool));
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

  async call(name: string, args: JsonObject, signal: AbortSignal): Promise<CallToolResult> {
    signal.throwIfAborted();
    if (!ALLOWED.has(name)) throw new Error("Tool is not in Kumi's allowed tool list");
    if (!this.isValid) throw new Error("MCP catalog is invalid; refresh before calling tools");
    if (!this.catalog.has(name)) throw new Error("Tool is not currently available or permitted");
    if (Buffer.byteLength(JSON.stringify(args)) > 16 * 1024) throw new Error("Tool arguments are too large; narrow the request");
    const invalidation = this.invalidation;
    const result = await this.endpoint.call(name, args, signal);
    signal.throwIfAborted();
    if (!this.isValid || invalidation !== this.invalidation) throw new Error("MCP catalog changed during the call; result discarded");
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
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
