import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../../scripts/probe-inference.mjs", import.meta.url));
const baseEnv = { ...process.env, KUMI_MODEL: "", KUMI_AUTH_FILE: "/nonexistent-kumi-test/auth.json" };
function run(env: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], { env, cwd: tmpdir(), encoding: "utf8", timeout: 15_000 });
}

test("probe reports the Kumi kernel and provider SDK versions but does not infer a model, including from another cwd", () => {
  const result = run(baseEnv);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /KUMI_MODEL/);
  assert.match(result.stdout, /"kernel":"kumi"/);
  assert.match(result.stdout, /"@ai-sdk\/openai":"\d+\.\d+\.\d+"/);
  assert.doesNotMatch(result.stdout, /"gateA":"passed"/);
});

test("missing sign-in fails truthfully without reading another store or requiring a Gateway key", () => {
  const dir = mkdtempSync(join(tmpdir(), "kumi-probe-test-"));
  try {
    const result = run({ ...baseEnv, KUMI_MODEL: "openai-codex/gpt-6-astra", KUMI_AUTH_FILE: join(dir, "absent.json"), AI_GATEWAY_API_KEY: "not-a-real-secret" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /login openai-codex/);
    assert(!`${result.stdout}${result.stderr}`.includes("not-a-real-secret"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("probe rejects all arguments without echoing argument values", () => {
  const result = run(baseEnv, ["--api-key", "not-a-real-secret"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /takes no arguments/);
  assert(!`${result.stdout}${result.stderr}`.includes("not-a-real-secret"));
});
