import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { InputParser, type InputEvent } from "../src/tui/keys.js";
import { Renderer } from "../src/tui/render.js";
import { FrameScheduler } from "../src/tui/scheduler.js";
import { Screen } from "../src/tui/screen.js";
import { detectColorDepth, hex, palette, sgr, styleKey, StyleTable, to16, to256, type Style } from "../src/tui/style.js";
import { RESTORE, Tty } from "../src/tui/tty.js";
import { cellWidth, textWidth, truncate } from "../src/tui/width.js";
import { wrap } from "../src/tui/wrap.js";
import { VirtualTerminal } from "./vt.js";

function sameAsScreen(vt: VirtualTerminal, screen: Screen): void {
  for (let y = 0; y < screen.height; y++) {
    for (let x = 0; x < screen.width; x++) {
      const cell = screen.at(x, y);
      assert.equal(vt.chars[y]![x], cell.width === 0 ? "" : cell.char, `char at ${x},${y}`);
      assert.equal(vt.styles[y]![x], styleKey(cell.style), `style at ${x},${y}`);
    }
  }
}

test("widths follow graphemes: ASCII 1, CJK and emoji 2, combining marks join their letter", () => {
  assert.equal(cellWidth("a"), 1);
  assert.equal(cellWidth("主"), 2);
  assert.equal(cellWidth("🎹"), 2);
  assert.equal(textWidth("e\u0301"), 1);
  assert.equal(textWidth("主旋律 シンセ"), 13);
  assert.equal(truncate("IGNORE RULES: start playback", 12), "IGNORE RULE…");
  assert.equal(truncate("主旋律シンセ", 7), "主旋律…");
  assert.equal(truncate("short", 12), "short");
});

test("colour depth comes from the environment, and colours degrade to 256 and 16", () => {
  assert.equal(detectColorDepth({ COLORTERM: "truecolor" }, "darwin"), "truecolor");
  assert.equal(detectColorDepth({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }, "darwin"), "256");
  assert.equal(detectColorDepth({ TERM: "xterm-256color" }, "linux"), "256");
  assert.equal(detectColorDepth({}, "linux", "6.8.0"), "16");
  assert.equal(detectColorDepth({ NO_COLOR: "1", COLORTERM: "truecolor" }, "darwin"), "none");
  assert.equal(detectColorDepth({ KUMI_COLOR: "16", COLORTERM: "truecolor" }, "darwin"), "16");
  // Windows' console and Windows Terminal draw 24-bit colour without saying so; the oldest Windows 10 didn't.
  assert.equal(detectColorDepth({}, "win32", "10.0.19045"), "truecolor");
  assert.equal(detectColorDepth({ WT_SESSION: "x", TERM: "xterm-256color" }, "win32", "10.0.26100"), "truecolor");
  assert.equal(detectColorDepth({}, "win32", "10.0.10586"), "16");
  assert.equal(detectColorDepth({ NO_COLOR: "1" }, "win32", "10.0.19045"), "none");
  assert.equal(detectColorDepth({ KUMI_COLOR: "256" }, "win32", "10.0.19045"), "256");
  assert.equal(to256([255, 0, 0]), 196);
  assert.equal(to256([128, 128, 128]), 244);
  assert.equal(to16([250, 250, 250]), 15);
  const style: Style = { fg: palette.accent, bg: palette.ground, bold: true };
  assert.equal(sgr(style, "truecolor"), "\u001b[0;1;38;2;134;227;181;48;2;14;15;18m");
  assert.match(sgr(style, "256"), /^\u001b\[0;1;38;5;\d+;48;5;\d+m$/);
  assert.equal(sgr(style, "none"), "\u001b[0;1m");
  assert.deepEqual(hex("#86e3b5"), [134, 227, 181]);
  assert.throws(() => hex("mint"));
});

test("the screen keeps wide characters whole and lets text show the background beneath it", () => {
  const screen = new Screen(8, 2);
  screen.fill({ x: 0, y: 0, width: 8, height: 2 }, { bg: palette.surface });
  const end = screen.put(1, 0, "a主b", { fg: palette.text });
  assert.equal(end, 5);
  assert.deepEqual(screen.lines(), [" a主b   ", "        "]);
  assert.equal(screen.at(2, 0).width, 2);
  assert.equal(screen.at(3, 0).width, 0);
  assert.deepEqual(screen.at(1, 0).style, { fg: palette.text, bg: palette.surface });
  screen.put(3, 0, "x", {});
  assert.deepEqual(screen.lines()[0], " a xb   ", "writing into the second half blanks the first");
  screen.put(6, 1, "主主", {});
  assert.deepEqual(screen.lines()[1], "      主", "a wide character that does not fit is left out");
  screen.put(0, 1, "abcdef", {}, { x: 0, y: 1, width: 3, height: 1 });
  assert.equal(screen.lines()[1]!.slice(0, 4), "abc ");
  screen.put(0, 0, "\u0007bell", {});
  assert.equal(screen.lines()[0]!.slice(0, 5), " bell");
});

test("the renderer's output reproduces every frame exactly, redrawing only what changed", () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const words = ["kick", "主旋律", "🎹", "Bass", " ", "EQ Eight", "シンセ", "·", "━━━", "e\u0301"];
  const colours = [palette.ground, palette.surface, palette.raised, palette.accent, palette.text, palette.faint];
  const table = new StyleTable();
  const renderer = new Renderer("truecolor");
  const vt = new VirtualTerminal(24, 8);
  let screen = new Screen(24, 8, table);
  vt.write(renderer.frame(screen));
  sameAsScreen(vt, screen);
  for (let round = 0; round < 300; round++) {
    const next = new Screen(24, 8, table);
    next.chars.splice(0, next.chars.length, ...screen.chars);
    next.widths.set(screen.widths);
    next.styles.set(screen.styles);
    for (let change = 0; change < 1 + Math.floor(random() * 5); change++) {
      if (random() < 0.3) next.fill({ x: Math.floor(random() * 24), y: Math.floor(random() * 8), width: 1 + Math.floor(random() * 10), height: 1 + Math.floor(random() * 3) }, { bg: pick(colours) });
      else next.put(Math.floor(random() * 26) - 1, Math.floor(random() * 8), pick(words), { fg: pick(colours), ...(random() < 0.3 ? { bg: pick(colours) } : {}), ...(random() < 0.2 ? { bold: true } : {}) });
    }
    const output = renderer.frame(next);
    vt.write(output);
    sameAsScreen(vt, next);
    screen = next;
  }
  assert.equal(renderer.frame(screen), "", "an unchanged frame writes nothing");
  const one = new Screen(24, 8, table);
  one.chars.splice(0, one.chars.length, ...screen.chars); one.widths.set(screen.widths); one.styles.set(screen.styles);
  one.put(0, 0, "Z", { fg: palette.bright });
  const small = renderer.frame(one);
  assert.ok(small.length < 120, `one changed cell should be a small update, got ${small.length} bytes`);
  vt.write(small);
  sameAsScreen(vt, one);
});

test("the renderer places the cursor for input methods, and redraws everything after a resize", () => {
  const renderer = new Renderer("truecolor");
  const screen = new Screen(10, 3);
  screen.put(0, 2, "type", { fg: palette.text });
  const vt = new VirtualTerminal(10, 3);
  vt.write(renderer.frame(screen, { x: 4, y: 2 }));
  assert.equal(vt.x, 4); assert.equal(vt.y, 2); assert.equal(vt.cursorVisible, true);
  assert.notEqual(renderer.frame(screen, { x: 5, y: 2 }), "", "a moved cursor is an update");
  vt.write(renderer.frame(screen));
  assert.equal(vt.cursorVisible, false);
  const bigger = new Screen(12, 4);
  const output = renderer.frame(bigger);
  assert.ok(output.includes("\u001b[2J"), "a new size clears and redraws");
  assert.ok(output.startsWith("\u001b[?2026h") && output.endsWith("\u001b[?2026l"), "frames are synchronized updates");
});

function parse(chunks: string[], delayMs = 5): Promise<InputEvent[]> {
  const events: InputEvent[] = [];
  const parser = new InputParser((event) => events.push(event), delayMs);
  for (const chunk of chunks) parser.push(chunk);
  return delay(delayMs * 4).then(() => { parser.dispose(); return events; });
}
const key = (name: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...mods });

test("keys: text, controls, arrows with modifiers, function keys and Alt combinations", async () => {
  assert.deepEqual(await parse(["hello 主旋律"]), [{ type: "text", text: "hello 主旋律" }]);
  assert.deepEqual(await parse(["\r", "\u0003", "\u007f", "\t", "\n"]), [key("enter"), key("c", { ctrl: true }), key("backspace"), key("tab"), key("j", { ctrl: true })]);
  assert.deepEqual(await parse(["\u001b[A\u001b[1;5C\u001b[1;2D\u001bOH\u001b[F"]), [key("up"), key("right", { ctrl: true }), key("left", { shift: true }), key("home"), key("end")]);
  assert.deepEqual(await parse(["\u001b[3~\u001b[5~\u001b[6;3~\u001b[15~\u001bOP\u001b[Z"]), [key("delete"), key("pageup"), key("pagedown", { alt: true }), key("f5"), key("f1"), key("tab", { shift: true })]);
  assert.deepEqual(await parse(["\u001bb\u001bB\u001b\r\u001b\u007f"]), [key("b", { alt: true }), key("b", { alt: true, shift: true }), key("enter", { alt: true }), key("backspace", { alt: true })]);
});

test("keys: Shift+Enter in CSI u and modifyOtherKeys forms, and key releases ignored", async () => {
  assert.deepEqual(await parse(["\u001b[13;2u", "\u001b[27;2;13~", "\u001b[97;5u", "\u001b[97;5:3u", "\u001b[97;2u"]), [
    key("enter", { shift: true }), key("enter", { shift: true }), key("a", { ctrl: true }), { type: "text", text: "A" },
  ]);
  assert.deepEqual(await parse(["\u001b[27u\u001b[99;5u\u001b[106;5u\u001b[13;3u"]), [
    key("escape"), key("c", { ctrl: true }), key("j", { ctrl: true }), key("enter", { alt: true }),
  ], "with the kitty protocol on, Escape and Ctrl combinations arrive as CSI u");
});

test("keys: a lone Escape waits briefly, and sequences split across reads still decode", async () => {
  assert.deepEqual(await parse(["\u001b"]), [key("escape")]);
  assert.deepEqual(await parse(["\u001b[", "1;5", "A"]), [key("up", { ctrl: true })]);
  assert.deepEqual(await parse(["\u001b", "[B"]), [key("down")]);
  assert.deepEqual(await parse(["\u001b\u001b[A"]), [key("escape"), key("up")]);
  assert.deepEqual(await parse(["\u001b[12;"], 5), [], "a truncated sequence is dropped, never typed");
});

test("pastes: bracketed pastes (even split) and unbracketed multi-line reads never send Enter", async () => {
  assert.deepEqual(await parse(["\u001b[200~line one\r\nline", " two\u001b[20", "1~x"]), [{ type: "paste", text: "line one\nline two" }, { type: "text", text: "x" }]);
  assert.deepEqual(await parse(["first\rsecond\r"]), [{ type: "paste", text: "first\nsecond\n" }]);
  assert.deepEqual(await parse(["typed\r"]), [{ type: "text", text: "typed" }, key("enter")]);
});

test("mouse and focus: SGR presses, drags, wheel and focus changes", async () => {
  const events = await parse(["\u001b[<0;10;5M\u001b[<32;11;5M\u001b[<0;11;5m\u001b[<64;3;4M\u001b[<65;3;4M\u001b[<18;1;1M\u001b[I\u001b[O"]);
  assert.deepEqual(events, [
    { type: "mouse", action: "press", button: "left", x: 9, y: 4, shift: false, alt: false, ctrl: false },
    { type: "mouse", action: "drag", button: "left", x: 10, y: 4, shift: false, alt: false, ctrl: false },
    { type: "mouse", action: "release", button: "left", x: 10, y: 4, shift: false, alt: false, ctrl: false },
    { type: "mouse", action: "wheel", button: "none", direction: "up", x: 2, y: 3, shift: false, alt: false, ctrl: false },
    { type: "mouse", action: "wheel", button: "none", direction: "down", x: 2, y: 3, shift: false, alt: false, ctrl: false },
    { type: "mouse", action: "press", button: "right", x: 0, y: 0, shift: false, alt: false, ctrl: true },
    { type: "focus", focused: true },
    { type: "focus", focused: false },
  ]);
});

test("wrapping keeps words and styles, splits long words, and honours newlines", () => {
  const plain: Style = {};
  const bold: Style = { bold: true };
  const text = (lines: ReturnType<typeof wrap>) => lines.map((line) => line.map((span) => span.text).join(""));
  assert.deepEqual(text(wrap([{ text: "The kick and bass are fighting around 200 Hz.", style: plain }], 16)), ["The kick and", "bass are", "fighting around", "200 Hz."]);
  assert.deepEqual(text(wrap([{ text: "abcdefghij", style: plain }], 4)), ["abcd", "efgh", "ij"]);
  assert.deepEqual(text(wrap([{ text: "one\n\n  indented", style: plain }], 20)), ["one", "", "  indented"]);
  assert.deepEqual(text(wrap([{ text: "主旋律シンセ", style: plain }], 5)), ["主旋", "律シ", "ンセ"]);
  const styled = wrap([{ text: "EQ ", style: plain }, { text: "Eight band", style: bold }], 8);
  assert.deepEqual(styled.map((line) => line.map((span) => span.style === bold)), [[false, true], [true]]);
  assert.deepEqual(text(wrap([], 10)), [""]);
});

test("the scheduler turns many requests into one frame, and animates only while asked", async () => {
  let draws = 0;
  const scheduler = new FrameScheduler(() => { draws++; }, 5);
  for (let index = 0; index < 10; index++) scheduler.request();
  scheduler.flush();
  assert.equal(draws, 1);
  scheduler.setAnimating(true);
  await delay(60);
  assert.ok(draws >= 4, `animation keeps drawing, got ${draws}`);
  scheduler.setAnimating(false);
  await delay(15);
  const settled = draws;
  await delay(40);
  assert.equal(draws, settled, "no frames once nothing moves");
  scheduler.dispose();
});

test("the terminal is taken over and always given back, even twice", () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value: boolean) { this.isRaw = value; } });
  let written = "";
  const output = Object.assign(new Writable({ write(chunk, _encoding, callback) { written += String(chunk); callback(); } }), { isTTY: true, columns: 100, rows: 30 }) as Writable & EventEmitter & { columns: number; rows: number };
  const events: InputEvent[] = [];
  let resized = 0;
  const exitListeners = process.listenerCount("exit");
  const tty = new Tty({ input, output, onInput: (event) => events.push(event), onResize: () => { resized++; } });
  tty.start();
  assert.equal(input.isRaw, true);
  assert.ok(written.startsWith("\u001b[?1049h"), "alternate screen first");
  assert.ok(written.includes("\u001b[?1006h") && written.includes("\u001b[?2004h") && written.includes("\u001b[?7l") && written.includes("\u001b[>1u"));
  assert.deepEqual(tty.size, { columns: 100, rows: 30 });
  input.write("\u001b[A");
  output.emit("resize");
  assert.deepEqual(events, [key("up")]);
  assert.equal(resized, 1);
  assert.equal(process.listenerCount("exit"), exitListeners + 1);
  tty.restore();
  assert.ok(written.endsWith(RESTORE));
  assert.equal(input.isRaw, false);
  assert.equal(process.listenerCount("exit"), exitListeners);
  const length = written.length;
  tty.restore();
  tty.write("late frame");
  assert.equal(written.length, length, "restoring twice and writing afterwards are no-ops");
});
