import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import {
  API_KEY_ENV, loginCodexBrowser, loginCodexDevice, OPENAI_CODEX, openCredentialStore, readPiCodexLogin, type OAuthCredential,
} from "@kumi/runtime";
import { DEFAULT_CODEX_MODEL, readSettings, writeSettings, type AppConfig } from "./config.js";

interface Io { out: Writable; env: Readonly<Record<string, string | undefined>>; signal: AbortSignal; openBrowser?: (url: string) => void }

export async function login(config: Extract<AppConfig, { mode: "login" }>, io: Io): Promise<void> {
  const store = openCredentialStore(config.authFile);
  let credential: OAuthCredential;
  if (config.method === "import-pi") credential = await readPiCodexLogin(config.piAuthFile);
  else if (config.method === "device") {
    credential = await loginCodexDevice({ signal: io.signal, onCode: ({ url, code }) => io.out.write(`Open ${url} and enter the code ${code}\nWaiting for approval...\n`) });
  } else {
    credential = await loginCodexBrowser({ signal: io.signal, onUrl: (url) => {
      io.out.write(`Sign in to ChatGPT in your browser. If it did not open, visit:\n${url}\nWaiting for the browser... (Ctrl-C cancels; use --device on a remote machine)\n`);
      io.openBrowser?.(url);
    } });
  }
  await store.update(OPENAI_CODEX, async () => credential);
  io.out.write(`Signed in to ChatGPT (openai-codex). Saved to ${store.path} (owner-only).\n`);
  if (config.method === "import-pi") {
    io.out.write("Imported from Pi: Kumi and Pi now share this session, so when either refreshes it the other may need to sign in again. Run login without --from-pi for a separate session.\n");
  }
  const settings = readSettings(config.settingsFile);
  if (!io.env.KUMI_MODEL && !settings.model) {
    writeSettings(config.settingsFile, { ...settings, model: DEFAULT_CODEX_MODEL });
    io.out.write(`Model: ${DEFAULT_CODEX_MODEL} (change with: npm run kumi -- model <provider>/<model>)\n`);
  }
}

export async function logout(config: Extract<AppConfig, { mode: "logout" }>, io: Pick<Io, "out">): Promise<void> {
  const store = openCredentialStore(config.authFile);
  const existed = Boolean(await store.get(OPENAI_CODEX));
  if (existed) await store.update(OPENAI_CODEX, async () => undefined);
  io.out.write(existed ? `Removed the local openai-codex sign-in from ${store.path}.\n` : "Not signed in to openai-codex.\n");
}

/** Which providers are usable, without printing any credential. */
export async function authStatus(config: Extract<AppConfig, { mode: "auth" }>, io: Pick<Io, "out" | "env">): Promise<void> {
  const codex = await openCredentialStore(config.authFile).get(OPENAI_CODEX);
  const hours = codex ? Math.floor((codex.expires - Date.now()) / 3_600_000) : 0;
  const lines = [`openai-codex  ${!codex ? "not signed in" : hours >= 1 ? `signed in (token valid ~${hours} h; refreshes automatically)` : "signed in (token refreshes on next use)"}`];
  for (const [provider, variable] of Object.entries(API_KEY_ENV)) {
    lines.push(`${provider.padEnd(13)} ${io.env[variable] ? `API key from ${variable}` : `not configured (${variable})`}`);
  }
  const model = io.env.KUMI_MODEL ? `${io.env.KUMI_MODEL} (from KUMI_MODEL)` : readSettings(config.settingsFile).model ?? "not chosen (npm run kumi -- model <provider>/<model>)";
  io.out.write(`${lines.join("\n")}\nModel: ${model}\nCredential file: ${config.authFile}\n`);
}

export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try { spawn(command, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch { /* URL is printed */ }
}
