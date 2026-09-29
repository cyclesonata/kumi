/**
 * Free space before Kumi writes something big (a recording, a video, a program) or something that
 * must not be cut short (a device file): with the disk nearly full, Live's recordings and saves and
 * Kumi's own files fail partway, often without saying why.
 */
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";

/** Free space on the disk holding `path` (its nearest folder that exists), in bytes; undefined when the system won't say. */
export async function freeBytes(path: string): Promise<number | undefined> {
  let at = path;
  while (!existsSync(at)) { const up = dirname(at); if (up === at) return undefined; at = up; }
  try { const stats = await statfs(at); return Number(stats.bavail) * Number(stats.bsize); } catch { return undefined; }
}

export const MB = 1_000_000;
const size = (bytes: number) => (bytes >= 1_000 * MB ? `${(bytes / (1_000 * MB)).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / MB))} MB`);

/**
 * Why not to go ahead, in plain words, when the disk holding `path` has less than `needed` free
 * (what `what` would need); undefined when there's room, or the system won't say.
 */
export async function lowDisk(path: string, needed: number, what: string, free: (path: string) => Promise<number | undefined> = freeBytes): Promise<string | undefined> {
  const left = await free(path).catch(() => undefined);
  if (left === undefined || left >= needed) return undefined;
  return `Only ${size(left)} is free on the disk ${what}, so it would likely fail partway. Free some space (empty the Trash or Recycle Bin, or move old bounces and videos off that disk), then try again.`;
}
