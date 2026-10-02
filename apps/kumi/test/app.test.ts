import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import type { ChangeRecord, SessionController, SessionEvent, TurnState } from "@kumi/runtime";
import { changePicture, chipColor, fitCrumbs, focusPath, setNameFrom, touchedNext, TuiApp, type TuiOptions } from "../src/tui/app.js";
import { palette } from "../src/tui/style.js";
import { Editor } from "../src/tui/editor.js";
import { RESTORE } from "../src/tui/tty.js";
import type { ModelControl } from "../src/models.js";
import { openInputHistory, type InputHistory } from "../src/history.js";
import { fakeModels, MODELS } from "./fake-models.js";
import { VirtualTerminal } from "./vt.js";

const opened: TuiApp[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((app) => app.close())); });

function harness(columns = 120, rows = 36, models?: ModelControl, extra: Partial<SessionController> = {}, history?: InputHistory, more: Partial<TuiOptions> = {}) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value: boolean) { this.isRaw = value; } });
  let written = "";
  const output = Object.assign(new Writable({ write(chunk, _encoding, callback) { written += String(chunk); callback(); } }), { isTTY: true, columns, rows });
  const calls: string[] = [];
  let state: TurnState = "idle";
  const controller: SessionController = {
    async start() { calls.push("start"); },
    async submit(text) { calls.push(`submit:${text}`); },
    async refresh() { calls.push("refresh"); },
    async newConversation() { calls.push("new"); },
    async cancel() { calls.push("cancel"); state = "idle"; },
    async close() { calls.push("close"); state = "closed"; },
    status() { return { state, connection: "connected", turns: 0, maxTurns: 30 }; },
    async undo(id) {
      calls.push(`undo:${id ?? "last"}`);
      const change = undoResult?.(id);
      if (change) app.handleEvent({ type: "change", change });
      return change;
    },
    ...extra,
  };
  let undoResult: ((id: string | undefined) => ChangeRecord | undefined) | undefined;
  // Never the real browser: a sign-in link is only recorded.
  const browsed: string[] = [];
  const app = new TuiApp({ controller, input, output, ...(models ? { models } : {}), ...(history ? { history } : {}), openBrowser: (url) => { browsed.push(url); },
    // Glyphs whatever the terminal running the tests (a CI Windows runner would get badges); badges are tested on their own.
    icons: "glyphs", mode: "live", secrets: ["private-token"], colorDepth: "truecolor", frameMs: 1, closeTimeoutMs: 100, ...more });
  opened.push(app);
  let vt = new VirtualTerminal(columns, rows);
  let consumed = 0;
  return {
    input, output, app, calls, browsed,
    onUndo(result: (id: string | undefined) => ChangeRecord | undefined) { undoResult = result; },
    get written() { return written; },
    screen(): string[] {
      app.flush();
      vt.write(written.slice(consumed));
      consumed = written.length;
      return vt.lines();
    },
    emit(event: SessionEvent) {
      if (event.type === "state") state = event.state;
      app.handleEvent(event);
    },
    async type(data: string) {
      input.write(data);
      await delay(45);
    },
    resize(width: number, height: number) {
      output.columns = width; output.rows = height;
      vt = new VirtualTerminal(width, height);
      consumed = written.length;
      output.emit("resize");
    },
  };
}

const has = (lines: string[], text: string) => lines.some((line) => line.includes(text));
const connect = (h: ReturnType<typeof harness>) => {
  h.emit({ type: "connection", state: "connected" });
  h.emit({ type: "observation", label: "Current open Set: Night Drive — Remote Script · real-live" });
};

test("Kumi opens full screen with the header, the Live pane and the input box, and closes cleanly", async () => {
  const h = harness();
  const done = h.app.run();
  await delay(5);
  connect(h);
  const lines = h.screen();
  assert.match(lines[0]!, /^ {2}Kumi {2}· {2}Night Drive +● Live {2}$/);
  for (const text of ["FOCUS", "NOW", "HISTORY", "Ready", "Nothing changed yet", "Kumi can see Night Drive.", "Ask Kumi about your Set", "enter to send"]) assert.ok(has(lines, text), text);
  assert.ok(h.calls.includes("start"));
  assert.equal(h.input.isRaw, true);
  await h.type("\u0003");
  assert.equal(await done, 0);
  assert.ok(h.calls.includes("close"));
  assert.equal(h.input.isRaw, false);
  assert.ok(h.written.endsWith(`${RESTORE}Kumi closed. Each Set's conversation continues next time.\n`), "the terminal is restored before the goodbye");
});

test("typing and sending, then streaming text and steps in plain words, then the finished turn", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("what's on 主旋律?");
  assert.ok(has(h.screen(), "what's on 主旋律?"));
  await h.type("\r");
  assert.ok(h.calls.includes("submit:what's on 主旋律?"));
  h.emit({ type: "state", state: "running" });
  h.emit({ type: "text", text: "The kick and bass are fighting around 200 Hz, private-token." });
  h.emit({ type: "tool-start", id: "t1", name: "live_discover" });
  let lines = h.screen();
  assert.ok(has(lines, "The kick and bass are fighting around 200 Hz, [redacted]."), "secrets never reach the screen");
  assert.ok(!lines.join("\n").includes("private-token"));
  assert.ok(lines.some((line) => /│ \S looking at your Set/.test(line)), "a step at work says what it's doing, in its own animation");
  assert.ok(has(lines, "working") && has(lines, "esc to stop"));
  h.emit({ type: "tool-end", id: "t1", name: "live_discover", isError: false, elapsedMs: 300 });
  lines = h.screen();
  assert.ok(lines.some((line) => line.includes("│ ✓ looked at your Set") && line.includes("0.3s")));
  h.emit({ type: "turn-complete", result: { stopReason: "completed" }, elapsedMs: 3100 });
  h.emit({ type: "state", state: "idle" });
  lines = h.screen();
  assert.ok(has(lines, "▾ 1 step · 3.1s"));
  assert.ok(has(lines, "│ ✓ looked at your Set"), "a finished answer keeps its steps");
  assert.ok(has(lines, "Ready"));
  assert.ok(!has(lines, "live_discover"), "tool names stay out of sight");
  await h.app.close();
});

test("answers render their markdown: bold, bullets and code, without the markers", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  await h.type("what's on the bass?\r");
  h.emit({ type: "state", state: "running" });
  h.emit({ type: "text", text: "**Bass** has:\n- EQ Eight\n- Compressor with `attack 12 ms`" });
  h.emit({ type: "turn-complete", result: { stopReason: "completed" }, elapsedMs: 900 });
  h.emit({ type: "state", state: "idle" });
  const lines = h.screen();
  assert.ok(has(lines, "Bass has:") && has(lines, "• EQ Eight") && has(lines, "• Compressor with attack 12 ms"));
  assert.ok(!has(lines, "**") && !has(lines, "`"));
  await h.app.close();
});

test("esc stops Kumi's work; ctrl+c clears the box before it quits", async () => {
  const h = harness();
  const done = h.app.run();
  await delay(5);
  h.emit({ type: "state", state: "running" });
  await h.type("\u001b");
  assert.ok(h.calls.includes("cancel"));
  h.emit({ type: "state", state: "idle" });
  await h.type("draft");
  assert.ok(has(h.screen(), "draft"));
  await h.type("\u0003");
  assert.ok(!has(h.screen(), "draft"), "the first ctrl+c clears the box");
  assert.ok(!h.calls.includes("close"));
  await h.type("\u0003");
  assert.equal(await done, 0);
});

test("the / menu lists a few commands, moves with the arrows and runs the choice", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  await h.type("/");
  let lines = h.screen();
  assert.ok(lines.some((line) => line.includes("/new") && line.includes("Forget this conversation and start fresh")));
  assert.ok(has(lines, "/refresh") && !has(lines, "Read your Live Set again"), "only the highlighted command explains itself");
  await h.type("\u001b[B\u001b[B");
  assert.ok(has(h.screen(), "Read your Live Set again"));
  await h.type("\r");
  assert.ok(h.calls.includes("refresh"));
  await h.type("/q");
  lines = h.screen();
  assert.ok(has(lines, "Close Kumi") && !has(lines, "/new"));
  await h.type("\u001b");
  assert.ok(!has(h.screen(), "Close Kumi"), "esc closes the menu and keeps the text");
  await h.type("\u0015/nope\r");
  assert.ok(has(h.screen(), "There's no /nope command. Type / to see them."));
  // A file dragged into the terminal pastes its path: that's a message for the model, not a command.
  await h.type("\u0015/Users/me/ref.wav\r");
  assert.ok(h.calls.includes("submit:/Users/me/ref.wav"));
  await h.app.close();
});

test("narrow windows fold the Live pane into a strip above the input box", async () => {
  const h = harness(80, 24);
  void h.app.run();
  await delay(5);
  connect(h);
  const lines = h.screen();
  assert.ok(!has(lines, "HISTORY") && !has(lines, "FOCUS"));
  assert.ok(lines.slice(15).some((line) => line.includes("Night Drive")), "the strip shows where Kumi is");
  assert.ok(has(lines, "Ask Kumi about your Set"));
  await h.app.close();
});

test("resizing redraws everything at the new size", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  h.screen();
  h.resize(90, 28);
  await delay(10);
  const lines = h.screen();
  assert.equal(lines.length, 28);
  assert.match(lines[0]!, /Kumi {2}· {2}Night Drive/);
  assert.ok(!has(lines, "HISTORY"), "90 columns is narrow");
  await h.app.close();
});

test("pasting several lines never sends, and the box grows to show them", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  await h.type("\u001b[200~line one\nline two\nline three\u001b[201~");
  const lines = h.screen();
  assert.ok(has(lines, "line one") && has(lines, "line two") && has(lines, "line three"));
  assert.ok(!h.calls.some((call) => call.startsWith("submit")));
  await h.app.close();
});

test("scrolling back keeps your place while new lines arrive", async () => {
  const h = harness(100, 24);
  void h.app.run();
  await delay(5);
  for (let index = 1; index <= 30; index++) h.emit({ type: "notice", message: `note number ${index}` });
  let lines = h.screen();
  assert.ok(has(lines, "note number 30") && !has(lines, "note number 1 "));
  await h.type("\u001b[5~");
  lines = h.screen();
  const top = lines.find((line) => line.includes("note number"))!;
  assert.ok(!has(lines, "note number 30"));
  assert.ok(has(lines, "newer below · page down"));
  h.emit({ type: "notice", message: "note number 31" });
  assert.equal(h.screen().find((line) => line.includes("note number")), top, "the view does not jump");
  await h.type("\u001b[6~\u001b[6~\u001b[6~");
  assert.ok(has(h.screen(), "note number 31"));
  await h.app.close();
});

test("a failed turn says so, and losing Live is explained", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("hello\r");
  h.emit({ type: "state", state: "running" });
  h.emit({ type: "error", message: "anthropic rejected the credentials (HTTP 401). Check the configured model." });
  h.emit({ type: "state", state: "idle" });
  // As the session reports it: the state, then what Kumi does about it.
  h.emit({ type: "connection", state: "disconnected" });
  h.emit({ type: "notice", message: "Live closed. Kumi will pick up where you left off when it's back." });
  const lines = h.screen();
  assert.ok(has(lines, "Kumi couldn't answer that; see the note below."));
  assert.ok(has(lines, "anthropic rejected the credentials (HTTP 401)"));
  assert.ok(has(lines, "Live closed. Kumi will pick up where you left off"));
  assert.match(lines[0]!, /● Live not connected {2}$/);
  await h.app.close();
});

test("FOCUS shows where you are in Live, in the wide pane and the narrow strip", async () => {
  const focus = { track: { name: "Bass", color: "#f59a3c", kind: "midi" as const }, device: "Operator", detail: "Device" as const, view: "Session" as const,
    parameter: { name: "Filter Freq", value: "1.20 kHz", owner: "Operator" } };
  for (const [columns, rows] of [[120, 36], [80, 24]] as const) {
    const h = harness(columns, rows);
    void h.app.run();
    await delay(5);
    connect(h);
    h.emit({ type: "focus", focus });
    const lines = h.screen();
    if (columns === 120) {
      assert.ok(has(lines, "■ Bass › Operator › Filter Freq") && has(lines, "1.20 kHz · Session · Device view"), "a tight pane moves the value to the second line");
    } else {
      assert.ok(has(lines, "■ Bass › Operator › Filter Freq · 1.20 kHz"), "the strip has room for the value");
    }
    h.emit({ type: "connection", state: "disconnected" });
    assert.ok(!has(h.screen(), "■ Bass"), "no stale focus once Live is gone");
    await h.app.close();
  }
});

const click = (lines: string[], row: number, text: string) => {
  const column = lines[row]!.indexOf(text);
  assert.ok(column >= 0, `${text} is on row ${row}`);
  return `\u001b[<0;${column + 1};${row + 1}M\u001b[<0;${column + 1};${row + 1}m`;
};

test("HISTORY lists Kumi's changes newest first with their own undo, and NOW shows the one just made", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  const tempo: ChangeRecord = { id: "c1", family: "tempo", title: "Tempo 120 → 124 BPM", state: "applied", from: 120, to: 124, at: 1 };
  const mixer: ChangeRecord = { id: "c2", family: "mixer", title: "Bass volume 0.0 dB → -2.0 dB, pan C → 5L", track: { name: "Bass", color: "#f59a3c" }, state: "applied", from: 0.85, to: 0.6, at: 2 };
  h.emit({ type: "change", change: tempo });
  h.emit({ type: "change", change: mixer });
  let lines = h.screen();
  assert.ok(has(lines, "✓ Bass volume 0.0 dB"), "NOW shows the change just made");
  assert.ok(!has(lines, "Nothing changed yet"));
  const history = lines.findIndex((line) => line.includes("HISTORY"));
  assert.match(lines[history + 1]!, /■ Bass volume 0\.0 dB → -2\.0 dB, +undo/);
  // The right pane only: the conversation area beside it may hold the welcome.
  const pane = lines[history]!.indexOf("HISTORY") - 2;
  assert.match(lines[history + 2]!.slice(pane), /^ +pan C → 5L *$/, "a long title continues on a second line, whole");
  const tempoRow = history + 3;
  assert.match(lines[tempoRow]!, /✓ Tempo 120 → 124 BPM +undo/);
  h.onUndo(() => ({ ...tempo, state: "undone" }));
  await h.type(click(lines, tempoRow, "undo"));
  assert.ok(h.calls.includes("undo:c1"), "clicking undo takes back that change");
  lines = h.screen();
  assert.match(lines[tempoRow]!, /○ Tempo 120 → 124 BPM +undone/);
  assert.ok(has(lines, "Undid: Tempo 120 → 124 BPM"));
  await h.app.close();
});

test("/undo takes back the latest change; a refused undo is kept and explained", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("/undo\r");
  assert.ok(has(h.screen(), "There's nothing of Kumi's to undo."));
  assert.ok(!h.calls.some((call) => call.startsWith("undo:")), "nothing to undo asks nothing of Live");
  const change: ChangeRecord = { id: "c7", family: "rename", title: "Renamed track “Bass” → “Sub”", state: "applied", at: 1 };
  h.emit({ type: "change", change });
  h.onUndo(() => ({ ...change, state: "kept", note: "It changed in Live since, so Kumi left it as it is." }));
  await h.type("/undo\r");
  assert.ok(h.calls.includes("undo:last"));
  const lines = h.screen();
  assert.ok(has(lines, "Kept: Renamed track “Bass” → “Sub”.") && has(lines, "It changed in Live since"), "the notice says why");
  assert.ok(lines.some((line) => /Renamed track “Bass” → “Sub” +kept/.test(line)));
  await h.app.close();
});

test("/copy puts the last answer on the clipboard through the terminal", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("/copy\r");
  assert.ok(has(h.screen(), "There's no answer to copy yet."));
  await h.type("hi\r");
  h.emit({ type: "state", state: "running" });
  h.emit({ type: "text", text: "Try a **shorter** release." });
  h.emit({ type: "turn-complete", result: { stopReason: "completed" }, elapsedMs: 10 });
  h.emit({ type: "state", state: "idle" });
  await h.type("/copy\r");
  const sequence = /\u001b\]52;c;([A-Za-z0-9+/=]+)\u0007/.exec(h.written);
  assert.ok(sequence, "an OSC 52 clipboard write");
  assert.equal(Buffer.from(sequence![1]!, "base64").toString("utf8"), "Try a **shorter** release.");
  assert.ok(has(h.screen(), "Copied Kumi's last answer."));
  await h.app.close();
});

test("NOW draws a change's before and after as positions while it shows the change", async () => {
  const change: ChangeRecord = { id: "c9", family: "mixer", title: "Bass volume 0.0 dB → -6.0 dB", state: "applied", from: 0.8, to: 0.4, range: [0, 1], at: 1 };
  assert.deepEqual(changePicture(change, 40)?.[0]?.map((part) => part.text), ["██████████░░", " → ", "█████░░░░░░░"]);
  const { range: _range, ...unspanned } = change;
  assert.equal(changePicture(unspanned, 40), undefined, "no span, no picture");
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "change", change });
  assert.ok(has(h.screen(), "██████████░░ → █████░░░░░░░"));
  await h.app.close();
});

test("NOW draws a colour change as the old and new swatches", () => {
  const change: ChangeRecord = { id: "c11", family: "color", title: "Bass colour changed", state: "applied", at: 1, colors: { from: "#f7f47c", to: "#e553a0" } };
  const [line] = changePicture(change, 40)!;
  assert.deepEqual(line!.map((part) => part.text), ["████", " → ", "████"]);
  assert.deepEqual([line![0]!.style.fg, line![2]!.style.fg], [[0xf7, 0xf4, 0x7c], [0xe5, 0x53, 0xa0]]);
  const { colors: _colors, ...plain } = change;
  assert.deepEqual(changePicture({ ...plain, colors: { to: "#e553a0" } }, 40)![0]!.map((part) => part.text), ["████"], "just the new colour when the old one wasn't known");
  assert.deepEqual(changePicture({ ...change, colors: { from: "#3c3c3c", to: "#e553a0" } }, 40)![0]![0]!.style.fg, [0x94, 0x94, 0x94], "dark colours lightened like the chips, so they show on the pane");
  for (const depth of ["16", "none"] as const) assert.equal(changePicture(change, 40, depth), undefined, `no swatches with ${depth} colours`);
  assert.ok(changePicture(change, 40, "256"), "256 colours tell most of Live's apart");
});

test("a loaded device's picture: a track's devices in a row, or a rack's chains stacked, the new one lit", () => {
  const base: ChangeRecord = { id: "c9", family: "device", title: "Loaded Reverb", state: "applied", at: 0 };
  const text = (lines: ReturnType<typeof changePicture>) => lines!.map((line) => line.map((part) => part.text).join(""));
  const lit = (lines: ReturnType<typeof changePicture>) => lines!.flatMap((line) => line.filter((part) => JSON.stringify(part.style.fg) === JSON.stringify(palette.accent)).map((part) => part.text));
  const row = changePicture({ ...base, devices: { devices: ["Operator", "Reverb", "Utility"], index: 1 } }, 40);
  assert.deepEqual(text(row), ["Operator → Reverb → Utility"]); assert.deepEqual(lit(row), ["Reverb"]);
  const narrow = changePicture({ ...base, devices: { devices: ["Arpeggiator", "Operator", "Reverb", "Echo", "Utility"], index: 4 } }, 20);
  assert.deepEqual(text(narrow), ["… → Echo → Utility"], "the lit one stays; the far end gives way");
  const rack = changePicture({ ...base, devices: { rack: "Instrument Rack", chain: 1, index: 1, chains: [{ name: "Wavetable", devices: ["Wavetable"] }, { name: "Operator", devices: ["Operator", "Reverb"] }, { name: "Bells", devices: ["Collision"] }] } }, 48);
  assert.deepEqual(text(rack), ["╭ Operator  Operator → Reverb", "╰ Bells     Collision  +1"], "the chain it went into and the next, the rest counted");
  assert.deepEqual(lit(rack), ["Reverb"]);
  const added = changePicture({ ...base, devices: { rack: "Instrument Rack", chain: 1, chains: [{ name: "Wavetable", devices: ["Wavetable"] }, { name: "Chain", devices: [] }] } }, 48);
  assert.deepEqual(text(added), ["╭ Wavetable  Wavetable", "╰ Chain      empty"]); assert.deepEqual(lit(added), ["Chain      "], "a new chain's name is lit");
});

test("NOW draws a new clip's notes as a tiny piano roll", async () => {
  const chord: ChangeRecord = { id: "c10", family: "clip", title: "New MIDI clip “Chord” · 3 notes", state: "applied", at: 1,
    clip: { length: 4, notes: [60, 64, 67].map((pitch) => ({ pitch, start: 0, duration: 4, velocity: 96 })) } };
  const text = (line: { text: string }[] | undefined) => (line ?? []).map((part) => part.text).join("");
  const lines = changePicture(chord, 12)!;
  assert.deepEqual(lines.map(text), ["⣉".repeat(12), "⣀".repeat(12)], "C, E and G at their distance: G at the top, E three lanes down, C at the bottom");
  const melody: ChangeRecord = { ...chord, clip: { length: 4, notes: [{ pitch: 72, start: 0, duration: 2, velocity: 100 }, { pitch: 60, start: 2, duration: 2, velocity: 30 }] } };
  const [high, low] = changePicture(melody, 8)!;
  assert.equal(text(high), "⠉⠉⠉⠉⠀⠀⠀⠀"); assert.equal(text(low), "⠀⠀⠀⠀⣀⣀⣀⣀", "time runs across, higher notes sit higher");
  assert.notDeepEqual(low!.find((part) => part.text.includes("⣀"))!.style, high!.find((part) => part.text.includes("⠉"))!.style, "quieter notes are dimmer");
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "change", change: chord });
  const screen = h.screen();
  const row = screen.findIndex((line) => line.includes("⣉⣉⣉⣉⣉⣉⣉⣉"));
  assert.ok(row > 0 && screen[row + 1]!.includes("⣀⣀⣀⣀⣀⣀⣀⣀"), "two rows under NOW");
  assert.ok(screen[row - 1]!.includes("New MIDI clip"), "right under the change's title");
  await h.app.close();
});

test("the narrow strip offers undo for the latest change", async () => {
  const h = harness(80, 24);
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "change", change: { id: "c3", family: "tempo", title: "Tempo 120 → 96 BPM", state: "applied", at: 1 } });
  const lines = h.screen();
  const row = lines.findIndex((line) => line.includes("✓ Tempo 120 → 96 BPM") && line.includes("undo"));
  assert.ok(row >= 0, "the strip shows the change with undo");
  h.onUndo(() => ({ id: "c3", family: "tempo", title: "Tempo 120 → 96 BPM", state: "undone", at: 1 }));
  await h.type(click(lines, row, "undo"));
  assert.ok(h.calls.includes("undo:c3"));
  await h.app.close();
});

test("a message typed while Kumi connects is kept and sent as soon as it's ready", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  h.emit({ type: "state", state: "running" });
  await h.type("what's the tempo?\r");
  assert.ok(has(h.screen(), "what's the tempo?"), "shown straight away");
  assert.ok(!h.calls.some((call) => call.startsWith("submit:")), "not sent while Kumi is still connecting");
  h.emit({ type: "state", state: "idle" });
  await delay(10);
  assert.ok(h.calls.includes("submit:what's the tempo?"));
  await h.app.close();
});

test("after /reconnect, earlier changes stay listed without their undo", async () => {
  const h = harness(120, 36, undefined, { async reconnect() { h.calls.push("reconnect"); } });
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "change", change: { id: "c5", family: "tempo", title: "Tempo 120 → 126 BPM", state: "applied", at: 1 } });
  await h.type("/reconnect\r");
  assert.ok(h.calls.includes("reconnect"));
  await delay(10);
  const lines = h.screen();
  assert.ok(lines.some((line) => /Tempo 120 → 126 BPM +no undo/.test(line)));
  await h.app.close();
});

test("a resumed conversation shows its earlier exchanges", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "resumed", savedAt: Date.now() - 2 * 60 * 60_000, lines: [{ role: "user", text: "Make the pad wider" }, { role: "assistant", text: "Widened the **Pad** chorus." }] });
  const lines = h.screen();
  for (const text of ["Continuing your conversation from 2 hours ago. /new starts fresh.", "Make the pad wider", "Widened the Pad chorus."]) assert.ok(has(lines, text), text);
  await h.app.close();
});

test("the welcome screen opens with Kumi's wordmark when the window has room for it", async () => {
  const { LOGO_LETTERS, LOGO_RULE } = await import("../src/tui/logo.js");
  const tall = harness(120, 36);
  void tall.app.run();
  await delay(5);
  connect(tall);
  const lines = tall.screen();
  for (const text of [...LOGO_LETTERS.map((line) => line.trim()), LOGO_RULE]) assert.ok(has(lines, text), text);
  assert.ok(lines.findIndex((line) => line.includes(LOGO_RULE)) < lines.findIndex((line) => line.includes("Kumi can see Night Drive.")), "above the welcome");
  // Centred: the wordmark's middle is the conversation area's middle, and the block sits mid-height.
  const ruleRow = lines.findIndex((line) => line.includes(LOGO_RULE));
  const ruleMiddle = lines[ruleRow]!.indexOf(LOGO_RULE) + LOGO_RULE.length / 2;
  const paneEnd = lines[0]!.length - (lines.find((line) => line.includes("FOCUS"))!.length - lines.find((line) => line.includes("FOCUS"))!.indexOf("FOCUS")) - 2;
  assert.ok(Math.abs(ruleMiddle - paneEnd / 2) <= 4, `centred across (${ruleMiddle} vs ${paneEnd / 2})`);
  const firstRow = lines.findIndex((line) => line.includes(LOGO_LETTERS[0]!.trim()));
  const lastRow = lines.findIndex((line) => line.includes("/conversations goes back"));
  assert.ok(Math.abs((firstRow + lastRow) / 2 - lines.length / 2) <= 4, `centred down (${firstRow}–${lastRow} of ${lines.length})`);
  await tall.app.close();
  const short = harness(120, 16);
  void short.app.run();
  await delay(5);
  connect(short);
  assert.ok(!has(short.screen(), LOGO_RULE) && has(short.screen(), "Kumi can see Night Drive."), "a short window keeps the welcome and drops the wordmark");
  await short.app.close();
});

test("the welcome screen catches you up on the Set; later it's a note in the conversation", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  const lastSeenAt = Date.now() - 3 * 24 * 60 * 60_000;
  h.emit({ type: "catch-up", catchUp: { set: "Night Drive", lastSeenAt, lines: ["Tempo 120 → 124 BPM", "Added track “Pad”"], more: 2 } });
  let lines = h.screen();
  for (const text of ["Since you were last here · 3 days ago", "• Tempo 120 → 124 BPM", "• Added track “Pad”", "and 2 more changes", "Try"]) assert.ok(has(lines, text), text);
  await h.type("hello\r");
  h.emit({ type: "catch-up", catchUp: { set: "Night Drive", lastSeenAt, lines: [], more: 0 } });
  lines = h.screen();
  assert.ok(has(lines, "Nothing changed in Night Drive since you were last here, 3 days ago."));
  await h.app.close();
});

test("a newer Kumi shows on the welcome screen, later as a note; /update asks, then closes Kumi so it updates", async () => {
  let requested = 0; let latest: string | undefined; let unreachable = false;
  const updates = { current: "1.0.0", request: () => { requested++; },
    check: async () => { if (unreachable) throw new Error("Kumi couldn't reach GitHub to ask; check your internet connection"); return latest; } };
  // Nothing newer, or no way to ask: /update says which.
  const h = harness(120, 36, undefined, {}, undefined, { updates });
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("/update\r");
  await delay(10);
  assert.ok(has(h.screen(), "Kumi is up to date (1.0.0)."));
  unreachable = true;
  await h.type("/update\r");
  await delay(10);
  const lines_ = h.screen();
  assert.ok(has(lines_, "Kumi couldn't reach GitHub to ask") && has(lines_, "/update again later."), "why it couldn't ask, and what to do");
  // Found once the conversation has begun: a note.
  h.app.offerUpdate("1.1.0");
  assert.ok(has(h.screen(), "Kumi 1.1.0 is out: /update gets it."));
  await h.app.close();
  assert.equal(requested, 0);
  // Found as Kumi starts: the welcome screen says so, and /update offers it.
  unreachable = false;
  const w = harness(120, 36, undefined, {}, undefined, { updates });
  const closed = w.app.run();
  await delay(5);
  connect(w);
  w.app.offerUpdate("1.1.0");
  let lines = w.screen();
  assert.ok(has(lines, "Kumi 1.1.0 is out · /update gets it") && has(lines, "Kumi can see Night Drive."), "on the welcome screen");
  await w.type("/update\r");
  await delay(10);
  lines = w.screen();
  assert.ok(has(lines, "Update to Kumi 1.1.0?") && has(lines, "Kumi closes, updates and opens again"));
  await w.type("\u001b[B\r");
  await delay(5);
  assert.ok(!has(w.screen(), "Update to Kumi 1.1.0?"), "not now closes the question");
  assert.equal(requested, 0);
  await w.type("/update\r");
  await delay(10);
  await w.type("\r");
  assert.equal(await closed, 0, "Kumi closes");
  assert.equal(requested, 1, "and updates once it has");
  // Without updates to offer (a test, or a Kumi that can't), there's no /update.
  const none = harness();
  void none.app.run();
  await delay(5);
  await none.type("/upd");
  assert.ok(!has(none.screen(), "Get the newest Kumi"));
  await none.app.close();
});

test("focus paths follow Live's detail view, shorten from the middle, and keep dark colours visible", () => {
  assert.deepEqual(focusPath({ track: { name: "Keys" }, detail: "Clip", clip: "", view: "Arrangement", selectedNotes: 2 }), { crumbs: ["Keys", "Untitled clip"], context: "Arrangement · Clip view · 2 notes selected" });
  assert.deepEqual(focusPath({ track: { name: "Keys" }, detail: "Device", device: "Reverb", parameter: { name: "Pan", owner: "Mixer" } }).crumbs, ["Keys", "Reverb"], "a parameter from elsewhere is not shown as the device's");
  assert.deepEqual(focusPath({ track: { name: "Keys" }, detail: "Device", device: "Reverb", parameter: { name: "Decay Time", value: "2.50 s", owner: "Reverb" } }), { crumbs: ["Keys", "Reverb", "Decay Time"], value: "2.50 s", context: "Device view" });
  assert.deepEqual(focusPath({ track: { name: "Keys" }, scene: "Chorus" }).crumbs, ["Keys", "Chorus"]);
  assert.deepEqual(fitCrumbs(["Keys", "Instrument Rack", "Pad Layer", "Chorus-Ensemble", "Rate"], 24), ["Keys", "…", "Rate"]);
  assert.deepEqual(fitCrumbs(["Keys", "Reverb"], 40), ["Keys", "Reverb"]);
  assert.deepEqual(chipColor("#f59a3c"), [245, 154, 60]);
  const lifted = chipColor("#1a1a1a");
  assert.ok(lifted[0] > 100, "a near-black track colour is lightened");
  assert.deepEqual(chipColor(undefined), chipColor("not a colour"));
});

test("the Set name comes from the observation label", () => {
  assert.equal(setNameFrom("Current open Set: Night Drive — Remote Script · real-live"), "Night Drive");
  assert.equal(setNameFrom("Current open Set: A — B — Remote Script · real-live"), "A — B");
  assert.equal(setNameFrom("Inference-only — No Live access"), undefined);
});

test("the editor moves by character, word and line, and wraps wide characters whole", () => {
  const editor = new Editor();
  editor.insert("make the 🎹 brighter");
  editor.wordLeft();
  assert.equal(editor.cursor, 11);
  editor.deleteWordLeft();
  assert.equal(editor.text, "make the brighter");
  editor.insert("e");
  editor.insert("\u0301");
  assert.equal(editor.text, "make the e\u0301brighter");
  assert.equal(editor.cursor, 10, "the accent joins its letter as one character");
  editor.set("line one\nline two");
  editor.home();
  assert.equal(editor.cursor, 9);
  editor.killToEnd();
  assert.equal(editor.text, "line one\n");
  editor.set("abc");
  editor.left(); editor.left(); editor.killToStart();
  assert.equal(editor.text, "bc");
  editor.set("主旋律シンセ");
  const layout = editor.layout(5);
  assert.deepEqual(layout.rows, ["主旋", "律シ", "ンセ"]);
  assert.deepEqual([layout.cursorRow, layout.cursorColumn], [2, 4]);
  editor.set("abcd");
  assert.deepEqual(editor.layout(4), { rows: ["abcd", ""], cursorRow: 1, cursorColumn: 0 }, "a full row moves the cursor to the next");
  editor.set("first line\nsecond");
  assert.equal(editor.vertical(20, -1), true);
  assert.equal(editor.cursor, 6, "up keeps the column");
  assert.equal(editor.vertical(20, -1), false);
});

// ---- the model, and signing in

const panelLines = (lines: string[]) => lines.slice(1);

test("/model lists each provider's own models under whether Kumi is signed in there; typing filters, and a choice says when it applies", async () => {
  const fake = fakeModels({ model: "openai-codex/gpt-6-astra", signedIn: ["openai-codex"], lists: MODELS });
  const h = harness(120, 36, fake.control);
  void h.app.run();
  await delay(5);
  connect(h);
  assert.match(h.screen()[0]!, /Night Drive +GPT-6 Astra +● Live {2}$/, "the header names the model");
  await h.type("/model\r");
  await delay(10);
  let lines = panelLines(h.screen());
  assert.ok(has(lines, "Choose a model") && has(lines, "type to filter"));
  assert.ok(lines.some((line) => /ChatGPT +signed in/.test(line)));
  assert.ok(lines.some((line) => line.includes("GPT-6 Astra") && line.includes("Frontier model for complex work") && line.includes("current")));
  assert.ok(lines.some((line) => /Anthropic +not signed in/.test(line)));
  assert.ok(lines.some((line) => line.includes("Sign in to Anthropic") && line.includes("with an API key") && line.includes("sign in")));
  assert.ok(has(h.screen(), "↑↓ to move · enter to choose · esc to close"));
  await h.type("luna");
  lines = panelLines(h.screen());
  assert.ok(has(lines, "filter: luna") && has(lines, "GPT-6 Luna") && !has(lines, "GPT-6 Astra") && !has(lines, "Anthropic"));
  await h.type("\r");
  await delay(5);
  assert.ok(fake.calls.includes("choose:openai-codex/gpt-6-luna"));
  lines = h.screen();
  assert.ok(!has(lines, "Choose a model"), "the panel closes");
  assert.ok(has(lines, "Kumi talks to GPT-6 Luna from your next message, at its usual low effort."));
  assert.match(lines[0]!, /GPT-6 Luna +● Live/);
  await h.app.close();
});

test("signing in with a key never shows it: dots only, checked with the provider first, and asked again when refused", async () => {
  const fake = fakeModels({ model: "openai-codex/gpt-6-astra", signedIn: ["openai-codex"], lists: MODELS });
  const h = harness(120, 36, fake.control);
  void h.app.run();
  await delay(5);
  await h.type("/login\r");
  await delay(5);
  let lines = h.screen();
  assert.ok(has(lines, "Sign in to") && lines.some((line) => line.includes("Anthropic") && line.includes("with an API key")));
  await h.type("\u001b[B\r");
  await delay(5);
  assert.ok(has(h.screen(), "Paste your Anthropic API key. It stays hidden, even here."));
  const refused = "refused-key-0123456789";
  await h.type(`\u001b[200~${refused}\u001b[201~`);
  lines = h.screen();
  assert.ok(has(lines, "•".repeat(refused.length)) && has(lines, `${refused.length} characters`));
  await h.type("\r");
  await delay(5);
  assert.ok(has(h.screen(), "Anthropic didn't accept that key. Paste it again, or esc to leave it."));
  const key = "sk-ant-private-0123456789abcdef";
  await h.type(`\u001b[200~${key}\u001b[201~\r`);
  await delay(10);
  lines = h.screen();
  assert.ok(has(lines, "Signed in to Anthropic.") && !has(lines, "Paste your Anthropic API key"));
  assert.ok(fake.calls.includes(`key:anthropic:${key.length}`));
  // Should the key ever come back in a message, it's hidden there too.
  h.emit({ type: "notice", message: `the provider echoed ${key}` });
  h.screen();
  for (const secret of [refused, key]) assert.ok(!h.written.includes(secret), "a key is never drawn");
  await h.app.close();
});

test("an answer that fails for want of a sign-in offers one, then sends the message again", async () => {
  const fake = fakeModels({ model: "anthropic/claude-sonnet-5-5", signedIn: ["openai-codex"], lists: MODELS });
  const h = harness(120, 36, fake.control);
  void h.app.run();
  await delay(10);
  assert.ok(has(h.screen(), "Sign in to Anthropic?"), "offered as Kumi starts");
  await h.type("\u001b");
  assert.ok(!has(h.screen(), "Sign in to Anthropic?"));
  await h.type("How do I tame the snare?\r");
  await delay(5);
  h.emit({ type: "state", state: "running" });
  h.emit({ type: "error", message: "Not signed in to Anthropic: add its API key with /login (or set ANTHROPIC_API_KEY).", kind: "auth", provider: "anthropic" });
  h.emit({ type: "state", state: "idle" });
  let lines = h.screen();
  assert.ok(has(lines, "Not signed in to Anthropic") && has(lines, "Sign in to Anthropic?") && has(lines, "Sign in now") && has(lines, "Choose another model"));
  await h.type("\r");
  await delay(5);
  assert.ok(has(h.screen(), "Paste your Anthropic API key"));
  await h.type("\u001b[200~sk-ant-fixture-0000\u001b[201~\r");
  await delay(10);
  lines = h.screen();
  assert.ok(has(lines, "Signed in to Anthropic.") && has(lines, "Sending your message again."));
  assert.deepEqual(h.calls.filter((call) => call.startsWith("submit")), ["submit:How do I tame the snare?", "submit:How do I tame the snare?"]);
  await h.app.close();
});

test("a model the provider doesn't offer, or no model at all, opens the choice", async () => {
  const fake = fakeModels({ model: "openai-codex/gpt-6-astra", signedIn: ["openai-codex"], lists: MODELS });
  const h = harness(120, 36, fake.control);
  void h.app.run();
  await delay(5);
  h.emit({ type: "error", message: "ChatGPT doesn't offer gpt-6-astra to this sign-in (HTTP 404); choose another model.", kind: "model", provider: "openai-codex" });
  assert.ok(has(h.screen(), "Choose another model?"));
  await h.type("\r");
  await delay(10);
  assert.ok(has(h.screen(), "Choose a model"));
  await h.app.close();
});

test("with no model chosen, Kumi starts with a signed-in provider's first one and says so; signed in nowhere, it shows where to sign in", async () => {
  const signed = fakeModels({ signedIn: ["openai-codex"], lists: MODELS });
  const h = harness(120, 36, signed.control);
  void h.app.run();
  await delay(10);
  assert.ok(has(h.screen(), "Kumi talks to GPT-6 Astra, ChatGPT's first choice. /model changes it."));
  await h.app.close();
  const none = fakeModels({ lists: MODELS });
  const fresh = harness(120, 36, none.control);
  void fresh.app.run();
  await delay(10);
  const lines = fresh.screen();
  assert.ok(has(lines, "Sign in to a provider to talk to its models"));
  assert.ok(has(lines, "Choose a model") && has(lines, "Sign in to ChatGPT") && has(lines, "with your ChatGPT plan"));
  assert.match(lines[0]!, /no model chosen/);
  await fresh.app.close();
});

test("a command typed while a list is open runs: the list Kumi opens at the start gives way to the input box on \"/\"", async () => {
  const none = fakeModels({ lists: MODELS });
  const h = harness(120, 36, none.control);
  void h.app.run();
  await delay(10);
  assert.ok(has(h.screen(), "Choose a model"));
  await h.type("/");
  let lines = h.screen();
  assert.ok(!has(lines, "Choose a model"), "the list closes");
  assert.ok(has(lines, "Forget this conversation and start fresh") && lines.some((line) => line.trim() === "/help"), "the command menu opens");
  await h.type("help\r");
  await delay(5);
  lines = h.screen();
  assert.ok(has(lines, "enter sends · ctrl+j or alt+enter starts a new line"), lines.join("\n"));
  // A filter that's begun keeps its "/": model names have them.
  await h.type("/model\r");
  await delay(10);
  await h.type("gpt-6/");
  assert.ok(has(h.screen(), "filter: gpt-6/"));
  await h.app.close();
});

test("signing in to ChatGPT from Kumi shows the link to open, copies it on c, and can be cancelled", async () => {
  const fake = fakeModels({ lists: MODELS });
  const h = harness(120, 36, fake.control);
  void h.app.run();
  await delay(10);
  await h.type("\r");
  await delay(5);
  let lines = h.screen();
  assert.ok(has(lines, "Sign in to ChatGPT") && has(lines, "https://auth.example.test/oauth/authorize") && has(lines, "Waiting for the browser…"));
  assert.deepEqual(h.browsed, ["https://auth.example.test/oauth/authorize?client=kumi&state=fixture"]);
  assert.ok(has(lines, "c copies the link · esc to cancel"));
  await h.type("c");
  assert.ok(h.written.includes(`\u001b]52;c;${Buffer.from("https://auth.example.test/oauth/authorize?client=kumi&state=fixture").toString("base64")}\u0007`));
  assert.ok(has(h.screen(), "Copied the sign-in link."));
  fake.finishChatGPT();
  await delay(10);
  lines = h.screen();
  assert.ok(has(lines, "Signed in to ChatGPT."));
  assert.ok(lines.some((line) => line.includes("GPT-6 Astra") && line.includes("current")), "then its models, the first one chosen");
  await h.type("\u001b");
  await h.type("/login\r");
  await delay(5);
  await h.type("\r");
  await delay(5);
  assert.ok(has(h.screen(), "Waiting for the browser…"));
  await h.type("\u001b");
  await delay(5);
  lines = h.screen();
  assert.ok(!has(lines, "Waiting for the browser…") && !has(lines, "didn't finish"), "cancelling is quiet");
  await h.app.close();
});

test("/effort offers the levels the model takes, with its own default first; /logout asks before signing out", async () => {
  const fake = fakeModels({ model: "openai-codex/gpt-6-astra", signedIn: ["openai-codex"], lists: MODELS });
  const h = harness(120, 36, fake.control);
  void h.app.run();
  await delay(5);
  await h.type("/effort\r");
  await delay(10);
  let lines = panelLines(h.screen());
  assert.ok(has(lines, "How hard GPT-6 Astra thinks · lower answers sooner"));
  assert.ok(lines.some((line) => line.includes("Default (medium)") && line.includes("current")));
  assert.ok(lines.some((line) => /^\s+xhigh\s+More thorough still/.test(line)));
  await h.type("\u001b[B\r");
  await delay(5);
  assert.ok(fake.calls.includes("effort:low"));
  lines = h.screen();
  assert.ok(has(lines, "GPT-6 Astra thinks at low effort from your next message."));
  assert.match(lines[0]!, /GPT-6 Astra · low +● /);
  await h.type("/logout\r");
  await delay(5);
  assert.ok(has(h.screen(), "Sign out of") && has(h.screen(), "Your ChatGPT sign-in"));
  await h.type("\r");
  assert.ok(has(h.screen(), "Sign out of ChatGPT?"));
  await h.type("\r");
  await delay(5);
  assert.ok(fake.calls.includes("signout:openai-codex"));
  assert.ok(has(h.screen(), "Signed out of ChatGPT."));
  await h.app.close();
});

test("NOW follows a plan: writing it, then each change as it lands while the rest is written, with a count", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("build me a pad\r");
  h.emit({ type: "state", state: "running" });
  let lines = h.screen();
  assert.ok(has(lines, "thinking"));
  h.emit({ type: "tool-input", id: "p1", name: "make_changes" });
  assert.ok(has(h.screen(), "writing the plan"));
  h.emit({ type: "tool-start", id: "p1", name: "make_changes" });
  lines = h.screen();
  assert.ok(has(lines, "making changes") && !has(lines, "writing the plan"));
  h.emit({ type: "change", change: { id: "c1", family: "structure", title: "Added track Pad", state: "applied", at: 1 } });
  lines = h.screen();
  assert.ok(has(lines, "✓ Added track Pad"), "each change shows as it lands, though the plan is still running");
  assert.ok(has(lines, "working · 1 change"));
  h.emit({ type: "change", change: { id: "c2", family: "device", title: "Loaded Wavetable on Pad", state: "applied", at: 2 } });
  lines = h.screen();
  assert.ok(has(lines, "✓ Loaded Wavetable on Pad") && has(lines, "working · 2 changes"));
  h.emit({ type: "tool-end", id: "p1", name: "make_changes", isError: false, elapsedMs: 2400 });
  h.emit({ type: "turn-complete", result: { stopReason: "completed" }, elapsedMs: 5200 });
  h.emit({ type: "state", state: "idle" });
  lines = h.screen();
  assert.ok(!has(lines, "working ·"), "the count is for the answer under way");
  await h.app.close();
});

// ---- latency budgets, counted rather than timed (see packages/runtime/test/latency-budgets.test.ts)

test("budget: a burst of streamed text is one frame, and a token in a long conversation lays out only its own answer", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  for (let index = 0; index < 1_000; index++) {
    h.emit({ type: "notice", message: `earlier note ${index}` });
    h.app.handleEvent({ type: "notice", message: `and another ${index}` });
  }
  await h.type("go\r");
  h.emit({ type: "state", state: "running" });
  h.screen();
  const frames = () => h.written.split("\u001b[?2026h").length - 1;
  const before = frames();
  for (let index = 0; index < 200; index++) h.emit({ type: "text", text: `word${index} ` });
  h.screen();
  assert.equal(frames() - before, 1, "200 tokens arriving together are drawn once");
  const transcript = (h.app as unknown as { transcript: { laidOut: number } }).transcript;
  const laidOut = transcript.laidOut;
  h.emit({ type: "text", text: "one more" });
  h.screen();
  assert.equal(transcript.laidOut - laidOut, 1, "of 2,000 entries, only the answer being written is laid out again");
  await h.app.close();
});


// ---- memory

test("a note Kumi keeps is one quiet line, and its call isn't a step", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("the reese is my main bass\r");
  h.emit({ type: "state", state: "running" });
  h.emit({ type: "text", text: "Got it." });
  h.emit({ type: "tool-start", id: "m1", name: "remember" });
  h.emit({ type: "remembered", scope: "set", note: { id: "s1", text: "The Reese is the main bass", at: 1 } });
  h.emit({ type: "tool-end", id: "m1", name: "remember", isError: false, elapsedMs: 3 });
  h.emit({ type: "turn-complete", result: { stopReason: "completed" }, elapsedMs: 900 });
  h.emit({ type: "state", state: "idle" });
  h.emit({ type: "remembered", scope: "producer", note: { id: "p1", text: "Prefers short reverbs", at: 2 } });
  h.emit({ type: "remembered", scope: "producer", note: { id: "p1", text: "Prefers short, dark reverbs", at: 3 }, replaced: { id: "p1", text: "Prefers short reverbs", at: 2 } });
  h.emit({ type: "forgot", scope: "set", note: { id: "s1", text: "The Reese is the main bass", at: 1 } });
  const lines = h.screen();
  assert.ok(has(lines, "✎ Noted about Night Drive: The Reese is the main bass"));
  assert.ok(has(lines, "✎ Noted about you: Prefers short reverbs"));
  assert.ok(has(lines, "✎ Updated a note about you: Prefers short, dark reverbs"));
  assert.ok(has(lines, "✎ Forgot: The Reese is the main bass"));
  assert.ok(!has(lines, "step"), "keeping a note isn't a step");
  await h.app.close();
});

test("/memory shows what Kumi remembers, about you and this Set, and forgets a note when asked", async () => {
  const memory = { producer: [{ id: "p1", text: "Prefers short, dark reverbs", at: Date.now() - 3_600_000 }], set: [{ id: "s1", text: "The Reese is the main bass", at: Date.now() - 60_000 }] };
  const forgotten: string[] = [];
  const h = harness(120, 36, undefined, {
    async memory() { return { ...memory, setName: "Night Drive", saved: true }; },
    async forget(id) { forgotten.push(id); const note = [...memory.producer, ...memory.set].find((item) => item.id === id); memory.set = memory.set.filter((item) => item.id !== id); return note; },
  });
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("/memory\r");
  await delay(10);
  let lines = h.screen();
  assert.ok(has(lines, "What Kumi remembers"));
  assert.ok(has(lines, "About you") && has(lines, "Prefers short, dark reverbs") && has(lines, "About Night Drive") && has(lines, "The Reese is the main bass"));
  await h.type("\u001b[B\r");
  await delay(5);
  lines = h.screen();
  assert.ok(has(lines, "Forget this note?") && has(lines, "The Reese is the main bass"));
  await h.type("\r");
  await delay(10);
  assert.deepEqual(forgotten, ["s1"]);
  assert.ok(!has(h.screen(), "Forget this note?"));
  await h.app.close();
});

test("/stop stops Live any time, even while Kumi answers, and NOW shows it", async () => {
  let stops = 0; let works = true;
  const h = harness(120, 36, undefined, { async stopLive() { stops++; if (works) h.emit({ type: "action", title: "Stopped", playing: false, recording: false }); return works; } });
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "state", state: "running" });
  await h.type("/stop\r");
  await delay(10);
  assert.equal(stops, 1, "not refused as busy");
  assert.ok(has(h.screen(), "■ Stopped"));
  assert.ok(h.calls.includes("cancel"), "the answer in progress stops too, so its later steps can't start Live again");
  h.emit({ type: "state", state: "idle" });
  works = false;
  await h.type("/stop\r");
  await delay(10);
  assert.ok(has(h.screen(), "press space in Live"), "a stop that didn't work says what to do");
  h.emit({ type: "connection", state: "disconnected" });
  await h.type("/stop\r");
  await delay(10);
  assert.equal(stops, 2, "nothing to stop without Live");
  await h.app.close();
});

test("between \"watch me\" and \"done\", NOW says Kumi is watching", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "watching", on: true });
  await delay(5);
  assert.ok(has(h.screen(), "Watching your changes in Live"));
  h.emit({ type: "watching", on: false });
  await delay(5);
  const lines = h.screen();
  assert.ok(!has(lines, "Watching your changes") && has(lines, "Ready"));
  await h.app.close();
});

// ---- listening and recipes

test("what Kumi heard during an answer goes above the answer, which says what it means", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("compare these\r");
  h.emit({ type: "state", state: "running" });
  h.emit({ type: "text", text: "Your mix is darker than the reference." });
  h.emit({ type: "heard", file: "mix.wav", summary: "−12.1 LUFS", bands: [-8, -5, -7, -6, -10, -12, -15, -17, -19, -22],
    compared: { reference: "ref.wav", summary: "−8.4 LUFS", differences: [0.2, 0.4, -0.3, 2.8, 0, -1.1, -2, -1.5, -0.8, 0.5], headlines: [] } });
  await delay(10);
  const lines = h.screen();
  const heard = lines.findIndex((line) => line.includes("Heard mix.wav"));
  const answer = lines.findIndex((line) => line.includes("Your mix is darker"));
  assert.ok(heard >= 0 && answer >= 0, lines.join("\n"));
  assert.ok(heard < answer, "heard first, then the answer");
  await h.app.close();
});

test("what Kumi heard shows as a small spectrum, and a comparison as dB over or under the reference", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "heard", file: "ref.wav", summary: "−8.4 LUFS · 128 BPM · F minor", bands: [-8, -5, -7, -9, -10, -12, -13, -16, -18, -22] });
  h.emit({ type: "heard", file: "mix.wav", summary: "−12.1 LUFS", bands: [-8, -5, -7, -6, -10, -12, -15, -17, -19, -22],
    compared: { reference: "ref.wav", summary: "−8.4 LUFS", differences: [0.2, 0.4, -0.3, 2.8, 0, -1.1, -2, -1.5, -0.8, 0.5], headlines: ["low mids +2.8 dB"] } });
  const lines = h.screen();
  assert.ok(has(lines, "Heard ref.wav · −8.4 LUFS · 128 BPM · F minor"));
  // 4 dB a step below the loudest band: the bass is full height, the air 17 dB down is under half.
  assert.ok(lines.some((line) => /████/.test(line) && /▄▄▄▄/.test(line)), "a spectrum of bars");
  assert.ok(has(lines, "Heard mix.wav against ref.wav, loudness matched"));
  assert.ok(lines.some((line) => line.includes("+2.8") && line.includes("−2.0")), "signed differences per band");
  assert.ok(lines.filter((line) => line.includes("l.mid") && line.includes("air")).length === 2, "the bands, low to high");
  await h.app.close();
});

test("a match run shows as it works: a line per audition round, its score and time in NOW, how it ended, and the audition in HISTORY", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("make my pad sound like this reference\r");
  h.emit({ type: "state", state: "running" });
  h.emit({ type: "match", state: "running", check: 0, elapsedMs: 5_000, roundsLeft: 12 });
  h.emit({ type: "auditioned", round: 1, best: { label: "Collision", score: 58 }, takes: [{ label: "Collision", score: 58 }, { label: "Operator", score: 41 }, { label: "Drift", silent: true }], gaps: ["attack too slow (40 ms against 5 ms)", "air (10000–20k Hz) −6.0 dB against the reference"] });
  h.emit({ type: "change", change: { id: "a1", family: "clip", title: "Auditioned 3 candidates · best Collision", state: "heard", score: 58, at: 1 } });
  h.emit({ type: "auditioned", round: 2, best: { label: "Collision", score: 71 }, previous: 58, takes: [{ label: "Collision", score: 71 }], gaps: ["darker overall (−1.2 dB/octave)"] });
  h.emit({ type: "match", state: "running", check: 2, first: 58, best: { label: "Collision", score: 71 }, elapsedMs: 125_000, roundsLeft: 10 });
  await delay(10);
  let lines = h.screen();
  assert.ok(has(lines, "Round 1 · 58% · attack too slow, air (10000–20k Hz) −6.0 dB"), lines.join("\n"));
  assert.ok(has(lines, "Collision 58 · Operator 41 · Drift silent"), "each candidate's score, quietly");
  assert.ok(has(lines, "Round 2 · 58% → 71% · darker overall"));
  assert.ok(has(lines, "matching · 58→71% · 2:05"), "NOW: the score from where it started, and the time");
  assert.ok(has(lines, "♪ Auditioned 3 candidates"), "NOW: heard, not changed");
  assert.ok(lines.some((line) => line.includes("♪ Auditioned 3 candidates · best") && line.includes("58%")), "HISTORY: one quiet line, its score where an undo would be");
  h.emit({ type: "match", state: "done", check: 3, first: 58, best: { label: "Collision", score: 76 }, elapsedMs: 250_000, roundsLeft: 9, stop: "plateau" });
  h.emit({ type: "turn-complete", result: { stopReason: "completed" }, elapsedMs: 250_000 });
  h.emit({ type: "state", state: "idle" });
  await delay(10);
  lines = h.screen();
  assert.ok(has(lines, "Matching: 58% → 76% (Collision) · 4:10 · no more gain"));
  assert.ok(!has(lines, "matching ·"), "NOW lets go of it");
  await h.app.close();
});

test("/goal starts a goal and shows its dashboard in the GOAL tab: what it's after, its generations, the best with a sparkline, the leader, what was tried; /goal stop ends it", async () => {
  const goals: (string | undefined)[] = []; let stopped = 0;
  const h = harness(140, 40, undefined, { async goal(text) { goals.push(text); }, async stopGoal() { stopped++; return true; } });
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("/goal make my pad sound like ~/ref.wav\r");
  assert.deepEqual(goals, ["make my pad sound like ~/ref.wav"]);
  h.emit({ type: "state", state: "running" });
  h.emit({ type: "goal", state: "running", goal: "make my pad sound like ~/ref.wav", generation: 12, rendered: 36, trend: [58, 58, 61, 64, 64, 70, 71, 71, 74, 76, 76, 81], first: 58,
    best: { label: "Collision", score: 81 }, leader: "Collision · Collision → Delay → Limiter", idea: "Tried a Collision with parallel delays.", elapsedMs: 185_000, candidates: 3 });
  await delay(10);
  let lines = h.screen();
  assert.ok(has(lines, "GOAL"), lines.join("\n"));
  assert.ok(has(lines, "searching · gen 12 · 36 heard · 3") && has(lines, "candidates · 3:05"), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("81% from 58%") && /▁.*█/.test(line)), "the best, where it started, and its trend");
  assert.ok(has(lines, "best  Collision · Collision → Delay →"));
  assert.ok(has(lines, "tried  Tried a Collision with parallel"));
  assert.ok(has(lines, "goal · 81% · gen 12 · 3:05"), "NOW's one line");
  await h.type("/goal stop\r");
  assert.equal(stopped, 1);
  h.emit({ type: "goal", state: "done", goal: "make my pad sound like ~/ref.wav", generation: 13, rendered: 39, trend: [58, 81], first: 58, best: { label: "Collision", score: 81 }, elapsedMs: 200_000, candidates: 3, bestTrack: "Kumi · Goal best", why: "stopped" });
  h.emit({ type: "state", state: "idle" });
  await delay(10);
  lines = h.screen();
  assert.ok(has(lines, "done · stopped · gen 13"));
  assert.ok(has(lines, "kept on  Kumi · Goal best"));
  assert.ok(!has(lines, "goal · 81%"), "NOW lets go of it");
  await h.app.close();
});

test("a video Kumi watched goes above the answer: its title, where its words came from, and the frames it looked at as small pictures; NOW says what it's doing meanwhile", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("watch this tutorial\r");
  h.emit({ type: "state", state: "running" });
  h.emit({ type: "tool-start", id: "w1", name: "watch_video" });
  h.emit({ type: "doing", text: "transcribing what's said · 40%" });
  assert.ok(has(h.screen(), "transcribing what's said · 40%"), "NOW says what it's doing");
  h.emit({ type: "text", text: "It builds a Reese bass." });
  const thumb = { width: 32, height: 18, rgb: new Uint8Array(32 * 18 * 3).fill(120) };
  h.emit({ type: "watched", title: "1 Minute Reese With Operator", channel: "Au5", url: "https://www.youtube.com/watch?v=W87uuuGcq9c", duration: 81, from: 0, to: 81,
    chapters: [], words: "transcribed", lines: 6, frames: [5, 15, 25, 35, 45].map((at) => ({ at, thumb })), notes: ["private-token leaked into a note"] });
  h.emit({ type: "tool-end", id: "w1", name: "watch_video", isError: false, elapsedMs: 1200 });
  await delay(5);
  const lines = h.screen();
  const watched = lines.findIndex((line) => line.includes("Watched “1 Minute Reese With Operator” · Au5 · 1:21"));
  const answer = lines.findIndex((line) => line.includes("It builds a Reese bass."));
  assert.ok(watched >= 0 && answer > watched, lines.join("\n"));
  assert.ok(has(lines, "the whole video · its speech, transcribed by Kumi"));
  assert.ok(lines.some((line) => /▀{10}/.test(line)), "small pictures");
  assert.ok(lines.some((line) => line.includes("0:05") && line.includes("0:15")), "their times");
  assert.ok(!lines.some((line) => line.includes("private-token")), "names and notes are shown safely");
  assert.ok(!has(lines, "transcribing what's said · 40%"), "NOW moves on once the tool ends");
  await h.app.close();
});

test("what Kumi looked up goes above the answer, a quiet line for each search and page, grouped; a page's title is shown safely", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("make me a reverb like the erbe-verb\r");
  h.emit({ type: "state", state: "running" });
  h.emit({ type: "tool-start", id: "s1", name: "search_web" });
  h.emit({ type: "doing", text: "searching the web for “erbe-verb design”" });
  assert.ok(has(h.screen(), "searching the web for “erbe-verb"), "NOW says what it's looking for (as much as fits)");
  h.emit({ type: "web", action: "searched", title: "erbe-verb design", where: "web", via: "Exa", results: 8 });
  h.emit({ type: "tool-end", id: "s1", name: "search_web", isError: false, elapsedMs: 900 });
  h.emit({ type: "web", action: "read", title: "Building the Erbe-Verb private-token", url: "https://forum.audulus.com/uploads/erbe.pdf", kind: "a PDF", via: "Exa" });
  h.emit({ type: "web", action: "read", title: "Afturmath/dm-Erbeverb", url: "https://github.com/Afturmath/dm-Erbeverb", kind: "a GitHub repository", files: 29 });
  h.emit({ type: "text", text: "It's a four-delay FDN reverb." });
  await delay(5);
  const lines = h.screen();
  const searched = lines.findIndex((line) => line.includes("Searched the web for “erbe-verb design” · 8 results"));
  const pdf = lines.findIndex((line) => line.includes("Read “Building the Erbe-Verb") && line.includes("· forum.audulus.com · a PDF"));
  const repo = lines.findIndex((line) => line.includes("Read “Afturmath/dm-Erbeverb” · github.com · a GitHub repository · 29 files"));
  const answer = lines.findIndex((line) => line.includes("It's a four-delay FDN reverb."));
  assert.ok(searched >= 0 && pdf === searched + 1 && repo === pdf + 1 && answer > repo, lines.join("\n"));
  assert.ok(!lines.some((line) => line.includes("private-token")), "a page's words are shown safely");
  await h.app.close();
});

test("/recipes lists saved ways of working; one without blanks runs straight away, one with blanks asks what to run it on", async () => {
  const ran: string[] = []; const forgotten: string[] = [];
  const recipes = [
    { name: "Drum bus", about: "Glue, saturation and a short room on a new return", params: [], steps: 3, used: 2, lastUsed: Date.now() - 86_400_000, created: 1 },
    { name: "Resample twice", about: "OTT and Saturator, then Grain Delay", params: [{ name: "track", about: "the track to resample" }], steps: 6, used: 0, created: 2 },
  ];
  const h = harness(120, 36, undefined, {
    async recipes() { return recipes; },
    async runRecipe(name) { ran.push(name); return { text: "Done:\n- Added return track “Drum Bus”", isError: false }; },
    async forgetRecipe(name) { forgotten.push(name); return true; },
  });
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("/recipes\r");
  await delay(10);
  let lines = h.screen();
  assert.ok(has(lines, "Your recipes") && has(lines, "Drum bus") && has(lines, "Resample twice") && has(lines, "used 1 day ago"));
  await h.type("\r");
  await delay(5);
  assert.ok(has(h.screen(), "Run it now"));
  await h.type("\r");
  await delay(10);
  assert.deepEqual(ran, ["Drum bus"], "no blanks: it runs with no model reply");
  assert.ok(has(h.screen(), "Added return track “Drum Bus”"));
  await h.type("/recipes\r");
  await delay(10);
  await h.type("\u001b[B\r");
  await delay(5);
  lines = h.screen();
  assert.ok(has(lines, "Run it on…") && has(lines, "Kumi needs: the track to resample"));
  await h.type("\r");
  await delay(5);
  assert.ok(has(h.screen(), "Run my recipe “Resample twice” on"), "the box says it, for the producer to finish");
  h.emit({ type: "recipe", action: "saved", name: "Vocal chain", steps: 4 });
  assert.ok(has(h.screen(), "↻ Saved a recipe: Vocal chain (4 steps)"));
  await h.app.close();
});

test("↑ and ↓ go back through what was sent, across /new and restarts, with secrets kept out of the history file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kumi-history-"));
  const file = join(directory, "input-history");
  try {
    const h = harness(120, 36, undefined, {}, openInputHistory(file, ["private-token"]));
    void h.app.run();
    await delay(5);
    connect(h);
    await h.type("make the bass wider\r");
    await h.type("/new\r");
    await h.type("use my key sk-ant-api03-Abcdefghijklmnopqrstuvwxyz0123456789 and private-token\r");
    await h.type("half-typed");
    // The input box is the last rows of the screen.
    const box = () => h.screen().slice(-4).join("\n");
    await h.type("\u001b[A");
    assert.match(box(), /use my key \[redacted\] and \[redacted\]/, "a pasted key and a known secret come back redacted");
    await h.type("\u001b[A");
    assert.match(box(), /\/new/);
    await h.type("\u001b[A");
    assert.match(box(), /make the bass wider/, "a recalled command didn't open the / menu");
    await h.type("\u001b[A");
    assert.match(box(), /make the bass wider/, "the oldest stays");
    await h.type("\u001b[B");
    assert.match(box(), /\/new/);
    await h.type("\u001b[B\u001b[B");
    assert.match(box(), /half-typed/, "past the newest, what was being typed");
    await h.app.close();
    const saved = readFileSync(file, "utf8");
    assert.ok(!saved.includes("sk-ant") && !saved.includes("private-token"), "the file never holds a secret");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(openInputHistory(file).entries, ["make the bass wider", "/new", "use my key [redacted] and [redacted]"], "a restart has it all");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("/new keeps what's above on screen under a line, and the bridge (HISTORY's undo stays)", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("make the bass wider\r");
  h.emit({ type: "change", change: { id: "c1", family: "mixer", title: "Bass width 100% → 140%", state: "applied", at: Date.now() } });
  await h.type("/new\r");
  const lines = h.screen();
  assert.ok(h.calls.includes("new"));
  assert.ok(has(lines, "make the bass wider"), "the old conversation stays on screen");
  assert.ok(has(lines, "New conversation. Kumi won't use what's above"));
  assert.ok(lines.some((line) => line.includes("Bass width") && line.includes("undo")), "its changes can still be undone");
  await h.app.close();
});

test("/conversations lists the Set's kept conversations and goes back to one, with its HISTORY", async () => {
  const resumed: string[] = [];
  const h = harness(120, 36, undefined, {
    async conversations() { return [{ id: "now001", savedAt: Date.now(), first: "add a hi-hat groove", turns: 2, current: true }, { id: "old001", savedAt: Date.now() - 2 * 3600_000, first: "make the bass wider", turns: 5, current: false }]; },
    async resumeConversation(id) { resumed.push(id); return true; },
  });
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("/conversations\r");
  let lines = h.screen();
  assert.ok(has(lines, "Conversations about Night Drive"));
  assert.ok(lines.some((line) => line.includes("add a hi-hat groove") && line.includes("this one · 2 requests")));
  assert.ok(lines.some((line) => line.includes("make the bass wider") && line.includes("2 hours ago · 5 requests")));
  await h.type("\u001b[B\r");
  assert.deepEqual(resumed, ["old001"]);
  h.emit({ type: "resumed", savedAt: Date.now() - 2 * 3600_000, chosen: true, lines: [{ role: "user", text: "make the bass wider" }, { role: "assistant", text: "Widened it to 140%." }],
    changes: [{ id: "old001:c4", family: "mixer", title: "Bass width 100% → 140%", state: "expired", note: "From an earlier session, so Kumi can't undo it now.", at: 1 }] });
  lines = h.screen();
  assert.ok(has(lines, "Back to your conversation from 2 hours ago"));
  assert.ok(has(lines, "Widened it to 140%."));
  assert.ok(lines.some((line) => line.includes("Bass width") && line.includes("no undo")), "its HISTORY is back, without undo");
  await h.app.close();
});

test("when Live is back after stopping a request, it's in the box, one enter from sent again", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "notice", message: "Live is back. Your last request was stopped; press enter to send it again." });
  h.emit({ type: "resend", text: "record the chorus into a new track" });
  const lines = h.screen();
  assert.ok(has(lines, "press enter to send it again"));
  assert.ok(has(lines, "record the chorus into a new track"));
  await h.type("\r");
  assert.ok(h.calls.includes("submit:record the chorus into a new track"));
  await h.app.close();
});

test("every memory save is a line of its own kind, a moment in NOW, and a MEMORY row with its forget", async () => {
  const forgotten: string[] = [];
  const h = harness(120, 36, undefined, {
    async forgetTechnique(id) { forgotten.push(`technique:${id}`); h.emit({ type: "technique", action: "forgot", technique: { id, name: "Neuro from a Reese", fits: "gritty neuro basses" } }); return true; },
    async forget(id) { forgotten.push(`note:${id}`); return undefined; },
    async forgetRecipe(name) { forgotten.push(`recipe:${name}`); return true; },
  });
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "technique", action: "kept", technique: { id: "t1", name: "Neuro from a Reese", fits: "gritty neuro basses", source: "Au5 · Neuro bass" } });
  let lines = h.screen();
  assert.ok(has(lines, "◆ Kept a technique: Neuro from a Reese"), "a line in the conversation");
  const now = lines.findIndex((line) => line.includes("NOW"));
  assert.ok(lines[now + 1]!.includes("◆ Kept a technique: Neuro"), "and NOW shows it for a moment");
  h.emit({ type: "remembered", scope: "producer", note: { id: "p1", text: "Prefers short reverbs", at: 1 } });
  h.emit({ type: "recipe", action: "saved", name: "Drum bus", steps: 3 });
  lines = h.screen();
  assert.ok(has(lines, "✎ Noted about you: Prefers short reverbs") && has(lines, "↻ Saved a recipe: Drum bus (3 steps)"));
  // What Kumi kept comes first in the HISTORY tab, right under its strip.
  const memory = lines.findIndex((line) => /HISTORY[^─]*─{3,}/.test(line));
  assert.ok(memory > 0, "the tab strip sits in the pane");
  assert.ok(lines[memory + 1]!.includes("↻ Drum bus") && lines[memory + 1]!.includes("forget"), "newest first, each with its forget");
  assert.ok(lines[memory + 2]!.includes("✎ Prefers short reverbs"));
  assert.ok(lines[memory + 3]!.includes("◆ Neuro from a Reese"));
  await h.type(click(lines, memory + 3, "forget"));
  await delay(5);
  assert.deepEqual(forgotten, ["technique:t1"]);
  lines = h.screen();
  assert.ok(lines[memory + 3]!.includes("forgotten"), "the row says so");
  assert.ok(has(lines, "◆ Forgot the technique: Neuro from a Reese"));
  // A note that was already gone says so.
  await h.type(click(lines, memory + 2, "forget"));
  await delay(5);
  assert.ok(has(h.screen(), "That was already gone."));
  h.emit({ type: "technique", action: "used", technique: { id: "t2", name: "Parallel drum crush", fits: "punchy drums" } });
  assert.ok(has(h.screen(), "◆ Using your technique: Parallel drum crush"), "using one says so, without a MEMORY row");
  await h.app.close();
});

test("/memory lists notes, techniques and recipes; choosing a technique offers to forget it", async () => {
  const forgotten: string[] = [];
  const h = harness(120, 36, undefined, {
    async memory() { return { producer: [{ id: "p1", text: "Prefers short reverbs", at: Date.now() }], set: [], saved: true, setName: "Night Drive" }; },
    async techniques() { return [{ id: "t1", name: "Neuro from a Reese", fits: "gritty, moving neuro basses", source: "Au5 · Neuro bass" }]; },
    async forgetTechnique(id) { forgotten.push(id); return true; },
    async recipes() { return [{ name: "Drum bus", about: "a return with glue compression", params: [], steps: 3, used: 0, created: 1 }]; },
  });
  void h.app.run();
  await delay(5);
  connect(h);
  await h.type("/memory\r");
  let lines = h.screen();
  for (const text of ["What Kumi remembers · notes, techniques and recipes", "About you", "Prefers short reverbs", "Techniques", "Neuro from a Reese", "Recipes", "Drum bus"]) assert.ok(has(lines, text), text);
  await h.type("techn");
  await h.type("\r");
  lines = h.screen();
  assert.ok(has(lines, "Forget this technique?"));
  await h.type("\r");
  await delay(5);
  assert.deepEqual(forgotten, ["t1"]);
  await h.app.close();
});

test("/status says the tokens this session's answers took on an API key, and nothing about them on a ChatGPT plan", async () => {
  const keyed = harness(240, 36, fakeModels({ model: "anthropic/claude-sonnet-5-5", signedIn: ["anthropic"], lists: MODELS }).control);
  void keyed.app.run();
  await delay(10);
  keyed.emit({ type: "turn-complete", result: { stopReason: "completed", usage: { inputTokens: 9_000, outputTokens: 700, cacheReadTokens: 6_000, cacheWriteTokens: 0 } }, elapsedMs: 900 });
  keyed.emit({ type: "turn-complete", result: { stopReason: "completed", usage: { inputTokens: 4_500, outputTokens: 520, cacheReadTokens: 2_000, cacheWriteTokens: 0 } }, elapsedMs: 900 });
  await keyed.type("/status\r");
  assert.ok(has(keyed.screen(), "this session: 13.5k tokens in (8.0k cached), 1.2k out"));
  await keyed.app.close();
  const plan = harness(160, 36, fakeModels({ model: "openai-codex/gpt-6-astra", signedIn: ["openai-codex"], lists: MODELS }).control);
  void plan.app.run();
  await delay(10);
  plan.emit({ type: "turn-complete", result: { stopReason: "completed", usage: { inputTokens: 9_000, outputTokens: 700, cacheReadTokens: 0, cacheWriteTokens: 0 } }, elapsedMs: 900 });
  await plan.type("/status\r");
  assert.ok(!plan.screen().join("\n").includes("tokens in"));
  await plan.app.close();
});

test("FOCUS's Device view draws the track's devices as a tree; a row pointed at by mouse or keyboard goes with the next message", async () => {
  const fx = (ref: string, name: string) => ({ ref, name, className: name, deviceType: "audio_effect" as const });
  const tree = { trackRef: "3:track:3", devices: [fx("d0", "Chorus-Ensemble"), fx("d1", "Compressor"),
    { ref: "d2", name: "Audio Effect Rack", className: "AudioEffectGroupDevice", canHaveChains: true, chains: [
      { ref: "c0", name: "Chain 1", devices: [fx("d2a", "Saturator"), fx("d2b", "EQ Eight")] }, { ref: "c1", name: "Chain 2", devices: [fx("d2c", "Utility")] }] },
    fx("d3", "Gate")] };
  const reads: string[] = []; const sent: unknown[] = [];
  const h = harness(120, 40, undefined, {
    async deviceTree(ref) { reads.push(ref); return tree; },
    async submit(text, extra) { sent.push({ text, ...(extra ?? {}) }); },
  });
  void h.app.run();
  await delay(5);
  connect(h);
  const focus = { track: { name: "4-Audio", color: "#e2b93b", kind: "audio" as const }, trackRef: "3:track:3", device: "Saturator", chain: "Chain 1", detail: "Device" as const, view: "Session" as const };
  h.emit({ type: "focus", focus });
  await delay(5);
  let lines = h.screen();
  for (const row of ["FOCUS · Device", "■  4-Audio", "├ ≈  Chorus-Ensemble", "├ ▣  Audio Effect Rack", "│ ├ ○  Chain 1", "│ │ ├ ≈  Saturator", "│ │ └ ≈  EQ Eight", "│ └ ○  Chain 2 (1)", "└ ≈  Gate"]) assert.ok(has(lines, row), row);
  // The focus feed reads twice a second; the tree is read again only when the track, its selected device or chain changes (a chain renamed in Live).
  h.emit({ type: "focus", focus: { ...focus } });
  h.emit({ type: "focus", focus: { ...focus, device: "EQ Eight" } });
  await delay(5);
  h.emit({ type: "focus", focus: { ...focus, device: "EQ Eight", chain: "Blah" } });
  await delay(5);
  assert.equal(reads.length, 3);
  h.emit({ type: "focus", focus });
  await delay(5);
  // By mouse: the row is pointed at, and shown above the input box.
  lines = h.screen();
  const row = lines.findIndex((line) => line.includes("│ │ ├ ≈  Saturator"));
  await h.type(click(lines, row, "Saturator"));
  lines = h.screen();
  assert.ok(has(lines, "≈  Audio Effect Rack › Chain 1 › Saturator  ×"));
  // The pointed-at row says so quietly, instead of a second highlight.
  assert.ok(lines[row]!.includes("Saturator") && lines[row]!.trimEnd().endsWith("pinned"));
  await h.type("make it gentler\r");
  await delay(5);
  assert.deepEqual(sent.at(-1), { text: "make it gentler", pinned: { trackRef: "3:track:3", ref: "d2a", node: "device", name: "Saturator", trail: ["Audio Effect Rack", "Chain 1"], siblings: ["EQ Eight"], track: "4-Audio" } });
  // Esc clears it; × does too.
  await h.type("\u001b");
  await delay(30);
  assert.ok(!has(h.screen(), "Chain 1 › Saturator  ×"));
  // By keyboard: Tab moves into the tree at what's selected in Live, arrows move, Enter points.
  await h.type("\t");
  await h.type("\u001b[B");
  await h.type("\r");
  lines = h.screen();
  assert.ok(has(lines, "≈  Audio Effect Rack › Chain 1 › EQ Eight  ×"));
  await h.type("and brighter\r");
  await delay(5);
  assert.equal((sent.at(-1) as { pinned: { name: string } }).pinned.name, "EQ Eight");
  lines = h.screen();
  const clear = lines.findIndex((line) => line.includes("EQ Eight  ×"));
  await h.type(click(lines, clear, "×"));
  assert.ok(!has(h.screen(), "EQ Eight  ×"));
  await h.app.close();
});

test("in FOCUS's tree, Live's selection has a band under it and the accent; a pinned row isn't highlighted the same way", async () => {
  const tree = { trackRef: "3:track:3", devices: [{ ref: "a", name: "Saturator", className: "Saturator" }, { ref: "b", name: "Gate", className: "Gate" }] };
  const h = harness(120, 36, undefined, { async deviceTree() { return tree; } });
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "focus", focus: { track: { name: "4-Audio", kind: "audio" as const }, trackRef: "3:track:3", device: "Saturator", detail: "Device" as const } });
  await delay(5);
  const lines = h.screen();
  const written = h.written;
  // #1c1f24 (raised) under the selected row, #86e3b5 (accent) for its name.
  assert.match(written, /38;2;134;227;181;48;2;28;31;36mSaturator/);
  const gate = lines.findIndex((line) => line.includes("└ ◇  Gate"));
  await h.type(click(lines, gate, "Gate"));
  assert.ok(h.screen()[gate]!.trimEnd().endsWith("pinned"));
  await h.type(click(h.screen(), gate, "pinned"));
  assert.ok(!h.screen()[gate]!.includes("pinned"), "clicking pinned clears it");
  await h.app.close();
});

test("FOCUS's MIDI view draws the highlighted clip as a small piano roll, its selected notes standing out", async () => {
  const view = { slotRef: "3:clip_slot:2:0", name: "Chords", length: 4, notes: [
    { pitch: 60, start: 0, duration: 1, velocity: 90 }, { pitch: 64, start: 1, duration: 1, velocity: 90, selected: true }, { pitch: 67, start: 2, duration: 2, velocity: 90 }] };
  const reads: string[] = [];
  const h = harness(120, 36, undefined, { async clipView(ref) { reads.push(ref); return view; } });
  void h.app.run();
  await delay(5);
  connect(h);
  const focus = { track: { name: "Keys", color: "#5ec1f7", kind: "midi" as const }, slotRef: "3:clip_slot:2:0", clip: "Chords", detail: "Clip" as const, view: "Session" as const, selectedNotes: 1 };
  h.emit({ type: "focus", focus });
  await delay(5);
  const lines = h.screen();
  assert.ok(has(lines, "FOCUS · Clip")); assert.ok(has(lines, "■  Keys › ▬  Chords")); assert.ok(has(lines, "1 bar · 3 notes · 1 selected"));
  const roll = lines.filter((line) => /[⠁-⣿]/.test(line.slice(80)));
  assert.equal(roll.length >= 2, true, "a piano roll of braille rows");
  // Selected notes stand out in the accent, the rest are quiet.
  assert.match(h.written, /38;2;134;227;181;48;2;20;22;26m[⠀-⣿]/);
  // Read again when the selection changes, not on every focus report.
  h.emit({ type: "focus", focus: { ...focus } });
  h.emit({ type: "focus", focus: { ...focus, selectedNotes: 2 } });
  await delay(5);
  assert.deepEqual(reads, ["3:clip_slot:2:0", "3:clip_slot:2:0"]);
  await h.app.close();
});

test("FOCUS's Session strip shows the track's slots around the selected scene; the Arrangement strip, a timeline and where the playhead is", async () => {
  const session = { trackRef: "3:track:1", scene: 2, slots: [
    { index: 0, clip: { name: "Intro", audio: false } }, { index: 1, clip: { name: "Verse", audio: false }, playing: true },
    { index: 2, clip: { name: "Drop", audio: true }, queued: true }, { index: 3 }] };
  const arrangement = { length: 128, position: 64, playing: true, loop: { start: 64, length: 16, enabled: true }, locators: [{ name: "Verse", position: 32 }, { name: "Drop", position: 96 }] };
  const asked: string[] = [];
  const h = harness(120, 36, undefined, {
    async sessionStrip(trackRef, scene) { asked.push(`session ${trackRef} ${scene}`); return session; },
    async arrangementStrip() { asked.push("arrangement"); return arrangement; } });
  void h.app.run();
  await delay(5);
  connect(h);
  const focus = { track: { name: "Bass", color: "#f59a3c", kind: "midi" as const }, trackRef: "3:track:1", sceneIndex: 2, view: "Session" as const };
  h.emit({ type: "focus", focus });
  await delay(5);
  let lines = h.screen();
  for (const row of ["FOCUS · Session", "■  Bass", "1 ▬  Intro", "2 ▬  Verse", "3 ▬  Drop", "4 ·"]) assert.ok(has(lines, row), row);
  assert.ok(lines.find((line) => line.includes("Verse"))!.trimEnd().endsWith("playing"));
  assert.ok(lines.find((line) => line.includes("Drop"))!.trimEnd().endsWith("queued"));
  h.emit({ type: "focus", focus: { ...focus, view: "Arrangement" as const } });
  await delay(5);
  lines = h.screen();
  assert.ok(has(lines, "FOCUS · Arrangement"));
  assert.ok(lines.some((line) => /─+┼─+┃━+.*┼─+/.test(line)), "the loop, the locators and the playhead on one line");
  assert.ok(has(lines, "bar 17 · playing · after Verse")); assert.ok(has(lines, "loop 17–21 · 32 bars"));
  assert.deepEqual(asked, ["session 3:track:1 2", "arrangement"]);
  // A device or clip open in Live shows that instead.
  h.emit({ type: "focus", focus: { ...focus, view: "Arrangement" as const, detail: "Device" as const, device: "Operator" } });
  assert.ok(!has(h.screen(), "FOCUS · Arrangement") && !has(h.screen(), "FOCUS · Session"));
  await h.app.close();
});

test("FOCUS follows what the producer last touched in Live: a device, a Session clip, a scene, or the view", () => {
  const base = { track: { name: "Bass" }, view: "Session" as const, detail: "Device" as const, device: "Operator", sceneIndex: 0 };
  assert.equal(touchedNext(null, base, undefined), "device");
  assert.equal(touchedNext(base, { ...base, sceneIndex: 1 }, "device"), "session", "a scene");
  assert.equal(touchedNext({ ...base, sceneIndex: 1 }, { ...base, sceneIndex: 1, device: "Reverb" }, "session"), "device", "a device");
  assert.equal(touchedNext(base, { ...base, detail: "Clip", slotRef: "s" }, "device"), "clip", "a Session clip");
  assert.equal(touchedNext(base, { ...base, view: "Arrangement" }, "device"), "arrangement", "the Arrangement");
  assert.equal(touchedNext({ ...base, view: "Arrangement" }, { ...base, view: "Arrangement", detail: "Clip", slotRef: "s" }, "arrangement"), "arrangement", "an Arrangement clip");
  assert.equal(touchedNext(base, { ...base }, "session"), "session", "nothing changed: as it was");
});

test("where glyphs may not show (the old Windows console), FOCUS's tree draws two-letter badges instead", async () => {
  const tree = { trackRef: "3:track:3", devices: [{ ref: "a", name: "Saturator", className: "Saturator", deviceType: "audio_effect" as const }] };
  const h = harness(120, 36, undefined, { async deviceTree() { return tree; } });
  (h.app as unknown as { icons: string }).icons = "badges";
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "focus", focus: { track: { name: "4-Audio", kind: "audio" as const }, trackRef: "3:track:3", device: "Saturator", detail: "Device" as const } });
  await delay(5);
  const lines = h.screen();
  assert.ok(has(lines, "AT 4-Audio") && has(lines, "└ FX Saturator"));
  await h.app.close();
});

const changesFor = (count: number): ChangeRecord[] => Array.from({ length: count }, (_, index) => ({ id: `c${index + 1}`, family: "tempo" as const, title: `Tempo change ${index + 1}`, state: "applied" as const, at: index }));
const stripRow = (lines: string[]) => lines.findIndex((line) => /HISTORY[^─]*─{3,}/.test(line));

test("the right pane's lower half is the tabbed area, anchored to the bottom at every height; FOCUS gives way first", async () => {
  for (const rows of [24, 36, 50]) {
    const h = harness(120, rows);
    void h.app.run();
    await delay(5);
    connect(h);
    const lines = h.screen();
    const pane = rows - 1;
    const bottom = Math.min(Math.max(7, Math.floor(pane / 2)), pane - 8);
    assert.equal(stripRow(lines), 1 + pane - bottom, `strip at ${rows} rows`);
    assert.ok(lines.findIndex((line) => line.includes("NOW")) < stripRow(lines), "FOCUS and NOW above it");
    assert.ok(has(lines, "Nothing changed yet"));
    await h.app.close();
  }
});

test("HISTORY scrolls by wheel and by keyboard, says how much more at its ends, holds its place as rows arrive, and undo works where it's scrolled", async () => {
  const h = harness(120, 36);
  h.onUndo((id) => ({ ...changesFor(40).find((change) => change.id === id)!, state: "undone" }));
  void h.app.run();
  await delay(5);
  connect(h);
  for (const change of changesFor(40)) h.emit({ type: "change", change });
  await delay(4_100); // NOW's flash of the last change passes
  let lines = h.screen();
  const strip = stripRow(lines);
  assert.ok(lines[strip]!.includes("HISTORY 40"), "a dim count beside the title");
  assert.ok(lines[strip + 1]!.includes("Tempo change 40"), "newest first");
  assert.ok(lines.some((line) => /↓ \d+ more/.test(line)));
  // The wheel over it scrolls it (the conversation stays put).
  const x = lines[strip]!.indexOf("HISTORY") + 2;
  await h.type(`\u001b[<65;${x};${strip + 4}M`);
  lines = h.screen();
  assert.ok(lines[strip + 1]!.includes("↑ 4 more") && lines[strip + 2]!.includes("Tempo change 36"));
  // A new change arrives while scrolled: the view stays on the same rows.
  h.emit({ type: "change", change: { ...changesFor(41)[40]!, id: "c41" } });
  lines = h.screen();
  assert.ok(lines[strip + 2]!.includes("Tempo change 36"), "held in place");
  // Undo on a row where it's scrolled to.
  await h.type(click(lines, strip + 2, "undo"));
  await delay(5);
  assert.ok(h.calls.includes("undo:c36"));
  // By keyboard: Shift+Tab goes in, arrows move, Enter undoes the row, Esc goes back to typing.
  await h.type("\u001b[Z");
  await h.type("\u001b[B");
  await h.type("\r");
  await delay(5);
  assert.ok(h.calls.includes("undo:c35"), JSON.stringify(h.calls));
  await h.type("\u001b");
  await delay(30);
  await h.type("x");
  assert.ok(has(h.screen(), "x"), "typing goes to the input box again");
  await h.app.close();
});

test("tabs register as modules: a second one (a test stub) switches by click and by Shift+Tab, and the one showing is remembered", async () => {
  let saved: string | undefined;
  const store = { load: () => saved, save: (id: string) => { saved = id; } };
  const stub = { id: "stub", title: "STUB", rows: () => [{ spans: [{ text: "stub row", style: {} }] }] };
  const h = harness(120, 36, undefined, {}, undefined, { tabs: [stub], panelTab: store });
  void h.app.run();
  await delay(5);
  connect(h);
  let lines = h.screen();
  const strip = stripRow(lines);
  assert.ok(lines[strip]!.includes("HISTORY") && lines[strip]!.includes("STUB"));
  await h.type(click(lines, strip, "STUB"));
  lines = h.screen();
  assert.ok(lines[strip + 1]!.includes("stub row")); assert.equal(saved, "stub");
  await h.type("\u001b[Z"); await h.type("\u001b[Z");
  assert.ok(has(h.screen(), "Nothing changed yet"), "Shift+Tab again: the next tab"); assert.equal(saved, "history");
  await h.app.close();
  saved = "stub";
  const again = harness(120, 36, undefined, {}, undefined, { tabs: [stub], panelTab: store });
  void again.app.run();
  await delay(5);
  connect(again);
  assert.ok(again.screen()[strip + 1]!.includes("stub row"), "after a restart, the tab that showed");
  await again.app.close();
  // With one tab, the strip is a heading, and switching does nothing harmful.
  const one = harness(120, 36);
  void one.app.run();
  await delay(5);
  connect(one);
  lines = one.screen();
  await one.type(click(lines, stripRow(lines), "HISTORY"));
  await one.type("\u001b[Z"); await one.type("\u001b[Z");
  assert.ok(has(one.screen(), "Nothing changed yet"));
  await one.app.close();
});

test("right-clicking in Live (Ask Kumi about this) pins it above the input box, and it goes with the next message", async () => {
  const sent: unknown[] = [];
  const h = harness(120, 40, undefined, { async submit(text, extra) { sent.push({ text, ...(extra ?? {}) }); } });
  void h.app.run();
  await delay(5);
  connect(h);
  const pin = { trackRef: "3:track:0", ref: "3:arrangement_clip:0:0", node: "clip" as const, name: "Verse riff", trail: ["Bass"], siblings: [], live: true, track: "Bass" };
  h.emit({ type: "pointed", pin });
  await delay(5);
  assert.ok(has(h.screen(), "Bass › Verse riff  ×"));
  await h.type("double it\r");
  await delay(5);
  assert.deepEqual(sent.at(-1), { text: "double it", pinned: pin });
});
