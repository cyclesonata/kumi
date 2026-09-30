import { createInterface, type Interface } from "node:readline";
import type { Writable } from "node:stream";
import stringWidth from "string-width";
import { EFFORTS, since, type Effort, type ProviderId, PROVIDERS, type SessionController, type SessionEvent } from "@kumi/runtime";
import { safeError } from "./config.js";
import type { InputHistory } from "./history.js";
import { KeyInput, type TerminalInput } from "./input.js";
import type { ModelControl } from "./models.js";
import { sanitizeText, StreamingText } from "./text.js";
import type { UpdateControl } from "./update.js";
import { KUMI } from "@kumi/runtime";

interface Options {
  controller: SessionController;
  input: TerminalInput;
  output: Writable & { isTTY?: boolean; columns?: number };
  models: ModelControl;
  mode: "live" | "inference-only";
  /** Shown once under the header, e.g. how to connect Live. */
  startupNotice?: string;
  secrets?: readonly string[];
  closeTimeoutMs?: number;
  /** What the producer typed before, for the up arrow; kept across /new, reconnects and restarts. */
  history?: InputHistory;
  /** Kumi's updates, for /update and word of a newer Kumi. */
  updates?: UpdateControl;
}
export interface Terminal {
  run(): Promise<number>;
  handleEvent(event: SessionEvent): void;
  /** A newer Kumi, found as Kumi started. */
  offerUpdate(latest: string): void;
  interrupt(): void;
  close(): Promise<number>;
}
const HELP = `/help · /status · /undo · /stop · /refresh · /reconnect (connect to Live again, keeping the conversation) · /new (forget this conversation and start fresh) · /conversations [number] (list this Set's, or go back to one) · /model [provider/model] · /effort [level|default] · /logout <provider> · /memory · /forget <id> · /recipes · /update (get the newest Kumi) · /quit | Ctrl-C: cancel work; idle: exit. EOF exits. Sign in with: ${KUMI} login <provider>.`;

/** One synchronous render transaction at a time; Writable preserves byte ordering/backpressure. */
class Presentation {
  private tail = "";
  private prefix = "assistant> ";
  private renderedRows = 0;
  private pipeLineOpen = false;
  private closed = false;
  constructor(private readonly rl: Interface, private readonly out: Options["output"], private readonly tty: boolean) {
    rl.once("close", () => { this.closed = true; });
  }
  private readonly segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  private rows(text: string) {
    const columns = Math.max(2, this.out.columns ?? 80);
    let rows = 1; let column = 0;
    for (const { segment } of this.segments.segment(text)) {
      const width = stringWidth(segment);
      if (!width) continue;
      // A wide glyph at the final column wraps with an extra blank cell.
      if (column + width > columns) { rows++; column = 0; }
      column += width;
    }
    return rows;
  }
  private frame(stable: string, partial = "", restoreInput = true) {
    if (!this.tty) { this.out.write(stable + partial); return; }
    if (this.closed) {
      const rows = this.renderedRows + this.rl.getCursorPos().rows;
      this.out.write(`\r${rows ? `\u001b[${rows}A` : ""}\u001b[0J${stable}${partial}`);
      this.renderedRows = 0;
      return;
    }
    const line = this.rl.line; const cursor = this.rl.cursor;
    // Use documented readline editing operations to clear its wrapped buffer.
    // Restore suffix, Home, then prefix: the exact original cursor is preserved,
    // including wide/combining characters, without mutating readonly properties.
    this.rl.write(null, { ctrl: true, name: "a" });
    this.rl.write(null, { ctrl: true, name: "k" });
    this.out.write(`\r${this.renderedRows ? `\u001b[${this.renderedRows}A` : ""}\u001b[0J${stable}${partial ? `${partial}\n` : ""}`);
    this.renderedRows = partial ? this.rows(partial) : 0;
    if (!restoreInput) return;
    this.rl.prompt(true);
    if (line) {
      this.rl.write(line.slice(cursor));
      this.rl.write(null, { ctrl: true, name: "a" });
      this.rl.write(line.slice(0, cursor));
    }
  }
  text(text: string) {
    if (!text) return;
    if (!this.tty) {
      this.out.write((this.pipeLineOpen ? "" : this.prefix) + text);
      this.pipeLineOpen = !text.endsWith("\n"); this.prefix = "";
      return;
    }
    this.tail += text;
    const lines = this.tail.split("\n");
    const complete = lines.slice(0, -1);
    const stable = complete.map((line, index) => `${index === 0 ? this.prefix : ""}${line}\n`).join("");
    this.tail = lines.at(-1)!;
    if (complete.length) this.prefix = "";
    this.frame(stable, this.tail ? this.prefix + this.tail : "");
  }
  notice(text: string, final = false) {
    if (!this.tty) {
      this.out.write(`${this.pipeLineOpen ? "\n" : ""}${text}\n`);
      this.pipeLineOpen = false;
    } else {
      this.frame(`${this.tail ? this.prefix + this.tail + "\n" : ""}${text}\n`, "", !final);
      this.tail = "";
    }
    this.prefix = "assistant> ";
  }
  submitted() {
    // readline has already committed the user's line and moved down. Any displayed
    // assistant fragment is now stable above it; do not redraw/duplicate that fragment.
    this.tail = ""; this.renderedRows = 0; this.prefix = "assistant> ";
  }
}

export function createTerminal(options: Options): Terminal {
  const { controller, input, output } = options;
  const secrets = options.secrets ?? [];
  const text = new StreamingText(secrets);
  let rl: Interface | undefined;
  let keys: KeyInput | undefined;
  let presentation: Presentation | undefined;
  let started = false;
  let closing = false;
  let cancelling = false;
  /** A newer Kumi's version, once the startup check or /update found one. */
  let newer: string | undefined;
  let suppressOutput = false;
  let displayedBytes = 0;
  let startedAt = performance.now();
  let firstTextMs: number | undefined;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => { resolveDone = resolve; });
  const line = (message: string) => sanitizeText(message, secrets).replaceAll("\n", " ").slice(0, 2048);
  const notice = (message: string) => { if (!output.destroyed) presentation?.notice(line(message)); };
  const reportError = (error: unknown) => notice(`[error] ${safeError(error, secrets)}`);
  const busy = () => ["running", "cancelling"].includes(controller.status().state);
  /** A message typed while Kumi was connecting; `answering` is true while a turn of ours runs. */
  let queued: string | undefined;
  let answering = false;

  async function finish(code = 0): Promise<number> {
    if (closing) return done;
    closing = true; suppressOutput = true; text.discard();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([controller.close(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Shutdown deadline exceeded")), options.closeTimeoutMs ?? 6_000);
      })]);
      if (!output.destroyed) presentation?.notice("Kumi closed. Each Set's conversation continues next time.", true);
    } catch (error) {
      code = 1;
      if (!output.destroyed) presentation?.notice(line(`[error] ${safeError(error, secrets)}`), true);
    }
    finally {
      clearTimeout(timer);
      rl?.close(); keys?.destroy(); input.pause();
      resolveDone(code);
    }
    return done;
  }
  function interrupt() {
    if (closing) return;
    if (!busy()) { void finish(); return; }
    if (cancelling) return;
    cancelling = true; suppressOutput = true; text.discard();
    notice("[cancelling] Cancelling current work.");
    void Promise.resolve().then(() => controller.cancel()).catch(reportError).finally(() => { cancelling = false; });
  }
  async function submitted(inputLine: string) {
    if (closing) return;
    presentation?.submitted();
    const command = inputLine.trim();
    if (!command) { if (input.isTTY && output.isTTY) rl?.prompt(true); return; }
    // Everything sent goes into the history, as a shell keeps it (secrets kept out).
    options.history?.add(inputLine);
    if (command === "/quit") { await finish(); return; }
    if (command === "/help") { notice(HELP); return; }
    // Typing /update is the go-ahead: Kumi closes, updates and opens again with this conversation.
    if (command === "/update" && options.updates) {
      if (busy()) { notice("[update] Kumi is working; /update once it's done (Ctrl-C stops it)."); return; }
      let latest = newer;
      if (!latest) {
        try { latest = await options.updates.check(); } catch (error) { notice(`[update] ${safeError(error, secrets)}. Try /update again later.`); return; }
      }
      if (!latest) { notice(`[update] Kumi is up to date (${options.updates.current}).`); return; }
      notice(`[update] Updating to Kumi ${latest}: Kumi closes, updates and opens again.`);
      options.updates.request();
      await finish();
      return;
    }
    if (command === "/stop") {
      if (!controller.stopLive) { notice("[stop] Kumi can't stop Live here."); return; }
      // An answer in progress stops too, so its later steps can't start Live again.
      if (busy()) await Promise.resolve(controller.cancel()).catch(() => {});
      // A stop shows as the "[live] Stopped" event.
      if (!await controller.stopLive()) notice("[stop] Kumi couldn't stop Live just now; press space in Live.");
      return;
    }
    if (command === "/status") {
      const status = controller.status();
      notice(`[status] ${status.state}; MCP/Live: ${status.connection}; turns ${status.turns}${status.maxTurns ? `/${status.maxTurns}` : ""}; ${status.observation ?? "No current Live observation"}`);
      return;
    }
    // Connecting or reading the Set, not answering: keep the message and send it when Kumi is ready.
    if (busy() && !answering && !command.startsWith("/") && queued === undefined) { queued = inputLine; notice("[waiting] Kumi is getting ready; your message goes as soon as it is."); return; }
    if (busy()) { notice("[busy] Busy; cancel first. No second turn was submitted."); return; }
    const [verb, argument] = command.split(/\s+/, 2);
    try {
      if (verb === "/model") { await modelCommand(argument); return; }
      if (verb === "/effort") {
        if (!argument) { notice(`[effort] ${options.models.current().effort ?? "the model's default"}. Choose one of ${EFFORTS.join(", ")} or default.`); return; }
        if (argument !== "default" && !(EFFORTS as readonly string[]).includes(argument)) { notice(`[effort] Choose one of ${EFFORTS.join(", ")} or default.`); return; }
        await options.models.setEffort(argument === "default" ? undefined : argument as Effort); notice(`[effort] ${argument}.`); return;
      }
      if (verb === "/memory") {
        const memory = await controller.memory?.();
        if (!memory) { notice("[memory] Kumi keeps no notes here."); return; }
        const list = (notes: { id: string; text: string }[]) => notes.map((note) => `${note.id} ${note.text}`).join(" · ") || "none";
        notice(`[memory] About you: ${list(memory.producer)}`);
        notice(memory.saved ? `[memory] About ${memory.setName ?? "this Set"}: ${list(memory.set)}` : "[memory] This Set isn't saved yet; notes about it are kept once it is.");
        if (controller.techniques) {
          const techniques = await controller.techniques();
          notice(`[memory] Techniques: ${techniques.map((technique) => `${technique.id} ${technique.name} (for ${technique.fits})`).join(" · ") || "none yet"}`);
        }
        return;
      }
      if (verb === "/recipes") {
        const recipes = await controller.recipes?.() ?? [];
        notice(recipes.length ? `[recipes] ${recipes.map((recipe) => `${recipe.name}${recipe.params.length ? ` (needs ${recipe.params.map((param) => param.name).join(", ")})` : ""}: ${recipe.about}`).join(" · ")}` : "[recipes] None yet. Ask Kumi to save a way of working, or say \"watch me\" and do it in Live.");
        return;
      }
      if (verb === "/conversations") {
        const kept = await controller.conversations?.() ?? [];
        if (!argument) {
          const requests = (count: number) => `${count} ${count === 1 ? "request" : "requests"}`;
          notice(kept.length ? `[conversations] ${kept.map((row, index) => `${index + 1}. ${sanitizeText(row.first, options.secrets).replaceAll("\n", " ").slice(0, 80) || "(nothing asked yet)"} (${row.current ? "this one" : since(row.savedAt, Date.now())}, ${requests(row.turns)})`).join(" · ")}. /conversations <number> goes back to one.`
            : "[conversations] None kept yet: a conversation is kept once you've asked something.");
          return;
        }
        const row = kept[Number.parseInt(argument, 10) - 1];
        if (!row) { notice("[conversations] Use: /conversations <number>, with a number from /conversations."); return; }
        if (row.current) { notice("[conversations] That's this one."); return; }
        if (!await controller.resumeConversation?.(row.id)) notice("[conversations] That conversation isn't kept any more.");
        return;
      }
      if (verb === "/forget") {
        // A technique's id starts with t; a note's with p or s.
        if (argument?.startsWith("t") && controller.forgetTechnique) {
          if (!await controller.forgetTechnique(argument)) notice("[memory] Use: /forget <id>, with an id from /memory.");
          return;
        }
        const note = argument ? await controller.forget?.(argument) : undefined;
        if (!note) notice("[memory] Use: /forget <id>, with an id from /memory.");
        return;
      }
      if (verb === "/login") { notice(`[login] Sign in from a shell: ${KUMI} login <provider> (openai-codex, anthropic, openai, opencode). The full-screen app signs in here.`); return; }
      if (verb === "/logout") {
        if (!argument || !(PROVIDERS as readonly string[]).includes(argument)) { notice(`[logout] Use: /logout <provider> (${PROVIDERS.join(", ")}).`); return; }
        notice(await options.models.signOut(argument as ProviderId) ? `[logout] Signed out of ${argument}.` : `[logout] There was no sign-in for ${argument} to remove.`); return;
      }
      if (command === "/undo") {
        const change = await controller.undo();
        if (change) notice(change.state === "undone" ? `[undo] Undid: ${change.title}` : `[undo] Kept: ${change.title}. ${change.note ?? ""}`.trim());
      } else if (command === "/refresh") await controller.refresh();
      else if (command === "/reconnect" && controller.reconnect) await controller.reconnect();
      else if (command === "/new") { notice("── New conversation. Kumi won't use what's above ──"); await controller.newConversation(); }
      else if (command.startsWith("/")) notice("Unknown command. Use /help.");
      else { answering = true; try { await controller.submit(inputLine); } finally { answering = false; } }
    } catch (error) { if (!closing) reportError(error); }
    finally { if (!closing && input.isTTY && output.isTTY) rl?.prompt(true); }
  }
  /** /model: say which it is, list a provider's, or choose one. */
  async function modelCommand(argument: string | undefined) {
    const { models } = options;
    if (!argument) {
      const current = models.current();
      const signedIn = (await models.providers()).filter((provider) => provider.signedIn).map((provider) => provider.id);
      notice(`[model] ${current.model ?? "none chosen"}${current.effort ? `, effort ${current.effort}` : ""}. List a provider's with /model <provider> (${signedIn.join(", ") || "sign in first"}); choose with /model <provider>/<model>.`);
      return;
    }
    if ((PROVIDERS as readonly string[]).includes(argument)) {
      const listed = await models.models(argument as ProviderId);
      notice(`[model] ${argument}: ${listed.map((model) => model.model).join(", ") || "no models listed"}`);
      return;
    }
    await models.choose(argument);
    notice(`[model] ${argument} from the next answer on.`);
  }
  function handleEvent(event: SessionEvent) {
    if (closing) return;
    switch (event.type) {
      case "state":
        if (event.state === "idle" && queued !== undefined && !answering) { const line = queued; queued = undefined; void Promise.resolve().then(() => submitted(line)); }
        if (event.state === "running") { suppressOutput = false; displayedBytes = 0; text.discard(); startedAt = performance.now(); firstTextMs = undefined; }
        if (event.state === "cancelling") { suppressOutput = true; text.discard(); }
        break;
      case "connection": notice(`[connection] MCP/Live: ${event.state}${event.state !== "connected" ? "; no verified current Live observation" : ""}`); break;
      case "observation": notice(`[observation] ${event.label}`); break;
      case "resumed": {
        const when = since(event.savedAt, Date.now());
        notice(event.chosen ? `── Back to your conversation from ${when} ──` : event.unreadable ? `[resumed] Your conversation from ${when}, which this model can't continue:`
          : `[resumed] Continuing your conversation from ${when} (/new starts fresh).`);
        if (event.chosen || event.unreadable) for (const line of event.lines.slice(-6)) notice(`${line.role === "user" ? "you" : "kumi"}> ${sanitizeText(line.text, options.secrets).replaceAll("\n", " ").slice(0, 200)}`);
        break;
      }
      // Live is back after stopping a request: it's in the line, ready to send again.
      case "resend": if (input.isTTY && output.isTTY && rl && !rl.line) rl.write(event.text.replaceAll("\n", " ")); break;
      case "catch-up": {
        const { catchUp } = event;
        const when = since(catchUp.lastSeenAt, Date.now());
        notice(catchUp.lines.length ? `[since last time · ${when}] ${catchUp.lines.join("; ")}${catchUp.more ? `; and ${catchUp.more} more` : ""}` : `[since last time · ${when}] Nothing changed.`);
        break;
      }
      case "change": {
        const { state, title, note } = event.change;
        if (state === "applied") notice(`[change] ${title} (/undo takes it back)`);
        else if (state === "unsure") notice(`[change] Check Live: ${title}. ${note ?? "Live didn't confirm it."}`);
        else if (state === "kept") notice(`[change] Kept: ${title}. ${note ?? ""}`.trim());
        else if (state === "expired") notice(`[change] No undo anymore: ${title}. ${note ?? ""}`.trim());
        else if (state === "heard") notice(`[heard] ${title}${event.change.score !== undefined ? ` · ${event.change.score}%` : ""}`);
        break;
      }
      case "notice": notice(event.message); break;
      case "error":
        reportError(new Error(event.message)); text.discard();
        // Plain lines can't show the key box: say which command signs in there.
        if (event.kind === "auth" && event.provider && (PROVIDERS as readonly string[]).includes(event.provider)) notice(`[login] Sign in from a shell: ${KUMI} login ${event.provider}`);
        break;
      case "text": {
        if (suppressOutput) return;
        firstTextMs ??= Math.round(performance.now() - startedAt);
        displayedBytes += Buffer.byteLength(event.text);
        if (displayedBytes > 256 * 1024) { notice("Assistant output exceeded the terminal bound; cancelling."); interrupt(); return; }
        presentation?.text(text.push(event.text));
        break;
      }
      case "tool-start": if (!suppressOutput) notice(`[tool] ${event.name} started`); break;
      case "tool-end": if (!suppressOutput) notice(`[tool] ${event.name} ${event.isError ? "error" : "success"} · ${event.elapsedMs} ms`); break;
      case "remembered": notice(`[memory] ${event.replaced ? "Updated a note" : "Noted"} ${event.scope === "producer" ? "about you" : "about this Set"}: ${event.note.text}${event.pending ? " (kept once the Set is saved)" : ""}`); break;
      case "forgot": notice(`[memory] Forgot: ${event.note.text}`); break;
      case "action": notice(`[live] ${event.title}`); break;
      case "watching": notice(event.on ? "[live] Kumi is watching the Set; do it in Live, then tell Kumi you're done." : "[live] Kumi stopped watching."); break;
      case "recipe": notice(`[recipe] ${event.action === "running" ? "Running" : event.action === "forgotten" ? "Forgot" : event.action === "updated" ? "Updated" : "Saved"} “${event.name}” (${event.steps} steps)`); break;
      case "technique": notice(`[technique] ${{ kept: "Kept", updated: "Updated", used: "Using", forgot: "Forgot" }[event.action]} “${event.technique.name}”${event.action === "kept" || event.action === "updated" ? ` (for ${event.technique.fits}; /forget ${event.technique.id} drops it)` : ""}`); break;
      case "lesson": notice(`[${event.action === "forgot" ? "forgot a lesson" : "learned"}] ${event.line}`); break;
      case "match": if (event.state === "done" && event.best) notice(`[matching] ${event.first !== undefined ? `${event.first}% → ` : ""}${event.best.score}% (${event.best.label}), stopped: ${event.stop ?? "done"}`); break;
      case "auditioned": notice(`[round ${event.round}] ${event.best ? `${event.previous !== undefined ? `${event.previous}% → ` : ""}${event.best.score}%${event.gaps.length ? ` · ${event.gaps.join(", ")}` : ""}` : "listened"}`); break;
      case "heard": notice(event.compared ? `[heard] ${event.file} against ${event.compared.reference}: ${event.compared.headlines.join("; ") || "close"}` : `[heard] ${event.file} · ${event.summary}`); break;
      case "watched": {
        const at = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
        const words = { captions: "its captions", automatic: "its automatic captions", transcribed: "its speech, transcribed", none: "no words" }[event.words];
        notice(`[watched] “${event.title.slice(0, 120)}”${event.duration ? ` (${at(event.duration)})` : ""}: ${at(event.from)}–${at(event.to)}, ${words}${event.frames.length ? `, frames at ${event.frames.map((frame) => at(frame.at)).join(", ")}` : ""}${event.sound ? `, the sound at ${at(event.sound.from)}–${at(event.sound.to)}` : ""}`);
        for (const note of event.notes.slice(0, 3)) notice(`[watched] ${note}`);
        break;
      }
      case "turn-complete": {
        if (event.result.stopReason !== "cancelled" && !suppressOutput) presentation?.text(text.finish()); else text.discard();
        const usage = event.result.usage;
        notice(`[${event.result.stopReason}] first text ${firstTextMs === undefined ? "unavailable" : `${firstTextMs} ms`}; total ${event.elapsedMs} ms; ${usage ? `reported tokens in/out ${usage.inputTokens}/${usage.outputTokens}; cache read/write ${usage.cacheReadTokens}/${usage.cacheWriteTokens}${event.result.stopReason === "cancelled" ? " (partial before cancellation)" : ""}` : "usage unavailable"}; cost unavailable`);
        break;
      }
    }
  }
  return {
    run() {
      if (started || closing) return done;
      started = true;
      const tty = Boolean(input.isTTY && output.isTTY);
      if (tty) keys = new KeyInput(input);
      // The up arrow goes through what was sent before, this session's and earlier ones'.
      rl = createInterface({ input: keys ?? input, output, terminal: tty, prompt: "kumi> ", crlfDelay: Infinity,
        ...(tty ? { historySize: 500, removeHistoryDuplicates: true, history: [...options.history?.entries ?? []].reverse().map((entry) => entry.replaceAll("\n", " ")) } : { historySize: 0 }) });
      presentation = new Presentation(rl, output, tty);
      rl.on("line", (value) => { void submitted(value).catch(reportError); });
      rl.on("SIGINT", interrupt);
      rl.on("close", () => { void finish(); });
      input.on("error", () => { void finish(1); }); output.on("error", () => { void finish(1); });
      notice(`Kumi · ${options.models.current().model ?? "no model chosen yet"} · ${options.mode === "inference-only" ? "MCP disconnected / No Live access" : "MCP connecting / Live unverified"}`);
      notice("Each Set's conversations are kept: its latest continues next time, and /conversations goes back to earlier ones. /help for commands.");
      if (options.startupNotice) notice(options.startupNotice);
      // No model yet: the first one a signed-in provider lists.
      if (!options.models.current().model) {
        void options.models.chooseDefault().then((chosen) => {
          if (!closing) notice(chosen ? `[model] ${chosen.id}, the first ${chosen.provider} lists. /model changes it.` : `[model] Not signed in to a provider yet. Sign in with: ${KUMI} login <provider>, then /model.`);
        }, () => undefined);
      }
      void Promise.resolve().then(() => { if (!closing) return controller.start(); }).catch(async (error: unknown) => {
        if (!closing) { reportError(error); await finish(1); }
      });
      return done;
    },
    handleEvent, interrupt,
    offerUpdate(latest: string) {
      if (closing || newer === latest) return;
      newer = latest;
      notice(`[update] Kumi ${latest} is out (this is ${options.updates?.current ?? "an older one"}). /update gets it.`);
    },
    close: () => finish(),
  };
}
