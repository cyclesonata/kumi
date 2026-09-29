/**
 * make_device: the model describes a Max for Live device (its name, controls, code and tests) and
 * Kumi builds it, runs its tests and Kumi's own checks, writes it where Live's Browser sees it
 * (User Library › Kumi), and waits for the Browser to list it, so load_device can put it on a track
 * with HISTORY and undo like any other device. The guide is read on demand, not with every request.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KernelTool } from "../core/contracts.js";
import { encodeAmxd } from "./amxd.js";
import { lowDisk, MB } from "../core/disk.js";
import { checkMidiDevice } from "./harness.js";
import { midiDevicePatcher } from "./midi.js";
import { checkSpec, MAX_CONTROLS, UNITS, type Control } from "./spec.js";

export const MAKE_DEVICE_TOOL = "make_device";

const DESCRIPTION = [
  "Make a Max for Live device the producer asks for, a MIDI effect so far (audio effects and instruments are next), and put it in their User Library for load_device.",
  "Read the guide first (guide: true): what the device's code can use, the rules Kumi checks, and what makes a device good.",
  "Then give its name, what it does, its controls (knobs, menus and switches, which become ordinary Live parameters), its JavaScript and its tests.",
  "Kumi builds the device around the code, runs your tests and its own checks (no errors, no hanging notes), and refuses a device that breaks a rule, saying why so you can fix it.",
  "Then load it with load_device and the itemId it returns.",
].join(" ");

const GUIDE = `Making a MIDI effect

Your code runs inside Kumi's frame in Live's Max (JavaScript, v8, strict mode). You write functions and the frame calls them:
- function midi(event): required. Called for every MIDI message that arrives. What you don't send on is dropped, so pass(event) whatever the device doesn't change.
- function changed(name, value): optional. A control moved (a number; the option's text for a choice; true or false for a switch).
- function reset(): optional. Forget anything pending. Called on all-notes-off, after which the frame turns off every note the device still holds.

Events: { type, channel (1–16), time (ms) } and
- noteon, noteoff: pitch (0–127), velocity (0–127)
- cc: controller, value; pitchbend: value (0–16383, 8192 is the centre); aftertouch: value; polytouch: pitch, value; program: value

What your code can use:
- send(event) sends an event of that shape (channel defaults to 1, velocity to 100); pass(event) sends one on as it came.
- after(ms, fn) runs fn later and returns a timer; cancel(timer) stops it.
- params["Name"] is a control's value now; now() is the time in milliseconds.
- Plain JavaScript: Math, arrays, objects, Map, Set, classes. Not files, the network, or Max's and Live's objects: the frame hides them, and Kumi refuses code that reaches for them.

Rules Kumi checks, refusing the device and saying which it broke:
- Every note-on the device sends gets a note-off. When you delay, transpose or replace notes, send the note-off for the pitch you sent, not the one that arrived, and forget a pending note whose note-off comes first.
- Once every note is released, nothing is left running: cancel timers, or let them end.
- It runs without an error on a chord, a single note, a controller, a bend and aftertouch.
- At most ${MAX_CONTROLS} controls, each named in up to 24 letters, digits and spaces (the producer's own words), with a range, a unit (${UNITS.filter(Boolean).join(", ")}, or none) and a default that works on load.

Craft:
- JavaScript in Max runs on its low-priority thread, so its timing can wander by a few milliseconds: right for grouping chords or delays of tens of milliseconds, not for sample-accurate work.
- Keep midi() quick.
- For anything grouped in time (chords, strums), hold the note-ons for the window and close it early when a note-off arrives. The delay is the price of clean output; say so when it matters.
- Pass controllers, bend, aftertouch and program changes through unless changing them is the device's job.
- Choose sensible defaults and say what they are. Ask the producer at most one question, and only when a choice changes the result (such as delaying note-ons or retriggering); otherwise decide.

Tests: write 2 to 6 of what the device must do. Each has input events (with at, in ms), the events expected out in order (the fields you name are compared, and at to within 3 ms), and set for any control values. Kumi runs them and its own checks before it makes the device; when one fails it says what came out instead, so fix the code or the test and call make_device again.

Then load_device with the itemId it returns, on the producer's MIDI track: Live puts a MIDI effect before the instrument. Tell the producer in a sentence or two what it does and what its controls are.`;

const EVENT = { type: "object", description: "{ type: noteon|noteoff|cc|pitchbend|aftertouch|polytouch|program, pitch, velocity, controller, value, channel, at (ms) }" };

/** A file name for the device that isn't taken yet: "Lowest Note", then "Lowest Note 2" and on. */
function freeName(folder: string, name: string): string {
  for (let index = 1; index < 1_000; index++) {
    const candidate = index === 1 ? name : `${name} ${index}`;
    if (!existsSync(join(folder, `${candidate}.amxd`))) return candidate;
  }
  return `${name} ${randomUUID().slice(0, 8)}`;
}

const describeControl = (control: Control) => control.type === "choice" ? `${control.name} (${control.options.join(" / ")}; ${control.default})`
  : control.type === "switch" ? `${control.name} (on/off; ${control.default ? "on" : "off"})`
  : `${control.name} (${control.min}–${control.max}${control.unit ? ` ${control.unit}` : ""}; ${control.default})`;

export interface DeviceToolOptions {
  /** Live's User Library: devices go in its Kumi folder. */
  userLibrary: string;
  /** Whether Live's Browser lists `itemId` yet. */
  browserSees(itemId: string, signal: AbortSignal): Promise<boolean>;
  /** How long to wait for the Browser (it indexes new files on its own time). */
  waitMs?: number;
}

export function deviceTool(options: DeviceToolOptions): KernelTool {
  return {
    name: MAKE_DEVICE_TOOL, description: DESCRIPTION,
    inputSchema: { type: "object", additionalProperties: false, properties: {
      guide: { type: "boolean", description: "true: read how to make a device (first)" },
      type: { type: "string", enum: ["midi_effect"] },
      name: { type: "string", minLength: 1, maxLength: 32, description: "The device's name, as the producer would say it" },
      about: { type: "string", minLength: 1, maxLength: 400, description: "What it does, in a sentence or two" },
      controls: { type: "array", maxItems: MAX_CONTROLS, items: { type: "object", properties: {
        name: { type: "string" }, type: { type: "string", enum: ["number", "integer", "choice", "switch"] }, min: { type: "number" }, max: { type: "number" },
        default: { description: "A number, one of the options, or true/false" }, unit: { type: "string", enum: [...UNITS] }, options: { type: "array", items: { type: "string" } } } } },
      code: { type: "string", maxLength: 24_000, description: "The device's JavaScript: function midi(event) and any helpers (see the guide)" },
      tests: { type: "array", maxItems: 12, items: { type: "object", properties: { name: { type: "string" }, set: { type: "object" }, input: { type: "array", items: EVENT }, expect: { type: "array", items: EVENT } } } } } },
    async execute(input, signal) {
      if (input.guide === true) return { text: GUIDE };
      const checked = checkSpec(input);
      if ("problems" in checked) return { text: JSON.stringify({ problems: checked.problems, next: "Fix these and call make_device again." }), isError: true };
      const spec = checked.spec;
      const verified = checkMidiDevice(spec);
      if (verified.problems.length) return { text: JSON.stringify({ problems: verified.problems, passed: `${verified.passed} of ${verified.of} of its tests`, next: "Fix the code (or a test that's wrong) and call make_device again." }), isError: true };
      signal.throwIfAborted();
      // Where Live's Browser looks: a folder that stays, so new files are noticed quickly.
      const folder = join(options.userLibrary, "Kumi");
      // A device file cut short by a full disk would load as a broken device.
      const full = await lowDisk(options.userLibrary, 100 * MB, "Live's User Library is on");
      if (full) return { text: `${full} No device was made.`, isError: true };
      await mkdir(folder, { recursive: true, mode: 0o755 });
      const name = freeName(folder, spec.name);
      const file = join(folder, `${name}.amxd`);
      const temporary = join(folder, `.${randomUUID()}.amxd`);
      try { await writeFile(temporary, encodeAmxd("midi_effect", midiDevicePatcher({ ...spec, name })), { mode: 0o644 }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
      // Live's Browser lists a device by its name, without the extension.
      const itemId = `user_library/Kumi/${name}`;
      const deadline = Date.now() + (options.waitMs ?? 20_000);
      let seen = false;
      while (!seen && Date.now() < deadline) {
        seen = await options.browserSees(itemId, signal).catch(() => false);
        if (!seen) await new Promise((resolve) => setTimeout(resolve, 400));
        signal.throwIfAborted();
      }
      return { text: JSON.stringify({ made: name, type: "MIDI effect", itemId, controls: spec.controls.map(describeControl),
        tests: `${verified.passed} of ${verified.of} of its tests passed, and Kumi's checks (no errors, no hanging notes)`,
        ...(seen ? {} : { note: "Live's Browser hasn't listed it yet; load it in a moment." }),
        next: "load_device with this itemId on the MIDI track; Live puts a MIDI effect before the instrument." }) };
    },
  };
}
