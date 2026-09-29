/** The conversation as entries, and how each entry becomes rows at a given width. */
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
}

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; steps: Step[]; status: "running" | "done" | "stopped" | "failed"; elapsedMs?: number }
  | { kind: "notice"; text: string; tone: "info" | "warn" };

export interface Row {
  spans: Span[];
  /** Background painted behind the row's text (the user's own messages). */
  band?: { bg: Rgb; width: number };
  /** Text right-aligned at the end of the row, such as a step's duration. */
  trailing?: Span;
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
  make_changes: "made changes",
  find_samples: "looked for samples",
  load_sample: "loaded a sample",
  load_sample_to_pad: "loaded a pad",
  edit_rack: "edited a rack",
  set_chain_mixer: "changed a rack chain",
};

/** What NOW says while a step runs: what Kumi is doing, not what it did. */
const DOING: Record<string, string> = {
  live_status: "checking Live",
  live_discover: "looking at your Set",
  live_snapshot: "reading your whole Set",
  live_browser_search: "searching the Browser",
  live_note_read: "reading notes",
  make_changes: "making changes",
  find_samples: "looking for samples",
  undo_change: "undoing a change",
};

export function doingLabel(tool: string | undefined, fallback: string): string {
  return (tool && DOING[tool]) ?? fallback;
}

export function stepLabel(tool: string): string {
  return STEP_LABELS[tool] ?? tool.replace(/^live_/, "").replaceAll("_", " ");
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Rows for one entry, `width` cells of text wide. A user message's band adds a cell either side. */
function entryRows(entry: Entry, width: number): Row[] {
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
  const rows: Row[] = [];
  if (entry.text) {
    for (const row of renderMarkdown(entry.text.replace(/\n+$/, ""), inner, S.text)) {
      rows.push({ spans: row.spans, ...(row.bg ? { band: { bg: row.bg, width: inner + 2 } } : {}) });
    }
  }
  if (entry.steps.length) {
    if (rows.length) rows.push({ spans: [] });
    if (entry.status === "running") {
      rows.push({ spans: [{ text: "▾ ", style: S.faint }, { text: "working", style: S.dim }] });
      for (const step of entry.steps) {
        const glyph = step.state === "running" ? { text: "…", style: S.accent } : step.state === "error" ? { text: "×", style: S.error } : { text: "✓", style: S.accent };
        rows.push({
          spans: [{ text: "│ ", style: S.rule }, glyph, { text: ` ${step.label}`, style: S.dim }],
          ...(step.ms !== undefined ? { trailing: { text: seconds(step.ms), style: S.faint } } : {}),
        });
      }
    } else {
      const count = entry.steps.length;
      rows.push({ spans: [
        { text: "▸ ", style: S.faint },
        { text: `${count} ${count === 1 ? "step" : "steps"}`, style: S.dim },
        ...(entry.elapsedMs !== undefined ? [{ text: ` · ${seconds(entry.elapsedMs)}`, style: S.faint }] : []),
      ] });
    }
  }
  if (entry.status === "stopped") rows.push({ spans: [{ text: "stopped", style: S.faint }] });
  if (entry.status === "failed" && !entry.text) rows.push({ spans: [{ text: "Kumi couldn't answer that; see the note below.", style: S.faint }] });
  return rows;
}

/** Rows for the whole conversation at `width`, with a blank row between entries. */
export class Transcript {
  readonly entries: Entry[] = [];
  private readonly revisions = new WeakMap<Entry, number>();
  private readonly cache = new WeakMap<Entry, { width: number; revision: number; rows: Row[] }>();

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  add(entry: Entry): Entry {
    this.entries.push(entry);
    return entry;
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

  rows(width: number): Row[] {
    const all: Row[] = [];
    for (const entry of this.entries) {
      const revision = this.revisions.get(entry) ?? 0;
      let cached = this.cache.get(entry);
      if (!cached || cached.width !== width || cached.revision !== revision) {
        this.laidOut++;
        cached = { width, revision, rows: entryRows(entry, width) };
        this.cache.set(entry, cached);
      }
      if (all.length) all.push({ spans: [] });
      all.push(...cached.rows);
    }
    return all;
  }
}
