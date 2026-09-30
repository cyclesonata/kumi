/**
 * A MIDI effect: midiin → a v8.codebox holding Kumi's frame and the device's own code → midiout,
 * with each control a live.dial, live.menu or live.toggle (an ordinary Live parameter) feeding the
 * code. The frame parses MIDI into events, sends events back as bytes, keeps count of the notes the
 * device holds (so all-notes-off silences them), and runs timers; the device's code only decides.
 */
import { devicePatcher, type Box, type Line } from "./amxd.js";
import type { Control, DeviceSpec } from "./spec.js";

/** The frame, with __CONTROLS__ and __DEFAULTS__ for the device's controls and __CODE__ for its code. */
const FRAME = String.raw`// Made by Kumi. The frame (fixed) runs the device's own code, below it.
inlets = 2;
outlets = 1;
const CONTROLS = __CONTROLS__;
const params = __DEFAULTS__;
const held = new Set();
const timers = new Set();
let status = 0;
let data = [];
function now() { return Date.now(); }
function write(bytes) { for (const byte of bytes) outlet(0, byte); }
function safely(fn, args) { try { return fn.apply(undefined, args); } catch (error) { post("Kumi device: " + ((error && error.message) || error) + "\n"); } }
function whole(value, low, high) { value = Math.round(Number(value)); return Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low; }
function send(event) {
  if (!event || typeof event !== "object") return;
  const channel = whole(event.channel === undefined ? 1 : event.channel, 1, 16) - 1;
  switch (event.type) {
    case "noteon": {
      const pitch = whole(event.pitch, 0, 127); const velocity = whole(event.velocity === undefined ? 100 : event.velocity, 0, 127);
      if (velocity === 0) { send({ type: "noteoff", pitch: pitch, channel: channel + 1 }); return; }
      held.add(channel * 128 + pitch); write([0x90 | channel, pitch, velocity]); return;
    }
    case "noteoff": { const pitch = whole(event.pitch, 0, 127); held.delete(channel * 128 + pitch); write([0x80 | channel, pitch, whole(event.velocity || 0, 0, 127)]); return; }
    case "cc": write([0xB0 | channel, whole(event.controller, 0, 127), whole(event.value, 0, 127)]); return;
    case "pitchbend": { const value = whole(event.value === undefined ? 8192 : event.value, 0, 16383); write([0xE0 | channel, value & 127, value >> 7]); return; }
    case "aftertouch": write([0xD0 | channel, whole(event.value, 0, 127)]); return;
    case "polytouch": write([0xA0 | channel, whole(event.pitch, 0, 127), whole(event.value, 0, 127)]); return;
    case "program": write([0xC0 | channel, whole(event.value, 0, 127)]); return;
  }
}
const pass = send;
function after(ms, fn) {
  const task = new Task(function () { timers.delete(task); safely(fn, []); });
  timers.add(task); task.schedule(Math.max(0, Number(ms) || 0)); return task;
}
function cancel(task) { if (task && timers.has(task)) { task.cancel(); timers.delete(task); } }
const device = (function () {
  "use strict";
  // Out of the device's reach: files, the network, and the rest of Max and Live.
  const File = undefined, Folder = undefined, XMLHttpRequest = undefined, fetch = undefined, SQLite = undefined, Dict = undefined, Buffer = undefined, Global = undefined,
    LiveAPI = undefined, messnamed = undefined, max = undefined, patcher = undefined, globalThis = undefined, outlet = undefined, Task = undefined, require = undefined;
  return (function () {
__CODE__
    return { midi: typeof midi === "function" ? midi : undefined, changed: typeof changed === "function" ? changed : undefined, reset: typeof reset === "function" ? reset : undefined };
  })();
})();
function panic() {
  for (const task of timers) task.cancel();
  timers.clear();
  if (device.reset) safely(device.reset, []);
  for (const key of held) write([0x80 | (key >> 7), key & 127, 0]);
  held.clear();
}
function receive(event) {
  // All notes off and all sound off: the device forgets, what it holds goes off, and the message passes on.
  if (event.type === "cc" && (event.controller === 123 || event.controller === 120)) { panic(); send(event); return; }
  if (device.midi) safely(device.midi, [event]); else send(event);
}
function parse(byte) {
  if (byte >= 0xF8) { write([byte]); return; }
  if (byte >= 0xF0) { status = byte === 0xF0 ? 0xF0 : 0; data = []; write([byte]); return; }
  if (byte >= 0x80) { status = byte; data = []; return; }
  if (status === 0xF0 || !status) { write([byte]); return; }
  data.push(byte);
  const kind = status & 0xF0; const channel = (status & 0x0F) + 1;
  if (data.length < (kind === 0xC0 || kind === 0xD0 ? 1 : 2)) return;
  const a = data[0]; const b = data[1]; data = [];
  const time = now();
  if (kind === 0x90 && b > 0) receive({ type: "noteon", channel: channel, pitch: a, velocity: b, time: time });
  else if (kind === 0x80 || kind === 0x90) receive({ type: "noteoff", channel: channel, pitch: a, velocity: kind === 0x80 ? b : 0, time: time });
  else if (kind === 0xB0) receive({ type: "cc", channel: channel, controller: a, value: b, time: time });
  else if (kind === 0xE0) receive({ type: "pitchbend", channel: channel, value: a | (b << 7), time: time });
  else if (kind === 0xD0) receive({ type: "aftertouch", channel: channel, value: a, time: time });
  else if (kind === 0xA0) receive({ type: "polytouch", channel: channel, pitch: a, value: b, time: time });
  else if (kind === 0xC0) receive({ type: "program", channel: channel, value: a, time: time });
}
function msg_int(value) { if (inlet === 0) parse(value); }
function msg_float(value) { if (inlet === 0) parse(Math.round(value)); }
function anything() {
  if (inlet !== 1) return;
  const knob = CONTROLS.find(function (item) { return item.id === messagename; });
  if (!knob) return;
  let value = arguments[0];
  if (knob.options) value = knob.options[whole(value, 0, knob.options.length - 1)];
  else if (knob.toggle) value = Number(value) > 0;
  params[knob.name] = value;
  if (device.changed) safely(device.changed, [knob.name, value]);
}
`;

/** The code the device's v8.codebox runs: the frame around the model's code. */
export function midiDeviceCode(spec: Pick<DeviceSpec, "controls" | "code">): string {
  const controls = spec.controls.map((control, index) => ({ id: `c${index + 1}`, name: control.name,
    ...(control.type === "choice" ? { options: control.options } : {}), ...(control.type === "switch" ? { toggle: true } : {}) }));
  const defaults = Object.fromEntries(spec.controls.map((control) => [control.name, control.default]));
  // Replaced one after the other, and the code last, so nothing in it can be taken for a placeholder.
  return FRAME.replace("__CONTROLS__", () => JSON.stringify(controls)).replace("__DEFAULTS__", () => JSON.stringify(defaults))
    .replace("__CODE__", () => spec.code.split(/\r?\n/).map((line) => `    ${line}`).join("\n"));
}

/** Live's display style for a unit (live.dial's parameter_unitstyle), and the text for a custom one. */
function unitStyle(control: Extract<Control, { type: "number" | "integer" }>): { style: number; units?: string } {
  switch (control.unit) {
    case "ms": case "s": return { style: 2 };
    case "Hz": return { style: 3 };
    case "dB": return { style: 4 };
    case "%": return { style: 5 };
    case "pan": return { style: 6 };
    case "st": return { style: 7 };
    case "note": return { style: 8 };
    case "beats": case "bpm": case "x": return { style: 9, units: control.unit };
    default: return { style: control.type === "integer" ? 0 : 1 };
  }
}

/** The patcher of a MIDI effect for `spec`: its face shows the controls in a row. */
export function midiDevicePatcher(spec: DeviceSpec): object {
  const boxes: Box[] = []; const lines: Line[] = [];
  const text = (id: string, content: string, rect: number[], extra: Record<string, unknown> = {}) =>
    boxes.push({ box: { id, maxclass: "newobj", text: content, fontname: "Arial Bold", fontsize: 10.0, patching_rect: rect, ...extra } });
  text("obj-midiin", "midiin", [40.0, 30.0, 40.0, 20.0], { numinlets: 1, numoutlets: 1, outlettype: ["int"] });
  text("obj-midiout", "midiout", [40.0, 420.0, 47.0, 20.0], { numinlets: 1, numoutlets: 0 });
  boxes.push({ box: { id: "obj-code", maxclass: "v8.codebox", filename: "none", code: midiDeviceCode(spec), fontface: 0, fontname: "Menlo", fontsize: 11.0,
    numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [40.0, 120.0, 520.0, 280.0], saved_object_attributes: { parameter_enable: 0 } } });
  lines.push({ patchline: { source: ["obj-midiin", 0], destination: ["obj-code", 0] } });
  lines.push({ patchline: { source: ["obj-code", 0], destination: ["obj-midiout", 0] } });
  spec.controls.forEach((control, index) => {
    const id = `obj-control-${index + 1}`; const x = 8.0 + index * 52.0;
    const valueof: Record<string, unknown> = { parameter_longname: control.name, parameter_shortname: control.name.slice(0, 12), parameter_initial_enable: 1 };
    let box: Record<string, unknown>;
    if (control.type === "choice") {
      box = { maxclass: "live.menu", numinlets: 1, numoutlets: 3, outlettype: ["", "", "float"], presentation_rect: [x, 24.0, 48.0, 15.0] };
      Object.assign(valueof, { parameter_type: 2, parameter_enum: control.options, parameter_mmax: control.options.length - 1, parameter_initial: [control.options.indexOf(control.default)] });
    } else if (control.type === "switch") {
      box = { maxclass: "live.toggle", numinlets: 1, numoutlets: 1, outlettype: [""], presentation_rect: [x + 12.0, 24.0, 20.0, 20.0] };
      Object.assign(valueof, { parameter_type: 2, parameter_enum: ["off", "on"], parameter_mmax: 1, parameter_initial: [control.default ? 1 : 0] });
    } else {
      const unit = unitStyle(control);
      box = { maxclass: "live.dial", numinlets: 1, numoutlets: 2, outlettype: ["", "float"], presentation_rect: [x, 8.0, 44.0, 48.0] };
      Object.assign(valueof, { parameter_type: control.type === "integer" ? 1 : 0, parameter_mmin: control.min, parameter_mmax: control.max, parameter_initial: [control.default],
        parameter_unitstyle: unit.style, ...(unit.units ? { parameter_units: unit.units } : {}),
        // Frequencies and times spread over decades turn more evenly on a curve.
        ...((control.unit === "Hz" || control.unit === "ms") && control.min > 0 && control.max / control.min >= 20 ? { parameter_exponent: 3.0 } : {}) });
    }
    boxes.push({ box: { id, varname: control.name, parameter_enable: 1, presentation: 1, patching_rect: [600.0 + index * 60.0, 30.0, 44.0, 48.0], ...box,
      saved_attribute_attributes: { valueof } } });
    const prepend = `obj-prepend-${index + 1}`;
    text(prepend, `prepend c${index + 1}`, [600.0 + index * 60.0, 90.0, 60.0, 20.0], { numinlets: 1, numoutlets: 1, outlettype: [""] });
    lines.push({ patchline: { source: [id, 0], destination: [prepend, 0] } });
    lines.push({ patchline: { source: [prepend, 0], destination: ["obj-code", 1] } });
  });
  return devicePatcher("midi_effect", { title: spec.name, description: spec.about, width: Math.max(120, 16 + spec.controls.length * 52), boxes, lines });
}
