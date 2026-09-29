/**
 * Kumi's icons for what's in a Set: a small silhouette, two cells wide, tinted by family (audio,
 * MIDI, instruments, plug-ins; a track in its own Live colour). Only characters every terminal Kumi
 * supports draws (box drawing, blocks and a few geometric shapes, no Braille, no pictures); where
 * even those don't show, a two-letter badge stands in. The tint goes on the icon only, never the
 * row's text. What follows an icon leaves one space after its two cells.
 */
import { hex, type Rgb, type Style } from "./style.js";

export type IconKind =
  | "audio-effect" | "midi-effect" | "instrument" | "drum-instrument" | "device"
  | "audio-rack" | "instrument-rack" | "midi-rack" | "drum-rack"
  | "max-audio" | "max-midi" | "max-instrument" | "plugin"
  | "chain" | "drum-pad"
  | "audio-track" | "midi-track" | "group-track" | "return-track" | "main-track"
  | "scene" | "audio-clip" | "midi-clip" | "locator"
  | "sample" | "preset" | "groove" | "tuning";

/** Soft tints near Kumi's palette, one per family. */
export const tints = {
  audio: hex("#7fd1c7"),
  midi: hex("#8cc8ff"),
  instrument: hex("#e7c88f"),
  plugin: hex("#c7a6ff"),
  neutral: hex("#a6acb5"),
  quiet: hex("#80868f"),
} as const;

/** Each kind: its glyph, its tint (a track's is its own colour), and the badge that stands in for it. */
export const ICONS: Record<IconKind, { glyph: string; tint: Rgb; badge: string }> = {
  "audio-effect": { glyph: "≈", tint: tints.audio, badge: "FX" },
  "midi-effect": { glyph: "♪", tint: tints.midi, badge: "ME" },
  instrument: { glyph: "◆", tint: tints.instrument, badge: "IN" },
  "drum-instrument": { glyph: "●", tint: tints.instrument, badge: "DI" },
  device: { glyph: "◇", tint: tints.neutral, badge: "DV" },
  "audio-rack": { glyph: "▣", tint: tints.audio, badge: "AR" },
  "instrument-rack": { glyph: "▣", tint: tints.instrument, badge: "IR" },
  "midi-rack": { glyph: "▣", tint: tints.midi, badge: "MR" },
  "drum-rack": { glyph: "▦", tint: tints.instrument, badge: "DR" },
  "max-audio": { glyph: "∞", tint: tints.audio, badge: "MA" },
  "max-midi": { glyph: "∞", tint: tints.midi, badge: "MM" },
  "max-instrument": { glyph: "∞", tint: tints.instrument, badge: "MX" },
  plugin: { glyph: "□", tint: tints.plugin, badge: "PL" },
  chain: { glyph: "○", tint: tints.quiet, badge: "CH" },
  "drum-pad": { glyph: "▪", tint: tints.instrument, badge: "PD" },
  "audio-track": { glyph: "■", tint: tints.neutral, badge: "AT" },
  "midi-track": { glyph: "■", tint: tints.neutral, badge: "MT" },
  "group-track": { glyph: "▣", tint: tints.neutral, badge: "GR" },
  "return-track": { glyph: "↩", tint: tints.neutral, badge: "RT" },
  "main-track": { glyph: "●", tint: tints.neutral, badge: "MN" },
  scene: { glyph: "▶", tint: tints.quiet, badge: "SC" },
  "audio-clip": { glyph: "▬", tint: tints.audio, badge: "AC" },
  "midi-clip": { glyph: "▬", tint: tints.midi, badge: "MC" },
  locator: { glyph: "▼", tint: tints.quiet, badge: "LC" },
  sample: { glyph: "~", tint: tints.audio, badge: "SM" },
  preset: { glyph: "▫", tint: tints.neutral, badge: "PR" },
  groove: { glyph: "≋", tint: tints.quiet, badge: "GV" },
  tuning: { glyph: "♯", tint: tints.quiet, badge: "TU" },
};

export type IconStyle = "glyphs" | "badges";

/**
 * Glyphs, or badges where they may not show: KUMI_ICONS chooses outright; otherwise badges on the
 * Linux console, a dumb terminal, and the old Windows console (not Windows Terminal, VS Code or ConEmu).
 */
export function detectIconStyle(env: Readonly<Record<string, string | undefined>> = process.env, platform: string = process.platform): IconStyle {
  if (env.KUMI_ICONS === "badges" || env.KUMI_ICONS === "glyphs") return env.KUMI_ICONS;
  if (env.TERM === "linux" || env.TERM === "dumb") return "badges";
  if (platform === "win32" && !env.WT_SESSION && env.TERM_PROGRAM !== "vscode" && !env.ConEmuANSI) return "badges";
  return "glyphs";
}

/** A kind's icon as text two cells wide, and its style; `color` is a track's own colour. */
export function icon(kind: IconKind, style: IconStyle, color?: Rgb): { text: string; style: Style } {
  const found = ICONS[kind];
  const tint = color ?? found.tint;
  return style === "badges" ? { text: found.badge, style: { fg: tint, bold: true } } : { text: `${found.glyph} `, style: { fg: tint } };
}

/** What kind of device a device row is, from what the bridge says about it (its class, and Live's device type when sent). */
export function deviceKind(row: { className?: unknown; canHaveChains?: unknown; canHaveDrumPads?: unknown; deviceType?: unknown }): IconKind {
  const cls = typeof row.className === "string" ? row.className : "";
  const type = row.deviceType === "instrument" || row.deviceType === "audio_effect" || row.deviceType === "midi_effect" ? row.deviceType : undefined;
  if (row.canHaveDrumPads === true || cls === "DrumGroupDevice") return "drum-rack";
  if (row.canHaveChains === true || /GroupDevice$/.test(cls)) {
    return cls.startsWith("MidiEffect") || type === "midi_effect" ? "midi-rack" : cls.startsWith("Instrument") || type === "instrument" ? "instrument-rack" : "audio-rack";
  }
  if (/^MxDevice/.test(cls)) return /MidiEffect/.test(cls) ? "max-midi" : /Instrument/.test(cls) ? "max-instrument" : "max-audio";
  if (/Plugin/.test(cls)) return "plugin";
  if (cls === "DrumCell" || cls === "DrumSampler") return "drum-instrument";
  return type === "instrument" ? "instrument" : type === "audio_effect" ? "audio-effect" : type === "midi_effect" ? "midi-effect" : "device";
}

/** A track's icon kind from the focus feed's or the bridge's words for it. */
export function trackKind(kind: unknown): IconKind {
  return kind === "midi" ? "midi-track" : kind === "group" ? "group-track" : kind === "return" ? "return-track" : kind === "main" ? "main-track" : "audio-track";
}
