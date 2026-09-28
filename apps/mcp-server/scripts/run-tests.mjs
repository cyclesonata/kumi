import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const testDirectory = resolve("dist/test");
const testFiles = readdirSync(testDirectory)
  .filter((file) => file.endsWith(".test.js") && file !== "benchmark.test.js")
  .sort()
  .map((file) => resolve(testDirectory, file));

if (testFiles.length === 0) throw new Error(`no compiled test files found in ${testDirectory}`);

// Functional tests run serially for deterministic shared-resource behavior.
// Wall-clock performance gates are deliberately excluded here and run once,
// uninstrumented, through `npm run benchmark`.
// Tests that stage audio without a folder of their own use a throwaway one, never ~/.config.
const staging = mkdtempSync(join(tmpdir(), "ableton-mcp-test-staging-"));
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], { stdio: "inherit", env: { ...process.env, ABLETON_MCP_IMPORT_STAGING_DIR: staging } });
rmSync(staging, { recursive: true, force: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
