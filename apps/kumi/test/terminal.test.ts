import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { SessionController, SessionEvent, TurnState } from "@kumi/runtime";
import { createTerminal } from "../src/terminal.js";
import { KeyInput } from "../src/input.js";
import { StreamingText, sanitizeText } from "../src/text.js";

function fixture(tty = false, hold = false, startupNotice?: string) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): void };
  input.isTTY = tty; input.isRaw = false; input.setRawMode = (value) => { input.isRaw = value; };
  let output = "";
  const sink = Object.assign(new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } }), { isTTY: tty, columns: 40 });
  const calls: string[] = [];
  let state: TurnState = "idle"; let releases: (() => void)[] = [];
  const controller: SessionController = {
    async start() { calls.push("start"); },
    async submit(text) {
      calls.push(`submit:${text}`); state = "running"; terminal.handleEvent({ type: "state", state });
      if (hold) await new Promise<void>((resolve) => { releases.push(resolve); });
      state = "idle"; terminal.handleEvent({ type: "state", state });
    },
    async refresh() { calls.push("refresh"); }, async newConversation() { calls.push("new"); },
    async cancel() { calls.push("cancel"); state = "idle"; for (const release of releases) release(); releases = []; },
    async close() { calls.push("close"); state = "closed"; for (const release of releases) release(); releases = []; },
    status() { return { state, connection: "disconnected", turns: 0, maxTurns: 30 }; },
    async undo() { calls.push("undo"); return { id: "c1", family: "tempo", title: "Tempo 120 → 124 BPM", state: "undone", at: 1 }; },
  };
  const terminal = createTerminal({ controller, input, output: sink, model: "openai-codex/fixture", mode: "inference-only", secrets: ["private-token"], closeTimeoutMs: 25,
    ...(startupNotice ? { startupNotice } : {}) });
  const done = terminal.run();
  return { input, sink, terminal, controller, done, calls, emit: (event: SessionEvent) => terminal.handleEvent(event), get output() { return output; } };
}

test("header, transcript, tool timing, usage and command dispatch are concise and safe", async () => {
  const f = fixture(); await delay(0);
  f.input.write("/help\n/status\n/refresh\n/new\n/unknown\nquestion\n"); await delay(0);
  f.emit({ type: "text", text: "hello " }); f.emit({ type: "text", text: "world" });
  f.emit({ type: "tool-start", id: "t", name: "live_status" });
  f.emit({ type: "tool-end", id: "t", name: "live_status", elapsedMs: 7, isError: false });
  f.emit({ type: "turn-complete", elapsedMs: 55, result: { stopReason: "completed", usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } } });
  f.emit({ type: "error", message: "token=private-token\u001b[31m bad" });
  f.input.write("/quit\n"); assert.equal(await f.done, 0);
  assert.match(f.output, /Kumi/); assert.match(f.output, /ephemeral|history is lost/i);
  assert.match(f.output, /No Live access/); assert.match(f.output, /hello world/); assert.equal(f.output.split("hello world").length, 2);
  assert.match(f.output, /live_status.*7 ms/); assert.match(f.output, /3.*2/); assert(!f.output.includes("private-token"));
  assert.deepEqual(f.calls, ["start", "refresh", "new", "submit:question", "close"]);
});

test("plain mode prints each change, and /undo takes back the latest", async () => {
  const f = fixture(); await delay(0);
  f.emit({ type: "change", change: { id: "c1", family: "tempo", title: "Tempo 120 → 124 BPM", state: "applied", at: 1 } });
  f.input.write("/undo\n"); await delay(5);
  f.input.write("/quit\n"); assert.equal(await f.done, 0);
  assert.match(f.output, /\[change\] Tempo 120 → 124 BPM \(\/undo takes it back\)/);
  assert.match(f.output, /\[undo\] Undid: Tempo 120 → 124 BPM/);
  assert(f.calls.includes("undo"));
});

test("an optional startup notice follows the header once", async () => {
  const f = fixture(false, false, "The Ableton bridge isn't installed yet");
  await delay(0); f.input.write("/quit\n"); assert.equal(await f.done, 0);
  assert.equal(f.output.split("bridge isn't installed yet").length, 2);
  assert(f.output.indexOf("/help for commands") < f.output.indexOf("bridge isn't installed yet"));
});

test("partial input and cursor survive streaming, notices and tool lines, including wrapped Unicode", async () => {
  const f = fixture(true); await delay(0);
  const prefix = "猫🎹".repeat(15);
  f.input.write(`${prefix}abcd`); f.input.write("\u001b[D\u001b[D");
  f.emit({ type: "text", text: "A streamed response" });
  f.emit({ type: "notice", message: "still working" });
  f.emit({ type: "tool-start", id: "x", name: "live_discover" });
  f.input.write("XY\r"); await delay(0);
  assert(f.calls.includes(`submit:${prefix}abXYcd`));
  f.input.write("/quit\r"); await f.done; assert.equal(f.input.isRaw, false);
  assert(stripVTControlCharacters(f.output).endsWith("Kumi closed. Ephemeral conversation discarded.\n"), "do not leave a dead Kumi prompt at exit");
});

test("busy submit and refresh/new are rejected; Ctrl-C cancels work but preserves partly typed next input", async () => {
  const f = fixture(true, true); await delay(0);
  f.input.write("first\r"); await delay(0);
  f.input.write("second\r/refresh\r/new\r"); await delay(0);
  assert.deepEqual(f.calls.filter((call) => call.startsWith("submit:")), ["submit:first"]); assert.match(f.output, /busy.*cancel first/i);
  f.input.write("follow"); f.input.write("\u0003"); await delay(0);
  assert(f.calls.includes("cancel")); assert(!f.calls.includes("close"));
  f.input.write("up\r"); await delay(0); assert(f.calls.includes("submit:followup"));
  f.input.write("\u0003"); await delay(0); f.input.write("\u0003");
  assert.equal(await f.done, 0); assert.equal(f.calls.filter((call) => call === "close").length, 1);
});

test("EOF during work and repeated shutdown close the controller exactly once and suppress late text", async () => {
  const f = fixture(false, true); await delay(0); f.input.write("pending\n"); await delay(0);
  f.input.end(); await f.done; await f.terminal.close();
  const before = f.output; f.emit({ type: "text", text: "late-secret" });
  assert.equal(f.output, before); assert.equal(f.calls.filter((call) => call === "close").length, 1);
});

test("shutdown has a hard bound even if an injected controller never resolves", async () => {
  const f = fixture(true); await delay(0);
  f.controller.close = () => new Promise(() => {});
  f.input.write("/quit\r");
  assert.equal(await f.done, 1); assert.equal(f.input.isRaw, false); assert.match(f.output, /Shutdown deadline/);
});

test("TTY input preserves split UTF-8 and separates pasted code points for readline row tracking", async () => {
  const source = new PassThrough(); const keys = new KeyInput(source);
  const chunks: string[] = []; keys.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const bytes = Buffer.from("a猫🎹b");
  source.write(bytes.subarray(0, 3)); source.write(bytes.subarray(3));
  await delay(0);
  assert.deepEqual(chunks, ["a", "猫", "🎹", "b"]);
  keys.destroy(); await delay(0); assert.equal(source.listenerCount("data"), 0);
});

test("streaming sanitizer rejects split CSI/OSC/DCS controls and split known credentials", () => {
  const text = new StreamingText(["private-token"]);
  const chunks = ["ok\u001b[3", "1m red\u001b[0m ", "\u001b]52;c;malicious", "clipboard\u0007", "key: private-", "token", "\u001bPdiscard", "\u001b\\ done\u202e"];
  const result = chunks.map((chunk) => text.push(chunk)).join("") + text.finish();
  assert.equal(result, "ok red key: [redacted] done");
  assert.equal(sanitizeText("bad\r\b\u0000\u009b31m text\u202e"), "bad text");
});

test("interrupted secret prefixes and unterminated escape sequences are discarded, not replayed next turn", () => {
  const text = new StreamingText(["private-token"]);
  assert.equal(text.push("private-"), ""); text.discard();
  assert.equal(text.push("next"), "next"); assert.equal(text.finish(), "");
  assert.equal(text.push("\u001b]0;hidden"), ""); text.discard();
  assert.equal(text.push("fresh"), "fresh");
});
