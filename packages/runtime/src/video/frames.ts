/** A frame, or a stretch of sound, from a video: a stream's address (with its headers) or a file. */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { run } from "./programs.js";

export interface Input { url: string; headers?: Record<string, string> }
export interface Thumb { width: number; height: number; rgb: Buffer }

/** The small picture of a frame drawn in the terminal: this many pixels across (a 16:9 frame is 18 high). */
export const THUMB_WIDTH = 32;

/** ffmpeg's input arguments for a stream or a file, starting at `at` seconds. */
function source(input: Input, at: number): string[] {
  const headers = Object.entries(input.headers ?? {}).filter(([key, value]) => /^[A-Za-z0-9-]+$/.test(key) && !/[\r\n]/.test(value));
  return [...(headers.length ? ["-headers", headers.map(([key, value]) => `${key}: ${value}\r\n`).join("")] : []),
    ...(/^https?:/i.test(input.url) ? ["-rw_timeout", "20000000"] : []), "-ss", at.toFixed(2), "-i", input.url];
}

async function into(path: string, write: (temporary: string) => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}${path.slice(path.lastIndexOf("."))}`);
  try { await write(temporary); await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** Parts of the picture to look at closely, as ffmpeg crops (width:height:x:y); Live's devices are at the bottom. */
export const REGIONS = {
  top: "iw:ih*0.4:0:0", bottom: "iw:ih*0.4:0:ih*0.6", left: "iw*0.5:ih:0:0", right: "iw*0.5:ih:iw*0.5:0", center: "iw*0.6:ih*0.6:iw*0.2:ih*0.2",
  "top-left": "iw*0.5:ih*0.5:0:0", "top-right": "iw*0.5:ih*0.5:iw*0.5:0", "bottom-left": "iw*0.5:ih*0.5:0:ih*0.5", "bottom-right": "iw*0.5:ih*0.5:iw*0.5:ih*0.5",
} as const;
export type Region = keyof typeof REGIONS;

/**
 * The frame at `at` as a JPEG (cached at `path`), with its thumbnail: the whole picture up to 1280
 * wide, or a `region` of it up to 1600 wide (from the sharpest stream, to read small print).
 * `input` may be left out when the frame is cached.
 */
export async function frameAt(ffmpeg: string, input: Input | undefined, at: number, path: string, signal?: AbortSignal, region?: Region): Promise<{ jpeg: Buffer; thumb: Thumb }> {
  if (!existsSync(path)) {
    if (!input) throw new Error("there's no stream to take it from");
    const filter = region ? `crop=${REGIONS[region]},scale='min(1600,iw)':-2` : "scale='min(1280,iw)':-2";
    await into(path, (temporary) => run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", ...source(input, at), "-frames:v", "1",
      "-vf", filter, "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "-y", temporary], { timeoutMs: 60_000, ...(signal ? { signal } : {}) }).then(() => {}));
  }
  const jpeg = await readFile(path);
  return { jpeg, thumb: await thumbOf(ffmpeg, path, signal) };
}

/** A frame's thumbnail: its pixels, THUMB_WIDTH across and as tall as its shape makes it (18 for 16:9), three bytes each. */
export async function thumbOf(ffmpeg: string, jpeg: string, signal?: AbortSignal): Promise<Thumb> {
  // A PPM says its own size: a close-up is wider than 16:9.
  const { stdout } = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", jpeg, "-vf", `scale=${THUMB_WIDTH}:-2`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "ppm", "-"],
    { encoding: "buffer", timeoutMs: 20_000, ...(signal ? { signal } : {}) });
  const data = stdout as Buffer;
  const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(data.subarray(0, 32).toString("latin1"));
  const width = Number(header?.[1]); const height = Number(header?.[2]);
  const rgb = header ? data.subarray(header[0].length) : Buffer.alloc(0);
  if (!header || width !== THUMB_WIDTH || height < 2 || height > THUMB_WIDTH || rgb.length !== width * height * 3) throw new Error("the frame's thumbnail came out wrong");
  return { width, height, rgb: Buffer.from(rgb) };
}

/**
 * `from`–`to` seconds of the sound as a WAV (cached at `path`): 44.1 kHz stereo to listen to, or
 * 16 kHz mono (`speech`) for transcribing.
 */
export async function soundBetween(ffmpeg: string, input: Input, from: number, to: number, path: string, signal?: AbortSignal, speech = false): Promise<string> {
  if (!existsSync(path)) {
    await into(path, (temporary) => run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", ...source(input, from), "-t", (to - from).toFixed(2), "-vn",
      "-ac", speech ? "1" : "2", "-ar", speech ? "16000" : "44100", "-c:a", "pcm_s16le", "-f", "wav", "-y", temporary], { timeoutMs: 10 * 60_000, ...(signal ? { signal } : {}) }).then(() => {}));
  }
  return path;
}

/** A local video's length in seconds, from ffprobe (beside ffmpeg); undefined when it can't say. */
export async function durationOf(ffmpeg: string, file: string, signal?: AbortSignal): Promise<number | undefined> {
  const probe = ffmpeg === "ffmpeg" ? "ffprobe" : join(dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  try {
    const { stdout } = await run(probe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeoutMs: 20_000, ...(signal ? { signal } : {}) });
    const seconds = Number(String(stdout).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch { return undefined; }
}
