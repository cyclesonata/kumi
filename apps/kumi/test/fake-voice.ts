import type { VoiceError } from "@kumi/runtime";
import type { VoiceChoices, VoiceControl } from "../src/voice.js";

/**
 * A stand-in for the microphone and whisper.cpp: what's said, how it sounds while Kumi listens, and
 * the trouble to have, with each call recorded.
 */
export function fakeVoice(options: { words?: string; listen?: VoiceError; write?: VoiceError; choices?: Partial<VoiceChoices> } = {}) {
  const calls: string[] = [];
  let choices: VoiceChoices = { send: false, language: "en", ...options.choices };
  /** What the microphone hears now: change it while listening. */
  const sound = { spoke: false, quietMs: 0, seconds: 2, level: 0.8 };
  let end: ((why: VoiceError | undefined) => void) | undefined;
  const control: VoiceControl = {
    systemLanguage: "ja",
    choices: () => choices,
    choose(change) {
      calls.push(`choose ${JSON.stringify(change)}`);
      const { microphone: _microphone, ...rest } = choices;
      const microphone = change.microphone === undefined ? choices.microphone : change.microphone ?? undefined;
      choices = { ...rest, ...(change.send !== undefined ? { send: change.send } : {}), ...(change.language ? { language: change.language } : {}), ...(microphone ? { microphone } : {}) };
    },
    async listen() {
      calls.push("listen");
      if (options.listen) throw options.listen;
      return {
        get seconds() { return sound.seconds; },
        get spoke() { return sound.spoke; },
        get quietMs() { return sound.quietMs; },
        level: () => sound.level,
        async stop() { calls.push("stop"); return { pcm: Buffer.alloc(64_000), seconds: 2, peak: 9_000, spoke: true }; },
        cancel() { calls.push("cancel"); },
        ended: new Promise<VoiceError | undefined>((resolve) => { end = resolve; }),
      };
    },
    async writeDown(_heard, io) {
      calls.push(`write ${io.names.join(", ")}`);
      if (options.write) throw options.write;
      return options.words ?? "make the bass darker";
    },
    async microphones() { return ["MacBook Pro Microphone", "Scarlett 2i2 USB"]; },
    openPrivacy: () => { calls.push("privacy"); },
  };
  return { control, calls, sound, end: (why?: VoiceError) => end?.(why) };
}
