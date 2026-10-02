/**
 * What Kumi is doing, as motion: each kind of task has its own small animation, so a step at work
 * reads as searching, reading, building or listening at a glance. A one-cell glyph for a step's row,
 * a wider scene for NOW, and a shimmer that passes over the words of whatever is under way.
 */
import { palette, type Rgb, type Style } from "./style.js";
import type { Span } from "./wrap.js";

export type Activity = "think" | "search" | "read" | "look" | "build" | "change" | "listen" | "watch" | "play" | "record" | "code";

const KINDS: Record<string, Activity> = {
  search_web: "search", live_browser_search: "search", find_samples: "search", live_browser_roots: "search", live_browser_inspect: "search",
  read_web: "read",
  server_status: "look", live_status: "look", live_discover: "look", live_snapshot: "look", live_note_read: "look", live_song_state: "look",
  live_performance_read: "look", live_key_estimate: "look", live_take_lane_read: "look", live_warp_marker_read: "look",
  live_arrangement_automation_read: "look", watch_me: "look", select: "look", show: "look",
  make_device: "build",
  listen: "listen", audition: "listen",
  watch_video: "watch",
  play: "play", fire_scene: "play", launch_clip: "play", jump_to_locator: "play",
  record: "record", capture_midi: "record",
  run_python: "code",
};

/** The kind of task a tool is; the rest change the Set. */
export function activityOf(tool: string | undefined): Activity {
  if (!tool) return "think";
  return KINDS[tool] ?? (tool.startsWith("live_") ? "look" : "change");
}

/** Each kind's one-cell frames, shown about ten a second. */
const GLYPHS: Record<Activity, readonly string[]> = {
  // Dots turning: thinking it over.
  think: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  // A dot circling, like a radar's sweep.
  search: ["⠁", "⠈", "⠐", "⠠", "⢀", "⡀", "⠄", "⠂"],
  // Eyes going down a page, line by line.
  read: ["⠉", "⠒", "⠤", "⣀", "⣀", "⠀"],
  // A gap going round: looking all over the Set.
  look: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
  // Filling up from the bottom: something being built.
  build: ["⡀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿", "⣿", "⠀"],
  // A fader going up and down.
  change: ["⣀", "⠤", "⠒", "⠉", "⠒", "⠤"],
  // A level meter.
  listen: ["▁", "▄", "▂", "▆", "▃", "▇", "▅", "▂"],
  // A reel turning.
  watch: ["◐", "◓", "◑", "◒"],
  play: ["▶", "▶", "▷", "▷"],
  record: ["●", "●", "○", "○"],
  // A block going round: code running.
  code: ["▖", "▘", "▝", "▗"],
};

/** The same, in characters every console font has (the old Windows console, where Kumi's icons are badges too). */
const PLAIN: Record<Activity, readonly string[]> = {
  think: ["|", "/", "-", "\\"], search: [".", "o", "O", "o"], read: ["-", "=", "-", " "], look: ["<", "^", ">", "v"],
  build: [".", ":", "|", "#", " "], change: ["-", "=", "+", "="], listen: [".", ":", "|", ":"], watch: ["o", "O"],
  play: [">", " "], record: ["*", " "], code: ["_", " "],
};

const FRAME_MS = 100;

/** The glyph for `kind` at `ms` into it, and its style (recording's in red); `plain` for consoles without the glyphs. */
export function activityGlyph(kind: Activity, ms: number, plain = false): Span {
  const frames = (plain ? PLAIN : GLYPHS)[kind];
  return { text: frames[Math.floor(Math.max(0, ms) / FRAME_MS) % frames.length]!, style: { fg: kind === "record" ? palette.error : palette.accent } };
}

/** `from` toward `to` by `amount` (0–1), in a few steps so the terminal's style table stays small. */
export function blend(from: Rgb, to: Rgb, amount: number, steps = 6): Rgb {
  const step = Math.round(Math.max(0, Math.min(1, amount)) * steps) / steps;
  return [0, 1, 2].map((index) => Math.round(from[index]! + (to[index]! - from[index]!) * step)) as unknown as Rgb;
}

/** Spans of one character each into as few spans as their styles allow. */
function joined(cells: Span[]): Span[] {
  const spans: Span[] = [];
  for (const cell of cells) {
    const last = spans[spans.length - 1];
    if (last && same(last.style, cell.style)) last.text += cell.text; else spans.push({ text: cell.text, style: { ...cell.style } });
  }
  return spans;
}
const same = (a: Style, b: Style) => a.fg?.join() === b.fg?.join() && a.bg?.join() === b.bg?.join() && Boolean(a.bold) === Boolean(b.bold);

/**
 * `text` with a band of light passing over it, left to right, every couple of seconds: the words
 * of what's under way, so they never sit still while Kumi works.
 */
export function shimmer(text: string, ms: number, base: Rgb = palette.dim, peak: Rgb = palette.bright): Span[] {
  const characters = [...text];
  const span = characters.length + 8;
  const center = ((ms / 1800) % 1) * span - 4;
  return joined(characters.map((character, index) => {
    const distance = Math.abs(index - center);
    return { text: character, style: { fg: blend(base, peak, Math.max(0, 1 - distance / 3.5)) } };
  }));
}

/** A smooth value 0–1 for each cell and moment: a level meter's bars, say. */
const wave = (cell: number, ms: number) => 0.5 + 0.22 * Math.sin(ms / 170 + cell * 1.7) + 0.18 * Math.sin(ms / 97 + cell * 0.9 + 1) + 0.1 * Math.sin(ms / 53 + cell * 2.3);
const BARS = "▁▂▃▄▅▆▇█";

/**
 * NOW's picture of what's under way, `width` cells wide: a scanner looking back and forth for a
 * search, a highlight going word by word for a page, tracks being looked over, blocks stacking up
 * for a device, a knob finding its place for a change, a level meter for listening, a playhead for
 * a video or Live playing, a line being typed for code, and a slow wave while thinking.
 */
export function activityScene(kind: Activity, ms: number, width: number): Span[] {
  const cells = Math.max(6, width);
  const t = Math.max(0, ms);
  const faint: Style = { fg: palette.rule };
  const dim: Style = { fg: palette.faint };
  const lit: Style = { fg: palette.accent };
  const out: Span[] = [];
  const put = (text: string, style: Style) => out.push({ text, style });
  switch (kind) {
    case "search": {
      // A scanner: a bright head going back and forth, its tail fading behind it.
      const period = 1600; const phase = (t % period) / period;
      const forward = phase < 0.5; const head = Math.round((forward ? phase * 2 : 2 - phase * 2) * (cells - 1));
      for (let cell = 0; cell < cells; cell++) {
        const behind = forward ? head - cell : cell - head;
        if (cell === head) put("●", lit);
        else if (behind > 0 && behind <= 3) put(["•", "∙", "·"][behind - 1]!, behind === 1 ? lit : dim);
        else put("·", faint);
      }
      break;
    }
    case "read": {
      // Words of a line, read one after another; then the next line.
      const line = Math.floor(t / 2400);
      const words: number[] = [];
      for (let used = 0, index = 0; used < cells; index++) {
        const length = 2 + ((line * 7 + index * 5) % 4);
        words.push(Math.min(length, cells - used));
        used += length + 1;
      }
      const reading = Math.floor((t % 2400) / (2400 / words.length));
      let used = 0;
      words.forEach((length, index) => {
        if (used >= cells) return;
        put("▬".repeat(length), index === reading ? lit : index < reading ? dim : faint);
        used += length;
        if (used < cells) { put(" ", faint); used++; }
      });
      break;
    }
    case "look": {
      // The Set's tracks side by side, looked over one by one.
      const tracks = Math.max(3, Math.floor((cells + 1) / 2));
      const at = Math.floor(t / 140) % (tracks + 3);
      for (let track = 0; track < tracks; track++) {
        const distance = at - track;
        put("▌", distance === 0 ? lit : distance === 1 ? dim : faint);
        if (track < tracks - 1) put(" ", faint);
      }
      break;
    }
    case "build": {
      // Blocks stacking up, one after another, until it's built; then again.
      const perCell = 120; const total = cells * perCell + 700;
      const at = t % total;
      for (let cell = 0; cell < cells; cell++) {
        const level = Math.floor((at - cell * perCell) / (perCell / 8));
        if (level <= 0) put("▁", faint);
        else put(BARS[Math.min(7, level)]!, at > cells * perCell ? lit : level >= 7 ? dim : lit);
      }
      break;
    }
    case "change": {
      // A knob gliding to a new place, filled up to it, again and again.
      const hop = 900; const from = settle(Math.floor(t / hop) - 1, cells); const to = settle(Math.floor(t / hop), cells);
      const ease = Math.min(1, (t % hop) / 450); const smooth = ease * ease * (3 - 2 * ease);
      const knob = Math.round(from + (to - from) * smooth);
      for (let cell = 0; cell < cells; cell++) put(cell === knob ? "●" : cell < knob ? "━" : "─", cell === knob ? lit : cell < knob ? dim : faint);
      break;
    }
    case "listen": {
      for (let cell = 0; cell < cells; cell++) {
        const level = Math.max(0, Math.min(7, Math.round(wave(cell, t) * 7)));
        put(BARS[level]!, level >= 5 ? lit : dim);
      }
      break;
    }
    case "watch": case "play": case "record": {
      // A playhead moving along, ticks on the beats behind it.
      const lead = kind === "record" ? "● " : "▶ ";
      put(lead, kind === "record" ? { fg: Math.floor(t / 500) % 2 ? palette.error : blend(palette.error, palette.surface, 0.5) } : lit);
      const length = Math.max(2, cells - 2);
      const head = Math.floor(t / 180) % length;
      for (let cell = 0; cell < length; cell++) put(cell === head ? "┃" : cell < head ? (kind === "watch" ? "━" : cell % 4 === 0 ? "┼" : "─") : "─", cell === head ? lit : cell < head ? dim : faint);
      break;
    }
    case "code": {
      // A line being typed, a block cursor blinking at its end; then the next line.
      const written = Math.floor(t / 90) % (cells + 6);
      for (let cell = 0; cell < cells; cell++) {
        if (cell < Math.min(written, cells - 1)) put((cell * 7) % 5 === 3 ? " " : "▪", dim);
        else if (cell === Math.min(written, cells - 1)) put(Math.floor(t / 400) % 2 ? " " : "▌", lit);
        else put(" ", faint);
      }
      break;
    }
    default: {
      // A slow wave of dots: thinking.
      for (let cell = 0; cell < cells; cell++) {
        const level = 0.5 + 0.5 * Math.sin(t / 260 - cell * 0.55);
        put(level > 0.85 ? "●" : level > 0.6 ? "•" : level > 0.35 ? "∙" : "·", level > 0.85 ? lit : level > 0.35 ? dim : faint);
      }
    }
  }
  // Every scene is exactly as wide as asked, so what's beside it stays put.
  const used = out.reduce((sum, span) => sum + [...span.text].length, 0);
  if (used < cells) put(" ".repeat(cells - used), faint);
  return joined(out);
}

/** Where the change scene's knob settles on its `n`th hop: somewhere new each time, the same each run. */
function settle(n: number, cells: number): number {
  const seed = Math.sin((n + 3) * 12.9898) * 43758.5453;
  return Math.floor((seed - Math.floor(seed)) * (cells - 2)) + 1;
}
