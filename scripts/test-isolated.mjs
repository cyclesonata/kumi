#!/usr/bin/env node
// Runs `node --test` in a home of its own: HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME and
// KUMI_HOME point into a fresh temporary folder, so no test can reach this machine's Live folders,
// Remote Scripts or ~/.kumi through a default it forgot to override (homedir(), kumiDir() and the like).
// The arguments are node --test's: the test files, or patterns it expands itself.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "kumi-test-home-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config"), KUMI_HOME: join(home, ".kumi") };
const run = spawnSync(process.execPath, ["--test", ...process.argv.slice(2)], { stdio: "inherit", env });
rmSync(home, { recursive: true, force: true });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
