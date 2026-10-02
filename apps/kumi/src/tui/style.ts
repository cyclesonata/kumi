/** Colours, text styles and the terminal escape codes that draw them. */

export type Rgb = readonly [number, number, number];

export interface Style {
  fg?: Rgb;
  bg?: Rgb;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export type ColorDepth = "truecolor" | "256" | "16" | "none";

export function hex(value: string): Rgb {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!match) throw new Error(`not a #rrggbb colour: ${value}`);
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)];
}

/** Kumi's palette (see docs/en/KUMI_TUI.md). Track colours come from Live itself. */
export const palette = {
  ground: hex("#0e0f12"),
  surface: hex("#14161a"),
  raised: hex("#1c1f24"),
  selected: hex("#1e3a2f"),
  rule: hex("#3a3f47"),
  track: hex("#4a5059"),
  faint: hex("#80868f"),
  dim: hex("#a6acb5"),
  text: hex("#d6dadf"),
  bright: hex("#f4f6f8"),
  accent: hex("#86e3b5"),
  pulse: hex("#2f5a47"),
  warn: hex("#e7b45f"),
  /** The beat light: Live's transport playing, lit on each beat (brightest on a bar's first), dark between. */
  beat: hex("#ffe14d"),
  offbeat: hex("#4d4420"),
  error: hex("#ee8479"),
  /** What Kumi keeps, by kind: notes, techniques, recipes, and its own lessons from matching. */
  note: hex("#8cc8ff"),
  technique: hex("#c7a6ff"),
  recipe: hex("#f2a6c4"),
  lesson: hex("#e7c88f"),
} as const;

/** Chooses the colour depth from the environment; `NO_COLOR` keeps bold and dim only. */
export function detectColorDepth(env: NodeJS.ProcessEnv = process.env): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const forced = env.KUMI_COLOR;
  if (forced === "truecolor" || forced === "256" || forced === "16" || forced === "none") return forced;
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (env.TERM_PROGRAM === "Apple_Terminal") return "256";
  if (/-256(color)?$/.test(env.TERM ?? "")) return "256";
  if (env.TERM === "dumb") return "none";
  return "16";
}

/** A stable key for comparing styles. */
export function styleKey(style: Style): string {
  const color = (rgb: Rgb | undefined) => (rgb ? `${rgb[0]},${rgb[1]},${rgb[2]}` : "-");
  return `${color(style.fg)}|${color(style.bg)}|${style.bold ? 1 : 0}${style.dim ? 1 : 0}${style.italic ? 1 : 0}${style.underline ? 1 : 0}${style.inverse ? 1 : 0}`;
}

/** Interns styles so screen cells can hold a small number; id 0 is the terminal default. */
export class StyleTable {
  private readonly ids = new Map<string, number>([[styleKey({}), 0]]);
  private readonly styles: Style[] = [{}];
  id(style: Style): number {
    const key = styleKey(style);
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.styles.length;
      this.styles.push({ ...style });
      this.ids.set(key, id);
    }
    return id;
  }
  style(id: number): Style {
    return this.styles[id] ?? {};
  }
}

// The xterm palette for the 16 basic colours, used to find the nearest match.
const BASIC: readonly Rgb[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
const distance = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const CUBE = [0, 95, 135, 175, 215, 255];

export function to256(rgb: Rgb): number {
  const level = (channel: number) => {
    let best = 0;
    for (let index = 1; index < CUBE.length; index++) if (Math.abs(CUBE[index]! - channel) < Math.abs(CUBE[best]! - channel)) best = index;
    return best;
  };
  const r = level(rgb[0]), g = level(rgb[1]), b = level(rgb[2]);
  const cube: Rgb = [CUBE[r]!, CUBE[g]!, CUBE[b]!];
  const average = Math.round((rgb[0] + rgb[1] + rgb[2]) / 3);
  const grayIndex = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
  const grayValue = 8 + grayIndex * 10;
  const gray: Rgb = [grayValue, grayValue, grayValue];
  return distance(gray, rgb) < distance(cube, rgb) ? 232 + grayIndex : 16 + 36 * r + 6 * g + b;
}

export function to16(rgb: Rgb): number {
  let best = 0;
  for (let index = 1; index < BASIC.length; index++) if (distance(BASIC[index]!, rgb) < distance(BASIC[best]!, rgb)) best = index;
  return best;
}

/** The complete SGR sequence for a style: always starts from a reset, so output never inherits. */
export function sgr(style: Style, depth: ColorDepth): string {
  const codes = ["0"];
  if (style.bold) codes.push("1");
  if (style.dim) codes.push("2");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.inverse) codes.push("7");
  const color = (rgb: Rgb | undefined, background: boolean) => {
    if (!rgb || depth === "none") return;
    if (depth === "truecolor") codes.push(`${background ? 48 : 38};2;${rgb[0]};${rgb[1]};${rgb[2]}`);
    else if (depth === "256") codes.push(`${background ? 48 : 38};5;${to256(rgb)}`);
    else {
      const index = to16(rgb);
      codes.push(String((index < 8 ? (background ? 40 : 30) : (background ? 100 : 90)) + (index % 8)));
    }
  };
  color(style.fg, false);
  color(style.bg, true);
  return `\u001b[${codes.join(";")}m`;
}
