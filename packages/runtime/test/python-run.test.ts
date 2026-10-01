import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../src/core/contracts.js";
import { BRIDGE_TOOLS } from "../src/integrations/ableton/index.js";
import { PYTHON_BRIDGE } from "../src/integrations/ableton/bridge-version.js";
import { opened, signal, tool } from "./fixtures/synthetic-bridge.js";

const success = (result: unknown): JsonObject => ({ ok: true, result, stdout: "printed\n", error: null });

test("run_python calls the bridge as a host tool, returns JSON and creates no HISTORY entry", async () => {
  const b = await opened({ fullControl: true, version: PYTHON_BRIDGE, python: () => success(123) });
  try {
    assert.ok(BRIDGE_TOOLS.includes("live_run_python"));
    assert.equal(b.tools.some((entry) => entry.name === "live_run_python"), false);
    const result = await tool(b.tools, "run_python").execute({ code: "obj.name", mode: "eval", ref: "track:1", timeoutMs: 25 }, signal());
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(JSON.parse(result.text), success(123));
    assert.deepEqual(b.requests.find((row) => row.name === "live_run_python")?.args, { code: "obj.name", mode: "eval", ref: "7:track:0", timeoutMs: 25 });
    assert.deepEqual(b.records, []);
    assert.equal(b.requests.some((row) => /python.*_(preview|apply)|live_undo_step_/.test(row.name)), false);
  } finally { await b.integration.close(); }
});

test("run_python retires old reads and names, and returned refs work with typed tools", async () => {
  const b = await opened({ fullControl: true, version: PYTHON_BRIDGE, python: () => success({ nested: [{ ref: "7:track:0", type: "Track", name: "Fixture Bass" }] }) });
  try {
    const result = await tool(b.tools, "run_python").execute({ code: "result = song.tracks[0]" }, signal());
    assert.equal(result.isError, false, result.text);
    const returned = (JSON.parse(result.text) as { result: { nested: Array<{ ref: string }> } }).result.nested[0]!.ref;
    assert.notEqual(returned, "track:1", "an old short name never comes back meaning something new");
    const stale = await tool(b.tools, "set_mixer").execute({ trackRef: "track:2", volume: 0.7 }, signal());
    assert.equal(stale.isError, true, stale.text);
    assert.equal(b.requests.some((row) => row.name === "live_mixer_preview"), false);
    assert.deepEqual(b.records, []);
    const renamed = await tool(b.tools, "rename").execute({ ref: returned, kind: "track", name: "Renamed Bass" }, signal());
    assert.equal(renamed.isError, false, renamed.text);
    assert.equal(b.requests.find((row) => row.name === "live_object_rename_preview")?.args.ref, "7:track:0");
    assert.equal(b.records.length, 1, "only the typed rename creates HISTORY");
    const again = await tool(b.tools, "run_python").execute({ code: "obj.name", mode: "eval", ref: returned }, signal());
    assert.equal(again.isError, false, again.text);
    assert.equal(b.requests.filter((row) => row.name === "live_run_python").at(-1)?.args.ref, "7:track:0");
  } finally { await b.integration.close(); }
});

test("a Python failure keeps its error data and retires reads and discovery cursors", async () => {
  const failure = { ok: false, result: null, stdout: "before failure\n", error: { type: "TimeoutError", message: "deadline", traceback: "Traceback\nTimeoutError: deadline" } };
  const b = await opened({ fullControl: true, version: PYTHON_BRIDGE, pageSize: 1, bigSet: 8, python: () => failure });
  try {
    const read = await tool(b.tools, "live_discover").execute({ kind: "track" }, signal());
    assert.equal(read.isError, false, read.text);
    const cursor = (JSON.parse(read.text) as { live: { nextCursor: string } }).live.nextCursor;
    assert.ok(cursor);
    const result = await tool(b.tools, "run_python").execute({ code: "while True: pass", timeoutMs: 10 }, signal());
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.text), failure);
    const stale = await tool(b.tools, "live_discover").execute({ kind: "track", cursor }, signal());
    assert.equal(stale.isError, true);
    assert.match(stale.text, /Cursor is stale/);
    assert.equal((await tool(b.tools, "set_mixer").execute({ trackRef: "track:1", volume: 0.7 }, signal())).isError, true);
    assert.deepEqual(b.records, []);
    assert.equal((await tool(b.tools, "live_discover").execute({ kind: "track" }, signal())).isError, false, "fresh discovery still works after a run");
  } finally { await b.integration.close(); }
});

test("run_python requires bridge 1.0.68 and an advertised bridge tool", async () => {
  const old = await opened({ fullControl: true, version: "1.0.67", python: () => success(1) });
  try { assert.equal(old.tools.some((entry) => entry.name === "run_python"), false); }
  finally { await old.integration.close(); }
  const missing = await opened({ fullControl: true, version: PYTHON_BRIDGE });
  try { assert.equal(missing.tools.some((entry) => entry.name === "run_python"), false); }
  finally { await missing.integration.close(); }
});
