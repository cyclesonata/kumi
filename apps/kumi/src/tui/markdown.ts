/**
 * Markdown as terminal rows: the subset models actually write in chat. Headings, bold,
 * italic, inline code, fenced code, lists with hanging indents, quotes, links and rules.
 * Single newlines stay line breaks, as in chat. Names like Kick_01_final stay literal.
 */
import { palette, type Rgb, type Style } from "./style.js";
import { graphemes, textWidth } from "./width.js";
import { wrap, type Span } from "./wrap.js";

export interface MarkdownRow {
  spans: Span[];
  /** Background band for code blocks. */
  bg?: Rgb;
}

const INLINE = /(`+)(.+?)\1|\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])|(?<![\w])_(?=\S)(.+?)(?<=\S)_(?![\w])|\[([^\]\n]+)\]\((\S+?)\)/g;

/** Inline spans: `code`, **bold**, *italic*, _italic_ and [links](url). */
export function inline(text: string, base: Style): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ text: text.slice(last, index), style: base });
    const [, , code, bold, star, underscore, label, url] = match;
    if (code !== undefined) spans.push({ text: code, style: { ...base, fg: palette.bright, bg: palette.raised } });
    else if (bold !== undefined) spans.push({ text: bold, style: { ...base, fg: palette.bright, bold: true } });
    else if (star !== undefined || underscore !== undefined) spans.push({ text: (star ?? underscore)!, style: { ...base, italic: true } });
    else if (label !== undefined) {
      spans.push({ text: label, style: { ...base, underline: true } });
      if (url && url !== label) spans.push({ text: ` (${url})`, style: { fg: palette.faint } });
    }
    last = index + match[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), style: base });
  return spans;
}

/** Wrap spans to `width`, putting `first` before the first line and `rest` before the others. */
function hanging(spans: Span[], width: number, first: Span, rest: string): MarkdownRow[] {
  const indent = textWidth(first.text);
  return wrap(spans, Math.max(1, width - indent)).map((line, index) => ({
    spans: [index === 0 ? first : { text: rest, style: first.style }, ...line],
  }));
}

/** Split a long code line between characters; code is never word-wrapped. */
function codeRows(line: string, width: number, style: Style): MarkdownRow[] {
  const rows: MarkdownRow[] = [];
  let current = "";
  let used = 0;
  for (const grapheme of graphemes(line)) {
    const cells = textWidth(grapheme);
    if (used + cells > width && current) { rows.push({ spans: [{ text: current, style }], bg: palette.raised }); current = ""; used = 0; }
    current += grapheme;
    used += cells;
  }
  rows.push({ spans: [{ text: current, style }], bg: palette.raised });
  return rows;
}

export function renderMarkdown(text: string, width: number, base: Style): MarkdownRow[] {
  const rows: MarkdownRow[] = [];
  const limit = Math.max(1, width);
  const code: Style = { fg: palette.bright };
  const faint: Style = { fg: palette.faint };
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const opening = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== undefined) {
      if (opening && opening[1]!.startsWith(fence)) { fence = undefined; continue; }
      rows.push(...codeRows(line, limit, code));
      continue;
    }
    if (opening) { fence = opening[1]!; continue; }
    if (!line.trim()) { rows.push({ spans: [] }); continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      rows.push(...wrap(inline(heading[2]!, { ...base, fg: palette.bright, bold: true }), limit).map((spans) => ({ spans })));
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { rows.push({ spans: [{ text: "─".repeat(Math.min(limit, 24)), style: faint }] }); continue; }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) { rows.push(...hanging(inline(quote[1]!, { fg: palette.dim }), limit, { text: "│ ", style: { fg: palette.rule } }, "│ ")); continue; }
    const item = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (item) {
      const depth = Math.min(4, Math.floor(item[1]!.replace(/\t/g, "  ").length / 2));
      const marker = /\d/.test(item[2]!) ? item[2]! : "•";
      const lead = `${"  ".repeat(depth)}${marker} `;
      rows.push(...hanging(inline(item[3]!, base), limit, { text: lead, style: faint }, " ".repeat(textWidth(lead))));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue;
      rows.push(...wrap([{ text: line.trim(), style: base }], limit).map((spans) => ({ spans })));
      continue;
    }
    rows.push(...wrap(inline(line, base), limit).map((spans) => ({ spans })));
  }
  return rows;
}
