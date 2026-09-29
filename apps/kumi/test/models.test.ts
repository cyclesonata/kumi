import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KumiError, openCredentialStore } from "@kumi/runtime";
import { createModelControl } from "../src/models.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const GOOD = "sk-ant-fixture-good-0001";
const levels = (...names: string[]) => ({ supported: true, ...Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((name) => [name, { supported: names.includes(name) }])) });
/** Anthropic's model list, for GOOD only. */
const anthropic: typeof fetch = async (input, init) => {
  if (String(input) !== "https://api.anthropic.com/v1/models?limit=100") return new Response("", { status: 404 });
  if (new Headers(init?.headers).get("x-api-key") !== GOOD) return json({ error: { message: "invalid x-api-key" } }, 401);
  return json({ data: [
    { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", capabilities: { effort: levels("low", "medium", "high", "xhigh", "max") } },
    { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", capabilities: { effort: { supported: false } } },
  ] });
};

function fixture(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kumi-models-app-"));
  const store = openCredentialStore(join(dir, "auth.json"));
  const settingsFile = join(dir, "settings.json");
  let changes = 0;
  const control = createModelControl({ store, settingsFile, env, fetch: anthropic, changed: async () => { changes++; } });
  return { control, store, settingsFile, get changes() { return changes; }, settings: () => JSON.parse(readFileSync(settingsFile, "utf8")) as unknown, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a key is kept only when its provider accepts it, and then its models are there to choose", async () => {
  const f = fixture();
  try {
    assert.equal((await f.control.providers()).find((provider) => provider.id === "anthropic")?.signedIn, false);
    await assert.rejects(f.control.choose("anthropic/claude-sonnet-5-5"), (error: unknown) => error instanceof KumiError && error.kind === "auth" && error.provider === "anthropic");
    assert.equal(await f.control.saveKey("anthropic", "sk-ant-fixture-bad-0002"), "refused");
    assert.equal(await f.store.get("anthropic"), undefined, "a refused key isn't kept");
    assert.equal(await f.control.saveKey("anthropic", ` ${GOOD}\n`), "ok");
    assert.deepEqual(await f.store.get("anthropic"), { type: "api-key", key: GOOD });
    assert.equal((await f.control.providers()).find((provider) => provider.id === "anthropic")?.via, "saved key");
    assert.deepEqual((await f.control.models("anthropic")).map((model) => model.name), ["Claude Sonnet 5.5", "Claude Haiku 4.5"]);
  } finally { f.done(); }
});

test("choosing a model and an effort keeps them for next time; an effort the new model doesn't take goes back to its default", async () => {
  const f = fixture();
  try {
    await f.control.saveKey("anthropic", GOOD);
    assert.equal(await f.control.chooseDefault().then((model) => model?.id), "anthropic/claude-sonnet-5-5", "the first model of the first provider signed in");
    await f.control.setEffort("max");
    assert.deepEqual(f.settings(), { model: "anthropic/claude-sonnet-5-5", effort: "max" });
    assert.deepEqual({ ...f.control.current(), efforts: f.control.current().efforts.length },
      { model: "anthropic/claude-sonnet-5-5", provider: "anthropic", name: "Claude Sonnet 5.5", effort: "max", efforts: 5, pinned: false });
    const binding = await f.control.binding();
    assert.equal(binding.id, "anthropic/claude-sonnet-5-5");
    await f.control.choose("anthropic/claude-haiku-4-5");
    assert.deepEqual(f.settings(), { model: "anthropic/claude-haiku-4-5" }, "Haiku has no effort to set");
    assert.ok(f.changes >= 3, "each change reaches the session");
    // Signing out leaves the model chosen, and says what's missing when it's next used.
    assert.equal(await f.control.signOut("anthropic"), true);
    await assert.rejects(f.control.binding(), (error: unknown) => error instanceof KumiError && error.kind === "auth" && error.provider === "anthropic");
    assert.equal(await f.control.signOut("anthropic"), false);
  } finally { f.done(); }
});

test("a new OpenCode key reaches a model on either OpenCode gateway, since Zen and Go share it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-models-app-"));
  const settingsFile = join(dir, "settings.json"); writeFileSync(settingsFile, JSON.stringify({ model: "opencode-go/some-model" }));
  let changes = 0;
  const control = createModelControl({ store: openCredentialStore(join(dir, "auth.json")), settingsFile, env: {}, fetch: async () => { throw new Error("offline"); }, changed: async () => { changes++; } });
  try {
    assert.equal(await control.saveKey("opencode", "oc-fixture-key-0001"), "unreachable");
    assert.equal(changes, 1, "the Go model's connection is made again with the new key");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with KUMI_MODEL set, a model chosen in Kumi lasts until it closes; a key in the environment isn't Kumi's to remove", async () => {
  const f = fixture({ KUMI_MODEL: "anthropic/claude-sonnet-5-5", ANTHROPIC_API_KEY: GOOD });
  try {
    assert.equal(f.control.current().pinned, true);
    assert.equal((await f.control.providers()).find((provider) => provider.id === "anthropic")?.via, "environment");
    await f.control.choose("anthropic/claude-haiku-4-5");
    assert.equal(f.control.current().model, "anthropic/claude-haiku-4-5");
    assert.deepEqual(f.settings(), {}, "the saved choice is left as it was");
    assert.equal(await f.control.signOut("anthropic"), false);
  } finally { f.done(); }
  const none = fixture();
  try { await assert.rejects(none.control.binding(), /Choose a model to talk to: type \/model/); } finally { none.done(); }
});
