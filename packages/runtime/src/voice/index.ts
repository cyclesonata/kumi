/**
 * Talking to Kumi: the producer's voice from the microphone, written down on this computer by
 * whisper.cpp. ffmpeg hears the microphone and the samples stay in memory; once the producer stops,
 * they're written to a private temporary file for whisper.cpp, deleted as soon as it's done. Nothing
 * is sent anywhere. KUMI_VOICE_INPUT names a sound file to hear in place of the microphone, at its own
 * pace (for tests and checks with nobody at the microphone).
 */
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ffmpegHint, findFfmpeg, findWhisper, vadModel, whisperAsset, whisperHint, whisperModel } from "../video/programs.js";
import { speechModelFor, transcribe } from "../video/speech.js";
import { listMicrophones, microphoneAllowed, microphoneInput, RATE, startCapture, terminalApp } from "./microphone.js";

export { listMicrophones, microphoneAllowed, parseMicrophones, terminalApp, type Capture } from "./microphone.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Why Kumi couldn't listen or write down, in words for the producer, and what kind of trouble it is,
 * so the app can offer the fix: the privacy settings, another microphone, or programs to install.
 */
export type VoiceTrouble = "missing" | "permission" | "device" | "silence" | "quiet" | "words" | "failed";
export class VoiceError extends Error {
  constructor(readonly trouble: VoiceTrouble, message: string) { super(message); }
}

/** Listening goes on this long after it's told to stop: the end of the last word is still on its way. */
const TAIL_MS = 250;

export interface Heard {
  /** 16 kHz mono 16-bit samples. */
  pcm: Buffer;
  seconds: number;
  /** The loudest sample's size; 0 is digital silence. */
  peak: number;
  /** Whether a voice was heard above the room. */
  spoke: boolean;
}

export interface Listening {
  /** Seconds heard so far. */
  readonly seconds: number;
  /** Whether a voice has been heard yet, and how long ago it was last heard (milliseconds). */
  readonly spoke: boolean;
  readonly quietMs: number;
  /** The loudest level since it was last asked, 0–1, for a meter. */
  level(): number;
  /** Stop listening, a moment later: what was heard. */
  stop(): Promise<Heard>;
  /** Stop and drop it. */
  cancel(): void;
  /** Resolves only when the microphone stops by itself: why, or undefined when a test's file played through. */
  readonly ended: Promise<VoiceError | undefined>;
}

export interface VoiceOptions {
  env?: Env;
  /** Where Kumi keeps the programs and speech models it fetches (~/.kumi/tools). */
  toolsDir: string;
  platform?: string;
  signal?: AbortSignal;
  /** Said once when Kumi fetches a program or the speech model. */
  onFetch?: (message: string) => void;
  /** How far a fetch is, in words for a status line: "getting the speech model · 45%". */
  onProgress?: (text: string) => void;
}

const fetching = (what: string, onProgress: ((text: string) => void) | undefined) => onProgress && { onProgress: (fraction: number) => onProgress(`getting ${what} · ${Math.round(fraction * 100)}%`) };

/** What to install where Kumi can't fetch ffmpeg or whisper.cpp itself (a Mac). */
function missing(platform: string, ffmpeg: boolean, whisper: boolean): VoiceError {
  const both = !ffmpeg && !whisper;
  const what = both ? "ffmpeg, which hears the microphone, and whisper.cpp, which writes down what you say on this computer"
    : !ffmpeg ? "ffmpeg, which hears the microphone" : "whisper.cpp, which writes down what you say on this computer";
  const install = platform === "darwin" ? `brew install ${[!ffmpeg ? "ffmpeg" : "", !whisper ? "whisper-cpp" : ""].filter(Boolean).join(" ")}`
    : [!ffmpeg ? ffmpegHint() : "", !whisper ? whisperHint() : ""].filter(Boolean).join("; ");
  return new VoiceError("missing", `Talking to Kumi needs ${what}. Install ${both ? "them" : "it"}: ${install}`);
}

/** What else keeps a microphone from Kumi, by system: its privacy settings, or a muted input. */
function keptQuiet(platform: string, env: Env, after: "open" | "silence"): string {
  if (platform === "darwin") {
    return after === "open" ? ` If macOS asked whether ${terminalApp(env)} may use the microphone, allow it (System Settings › Privacy & Security › Microphone).`
      : ` Allow ${terminalApp(env)} in System Settings › Privacy & Security › Microphone (macOS may just have asked), and check that the microphone isn't muted.`;
  }
  if (platform === "win32") return ` Check that desktop apps may use the microphone (Settings › Privacy & security › Microphone)${after === "open" ? " and that no other app holds it" : " and that it isn't muted"}.`;
  return after === "silence" ? " Check that it isn't muted." : "";
}

/** Once macOS has said the terminal may use the microphone, it isn't asked again. */
let allowed = false;

/**
 * Open the microphone and listen. A Mac whose terminal isn't allowed the microphone says so first;
 * ffmpeg is found (fetched, off a Mac); resolves once sound arrives.
 */
export async function listen(options: VoiceOptions & { microphone?: string; ffmpeg?: string }): Promise<Listening> {
  const env = options.env ?? process.env; const platform = options.platform ?? process.platform;
  const file = env.KUMI_VOICE_INPUT;
  if (file && !existsSync(file)) throw new VoiceError("device", `KUMI_VOICE_INPUT names ${file}, which isn't there.`);
  // Off a Mac, Kumi fetches ffmpeg (now) and whisper.cpp (while the producer talks). On a Mac both are
  // the producer's to install, so they're asked for before anything is said.
  const fetches = Boolean(whisperAsset(platform));
  const [ffmpeg, whisper] = await Promise.all([
    options.ffmpeg ?? findFfmpeg({ env, toolsDir: options.toolsDir, purpose: "which it hears the microphone through", ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onFetch ? { onFetch: options.onFetch } : {}), ...fetching("ffmpeg", options.onProgress) }),
    fetches || findWhisper({ env, toolsDir: options.toolsDir, installedOnly: true }).then(Boolean)]);
  if (!fetches && (!ffmpeg || !whisper)) throw missing(platform, Boolean(ffmpeg), whisper);
  if (!ffmpeg) throw new VoiceError("missing", `Kumi hears the microphone through ffmpeg, and couldn't fetch it just now. Check the connection and try again, or install it: ${ffmpegHint()}`);
  if (!file && !allowed) {
    const answer = await microphoneAllowed(platform);
    if (answer === false) throw new VoiceError("permission", `macOS isn't letting ${terminalApp(env)} use the microphone. Allow it in System Settings › Privacy & Security › Microphone, then try again.`);
    allowed = answer === true;
  }
  let device = options.microphone;
  if (!file && platform === "win32" && !device) {
    device = (await listMicrophones(ffmpeg, platform))[0];
    if (!device) throw new VoiceError("device", "Kumi found no microphone on this computer. Plug one in, or check that Windows sees it (Settings › System › Sound › Input).");
  }
  const stopped = new Promise<string>((resolve) => options.signal?.addEventListener("abort", () => resolve("stopped"), { once: true }));
  const open = async (input: string[]) => {
    options.signal?.throwIfAborted();
    const capture = startCapture(ffmpeg, input);
    const failed = await Promise.race([capture.started.then(() => undefined), capture.ended.then((why) => why ?? "it sent no sound"), stopped]);
    if (failed !== undefined || options.signal?.aborted) { void capture.stop(); options.signal?.throwIfAborted(); }
    return { capture, failed };
  };
  let { capture, failed } = await open(file ? ["-re", "-i", file] : microphoneInput(platform, device));
  // An ffmpeg built without PulseAudio (some Linux builds) hears ALSA's default instead.
  if (failed && !file && platform === "linux" && /pulse/i.test(failed)) ({ capture, failed } = await open(["-f", "alsa", "-i", device || "default"]));
  if (failed !== undefined) throw new VoiceError("device", `Kumi couldn't open the microphone (${failed}).${keptQuiet(platform, env, "open")}`);
  const abandon = () => { void capture.stop(); };
  return {
    get seconds() { return capture.seconds; },
    get spoke() { return capture.meter.speaking; },
    get quietMs() { return capture.meter.quietMs; },
    level: () => capture.meter.take(),
    async stop() {
      await delay(TAIL_MS);
      await capture.stop();
      return { pcm: capture.pcm(), seconds: capture.seconds, peak: capture.meter.peak, spoke: capture.meter.spoke };
    },
    cancel: abandon,
    ended: capture.ended.then((why) => (why === undefined ? undefined : new VoiceError("device", `The microphone stopped (${why}).`))),
  };
}

/** A WAV file of 16 kHz mono 16-bit samples. */
export function wavFile(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * What whisper is told to expect: a producer's words, Live's devices, and the names the producer's Set
 * uses, spelled as the Set spells them. A sentence about the talk, not a request: whisper takes its
 * cue from it, and anything of it heard back is never something to do.
 */
export function voicePrompt(names: readonly string[] = []): string {
  const own = [...new Set(names.map((name) => name.replace(/\s+/g, " ").trim()).filter((name) => name && name.length <= 40))].slice(0, 12);
  return `A producer talks to Kumi about the bass, the kick, the hats and the pad in their Ableton Live Set${own.length ? ` (${own.join(", ")})` : ""}, with Operator, Wavetable, Drift, Simpler, Drum Rack, Saturator, Roar, EQ Eight, Glue Compressor and Auto Filter.`;
}

/** What whisper says it heard in silence or noise, which nobody said. */
const PHANTOMS = new Set(["you", "thank you", "thanks", "thank you for watching", "thanks for watching", "bye", "the end", "subscribe", "please subscribe", "ご視聴ありがとうございました"]);

/** whisper's words as the producer's: its marks for sounds dropped, spaces tidied, phantom phrases gone. */
export function cleanWords(text: string): string {
  const words = text.replace(/\[[^\]]*\]|\*[^*]*\*/g, " ").replace(/\s+/g, " ").trim();
  const bare = words.toLowerCase().replace(/[.!?,。！？、\s]+$/u, "").replace(/^[.!?,\s]+/, "");
  return !bare || PHANTOMS.has(bare) ? "" : words;
}

/**
 * whisper's audio context for a recording this long: the recording and a little more, in its frames
 * (50 a second, 1500 at most); a short one is then written down several times faster.
 */
export const audioContextFor = (seconds: number) => Math.min(1500, Math.ceil(((seconds + 2) * 50) / 64) * 64);

/**
 * Write down what was heard: in `language` ("en", another language's code, or "auto" to detect it),
 * expecting `names` (the Set's own). whisper.cpp and its speech model are found, or fetched the first time.
 */
export async function writeDown(heard: Heard, options: VoiceOptions & { language?: string; names?: readonly string[] }): Promise<string> {
  const env = options.env ?? process.env; const platform = options.platform ?? process.platform;
  if (!heard.pcm.length || heard.peak === 0) throw new VoiceError("silence", `Kumi got only silence from the microphone.${keptQuiet(platform, env, "silence")}`);
  if (!heard.spoke) throw new VoiceError("quiet", "Kumi didn't hear you: the microphone picked up only quiet. Speak a little closer, or check its input level.");
  const progress = (what: string) => ({ ...(options.signal ? { signal: options.signal } : {}), ...(options.onFetch ? { onFetch: options.onFetch } : {}), ...fetching(what, options.onProgress) });
  const whisper = await findWhisper({ env, toolsDir: options.toolsDir, purpose: "which writes down what you say, on this computer", ...progress("whisper.cpp") }).catch((error: unknown) => {
    options.signal?.throwIfAborted();
    throw new VoiceError("missing", `Kumi writes down what you say with whisper.cpp, and couldn't fetch it just now (${error instanceof Error ? error.message.slice(0, 160) : "it failed"}).`);
  });
  if (!whisper) throw missing(platform, true, false);
  const language = options.language ?? "en";
  const [model, vad] = await Promise.all([
    whisperModel(speechModelFor(language), { env, toolsDir: options.toolsDir, purpose: "to write down what you say", ...progress("the speech model") }).catch((error: unknown) => {
      options.signal?.throwIfAborted();
      throw new VoiceError("missing", `Kumi needs a speech model to write down what you say, and couldn't fetch it (${error instanceof Error ? error.message.slice(0, 200) : "it failed"}).`);
    }),
    // Without it (offline the first time), the level of what was heard still keeps out a quiet room.
    vadModel({ env, toolsDir: options.toolsDir, ...(options.signal ? { signal: options.signal } : {}) }).catch(() => undefined)]);
  const folder = await mkdtemp(join(tmpdir(), "kumi-voice-"));
  try {
    const wav = join(folder, "voice.wav");
    await writeFile(wav, wavFile(heard.pcm), { mode: 0o600 });
    // whisper's cue is in English: it helps English, and would only pull another language toward it.
    const english = /^en\b/i.test(language);
    const write = (withVad: string | undefined) => transcribe(whisper, model, wav, { language, audioContext: audioContextFor(heard.seconds), timeoutMs: 120_000,
      ...(english ? { prompt: voicePrompt(options.names) } : {}), ...(withVad ? { vad: withVad } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    // A whisper.cpp from before its voice activity detection writes it all down instead.
    const cues = await write(vad).catch((error: unknown) => { options.signal?.throwIfAborted(); if (vad) return write(undefined); throw error; }).catch((error: unknown) => {
      options.signal?.throwIfAborted();
      throw new VoiceError("failed", `Kumi couldn't write down what you said (${error instanceof Error ? error.message.slice(0, 200) : "whisper.cpp failed"}).`);
    });
    const words = cleanWords(cues.map((cue) => cue.text).join(" "));
    if (!words) throw new VoiceError("words", "Kumi couldn't make out any words. Try again, a little closer to the microphone.");
    return words;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

/**
 * whisper.cpp (fetched, off a Mac), the speech model for `language` and the voice activity model, made
 * ready ahead: started as the producer starts talking, so what they say is written down as they stop.
 */
export async function prepareVoice(options: VoiceOptions & { language?: string }): Promise<void> {
  const env = options.env ?? process.env;
  const io = { ...(options.signal ? { signal: options.signal } : {}), ...(options.onFetch ? { onFetch: options.onFetch } : {}) };
  await findWhisper({ env, toolsDir: options.toolsDir, purpose: "which writes down what you say, on this computer", ...io, ...fetching("whisper.cpp", options.onProgress) });
  await whisperModel(speechModelFor(options.language ?? "en"), { env, toolsDir: options.toolsDir, purpose: "to write down what you say", ...io, ...fetching("the speech model", options.onProgress) });
  await vadModel({ env, toolsDir: options.toolsDir, ...io });
}

export interface VoiceReadiness {
  ffmpeg?: string;
  whisper?: string;
  /** The speech model for the producer's language, and where it is once fetched. */
  model: { name: string; path?: string };
  /** Kumi fetches missing programs itself here (off a Mac). */
  fetches: boolean;
  /** On a Mac: whether the terminal may use the microphone; undefined until macOS has asked. */
  allowed?: boolean;
}

/** What talking to Kumi needs, and what's here: nothing is fetched (for the doctor). */
export async function voiceReadiness(options: { env?: Env; toolsDir: string; platform?: string; language?: string }): Promise<VoiceReadiness> {
  const env = options.env ?? process.env; const platform = options.platform ?? process.platform;
  const [ffmpeg, whisper, allowed] = await Promise.all([findFfmpeg({ env, toolsDir: options.toolsDir, installedOnly: true }), findWhisper({ env, toolsDir: options.toolsDir, installedOnly: true }),
    microphoneAllowed(platform)]);
  const name = speechModelFor(options.language ?? "en");
  const path = env.KUMI_WHISPER_MODEL ?? join(options.toolsDir, "whisper-models", name);
  const present = existsSync(path) && statSync(path).size > 0;
  return { ...(ffmpeg ? { ffmpeg } : {}), ...(whisper ? { whisper } : {}), model: { name, ...(present ? { path } : {}) }, fetches: Boolean(whisperAsset(platform)),
    ...(allowed !== undefined ? { allowed } : {}) };
}
