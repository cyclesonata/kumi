/** Word wrapping of styled text into terminal lines. */
import type { Style } from "./style.js";
import { cellWidth, graphemes, textWidth } from "./width.js";

export interface Span {
  text: string;
  style: Style;
}

/**
 * Greedy word wrap to `width` cells. Newlines always break; a word wider than the line is
 * split between characters; spaces at a wrap point are dropped, but indentation at the
 * start of a paragraph is kept. Always returns at least one (possibly empty) line.
 */
export function wrap(spans: readonly Span[], width: number): Span[][] {
  const limit = Math.max(1, width);
  const lines: Span[][] = [];
  let line: Span[] = [];
  let used = 0;
  let continuation = false;

  const append = (text: string, style: Style, cells: number) => {
    const last = line[line.length - 1];
    if (last && last.style === style) last.text += text;
    else line.push({ text, style });
    used += cells;
  };
  const breakLine = (wrapped: boolean) => {
    const last = line[line.length - 1];
    if (wrapped && last) {
      last.text = last.text.replace(/ +$/, "");
      if (!last.text) line.pop();
    }
    lines.push(line);
    line = [];
    used = 0;
    continuation = wrapped;
  };

  for (const span of spans) {
    for (const token of span.text.match(/\n| +|[^ \n]+/g) ?? []) {
      if (token === "\n") { breakLine(false); continue; }
      const cells = textWidth(token);
      if (token[0] === " ") {
        if (continuation && used === 0) continue;
        if (used + cells > limit) { breakLine(true); continue; }
        append(token, span.style, cells);
        continue;
      }
      if (used + cells <= limit) { append(token, span.style, cells); continue; }
      if (cells <= limit) {
        breakLine(true);
        append(token, span.style, cells);
        continue;
      }
      for (const grapheme of graphemes(token)) {
        const size = cellWidth(grapheme);
        if (used + size > limit) breakLine(true);
        append(grapheme, span.style, size);
      }
    }
  }
  lines.push(line);
  return lines;
}
