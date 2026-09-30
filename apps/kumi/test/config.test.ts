import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findBridgeConfig, liveUserLibrary, loadConfig, loadInferenceConfig, readSettings, remoteScriptsDir, safeError, writeSettings } from "../src/config.js";

// Never read the developer's own ~/.kumi settings or installed bridge.
const isolated = { KUMI_SETTINGS_FILE: "/nonexistent-kumi-test/settings.json", KUMI_REMOTE_SCRIPTS_DIR: "/nonexistent-kumi-test/Remote Scripts" };
const env = { ...isolated, KUMI_MODEL: "openai-codex/gpt-6-astra" };
const secret = "test-only-secret-do-not-log";
const defaultAuth = join(homedir(), ".kumi", "auth.json");

test("a model is <provider>/<model>, or none yet (Kumi then offers one); no Gateway key is needed", () => {
  assert.deepEqual(loadInferenceConfig({ ...isolated }), { authFile: defaultAuth });
  for (const value of ["", " \t\n", "guess", "gateway/model", "openai-codex/", "openai-codex/model\nInjected", "openai-codex/white space"]) {
    assert.throws(() => loadInferenceConfig({ ...isolated, KUMI_MODEL: value }), /KUMI_MODEL|model/);
  }
  for (const model of ["openai-codex/gpt-6-astra", "openai/gpt-6-luna", "anthropic/claude-haiku-4-5-20251001", "opencode/kimi-k2.6", "opencode-go/gpt-5.5"]) {
    assert.deepEqual(loadInferenceConfig({ ...isolated, KUMI_MODEL: model }), { model, authFile: defaultAuth });
  }
  assert.deepEqual(loadInferenceConfig({ ...env, AI_GATEWAY_API_KEY: secret }), loadInferenceConfig(env));
});

test("supports only an explicit absolute credential-file override; never echoes invalid values", () => {
  assert.equal(loadInferenceConfig({ ...env, KUMI_AUTH_FILE: "/private/owner/auth.json" }).authFile, "/private/owner/auth.json");
  for (const file of ["", "relative.json", "/tmp/unsafe\nfile", "~/auth.json"]) {
    assert.throws(() => loadInferenceConfig({ ...env, KUMI_AUTH_FILE: file }), /KUMI_AUTH_FILE/);
  }
  assert.throws(() => loadInferenceConfig({ ...isolated, KUMI_MODEL: secret }), (error: unknown) => {
    assert(error instanceof Error);
    assert(!error.message.includes(secret));
    return true;
  });
});

test("sign-in commands: login (browser, device, Pi import, a key asked for), logout and status", () => {
  const pi = join(homedir(), ".pi", "agent", "auth.json");
  assert.deepEqual(loadConfig(["login", "openai-codex"], isolated), { mode: "login", provider: "openai-codex", method: "browser", authFile: defaultAuth, piAuthFile: pi, settingsFile: isolated.KUMI_SETTINGS_FILE });
  assert.equal((loadConfig(["login", "openai-codex", "--device"], {}) as { method: string }).method, "device");
  assert.equal((loadConfig(["login", "openai-codex", "--from-pi"], {}) as { method: string }).method, "import-pi");
  for (const provider of ["anthropic", "openai", "opencode", "opencode-go"]) assert.deepEqual(loadConfig(["login", provider], isolated), { mode: "login", provider, method: "key", authFile: defaultAuth, piAuthFile: pi, settingsFile: isolated.KUMI_SETTINGS_FILE });
  assert.deepEqual(loadConfig(["logout", "openai-codex"], { KUMI_AUTH_FILE: "/x/auth.json" }), { mode: "logout", provider: "openai-codex", authFile: "/x/auth.json" });
  assert.deepEqual(loadConfig(["logout", "anthropic"], { KUMI_AUTH_FILE: "/x/auth.json" }), { mode: "logout", provider: "anthropic", authFile: "/x/auth.json" });
  assert.deepEqual(loadConfig(["auth"], isolated), { mode: "auth", authFile: defaultAuth, settingsFile: isolated.KUMI_SETTINGS_FILE });
  // A key is asked for, never read from the command line, where shell history would keep it.
  assert.throws(() => loadConfig(["login", "anthropic", secret], {}), (error: unknown) => error instanceof Error && /asks for the API key/.test(error.message) && !error.message.includes(secret));
  for (const args of [["login"], ["login", secret], ["logout", secret], ["login", "anthropic", "--device"], ["login", "openai-codex", "--token", secret], ["login", "openai-codex", "--device", "--from-pi"], ["logout", "openai-codex", "--all"], ["auth", secret]]) {
    assert.throws(() => loadConfig(args, {}), (error: unknown) => error instanceof Error && !error.message.includes(secret));
  }
});

test("without arguments, uses the bridge configuration named by the installed Remote Script", () => {
  assert.deepEqual(loadConfig([], env), { mode: "inference-only", bridgeMissing: true, ...loadInferenceConfig(env) });
  const dir = mkdtempSync(join(tmpdir(), "kumi-scripts-"));
  try {
    const bridge = join(dir, "bridge-config.json");
    writeFileSync(bridge, "{}");
    mkdirSync(join(dir, "AbletonMcpBridge"));
    const scripts = { ...env, KUMI_REMOTE_SCRIPTS_DIR: dir };
    for (const reference of ["not json", JSON.stringify({ config: "relative.json" }), JSON.stringify({ config: join(dir, "missing.json") })]) {
      writeFileSync(join(dir, "AbletonMcpBridge", "bridge-reference.json"), reference);
      assert.equal(findBridgeConfig(scripts), undefined);
    }
    writeFileSync(join(dir, "AbletonMcpBridge", "bridge-reference.json"), JSON.stringify({ config: bridge }));
    assert.deepEqual(loadConfig([], scripts), { mode: "live", bridgeConfig: bridge, ...loadInferenceConfig(env) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(loadConfig(["--inference-only"], env), { mode: "inference-only", ...loadInferenceConfig(env) });
  assert.deepEqual(loadConfig(["--help"], {}), { mode: "help" });
  assert.deepEqual(loadConfig(["--version"], {}), { mode: "version" });
  assert.deepEqual(loadConfig(["-v"], {}), { mode: "version" });
  assert.deepEqual(loadConfig(["bridge"], {}), { mode: "bridge", yes: false, allowDirty: false });
  assert.deepEqual(loadConfig(["bridge", "--yes", "--allow-dirty"], {}), { mode: "bridge", yes: true, allowDirty: true });
  assert.throws(() => loadConfig(["bridge", "--force"], {}), /Use: bridge \[--yes\] \[--allow-dirty\]/);
});

test("the chosen model persists in an owner-only settings file; KUMI_MODEL overrides it", () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-settings-"));
  try {
    const settingsFile = join(dir, "nested", "settings.json");
    const local = { ...isolated, KUMI_SETTINGS_FILE: settingsFile };
    assert.equal(loadInferenceConfig(local).model, undefined);
    assert.deepEqual(loadConfig(["model", "anthropic/claude-sonnet-5"], local), { mode: "model", settingsFile, model: "anthropic/claude-sonnet-5" });
    assert.deepEqual(loadConfig(["model"], local), { mode: "model", settingsFile });
    assert.throws(() => loadConfig(["model", `x/${secret}`], local), (error: unknown) => error instanceof Error && !error.message.includes(secret));
    writeSettings(settingsFile, { model: "anthropic/claude-sonnet-5" });
    if (process.platform !== "win32") assert.equal(statSync(settingsFile).mode & 0o777, 0o600);
    assert.deepEqual(readSettings(settingsFile), { model: "anthropic/claude-sonnet-5" });
    // How hard it thinks is kept alongside; a level Kumi doesn't know is left out.
    writeSettings(settingsFile, { model: "anthropic/claude-sonnet-5", effort: "low" });
    assert.deepEqual(readSettings(settingsFile), { model: "anthropic/claude-sonnet-5", effort: "low" });
    writeFileSync(settingsFile, JSON.stringify({ model: "anthropic/claude-sonnet-5", effort: "ludicrous" }));
    assert.deepEqual(readSettings(settingsFile), { model: "anthropic/claude-sonnet-5" });
    assert.equal(loadInferenceConfig(local).model, "anthropic/claude-sonnet-5");
    assert.equal(loadInferenceConfig({ ...local, KUMI_MODEL: "openai/gpt-6-luna" }).model, "openai/gpt-6-luna");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("accepts an absolute existing bridge configuration without parsing its secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-config-"));
  try {
    const file = join(dir, "bridge config.json");
    writeFileSync(file, "not parsed by Kumi; owned by the MCP server");
    assert.deepEqual(loadConfig(["--bridge-config", file], env), { mode: "live", bridgeConfig: file, ...loadInferenceConfig(env) });
    assert.throws(() => loadConfig(["--bridge-config", join(dir, "missing.json")], env), /configuration.*file/);
    assert.throws(() => loadConfig(["--bridge-config", dir], env), /configuration.*file/);
    assert.throws(() => loadConfig(["--bridge-config", "relative.json"], env), /absolute/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects unknown, repeated, conflicting, and incomplete flags without echoing arguments", () => {
  for (const args of [
    ["--bridge-config"], ["--bridge-config", "--help"], ["--inference-only", "--inference-only"],
    ["--help", "--inference-only"], ["--bridge-config", "/file", "--bridge-config", "/other"],
    ["--inference-only", "--bridge-config", "/file"], ["--api-key", secret],
    ["--model", env.KUMI_MODEL], ["--backend", "wasm"], ["--anything"], ["positional"],
  ]) {
    assert.throws(() => loadConfig(args, env), (error: unknown) => {
      assert(error instanceof Error);
      assert(!error.message.includes(secret));
      return true;
    });
  }
});

test("redacts known keys and credential headers before sanitizing and bounding errors", () => {
  const error = new Error(`\x1b[2Jrequest ${secret}; Authorization: Bearer unknown-token; x-api-key: hidden; token=secret\r\nnext\x07`);
  const result = safeError(error, [secret]);
  for (const privateValue of [secret, "unknown-token", "hidden", "secret", "\x1b", "\x07", "\r"]) assert(!result.includes(privateValue));
  assert(result.includes("[redacted]"));
  assert(safeError(new Error("a".repeat(10_000))).length <= 1024);
  assert.equal(safeError({ arbitrary: "do not serialize" }), "Unexpected failure");
});

test("Live's Remote Scripts folder is in the User Library Live's own preferences name, wherever it was moved", () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-live-prefs-"));
  try {
    const preferences = process.platform === "win32" ? join(dir, "Ableton", "Live 12.4.1", "Preferences") : join(dir, "Library", "Preferences", "Ableton", "Live 12.4.1");
    mkdirSync(preferences, { recursive: true });
    const moved = join(dir, "Big Drive", "Music & Samples");
    writeFileSync(join(preferences, "Library.cfg"), `<?xml version="1.0"?><Ableton><ContentLibrary><UserLibrary><LibraryProject Id="0"><ProjectLocation /><ProjectName Value="User Library" /><ProjectPath Value="${moved.replace(/&/g, "&amp;")}" /></LibraryProject></UserLibrary></ContentLibrary></Ableton>`);
    const env = process.platform === "win32" ? { APPDATA: dir } : { HOME: dir };
    assert.equal(liveUserLibrary(env), join(moved, "User Library"));
    assert.equal(remoteScriptsDir(env), join(moved, "User Library", "Remote Scripts"));
    assert.equal(remoteScriptsDir({ ...env, KUMI_REMOTE_SCRIPTS_DIR: "/chosen/Remote Scripts" }), "/chosen/Remote Scripts", "an explicit folder wins");
    assert.equal(liveUserLibrary(process.platform === "win32" ? { APPDATA: join(dir, "none") } : { HOME: join(dir, "none") }), undefined);
    // Unescaped once: a folder whose name holds the text "&quot;" keeps it.
    const literal = join(dir, "Takes &quot;live&quot;");
    writeFileSync(join(preferences, "Library.cfg"), `<?xml version="1.0"?><Ableton><ContentLibrary><UserLibrary><LibraryProject Id="0"><ProjectLocation /><ProjectName Value="User Library" /><ProjectPath Value="${literal.replace(/&/g, "&amp;")}" /></LibraryProject></UserLibrary></ContentLibrary></Ableton>`);
    assert.equal(liveUserLibrary(env), join(literal, "User Library"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
