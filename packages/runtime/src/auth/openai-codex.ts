import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { KumiError } from "../core/errors.js";
import type { CredentialStore, OAuthCredential } from "./store.js";
import { KUMI } from "../command.js";

// ChatGPT-plan sign-in, as used by Codex. There is no third-party client registration, so Kumi uses
// Codex's public client ID and identifies itself honestly through `originator` and its User-Agent.
export const OPENAI_CODEX = "openai-codex";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;
export const DEVICE_VERIFICATION_URL = `${AUTH_BASE}/codex/device`;
const SCOPE = "openid profile email offline_access";
const REFRESH_MARGIN_MS = 5 * 60_000;
const DEVICE_TIMEOUT_MS = 15 * 60_000;
export const LOGIN_HINT = `Sign in with /login in Kumi, or: ${KUMI} login openai-codex`;

type Fetch = typeof fetch;
export interface LoginOptions { signal: AbortSignal; fetch?: Fetch }

export function accountIdFromToken(token: string): string | undefined {
  const id = claims(token)?.["https://api.openai.com/auth"];
  const account = id && typeof id === "object" ? (id as Record<string, unknown>).chatgpt_account_id : undefined;
  return typeof account === "string" && account ? account : undefined;
}

function claims(token: string): Record<string, unknown> | undefined {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

async function requestTokens(body: URLSearchParams, options: LoginOptions, previousRefresh?: string): Promise<OAuthCredential> {
  const response = await (options.fetch ?? fetch)(TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: options.signal,
  });
  if (!response.ok) {
    throw new KumiError("auth", previousRefresh
      ? `OpenAI sign-in could not be refreshed (HTTP ${response.status}). ${LOGIN_HINT}`
      : `OpenAI sign-in failed (HTTP ${response.status}).`, OPENAI_CODEX);
  }
  const json = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  const refresh = typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : previousRefresh;
  if (typeof json.access_token !== "string" || !json.access_token || !refresh) throw new KumiError("auth", "OpenAI returned an incomplete token response.", OPENAI_CODEX);
  const accountId = accountIdFromToken(json.access_token);
  if (!accountId) throw new KumiError("auth", "The OpenAI token has no ChatGPT account; sign in with a ChatGPT plan that includes Codex.", OPENAI_CODEX);
  const exp = claims(json.access_token)?.exp;
  const expires = typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1000
    : typeof exp === "number" ? exp * 1000 : Date.now() + 60 * 60_000;
  return { type: "oauth", access: json.access_token, refresh, expires, accountId };
}

export function refreshCodexCredential(credential: OAuthCredential, options: LoginOptions): Promise<OAuthCredential> {
  return requestTokens(new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refresh, client_id: CLIENT_ID }), options, credential.refresh);
}

/** PKCE authorization-code flow with a one-shot callback server on localhost:1455. */
export async function loginCodexBrowser(options: LoginOptions & { onUrl(url: string): void; port?: number }): Promise<OAuthCredential> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const url = new URL(`${AUTH_BASE}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state,
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "kumi",
  })) url.searchParams.set(key, value);
  const code = await new Promise<string>((resolve, reject) => {
    const page = (message: string) => `<!doctype html><meta charset="utf-8"><title>Kumi</title><p style="font:16px system-ui;margin:3rem">${message}</p>`;
    const server = createServer((request, response) => {
      const callback = new URL(request.url ?? "/", "http://localhost");
      if (callback.pathname !== "/auth/callback") { response.writeHead(404).end(); return; }
      const received = callback.searchParams.get("code");
      const valid = callback.searchParams.get("state") === state && received && !callback.searchParams.get("error");
      response.writeHead(valid ? 200 : 400, { "content-type": "text/html; charset=utf-8", connection: "close" })
        .end(page(valid ? "Kumi is signed in. You can close this tab." : "Sign-in failed. Return to the terminal."));
      finish(valid ? undefined : new KumiError("auth", "OpenAI sign-in was denied or returned an invalid callback."), received ?? undefined);
    });
    const onAbort = () => finish(new KumiError("auth", "Sign-in cancelled."));
    let settled = false;
    function finish(error: Error | undefined, value?: string) {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      server.close(); server.closeAllConnections();
      if (error || !value) reject(error ?? new KumiError("auth", "OpenAI sign-in returned no code.")); else resolve(value);
    }
    server.once("error", (error: NodeJS.ErrnoException) => finish(new KumiError("auth", error.code === "EADDRINUSE"
      ? "Port 1455 is busy (another sign-in may be open). Close it and retry, or use --device."
      : "Could not start the local sign-in callback; use --device.")));
    if (options.signal.aborted) { onAbort(); return; }
    options.signal.addEventListener("abort", onAbort, { once: true });
    server.listen(options.port ?? 1455, "127.0.0.1", () => options.onUrl(url.toString()));
  });
  return requestTokens(new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: REDIRECT_URI }), options);
}

/** Device-code flow for machines without a local browser. */
export async function loginCodexDevice(options: LoginOptions & { onCode(prompt: { url: string; code: string }): void }): Promise<OAuthCredential> {
  const fetchImpl = options.fetch ?? fetch;
  const post = (path: string, body: object) => fetchImpl(`${AUTH_BASE}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: options.signal,
  });
  const start = await post("/api/accounts/deviceauth/usercode", { client_id: CLIENT_ID });
  if (!start.ok) throw new KumiError("auth", start.status === 404 ? "Device sign-in is not available; use browser sign-in." : `Device sign-in could not start (HTTP ${start.status}).`);
  const device = await start.json() as { device_auth_id?: unknown; user_code?: unknown; interval?: unknown };
  let interval = Number(device.interval);
  if (typeof device.device_auth_id !== "string" || typeof device.user_code !== "string" || !Number.isFinite(interval)) {
    throw new KumiError("auth", "OpenAI returned an invalid device sign-in response.");
  }
  interval = Math.max(1, interval);
  options.onCode({ url: DEVICE_VERIFICATION_URL, code: device.user_code });
  for (const deadline = Date.now() + DEVICE_TIMEOUT_MS; Date.now() < deadline;) {
    await delay(interval * 1000, undefined, { signal: options.signal });
    const poll = await post("/api/accounts/deviceauth/token", { device_auth_id: device.device_auth_id, user_code: device.user_code });
    if (poll.ok) {
      const grant = await poll.json() as { authorization_code?: unknown; code_verifier?: unknown };
      if (typeof grant.authorization_code !== "string" || typeof grant.code_verifier !== "string") throw new KumiError("auth", "OpenAI returned an invalid device grant.");
      return requestTokens(new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code: grant.authorization_code,
        code_verifier: grant.code_verifier, redirect_uri: DEVICE_REDIRECT_URI }), options);
    }
    if (poll.status === 403 || poll.status === 404) continue;
    const body = await poll.json().catch(() => ({})) as { error?: unknown };
    const code = body.error && typeof body.error === "object" ? (body.error as { code?: unknown }).code : body.error;
    if (code === "deviceauth_authorization_pending") continue;
    if (code === "slow_down") { interval += 5; continue; }
    throw new KumiError("auth", `Device sign-in failed (HTTP ${poll.status}).`);
  }
  throw new KumiError("auth", "Device sign-in expired; try again.");
}

/** One-time migration from the Pi-based POC's login. Only the openai-codex entry is read. */
export async function readPiCodexLogin(path: string): Promise<OAuthCredential> {
  let entry: Record<string, unknown> | undefined;
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const value = data[OPENAI_CODEX];
    entry = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch { throw new KumiError("auth", `No readable Pi login at ${path}.`); }
  const { access, refresh, expires } = entry ?? {};
  if (entry?.type !== "oauth" || typeof access !== "string" || !access || typeof refresh !== "string" || !refresh || typeof expires !== "number") {
    throw new KumiError("auth", "The Pi login has no ChatGPT (openai-codex) session to import.");
  }
  const accountId = typeof entry.accountId === "string" && entry.accountId ? entry.accountId : accountIdFromToken(access);
  if (!accountId) throw new KumiError("auth", "The Pi login has no ChatGPT account ID.");
  return { type: "oauth", access, refresh, expires, accountId };
}

export interface CodexToken { access: string; accountId: string }

/** Current access token, refreshed shortly before expiry under the store lock (another process may already have refreshed). */
export function codexTokenSource(store: CredentialStore, options: { fetch?: Fetch; now?: () => number } = {}): () => Promise<CodexToken> {
  const now = options.now ?? Date.now;
  let refreshing: Promise<OAuthCredential | undefined> | undefined;
  const fresh = (credential: OAuthCredential) => credential.expires - now() > REFRESH_MARGIN_MS;
  return async () => {
    const current = await store.get(OPENAI_CODEX);
    if (current?.type !== "oauth") throw new KumiError("auth", `Not signed in to ChatGPT (openai-codex). ${LOGIN_HINT}`, OPENAI_CODEX);
    if (fresh(current)) return { access: current.access, accountId: current.accountId };
    refreshing ??= store.update(OPENAI_CODEX, async (latest) => {
      if (latest?.type !== "oauth") throw new KumiError("auth", `Not signed in to ChatGPT (openai-codex). ${LOGIN_HINT}`, OPENAI_CODEX);
      if (fresh(latest)) return latest;
      // Not tied to one caller's cancellation: concurrent requests share this refresh.
      return refreshCodexCredential(latest, { signal: AbortSignal.timeout(30_000), ...(options.fetch ? { fetch: options.fetch } : {}) });
    }).finally(() => { refreshing = undefined; }) as Promise<OAuthCredential | undefined>;
    const credential = await refreshing;
    return { access: credential!.access, accountId: credential!.accountId };
  };
}
