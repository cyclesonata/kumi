/**
 * Talking instead of typing, in the input box. ctrl+t starts listening and pressing it again stops;
 * held down, Kumi listens until it's let go (terminals using the kitty protocol say when; elsewhere
 * the key's own repeats stopping do). Enter stops and sends, esc drops it, and a tap's listening also
 * stops by itself after a few seconds of quiet. What was said is written down on this computer and
 * lands in the box at the cursor, for enter to send, or is sent at once when the producer chose that.
 */
import { VoiceError, type Listening, type VoiceTrouble } from "@kumi/runtime";
import type { VoiceControl, VoiceIo } from "../voice.js";
import { activityGlyph, shimmer } from "./activity.js";
import { palette, type Style } from "./style.js";
import type { Span } from "./wrap.js";

/** Held longer than this, letting go stops listening; a shorter press is a tap, and listening goes on. */
const HOLD_MS = 400;
/** Where the terminal doesn't say when keys are let go, a second press this soon is the key repeating as it's held… */
const REPEAT_MS = 1_500;
/** …and once its repeats stop for this long, it's been let go. */
const LET_GO_MS = 350;
/** Quiet this long after speaking ends a tap's listening. */
const QUIET_MS = 3_000;
/** The longest Kumi listens at once. */
const MAX_MS = 2 * 60_000;
/** Shorter than this, a take was a press taken back: nothing is written down. */
const SHORT_MS = 400;
/** The meter takes a level this often, and shows this many. */
const STEP_MS = 60;
const METER = 16;
/** Opening the microphone takes longer than this when something holds it (macOS asking, say). */
const SLOW_MS = 3_000;

export type VoicePhase = "idle" | "starting" | "listening" | "writing";

export interface VoiceHost {
  /** The words, into the input box at the cursor. */
  insert(text: string): void;
  /** Send what's in the box, as enter would. */
  send(): void;
  notice(text: string, tone: "info" | "warn"): void;
  /** A failure that has a fix (the privacy settings, another microphone): offer it. */
  offer(trouble: VoiceTrouble): void;
  /** Names Kumi can see in the Set, so they're written down right. */
  names(): string[];
  redraw(): void;
  /** Frames keep coming while something moves. */
  animate(on: boolean): void;
}

/** The line under the input box while Kumi listens or writes down. */
export interface VoiceView {
  /** What's happening, at its left. */
  status: Span[];
  /** The keys that do something now, at its right. */
  hint: string;
  /** In place of the empty box's placeholder. */
  placeholder: string;
}

const dim: Style = { fg: palette.dim };
const faint: Style = { fg: palette.faint };
const BARS = "▁▂▃▄▅▆▇█";
const clock = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };

export class VoiceInput {
  phase: VoicePhase = "idle";
  /** Each take's number: what an earlier take hears back is dropped. */
  private take = 0;
  private abort: AbortController | undefined;
  private listening: Listening | undefined;
  /** When this phase began. */
  private since = 0;
  /** When the take began, and whether ctrl+t began it (not /voice). */
  private pressedAt = 0;
  private keyed = false;
  /** The terminal reports keys let go (one has been). */
  private releases = false;
  /** How ctrl+t is known to be held: its let-go will stop listening, or its repeats stopping will. */
  private held: "release" | "repeat" | undefined;
  private letGo: ReturnType<typeof setTimeout> | undefined;
  /** Until then, ctrl+t's presses are a held key's repeats after listening stopped, not a new take. */
  private quietUntil = 0;
  /** The last of a held key's repeats: where the take ends once they stop. */
  private lastPress = 0;
  private sendAfter = false;
  /** A fetch under way, in words ("getting the speech model · 45%"). */
  private progress: string | undefined;
  private levels: number[] = [];
  private sampler: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly control: VoiceControl, private readonly host: VoiceHost) {}

  get active(): boolean { return this.phase !== "idle"; }
  private get open(): boolean { return this.phase === "starting" || this.phase === "listening"; }

  /** ctrl+t pressed; `repeat`: the terminal says it's held down. */
  press(repeat = false): void {
    const now = performance.now();
    if (repeat) { if (this.open) this.held = "release"; return; }
    if (now < this.quietUntil) { this.quietUntil = now + LET_GO_MS; return; }
    if (this.phase === "idle") { this.start(true); return; }
    // Writing down: the next take waits for it.
    if (!this.open) return;
    if (this.held === "repeat" || (!this.releases && this.keyed && now - this.pressedAt < REPEAT_MS)) { this.held = "repeat"; this.lastPress = now; this.extend(); return; }
    this.quietUntil = now + LET_GO_MS;
    this.stop();
  }

  /** ctrl+t let go, where the terminal says so: held down, listening stops as it's let go. */
  release(): void {
    this.releases = true;
    if (this.open && this.keyed && performance.now() - this.pressedAt >= HOLD_MS) this.stop();
  }

  /** Enter: listening stops and what was said is sent; writing down, it's sent once written. False when it isn't voice's. */
  enter(): boolean {
    if (this.phase === "listening") { this.stop(true); return true; }
    if (this.phase === "writing") { this.sendAfter = true; this.host.redraw(); return true; }
    // Nothing heard yet: enter sends what's typed.
    if (this.phase === "starting") this.cancel();
    return false;
  }

  /** Drop what's being heard or written down; false when there's nothing to drop. */
  cancel(): boolean {
    if (this.phase === "idle") return false;
    this.take++;
    this.abort?.abort();
    const listening = this.listening;
    this.reset();
    listening?.cancel();
    return true;
  }

  /** Listen: ctrl+t (`keyed`), or /voice. */
  start(keyed = false): void {
    if (this.phase !== "idle") return;
    const take = ++this.take; const abort = new AbortController();
    this.abort = abort; this.phase = "starting"; this.since = this.pressedAt = performance.now(); this.keyed = keyed;
    this.held = undefined; this.sendAfter = false; this.progress = undefined; this.levels = [];
    this.host.animate(true); this.host.redraw();
    void this.control.listen(this.io(take, abort)).then((listening) => {
      if (take !== this.take) { listening.cancel(); return; }
      this.listening = listening; this.phase = "listening"; this.since = performance.now(); this.progress = undefined;
      this.sampler = setInterval(() => this.sample(), STEP_MS);
      this.sampler.unref?.();
      void listening.ended.then((why) => { if (take === this.take && this.phase === "listening") this.ended(why); });
      this.host.redraw();
    }, (error: unknown) => { if (take === this.take) this.fail(error); });
  }

  /**
   * Stop listening and write down what was said (`send`: then send it), as of `at` (a held key's last
   * repeat). Before the microphone opened nothing was heard, and a take shorter than a moment is a
   * press taken back: neither is written down.
   */
  stop(send = false, at = performance.now()): void {
    clearTimeout(this.letGo); this.letGo = undefined;
    if (this.phase === "starting") { this.cancel(); return; }
    const listening = this.listening;
    if (this.phase !== "listening" || !listening) return;
    const take = this.take; const abort = this.abort!;
    const short = at - this.since < SHORT_MS;
    clearInterval(this.sampler); this.sampler = undefined;
    this.listening = undefined; this.phase = "writing"; this.since = performance.now(); this.progress = undefined;
    this.sendAfter ||= send || this.control.choices().send;
    this.host.redraw();
    void listening.stop().then(async (heard) => {
      if (take !== this.take) return;
      if (short) { this.reset(); return; }
      const words = await this.control.writeDown(heard, { ...this.io(take, abort), names: this.host.names() });
      if (take !== this.take) return;
      const sending = this.sendAfter;
      this.reset();
      this.host.insert(words);
      if (sending) this.host.send();
    }).catch((error: unknown) => { if (take === this.take) this.fail(error); });
  }

  /** The line under the input box now, while Kumi listens or writes down. */
  view(now: number): VoiceView | undefined {
    if (this.phase === "starting") {
      const words = this.progress ?? (now - this.since > SLOW_MS ? "waiting for the microphone: if your computer asks, allow it" : "opening the microphone");
      return { status: [activityGlyph("listen", now - this.since), { text: ` ${words}`, style: dim }], hint: "esc to cancel", placeholder: "Getting ready to listen…" };
    }
    if (this.phase === "listening") {
      // The dot pulses like NOW's while Kumi works; the meter scrolls, newest at the right.
      const lit = Math.floor((now - this.since) / 500) % 2 === 0;
      const levels = [...Array<number>(Math.max(0, METER - this.levels.length)).fill(0), ...this.levels];
      return {
        status: [{ text: "●", style: { fg: lit ? palette.accent : palette.pulse } }, { text: ` ${clock(now - this.since)}  `, style: dim },
          ...levels.map((level) => ({ text: BARS[Math.round(level * 7)]!, style: { fg: level >= 0.55 ? palette.accent : level >= 0.15 ? palette.dim : palette.rule } }))],
        hint: this.held ? "let go to stop · esc to cancel" : "ctrl+t to stop · enter to send · esc to cancel",
        placeholder: "Listening…",
      };
    }
    if (this.phase === "writing") {
      return { status: [...shimmer("writing it down", now - this.since), ...(this.progress ? [{ text: ` · ${this.progress}`, style: faint }] : [])],
        hint: this.sendAfter ? "sends once it's written · esc to cancel" : "esc to cancel", placeholder: "Writing down what you said…" };
    }
    return undefined;
  }

  private io(take: number, abort: AbortController): VoiceIo {
    return {
      signal: abort.signal,
      onFetch: (message) => this.host.notice(message, "info"),
      onProgress: (text) => { if (take === this.take) { this.progress = text; this.host.redraw(); } },
    };
  }

  /** While listening: the meter's next level, and the limits: quiet after speaking ends a tap's listening, and so does two minutes. */
  private sample(): void {
    const listening = this.listening;
    if (!listening || this.phase !== "listening") return;
    this.levels.push(listening.level());
    if (this.levels.length > METER) this.levels.shift();
    if (performance.now() - this.since >= MAX_MS) { this.host.notice("Kumi listens for two minutes at a time: it's writing down what you said so far.", "info"); this.stop(); }
    else if (!this.held && listening.spoke && listening.quietMs >= QUIET_MS) this.stop();
  }

  /** Where the terminal doesn't say when keys are let go: listening stops once the key's repeats stop. */
  private extend(): void {
    clearTimeout(this.letGo);
    this.letGo = setTimeout(() => {
      this.letGo = undefined;
      if (this.open) { this.quietUntil = performance.now() + LET_GO_MS; this.stop(false, this.lastPress); }
    }, LET_GO_MS);
    this.letGo.unref?.();
  }

  /** The microphone stopped by itself: a test's file played through (as if stopped), or it went away (what was heard is still written down). */
  private ended(why: VoiceError | undefined): void {
    if (!why) { this.stop(); return; }
    if ((this.listening?.seconds ?? 0) < 1) { this.fail(why); return; }
    this.host.notice(why.message, "warn");
    this.stop();
  }

  private fail(error: unknown): void {
    const listening = this.listening;
    this.reset();
    listening?.cancel();
    if (error instanceof Error && error.name === "AbortError") return;
    const trouble = error instanceof VoiceError ? error.trouble : undefined;
    this.host.notice(error instanceof Error ? error.message : "Kumi couldn't listen just now.", trouble === "quiet" || trouble === "words" ? "info" : "warn");
    if (trouble) this.host.offer(trouble);
  }

  private reset(): void {
    clearTimeout(this.letGo); this.letGo = undefined;
    clearInterval(this.sampler); this.sampler = undefined;
    this.phase = "idle"; this.listening = undefined; this.abort = undefined; this.held = undefined; this.sendAfter = false; this.progress = undefined;
    this.host.animate(false);
    this.host.redraw();
  }
}
