/**
 * Kumi's way onto the web: http and https only, and only to public addresses. A name is checked
 * before anything is sent, and again on every address it resolves to as the connection is made, so
 * a page can't point Kumi at this computer or a private network, not by a redirect either. Bodies
 * are capped, and what comes back is untrusted: the tools that read it say so.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { KUMI_VERSION } from "../version.js";

/** Something Kumi couldn't read, said so the model and the producer can act on it. */
export class WebError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

/** Sites answer a browser; Kumi says who it is too. */
export const WEB_USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Kumi/${KUMI_VERSION}`;

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;
export const MAX_BYTES = 5 * 1024 * 1024;

const PRIVATE = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) PRIVATE.addSubnet(net, prefix, "ipv4");
// ::/96 holds :: and ::1; an IPv4 address written as IPv6 (::ffff:10.0.0.1) is checked as IPv4.
for (const [net, prefix] of [["::", 96], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["64:ff9b:1::", 48], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

/** Whether an IP address is this computer, a private network, or otherwise not somewhere public. */
export function privateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  const family = isIP(bare);
  if (family === 4) return PRIVATE.check(bare, "ipv4");
  if (family !== 6) return true;
  // NAT64 carries an IPv4 address in its last 32 bits: that address decides.
  const nat64 = /^64:ff9b::(.+)$/.exec(bare)?.[1];
  if (nat64) {
    if (nat64.includes(".")) return privateAddress(nat64);
    const words = nat64.split(":").map((word) => Number.parseInt(word || "0", 16));
    const [high = 0, low = 0] = words.length >= 2 ? words.slice(-2) : [0, words[0] ?? 0];
    return privateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return PRIVATE.check(bare, "ipv6");
}

/** Whether a host name is somewhere public by its name alone (an IP address, by `allow`). */
export function publicHost(hostname: string, allow: (address: string) => boolean = (address) => !privateAddress(address)): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  if (isIP(host.replace(/%.*$/, ""))) return allow(host);
  if (host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host) || !host.includes(".")) return false;
  return true;
}

export interface WebRequest {
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: string;
  signal?: AbortSignal;
  /** The most read; the rest isn't (truncated). */
  maxBytes?: number;
  timeoutMs?: number;
  /** Whether to read a body of this type at all: a PDF, say, is handed on by its address. */
  wants?: (contentType: string) => boolean;
}

export interface WebResponse {
  /** Where it came from in the end, after redirects. */
  url: string;
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Its media type, lower case, without parameters ("text/html"). */
  contentType: string;
  /** The charset its Content-Type names, if any. */
  charset?: string;
  body: Buffer;
  /** The body was longer than maxBytes. */
  truncated: boolean;
  /** `wants` turned the body down, so none was read. */
  skipped: boolean;
}

export interface WebClient {
  fetch(url: string, request?: WebRequest): Promise<WebResponse>;
}

export interface WebClientOptions {
  /** How names become addresses (the system's, by default). */
  lookup?: typeof dnsLookup;
  /** Which addresses Kumi may connect to: public ones only, except in tests. */
  allow?: (address: string) => boolean;
}

/** An address Kumi may read: http(s), no credentials in it, and public by name. */
export function checkedUrl(value: string, allow?: (address: string) => boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new WebError(`That isn't a web address: ${value.slice(0, 200)}`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebError(`Kumi reads http and https addresses, not ${url.protocol.replace(/:$/, "")}.`);
  if (url.username || url.password) throw new WebError("Kumi doesn't send names or passwords inside an address.");
  if (!publicHost(url.hostname, allow)) throw new WebError(`Kumi reads only public web addresses, not this computer or a private network (${url.hostname}).`);
  return url;
}

/** The system's lookup, refusing a name any of whose addresses isn't public. */
function guardedLookup(resolve: typeof dnsLookup, allow: (address: string) => boolean): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number }, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname, { family: options.family ?? 0, all: true }, (error, addresses) => {
      if (error) { callback(error, ""); return; }
      const list = addresses as LookupAddress[];
      if (!list.length || list.some((entry) => !allow(entry.address))) {
        callback(Object.assign(new WebError(`Kumi reads only public web addresses, and ${hostname} is on this computer or a private network.`), { code: "EKUMIPRIVATE" }), "");
        return;
      }
      if (options.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  }) as LookupFunction;
}

const STATUS_WORDS: Record<number, string> = { 401: "it needs a sign-in", 403: "it refused Kumi", 404: "there's nothing at that address", 410: "it's gone", 429: "it's had too many requests; try again in a while", 451: "it's unavailable here" };

function locale(): string {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale;
    const base = tag.split("-")[0];
    return base && base !== tag ? `${tag},${base};q=0.9,*;q=0.5` : `${tag},*;q=0.5`;
  } catch { return "en;q=0.9,*;q=0.5"; }
}

export function createWebClient(options: WebClientOptions = {}): WebClient {
  const allow = options.allow ?? ((address: string) => !privateAddress(address));
  const lookup = guardedLookup(options.lookup ?? dnsLookup, allow);
  const language = locale();

  function once(url: URL, request: WebRequest, signal: AbortSignal): Promise<{ response: IncomingMessage; stream: Readable }> {
    return new Promise((resolve, reject) => {
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const headers: Record<string, string> = { "user-agent": WEB_USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "accept-language": language, "accept-encoding": "gzip, deflate, br", ...request.headers };
      if (request.body !== undefined) headers["content-length"] = String(Buffer.byteLength(request.body));
      const req = send(url, { method: request.method ?? "GET", headers, lookup, signal, maxHeaderSize: 64 * 1024 }, (response) => {
        const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase().trim();
        const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : undefined;
        const stream: Readable = decoder ? response.pipe(decoder) : response;
        if (decoder) response.on("error", (error) => decoder.destroy(error));
        resolve({ response, stream });
      });
      req.on("error", reject);
      if (request.body !== undefined) req.write(request.body);
      req.end();
    });
  }

  async function body(stream: Readable, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    try {
      for await (const chunk of stream) {
        const piece = chunk as Buffer;
        if (total + piece.length > maxBytes) { chunks.push(piece.subarray(0, maxBytes - total)); total = maxBytes; truncated = true; break; }
        chunks.push(piece); total += piece.length;
      }
    } finally { stream.destroy(); }
    return { body: Buffer.concat(chunks, total), truncated };
  }

  return {
    async fetch(address, request = {}) {
      const timeoutMs = request.timeoutMs ?? TIMEOUT_MS;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const maxBytes = request.maxBytes ?? MAX_BYTES;
      let url = checkedUrl(address, allow);
      let method = request.method ?? "GET";
      let payload = request.body;
      try {
        for (let hop = 0; ; hop++) {
          const { response, stream } = await once(url, { ...request, method, ...(payload !== undefined ? { body: payload } : {}) }, signal);
          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          if ([301, 302, 303, 307, 308].includes(status) && location) {
            stream.destroy();
            if (hop >= MAX_REDIRECTS) throw new WebError(`${url.hostname} sent Kumi through too many redirects.`);
            url = checkedUrl(new URL(location, url).href, allow);
            // As browsers do: a 303, or a 301/302 after a POST, fetches the new address plainly.
            if (status === 303 || ((status === 301 || status === 302) && method === "POST")) { method = "GET"; payload = undefined; }
            continue;
          }
          const type = String(response.headers["content-type"] ?? "");
          const contentType = type.split(";")[0]!.trim().toLowerCase();
          const charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(type)?.[1];
          if (request.wants && !request.wants(contentType)) {
            stream.destroy();
            return { url: url.href, status, headers: response.headers, contentType, ...(charset ? { charset } : {}), body: Buffer.alloc(0), truncated: false, skipped: true };
          }
          const read = await body(stream, maxBytes);
          return { url: url.href, status, headers: response.headers, contentType, ...(charset ? { charset } : {}), ...read, skipped: false };
        }
      } catch (error) {
        request.signal?.throwIfAborted();
        if (error instanceof WebError) throw error;
        if (timeout.aborted) throw new WebError(`${url.hostname} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EKUMIPRIVATE") throw new WebError((error as Error).message);
        if (code === "ENOTFOUND" || code === "EAI_AGAIN") throw new WebError(`Kumi couldn't find ${url.hostname}: check the address, or the internet connection.`);
        if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") throw new WebError(`${url.hostname} wouldn't connect (${code}).`);
        if (code === "CERT_HAS_EXPIRED" || code?.startsWith("ERR_TLS") || code?.includes("CERT")) throw new WebError(`${url.hostname}'s secure connection didn't check out (${code}), so Kumi didn't read it.`);
        throw new WebError(`Kumi couldn't read ${url.hostname}: ${error instanceof Error ? error.message.slice(0, 160) : "it failed"}.`);
      }
    },
  };
}

/** Why a status isn't a page, in a few words ("it refused Kumi"). */
export function statusWords(status: number): string {
  return STATUS_WORDS[status] ?? (status >= 500 ? `its server had trouble (${status})` : `it answered ${status}`);
}

/** A body as text, by its charset or the page's own <meta charset>, UTF-8 otherwise. */
export function decodeText(body: Buffer, charset?: string): string {
  let label = charset;
  if (!label) {
    const head = body.subarray(0, 2048).toString("latin1");
    label = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  }
  try { return new TextDecoder(label ?? "utf-8").decode(body); } catch { return new TextDecoder("utf-8").decode(body); }
}
