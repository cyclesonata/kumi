/**
 * The library on disk: one log per kind (sounds, presets, Sets), a line of JSON per file, appended
 * as each is learned, so learning that stops (Kumi quits, the computer sleeps) carries on where it
 * was. A file learned again adds a line that replaces the one before; one that's gone adds a line
 * saying so; now and then the log is written afresh with only what stands. A reader keeps its place
 * and reads only what was added since.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Put a written file in place; on Windows a reader holding the old one briefly refuses it, so it's tried again. */
async function replace(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

/** Every entry is about one file, as it was when learned. */
export interface Entry { path: string; size: number; mtime: number; gone?: true }
interface Header { kumiLibrary: string; version: number; generation: string; created: number }

/** Files Kumi writes that only this user can read: the library says what's on their computer. */
const PRIVATE = { mode: 0o600 } as const;

async function readHeader(file: string): Promise<Header | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    const line = buffer.toString("utf8", 0, bytesRead).split("\n")[0]!;
    const header = JSON.parse(line) as Partial<Header>;
    return typeof header.kumiLibrary === "string" && typeof header.version === "number" && typeof header.generation === "string" ? header as Header : undefined;
  } catch { return undefined; }
  finally { await handle?.close().catch(() => {}); }
}

/** A log of entries of one kind, at one version: an older version's log is started afresh. */
export class Log<T extends Entry> {
  constructor(readonly file: string, readonly kind: string, readonly version: number) {}

  /** What stands in the log now, by path. */
  async load(): Promise<Map<string, T>> {
    const header = await readHeader(this.file);
    if (!header || header.kumiLibrary !== this.kind || header.version !== this.version) return new Map();
    const text = await readFile(this.file, "utf8").catch(() => "");
    const entries = new Map<string, T>();
    applyLines(text.slice(text.indexOf("\n") + 1), entries);
    return entries;
  }

  /** Add entries (learned, or gone) at the end; a log that isn't this version's is started first. */
  async append(entries: readonly (T | Entry)[]): Promise<void> {
    if (!entries.length) return;
    const header = await readHeader(this.file);
    if (!header || header.kumiLibrary !== this.kind || header.version !== this.version) await this.write([]);
    await appendFile(this.file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), PRIVATE);
  }

  /** The log written afresh with only `entries`: a new generation, which readers load whole. */
  async write(entries: Iterable<T>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const header: Header = { kumiLibrary: this.kind, version: this.version, generation: randomUUID(), created: Date.now() };
    const lines = [JSON.stringify(header)];
    for (const entry of entries) lines.push(JSON.stringify(entry));
    const temporary = join(dirname(this.file), `.${this.kind}-${randomUUID()}`);
    try {
      await writeFile(temporary, `${lines.join("\n")}\n`, PRIVATE);
      await replace(temporary, this.file);
    } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}

/** Apply a log's lines to `entries`; a line cut off by a crash is left out. */
function applyLines<T extends Entry>(text: string, entries: Map<string, T>): void {
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: T;
    try { entry = JSON.parse(line) as T; } catch { continue; }
    if (typeof entry?.path !== "string") continue;
    if (entry.gone) entries.delete(entry.path); else { entries.delete(entry.path); entries.set(entry.path, entry); }
  }
}

/**
 * Reading a log as it grows: the first read loads it whole, later ones only what was appended since
 * (or the whole again when it was written afresh). `changed` says whether anything did.
 */
export class LogReader<T extends Entry> {
  private generation: string | undefined;
  private offset = 0;
  readonly entries = new Map<string, T>();

  constructor(readonly file: string, readonly kind: string, readonly version: number) {}

  async refresh(): Promise<{ changed: boolean; reloaded: boolean }> {
    const header = await readHeader(this.file);
    if (!header || header.kumiLibrary !== this.kind || header.version !== this.version) {
      const had = this.entries.size > 0;
      this.entries.clear(); this.generation = undefined; this.offset = 0;
      return { changed: had, reloaded: had };
    }
    const size = await stat(this.file).then((info) => info.size, () => 0);
    const reloaded = header.generation !== this.generation || size < this.offset;
    if (reloaded) { this.entries.clear(); this.offset = 0; this.generation = header.generation; }
    if (size === this.offset) return { changed: reloaded, reloaded };
    const handle = await open(this.file, "r");
    try {
      const buffer = Buffer.alloc(size - this.offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      // Only whole lines: one being written now is read next time.
      const end = buffer.lastIndexOf(10, bytesRead - 1);
      if (end < 0) return { changed: reloaded, reloaded };
      let text = buffer.toString("utf8", 0, end + 1);
      if (this.offset === 0) text = text.slice(text.indexOf("\n") + 1);
      this.offset += end + 1;
      await applyChunked(text, this.entries);
      return { changed: true, reloaded };
    } finally { await handle.close(); }
  }
}

/** Big logs are read a few thousand lines at a time, so the screen keeps drawing meanwhile. */
async function applyChunked<T extends Entry>(text: string, entries: Map<string, T>): Promise<void> {
  const CHUNK = 1 << 20;
  let at = 0;
  while (at < text.length) {
    let end = text.indexOf("\n", Math.min(text.length - 1, at + CHUNK));
    if (end < 0) end = text.length - 1;
    applyLines(text.slice(at, end + 1), entries);
    at = end + 1;
    if (at < text.length) await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A small JSON file written whole (state, settings of the library's own): unreadable is undefined. */
export async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return undefined; }
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.${randomUUID()}.json`);
  try { await writeFile(temporary, `${JSON.stringify(value, null, 1)}\n`, PRIVATE); await replace(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** Numbers as compact text in a log: a Float32 vector in base64. */
export const packVector = (values: readonly number[]) => Buffer.from(Float32Array.from(values).buffer).toString("base64");
export function unpackVector(text: string): Float32Array {
  const bytes = Buffer.from(text, "base64");
  const copy = new Uint8Array(bytes.length - (bytes.length % 4)); copy.set(bytes.subarray(0, copy.length));
  return new Float32Array(copy.buffer);
}
