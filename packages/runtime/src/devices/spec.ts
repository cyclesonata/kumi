/**
 * What the model asks for when it makes a device, and the checks it has to pass. The model never
 * writes a patch: it names the device, its knobs and its code, and Kumi builds the rest.
 */
import { checkGenCode, MAX_VOICES, paramName, paramProblem } from "./gen.js";

/** A knob, a menu or a switch on the device: an ordinary Live parameter, automatable and mappable. */
export type Control =
  | { name: string; type: "number" | "integer"; min: number; max: number; default: number; unit?: Unit }
  | { name: string; type: "choice"; options: string[]; default: string }
  | { name: string; type: "switch"; default: boolean };

export const UNITS = ["", "ms", "s", "Hz", "dB", "%", "st", "note", "pan", "beats", "bpm", "x"] as const;
export type Unit = typeof UNITS[number];

/** A MIDI event as the device's code sees it (times in milliseconds). */
export interface MidiEvent {
  type: "noteon" | "noteoff" | "cc" | "pitchbend" | "aftertouch" | "polytouch" | "program";
  channel?: number;
  pitch?: number;
  velocity?: number;
  controller?: number;
  value?: number;
  at?: number;
}

/** Events in and what should come out, to check the device's code before it's made. */
export interface MidiTest { name: string; set?: Record<string, number | string | boolean>; input: MidiEvent[]; expect: MidiEvent[] }

/**
 * A MIDI effect: JavaScript that decides what happens to each MIDI event, with tests Kumi runs. One
 * that runs free (an LFO, a clock, a generator) keeps sending once every note is released.
 */
export interface MidiSpec { type: "midi_effect"; name: string; about: string; controls: Control[]; code: string; tests: MidiTest[]; runsFree?: boolean }
/** An audio effect: GenExpr that turns in1/in2 into out1/out2, sample by sample. */
export interface AudioEffectSpec { type: "audio_effect"; name: string; about: string; controls: Control[]; code: string }
/** An instrument: GenExpr for one voice, played by notes, and how many voices play at once. */
export interface InstrumentSpec { type: "instrument"; name: string; about: string; controls: Control[]; code: string; voices: number }
export type DeviceSpec = MidiSpec | AudioEffectSpec | InstrumentSpec;
export type DeviceKind = DeviceSpec["type"];
export const DEVICE_KINDS: readonly DeviceKind[] = ["midi_effect", "audio_effect", "instrument"];

/**
 * Ceilings, not targets: a device gets the controls, options, voices and code it needs, and these
 * only keep its file one Live loads. Past eight, the face shows its controls in up to three rows.
 */
export const MAX_CONTROLS = 128;
export const MAX_OPTIONS = 128;
export const MAX_CODE = 100_000;
export const MAX_TESTS = 32;
const MAX_TEST_EVENTS = 256;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()&'+-]{0,31}$/;
const CONTROL = /^[A-Za-z][A-Za-z0-9 ._()&'+\/#%-]{0,31}$/;
const EVENT_TYPES = new Set(["noteon", "noteoff", "cc", "pitchbend", "aftertouch", "polytouch", "program"]);

/**
 * What the device's code may not reach: files, the network, the rest of Max and Live, and the
 * frame's own plumbing (it sends through send and pass, and times through after, so no note is
 * left hanging). The frame also hides these names from the code; the check says why up front.
 */
const FORBIDDEN: [RegExp, string][] = [
  [/\b(File|Folder|XMLHttpRequest|fetch|SQLite|Dict|Buffer|Global|LiveAPI|messnamed|globalThis|require|patcher)\b|\bmax\s*\.\s*[a-z]/, "files, the network and the rest of Max and Live are out of reach"],
  [/\bimport\s*[({"'`\w*]|\bexport\s+/, "modules aren't available"],
  [/\beval\s*\(|\bFunction\s*\(|\.\s*constructor\b|\[\s*["'`]constructor|__proto__/, "code can't make code"],
  [/\boutlet\s*\(|\bnew\s+Task\b/, "send with send(event) or pass(event), and time with after(ms, fn): the frame keeps count of held notes"],
];

/** A spec from the model's input, or the problems with it, each said so the model can fix it. */
export function checkSpec(input: Record<string, unknown>): { spec: DeviceSpec } | { problems: string[] } {
  const problems: string[] = [];
  const type = (input.type ?? "midi_effect") as DeviceKind;
  if (!DEVICE_KINDS.includes(type)) problems.push(`type ${JSON.stringify(input.type)}: midi_effect, audio_effect or instrument.`);
  const gen = type === "audio_effect" || type === "instrument";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!NAME.test(name)) problems.push("name: 1–32 characters, letters, digits, spaces and . _ ( ) & ' + -, starting with a letter or digit.");
  const about = typeof input.about === "string" ? input.about.trim() : "";
  if (!about || about.length > 400) problems.push("about: what the device does, in a sentence or two (up to 400 characters).");
  const controls = Array.isArray(input.controls) ? input.controls : [];
  if (controls.length > MAX_CONTROLS) problems.push(`controls: at most ${MAX_CONTROLS}.`);
  const seen = new Set<string>();
  const checked: Control[] = [];
  for (const [index, raw] of controls.slice(0, MAX_CONTROLS).entries()) {
    const control = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const label = `controls[${index}]`;
    const controlName = typeof control.name === "string" ? control.name.trim() : "";
    if (!CONTROL.test(controlName) || /^device on$/i.test(controlName)) { problems.push(`${label}.name: 1–32 letters, digits, spaces and . _ ( ) & ' + / # % -, starting with a letter.`); continue; }
    if (seen.has(controlName.toLowerCase())) { problems.push(`${label}.name: "${controlName}" is used twice.`); continue; }
    // In GenExpr a control is its Param: "Pre-Delay" and "Pre Delay" would both be pre_delay.
    const twin = gen ? checked.find((other) => paramName(other.name) === paramName(controlName)) : undefined;
    if (twin) { problems.push(`${label}.name: "${controlName}" and "${twin.name}" would both be the Param ${paramName(controlName)}; name them apart.`); continue; }
    if (gen && /^(mix|output)$/i.test(controlName)) { problems.push(`${label}.name: Kumi adds ${controlName} to every ${type === "audio_effect" ? "audio effect" : "instrument"} itself; leave it out.`); continue; }
    const asParam = gen ? paramProblem(controlName) : undefined;
    if (asParam) { problems.push(`${label}.name: ${asParam}.`); continue; }
    seen.add(controlName.toLowerCase());
    if (control.type === "number" || control.type === "integer") {
      const { min, max } = control; const fallback = control.default;
      const numbers = [min, max, fallback].every((value) => typeof value === "number" && Number.isFinite(value));
      const unit = control.unit ?? "";
      if (!numbers) { problems.push(`${label} (${controlName}): min, max and default are numbers.`); continue; }
      if ((min as number) >= (max as number)) { problems.push(`${label} (${controlName}): min is below max.`); continue; }
      if ((fallback as number) < (min as number) || (fallback as number) > (max as number)) { problems.push(`${label} (${controlName}): the default, a value that sounds right on load, is between min and max.`); continue; }
      if (control.type === "integer" && ![min, max, fallback].every((value) => Number.isInteger(value))) { problems.push(`${label} (${controlName}): an integer control has whole-number min, max and default.`); continue; }
      if (!(UNITS as readonly unknown[]).includes(unit)) { problems.push(`${label} (${controlName}): unit is one of ${UNITS.filter(Boolean).join(", ")}, or "" for none.`); continue; }
      checked.push({ name: controlName, type: control.type, min: min as number, max: max as number, default: fallback as number, unit: unit as Unit });
    } else if (control.type === "choice") {
      const options = Array.isArray(control.options) ? control.options : [];
      if (options.length < 2 || options.length > MAX_OPTIONS || !options.every((option) => typeof option === "string" && option.trim() && option.length <= 32)) { problems.push(`${label} (${controlName}): 2–${MAX_OPTIONS} options of up to 32 characters.`); continue; }
      if (!options.includes(control.default)) { problems.push(`${label} (${controlName}): the default is one of the options.`); continue; }
      checked.push({ name: controlName, type: "choice", options: options as string[], default: control.default as string });
    } else if (control.type === "switch") {
      if (typeof control.default !== "boolean") { problems.push(`${label} (${controlName}): a switch's default is true or false.`); continue; }
      checked.push({ name: controlName, type: "switch", default: control.default });
    } else problems.push(`${label} (${controlName}): type is number, integer, choice or switch.`);
  }
  const code = typeof input.code === "string" ? input.code : "";
  if (!code.trim() || code.length > MAX_CODE) problems.push(`code: the device's ${gen ? "GenExpr" : "JavaScript"}, up to ${MAX_CODE.toLocaleString("en-US")} characters.`);
  else if (gen) problems.push(...checkGenCode(code, type as "audio_effect" | "instrument", checked));
  else {
    if (!/\bfunction\s+midi\s*\(/.test(code)) problems.push("code: define function midi(event), called for each MIDI event that arrives.");
    for (const [pattern, why] of FORBIDDEN) {
      const found = pattern.exec(code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""));
      if (found) problems.push(`code: "${found[0].trim()}" isn't allowed: ${why}.`);
    }
  }
  // Only a MIDI effect's code runs outside Live; an audio effect or instrument is heard with audition once loaded.
  const tests = !gen && Array.isArray(input.tests) ? input.tests : [];
  if (tests.length > MAX_TESTS) problems.push(`tests: at most ${MAX_TESTS}.`);
  const checkedTests: MidiTest[] = [];
  for (const [index, raw] of tests.slice(0, MAX_TESTS).entries()) {
    const test = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const label = `tests[${index}]`;
    const events = (value: unknown) => (Array.isArray(value) && value.length <= MAX_TEST_EVENTS && value.every((event) => event && typeof event === "object" && EVENT_TYPES.has((event as MidiEvent).type)
      && ((event as MidiEvent).at === undefined || (typeof (event as MidiEvent).at === "number" && (event as MidiEvent).at! >= 0 && (event as MidiEvent).at! <= 60_000))) ? value as MidiEvent[] : undefined);
    const inputEvents = events(test.input); const expected = events(test.expect);
    if (typeof test.name !== "string" || !test.name.trim() || !inputEvents || !expected) { problems.push(`${label}: a name, input and expect, each up to ${MAX_TEST_EVENTS} events of type ${[...EVENT_TYPES].join(", ")} (at: milliseconds).`); continue; }
    if (test.set !== undefined && (typeof test.set !== "object" || test.set === null || Array.isArray(test.set))) { problems.push(`${label}: set names controls and their values.`); continue; }
    checkedTests.push({ name: test.name.trim().slice(0, 80), ...(test.set ? { set: test.set as NonNullable<MidiTest["set"]> } : {}), input: inputEvents, expect: expected });
  }
  let voices = 8;
  if (type === "instrument" && input.voices !== undefined) {
    if (!Number.isInteger(input.voices) || (input.voices as number) < 1 || (input.voices as number) > MAX_VOICES) problems.push(`voices: how many notes play at once, 1 (mono) to ${MAX_VOICES}.`);
    else voices = input.voices as number;
  }
  if (!gen && input.runs_free !== undefined && typeof input.runs_free !== "boolean") problems.push("runs_free: true for a MIDI effect that keeps sending on its own (an LFO, a clock, a generator).");
  if (problems.length) return { problems };
  if (type === "audio_effect") return { spec: { type, name, about, controls: checked, code } };
  if (type === "instrument") return { spec: { type, name, about, controls: checked, code, voices } };
  return { spec: { type: "midi_effect", name, about, controls: checked, code, tests: checkedTests, ...(input.runs_free === true ? { runsFree: true } : {}) } };
}
