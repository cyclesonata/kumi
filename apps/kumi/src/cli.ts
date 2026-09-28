#!/usr/bin/env node
import {
  createAbletonIntegration, createAgentKernel, createInferenceOnlyIntegration, createProjectStore, createSession, openCredentialStore, resolveModel,
} from "@kumi/runtime";
import { loadConfig, loadProjectsDir, readSettings, safeError, SUPPORTED_NODE_MAJORS, writeSettings } from "./config.js";
import { authStatus, login, logout, openBrowser } from "./login.js";
import { createTerminal, type Terminal } from "./terminal.js";
import { createTui } from "./tui/app.js";

const HELP = `Kumi — producer assistant for Ableton Live

First run (Node.js 22 or 24):
  npm run setup                          Install and build Kumi and the Ableton bridge
  npm run kumi -- login openai-codex     Sign in with a ChatGPT plan (--device without a browser)
  npm run kumi                           Talk about the open Live Set; the installed bridge is found automatically

More:
  npm run kumi -- --inference-only       Chat without Live
  npm run kumi -- --bridge-config /absolute/path/bridge-config.json
  npm run kumi -- model [<provider>/<model>]   Show or choose the model
  npm run kumi -- auth                   Show which providers are usable (no secrets)
  npm run kumi -- logout openai-codex    Remove the local ChatGPT sign-in

Providers: openai-codex (ChatGPT sign-in), openai (OPENAI_API_KEY), anthropic (ANTHROPIC_API_KEY),
opencode and opencode-go (OPENCODE_API_KEY). KUMI_MODEL overrides the chosen model.
Kumi reads the open Live Set and makes changes you ask for; each change can be undone. Playback control,
recording, listening and memory are not implemented yet.
In a session: /help /status /undo /refresh /new /quit. Ctrl-C cancels work, or exits if idle.
KUMI_TRACE=1 prints MCP dispatch names only.
`;
const BRIDGE_MISSING = "The Ableton bridge isn't installed yet, so Kumi can't see Live; chatting without it. To connect Live, see docs/en/KUMI_POC.md (Connect to Live).";
const secrets = [process.env.AI_GATEWAY_API_KEY, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.OPENCODE_API_KEY]
  .filter((value): value is string => Boolean(value));

try {
  if (!SUPPORTED_NODE_MAJORS.includes(Number(process.versions.node.split(".")[0]))) {
    throw new Error(`Kumi needs Node.js 22 or 24 (this is ${process.version}); install Node 24 LTS from https://nodejs.org.`);
  }
  const config = loadConfig(process.argv.slice(2));
  if (config.mode === "help") process.stdout.write(HELP);
  else if (config.mode === "auth") await authStatus(config, { out: process.stdout, env: process.env });
  else if (config.mode === "logout") await logout(config, { out: process.stdout });
  else if (config.mode === "model") {
    const settings = readSettings(config.settingsFile);
    if (config.model) writeSettings(config.settingsFile, { ...settings, model: config.model });
    const chosen = config.model ?? settings.model;
    process.stdout.write(config.model ? `Model set to ${config.model}.\n` : `Model: ${chosen ?? "not chosen"}. Change it with: npm run kumi -- model <provider>/<model>\n`);
    if (process.env.KUMI_MODEL) process.stdout.write(`KUMI_MODEL=${process.env.KUMI_MODEL} currently overrides it.\n`);
  } else if (config.mode === "login") {
    const cancel = new AbortController();
    const interrupt = () => cancel.abort();
    process.once("SIGINT", interrupt);
    try {
      await login(config, { out: process.stdout, env: process.env, signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(15 * 60_000)]),
        ...(process.stdout.isTTY ? { openBrowser } : {}) });
    } finally { process.removeListener("SIGINT", interrupt); }
  } else {
    const store = openCredentialStore(config.authFile);
    // Fails here, before the terminal starts, when the provider has no usable credentials.
    const binding = await resolveModel({ model: config.model, store, env: process.env });
    for (const credential of Object.values(await store.list())) secrets.push(credential.access, credential.refresh);
    let terminal: Terminal | undefined;
    const controller = createSession({
      kernelFactory: async (options) => createAgentKernel({ ...options, binding }),
      integrationFactory: (onConnection) => config.mode === "inference-only" ? createInferenceOnlyIntegration(onConnection)
        : createAbletonIntegration({ onConnection, bridgeConfig: config.bridgeConfig,
          onFocus: (focus) => terminal?.handleEvent({ type: "focus", focus }),
          onChange: (change) => terminal?.handleEvent({ type: "change", change }),
          projectStore: createProjectStore(loadProjectsDir()),
          onCatchUp: (catchUp) => terminal?.handleEvent({ type: "catch-up", catchUp }),
          ...(process.env.KUMI_TRACE === "1" ? { onDispatch: (name: string) => terminal?.handleEvent({ type: "notice", message: `[MCP dispatch] ${name}` }) } : {}),
        }),
      onEvent: (event) => terminal?.handleEvent(event),
    });
    // The full-screen app needs a real terminal; pipes, and KUMI_UI=plain (e.g. for screen readers), get plain lines.
    const fullScreen = Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.KUMI_UI !== "plain";
    terminal = (fullScreen ? createTui : createTerminal)({ controller, input: process.stdin, output: process.stdout, model: config.model, mode: config.mode, secrets,
      ...(config.mode === "inference-only" && config.bridgeMissing ? { startupNotice: BRIDGE_MISSING } : {}) });
    const interrupt = () => terminal?.interrupt();
    const terminate = () => { void terminal?.close(); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    try { process.exitCode = await terminal.run(); }
    finally {
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
      // Normally exit naturally. A leaked dependency handle must not hang the TUI
      // indefinitely after bounded cleanup. Only this Kumi process is terminated.
      const watchdog = setTimeout(() => {
        process.stderr.write("Kumi shutdown left a live handle; terminating this Kumi process.\n"); process.exit(1);
      }, 2_000);
      watchdog.unref();
    }
  }
} catch (error) {
  process.stderr.write(`Kumi: ${safeError(error, secrets)}\n`);
  process.exitCode = 1;
}
