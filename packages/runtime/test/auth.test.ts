import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { accountIdFromToken, loginCodexBrowser, loginCodexDevice, readPiCodexLogin } from "../src/auth/openai-codex.js";
import { openCredentialStore, type OAuthCredential } from "../src/auth/store.js";

const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const token = (account = "acct-1") => jwt({ "https://api.openai.com/auth": { chatgpt_account_id: account } });
const credential = (refresh = "r"): OAuthCredential => ({ type: "oauth", access: token(), refresh, expires: Date.now() + 3_600_000, accountId: "acct-1" });
async function inTemp(body: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "kumi-auth-"));
  try { await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("credential store is owner-only, atomic, and removes entries on request", async () => {
  await inTemp(async (dir) => {
    const path = join(dir, "nested", "auth.json");
    const store = openCredentialStore(path);
    assert.equal(await store.get("openai-codex"), undefined);
    await store.update("openai-codex", async () => credential());
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(dir, "nested"))).mode & 0o777, 0o700);
    }
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).version, 1);
    await store.update("openai-codex", async () => undefined);
    assert.deepEqual(await store.list(), {});
    await assert.rejects(store.update("x", async () => ({ type: "oauth" }) as never), /malformed credential/);
  });
});

test("credential store keeps API keys beside sign-ins, and refuses anything that isn't one word", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kumi-auth-keys-"));
  try {
    const store = openCredentialStore(join(dir, "auth.json"));
    await store.update("anthropic", async () => ({ type: "api-key", key: "sk-ant-fixture-0001" }));
    assert.deepEqual(await openCredentialStore(join(dir, "auth.json")).get("anthropic"), { type: "api-key", key: "sk-ant-fixture-0001" });
    for (const key of ["", "short", "two words-here", "line\nbreak-0000", "x".repeat(4097)]) {
      await assert.rejects(store.update("openai", async () => ({ type: "api-key", key })), /malformed/);
    }
    assert.deepEqual(Object.keys(await store.list()), ["anthropic"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("credential store refuses readable-by-others and malformed files without printing their contents", async () => {
  await inTemp(async (dir) => {
    const path = join(dir, "auth.json");
    await writeFile(path, JSON.stringify({ version: 1, credentials: { "openai-codex": credential("secret-refresh") } }), { mode: 0o600 });
    // Windows keeps no POSIX modes to check (see the store).
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await assert.rejects(openCredentialStore(path).get("openai-codex"), /chmod 600/);
    }
    await writeFile(path, "{\"token\": \"secret-refresh\"", { mode: 0o600 });
    await chmod(path, 0o600);
    await assert.rejects(openCredentialStore(path).get("openai-codex"), (error: unknown) =>
      error instanceof Error && /malformed/.test(error.message) && !error.message.includes("secret-refresh"));
  });
});

test("concurrent updates from separate processes' stores serialize under the lock; stale locks are broken", async () => {
  await inTemp(async (dir) => {
    const path = join(dir, "auth.json");
    const slow = (value: OAuthCredential) => async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return value; };
    await Promise.all([openCredentialStore(path).update("a", slow(credential("a"))), openCredentialStore(path).update("b", slow(credential("b")))]);
    assert.deepEqual(Object.keys(await openCredentialStore(path).list()).sort(), ["a", "b"]);
    await writeFile(`${path}.lock`, "999999");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    await openCredentialStore(path).update("c", async () => credential("c"));
    const c = await openCredentialStore(path).get("c");
    assert.equal(c?.type === "oauth" ? c.refresh : undefined, "c");
  });
});

test("account IDs come only from the ChatGPT auth claim", () => {
  assert.equal(accountIdFromToken(token("acct-9")), "acct-9");
  for (const value of ["", "not-a-jwt", jwt({}), jwt({ "https://api.openai.com/auth": { chatgpt_account_id: 7 } })]) assert.equal(accountIdFromToken(value), undefined);
});

test("browser sign-in: PKCE, state check, one-shot localhost callback, token exchange", async () => {
  const port = await freePort();
  const exchanges: URLSearchParams[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    exchanges.push(init!.body as URLSearchParams);
    return Response.json({ access_token: token("acct-7"), refresh_token: "refresh-7", expires_in: 600 });
  };
  let authorize: URL | undefined;
  const login = loginCodexBrowser({ signal: new AbortController().signal, fetch: fetchImpl, port, onUrl: (url) => { authorize = new URL(url); } });
  while (!authorize) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(authorize.origin + authorize.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(authorize.searchParams.get("originator"), "kumi");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  const rejected = assert.rejects(login, /denied or returned an invalid callback/);
  const denied = await fetch(`http://127.0.0.1:${port}/auth/callback?code=x&state=wrong`);
  assert.equal(denied.status, 400);
  await rejected;
  assert.equal(exchanges.length, 0);

  let second: URL | undefined;
  const retry = loginCodexBrowser({ signal: new AbortController().signal, fetch: fetchImpl, port, onUrl: (url) => { second = new URL(url); } });
  while (!second) await new Promise((resolve) => setTimeout(resolve, 5));
  const callback = await fetch(`http://127.0.0.1:${port}/auth/callback?code=the-code&state=${second.searchParams.get("state")}`);
  assert.equal(callback.status, 200);
  const result = await retry;
  assert.deepEqual({ ...result, expires: 0 }, { type: "oauth", access: token("acct-7"), refresh: "refresh-7", expires: 0, accountId: "acct-7" });
  const form = exchanges[0]!;
  assert.equal(form.get("code"), "the-code");
  assert.equal(form.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), second.searchParams.get("code_challenge"));
});

test("browser sign-in can be cancelled and reports a busy port", async () => {
  const controller = new AbortController();
  const port = await freePort();
  const login = loginCodexBrowser({ signal: controller.signal, port, onUrl: () => controller.abort() });
  await assert.rejects(login, /cancelled/);
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  try {
    await assert.rejects(loginCodexBrowser({ signal: new AbortController().signal, port, onUrl: () => {} }), /busy/);
  } finally { await new Promise((resolve) => blocker.close(resolve)); }
});

test("device sign-in polls until approval, then exchanges the device grant", async () => {
  const calls: string[] = [];
  let polls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith("/usercode")) return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "1" });
    if (path.endsWith("/deviceauth/token")) {
      return ++polls === 1 ? new Response("{}", { status: 403 }) : Response.json({ authorization_code: "auth-code", code_verifier: "verifier" });
    }
    const form = init!.body as URLSearchParams;
    assert.equal(form.get("code_verifier"), "verifier");
    assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
    return Response.json({ access_token: token(), refresh_token: "refresh", expires_in: 600 });
  };
  let prompt: { url: string; code: string } | undefined;
  const result = await loginCodexDevice({ signal: new AbortController().signal, fetch: fetchImpl, onCode: (value) => { prompt = value; } });
  assert.deepEqual(prompt, { url: "https://auth.openai.com/codex/device", code: "ABCD-1234" });
  assert.equal(result.accountId, "acct-1");
  assert.deepEqual(calls, ["/api/accounts/deviceauth/usercode", "/api/accounts/deviceauth/token", "/api/accounts/deviceauth/token", "/oauth/token"]);
});

test("Pi import reads only the openai-codex entry and derives a missing account ID", async () => {
  await inTemp(async (dir) => {
    const path = join(dir, "pi-auth.json");
    await writeFile(path, JSON.stringify({ other: { type: "oauth", access: "x" }, "openai-codex": { type: "oauth", access: token("acct-3"), refresh: "r", expires: 5 } }));
    assert.deepEqual(await readPiCodexLogin(path), { type: "oauth", access: token("acct-3"), refresh: "r", expires: 5, accountId: "acct-3" });
    await writeFile(path, JSON.stringify({ other: {} }));
    await assert.rejects(readPiCodexLogin(path), /no ChatGPT \(openai-codex\) session/);
    await assert.rejects(readPiCodexLogin(join(dir, "missing.json")), /No readable Pi login/);
  });
});
