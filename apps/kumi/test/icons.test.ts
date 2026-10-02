import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceKind, detectIconStyle, icon, ICONS, trackKind, type IconKind } from "../src/tui/icons.js";
import { textWidth } from "../src/tui/width.js";

test("every icon is exactly two cells, as a glyph or a badge, and each badge is its own", () => {
  const kinds = Object.keys(ICONS) as IconKind[];
  for (const kind of kinds) {
    assert.equal(textWidth(icon(kind, "glyphs").text), 2, kind);
    assert.equal(textWidth(icon(kind, "badges").text), 2, kind);
    assert.match(icon(kind, "badges").text, /^[A-Z]{2}$/, kind);
    // Box drawing, blocks, geometric shapes and a few symbols: nothing from Braille or the emoji ranges.
    const code = ICONS[kind].glyph.codePointAt(0)!;
    assert.ok(!(code >= 0x2800 && code <= 0x28ff) && code < 0x1f000, `${kind} uses a character every terminal draws`);
  }
  assert.equal(new Set(kinds.map((kind) => ICONS[kind].badge)).size, kinds.length);
});

test("the tint is on the icon only, and a track's is its own colour", () => {
  assert.deepEqual(icon("midi-track", "glyphs", [200, 40, 40]).style, { fg: [200, 40, 40] });
  assert.equal(icon("audio-effect", "glyphs").style.bold, undefined);
});

test("badges stand in where glyphs may not show: chosen outright, or on the Linux console and the old Windows console", () => {
  assert.equal(detectIconStyle({ TERM_PROGRAM: "ghostty" }, "darwin"), "glyphs");
  assert.equal(detectIconStyle({ WT_SESSION: "x" }, "win32"), "glyphs", "Windows Terminal");
  assert.equal(detectIconStyle({ TERM_PROGRAM: "vscode" }, "win32"), "glyphs");
  assert.equal(detectIconStyle({ TERM_PROGRAM: "WezTerm" }, "win32"), "glyphs", "any terminal that names itself");
  assert.equal(detectIconStyle({ TERM_PROGRAM: "mintty", TERM: "xterm" }, "win32"), "glyphs", "Git Bash's own window");
  assert.equal(detectIconStyle({}, "win32"), "badges", "the old console");
  assert.equal(detectIconStyle({ TERM: "linux" }, "linux"), "badges");
  assert.equal(detectIconStyle({ KUMI_ICONS: "badges", TERM_PROGRAM: "ghostty" }, "darwin"), "badges");
  assert.equal(detectIconStyle({ KUMI_ICONS: "glyphs" }, "win32"), "glyphs");
});

test("a device's kind comes from its class, its chains and pads, and Live's device type when the bridge sends it", () => {
  assert.equal(deviceKind({ className: "DrumGroupDevice", canHaveChains: true, canHaveDrumPads: true }), "drum-rack");
  assert.equal(deviceKind({ className: "InstrumentGroupDevice", canHaveChains: true }), "instrument-rack");
  assert.equal(deviceKind({ className: "AudioEffectGroupDevice", canHaveChains: true }), "audio-rack");
  assert.equal(deviceKind({ className: "MidiEffectGroupDevice", canHaveChains: true }), "midi-rack");
  assert.equal(deviceKind({ className: "MxDeviceMidiEffect" }), "max-midi");
  assert.equal(deviceKind({ className: "MxDeviceInstrument" }), "max-instrument");
  assert.equal(deviceKind({ className: "MxDeviceAudioEffect" }), "max-audio");
  assert.equal(deviceKind({ className: "PluginDevice" }), "plugin");
  assert.equal(deviceKind({ className: "AuPluginDevice" }), "plugin");
  assert.equal(deviceKind({ className: "Saturator", deviceType: "audio_effect" }), "audio-effect");
  assert.equal(deviceKind({ className: "Operator", deviceType: "instrument" }), "instrument");
  assert.equal(deviceKind({ className: "Arpeggiator", deviceType: "midi_effect" }), "midi-effect");
  assert.equal(deviceKind({ className: "Saturator" }), "device", "without Live's type, a plain device");
  assert.equal(trackKind("group"), "group-track"); assert.equal(trackKind(undefined), "audio-track");
});
