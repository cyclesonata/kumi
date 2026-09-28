// Opt-in interactive fixture. Synthetic MCP data, never an actual Live adapter.
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAgentKernel, createSession, openCredentialStore, resolveModel } from "../../../../packages/runtime/dist/src/index.js";
import { connectMcp } from "../../../../packages/runtime/dist/src/mcp/client.js";
import { AllowedTools } from "../../../../packages/runtime/dist/src/mcp/allowed-tools.js";
import { createTerminal } from "../../dist/src/terminal.js";
import { loadInferenceConfig } from "../../dist/src/config.js";
const real = process.env.KUMI_PTY_REAL === "1";
const inference = real ? loadInferenceConfig() : undefined;
const binding = real ? await resolveModel({ model: inference.model, store: openCredentialStore(inference.authFile), env: process.env }) : undefined;
let terminal;
let childPid;
let cancellationCount;
const controller = createSession({
  kernelFactory: real ? async (options) => createAgentKernel({ ...options, binding }) : async ({ tools }) => ({
    async run(input, signal, emit) {
      const prompt = input.split("\n\n<current_observation_untrusted>")[0];
      if (prompt === "delay") {
        emit({ type: "tool-start", name: "server_status", id: "fixture-delay" });
        await tools[0].execute({ action: "delay" }, signal);
        signal.throwIfAborted();
        emit({ type: "tool-end", name: "server_status", id: "fixture-delay", isError: false, elapsedMs: 60_000 });
      } else if (prompt === "stream") {
        for (let index = 0; index < 200; index++) { signal.throwIfAborted(); emit({ type: "text", text: `stream-${index} ` }); await delay(20, undefined, { signal }); }
      } else emit({ type: "text", text: `ECHO:${prompt}` });
      return { stopReason: "completed" };
    },
    async close() {},
  }),
  integrationFactory: (onConnection) => {
    let endpoint;
    let tools;
    return {
      async start(signal) {
        onConnection("connecting");
        endpoint = await connectMcp({ entry: fileURLToPath(new URL("../../../../packages/runtime/test/fixtures/mcp-server.mjs", import.meta.url)), signal });
        childPid = endpoint.pid;
        tools = new AllowedTools(endpoint);
        endpoint.onDisconnect(() => onConnection("disconnected"));
        onConnection("connected");
      },
      async observe(signal) {
        await tools.refresh(signal);
        return { key: "synthetic-pty", label: "SYNTHETIC PTY FIXTURE — NOT REAL LIVE", context: "Synthetic MCP fixture, no Live access.",
          instructions: "You are testing an interactive terminal, not Live. If the user says delay, call server_status with action=delay exactly once. It intentionally waits until cancellation. If they say recover, answer exactly PTY_RECOVERED. For cancellation count, call server_status with empty arguments and report CANCEL_COUNT=<cancelled field>. All responses are synthetic fixture evidence.",
          tools: tools.list().filter((tool) => tool.name === "server_status").map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
            async execute(args, signal) { const result = await tools.call(tool.name, args, signal); return { text: JSON.stringify(result), isError: Boolean(result.isError) }; },
          })),
        };
      },
      async close() {
        try {
          const result = await endpoint.call("server_status", {}, new AbortController().signal);
          cancellationCount = result.structuredContent?.cancelled;
        } finally { await tools.close(); }
      },
    };
  },
  onEvent: (event) => terminal?.handleEvent(event),
});
terminal = createTerminal({ controller, input: process.stdin, output: process.stdout, mode: "inference-only", model: real ? `${inference.model} [SYNTHETIC MCP FIXTURE]` : "deterministic-fixture [NO INFERENCE]" });
process.exitCode = await terminal.run();
let alive = false;
try { process.kill(childPid, 0); alive = true; } catch {}
console.error(JSON.stringify({ syntheticFixture: true, realInference: real, cancellationCount, ownedChildExited: !alive, exitCode: process.exitCode }));
if (alive) process.exitCode = 1;
