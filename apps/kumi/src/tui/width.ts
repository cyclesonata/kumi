/** How many terminal cells text occupies, measured per grapheme (what a reader sees as one character). */
import stringWidth from "string-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

/** 0 for marks that attach to the previous character, 2 for wide CJK and emoji, else 1. */
export function cellWidth(grapheme: string): number {
  if (grapheme.length === 1) {
    const code = grapheme.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) return 1;
  }
  return Math.min(2, stringWidth(grapheme));
}

export function textWidth(text: string): number {
  let width = 0;
  for (const grapheme of graphemes(text)) width += cellWidth(grapheme);
  return width;
}

/** At most `width` cells, ending in an ellipsis when something was cut. */
export function truncate(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  const room = width - textWidth(ellipsis);
  if (room <= 0) return ellipsis.slice(0, width);
  let used = 0;
  let out = "";
  for (const grapheme of graphemes(text)) {
    const cells = cellWidth(grapheme);
    if (used + cells > room) break;
    out += grapheme;
    used += cells;
  }
  return out + ellipsis;
}
