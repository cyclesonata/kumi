/**
 * A MIDI device's code, run here before it's made: the same frame and code the device runs in Max,
 * with Max's globals stood in for (outlet, Task, inlet, messagename, post) and a clock Kumi moves,
 * so a test is exact and instant. The device's own tests run, and Kumi's checks: it runs, it
 * throws nothing, it leaves no note hanging, and it goes quiet once every note is released.
 */
import vm from "node:vm";
import { midiDeviceCode } from "./midi.js";
import type { DeviceSpec, MidiEvent, MidiTest } from "./spec.js";

interface Timed extends MidiEvent { at: number }

/** One run of the device: what it sent, what it said, and whether timers were still running. */
interface Run { output: Timed[]; errors: string[]; pending: number }

function bytesOf(event: MidiEvent): number[] {
  const channel = Math.min(16, Math.max(1, Math.round(event.channel ?? 1))) - 1;
  const b7 = (value: number | undefined, fallback = 0) => Math.min(127, Math.max(0, Math.round(value ?? fallback)));
  switch (event.type) {
    // A note-on of velocity 0 goes as one: MIDI's other way to say note-off, which a device must handle.
    case "noteon": return [0x90 | channel, b7(event.pitch), b7(event.velocity, 100)];
    case "noteoff": return [0x80 | channel, b7(event.pitch), b7(event.velocity)];
    case "cc": return [0xB0 | channel, b7(event.controller), b7(event.value)];
    case "pitchbend": { const value = Math.min(16383, Math.max(0, Math.round(event.value ?? 8192))); return [0xE0 | channel, value & 127, value >> 7]; }
    case "aftertouch": return [0xD0 | channel, b7(event.value)];
    case "polytouch": return [0xA0 | channel, b7(event.pitch), b7(event.value)];
    case "program": return [0xC0 | channel, b7(event.value)];
  }
}

/** Bytes the device sent, as events (each at the time its last byte went). */
function eventsOf(bytes: { at: number; byte: number }[]): Timed[] {
  const events: Timed[] = []; let status = 0; let data: number[] = [];
  for (const { at, byte } of bytes) {
    if (byte >= 0xF0) { status = 0; data = []; continue; }
    if (byte >= 0x80) { status = byte; data = []; continue; }
    if (!status) continue;
    data.push(byte);
    const kind = status & 0xF0; const channel = (status & 0x0F) + 1;
    if (data.length < (kind === 0xC0 || kind === 0xD0 ? 1 : 2)) continue;
    const [a = 0, b = 0] = data; data = [];
    if (kind === 0x90 && b > 0) events.push({ type: "noteon", channel, pitch: a, velocity: b, at });
    else if (kind === 0x80 || kind === 0x90) events.push({ type: "noteoff", channel, pitch: a, velocity: kind === 0x80 ? b : 0, at });
    else if (kind === 0xB0) events.push({ type: "cc", channel, controller: a, value: b, at });
    else if (kind === 0xE0) events.push({ type: "pitchbend", channel, value: a | (b << 7), at });
    else if (kind === 0xD0) events.push({ type: "aftertouch", channel, value: a, at });
    else if (kind === 0xA0) events.push({ type: "polytouch", channel, pitch: a, value: b, at });
    else if (kind === 0xC0) events.push({ type: "program", channel, value: a, at });
  }
  return events;
}

/** Runs the device on `input` (control values `set` first), then `settle` ms more for its timers. */
function run(spec: Pick<DeviceSpec, "controls" | "code">, input: MidiEvent[], set: MidiTest["set"] = {}, settle = 2_000): Run {
  let clock = 0; const sent: { at: number; byte: number }[] = []; const errors: string[] = [];
  const queue = new Set<{ due: number; order: number; fn: () => void }>(); let order = 0;
  class Task {
    private entry: { due: number; order: number; fn: () => void } | undefined;
    constructor(private readonly fn: () => void) {}
    schedule(ms?: number) { if (this.entry) queue.delete(this.entry); this.entry = { due: clock + Math.max(0, Number(ms) || 0), order: order++, fn: this.fn }; queue.add(this.entry); }
    cancel() { if (this.entry) queue.delete(this.entry); this.entry = undefined; }
  }
  const fakeDate = class extends Date { static override now() { return clock; } };
  const context = vm.createContext({ outlet: (_index: number, byte: number) => { sent.push({ at: clock, byte: Number(byte) }); }, post: (text: string) => { if (/^Kumi device:/.test(String(text))) errors.push(String(text).replace(/^Kumi device:\s*/, "").trim()); },
    Task, Date: fakeDate, inlet: 0, messagename: "" });
  const until = (time: number) => {
    for (let guard = 0; guard < 100_000; guard++) {
      let next: { due: number; order: number; fn: () => void } | undefined;
      for (const entry of queue) if (entry.due <= time && (!next || entry.due < next.due || (entry.due === next.due && entry.order < next.order))) next = entry;
      if (!next) break;
      queue.delete(next); clock = next.due; next.fn();
    }
    clock = Math.max(clock, time);
  };
  try { vm.runInContext(midiDeviceCode(spec), context, { timeout: 2_000 }); }
  catch (error) { return { output: [], errors: [`the code doesn't run: ${(error as Error).message}`], pending: 0 }; }
  const call = (name: string, inlet: number, ...args: unknown[]) => {
    context.inlet = inlet;
    try { (context[name] as (...values: unknown[]) => void)(...args); } catch (error) { errors.push((error as Error).message); }
  };
  for (const [name, value] of Object.entries(set ?? {})) {
    const index = spec.controls.findIndex((control) => control.name === name);
    const control = spec.controls[index];
    if (!control) { errors.push(`the test sets "${name}", which isn't one of the controls`); continue; }
    context.messagename = `c${index + 1}`;
    call("anything", 1, control.type === "choice" ? Math.max(0, control.options.indexOf(String(value))) : control.type === "switch" ? (value ? 1 : 0) : Number(value));
  }
  const timeline = [...input].map((event, index) => ({ event, at: event.at ?? 0, index })).sort((a, b) => a.at - b.at || a.index - b.index);
  for (const { event, at } of timeline) {
    until(at);
    for (const byte of bytesOf(event)) call("msg_int", 0, byte);
  }
  until((timeline.at(-1)?.at ?? 0) + settle);
  return { output: eventsOf(sent), errors, pending: queue.size };
}

const describe = (event: MidiEvent) => [event.type, event.pitch !== undefined ? `pitch ${event.pitch}` : "", event.velocity !== undefined && event.type === "noteon" ? `velocity ${event.velocity}` : "",
  event.controller !== undefined ? `cc ${event.controller}` : "", event.value !== undefined ? `value ${event.value}` : "", event.channel !== undefined && event.channel !== 1 ? `channel ${event.channel}` : "",
  event.at !== undefined ? `at ${Math.round(event.at)} ms` : ""].filter(Boolean).join(" ");

/** Whether `actual` is what `expected` says: the fields it names, and its time within 3 ms. */
function matches(expected: MidiEvent, actual: Timed): boolean {
  if (expected.type !== actual.type) return false;
  for (const field of ["pitch", "velocity", "controller", "value"] as const) if (expected[field] !== undefined && expected[field] !== actual[field]) return false;
  if ((expected.channel ?? 1) !== (actual.channel ?? 1)) return false;
  return expected.at === undefined || Math.abs(expected.at - actual.at) <= 3;
}

/** Notes the device turned on and never off. */
function hanging(output: Timed[]): string[] {
  const on = new Map<string, number>();
  for (const event of output) {
    const key = `${event.channel ?? 1}:${event.pitch}`;
    if (event.type === "noteon") on.set(key, (on.get(key) ?? 0) + 1);
    if (event.type === "noteoff" && on.get(key)) on.set(key, on.get(key)! - 1);
  }
  return [...on].filter(([, count]) => count > 0).map(([key]) => key.split(":")[1]!);
}

/** Kumi's own check: a chord, a single note, a controller, a bend and aftertouch, each released. */
const PROBE: MidiEvent[] = [
  { type: "noteon", pitch: 60, velocity: 100, at: 0 }, { type: "noteon", pitch: 64, velocity: 90, at: 4 }, { type: "noteon", pitch: 67, velocity: 80, at: 8 },
  { type: "noteoff", pitch: 60, at: 400 }, { type: "noteoff", pitch: 64, at: 402 }, { type: "noteoff", pitch: 67, at: 404 },
  { type: "noteon", pitch: 72, velocity: 110, at: 1_000 }, { type: "noteoff", pitch: 72, at: 1_300 },
  { type: "cc", controller: 1, value: 64, at: 1_500 }, { type: "pitchbend", value: 9_000, at: 1_600 }, { type: "aftertouch", value: 50, at: 1_700 },
];

export interface Checked { passed: number; of: number; problems: string[] }

/** The device's tests and Kumi's checks; problems say what went wrong, for the model to fix. */
export function checkMidiDevice(spec: Pick<DeviceSpec, "controls" | "code" | "tests">): Checked {
  const problems: string[] = [];
  const probe = run(spec, PROBE);
  if (probe.errors.length) problems.push(`Kumi's check: it threw: ${[...new Set(probe.errors)].slice(0, 3).join("; ")}`);
  const loose = hanging(probe.output);
  if (loose.length) problems.push(`Kumi's check: once every note is released, it leaves notes hanging (pitch ${loose.join(", ")}); send a noteoff for every noteon it sent.`);
  if (probe.pending) problems.push("Kumi's check: its timers keep running after every note is released; stop them (cancel) when nothing is held.");
  if (probe.output.length > 200) problems.push(`Kumi's check: it sent ${probe.output.length} events for 11 in; a MIDI effect shouldn't flood.`);
  let passed = 0;
  for (const test of spec.tests) {
    const result = run(spec, test.input, test.set);
    const ok = !result.errors.length && result.output.length === test.expect.length && test.expect.every((expected, index) => matches(expected, result.output[index]!));
    if (ok) { passed++; continue; }
    problems.push(`test "${test.name}": expected ${test.expect.map(describe).join(", ") || "nothing"}; got ${result.output.map(describe).join(", ") || "nothing"}${result.errors.length ? ` (it threw: ${result.errors[0]})` : ""}.`);
  }
  return { passed, of: spec.tests.length, problems };
}
