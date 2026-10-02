import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings, writeSettings } from "../src/config.js";
import { voiceCheck } from "../src/doctor.js";
import { languageName } from "../src/tui/app.js";
import { createVoiceControl, systemLanguage } from "../src/voice.js";

test("how the producer talks to Kumi is kept in the settings file, beside the model, and nothing that isn't a setting is", () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-voice-settings-"));
  try {
    const file = join(dir, "settings.json");
    writeSettings(file, { model: "anthropic/claude-sonnet-5", voice: { send: true, language: "ja", microphone: "Scarlett 2i2 USB" } });
    assert.deepEqual(readSettings(file).voice, { send: true, language: "ja", microphone: "Scarlett 2i2 USB" });
    // Choosing a model keeps them.
    writeSettings(file, { model: "openai/gpt-6-luna" });
    assert.deepEqual(readSettings(file), { model: "openai/gpt-6-luna", voice: { send: true, language: "ja", microphone: "Scarlett 2i2 USB" } });
    writeFileSync(file, JSON.stringify({ voice: { send: "yes", language: "Klingon", microphone: "Mic\u0007" } }));
    assert.deepEqual(readSettings(file), {}, "what isn't a voice setting is left out");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Kumi expects the computer's language until the producer chooses, and keeps what they choose", () => {
  assert.equal(systemLanguage({ LANG: "ja_JP.UTF-8" }), "ja");
  assert.equal(systemLanguage({ LC_ALL: "de_DE.UTF-8", LANG: "en_US.UTF-8" }), "de");
  assert.equal(systemLanguage({ LANG: "C" }), "en");
  assert.equal(languageName("ja"), "Japanese");
  assert.equal(languageName("auto"), "any language");
  const dir = mkdtempSync(join(tmpdir(), "kumi-voice-control-"));
  try {
    const settingsFile = join(dir, "settings.json");
    const opened: string[] = [];
    const voice = createVoiceControl({ env: { LANG: "ja_JP.UTF-8" }, toolsDir: join(dir, "tools"), settingsFile, open: (url) => opened.push(url), platform: "darwin" });
    assert.equal(voice.systemLanguage, "ja");
    assert.deepEqual(voice.choices(), { send: false, language: "ja" });
    voice.choose({ send: true, language: "en", microphone: "MacBook Pro Microphone" });
    assert.deepEqual(voice.choices(), { send: true, language: "en", microphone: "MacBook Pro Microphone" });
    voice.choose({ send: false, microphone: null });
    assert.deepEqual(voice.choices(), { send: false, language: "en" });
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { voice: { language: "en" } });
    voice.openPrivacy?.();
    assert.deepEqual(opened, ["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"], "a Mac's microphone privacy settings");
    assert.equal(createVoiceControl({ toolsDir: dir, settingsFile, open: () => {}, platform: "win32" }).openPrivacy !== undefined, true);
    assert.equal(createVoiceControl({ toolsDir: dir, settingsFile, open: () => {}, platform: "linux" }).openPrivacy, undefined, "Linux has none to open");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the doctor says whether talking to Kumi is ready, and what to install; never as something to fix", () => {
  const model = { name: "ggml-small.en-q5_1.bin", path: "/tools/ggml-small.en-q5_1.bin" };
  assert.deepEqual(voiceCheck({ ffmpeg: "/opt/homebrew/bin/ffmpeg", whisper: "/opt/homebrew/bin/whisper-cli", model, fetches: false }, {}, "darwin"),
    { status: "ok", text: "Talking to Kumi (ctrl+t): ffmpeg hears the microphone, whisper.cpp writes down what you say, on this computer" });
  assert.deepEqual(voiceCheck({ ffmpeg: "/opt/homebrew/bin/ffmpeg", model, fetches: false }, {}, "darwin"),
    { status: "note", text: "Talking to Kumi (ctrl+t) needs whisper.cpp", next: "Install it: brew install whisper-cpp" });
  assert.deepEqual(voiceCheck({ model, fetches: false }, {}, "darwin"),
    { status: "note", text: "Talking to Kumi (ctrl+t) needs ffmpeg and whisper.cpp", next: "Install them: brew install ffmpeg whisper-cpp" });
  assert.deepEqual(voiceCheck({ ffmpeg: "f", whisper: "w", model, fetches: false, allowed: false }, { TERM_PROGRAM: "iTerm.app" }, "darwin"),
    { status: "note", text: "Talking to Kumi (ctrl+t): macOS isn't letting iTerm2 use the microphone", next: "Allow it in System Settings › Privacy & Security › Microphone" });
  assert.deepEqual(voiceCheck({ ffmpeg: "f", whisper: "w", model: { name: model.name }, fetches: false }, {}, "darwin"),
    { status: "ok", text: "Talking to Kumi (ctrl+t): Kumi fetches its speech model (about 190 MB) the first time you talk" });
  assert.deepEqual(voiceCheck({ model: { name: model.name }, fetches: true }, {}, "win32"),
    { status: "ok", text: "Talking to Kumi (ctrl+t): Kumi fetches ffmpeg, whisper.cpp and its speech model (about 190 MB) the first time you talk" });
});
