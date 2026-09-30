/** A video's captions as timed lines the model can read: YouTube's json3, WebVTT and SRT. */

export interface Cue { start: number; end: number; text: string }

/** "2:05", "1:02:03", "125" or 125 → seconds; undefined when it isn't a time. */
export function parseTime(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** 125 → "2:05", 3723 → "1:02:03". */
export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600); const minutes = Math.floor((whole % 3600) / 60); const secs = whole % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** A caption's words: no markup, entities or sound tags ("[Music]"). */
const clean = (text: string) => text.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
  .replace(/\[[^\]]{1,30}\]/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

function json3(text: string): Cue[] {
  let value: { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] };
  try { value = JSON.parse(text) as typeof value; } catch { return []; }
  const cues: Cue[] = [];
  for (const event of value.events ?? []) {
    if (!Array.isArray(event.segs) || typeof event.tStartMs !== "number") continue;
    const line = clean(event.segs.map((seg) => seg.utf8 ?? "").join(""));
    if (!line) continue;
    const start = event.tStartMs / 1000;
    cues.push({ start, end: start + (event.dDurationMs ?? 0) / 1000, text: line });
  }
  return cues;
}

const TIMING = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{3})/;
const seconds = (hours: string | undefined, minutes: string, secs: string, millis: string) => Number((hours ?? "0:").slice(0, -1) || 0) * 3600 + Number(minutes) * 60 + Number(secs) + Number(millis) / 1000;

/** WebVTT and SRT: timed blocks. YouTube's automatic WebVTT repeats each line as it rolls up; repeats go. */
function blocks(text: string): Cue[] {
  const cues: Cue[] = [];
  let last = "";
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => TIMING.test(line));
    if (at < 0) continue;
    const match = TIMING.exec(lines[at]!)!;
    const start = seconds(match[1], match[2]!, match[3]!, match[4]!); const end = seconds(match[5], match[6]!, match[7]!, match[8]!);
    for (const raw of lines.slice(at + 1)) {
      const line = clean(raw);
      if (!line || line === last) continue;
      cues.push({ start, end, text: line });
      last = line;
    }
  }
  return cues;
}

export function parseCaptions(text: string, format: string): Cue[] {
  const cues = format === "json3" ? json3(text) : blocks(text);
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * Cues as the lines the model reads: joined into sentences of up to about `chars` characters, a
 * new line at a pause (or a sentence's end once long enough), each with the time it starts.
 */
export function transcriptLines(cues: readonly Cue[], options: { from?: number; to?: number; chars?: number } = {}): { at: number; text: string }[] {
  const from = options.from ?? 0; const to = options.to ?? Infinity; const chars = options.chars ?? 220;
  const lines: { at: number; text: string }[] = [];
  let current: { at: number; text: string; end: number } | undefined;
  for (const cue of cues) {
    if (cue.end < from || cue.start > to) continue;
    const pause = current ? cue.start - current.end > 2.5 : false;
    const ended = current ? /[.!?]$/.test(current.text) && current.text.length > chars / 2 : false;
    if (!current || pause || ended || current.text.length + cue.text.length > chars) {
      if (current) lines.push({ at: current.at, text: current.text });
      current = { at: cue.start, text: cue.text, end: cue.end };
    } else { current.text = `${current.text} ${cue.text}`; current.end = Math.max(current.end, cue.end); }
  }
  if (current) lines.push({ at: current.at, text: current.text });
  return lines;
}

/** What was said around `at` (a few seconds either side), for the line under a frame. */
export function saidAround(cues: readonly Cue[], at: number, span = 4): string {
  return cues.filter((cue) => cue.end >= at - span && cue.start <= at + span / 2).map((cue) => cue.text).join(" ").slice(0, 240);
}
