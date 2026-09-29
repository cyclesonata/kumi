#!/usr/bin/env node
// Regenerate bridge-tools.json for the eval: the bridge's own descriptions and input schemas of every
// tool Kumi may call, from the built bridge's catalog. Run after the bridge's tools change:
// npm run build --prefix apps/mcp-server && node apps/kumi/scripts/make-bridge-tools.mjs
import { writeFileSync } from "node:fs";
import { BRIDGE_TOOLS } from "@kumi/runtime";

const { TOOL_CATALOG } = await import(new URL("../../mcp-server/dist/src/tool-catalog.js", import.meta.url).href);
const tools = TOOL_CATALOG.filter((entry) => BRIDGE_TOOLS.includes(entry.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const missing = BRIDGE_TOOLS.filter((name) => !tools.some((tool) => tool.name === name));
writeFileSync(new URL("./bridge-tools.json", import.meta.url), `${JSON.stringify(tools, null, 1)}\n`);
process.stdout.write(`${tools.length} tools written${missing.length ? `; not in the bridge's catalog: ${missing.join(", ")}` : ""}\n`);
