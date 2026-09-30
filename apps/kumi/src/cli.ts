#!/usr/bin/env node
import {
  createAbletonIntegration, createAgentKernel, createConversationStore, createInferenceOnlyIntegration, createMemoryStore, createProjectStore, createRecipeStore, createSession, createTechniqueStore, configurePrograms, KUMI_VERSION, KumiError, openCredentialStore, withFallback,
  type Kernel, type KernelCheckpoint,
} from "@kumi/runtime";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { liveUserLibrary, loadConfig, loadGapsFile, loadInputHistoryFile, loadMemoryFile, loadTechniquesFile, loadProjectsDir, loadRecipesDir, loadSettingsFile, loadToolsDir, loadVideosDir, readSettings, safeError, SUPPORTED_NODE_MAJORS, writeSettings } from "./config.js";
import { openInputHistory } from "./history.js";
import { setupBridge } from "./bridge-setup.js";
import { readBridgeServer, runDoctor, type LiveProbe } from "./doctor.js";
import { writeReport } from "./report.js";
import { newerKumi, olderBridge, runUpdate } from "./update.js";
import { authStatus, login, logout, openBrowser } from "./login.js";
import { createModelControl } from "./models.js";
import { createTerminal, type Terminal } from "./terminal.js";
import { createTui } from "./tui/app.js";

const HELP = `Kumi ${KUMI_VERSION} — producer assistant for Ableton Live

First run (Node.js 22 or 24):
  npm run setup                          Install and build Kumi and the Ableton bridge
  npm run kumi -- bridge                 With Live closed: put the bridge into Live, or bring it up to date
  npm run kumi                           Talk about the open Live Set; the installed bridge is found automatically.
                                         Sign in there with /login, and choose a model with /model.

More:
  npm run kumi -- --inference-only       Chat without Live
  npm run kumi -- --bridge-config /absolute/path/bridge-config.json
  npm run kumi -- login <provider>       Sign in from the shell: openai-codex with a ChatGPT plan (--device
                                         without a browser); anthropic, openai, opencode with an API key (asked for)
  npm run kumi -- logout <provider>      Remove Kumi's sign-in for that provider
  npm run kumi -- model [<provider>/<model>]   Show or choose the model
  npm run kumi -- auth                   Show which providers are usable (no secrets)
  npm run kumi -- doctor                 Check Node, sign-in, the bridge, Live and the terminal
  npm run kumi -- update                 Bring Kumi up to date, and the bridge in Live when it's older
  npm run kumi -- report                 Write a file to send when something goes wrong (no keys in it)
  npm run kumi -- --version              Show Kumi's version

Providers: openai-codex (ChatGPT), anthropic, openai, opencode and opencode-go (OpenCode Zen and Go share
a key). An API key in ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENCODE_API_KEY is used when set.
KUMI_MODEL overrides the chosen model.
Kumi reads the open Live Set and makes the changes you ask for; each change can be undone. It plays, records
and bounces when you ask, listens to audio (a reference, a sample, a recording) and compares it, keeps short notes
of what you tell it that Live can't show, and saves your ways of working as recipes to replay, including ones it
learns by watching you.
In a session: /help /status /model /effort /login /logout /memory /recipes /conversations /undo /refresh /reconnect /new /quit. Ctrl-C cancels work, or exits if idle.
KUMI_TRACE=1 prints MCP dispatch names only.
`;
const BRIDGE_MISSING = "The Ableton bridge isn't installed yet, so Kumi can't see Live; chatting without it. To connect Live, quit Live and run: npm run kumi -- bridge";
const secrets = [process.env.AI_GATEWAY_API_KEY, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.OPENCODE_API_KEY]
  .filter((value): value is string => Boolean(value));

/**
 * A kernel for when the model can't be reached yet (none chosen, not signed in): Kumi still starts
 * and reads Live, and each answer says what's missing, so the app can offer the fix. It keeps the
 * conversation it was given for the kernel that replaces it.
 */
function unavailableKernel(error: KumiError, checkpoint: KernelCheckpoint | undefined): Kernel {
  return { async run() { throw error; }, async close() {}, ...(checkpoint ? { checkpoint: () => checkpoint } : {}) };
}

/** Start the bridge the way Kumi does, ask Live how it is, and stop again. */
async function probeLive(bridgeConfig: string): Promise<LiveProbe> {
  const integration = createAbletonIntegration({ bridgeConfig, onConnection: () => {} });
  try { await integration.start(AbortSignal.timeout(20_000)); }
  catch { await integration.close().catch(() => {}); return { started: false }; }
  try {
    const observation = await integration.observe(AbortSignal.timeout(20_000));
    const context = JSON.parse(observation.context) as { mode?: string; liveVersion?: unknown; provenance?: unknown; set?: { name?: unknown } };
    if (context.mode === "inference-only" || !observation.tools.length) return { started: true, connected: false };
    return { started: true, connected: true, ...(typeof context.liveVersion === "string" ? { liveVersion: context.liveVersion } : {}),
      ...(typeof context.set?.name === "string" ? { set: context.set.name } : {}), realLive: context.provenance === "real-live" };
  } catch { return { started: true, connected: false }; }
  finally { await integration.close().catch(() => {}); }
}
const bundledBridgeVersion = (() => {
  try { return (JSON.parse(readFileSync(new URL("../../../mcp-server/package.json", import.meta.url), "utf8")) as { version?: string }).version; } catch { return undefined; }
})();

try {
  // The doctor and the report run on any Node, so they can say that along with everything else.
  const doctor = process.argv.length === 3 && (process.argv[2] === "doctor" || process.argv[2] === "report");
  if (!doctor && !SUPPORTED_NODE_MAJORS.includes(Number(process.versions.node.split(".")[0]))) {
    throw new Error(`Kumi needs Node.js 22 or 24 (this is ${process.version}); install Node 24 LTS from https://nodejs.org.`);
  }
  const config = loadConfig(process.argv.slice(2));
  if (config.mode === "doctor") process.exitCode = await runDoctor({ out: process.stdout, env: process.env, probeLive, ...(bundledBridgeVersion ? { bundledBridgeVersion } : {}) });
  else if (config.mode === "update") process.exitCode = await runUpdate({ out: process.stdout, env: process.env });
  else if (config.mode === "report") process.exitCode = await writeReport({ out: process.stdout, env: process.env, probeLive, ...(bundledBridgeVersion ? { bundledBridgeVersion } : {}) });
  else if (config.mode === "help") process.stdout.write(HELP);
  else if (config.mode === "version") process.stdout.write(`Kumi ${KUMI_VERSION}\n`);
  else if (config.mode === "bridge") process.exitCode = await setupBridge({ out: process.stdout, env: process.env, input: process.stdin, yes: config.yes, allowDirty: config.allowDirty });
  else if (config.mode === "auth") await authStatus(config, { out: process.stdout, env: process.env });
  else if (config.mode === "logout") await logout(config, { out: process.stdout, env: process.env });
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
      await login(config, { out: process.stdout, env: process.env, signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(15 * 60_000)]), input: process.stdin,
        ...(process.stdout.isTTY ? { openBrowser } : {}) });
    } finally { process.removeListener("SIGINT", interrupt); }
  } else {
    const store = openCredentialStore(config.authFile);
    for (const credential of Object.values(await store.list().catch(() => ({})))) {
      if (credential.type === "oauth") secrets.push(credential.access, credential.refresh); else secrets.push(credential.key);
    }
    let terminal: Terminal | undefined;
    // A missing sign-in or model isn't a reason not to start: the app offers /login and /model.
    const models = createModelControl({ store, settingsFile: loadSettingsFile(), env: process.env, changed: async () => { await controller.reconfigure?.(); } });
    const controller = createSession({
      kernelFactory: async (options) => {
        try { return createAgentKernel({ ...options, binding: await models.binding() }); }
        catch (error) { if (error instanceof KumiError) return unavailableKernel(error, options.checkpoint); throw error; }
      },
      integrationFactory: (onConnection) => config.mode === "inference-only" ? createInferenceOnlyIntegration(onConnection)
        : withFallback(createAbletonIntegration({ onConnection, bridgeConfig: config.bridgeConfig,
          onFocus: (focus) => terminal?.handleEvent({ type: "focus", focus }),
          // Kumi's changes are kept with the conversation too, for its HISTORY when it's resumed.
          onChange: (change) => { controller.watch?.({ type: "change", change }); terminal?.handleEvent({ type: "change", change }); },
          onAction: (action) => { controller.watch?.({ type: "action", ...action }); terminal?.handleEvent({ type: "action", ...action }); },
          onWatch: (on) => terminal?.handleEvent({ type: "watching", on }),
          onAudition: (event) => terminal?.handleEvent(event),
          projectStore: createProjectStore(loadProjectsDir()),
          ...(liveUserLibrary() ? { userLibrary: liveUserLibrary()! } : {}),
          onCatchUp: (catchUp) => terminal?.handleEvent({ type: "catch-up", catchUp }),
          ...(process.env.KUMI_TRACE === "1" ? { onDispatch: (name: string) => terminal?.handleEvent({ type: "notice", message: `[MCP dispatch] ${name}` }) } : {}),
        }),
        // A bridge that won't start: chat without Live, and say how to fix it. With Live's part as new as
        // Kumi's, it stopped because Live didn't answer (not open, not using the bridge, or held by a dialog).
        () => createInferenceOnlyIntegration(onConnection), (message) => {
          let installed: string | undefined;
          try { installed = config.mode === "live" ? readBridgeServer(config.bridgeConfig).version : undefined; } catch { installed = undefined; }
          const current = installed !== undefined && installed === bundledBridgeVersion;
          terminal?.handleEvent({ type: "notice", message: current
            ? "Kumi's bridge couldn't reach Live, so this is chat without Live. Open Live and choose AbletonMcpBridge as a Control Surface (Settings → Link, Tempo & MIDI); if Live is showing a dialog, answer it. Then /reconnect."
            : message });
        }),
      onEvent: (event) => terminal?.handleEvent(event),
      ...(config.mode === "live" ? { conversations: createConversationStore(loadProjectsDir()) } : {}),
      memory: createMemoryStore({ projectsDir: loadProjectsDir(), producerFile: loadMemoryFile() }),
      listen: true,
      recipes: createRecipeStore(loadRecipesDir()),
      techniques: createTechniqueStore(loadTechniquesFile()),
      gaps: loadGapsFile(),
      watch: { videosDir: loadVideosDir(), toolsDir: loadToolsDir() },
    });
    // The full-screen app needs a real terminal; pipes, and KUMI_UI=plain (e.g. for screen readers), get plain lines.
    const fullScreen = Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.KUMI_UI !== "plain";
    // Programs Kumi fetches when first needed (ffmpeg, off a Mac) go in its tools folder, and it says so.
    configurePrograms({ toolsDir: loadToolsDir(), onFetch: (message) => terminal?.handleEvent({ type: "notice", message }) });
    const stale = config.mode === "live" ? olderBridge(process.env, bundledBridgeVersion) : undefined;
    terminal = (fullScreen ? createTui : createTerminal)({ controller, input: process.stdin, output: process.stdout, models, mode: config.mode, secrets,
      history: openInputHistory(loadInputHistoryFile(), secrets), openBrowser,
      panelTab: { load: () => readSettings(loadSettingsFile()).panelTab, save: (id) => { try { writeSettings(loadSettingsFile(), { ...readSettings(loadSettingsFile()), panelTab: id }); } catch { /* next time, then */ } } },
      ...(config.mode === "inference-only" && config.bridgeMissing ? { startupNotice: BRIDGE_MISSING } : stale ? { startupNotice: `The bridge in Live is ${stale.installed}, older than this Kumi's (${stale.bundled}), so some changes aren't offered. Quit Kumi and Live, then run: npm run kumi -- update` } : {}) });
    const interrupt = () => terminal?.interrupt();
    const terminate = () => { void terminal?.close(); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    const running = terminal.run();
    // A newer Kumi, asked of git at most once a day while Kumi starts; nothing is said without one.
    void newerKumi({ cacheFile: join(dirname(loadSettingsFile()), "update-check.json") })
      .then((latest) => { if (latest) terminal?.handleEvent({ type: "notice", message: `Kumi ${latest} is out (this is ${KUMI_VERSION}). Quit Kumi, then run: npm run kumi -- update` }); }, () => {});
    try { process.exitCode = await running; }
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
