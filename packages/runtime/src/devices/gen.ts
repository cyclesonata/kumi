/**
 * Audio effects and instruments: the model writes GenExpr (the language of Max's gen~) and Kumi
 * builds the device around it.
 *
 * - An audio effect: plugin~ → gen~ (the model's code) → Kumi's output stage → plugout~.
 * - An instrument: notein → poly (voice allocation) → one gen~ per voice (the model's voice) →
 *   Kumi's output stage → plugout~.
 *
 * Kumi's output stage is fixed and always there: NaN and denormals out, DC blocked, the level set by
 * an Output knob and held under -1 dBFS (a runaway feedback patch can't blast anyone), and on an
 * effect a Mix knob against the dry signal. Each of the model's controls is a Param in the code, named
 * like the control ("Decay Time" is decay_time), and an ordinary Live parameter on the device's face.
 *
 * GenExpr's order is fixed: function definitions, then declarations (Param, History…), then
 * statements. Kumi's Params go after the model's functions, ahead of the rest of its code.
 */
import { devicePatcher, type Box, type Line } from "./amxd.js";
import { unitStyle } from "./midi.js";
import type { Control } from "./spec.js";

/**
 * gen~'s operators, constants and keywords (as Max 9's gen~ names them), which a control's Param
 * mustn't be (a Param named mix would hide the mix operator), and the names Kumi's own Params use.
 */
const RESERVED = new Set(("abs absdiff accum acos acosh add and asin asinh atan atan2 atanh atodb bool break buffer cartopol ceil change channels clamp clip "
  + "constant continue cos cosh counter cycle data dbtoa dcblock degrees degtorad delay delta dim div e elapsed else eq eqp exp exp2 expr f fastcos fastexp "
  + "fastpow fastsin fasttan fftfullspect ffthop fftinfo fftoffset fftsize fixdenorm fixnan float floor fold for fract ftom gate gen gt gte gtep gtp halfpi "
  + "history hypot i if in int interp invpi isdenorm isnan latch ln ln10 ln2 log log10 log10e log2 log2e lookup lt lte ltep ltp max maximum min minimum mix "
  + "mod mstosamps mtof mul mulequals nearest neg neq neqp noise not or out param pass peek phasewrap phasor phi pi plusequals poke poltocar pow r radians "
  + "radtodeg rate rdiv read receive return rmod round rsub s sah sample samplerate sampstoms scale selector send setparam sign sin sinh slide smoothstep "
  + "splat sqrt sqrt1_2 sqrt2 step sub switch t60 t60time tan tanh train triangle trunc twopi vectorsize voice voices wave while wrap write xor "
  + "note velocity strike bend mod_wheel gain wet").split(" "));

/** A control's name as its Param in the code: "Decay Time" → decay_time. */
export function paramName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Why a control's name can't be a Param, if it can't. */
export function paramProblem(name: string): string | undefined {
  const id = paramName(name);
  if (!/^[a-z][a-z0-9_]*$/.test(id)) return `"${name}" needs to start with a letter to be a Param in the code`;
  if (RESERVED.has(id) || id.startsWith("kumi_")) return `"${name}" would be the Param ${id}, a name gen~ or Kumi already uses; call it something else (such as "${name} Amount")`;
  return undefined;
}

const withoutComments = (code: string) => code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));

/**
 * Where the model's leading function definitions end (GenExpr puts them first): an identifier, its
 * parameters in parentheses, then a braced body; anything else starts the declarations and statements.
 */
export function afterFunctions(code: string): number {
  const bare = withoutComments(code);
  const keywords = new Set(["if", "else", "for", "while", "return", "break", "continue", "Param", "History", "Data", "Buffer", "Delay"]);
  let at = 0;
  for (;;) {
    const head = /^\s*([A-Za-z_]\w*)\s*\(/.exec(bare.slice(at));
    if (!head || keywords.has(head[1]!)) return at;
    let index = at + head[0].length; let depth = 1;
    while (index < bare.length && depth) { if (bare[index] === "(") depth++; else if (bare[index] === ")") depth--; index++; }
    const brace = /^\s*\{/.exec(bare.slice(index));
    if (depth || !brace) return at;   // a call, not a definition
    index += brace[0].length; depth = 1;
    while (index < bare.length && depth) { if (bare[index] === "{") depth++; else if (bare[index] === "}") depth--; index++; }
    if (depth) return at;
    at = index;
  }
}

/** The highest inN the code reads (0 when none): how many inlets its codebox has. */
export function inputsRead(code: string): number {
  let most = 0;
  for (const found of withoutComments(code).matchAll(/\bin([1-9])\b/g)) most = Math.max(most, Number(found[1]));
  return most;
}

/** What Kumi checks in the model's GenExpr before building (Max compiles it when Live loads the device). */
export function checkGenCode(code: string, kind: "audio_effect" | "instrument"): string[] {
  const problems: string[] = [];
  const bare = withoutComments(code);
  if (!/\bout1\s*=/.test(bare) || !/\bout2\s*=/.test(bare)) problems.push("code: assign out1 (left) and out2 (right), every sample.");
  if (/\bout[3-9]\b/.test(bare)) problems.push("code: the device has two outputs, out1 (left) and out2 (right).");
  let braces = 0; let parens = 0; let broken = false;
  for (const char of bare) {
    if (char === "{") braces++; else if (char === "}") braces--; else if (char === "(") parens++; else if (char === ")") parens--;
    if (braces < 0 || parens < 0) { broken = true; break; }
  }
  if (broken || braces !== 0 || parens !== 0) problems.push("code: its braces or parentheses don't pair up.");
  if (/\bParam\s+(note|velocity|strike|bend|mod_wheel|kumi_\w*)\b/.test(bare)) problems.push("code: note, velocity, strike, bend and mod_wheel are Kumi's; use them without declaring them.");
  if (kind === "audio_effect" && inputsRead(code) === 0) problems.push("code: an audio effect reads its input, in1 (left) and in2 (right).");
  if (kind === "audio_effect" && /\b(note|velocity|strike|mod_wheel)\b/.test(bare)) problems.push("code: an audio effect gets no notes; note, velocity, strike and mod_wheel are an instrument's.");
  if (kind === "instrument" && inputsRead(code) > 0) problems.push("code: an instrument has no audio input; make sound from note, velocity, bend and mod_wheel.");
  if (kind === "instrument" && !/\bnote\b/.test(bare)) problems.push("code: a voice plays the note it's given: use note (the MIDI note number, e.g. mtof(note + bend) for its frequency).");
  if (inputsRead(code) > 2) problems.push("code: the device has two inputs, in1 (left) and in2 (right).");
  return problems;
}

/** The Param declarations for the model's controls. */
function paramLines(controls: readonly Control[]): string[] {
  return controls.map((control) => {
    const id = paramName(control.name);
    if (control.type === "switch") return `Param ${id}(${control.default ? 1 : 0}, min=0, max=1);`;
    if (control.type === "choice") return `Param ${id}(${control.options.indexOf(control.default)}, min=0, max=${control.options.length - 1});`;
    return `Param ${id}(${control.default}, min=${control.min}, max=${control.max});`;
  });
}

/** The model's code with Kumi's declarations in their place: after its functions, before the rest. */
export function withParams(code: string, lines: readonly string[], heading: string): string {
  const split = afterFunctions(code);
  const functions = code.slice(0, split).replace(/\s+$/, ""); const rest = code.slice(split).replace(/^\s*\n/, "");
  return [`// ${heading}`, ...(functions ? [functions, ""] : []), "// Kumi's Params (from the device's controls):", ...lines, "", rest].join("\n");
}

const OUTPUT_STAGE_EFFECT = [
  "// Kumi's output stage (fixed): the dry signal mixed back, NaN and DC out, the level held under -1 dBFS.",
  "Param kumi_mix(100, min=0, max=100);",
  "Param kumi_output(0, min=-36, max=12);",
  "gain = dbtoa(kumi_output);",
  "wet = kumi_mix * 0.01;",
  "l = mix(fixnan(fixdenorm(in3)), fixnan(fixdenorm(in1)), wet);",
  "r = mix(fixnan(fixdenorm(in4)), fixnan(fixdenorm(in2)), wet);",
  "out1 = clamp(dcblock(l) * gain, -0.891, 0.891);",
  "out2 = clamp(dcblock(r) * gain, -0.891, 0.891);",
].join("\n");

const OUTPUT_STAGE_INSTRUMENT = [
  "// Kumi's output stage (fixed): NaN and DC out, the level held under -1 dBFS.",
  "Param kumi_output(0, min=-36, max=12);",
  "gain = dbtoa(kumi_output);",
  "out1 = clamp(dcblock(fixnan(fixdenorm(in1))) * gain, -0.891, 0.891);",
  "out2 = clamp(dcblock(fixnan(fixdenorm(in2))) * gain, -0.891, 0.891);",
].join("\n");

/**
 * Kumi's per-voice Params, set for each note: the note, its velocity (0 once released), strike (a new
 * count on every note played, so change(strike) != 0 starts a note even when a busy voice is taken for
 * one at the same velocity), the bend in semitones and the mod wheel.
 */
const VOICE_PARAMS = ["Param note(60, min=0, max=127);", "Param velocity(0, min=0, max=127);", "Param strike(0);", "Param bend(0, min=-2, max=2);", "Param mod_wheel(0, min=0, max=1);"];

/** Max saves code with Windows line endings; it reads either, and Kumi writes it the way Max does. */
const maxLines = (code: string) => code.replace(/\r?\n/g, "\r\n");

/** A gen~ box holding one codebox, wired to as many inlets as the code reads and two outlets. */
function genBox(id: string, code: string, rect: number[]): Box {
  const ins = inputsRead(code);
  const inner: Box[] = []; const lines: Line[] = [];
  inner.push({ box: { id: "obj-code", maxclass: "codebox", code: maxLines(code), fontface: 0, fontname: "<Monospaced>", fontsize: 12.0, numinlets: ins, numoutlets: 2,
    outlettype: ["", ""], patching_rect: [40.0, 80.0, 600.0, 400.0] } });
  for (let index = 1; index <= ins; index++) {
    inner.push({ box: { id: `obj-in-${index}`, maxclass: "newobj", text: `in ${index}`, numinlets: 0, numoutlets: 1, outlettype: [""], patching_rect: [40.0 + (index - 1) * 90.0, 20.0, 30.0, 22.0] } });
    lines.push({ patchline: { source: [`obj-in-${index}`, 0], destination: ["obj-code", index - 1] } });
  }
  for (const index of [1, 2]) {
    inner.push({ box: { id: `obj-out-${index}`, maxclass: "newobj", text: `out ${index}`, numinlets: 1, numoutlets: 0, patching_rect: [40.0 + (index - 1) * 90.0, 510.0, 37.0, 22.0] } });
    lines.push({ patchline: { source: ["obj-code", index - 1], destination: [`obj-out-${index}`, 0] } });
  }
  // gen~ has an inlet for each in, and always at least one, which also takes Param messages.
  return { box: { id, maxclass: "newobj", text: "gen~", numinlets: Math.max(1, ins), numoutlets: 2, outlettype: ["signal", "signal"], patching_rect: rect,
    patcher: { fileversion: 1, appversion: { major: 9, minor: 1, revision: 5, architecture: "x64", modernui: 1 }, classnamespace: "dsp.gen",
      rect: [100.0, 100.0, 720.0, 600.0], gridsize: [15.0, 15.0], boxes: inner, lines } } };
}

/** Builds the face's controls: each sends "<param> <value>" to its targets. */
class Face {
  readonly boxes: Box[] = []; readonly lines: Line[] = [];
  private count = 0;
  add(control: Control, param: string, targets: readonly string[]): void {
    const index = this.count++; const id = `obj-control-${index + 1}`; const x = 8.0 + index * 52.0;
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
        ...((control.unit === "Hz" || control.unit === "ms") && control.min > 0 && control.max / control.min >= 20 ? { parameter_exponent: 3.0 } : {}) });
    }
    // A menu's first outlet is the chosen option's index; a dial's and a toggle's is the value.
    this.boxes.push({ box: { id, varname: control.name, parameter_enable: 1, presentation: 1, patching_rect: [760.0 + index * 90.0, 30.0, 44.0, 48.0], ...box, saved_attribute_attributes: { valueof } } });
    const prepend = `obj-prepend-${index + 1}`;
    this.boxes.push({ box: { id: prepend, maxclass: "newobj", text: `prepend ${param}`, numinlets: 1, numoutlets: 1, outlettype: [""], patching_rect: [760.0 + index * 90.0, 100.0, 80.0, 22.0] } });
    this.lines.push({ patchline: { source: [id, 0], destination: [prepend, 0] } });
    for (const target of targets) this.lines.push({ patchline: { source: [prepend, 0], destination: [target, 0] } });
  }
  get width(): number { return Math.max(140, 16 + this.count * 52); }
}

/** Kumi's own knobs: Mix (effects) and Output. */
export const MIX: Control = { name: "Mix", type: "number", min: 0, max: 100, default: 100, unit: "%" };
export const OUTPUT: Control = { name: "Output", type: "number", min: -36, max: 12, default: 0, unit: "dB" };

export interface GenSpec { name: string; about: string; controls: Control[]; code: string; voices?: number }

/** The effect's code as its gen~ holds it. */
export const effectCode = (spec: GenSpec) => withParams(spec.code, paramLines(spec.controls), `Made by Kumi: ${spec.name}`);
/** One voice's code as each voice's gen~ holds it. */
export const voiceCode = (spec: GenSpec) => withParams(spec.code, [...VOICE_PARAMS, ...paramLines(spec.controls)], `Made by Kumi: ${spec.name} (one voice)`);

/** An audio effect's patcher. */
export function audioEffectPatcher(spec: GenSpec): object {
  const boxes: Box[] = []; const lines: Line[] = []; const face = new Face();
  boxes.push({ box: { id: "obj-plugin", maxclass: "newobj", text: "plugin~ 1 2", numinlets: 1, numoutlets: 2, outlettype: ["signal", "signal"], patching_rect: [40.0, 30.0, 80.0, 22.0] } });
  const effect = genBox("obj-effect", effectCode(spec), [40.0, 120.0, 300.0, 22.0]);
  const ins = inputsRead(spec.code);
  boxes.push(effect);
  boxes.push(genBox("obj-output", OUTPUT_STAGE_EFFECT, [40.0, 220.0, 300.0, 22.0]));
  boxes.push({ box: { id: "obj-plugout", maxclass: "newobj", text: "plugout~ 1 2", numinlets: 2, numoutlets: 0, patching_rect: [40.0, 320.0, 80.0, 22.0] } });
  for (const channel of [0, 1]) {
    if (channel < ins) lines.push({ patchline: { source: ["obj-plugin", channel], destination: ["obj-effect", channel] } });
    lines.push({ patchline: { source: ["obj-effect", channel], destination: ["obj-output", channel] } });
    lines.push({ patchline: { source: ["obj-plugin", channel], destination: ["obj-output", channel + 2] } });
    lines.push({ patchline: { source: ["obj-output", channel], destination: ["obj-plugout", channel] } });
  }
  for (const control of spec.controls) face.add(control, paramName(control.name), ["obj-effect"]);
  face.add(MIX, "kumi_mix", ["obj-output"]); face.add(OUTPUT, "kumi_output", ["obj-output"]);
  return devicePatcher("audio_effect", { title: spec.name, description: spec.about, width: face.width, boxes: [...boxes, ...face.boxes], lines: [...lines, ...face.lines] });
}

/** An instrument's patcher: `voices` copies of the model's voice, the notes shared out by poly. */
export function instrumentPatcher(spec: GenSpec): object {
  const voices = Math.min(8, Math.max(1, Math.round(spec.voices ?? 8)));
  const boxes: Box[] = []; const lines: Line[] = []; const face = new Face();
  const obj = (id: string, text: string, ins: number, outs: number, rect: number[], outlettype: string[] = Array.from({ length: outs }, () => "")) =>
    boxes.push({ box: { id, maxclass: "newobj", text, numinlets: ins, numoutlets: outs, outlettype, patching_rect: rect } });
  const wire = (source: string, outlet: number, destination: string, inlet = 0) => lines.push({ patchline: { source: [source, outlet], destination: [destination, inlet] } });
  // The track's notes; poly shares them out to voices, taking the oldest when all are busy, and sends voice, pitch, velocity.
  obj("obj-notein", "notein", 1, 3, [40.0, 20.0, 60.0, 22.0], ["int", "int", "int"]);
  obj("obj-poly", `poly ${voices} 1`, 2, 3, [40.0, 60.0, 80.0, 22.0], ["int", "int", "int"]);
  obj("obj-pack", "pack 0 0 0", 3, 1, [40.0, 100.0, 80.0, 22.0]);
  obj("obj-route", `route ${Array.from({ length: voices }, (_, index) => index + 1).join(" ")}`, 1, voices + 1, [40.0, 140.0, 40.0 + voices * 30.0, 22.0]);
  wire("obj-notein", 0, "obj-poly", 0); wire("obj-notein", 1, "obj-poly", 1);
  for (const outlet of [0, 1, 2]) wire("obj-poly", outlet, "obj-pack", outlet);
  wire("obj-pack", 0, "obj-route");
  // Bend (7-bit, 64 at rest) as ±2 semitones, exactly 0 at rest; the mod wheel as 0–1.
  obj("obj-bendin", "bendin", 1, 2, [420.0, 20.0, 50.0, 22.0], ["int", "int"]);
  obj("obj-bendcentre", "- 64", 2, 1, [420.0, 50.0, 40.0, 22.0], ["int"]);
  obj("obj-bendscale", "/ 32.", 2, 1, [420.0, 80.0, 40.0, 22.0], ["float"]);
  obj("obj-bend", "prepend bend", 1, 1, [420.0, 110.0, 90.0, 22.0]);
  obj("obj-ctlin", "ctlin 1", 1, 2, [560.0, 20.0, 50.0, 22.0], ["int", "int"]);
  obj("obj-modscale", "/ 127.", 2, 1, [560.0, 50.0, 45.0, 22.0], ["float"]);
  obj("obj-mod", "prepend mod_wheel", 1, 1, [560.0, 80.0, 110.0, 22.0]);
  wire("obj-bendin", 0, "obj-bendcentre"); wire("obj-bendcentre", 0, "obj-bendscale"); wire("obj-bendscale", 0, "obj-bend");
  wire("obj-ctlin", 0, "obj-modscale"); wire("obj-modscale", 0, "obj-mod");
  const code = voiceCode(spec);
  const voiceIds: string[] = [];
  boxes.push(genBox("obj-output", OUTPUT_STAGE_INSTRUMENT, [40.0, 500.0, 300.0, 22.0]));
  obj("obj-plugout", "plugout~ 1 2", 2, 0, [40.0, 560.0, 80.0, 22.0], []);
  for (let voice = 0; voice < voices; voice++) {
    const n = voice + 1; const id = `obj-voice-${n}`; const x = 40.0 + voice * 120.0; voiceIds.push(id);
    // The voice's note and velocity first, then its strike: trigger sends right to left.
    obj(`obj-order-${n}`, "t l l", 1, 2, [x, 180.0, 40.0, 22.0]);
    obj(`obj-unpack-${n}`, "unpack 0 0", 1, 2, [x, 210.0, 70.0, 22.0], ["int", "int"]);
    obj(`obj-note-${n}`, "prepend note", 1, 1, [x, 240.0, 90.0, 22.0]);
    obj(`obj-velocity-${n}`, "prepend velocity", 1, 1, [x, 270.0, 100.0, 22.0]);
    // Every note played (a velocity above 0) counts one more strike, from 1: a bare counter's first count
    // is 0, which left strike at 0 and every voice's first note unplayed.
    obj(`obj-heard-${n}`, "unpack 0 0", 1, 2, [x + 60.0, 280.0, 70.0, 22.0], ["int", "int"]);
    obj(`obj-played-${n}`, "sel 0", 2, 2, [x + 60.0, 305.0, 40.0, 22.0], ["bang", ""]);
    obj(`obj-bang-${n}`, "t b", 1, 1, [x + 60.0, 330.0, 30.0, 22.0], ["bang"]);
    obj(`obj-count-${n}`, "counter 1 1000000", 5, 4, [x + 60.0, 355.0, 110.0, 22.0], ["int", "", "", "int"]);
    obj(`obj-strike-${n}`, "prepend strike", 1, 1, [x + 60.0, 380.0, 90.0, 22.0]);
    boxes.push(genBox(id, code, [x, 420.0, 100.0, 22.0]));
    wire("obj-route", voice, `obj-order-${n}`);
    wire(`obj-order-${n}`, 1, `obj-unpack-${n}`); wire(`obj-unpack-${n}`, 0, `obj-note-${n}`); wire(`obj-unpack-${n}`, 1, `obj-velocity-${n}`);
    wire(`obj-order-${n}`, 0, `obj-heard-${n}`); wire(`obj-heard-${n}`, 1, `obj-played-${n}`); wire(`obj-played-${n}`, 1, `obj-bang-${n}`);
    wire(`obj-bang-${n}`, 0, `obj-count-${n}`); wire(`obj-count-${n}`, 0, `obj-strike-${n}`);
    wire(`obj-note-${n}`, 0, id); wire(`obj-velocity-${n}`, 0, id); wire(`obj-strike-${n}`, 0, id); wire("obj-bend", 0, id); wire("obj-mod", 0, id);
    // Signals into one inlet add up: every voice into the output stage.
    wire(id, 0, "obj-output", 0); wire(id, 1, "obj-output", 1);
  }
  wire("obj-output", 0, "obj-plugout", 0); wire("obj-output", 1, "obj-plugout", 1);
  for (const control of spec.controls) face.add(control, paramName(control.name), voiceIds);
  face.add(OUTPUT, "kumi_output", ["obj-output"]);
  return devicePatcher("instrument", { title: spec.name, description: spec.about, width: face.width, boxes: [...boxes, ...face.boxes], lines: [...lines, ...face.lines] });
}
