/**
 * Reading Live's own files (Sets, presets, racks): gzipped XML, read as a stream of tags without
 * building a tree, so a 30 MB Set takes a fraction of a second and little memory. Only tags and
 * their attributes are seen: Live keeps its values in attributes, and text (sample data, plug-in
 * state) is skipped over.
 */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { constants, createGunzip, gunzipSync } from "node:zlib";

export interface TagHandler {
  /** A tag opened; `attrs` is its raw attribute text, read with attribute(). `empty`: it closed itself (<Tag />). */
  open(name: string, attrs: string, empty: boolean): void;
  close(name: string): void;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const decode = (value: string) => (value.includes("&") ? value.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (_, name: string) => {
  if (name[0] !== "#") return ENTITIES[name]!;
  const code = name[1] === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}) : value);

/** One attribute's value from a tag's raw attribute text, its entities decoded. */
export function attribute(attrs: string, name: string): string | undefined {
  let at = attrs.indexOf(`${name}=`);
  // A longer name that ends in this one ("UserName" when asking for "Name") isn't it.
  while (at > 0 && !/\s/.test(attrs[at - 1]!)) at = attrs.indexOf(`${name}=`, at + 1);
  if (at < 0) return undefined;
  const quote = attrs[at + name.length + 1];
  if (quote !== "\"" && quote !== "'") return undefined;
  const end = attrs.indexOf(quote, at + name.length + 2);
  return end < 0 ? undefined : decode(attrs.slice(at + name.length + 2, end));
}

/**
 * Scan tags in `text` from the start; returns where an unfinished tag begins (or the end), so the
 * caller keeps the rest for the next piece of the stream.
 */
export function scanTags(text: string, handler: TagHandler): number {
  let at = 0;
  const length = text.length;
  while (at < length) {
    const start = text.indexOf("<", at);
    if (start < 0) return length;
    const next = text.charCodeAt(start + 1);
    if (Number.isNaN(next)) return start;
    // <?xml ?>, comments and CDATA aren't Live's values.
    if (next === 63 /* ? */ || next === 33 /* ! */) {
      const closer = text.startsWith("<!--", start) ? "-->" : text.startsWith("<![CDATA[", start) ? "]]>" : ">";
      const end = text.indexOf(closer, start + 2);
      if (end < 0) return start;
      at = end + closer.length;
      continue;
    }
    // The tag ends at the first > outside quotes (a value may hold one).
    let end = start + 1;
    for (;;) {
      if (end >= length) return start;
      const code = text.charCodeAt(end);
      if (code === 62 /* > */) break;
      if (code === 34 || code === 39) {
        const close = text.indexOf(code === 34 ? "\"" : "'", end + 1);
        if (close < 0) return start;
        end = close + 1;
        continue;
      }
      end++;
    }
    if (next === 47 /* / */) handler.close(text.slice(start + 2, end).trim());
    else {
      const empty = text.charCodeAt(end - 1) === 47;
      const inner = text.slice(start + 1, empty ? end - 1 : end);
      const space = inner.search(/[\s/]/);
      const name = space < 0 ? inner : inner.slice(0, space);
      const attrs = space < 0 ? "" : inner.slice(space);
      handler.open(name, attrs, empty);
      if (empty) handler.close(name);
    }
    at = end + 1;
  }
  return length;
}

/** Live's files are gzipped; one saved by hand may be plain XML. */
const gzipped = (bytes: Buffer) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/**
 * Every tag of a gzipped (or plain) XML file, in order, as the file streams in. `maxBytes` bounds the
 * XML read, so a damaged or hostile file can't fill memory; `stop()` ends the read early.
 */
export async function scanXmlFile(path: string, handler: TagHandler & { stop?(): boolean }, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<void> {
  const head = Buffer.alloc(2);
  const file = await open(path, "r");
  try { await file.read(head, 0, 2, 0); } finally { await file.close(); }
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const source = createReadStream(path, { highWaterMark: 256 * 1024 });
  const stream = gzipped(head) ? source.pipe(createGunzip({ chunkSize: 256 * 1024 })) : source;
  const decoder = new StringDecoder("utf8");
  let pending = ""; let read = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      options.signal?.throwIfAborted();
      read += chunk.length;
      if (read > maxBytes) throw new Error("That file is larger than Kumi reads.");
      const text = pending + decoder.write(chunk);
      pending = text.slice(scanTags(text, handler));
      if (handler.stop?.()) break;
    }
  } finally { source.destroy(); if (stream !== source) (stream as ReturnType<typeof createGunzip>).destroy(); }
}

/**
 * The start of a gzipped (or plain) XML file as text: its first `bytes` on disk, unzipped as far as
 * they go. A preset's device and name are in its first few kilobytes.
 */
export async function xmlHead(path: string, bytes = 16 * 1024): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, 0);
    const data = buffer.subarray(0, bytesRead);
    if (!gzipped(data)) return data.toString("utf8");
    // A cut-off gzip stream unzips as far as it goes, with no error.
    return gunzipSync(data, { finishFlush: constants.Z_SYNC_FLUSH }).toString("utf8");
  } finally { await file.close(); }
}
