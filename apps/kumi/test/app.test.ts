import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import type { ChangeRecord, SessionController, SessionEvent, TurnState } from "@kumi/runtime";
import { changePicture, chipColor, fitCrumbs, focusPath, setNameFrom, TuiApp } from "../src/tui/app.js";
import { palette } from "../src/tui/style.js";
import { Editor } from "../src/tui/editor.js";
import { RESTORE } from "../src/tui/tty.js";
import type { ModelControl } from "../src/models.js";
import { fakeModels, MODELS } from "./fake-models.js";
import { VirtualTerminal } from "./vt.js";

const opened: TuiApp[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((app) => app.close())); });

function harness(columns = 120, rows = 36, models?: ModelControl, extra: Partial<SessionController> = {}) {
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
  const app = new TuiApp({ controller, input, output, ...(models ? { models } : {}), mode: "live", secrets: ["private-token"], colorDepth: "truecolor", frameMs: 1, closeTimeoutMs: 100 });
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
  assert.ok(h.written.endsWith(`${RESTORE}Kumi closed. Conversations about saved Sets continue next time.\n`), "the terminal is restored before the goodbye");
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
  h.emit({ type: "notice", message: "Live disconnected. Kumi keeps the conversation and reconnects when Live is back; if it doesn't, use /new." });
  const lines = h.screen();
  assert.ok(has(lines, "Kumi couldn't answer that; see the note below."));
  assert.ok(has(lines, "anthropic rejected the credentials (HTTP 401)"));
  assert.ok(has(lines, "Live disconnected. Kumi keeps the conversation"));
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
  assert.match(lines[history + 2]!, /^ +pan C → 5L *$/, "a long title continues on a second line, whole");
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
  assert.deepEqual(lines.map(text), ["⠉".repeat(12), "⣉".repeat(12)], "three pitches in three lanes: top, middle and bottom");
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
  const row = screen.findIndex((line) => line.includes("⠉⠉⠉⠉⠉⠉⠉⠉"));
  assert.ok(row > 0 && screen[row + 1]!.includes("⣉⣉⣉⣉⣉⣉⣉⣉"), "two rows under NOW");
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

test("after /new, earlier changes stay listed without their undo", async () => {
  const h = harness();
  void h.app.run();
  await delay(5);
  connect(h);
  h.emit({ type: "change", change: { id: "c5", family: "tempo", title: "Tempo 120 → 126 BPM", state: "applied", at: 1 } });
  await h.type("/new\r");
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

test("signing in to ChatGPT from Kumi shows the link to open, copies it on c, and can be cancelled", async () => {
  const fake = fakeModels({ lists: MODELS });
  const h = harness(120, 36, fake.control);
  void h.app.run();
  await delay(10);
  await h.type("\r");
  await delay(5);
  let lines = h.screen();
  assert.ok(has(lines, "Sign in to ChatGPT") && has(lines, "https://auth.example.test/oauth/authorize") && has(lines, "Waiting for the browser…"));
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
  assert.ok(has(lines, "Kumi will remember: The Reese is the main bass"));
  assert.ok(has(lines, "Kumi will remember about you: Prefers short reverbs"));
  assert.ok(has(lines, "Kumi updated a note about you: Prefers short, dark reverbs"));
  assert.ok(has(lines, "Kumi forgot: The Reese is the main bass"));
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
  assert.ok(has(h.screen(), "Kumi saved the recipe “Vocal chain” (4 steps)"));
  await h.app.close();
});
