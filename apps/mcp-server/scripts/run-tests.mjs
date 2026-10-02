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
//
// TEST_SHARD=2/4 runs the second of four shards, so a slow runner (Windows) splits the files across jobs.
// Shards are balanced by what each file costs there (measured on Windows; most take seconds), and the
// lifecycle file, minutes on its own, is split in two by its tests' names.
const shard = process.env.TEST_SHARD?.trim();
if (shard && !/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error(`TEST_SHARD must look like 1/3, not ${shard}`);
const WEIGHTS = { "lifecycle.test.js": 360, "delivery.test.js": 20, "project-semantic-diff.test.js": 12, "host.test.js": 10 };
const LIFECYCLE_HALF = "^(upgrades|uninstall|serializes|rejects) ";
/** A run: test files, and for the lifecycle file's halves, the names it takes or skips. */
const units = testFiles.flatMap((file) => {
  const name = file.split(/[\\/]/).at(-1);
  if (name === "lifecycle.test.js" && shard) return [{ files: [file], weight: 190, args: [`--test-name-pattern=${LIFECYCLE_HALF}`] }, { files: [file], weight: 170, args: [`--test-skip-pattern=${LIFECYCLE_HALF}`] }];
  return [{ files: [file], weight: WEIGHTS[name] ?? 3, args: [] }];
});
let runs = [{ files: testFiles, args: [] }];
if (shard) {
  const [index, total] = shard.split("/").map(Number);
  if (index > total) throw new Error(`TEST_SHARD ${shard} names a shard past the last`);
  // Heaviest first, each to the lightest shard so far.
  const loads = Array.from({ length: total }, () => ({ weight: 0, units: [] }));
  for (const unit of [...units].sort((a, b) => b.weight - a.weight || a.files[0].localeCompare(b.files[0]))) {
    const lightest = loads.reduce((best, load) => (load.weight < best.weight ? load : best));
    lightest.units.push(unit); lightest.weight += unit.weight;
  }
  const mine = loads[index - 1].units;
  // Plain files share one run; a file's half runs on its own (name patterns apply to the whole run).
  runs = [{ files: mine.filter((unit) => !unit.args.length).flatMap((unit) => unit.files), args: [] }, ...mine.filter((unit) => unit.args.length).map((unit) => ({ files: unit.files, args: unit.args }))]
    .filter((run) => run.files.length);
}
const staging = mkdtempSync(join(tmpdir(), "ableton-mcp-test-staging-"));
let status = 0;
for (const run of runs) {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...run.args, ...run.files], { stdio: "inherit", env: { ...process.env, ABLETON_MCP_IMPORT_STAGING_DIR: staging } });
  if (result.error) { rmSync(staging, { recursive: true, force: true }); throw result.error; }
  if (result.status !== 0) status = result.status ?? 1;
}
rmSync(staging, { recursive: true, force: true });
process.exitCode = status;
