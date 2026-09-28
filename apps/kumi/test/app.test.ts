import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import type { ChangeRecord, SessionController, SessionEvent, TurnState } from "@kumi/runtime";
import { chipColor, fitCrumbs, focusPath, setNameFrom, TuiApp } from "../src/tui/app.js";
import { Editor } from "../src/tui/editor.js";
import { RESTORE } from "../src/tui/tty.js";
import { VirtualTerminal } from "./vt.js";

const opened: TuiApp[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((app) => app.close())); });

function harness(columns = 120, rows = 36) {
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
  };
  let undoResult: ((id: string | undefined) => ChangeRecord | undefined) | undefined;
  const app = new TuiApp({ controller, input, output, model: "openai-codex/fixture", mode: "live", secrets: ["private-token"], colorDepth: "truecolor", frameMs: 1, closeTimeoutMs: 100 });
  opened.push(app);
  let vt = new VirtualTerminal(columns, rows);
  let consumed = 0;
  return {
    input, output, app, calls,
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
  assert.ok(h.written.endsWith(`${RESTORE}Kumi closed. This conversation wasn't saved.\n`), "the terminal is restored before the goodbye");
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
  assert.ok(has(lines, "│ … looked at your Set"));
  assert.ok(has(lines, "working") && has(lines, "esc to stop"));
  h.emit({ type: "tool-end", id: "t1", name: "live_discover", isError: false, elapsedMs: 300 });
  lines = h.screen();
  assert.ok(lines.some((line) => line.includes("│ ✓ looked at your Set") && line.includes("0.3s")));
  h.emit({ type: "turn-complete", result: { stopReason: "completed" }, elapsedMs: 3100 });
  h.emit({ type: "state", state: "idle" });
  lines = h.screen();
  assert.ok(has(lines, "▸ 1 step · 3.1s"));
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
  assert.ok(lines.some((line) => line.includes("/new") && line.includes("Start a fresh conversation")));
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
  h.emit({ type: "connection", state: "disconnected" });
  const lines = h.screen();
  assert.ok(has(lines, "Kumi couldn't answer that; see the note below."));
  assert.ok(has(lines, "anthropic rejected the credentials (HTTP 401)"));
  assert.ok(has(lines, "Live disconnected."));
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
  const mixer: ChangeRecord = { id: "c2", family: "mixer", title: "Bass volume down", track: { name: "Bass", color: "#f59a3c" }, state: "applied", from: 0.85, to: 0.6, at: 2 };
  h.emit({ type: "change", change: tempo });
  h.emit({ type: "change", change: mixer });
  let lines = h.screen();
  assert.ok(has(lines, "✓ Bass volume down"), "NOW shows the change just made");
  assert.ok(!has(lines, "Nothing changed yet"));
  const history = lines.findIndex((line) => line.includes("HISTORY"));
  assert.match(lines[history + 1]!, /■ Bass volume down +undo/);
  assert.match(lines[history + 2]!, /✓ Tempo 120 → 124 BPM +undo/);
  h.onUndo(() => ({ ...tempo, state: "undone" }));
  await h.type(click(lines, history + 2, "undo"));
  assert.ok(h.calls.includes("undo:c1"), "clicking undo takes back that change");
  lines = h.screen();
  assert.match(lines[history + 2]!, /○ Tempo 120 → 124 BPM +undone/);
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
