import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

test("the launcher explains an unbuilt checkout instead of failing with a stack trace", async () => {
  const launcher = fileURLToPath(new URL("../../bin/kumi.mjs", import.meta.url));
  const copy = await mkdtemp(join(tmpdir(), "kumi-launcher-"));
  try {
    await mkdir(join(copy, "bin"));
    await writeFile(join(copy, "bin", "kumi.mjs"), await readFile(launcher));
    await assert.rejects(exec(process.execPath, [join(copy, "bin", "kumi.mjs")], { timeout: 15_000 }), (error: unknown) =>
      /npm run setup/.test((error as { stderr: string }).stderr) && !/at /.test((error as { stderr: string }).stderr));
  } finally { await rm(copy, { recursive: true, force: true }); }
});

test("root npm start forwards CLI arguments from a different cwd; help requires no credential/model", async () => {
  // npm is npm.cmd on Windows, which only starts through a shell.
  const { stdout, stderr } = await exec("npm", ["--prefix", root, "run", "kumi", "--", "--help"], {
    cwd: tmpdir(), env: { ...process.env, KUMI_MODEL: "", KUMI_AUTH_FILE: "" }, timeout: 15_000, shell: process.platform === "win32",
  });
  assert.match(stdout, /--bridge-config/); assert.match(stdout, /--inference-only/); assert.match(stdout, /producer assistant for Ableton Live/);
  assert.match(stdout, /npm run setup/); assert.match(stdout, /login <provider>/); assert.match(stdout, /\/login/); assert.match(stdout, /Node\.js 22 or 24/);
  assert.equal(stderr, "");
});

test("--version says Kumi's release, which is the packages' version", async () => {
  const { KUMI_VERSION } = await import("@kumi/runtime");
  const { stdout } = await exec(process.execPath, [cli, "--version"], { env: { ...process.env, KUMI_MODEL: "" }, timeout: 15_000 });
  assert.equal(stdout, `Kumi ${KUMI_VERSION}\n`);
  for (const file of ["package.json", "apps/kumi/package.json", "packages/runtime/package.json"]) {
    assert.equal((JSON.parse(await readFile(join(root, file), "utf8")) as { version: string }).version, KUMI_VERSION, file);
  }
  const app = JSON.parse(await readFile(join(root, "apps/kumi/package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(app.dependencies["@kumi/runtime"], KUMI_VERSION, "the app asks for the runtime beside it, or npm ci looks for it on the registry");
  assert.match(KUMI_VERSION, /^1\.\d+\.\d+$/);
});

test("CLI rejects invalid configuration without echoing model/credential-like values", async () => {
  await assert.rejects(exec(process.execPath, [cli, "--inference-only"], {
    env: { ...process.env, KUMI_MODEL: "private-token", AI_GATEWAY_API_KEY: "private-token" }, timeout: 15_000,
  }), (error: unknown) => {
    const failure = error as Error & { code: number; stderr: string };
    assert.equal(failure.code, 1); assert.match(failure.stderr, /KUMI_MODEL/); assert(!failure.stderr.includes("private-token")); return true;
  });
});

test("without a sign-in Kumi still starts, and an answer says where to sign in, before any model request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kumi-cli-test-"));
  try {
    for (const [model, pattern] of [["openai-codex/gpt-6-astra", /Not signed in to ChatGPT \(openai-codex\)/], ["anthropic/claude-sonnet-5", /Not signed in to Anthropic: add its API key with \/login \(or set ANTHROPIC_API_KEY\)/]] as const) {
      const child = execFile(process.execPath, [cli, "--inference-only"], {
        env: { ...process.env, KUMI_MODEL: model, KUMI_AUTH_FILE: join(dir, "absent.json"), ANTHROPIC_API_KEY: "", KUMI_SETTINGS_FILE: join(dir, "settings.json") }, timeout: 15_000,
      });
      let stdout = "";
      child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.stdin!.write("How do I tame a snare?\n");
      // The answer fails at once (nothing to send it with), then Kumi closes at the end of input.
      for (let waited = 0; !pattern.test(stdout) && waited < 10_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      child.stdin!.end();
      assert.equal(await exited, 0);
      assert.match(stdout, pattern);
      assert.match(stdout, new RegExp(`Kumi · ${model.replace("/", "\\/")}`));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("login --from-pi imports only the ChatGPT session into an owner-only store; auth and logout never print secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "kumi-cli-home-"));
  const access = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-cli" } });
  // Windows finds the home folder through USERPROFILE.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, KUMI_AUTH_FILE: join(home, ".kumi", "auth.json"), KUMI_SETTINGS_FILE: join(home, ".kumi", "settings.json"), OPENAI_API_KEY: "sk-private-env", ANTHROPIC_API_KEY: "" };
  delete env.KUMI_MODEL;
  try {
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "refresh-private", expires: Date.now() + 7_200_000 } }), { mode: 0o600 });
    const imported = await exec(process.execPath, [cli, "login", "openai-codex", "--from-pi"], { env, timeout: 15_000 });
    assert.match(imported.stdout, /Signed in to ChatGPT/);
    // No model is written into Kumi: it starts with ChatGPT's own first choice.
    assert.match(imported.stdout, /Next: npm run kumi\. It starts with ChatGPT's first model; \/model changes it\./);
    const authFile = join(home, ".kumi", "auth.json");
    if (process.platform !== "win32") assert.equal((await stat(authFile)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(authFile, "utf8")).credentials["openai-codex"].accountId, "acct-cli");
    const status = await exec(process.execPath, [cli, "auth"], { env, timeout: 15_000 });
    assert.match(status.stdout, /openai-codex\s+signed in/);
    assert.match(status.stdout, /openai\s+API key from OPENAI_API_KEY/);
    assert.match(status.stdout, /anthropic\s+not signed in \(npm run kumi -- login anthropic\)/);
    assert.match(status.stdout, /Model: not chosen yet/);
    assert.match((await exec(process.execPath, [cli, "model", "anthropic/claude-sonnet-5"], { env, timeout: 15_000 })).stdout, /Model set to anthropic\/claude-sonnet-5/);
    assert.match((await exec(process.execPath, [cli, "model"], { env, timeout: 15_000 })).stdout, /Model: anthropic\/claude-sonnet-5/);
    const removed = await exec(process.execPath, [cli, "logout", "openai-codex"], { env, timeout: 15_000 });
    assert.match(removed.stdout, /Removed/);
    assert.match((await exec(process.execPath, [cli, "auth"], { env, timeout: 15_000 })).stdout, /openai-codex\s+not signed in/);
    for (const output of [imported.stdout, imported.stderr, status.stdout, removed.stdout]) {
      for (const secret of [access, "refresh-private", "sk-private-env"]) assert(!output.includes(secret));
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
