import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { decodeAmxd, encodeAmxd } from "../src/devices/amxd.js";
import { checkMidiDevice } from "../src/devices/harness.js";
import { midiDeviceCode, midiDevicePatcher } from "../src/devices/midi.js";
import { checkSpec, type DeviceSpec } from "../src/devices/spec.js";
import { deviceTool } from "../src/devices/tool.js";

const folder = mkdtempSync(join(tmpdir(), "kumi-devices-test-"));
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));

/** A device a producer might ask for: each chord's lowest note, everything else untouched. */
const LOWEST = {
  type: "midi_effect", name: "Lowest Note", about: "Keeps the lowest note of each chord (notes within the window); everything else passes through untouched.",
  controls: [{ name: "Window", type: "number", min: 1, max: 50, default: 15, unit: "ms" }],
  code: `let pending = [];
let timer = null;
const sounding = new Map();
const key = (event) => event.channel + ":" + event.pitch;
function flush() {
  timer = null;
  if (!pending.length) return;
  const lowest = pending.reduce((a, b) => (b.pitch < a.pitch ? b : a));
  pending = [];
  send({ type: "noteon", pitch: lowest.pitch, velocity: lowest.velocity, channel: lowest.channel });
  sounding.set(key(lowest), lowest);
}
function midi(event) {
  if (event.type === "noteon") { pending.push(event); if (!timer) timer = after(params.Window, flush); return; }
  if (event.type === "noteoff") {
    if (pending.some((note) => key(note) === key(event))) { cancel(timer); flush(); }
    const note = sounding.get(key(event));
    if (note) { send({ type: "noteoff", pitch: note.pitch, channel: note.channel }); sounding.delete(key(event)); }
    return;
  }
  pass(event);
}
function reset() { pending = []; timer = null; sounding.clear(); }`,
  tests: [
    { name: "a chord keeps its lowest note", input: [{ type: "noteon", pitch: 64, velocity: 90, at: 0 }, { type: "noteon", pitch: 60, velocity: 100, at: 5 }, { type: "noteon", pitch: 67, at: 10 },
      { type: "noteoff", pitch: 60, at: 500 }, { type: "noteoff", pitch: 64, at: 500 }, { type: "noteoff", pitch: 67, at: 500 }],
      expect: [{ type: "noteon", pitch: 60, velocity: 100, at: 15 }, { type: "noteoff", pitch: 60, at: 500 }] },
    { name: "notes apart both play", input: [{ type: "noteon", pitch: 60, at: 0 }, { type: "noteon", pitch: 64, at: 20 }, { type: "noteoff", pitch: 60, at: 300 }, { type: "noteoff", pitch: 64, at: 320 }],
      expect: [{ type: "noteon", pitch: 60, at: 15 }, { type: "noteon", pitch: 64, at: 35 }, { type: "noteoff", pitch: 60, at: 300 }, { type: "noteoff", pitch: 64, at: 320 }] },
    { name: "the rest passes", input: [{ type: "cc", controller: 1, value: 64, at: 0 }, { type: "pitchbend", value: 9000, at: 5 }], expect: [{ type: "cc", controller: 1, value: 64 }, { type: "pitchbend", value: 9000 }] },
    { name: "a wider window", set: { Window: 30 }, input: [{ type: "noteon", pitch: 62, at: 0 }, { type: "noteon", pitch: 55, at: 25 }, { type: "noteoff", pitch: 62, at: 200 }, { type: "noteoff", pitch: 55, at: 200 }],
      expect: [{ type: "noteon", pitch: 55, at: 30 }, { type: "noteoff", pitch: 55, at: 200 }] },
  ],
};
const spec = (overrides: Record<string, unknown> = {}): DeviceSpec => {
  const checked = checkSpec({ ...LOWEST, ...overrides });
  assert.ok("spec" in checked, JSON.stringify(checked));
  return checked.spec;
};

test("a device file is Live's container: ampf, the type's letters, meta, and the patcher as JSON", () => {
  const bytes = encodeAmxd("midi_effect", { patcher: { title: "x" } });
  assert.equal(bytes.toString("latin1", 0, 12), "ampf\u0004\u0000\u0000\u0000mmmm");
  assert.equal(bytes.toString("latin1", 12, 16), "meta");
  assert.equal(bytes.at(-1), 0, "the patcher ends in a NUL");
  assert.deepEqual(decodeAmxd(bytes), { type: "midi_effect", patcher: { patcher: { title: "x" } } });
  assert.equal(decodeAmxd(Buffer.from("not a device")), undefined);
  assert.equal(encodeAmxd("audio_effect", {}).toString("latin1", 8, 12), "aaaa");
});

test("a MIDI effect's patch: midiin, the code, midiout, and each control a Live parameter feeding it", () => {
  const patcher = midiDevicePatcher(spec({ controls: [{ name: "Window", type: "number", min: 1, max: 50, default: 15, unit: "ms" }, { name: "Mode", type: "choice", options: ["Lowest", "Highest"], default: "Lowest" }, { name: "Bypass Drums", type: "switch", default: false }] })) as { patcher: Record<string, unknown> };
  const boxes = (patcher.patcher.boxes as { box: Record<string, unknown> }[]).map((item) => item.box);
  assert.deepEqual(boxes.filter((box) => box.maxclass === "newobj").map((box) => box.text), ["midiin", "midiout", "prepend c1", "prepend c2", "prepend c3"]);
  const code = boxes.find((box) => box.maxclass === "v8.codebox")!;
  assert.match(String(code.code), /function midi\(event\)/);
  assert.match(String(code.code), /const CONTROLS = \[\{"id":"c1","name":"Window"\}/);
  const dial = boxes.find((box) => box.maxclass === "live.dial")!;
  assert.deepEqual((dial.saved_attribute_attributes as { valueof: Record<string, unknown> }).valueof, { parameter_longname: "Window", parameter_shortname: "Window", parameter_initial_enable: 1,
    parameter_type: 0, parameter_mmin: 1, parameter_mmax: 50, parameter_initial: [15], parameter_unitstyle: 2, parameter_exponent: 3 }, "a time over decades turns on a curve");
  assert.equal(boxes.find((box) => box.maxclass === "live.menu")!.varname, "Mode");
  assert.equal(boxes.find((box) => box.maxclass === "live.toggle")!.varname, "Bypass Drums");
  assert.equal(patcher.patcher.openinpresentation, 1);
  assert.equal((patcher.patcher.project as { amxdtype: number }).amxdtype, 0x6d6d6d6d);
  assert.equal(patcher.patcher.description, LOWEST.about);
});

test("the device's code can't reach files, the network or Max and Live: the frame hides them, and the check refuses them", () => {
  // Hidden at run time: Max's objects are undefined inside the device's own code.
  const code = midiDeviceCode({ controls: [], code: "function midi(event) { send({ type: 'cc', controller: 1, value: [typeof File, typeof Dict, typeof LiveAPI, typeof outlet, typeof max].every((kind) => kind === 'undefined') ? 1 : 0 }); }" });
  const sent: number[] = [];
  const context = vm.createContext({ outlet: (_index: number, byte: number) => sent.push(byte), post: () => {}, Task: class {}, File: class {}, Dict: class {}, LiveAPI: class {}, max: {}, inlet: 0 });
  vm.runInContext(code, context);
  for (const byte of [0xB0, 7, 100]) (context.msg_int as (value: number) => void)(byte);
  assert.deepEqual(sent, [0xB0, 1, 1]);
  // Refused up front, saying why.
  const refused = checkSpec({ ...LOWEST, code: "function midi(e) { const f = new File('/tmp/x'); XMLHttpRequest; outlet(0, 1); new Task(() => {}); eval('1'); }" });
  assert.ok("problems" in refused);
  assert.equal(refused.problems.length, 3, "one line for each kind of reach");
  assert.match(refused.problems.join(" "), /files, the network/);
  assert.match(refused.problems.join(" "), /can't make code/);
  // Ordinary names are fine: Math.max, a helper called parse, a class.
  assert.ok("spec" in checkSpec({ ...LOWEST, code: "class Voice { constructor(p) { this.p = p; } }\nconst parse = (x) => Math.max(0, x);\nfunction midi(event) { pass(event); }" }));
});

test("a spec says what's wrong with it, each so it can be fixed", () => {
  const checked = checkSpec({ type: "audio_effect", name: "", about: "", controls: [
    { name: "Window", type: "number", min: 5, max: 1, default: 3 }, { name: "Window", type: "switch", default: true }, { name: "Mode", type: "choice", options: ["A"], default: "A" },
    { name: "Level", type: "integer", min: 0, max: 10, default: 2.5 }, { name: "Rate", type: "number", min: 0, max: 1, default: 0.5, unit: "furlongs" }], code: "send(1)", tests: [{ name: "x", input: "no" }] });
  assert.ok("problems" in checked);
  const text = checked.problems.join("\n");
  for (const expected of [/MIDI effects so far/, /^name:/m, /^about:/m, /min is below max/, /used twice/, /2–16 options/, /whole-number/, /unit is one of/, /define function midi/, /^tests\[0\]/m]) assert.match(text, expected);
});

test("Kumi runs the device's tests and its own checks: a working device passes, a broken one is told what went wrong", () => {
  assert.deepEqual(checkMidiDevice(spec()), { passed: 4, of: 4, problems: [] });
  const wrongTest = checkMidiDevice(spec({ tests: [{ name: "wrong", input: [{ type: "noteon", pitch: 60, at: 0 }, { type: "noteoff", pitch: 60, at: 100 }], expect: [{ type: "noteon", pitch: 61 }] }] }));
  assert.match(wrongTest.problems[0]!, /^test "wrong": expected noteon pitch 61; got noteon pitch 60 velocity 100 at 15 ms, noteoff pitch 60 at 100 ms\.$/);
  const hanging = checkMidiDevice(spec({ code: "function midi(event) { if (event.type !== 'noteoff') send(event); }", tests: [] }));
  assert.match(hanging.problems.join(" "), /leaves notes hanging \(pitch 60, 64, 67, 72\)/);
  const throwing = checkMidiDevice(spec({ code: "function midi(event) { if (event.type === 'cc') missing(); pass(event); }", tests: [] }));
  assert.match(throwing.problems.join(" "), /it threw: missing is not defined/);
  const running = checkMidiDevice(spec({ code: "function tick() { after(100, tick); }\ntick();\nfunction midi(event) { pass(event); }", tests: [] }));
  assert.match(running.problems.join(" "), /timers keep running/);
  // A note-on of velocity 0 in a test goes to the device as one, which the frame hands on as a note-off.
  const zero = checkMidiDevice(spec({ tests: [{ name: "velocity 0 releases", input: [{ type: "noteon", pitch: 60, velocity: 100, at: 0 }, { type: "noteon", pitch: 60, velocity: 0, at: 90 }],
    expect: [{ type: "noteon", pitch: 60, at: 15 }, { type: "noteoff", pitch: 60, at: 90 }] }] }));
  assert.deepEqual(zero.problems, []);
  const broken = checkMidiDevice(spec({ code: "function midi(event) { pass(event) ", tests: [] }));
  assert.match(broken.problems.join(" "), /the code doesn't run/);
});

test("make_device reads its guide on demand, makes a device where Live's Browser sees it, and waits for the Browser", async () => {
  const seen: string[] = [];
  let calls = 0;
  const tool = deviceTool({ userLibrary: folder, waitMs: 5_000, browserSees: async (itemId) => { seen.push(itemId); return ++calls > 1; } });
  const guide = await tool.execute({ guide: true }, new AbortController().signal);
  assert.match(guide.text, /^Making a MIDI effect/);
  assert.match(guide.text, /Every note-on the device sends gets a note-off/);
  const made = await tool.execute(LOWEST, new AbortController().signal);
  assert.equal(made.isError, undefined, made.text);
  const result = JSON.parse(made.text) as Record<string, unknown>;
  assert.equal(result.itemId, "user_library/Kumi/Lowest Note");
  assert.deepEqual(result.controls, ["Window (1–50 ms; 15)"]);
  assert.match(String(result.tests), /4 of 4/);
  assert.equal(result.note, undefined, "the Browser listed it");
  assert.deepEqual(seen, ["user_library/Kumi/Lowest Note", "user_library/Kumi/Lowest Note"]);
  const decoded = decodeAmxd(readFileSync(join(folder, "Kumi", "Lowest Note.amxd")));
  assert.equal(decoded?.type, "midi_effect");
  assert.equal(decoded?.patcher.patcher.title, "Lowest Note");
  // A second one doesn't overwrite the first, which a Set may use.
  const again = JSON.parse((await tool.execute(LOWEST, new AbortController().signal)).text) as Record<string, unknown>;
  assert.equal(again.itemId, "user_library/Kumi/Lowest Note 2");
  // A broken one isn't made: the model is told what to fix.
  const refused = await tool.execute({ ...LOWEST, name: "Broken", code: "function midi(event) { if (event.type !== 'noteoff') send(event); }", tests: [] }, new AbortController().signal);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /leaves notes hanging/);
  assert.throws(() => readFileSync(join(folder, "Kumi", "Broken.amxd")));
});
