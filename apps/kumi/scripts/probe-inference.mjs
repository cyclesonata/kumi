#!/usr/bin/env node
// Opt-in authenticated Gate A. Uses only a harmless nonce tool; never connects to Live.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createAgentKernel, openCredentialStore, resolveModel } from "@kumi/runtime";
import { loadInferenceConfig, safeError } from "../dist/src/config.js";

let kernel;
let activeController;
let stage = "arguments";
let interrupted = false;
let unhandled = 0;
const report = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const onUnhandled = () => { unhandled++; };
const onInterrupt = () => { interrupted = true; activeController?.abort(); };
async function deadline(promise, ms, message, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { try { onTimeout(); } finally { reject(new Error(message)); } }, ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function prompt(label, input, { cancelOnText = false } = {}) {
  if (interrupted) throw new Error("Probe interrupted");
  stage = label;
  const controller = new AbortController();
  activeController = controller;
  const started = performance.now();
  let firstTextMs;
  let cancellationAt;
  let text = "";
  const tools = [];
  try {
    const running = kernel.run(input, controller.signal, (event) => {
      if (controller.signal.aborted) return;
      if (event.type === "text" && event.text) {
        firstTextMs ??= performance.now() - started;
        text += event.text;
        if (Buffer.byteLength(text) > 64 * 1024) throw new Error("Probe response exceeded 64 KiB");
        process.stdout.write(event.text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ""));
        if (cancelOnText) { cancellationAt = performance.now(); controller.abort(); }
      } else if (event.type === "tool-start" || event.type === "tool-end") {
        tools.push(event);
        report({ stage: label, event: event.type, tool: event.name, ...(event.type === "tool-end" ? { isError: event.isError, elapsedMs: event.elapsedMs } : {}) });
      }
    });
    const result = await deadline(running, 120_000, "Inference turn timed out", () => controller.abort());
    process.stdout.write("\n");
    if (interrupted) throw new Error("Probe interrupted");
    assert(firstTextMs !== undefined && text.trim(), "Model must stream nonempty text");
    if (cancelOnText) {
      assert(cancellationAt !== undefined, "Cancellation must occur during active streaming");
      assert.equal(result.stopReason, "cancelled");
      assert(performance.now() - cancellationAt < 5_000, "Cancellation exceeded five seconds");
    } else assert.equal(result.stopReason, "completed");
    report({ stage: label, passed: true, firstTextMs: Math.round(firstTextMs), totalMs: Math.round(performance.now() - started),
      stopReason: result.stopReason, usage: result.usage ?? "unavailable",
      ...(cancelOnText ? { cancellationMs: Math.round(performance.now() - cancellationAt) } : {}),
    });
    return { text, tools };
  } finally { controller.abort(); activeController = undefined; }
}
process.on("unhandledRejection", onUnhandled);
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);
const watchdog = setTimeout(() => {
  process.stderr.write("Gate A failed: watchdog expired; bounded shutdown could not be verified.\n");
  activeController?.abort();
  void kernel?.close();
  setTimeout(() => process.exit(1), 5_000);
}, 10 * 60_000);
try {
  if (process.argv.length !== 2) throw new Error("The inference probe takes no arguments; configure KUMI_MODEL and sign in locally.");
  const providers = Object.fromEntries(["@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/openai-compatible"].map((name) =>
    [name, JSON.parse(readFileSync(new URL("package.json", import.meta.resolve(name).replace(/dist\/.*$/, "")), "utf8")).version]));
  report({ timestamp: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, kernel: "kumi", providers });
  stage = "configuration";
  const config = loadInferenceConfig();
  const provider = config.model.split("/")[0];
  report({ stage, model: config.model, authentication: provider === "openai-codex" ? "ChatGPT OAuth; credentials not logged" : "API key; not logged" });
  let nonce;
  let toolCalls = 0;
  stage = "agent-create";
  const binding = await resolveModel({ model: config.model, store: openCredentialStore(config.authFile), env: process.env });
  kernel = createAgentKernel({
    binding, signal: new AbortController().signal,
    instructions: "You are a concise integration diagnostic. Follow output instructions exactly. Call diagnostic_nonce only when explicitly requested, exactly once, then report the actual returned nonce. Never invent a tool result.",
    tools: [{
      name: "diagnostic_nonce", description: "Return an unpredictable diagnostic nonce. No side effects or external data.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, signal) {
        signal.throwIfAborted(); toolCalls++;
        nonce = randomBytes(16).toString("hex");
        return { text: JSON.stringify({ nonce }) };
      },
    }],
  });
  const marker = `memory_${randomBytes(12).toString("hex")}`;
  await prompt("authenticated-stream", `Remember this marker for my next question: ${marker}. Reply with a brief acknowledgement, without using tools.`);
  const followup = await prompt("same-agent-followup", "What marker did I just ask you to remember? Reply with only the exact marker; do not use tools.");
  assert(followup.text.includes(marker), "Follow-up did not retain the conversation marker");
  const diagnostic = await prompt("nonce-tool", "Call diagnostic_nonce now, exactly once. Then reply with only the actual nonce it returned.");
  assert.equal(toolCalls, 1);
  assert(nonce && diagnostic.text.includes(nonce), "Answer did not use the actual random tool result");
  const start = diagnostic.tools.find((event) => event.type === "tool-start" && event.name === "diagnostic_nonce");
  assert(start && diagnostic.tools.some((event) => event.type === "tool-end" && event.id === start.id && !event.isError), "Missing matching successful tool start/end events");
  await prompt("active-cancellation", "Write a numbered list from 1 to 10000, one number per line. Do not summarize or use tools.", { cancelOnText: true });
  const markerAfterCancel = `recovered_${randomBytes(12).toString("hex")}`;
  const recovery = await prompt("post-cancel-recovery", `Reply with only ${markerAfterCancel}. Do not use tools.`);
  assert.equal(recovery.text.trim(), markerAfterCancel);
  const settled = kernel.checkpoint().messages;
  assert(!JSON.stringify(settled).includes("10000, one number"), "Cancelled turn leaked into settled history");
  await deadline(kernel.close(), 5_000, "Kernel close timed out");
  kernel = undefined;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unhandled, 0);
  report({ gateA: "passed", kernel: "kumi", model: config.model, toolCalls, settledMessages: settled.length, unhandledRejections: 0, kernelClosed: true, cost: "unavailable; no price estimated" });
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`Gate A failed at ${stage}: ${safeError(error)}\n`);
} finally {
  activeController?.abort();
  if (kernel) {
    try { await deadline(kernel.close(), 5_000, "Kernel close timed out"); }
    catch (error) {
      process.exitCode = 1;
      process.stderr.write(`Gate A cleanup failed: ${safeError(error)}\n`);
      setTimeout(() => process.exit(1), 5_000).unref();
    }
  }
  clearTimeout(watchdog);
  process.removeListener("unhandledRejection", onUnhandled);
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onInterrupt);
}
