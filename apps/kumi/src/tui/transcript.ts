/** The conversation as entries, and how each entry becomes rows at a given width. */
import { activityOf, blend, type Activity } from "./activity.js";
import { palette, type Rgb, type Style } from "./style.js";
import { textWidth } from "./width.js";
import { renderMarkdown } from "./markdown.js";
import { wrap, type Span } from "./wrap.js";

export interface Step {
  id: string;
  /** The tool it ran, for what NOW says while it runs. */
  tool?: string;
  label: string;
  state: "running" | "done" | "error";
  ms?: number;
  /** What it's doing now, when the tool says ("looking at 2:05"). */
  doing?: string;
  /** When it started and ended (performance.now()); unknown for a conversation brought back. */
  startedAt?: number;
  endedAt?: number;
  /** When it began folding into the same step just above it (see foldSteps). */
  folded?: number;
}

/** What Kumi keeps: notes (✎), techniques (◆) and recipes (↻). */
export type MemoryKind = "note" | "technique" | "recipe" | "lesson";
export const MEMORY_GLYPHS: Record<MemoryKind, string> = { note: "✎", technique: "◆", recipe: "↻", lesson: "✦" };

/** A frame's small picture: RGB, three bytes a pixel, row by row. */
export interface Picture { width: number; height: number; rgb: Uint8Array }

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; steps: Step[]; status: "running" | "done" | "stopped" | "failed"; elapsedMs?: number; startedAt?: number }
  | { kind: "notice"; text: string; tone: "info" | "warn" }
  /** A line across the conversation: what's above it is a conversation Kumi no longer uses, say. */
  | { kind: "divider"; text: string }
  /** Something Kumi kept, used or forgot: a note, a technique or a recipe, each with its glyph and colour. */
  | { kind: "memory"; what: MemoryKind; text: string }
  /** Audio Kumi listened to: its tonal balance, or its differences from a reference. */
  | { kind: "heard"; file: string; summary: string; bands: number[]; compared?: { reference: string; summary: string; differences: number[] } }
  /** An audition: its round, the best score and the one before, what differs most, and each candidate's score. */
  | { kind: "auditioned"; round: number; best?: { label: string; score: number }; previous?: number; takes: { label: string; score?: number; silent?: boolean }[]; gaps: string[] }
  /** A video Kumi watched: what it is, where its words came from, and the frames it looked at (pictured when `pictures`). */
  | { kind: "watched"; title: string; channel?: string; duration?: number; from: number; to: number; chapters: string[]; words: string;
    frames: { at: number; zoom?: string; thumb: Picture }[]; sound?: { from: number; to: number }; notes: string[]; pictures: boolean }
  /** What Kumi looked up for an answer, a line each: a search (its words) or a page read (its title, where it is, what it is). */
  | { kind: "web"; lines: WebLine[] };

/** A search or a page read, as the web entry shows it: "Searched the web for", “the words”, "8 results". */
export interface WebLine { lead: string; title: string; detail: string }

/** Ten bands, low to high, as the listening analysis names them. */
const BAND_LABELS = ["sub", "bass", "u.bas", "l.mid", "mids", "u.mid", "pres", "bite", "brill", "air"];
const BARS = "▁▂▃▄▅▆▇█";

export interface Row {
  spans: Span[];
  /** Background painted behind the row's text (the user's own messages). */
  band?: { bg: Rgb; width: number };
  /** Text right-aligned at the end of the row, such as a step's duration. */
  trailing?: Span;
  /**
   * Drawn afresh each frame: a step at work (its kind's glyph, its words shimmering, its time going
   * up), or the answer's "working" line (shimmering, with the time so far).
   */
  live?: { kind: "step"; activity: Activity; since: number; label: string; doing?: string } | { kind: "header"; label: string; since?: number };
}

const S = {
  bright: { fg: palette.bright } as Style,
  text: { fg: palette.text } as Style,
  dim: { fg: palette.dim } as Style,
  faint: { fg: palette.faint } as Style,
  accent: { fg: palette.accent } as Style,
  rule: { fg: palette.rule } as Style,
  warn: { fg: palette.warn } as Style,
  error: { fg: palette.error } as Style,
};

/** Words for what Kumi did, instead of tool names. */
const STEP_LABELS: Record<string, string> = {
  server_status: "checked the Ableton bridge",
  live_status: "checked Live",
  live_discover: "looked at your Set",
  live_snapshot: "read your whole Set",
  live_browser_search: "searched the Browser",
  live_note_read: "read notes",
  set_tempo: "changed the tempo",
  set_mixer: "changed the mixer",
  rename: "renamed",
  add_tracks_and_scenes: "added tracks or scenes",
  write_midi_clip: "wrote a MIDI clip",
  load_device: "loaded a device",
  set_device_parameter: "moved a device control",
  set_locators: "set locators",
  set_track_color: "changed a track colour",
  undo_change: "undid a change",
  run_python: "ran Python in Live",
  make_changes: "made changes",
  arrange: "arranged",
  listen: "listened",
  audition: "listened to it quietly",
  run_recipe: "ran a recipe",
  play: "played or stopped",
  fire_scene: "launched a scene",
  launch_clip: "launched a clip",
  record: "recorded",
  jump_to_locator: "moved the playhead",
  select: "showed you in Live",
  show: "changed the view",
  set_transport: "changed the transport",
  set_routing: "changed routing",
  transform_midi: "transformed notes",
  set_automation: "drew automation",
  change_structure: "changed tracks",
  set_song: "changed song settings",
  find_sounds: "looked for sounds",
  find_presets: "looked for presets",
  my_sets: "looked through your Sets",
  live_manual: "read Live's manual",
  load_sample: "loaded a sample",
  load_sample_to_pad: "loaded a pad",
  edit_rack: "edited a rack",
  set_chain_mixer: "changed a rack chain",
  set_mixer_options: "changed mixer options",
  set_clip: "changed a clip",
  set_audio_clip: "changed an audio clip",
  edit_clip: "edited a clip",
  duplicate_clip: "copied a clip",
  move_clip: "moved a clip",
  add_arrangement_clip: "added an Arrangement clip",
  change_notes: "changed notes",
  delete_notes: "deleted notes",
  edit_notes: "edited notes",
  set_scene: "changed a scene",
  capture_scene: "captured a scene",
  switch_device: "switched a device",
  move_device: "moved a device",
  move_device_to: "moved a device",
  delete_device: "deleted a device",
  set_chain: "changed a chain",
  set_scale: "set the scale",
  set_groove: "changed the groove",
  replace_sample: "swapped a sample",
  import_audio: "imported audio",
  set_warp_markers: "moved warp markers",
  capture_midi: "captured MIDI",
  set_device_details: "changed device settings",
  use_looper: "used the Looper",
  set_sidechain: "set a sidechain",
  live_song_state: "read the song's settings",
  live_performance_read: "checked Live's load",
  live_key_estimate: "estimated the key",
  live_take_lane_read: "read take lanes",
  live_warp_marker_read: "read warp markers",
  live_arrangement_automation_read: "read automation",
  live_browser_roots: "looked in the Browser",
  live_browser_inspect: "looked in the Browser",
  watch_me: "watched you work",
  save_recipe: "saved a recipe",
  watch_video: "watched a video",
  make_device: "made a device",
  search_web: "searched the web",
  read_web: "read a page",
};

/** What NOW says while a step runs: what Kumi is doing, not what it did. */
const DOING: Record<string, string> = {
  live_status: "checking Live",
  live_discover: "looking at your Set",
  live_snapshot: "reading your whole Set",
  live_browser_search: "searching the Browser",
  live_note_read: "reading notes",
  make_changes: "making changes",
  arrange: "arranging",
  listen: "listening",
  audition: "listening to it quietly",
  run_recipe: "running a recipe",
  play: "playing",
  record: "recording",
  select: "showing you",
  find_sounds: "looking for sounds",
  find_presets: "looking for presets",
  my_sets: "looking through your Sets",
  live_manual: "reading Live's manual",
  undo_change: "undoing a change",
  run_python: "running Python in Live",
  watch_me: "comparing your Set",
  live_key_estimate: "estimating the key",
  watch_video: "watching the video",
  make_device: "making a device",
  search_web: "searching the web",
  read_web: "reading a page",
};

export function doingLabel(tool: string | undefined, fallback: string): string {
  return (tool && DOING[tool]) ?? fallback;
}

export function stepLabel(tool: string): string {
  return STEP_LABELS[tool] ?? tool.replace(/^live_/, "").replaceAll("_", " ");
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** How long the same step done several times in a row stays listed, each time, before they fold into one line. */
export const FOLD_AFTER_MS = 3_000;
/** The fold: the extra lines fade, then go one by one from the bottom, the count on the first going up. */
const FOLD_FADE_MS = 220;
const FOLD_STEP_MS = 70;
const foldSpan = (extra: number) => FOLD_FADE_MS + extra * Math.min(FOLD_STEP_MS, 380 / Math.max(1, extra));

/** Steps done one after another that read the same: the same words, both finished the same way. */
const alike = (a: Step, b: Step) => a.label === b.label && a.state === b.state && a.state !== "running";

/**
 * Runs of the same step (three "read a page" in a row, say) fold into their first line once the
 * last of them has been done for FOLD_AFTER_MS; one that joins later folds in the same way. A step
 * brought back with a conversation folds at once. Marks when each began folding; true when one did.
 */
export function foldSteps(steps: Step[], now: number): boolean {
  let changed = false;
  for (let start = 0; start < steps.length;) {
    let end = start + 1;
    while (end < steps.length && alike(steps[start]!, steps[end]!)) end++;
    const waiting = steps.slice(start + 1, end).filter((step) => step.folded === undefined);
    if (waiting.length) {
      const due = Math.max(...[steps[start]!, ...waiting].map((step) => step.endedAt ?? Number.NEGATIVE_INFINITY)) + FOLD_AFTER_MS;
      if (now >= due) { for (const step of waiting) step.folded = Number.isFinite(due) ? due : now - foldSpan(waiting.length) - 1; changed = true; }
    }
    start = end;
  }
  return changed;
}

/** When the steps next look different without anything new happening: a fold due, or one under way (now). */
export function stepsChangeAt(steps: readonly Step[], now: number): number | undefined {
  let soonest: number | undefined;
  const consider = (at: number) => { soonest = soonest === undefined ? at : Math.min(soonest, at); };
  for (let start = 0; start < steps.length;) {
    let end = start + 1;
    while (end < steps.length && alike(steps[start]!, steps[end]!)) end++;
    const members = steps.slice(start + 1, end);
    const waiting = members.filter((step) => step.folded === undefined);
    if (waiting.length) consider(Math.max(now, Math.max(...[steps[start]!, ...waiting].map((step) => step.endedAt ?? 0)) + FOLD_AFTER_MS));
    for (const step of members) if (step.folded !== undefined && now < step.folded + foldSpan(members.length) + 1) consider(now);
    start = end;
  }
  return soonest;
}

/**
 * A step's line: its glyph (✓, ×, or its kind's animation while it runs), its words and its time.
 * A run folded into its first line says how many times ("×3") and their time together; lines on
 * their way into it fade, then go, the last first.
 */
function stepRows(steps: readonly Step[], now: number): Row[] {
  const rows: Row[] = [];
  for (let start = 0; start < steps.length;) {
    const first = steps[start]!;
    if (first.state === "running") {
      const label = doingLabel(first.tool, first.label);
      rows.push({ spans: [{ text: "│ ", style: S.rule }, { text: " ", style: S.accent }, { text: ` ${label}`, style: S.dim }],
        live: { kind: "step", activity: activityOf(first.tool), since: first.startedAt ?? now, label, ...(first.doing ? { doing: first.doing } : {}) } });
      start++;
      continue;
    }
    let end = start + 1;
    while (end < steps.length && alike(first, steps[end]!)) end++;
    const members = steps.slice(start + 1, end);
    const span = foldSpan(members.length);
    // Each member's place in the fold: listed (not folding), fading, or gone into the first line.
    const fading: { step: Step; fade: number }[] = [];
    let gone = 0; let goneMs = 0;
    members.forEach((step, index) => {
      if (step.folded === undefined) { fading.push({ step, fade: 0 }); return; }
      const into = now - step.folded;
      // The last goes first: its turn comes after the fade.
      const leaves = FOLD_FADE_MS + (members.length - 1 - index) * ((span - FOLD_FADE_MS) / Math.max(1, members.length));
      if (into >= leaves) { gone++; goneMs += step.ms ?? 0; } else fading.push({ step, fade: Math.max(0, Math.min(1, into / FOLD_FADE_MS)) });
    });
    rows.push(stepRow(first, 0, gone ? { count: gone + 1, ms: (first.ms ?? 0) + goneMs } : undefined));
    for (const { step, fade } of fading) rows.push(stepRow(step, fade));
    start = end;
  }
  return rows;
}

function stepRow(step: Step, fade: number, folded?: { count: number; ms: number }): Row {
  const glyph = step.state === "error" ? { text: "×", style: S.error } : { text: "✓", style: S.accent };
  const fadeStyle = (style: Style): Style => (fade > 0 && style.fg ? { fg: blend(style.fg, palette.ground, fade, 5) } : style);
  const ms = step.ms === undefined ? undefined : folded ? folded.ms : step.ms;
  return {
    spans: [{ text: "│ ", style: S.rule }, { text: glyph.text, style: fadeStyle(glyph.style) }, { text: ` ${step.label}`, style: fadeStyle(S.dim) },
      ...(folded ? [{ text: ` ×${folded.count}`, style: S.faint }] : [])],
    ...(ms !== undefined ? { trailing: { text: seconds(ms), style: fadeStyle(S.faint) } } : {}),
  };
}

/** Rows for one entry, `width` cells of text wide, at `now` (steps fold over time). A user message's band adds a cell either side. */
function entryRows(entry: Entry, width: number, now = 0): Row[] {
  const inner = Math.max(1, width);
  if (entry.kind === "user") {
    const lines = wrap([{ text: entry.text, style: S.bright }], inner);
    const band = Math.max(...lines.map((line) => textWidth(line.map((span) => span.text).join("")))) + 2;
    return lines.map((spans) => ({ spans, band: { bg: palette.raised, width: band } }));
  }
  if (entry.kind === "notice") {
    const style = entry.tone === "warn" ? S.warn : S.faint;
    return wrap([{ text: entry.text, style }], inner).map((spans) => ({ spans }));
  }
  if (entry.kind === "memory") {
    const lines = wrap([{ text: entry.text, style: S.dim }], Math.max(1, inner - 2));
    return lines.map((spans, index) => ({ spans: [index === 0 ? { text: `${MEMORY_GLYPHS[entry.what]} `, style: { fg: palette[entry.what] } as Style } : { text: "  ", style: S.dim }, ...spans] }));
  }
  if (entry.kind === "divider") {
    const rest = Math.max(2, inner - textWidth(entry.text) - 4);
    return wrap([{ text: "── ", style: S.rule }, { text: entry.text, style: S.dim }, { text: ` ${"─".repeat(rest)}`, style: S.rule }], inner).map((spans) => ({ spans }));
  }
  if (entry.kind === "heard") return heardRows(entry, inner);
  if (entry.kind === "auditioned") return auditionedRows(entry, inner);
  if (entry.kind === "watched") return watchedRows(entry, inner);
  if (entry.kind === "web") return entry.lines.flatMap((line) => wrap([{ text: `${line.lead} `, style: S.dim },
    { text: line.title, style: S.text }, ...(line.detail ? [{ text: ` · ${line.detail}`, style: S.faint }] : [])], inner).map((spans) => ({ spans })));
  const rows: Row[] = [];
  if (entry.text) {
    for (const row of renderMarkdown(entry.text.replace(/\n+$/, ""), inner, S.text)) {
      rows.push({ spans: row.spans, ...(row.bg ? { band: { bg: row.bg, width: inner + 2 } } : {}) });
    }
  }
  if (entry.steps.length) {
    if (rows.length) rows.push({ spans: [] });
    if (entry.status === "running") {
      rows.push({ spans: [{ text: "▾ ", style: S.faint }, { text: "working", style: S.dim }], live: { kind: "header", label: "working", ...(entry.startedAt !== undefined ? { since: entry.startedAt } : {}) } });
    } else {
      // A finished answer keeps its steps on screen, under what they came to.
      const count = entry.steps.length;
      rows.push({ spans: [
        { text: "▾ ", style: S.faint },
        { text: `${count} ${count === 1 ? "step" : "steps"}`, style: S.dim },
        ...(entry.elapsedMs !== undefined ? [{ text: ` · ${seconds(entry.elapsedMs)}`, style: S.faint }] : []),
      ] });
    }
    rows.push(...stepRows(entry.steps, now));
  }
  if (entry.status === "stopped") rows.push({ spans: [{ text: "stopped", style: S.faint }] });
  if (entry.status === "failed" && !entry.text) rows.push({ spans: [{ text: "Kumi couldn't answer that; see the note below.", style: S.faint }] });
  return rows;
}

/**
 * What Kumi heard, in three quiet rows: the file and its summary, then its balance as a small
 * spectrum (or, against a reference, how many dB each band is over or under it), then the bands.
 */
function heardRows(entry: Extract<Entry, { kind: "heard" }>, width: number): Row[] {
  const cell = width >= 60 ? 6 : 5;
  const fits = Math.max(1, Math.min(BAND_LABELS.length, Math.floor(width / cell)));
  const title = entry.compared ? `Heard ${entry.file} against ${entry.compared.reference}, loudness matched` : `Heard ${entry.file} · ${entry.summary}`;
  const rows: Row[] = wrap([{ text: title, style: S.dim }], width).map((spans) => ({ spans }));
  const pad = (text: string) => text.padEnd(cell).slice(0, cell);
  if (entry.compared) {
    rows.push({ spans: entry.compared.differences.slice(0, fits).map((value) => {
      const text = `${value > 0 ? "+" : value < 0 ? "−" : " "}${Math.abs(value).toFixed(1)}`;
      return { text: pad(text), style: Math.abs(value) >= 1.5 ? (value > 0 ? S.warn : S.accent) : S.faint };
    }) });
  } else {
    const loudest = Math.max(...entry.bands);
    rows.push({ spans: entry.bands.slice(0, fits).map((value) => {
      const level = Math.max(0, Math.min(7, Math.round(7 + (value - loudest) / 4)));
      return { text: pad(BARS[level]!.repeat(cell - 2)), style: S.accent };
    }) });
  }
  rows.push({ spans: BAND_LABELS.slice(0, fits).map((label) => ({ text: pad(label), style: S.faint })) });
  return rows;
}

/**
 * An audition, in a line or two: "Round 2 · 58% → 71% · brighter top, faster attack", and with
 * several candidates, each one's score, quietly.
 */
function auditionedRows(entry: Extract<Entry, { kind: "auditioned" }>, width: number): Row[] {
  const spans: Span[] = [{ text: `Round ${entry.round} · `, style: S.dim }];
  if (entry.best) {
    if (entry.previous !== undefined) spans.push({ text: `${entry.previous}% → `, style: S.dim });
    spans.push({ text: `${entry.best.score}%`, style: entry.previous !== undefined && entry.best.score < entry.previous ? S.warn : S.accent });
    if (entry.gaps.length) spans.push({ text: ` · ${entry.gaps.join(", ")}`, style: S.dim });
  } else spans.push({ text: entry.takes.every((take) => take.silent) ? "the render was silent" : "listened", style: S.dim });
  const rows: Row[] = wrap(spans, width).map((line) => ({ spans: line }));
  if (entry.takes.length > 1) {
    const each = entry.takes.map((take) => `${take.label} ${take.silent ? "silent" : take.score !== undefined ? `${take.score}` : "–"}`).join(" · ");
    rows.push(...wrap([{ text: each, style: S.faint }], width).map((line) => ({ spans: line })));
  }
  return rows;
}

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600); const minutes = Math.floor((whole % 3600) / 60); const secs = whole % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
};

/** A picture's colour over a cell's area (x, y and size in its own pixels), averaged. */
function area(picture: Picture, x0: number, y0: number, x1: number, y1: number): Rgb {
  let red = 0; let green = 0; let blue = 0; let count = 0;
  for (let y = Math.floor(y0); y < Math.max(Math.floor(y0) + 1, Math.ceil(y1)); y++) {
    for (let x = Math.floor(x0); x < Math.max(Math.floor(x0) + 1, Math.ceil(x1)); x++) {
      const at = (Math.min(picture.height - 1, y) * picture.width + Math.min(picture.width - 1, x)) * 3;
      red += picture.rgb[at] ?? 0; green += picture.rgb[at + 1] ?? 0; blue += picture.rgb[at + 2] ?? 0; count++;
    }
  }
  return [Math.round(red / count), Math.round(green / count), Math.round(blue / count)];
}

/** A picture `cells` wide as rows of half blocks: each cell's top half one pixel, its bottom half the next. */
export function pictureRows(picture: Picture, cells: number): Span[][] {
  const height = Math.max(2, Math.round((cells * picture.height) / picture.width / 2) * 2);
  const across = picture.width / cells; const down = picture.height / height;
  const rows: Span[][] = [];
  for (let row = 0; row < height / 2; row++) {
    const spans: Span[] = [];
    for (let cell = 0; cell < cells; cell++) {
      const top = area(picture, cell * across, row * 2 * down, (cell + 1) * across, (row * 2 + 1) * down);
      const bottom = area(picture, cell * across, (row * 2 + 1) * down, (cell + 1) * across, (row * 2 + 2) * down);
      spans.push({ text: "▀", style: { fg: top, bg: bottom } });
    }
    rows.push(spans);
  }
  return rows;
}

/** Most frames pictured in a watched entry; the rest are listed by time. */
const MAX_PICTURED = 8;

/**
 * A watched video: its title, where the words came from, then the frames Kumi looked at, side by
 * side as small pictures with their times (just the times where the terminal can't draw them).
 */
function watchedRows(entry: Extract<Entry, { kind: "watched" }>, width: number): Row[] {
  const rows: Row[] = wrap([{ text: "Watched ", style: S.dim }, { text: `“${entry.title}”`, style: S.text },
    { text: `${entry.channel ? ` · ${entry.channel}` : ""}${entry.duration ? ` · ${clock(entry.duration)}` : ""}`, style: S.dim }], width).map((spans) => ({ spans }));
  const watched = entry.duration && entry.from <= 0 && entry.to >= entry.duration - 1 ? "the whole video" : `${clock(entry.from)}–${clock(entry.to)}`;
  rows.push(...wrap([{ text: `${watched} · ${entry.words}${entry.sound ? ` · kept its sound at ${clock(entry.sound.from)}–${clock(entry.sound.to)}` : ""}`, style: S.faint }], width).map((spans) => ({ spans })));
  if (entry.chapters.length) rows.push(...wrap([{ text: `chapters: ${entry.chapters.join(" · ")}`, style: S.faint }], width).map((spans) => ({ spans })));
  const times = (frame: Extract<Entry, { kind: "watched" }>["frames"][number]) => `${clock(frame.at)}${frame.zoom ? ` ${frame.zoom}` : ""}`;
  if (entry.frames.length && entry.pictures && width >= 24) {
    // About four across, each a 16:9 picture as wide as fits.
    const cells = Math.max(10, Math.min(24, Math.floor((width + 1) / 4) - 1));
    const across = Math.max(1, Math.floor((width + 1) / (cells + 1)));
    const shown = entry.frames.slice(0, MAX_PICTURED);
    for (let start = 0; start < shown.length; start += across) {
      const group = shown.slice(start, start + across);
      const pictures = group.map((frame) => pictureRows(frame.thumb, cells));
      const height = Math.max(...pictures.map((picture) => picture.length));
      for (let line = 0; line < height; line++) {
        rows.push({ spans: pictures.flatMap((picture, index) => [...(index ? [{ text: " ", style: S.faint }] : []), ...(picture[line] ?? [{ text: " ".repeat(cells), style: S.faint }])]) });
      }
      rows.push({ spans: group.map((frame, index) => ({ text: `${index ? " " : ""}${times(frame).padEnd(cells).slice(0, cells)}`, style: S.faint })) });
    }
    if (entry.frames.length > shown.length) rows.push({ spans: [{ text: `and ${entry.frames.slice(shown.length).map(times).join(", ")}`, style: S.faint }] });
  } else if (entry.frames.length) {
    rows.push(...wrap([{ text: `looked at ${entry.frames.map(times).join(", ")}`, style: S.faint }], width).map((spans) => ({ spans })));
  }
  for (const note of entry.notes) rows.push(...wrap([{ text: note, style: S.faint }], width).map((spans) => ({ spans })));
  return rows;
}

/** Rows for the whole conversation at `width`, with a blank row between entries. */
export class Transcript {
  readonly entries: Entry[] = [];
  private readonly revisions = new WeakMap<Entry, number>();
  private readonly cache = new WeakMap<Entry, { width: number; revision: number; rows: Row[]; moving: boolean }>();

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  add(entry: Entry): Entry {
    this.entries.push(entry);
    return entry;
  }

  /** Put `entry` just above `before` (at the end when `before` isn't there). */
  insertBefore(entry: Entry, before: Entry | undefined): Entry {
    const at = before ? this.entries.indexOf(before) : -1;
    if (at < 0) this.entries.push(entry); else this.entries.splice(at, 0, entry);
    return entry;
  }

  remove(entry: Entry): void {
    const at = this.entries.indexOf(entry);
    if (at >= 0) this.entries.splice(at, 1);
  }

  /** Call after changing an entry, so its rows are laid out again. */
  touch(entry: Entry): void {
    this.revisions.set(entry, (this.revisions.get(entry) ?? 0) + 1);
  }

  clear(): void {
    this.entries.length = 0;
  }

  /** Entries laid out afresh rather than taken from the cache: a frame's real work. */
  laidOut = 0;

  /** When the rows next change by themselves (a fold of repeated steps due, or under way), if they will. */
  changeAt(now: number): number | undefined {
    let soonest: number | undefined;
    for (const entry of this.entries) {
      if (entry.kind !== "assistant" || entry.steps.length < 2) continue;
      const at = stepsChangeAt(entry.steps, now);
      if (at !== undefined) soonest = soonest === undefined ? at : Math.min(soonest, at);
    }
    return soonest;
  }

  rows(width: number, now = performance.now()): Row[] {
    const all: Row[] = [];
    for (const entry of this.entries) {
      // Repeated steps fold as time passes; while they're folding, the entry is laid out each frame.
      let moving = false;
      if (entry.kind === "assistant" && entry.steps.length > 1) {
        if (foldSteps(entry.steps, now)) this.touch(entry);
        moving = stepsChangeAt(entry.steps, now) === now;
      }
      const revision = this.revisions.get(entry) ?? 0;
      let cached = this.cache.get(entry);
      if (!cached || cached.width !== width || cached.revision !== revision || moving || cached.moving) {
        this.laidOut++;
        cached = { width, revision, rows: entryRows(entry, width, now), moving };
        this.cache.set(entry, cached);
      }
      if (all.length) all.push({ spans: [] });
      all.push(...cached.rows);
    }
    return all;
  }
}
