#!/usr/bin/env node
// Kumi's entry: `kumi` once installed (the installer's launcher runs it with Kumi's own Node), or
// `npm run kumi` from a checkout. Plain JavaScript, so an unsupported Node or a missing build gets a
// one-line instruction instead of a stack trace.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const installed = process.env.KUMI_INSTALLED === "1";
const reinstall = "Run the Kumi installer again (github.com/user1303836/kumi), which repairs it.";
const major = Number(process.versions.node.split(".")[0]);
// `doctor` runs anyway, so it can say what's wrong along with everything else.
const doctor = process.argv[2] === "doctor";
if (![22, 24].includes(major) && !doctor) {
  process.stderr.write(installed
    ? `Kumi's own Node is missing or damaged (this is ${process.version}). ${reinstall}\n`
    : `Kumi needs Node.js 22 or 24; this is ${process.version}.\nThe easiest way is the installer, which brings its own Node: see github.com/user1303836/kumi\nOr install Node 24 LTS from https://nodejs.org, then run: npm run setup\n`);
  process.exit(1);
}
const cli = new URL("../dist/src/cli.js", import.meta.url);
if (!existsSync(fileURLToPath(cli))) {
  process.stderr.write(installed ? `Kumi's files are incomplete. ${reinstall}\n` : "Kumi is not built yet. From the repository root, run: npm run setup\n");
  process.exit(1);
}
await import(cli.href);
