#!/usr/bin/env node
// `npm run kumi` entry: plain JavaScript so an unsupported Node or a missing build
// gets a one-line instruction instead of a stack trace.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const major = Number(process.versions.node.split(".")[0]);
if (![22, 24].includes(major)) {
  process.stderr.write(`Kumi needs Node.js 22 or 24; this is ${process.version}.\nInstall Node 24 LTS from https://nodejs.org, then run: npm run setup\n`);
  process.exit(1);
}
const cli = new URL("../dist/src/cli.js", import.meta.url);
if (!existsSync(fileURLToPath(cli))) {
  process.stderr.write("Kumi is not built yet. From the repository root, run: npm run setup\n");
  process.exit(1);
}
await import(cli.href);
