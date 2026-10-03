import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findFfmpeg, findWhisper, VAD_MODEL, vadModel, whisperModel } from "../src/video/programs.js";
import { audioContextFor, cleanWords, listen, VoiceError, voicePrompt, voiceReadiness, wavFile, writeDown, type Heard } from "../src/voice/index.js";
import { Meter, microphoneInput, parseMicrophones, terminalApp } from "../src/voice/microphone.js";
import { wav } from "./fixtures/synthetic-audio.js";

const folder = mkdtempSync(join(tmpdir(), "kumi-voice-test-"));
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));
const ffmpeg = await findFfmpeg();
const needsFfmpeg = !ffmpeg && "ffmpeg plays the test's voice in place of a microphone";

const RATE = 48000;
/** A voice, as levels go: bursts of a buzzy tone (words), with pauses, over a quiet room. */
function voice(seconds: number, words: [number, number][]): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE)); let x = 3;
  for (let index = 0; index < out.length; index++) { x = (x * 1103515245 + 12345) % 2147483648; out[index] = 0.0015 * (x / 1073741824 - 1); }
  for (const [from, to] of words) for (let index = Math.round(from * RATE); index < Math.round(to * RATE) && index < out.length; index++) out[index]! += 0.25 * (2 * ((index * 180 / RATE) % 1) - 1);
  return out;
}
const samples = (signal: Float32Array, every = 3) => Int16Array.from({ length: Math.floor(signal.length / every) }, (_, index) => Math.round(signal[index * every]! * 32767));

test("ffmpeg hears the microphone by each system's own way: AVFoundation's default, a DirectShow device by name, PulseAudio", () => {
  assert.deepEqual(microphoneInput("darwin", undefined), ["-f", "avfoundation", "-i", ":default"]);
  assert.deepEqual(microphoneInput("darwin", "Scarlett 2i2 USB"), ["-f", "avfoundation", "-i", ":Scarlett 2i2 USB"]);
  assert.deepEqual(microphoneInput("win32", "Microphone (Realtek(R) Audio)"), ["-f", "dshow", "-audio_buffer_size", "50", "-i", "audio=Microphone (Realtek(R) Audio)"]);
  assert.deepEqual(microphoneInput("linux", undefined), ["-f", "pulse", "-i", "default"]);
});

test("the microphones come from ffmpeg's device listing: a Mac's audio devices, Windows' in either ffmpeg's way", () => {
  const mac = ["[AVFoundation indev @ 0x7f8] AVFoundation video devices:", "[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera", "[AVFoundation indev @ 0x7f8] [1] Capture screen 0",
    "[AVFoundation indev @ 0x7f8] AVFoundation audio devices:", "[AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone", "[AVFoundation indev @ 0x7f8] [1] Scarlett 2i2 USB", "[in#0 @ 0x600] Error opening input: Input/output error"].join("\n");
  assert.deepEqual(parseMicrophones(mac, "darwin"), ["MacBook Pro Microphone", "Scarlett 2i2 USB"]);
  const windows = ['[dshow @ 000001] "Integrated Camera" (video)', '[dshow @ 000001]   Alternative name "@device_pnp_\\\\?\\usb#vid"', '[dshow @ 000001] "Microphone (Realtek(R) Audio)" (audio)',
    '[dshow @ 000001]   Alternative name "@device_cm_{33D9A762}\\wave_{5B3}"', '[dshow @ 000001] "マイク (USB Audio)" (audio)', "dummy: Immediate exit requested"].join("\r\n");
  assert.deepEqual(parseMicrophones(windows, "win32"), ["Microphone (Realtek(R) Audio)", "マイク (USB Audio)"]);
  const older = ["[dshow @ 02] DirectShow video devices (some may be both video and audio devices)", '[dshow @ 02]  "Integrated Camera"', "[dshow @ 02] DirectShow audio devices", '[dshow @ 02]  "Line In (Focusrite USB)"'].join("\n");
  assert.deepEqual(parseMicrophones(older, "win32"), ["Line In (Focusrite USB)"]);
  assert.deepEqual(parseMicrophones(mac, "linux"), []);
});

test("the meter: digital silence, a quiet room, and a voice over it (when it last spoke); its level for a meter that moves", () => {
  const silent = new Meter();
  silent.push(new Int16Array(16_000));
  assert.equal(silent.peak, 0);
  assert.equal(silent.spoke, false);
  const room = new Meter();
  room.push(samples(voice(2, [])));
  assert.ok(room.peak > 0 && !room.spoke && !room.speaking, "a room's own noise isn't a voice");
  assert.ok(room.take() < 0.15, "the meter sits low in a quiet room");
  const talking = new Meter();
  talking.push(samples(voice(4, [[0.5, 1.2], [1.5, 2.2]])));
  assert.ok(talking.spoke && talking.speaking);
  assert.ok(Math.abs(talking.quietMs - 1800) < 100, `quiet since the last word: ${talking.quietMs}`);
  assert.ok(talking.floor < -55, `the room's level: ${talking.floor}`);
  assert.ok(talking.take() > 0.6, "the loudest level since it was last asked");
  assert.equal(talking.take(), 0, "and then afresh");
  // A click or two isn't a voice.
  const click = new Meter();
  const clicks = samples(voice(2, [[1, 1.04]]));
  click.push(clicks);
  assert.equal(click.spoke, false);
});

test("what's heard becomes a WAV whisper.cpp reads: 16 kHz mono 16-bit", () => {
  const pcm = Buffer.alloc(32_000, 1);
  const file = wavFile(pcm);
  assert.equal(file.length, 44 + 32_000);
  assert.equal(file.toString("ascii", 0, 4), "RIFF"); assert.equal(file.toString("ascii", 8, 12), "WAVE"); assert.equal(file.toString("ascii", 36, 40), "data");
  assert.deepEqual([file.readUInt16LE(22), file.readUInt32LE(24), file.readUInt16LE(34), file.readUInt32LE(40)], [1, 16_000, 16, 32_000]);
});

test("whisper's words become the producer's: its sound marks dropped, and the phrases it hears in silence gone", () => {
  assert.equal(cleanWords("  Make the bass   darker [BLANK_AUDIO] "), "Make the bass darker");
  assert.equal(cleanWords(" you"), "");
  assert.equal(cleanWords("Thank you."), "");
  assert.equal(cleanWords("[Music] *laughs*"), "");
  assert.equal(cleanWords("."), "");
  assert.equal(cleanWords("Thank you, now add a reverb."), "Thank you, now add a reverb.");
  // whisper reads the recording and a little more, never past its window.
  assert.equal(audioContextFor(1), 192);
  assert.ok(audioContextFor(4.5) < audioContextFor(12) && audioContextFor(12) < 1500);
  assert.equal(audioContextFor(40), 1500);
  // It's told to expect a producer's words, Live's devices and the Set's own names, once each, in a
  // sentence about the talk: whatever of it whisper might hear back is never something to do.
  const prompt = voicePrompt(["Night Drive", "Bass", "Bass", "x".repeat(60)]);
  assert.match(prompt, /^A producer talks to Kumi about the bass, .* Ableton Live Set \(Night Drive, Bass\), with Operator, Wavetable/);
  assert.ok(!prompt.includes("xxxx"));
});

test("the terminal macOS asks about is named as the producer knows it", () => {
  assert.equal(terminalApp({ __CFBundleIdentifier: "com.googlecode.iterm2", TERM_PROGRAM: "tmux" }), "iTerm2");
  assert.equal(terminalApp({ TERM_PROGRAM: "Apple_Terminal" }), "Terminal");
  assert.equal(terminalApp({ TERM_PROGRAM: "ghostty" }), "Ghostty");
  assert.equal(terminalApp({}), "your terminal app");
});

test("on a Mac, talking needs ffmpeg and whisper.cpp first: Kumi says the one command that installs what's missing", async () => {
  const missing = join(folder, "not-here");
  const both = await listen({ env: { KUMI_FFMPEG: missing, KUMI_WHISPER: missing }, toolsDir: join(folder, "tools"), platform: "darwin" }).catch((error: unknown) => error);
  assert.ok(both instanceof VoiceError && both.trouble === "missing");
  assert.match(both.message, /needs ffmpeg, which hears the microphone, and whisper\.cpp, which writes down what you say on this computer\. Install them: brew install ffmpeg whisper-cpp$/);
  const whisper = await listen({ env: { KUMI_FFMPEG: process.execPath, KUMI_WHISPER: missing }, toolsDir: join(folder, "tools"), platform: "darwin" }).catch((error: unknown) => error);
  assert.match(String((whisper as Error).message), /needs whisper\.cpp.*Install it: brew install whisper-cpp$/);
  const nothing = await listen({ env: { KUMI_VOICE_INPUT: join(folder, "nothing.wav") }, toolsDir: join(folder, "tools") }).catch((error: unknown) => error);
  assert.match(String((nothing as Error).message), /KUMI_VOICE_INPUT names .*nothing\.wav, which isn't there/);
});

test("a voice played in place of the microphone is heard at its own pace, with its level, and ends when it does", { skip: needsFfmpeg }, async () => {
  const file = wav("voice.wav", voice(2.5, [[0.3, 1.0], [1.3, 1.9]]));
  const env = { ...process.env, KUMI_VOICE_INPUT: file };
  const started = performance.now();
  const listening = await listen({ env, toolsDir: join(folder, "tools"), ffmpeg: ffmpeg! });
  const levels: number[] = [];
  const meter = setInterval(() => levels.push(listening.level()), 100);
  assert.equal(await listening.ended, undefined, "a file that plays through ends, as if the producer stopped");
  clearInterval(meter);
  assert.ok(performance.now() - started > 1_500, "heard at its own pace, as a microphone would be");
  assert.ok(listening.spoke);
  assert.ok(Math.max(...levels) > 0.6 && Math.min(...levels) < 0.2, `the meter moves: ${levels.map((level) => level.toFixed(1)).join(" ")}`);
  const heard = await listening.stop();
  assert.ok(Math.abs(heard.seconds - 2.5) < 0.2, `${heard.seconds} s`);
  assert.ok(heard.peak > 5_000 && heard.spoke);
  assert.equal(heard.pcm.length, Math.round(heard.seconds * 16_000) * 2);
});

test("written down only when there's a voice: silence and quiet say what's wrong instead", { skip: needsFfmpeg }, async () => {
  const hear = async (signal: Float32Array, name: string): Promise<Heard> => {
    const listening = await listen({ env: { ...process.env, KUMI_VOICE_INPUT: wav(name, signal) }, toolsDir: join(folder, "tools"), ffmpeg: ffmpeg! });
    await listening.ended;
    return listening.stop();
  };
  const silent = await writeDown(await hear(new Float32Array(RATE), "silent.wav"), { toolsDir: join(folder, "tools"), platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal" } }).catch((error: unknown) => error);
  assert.ok(silent instanceof VoiceError && silent.trouble === "silence");
  assert.match(silent.message, /^Kumi got only silence from the microphone\. Allow Terminal in System Settings › Privacy & Security › Microphone/);
  const windows = await writeDown(await hear(new Float32Array(RATE), "silent-windows.wav"), { toolsDir: join(folder, "tools"), platform: "win32", env: {} }).catch((error: unknown) => error);
  assert.match(String((windows as Error).message), /desktop apps may use the microphone \(Settings › Privacy & security › Microphone\)/);
  const quiet = await writeDown(await hear(voice(1.5, []), "room.wav"), { toolsDir: join(folder, "tools"), env: {} }).catch((error: unknown) => error);
  assert.ok(quiet instanceof VoiceError && quiet.trouble === "quiet");
  assert.match(quiet.message, /didn't hear you/);
});

// Only where whisper.cpp, a speech model (KUMI_WHISPER_MODEL) and a voice to make the recording (macOS's say) are all here.
const whisper = process.env.KUMI_WHISPER_MODEL ? await findWhisper({ toolsDir: join(folder, "tools"), installedOnly: true }) : undefined;
const canSpeak = process.platform === "darwin" && Boolean(ffmpeg && whisper);
test("what's said is written down on this computer, Live's words spelled right", { skip: !canSpeak && "needs whisper.cpp, KUMI_WHISPER_MODEL and macOS's say" }, async () => {
  const spoken = join(folder, "spoken.aiff");
  execFileSync("say", ["-o", spoken, "Put a Saturator after the Operator on the bass."]);
  const listening = await listen({ env: { ...process.env, KUMI_VOICE_INPUT: spoken }, toolsDir: join(folder, "tools"), ffmpeg: ffmpeg! });
  await listening.ended;
  const words = await writeDown(await listening.stop(), { toolsDir: join(folder, "tools"), language: "en", names: ["Bass"] });
  assert.match(words, /saturator after the operator on the bass/i);
});

test("the speech model is fetched with how far it's got, and says what it's for", async () => {
  const model = new TextEncoder().encode("a speech model");
  const sha = createHash("sha256").update(model).digest("hex");
  const tree = async (url: string) => (url.includes("/api/models/") ? new TextEncoder().encode(JSON.stringify([{ path: "ggml-tiny.en.bin", size: model.length, lfs: { oid: sha } }])) : model);
  const told: string[] = []; const progress: number[] = [];
  await whisperModel("ggml-tiny.en.bin", { toolsDir: join(folder, "fetched"), env: {}, download: tree, free: async () => 1e12, purpose: "to write down what you say",
    onFetch: (message) => told.push(message), onProgress: (fraction) => progress.push(fraction) });
  assert.deepEqual(told, ["Kumi is fetching a speech model, to write down what you say (once, about 0 MB)."]);
  assert.deepEqual(progress, [1]);
  // The voice activity model, which keeps music and noise from being written down, comes from its own place, without a word.
  const vad = new TextEncoder().encode("a voice activity model");
  const vadSha = createHash("sha256").update(vad).digest("hex");
  const asked: string[] = [];
  const path = await vadModel({ toolsDir: join(folder, "fetched"), env: { KUMI_WHISPER_MODEL: join(folder, "elsewhere.bin") }, free: async () => 1e12, onFetch: (message) => told.push(message),
    download: async (url) => { asked.push(url); return url.includes("/api/models/") ? new TextEncoder().encode(JSON.stringify([{ path: VAD_MODEL, size: vad.length, lfs: { oid: vadSha } }])) : vad; } });
  assert.equal(path, join(folder, "fetched", "whisper-models", VAD_MODEL), "KUMI_WHISPER_MODEL names the speech model only");
  assert.deepEqual(asked, ["https://huggingface.co/api/models/ggml-org/whisper-vad/tree/main", `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_MODEL}`]);
  assert.equal(told.length, 1);
});

test("what talking needs and has, looked up without fetching or asking anything", async () => {
  const model = join(folder, "model.bin"); writeFileSync(model, "a model");
  const ready = await voiceReadiness({ env: { KUMI_FFMPEG: process.execPath, KUMI_WHISPER: process.execPath, KUMI_WHISPER_MODEL: model }, toolsDir: join(folder, "ready"), platform: "linux" });
  assert.deepEqual(ready, { ffmpeg: process.execPath, whisper: process.execPath, model: { name: "ggml-small.en-q5_1.bin", path: model }, fetches: true });
  const bare = await voiceReadiness({ env: { KUMI_FFMPEG: join(folder, "none"), KUMI_WHISPER: join(folder, "none") }, toolsDir: join(folder, "bare"), platform: "win32", language: "ja" });
  assert.deepEqual(bare, { model: { name: "ggml-small-q5_1.bin" }, fetches: true });
});
