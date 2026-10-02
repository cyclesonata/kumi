/**
 * Talking to Kumi, for the app: listening and writing down with the producer's choices (whether what's
 * said is sent at once, the language, the microphone), kept in settings.json. Off a Mac, whisper.cpp
 * and the speech model are fetched while the producer talks the first time, so writing down can start
 * as soon as they stop.
 */
import { findFfmpeg, listen, listMicrophones, prepareVoice, writeDown, type Heard, type Listening } from "@kumi/runtime";
import { readSettings, writeSettings, type VoiceSettings } from "./config.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface VoiceChoices {
  /** Send what's said as soon as the producer stops, without enter. */
  send: boolean;
  /** "en", another language's code, or "auto" to detect it. */
  language: string;
  /** A microphone by name; the system's default when unset. */
  microphone?: string;
}

export interface VoiceIo {
  signal: AbortSignal;
  /** Said once, in the conversation, when Kumi fetches a program or the speech model. */
  onFetch(message: string): void;
  /** How a fetch is going, for the status line under the input box. */
  onProgress(text: string): void;
}

export interface VoiceControl {
  choices(): VoiceChoices;
  choose(change: { send?: boolean; language?: string; microphone?: string | null }): void;
  /** The language the computer is set to, as a code ("en", "ja"). */
  readonly systemLanguage: string;
  listen(io: VoiceIo): Promise<Listening>;
  /** Write down what was heard, expecting `names` (the Set's own). */
  writeDown(heard: Heard, io: VoiceIo & { names: readonly string[] }): Promise<string>;
  microphones(): Promise<string[]>;
  /** Open the system's microphone privacy settings; absent where there are none to open. */
  openPrivacy?: () => void;
}

/** The computer's language as a code: the locale the terminal says, else the system's ("C" is English). */
export function systemLanguage(env: Env = process.env): string {
  const tag = env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  const code = /^([a-z]{2,3})(?:[-_.@]|$)/i.exec(tag)?.[1]?.toLowerCase();
  return code && code !== "c" ? code : "en";
}

/** Where each system keeps the microphone's privacy settings. */
const PRIVACY: Record<string, string> = { darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone", win32: "ms-settings:privacy-microphone" };

export function createVoiceControl(options: { env?: Env; toolsDir: string; settingsFile: string; open?: (url: string) => void; platform?: string }): VoiceControl {
  const env = options.env ?? process.env; const platform = options.platform ?? process.platform;
  const language = systemLanguage(env);
  const saved = (): VoiceSettings => readSettings(options.settingsFile).voice ?? {};
  // whisper.cpp and the speech model, made ready while the producer talks. A fetch isn't tied to one
  // take: dropping what was said doesn't waste the download, and its progress goes to the latest take.
  let ready: { language: string; done: Promise<void> } | undefined;
  let progress: ((text: string) => void) | undefined;
  const prepare = (io: VoiceIo, language: string) => {
    progress = io.onProgress;
    if (ready?.language === language) return;
    const done = prepareVoice({ env, toolsDir: options.toolsDir, platform, language, onFetch: io.onFetch, onProgress: (text) => progress?.(text) })
      // Writing down fetches again, and says why, when this didn't get there (offline, say).
      .catch(() => { if (ready?.done === done) ready = undefined; });
    ready = { language, done };
  };
  return {
    systemLanguage: language,
    choices() {
      const voice = saved();
      return { send: voice.send === true, language: voice.language ?? language, ...(voice.microphone ? { microphone: voice.microphone } : {}) };
    },
    choose(change) {
      const voice = { ...saved() };
      if (change.send !== undefined) { if (change.send) voice.send = true; else delete voice.send; }
      if (change.language !== undefined) voice.language = change.language;
      if (change.microphone !== undefined) { if (change.microphone) voice.microphone = change.microphone; else delete voice.microphone; }
      writeSettings(options.settingsFile, { ...readSettings(options.settingsFile), voice });
    },
    async listen(io) {
      const { microphone, language } = this.choices();
      const listening = await listen({ env, toolsDir: options.toolsDir, platform, signal: io.signal, onFetch: io.onFetch, onProgress: io.onProgress, ...(microphone ? { microphone } : {}) });
      prepare(io, language);
      return listening;
    },
    async writeDown(heard, io) {
      const { language } = this.choices();
      progress = io.onProgress;
      // Dropped while the model comes: the take stops waiting, the fetch goes on.
      if (ready?.language === language) await Promise.race([ready.done, new Promise((_, reject) => io.signal.addEventListener("abort", () => reject(io.signal.reason), { once: true }))]);
      return writeDown(heard, { env, toolsDir: options.toolsDir, platform, language, names: io.names, signal: io.signal, onFetch: io.onFetch, onProgress: io.onProgress });
    },
    async microphones() {
      const ffmpeg = await findFfmpeg({ env, toolsDir: options.toolsDir, installedOnly: true });
      return ffmpeg ? listMicrophones(ffmpeg, platform) : [];
    },
    ...(PRIVACY[platform] && options.open ? { openPrivacy: () => options.open!(PRIVACY[platform]!) } : {}),
  };
}
