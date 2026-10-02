/**
 * The microphone, heard through ffmpeg (AVFoundation on a Mac, DirectShow on Windows, PulseAudio on
 * Linux) as 16 kHz mono samples kept in memory, with their level as they come. On a Mac, whether the
 * terminal Kumi runs in may use the microphone is read without asking the producer anything.
 */
import { execFile, spawn } from "node:child_process";

type Env = Readonly<Record<string, string | undefined>>;

/** Samples a second: what whisper.cpp reads. */
export const RATE = 16_000;
/** Levels are measured a block at a time (32 ms). */
const BLOCK = 512;
const BLOCK_MS = (BLOCK / RATE) * 1000;
/** Quieter than this is never a voice, however quiet the room. */
const SPEECH_DB = -50;
/** A voice is at least this much louder than the room… */
const MARGIN_DB = 12;
/** …for at least this long, all told (a word, not a click). */
const SPEECH_MS = 150;
/** The most kept: a little over the longest Kumi listens. */
const MAX_BYTES = RATE * 2 * 150;

/** ffmpeg's input for the microphone named `device` (or the system's default, where there is one). */
export function microphoneInput(platform: string, device: string | undefined): string[] {
  if (platform === "darwin") return ["-f", "avfoundation", "-i", `:${device || "default"}`];
  // DirectShow has no default device: Kumi names one (the first Windows lists, unless the producer chose).
  // Its small buffer keeps the meter quick.
  if (platform === "win32") return ["-f", "dshow", "-audio_buffer_size", "50", "-i", `audio=${device ?? ""}`];
  return ["-f", "pulse", "-i", device || "default"];
}

/** The microphones in ffmpeg's device listing, by name. */
export function parseMicrophones(listing: string, platform: string): string[] {
  const names: string[] = [];
  let audio = false;
  for (const raw of listing.split(/\r?\n/)) {
    const line = raw.replace(/^\[[^\]]*\]\s?/, "");
    if (platform === "darwin") {
      if (/AVFoundation audio devices:/.test(line)) { audio = true; continue; }
      if (/AVFoundation video devices:/.test(line)) { audio = false; continue; }
      const found = audio ? /^\[(\d+)\] (.+)$/.exec(line.trim()) : undefined;
      if (found) names.push(found[2]!.trim());
    } else if (platform === "win32") {
      // ffmpeg 5 and later mark each device "(audio)"; older ones list audio devices under a heading.
      if (/DirectShow audio devices/.test(line)) { audio = true; continue; }
      if (/DirectShow video devices/.test(line)) { audio = false; continue; }
      if (/Alternative name/.test(line)) continue;
      const found = /^\s*"(.+)"\s*(\((audio|video|none)\))?\s*$/.exec(line);
      if (found && (found[3] === "audio" || (!found[3] && audio))) names.push(found[1]!);
    }
  }
  return [...new Set(names)];
}

/** The microphones ffmpeg sees (none listed on Linux, where the system's default is used). */
export function listMicrophones(ffmpeg: string, platform: string = process.platform): Promise<string[]> {
  const args = platform === "darwin" ? ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]
    : platform === "win32" ? ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"] : undefined;
  if (!args) return Promise.resolve([]);
  // ffmpeg lists the devices, then stops with an error (there's nothing to read): the listing is read either way.
  return new Promise((resolve) => {
    execFile(ffmpeg, args, { timeout: 15_000, windowsHide: true, encoding: "utf8" }, (_error, _stdout, stderr) => resolve(parseMicrophones(String(stderr ?? ""), platform)));
  });
}

/** Apps' names by their bundle identifiers: the terminal macOS asks about is named in Kumi's words. */
const APPS: Record<string, string> = {
  "com.apple.Terminal": "Terminal", "com.googlecode.iterm2": "iTerm2", "com.mitchellh.ghostty": "Ghostty", "com.github.wez.wezterm": "WezTerm",
  "net.kovidgoyal.kitty": "kitty", "org.alacritty": "Alacritty", "dev.warp.Warp-Stable": "Warp", "com.microsoft.VSCode": "Visual Studio Code", "com.todesktop.230313mzl4w4u92": "Cursor",
};
const PROGRAMS: Record<string, string> = { Apple_Terminal: "Terminal", "iTerm.app": "iTerm2", ghostty: "Ghostty", WezTerm: "WezTerm", vscode: "Visual Studio Code", WarpTerminal: "Warp" };

/** The terminal app Kumi runs in, as the producer knows it; "your terminal app" when it doesn't say. */
export function terminalApp(env: Env = process.env): string {
  return APPS[env.__CFBundleIdentifier ?? ""] ?? PROGRAMS[env.TERM_PROGRAM ?? ""] ?? "your terminal app";
}

/**
 * Whether the terminal Kumi runs in may use the microphone, as macOS's privacy settings say (read, not
 * asked): true, false, or undefined when macOS hasn't asked yet (or anywhere else).
 */
export function microphoneAllowed(platform: string = process.platform): Promise<boolean | undefined> {
  if (platform !== "darwin") return Promise.resolve(undefined);
  // AVCaptureDevice's authorization status for sound ("soun"): 0 not asked yet, 1 restricted, 2 denied, 3 allowed.
  const script = "ObjC.import('AVFoundation'); String($.NSClassFromString('AVCaptureDevice').authorizationStatusForMediaType('soun'))";
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script], { timeout: 5_000, encoding: "utf8" }, (error, stdout) => {
      const status = error ? NaN : Number(String(stdout).trim());
      resolve(status === 3 ? true : status === 1 || status === 2 ? false : undefined);
    });
  });
}

/**
 * Levels as they come, a block at a time, in dBFS: the meter's, the room's own (the quiet end of what's
 * been heard), and whether someone spoke (louder than the room by a margin, long enough).
 */
export class Meter {
  /** Blocks by level, a decibel a bin from 0 down to -100: the room's level is their quiet end. */
  private readonly bins = new Uint32Array(101);
  private readonly levels: number[] = [];
  private readonly part = new Int16Array(BLOCK);
  private filled = 0;
  private speech = 0;
  private lastSpeech = -1;
  private loudest = 0;
  /** The loudest sample's size: 0 all along is digital silence, a microphone that sends nothing. */
  peak = 0;

  push(samples: Int16Array): void {
    for (const sample of samples) {
      const size = Math.abs(sample);
      if (size > this.peak) this.peak = size;
      this.part[this.filled++] = sample;
      if (this.filled === BLOCK) { this.block(); this.filled = 0; }
    }
  }

  private block(): void {
    let sum = 0;
    for (const sample of this.part) sum += sample * sample;
    const rms = Math.sqrt(sum / BLOCK);
    const db = rms > 0 ? Math.max(-100, 20 * Math.log10(rms / 32768)) : -100;
    this.levels.push(db);
    const bin = Math.min(100, Math.round(-db));
    this.bins[bin] = this.bins[bin]! + 1;
    if (db > this.threshold()) { this.speech++; this.lastSpeech = this.levels.length - 1; }
    // The meter shows -60 dBFS (nothing) to -10 dBFS (loud).
    this.loudest = Math.max(this.loudest, Math.min(1, Math.max(0, (db + 60) / 50)));
  }

  /** The room's own level: the quietest sixth of what's been heard. */
  get floor(): number {
    let seen = 0;
    for (let bin = 100; bin >= 0; bin--) { seen += this.bins[bin]!; if (seen >= this.levels.length / 6) return -bin; }
    return -100;
  }

  private threshold(): number { return Math.max(SPEECH_DB, this.floor + MARGIN_DB); }

  /** The loudest level since the last time it was asked, 0–1, for a meter that moves. */
  take(): number { const level = this.loudest; this.loudest = 0; return level; }

  /** Whether someone has spoken yet, as heard so far. */
  get speaking(): boolean { return this.speech * BLOCK_MS >= SPEECH_MS; }

  /** Whether someone spoke, judged against the room's level over the whole take. */
  get spoke(): boolean {
    const threshold = this.threshold();
    let blocks = 0;
    for (const level of this.levels) if (level > threshold && ++blocks * BLOCK_MS >= SPEECH_MS) return true;
    return false;
  }

  /** Milliseconds since a voice was last heard (since the start, before any). */
  get quietMs(): number { return (this.levels.length - 1 - this.lastSpeech) * BLOCK_MS; }
}

export interface Capture {
  readonly meter: Meter;
  /** Seconds heard so far. */
  readonly seconds: number;
  /** Everything heard, as 16-bit samples. */
  pcm(): Buffer;
  /** Resolves when the first sound arrives. */
  readonly started: Promise<void>;
  /**
   * Resolves only when ffmpeg stops by itself: with its last words when it failed, undefined when its
   * input ended (a test's file played through).
   */
  readonly ended: Promise<string | undefined>;
  /** Stop hearing; resolves once ffmpeg has gone. */
  stop(): Promise<void>;
}

/** Hear `input` (ffmpeg's arguments for it) as 16 kHz mono samples, until stopped. */
export function startCapture(ffmpeg: string, input: readonly string[]): Capture {
  const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", ...input, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-flush_packets", "1", "pipe:1"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const meter = new Meter();
  const chunks: Buffer[] = [];
  let bytes = 0; let odd: Buffer | undefined; let tail = ""; let stopped = false;
  let first!: () => void; let end!: (why: string | undefined) => void; let gone!: () => void;
  const started = new Promise<void>((resolve) => { first = resolve; });
  const ended = new Promise<string | undefined>((resolve) => { end = resolve; });
  const closed = new Promise<void>((resolve) => { gone = resolve; });
  child.stdout.on("data", (chunk: Buffer) => {
    if (stopped) return;
    // Samples are two bytes; a read can split one.
    const data = odd ? Buffer.concat([odd, chunk]) : chunk;
    const whole = data.length - (data.length % 2);
    odd = whole < data.length ? data.subarray(whole) : undefined;
    if (!whole || bytes >= MAX_BYTES) return;
    const block = data.subarray(0, whole);
    chunks.push(block); bytes += whole;
    const samples = new Int16Array(whole / 2);
    for (let index = 0; index < samples.length; index++) samples[index] = block.readInt16LE(index * 2);
    meter.push(samples);
    first();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { tail = (tail + chunk).slice(-2000); });
  const last = () => tail.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 300);
  child.once("error", (error) => { gone(); if (!stopped) end(error.message); });
  child.once("close", (code) => { gone(); if (!stopped) end(code === 0 ? undefined : last() ?? `ffmpeg stopped (${code})`); });
  return {
    meter,
    get seconds() { return bytes / 2 / RATE; },
    pcm: () => Buffer.concat(chunks),
    started, ended,
    async stop() {
      if (!stopped) { stopped = true; child.kill(); }
      // ffmpeg finishes in a moment; one that doesn't is left to finish on its own.
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
    },
  };
}
