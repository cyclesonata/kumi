import assert from "node:assert/strict";
import { test } from "node:test";
import { inline, renderMarkdown, type MarkdownRow } from "../src/tui/markdown.js";
import { palette, type Style } from "../src/tui/style.js";

const base: Style = { fg: palette.text };
const text = (rows: MarkdownRow[]) => rows.map((row) => row.spans.map((span) => span.text).join(""));

test("inline markdown becomes styles, and names with underscores or lone asterisks stay literal", () => {
  const spans = inline("**Bass** needs *less* `EQ Eight` at [200 Hz](https://example.com/eq)", base);
  assert.deepEqual(spans.map((span) => span.text), ["Bass", " needs ", "less", " ", "EQ Eight", " at ", "200 Hz", " (https://example.com/eq)"]);
  assert.equal(spans[0]!.style.bold, true);
  assert.equal(spans[2]!.style.italic, true);
  assert.deepEqual(spans[4]!.style.bg, palette.raised);
  assert.equal(spans[6]!.style.underline, true);
  assert.deepEqual(inline("Kick_01_final and 2*3*4 and C* minor", base).map((span) => span.text), ["Kick_01_final and 2*3*4 and C* minor"]);
  assert.deepEqual(inline("_really_ loud", base).map((span) => span.style.italic ?? false), [true, false]);
});

test("lists get bullets and hanging indents; headings, quotes and code render without their markers", () => {
  const rows = renderMarkdown([
    "## Low end",
    "- The kick and bass are fighting around 200 Hz",
    "  - nested point",
    "2. Then tighten the compressor",
    "> Names are data",
    "```js",
    "const gain = -3;",
    "```",
    "---",
    "| Track | Device |",
    "|---|---|",
    "| Bass | EQ Eight |",
  ].join("\n"), 24, base);
  assert.deepEqual(text(rows), [
    "Low end",
    "• The kick and bass are",
    "  fighting around 200 Hz",
    "  • nested point",
    "2. Then tighten the",
    "   compressor",
    "│ Names are data",
    "const gain = -3;",
    "────────────────────────",
    "| Track | Device |",
    "| Bass | EQ Eight |",
  ]);
  assert.equal(rows[0]!.spans[0]!.style.bold, true);
  assert.deepEqual(rows[7]!.bg, palette.raised, "code blocks sit on a band");
  assert.equal(rows[1]!.bg, undefined);
});

test("a long code line splits between characters instead of wrapping words", () => {
  const rows = renderMarkdown("```\nabcdefghij\n```", 4, base);
  assert.deepEqual(text(rows), ["abcd", "efgh", "ij"]);
});

test("an unfinished fence while streaming shows the code so far", () => {
  assert.deepEqual(text(renderMarkdown("Try this:\n```\nlet x", 20, base)), ["Try this:", "let x"]);
});
