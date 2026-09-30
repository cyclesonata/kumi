import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ExtensionChannel, readExtensionEndpoint } from "../src/bridge/extension-channel.js";
import { findExtensionBundle, launchExtension, parseExtensionHosts } from "../src/bridge/extension-launcher.js";
import { withExtension } from "../src/bridge/extension-setup.js";
import { kumiExtensionFolders } from "../src/bridge/live-extension-folders.js";
import { mergedStatus, routeToExtension, routedAdapter } from "../src/bridge/router.js";
import { LIVE_REGISTRY_HASH, type AsyncLiveAdapter, type LiveEvent, type LiveInvocation, type LiveStatus } from "../src/live.js";

// Kumi's Live extension as committed (apps/live-extension/dist/extension.js), run in this process
// against the extension's own fake Live, and reached the way the bridge reaches it.
const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const extensionDir = join(repository, "apps", "live-extension");

type Extension = { activate(activation: unknown): void; deactivate(): Promise<void> };
let root: string; let storage: string; let extension: Extension; let live: Record<string, unknown>;

async function waitFor<T>(check: () => T | undefined, ms = 5_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) { const value = check(); if (value) return value; if (Date.now() > until) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "bridge-extension-")); storage = join(root, "storage");
  const { fakeLive } = await import(pathToFileURL(join(extensionDir, "test", "fake-live.mjs")).href) as { fakeLive(options: Record<string, string>): { activation: unknown; model: Record<string, unknown> } };
  const fake = fakeLive({ storage, temp: join(root, "temp"), liveTemp: join(root, "live-temp") });
  live = fake.model;
  extension = createRequire(import.meta.url)(join(extensionDir, "dist", "extension.js")) as Extension;
  extension.activate(fake.activation);
  await waitFor(() => readExtensionEndpoint(storage));
});

after(async () => { await extension.deactivate(); rmSync(root, { recursive: true, force: true }); });

test("the bridge finds the extension it carries, and its endpoint only while the process lives", () => {
  // The copy staged into the bridge package when it's packed, or the repository's own.
  assert.ok([extensionDir, join(repository, "apps", "mcp-server", "live-extension")].includes(findExtensionBundle()!));
  const endpoint = readExtensionEndpoint(storage);
  assert.equal(endpoint?.pid, process.pid); assert.equal(endpoint?.registryHash, LIVE_REGISTRY_HASH);
  writeFileSync(join(root, "endpoint.json"), JSON.stringify({ ...endpoint, pid: 2 ** 22 + 12345 }));
  assert.equal(readExtensionEndpoint(root), undefined);
});

test("the channel connects with the shared secret, runs extension operations and receives pointed events", async () => {
  const channel = new ExtensionChannel({ storageDirectory: storage });
  assert.equal(await channel.connect(), true);
  const status = channel.status()!;
  assert.equal(status.adapter, "extension"); assert.ok(status.operations?.includes("render.offline"));
  const clip = await channel.invoke("arrangement.midi-clip.create", { trackRef: "3:track:0", start: 0, length: 4, notes: [{ pitch: 60, start: 0, duration: 1 }], expectedName: "Keys" }) as { ref: string; notes: number };
  assert.deepEqual([clip.ref, clip.notes], ["3:arrangement_clip:0:0", 1]);
  const rendered = await channel.invoke("render.offline", { trackRef: "3:track:2", fromBeat: 0, toBeat: 4, expectedName: "Vox" }) as { seconds: number; format: string };
  assert.deepEqual([rendered.format, rendered.seconds], ["wav", 2]);
  await assert.rejects(channel.invoke("tempo.set", {}), /doesn't offer tempo\.set/);
  await assert.rejects(channel.invoke("render.offline", { trackRef: "3:track:2" }), /required by registry/);
  const events: LiveEvent[] = []; channel.subscribe((event) => events.push(event));
  (live.commands as Map<string, (argument: unknown) => void>).get("kumi.point")!((live.handle as (object: unknown) => unknown)(live.vox));
  const pointed = await waitFor(() => events[0]);
  assert.equal(pointed.type, "pointed"); assert.deepEqual((pointed.payload as { path: number[] }).path, [2]);
  await channel.close();
});

test("a channel looks for the extension only while it's enabled (a real Live is connected)", async () => {
  let real = false; let launched = 0;
  const channel = new ExtensionChannel({ storageDirectory: storage, enabled: () => real, launch: async () => { launched += 1; } });
  assert.equal(await channel.connect(), false); assert.match(channel.reason, /no real Live/); assert.equal(launched, 0);
  real = true;
  assert.equal(await channel.connect(), true);
  await channel.close();
});

test("a channel without the secret, or with another registry, isn't connected", async () => {
  const elsewhere = join(root, "elsewhere"); rmSync(elsewhere, { recursive: true, force: true });
  const missing = new ExtensionChannel({ storageDirectory: elsewhere });
  assert.equal(await missing.connect(), false); assert.match(missing.reason, /isn't running/);
  const copy = join(root, "copy"); (await import("node:fs")).mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "endpoint.json"), readFileSync(join(storage, "endpoint.json"))); writeFileSync(join(copy, "secret"), `${"w".repeat(40)}\n`);
  const wrongSecret = new ExtensionChannel({ storageDirectory: copy });
  assert.equal(await wrongSecret.connect(), false); assert.match(wrongSecret.reason, /signed with the bridge's secret/);
  writeFileSync(join(copy, "endpoint.json"), JSON.stringify({ ...readExtensionEndpoint(storage), registryHash: "0".repeat(64) }));
  const otherRegistry = new ExtensionChannel({ storageDirectory: copy });
  assert.equal(await otherRegistry.connect(), false); assert.match(otherRegistry.reason, /another bridge version/);
});

test("launching does nothing while an extension answers, and says why when it can't start one", async () => {
  const lines: string[] = [];
  await launchExtension({ storageDirectory: storage, scan: false, log: (line) => lines.push(line) });
  assert.equal(lines.length, 0);
  const empty = join(root, "empty");
  await launchExtension({ storageDirectory: empty, scan: false, extension: join(root, "no-extension-here"), liveApp: join(root, "No Live.app"), log: (line) => lines.push(line), waitMs: 100 });
  assert.deepEqual(lines, ["extension channel: Kumi's Live extension isn't with this bridge"]);
});

const remoteStatus: LiveStatus = { connected: true, adapter: "remote-script", epoch: 7, protocol: "ableton-live/v1", capabilities: ["session.read"], registryHash: LIVE_REGISTRY_HASH, operations: ["status", "snapshot", "tempo.set", "device.duplicate"] };

test("operations only the extension has go to it; shared ones stay on the Remote Script", () => {
  const extensionStatus: LiveStatus = { connected: true, adapter: "extension", epoch: 1, protocol: "ableton-live/v1", capabilities: [], operations: ["status", "render.offline", "device.duplicate"] };
  assert.equal(routeToExtension("render.offline", remoteStatus, extensionStatus), true);
  assert.equal(routeToExtension("device.duplicate", remoteStatus, extensionStatus), false);
  assert.equal(routeToExtension("device.duplicate", { ...remoteStatus, operations: ["status"] }, extensionStatus), true);
  assert.equal(routeToExtension("render.offline", remoteStatus, undefined), false);
  const merged = mergedStatus(remoteStatus, { ...extensionStatus, extension: { version: "1.0.0" } }, "connected");
  assert.deepEqual(merged.operations, ["status", "snapshot", "tempo.set", "device.duplicate", "render.offline"]);
  assert.deepEqual(merged.channels, { extension: { connected: true, version: "1.0.0", operations: ["render.offline"] } });
  assert.deepEqual(mergedStatus({ ...remoteStatus, connected: false }, extensionStatus, "x").operations, remoteStatus.operations);
  assert.deepEqual(mergedStatus(remoteStatus, undefined, "Kumi's Live extension isn't running").channels, { extension: { connected: false, reason: "Kumi's Live extension isn't running" } });
});

test("the routed adapter keeps the Remote Script's own methods, routes invocations and closes both", async () => {
  const calls: string[] = []; const listeners: Array<(event: LiveEvent) => void> = [];
  const remoteScript = {
    status: () => remoteStatus, snapshot: () => { throw new Error("async"); }, get: () => undefined, invoke: () => undefined, reconnect: () => remoteStatus,
    subscribe: (listener: (event: LiveEvent) => void) => { listeners.push(listener); return () => undefined; },
    snapshotAsync: async () => { calls.push("snapshot"); return {} as never; }, discoverAsync: async () => ({}) as never, getAsync: async () => undefined,
    invokeAsync: async (invocation: LiveInvocation) => { calls.push(`lom:${invocation.operation}`); return { ok: true }; },
    reconnectAsync: async () => remoteStatus, close: async () => { calls.push("close:lom"); },
    retireTransactionAsync: async () => { calls.push("retire"); return { retired: 0 }; },
  } as unknown as AsyncLiveAdapter & { retireTransactionAsync(id: string): Promise<unknown> };
  const channel = new ExtensionChannel({ storageDirectory: storage });
  await channel.connect();
  let closed = 0;
  const adapter = routedAdapter(remoteScript, channel, () => { closed += 1; });
  assert.ok(adapter.status().operations?.includes("render.offline"));
  await adapter.invokeAsync({ operation: "tempo.set", args: {} });
  await adapter.retireTransactionAsync("transaction-1");
  await adapter.snapshotAsync();
  const rendered = await adapter.invokeAsync({ operation: "render.offline" as LiveInvocation["operation"], args: { trackRef: "3:track:2", fromBeat: 0, toBeat: 2, expectedName: "Vox" } }) as { seconds: number };
  assert.equal(rendered.seconds, 1);
  assert.deepEqual(calls, ["lom:tempo.set", "retire", "snapshot"]);
  const seen: LiveEvent[] = []; adapter.subscribe((event) => seen.push(event));
  listeners[0]!({ epoch: 7, sequence: 1, type: "transport", payload: {} });
  (live.commands as Map<string, (argument: unknown) => void>).get("kumi.point")!((live.handle as (object: unknown) => unknown)(live.keys));
  await waitFor(() => seen.length === 2 || undefined);
  assert.deepEqual(seen.map((event) => event.type), ["transport", "pointed"]);
  await adapter.close();
  assert.equal(closed, 1); assert.deepEqual(calls.at(-1), "close:lom"); assert.equal(channel.status(), undefined);
});

/**
 * A stand-in for Live's Extension Host: a `node` that, like the real one with Kumi's extension,
 * writes the extension's endpoint into the storage directory it's given (or, as `mute`, never does).
 */
function fakeExtensionHost(directory: string, mode: "answer" | "mute"): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "ExtensionHostNodeModule.node"), "");
  const script = join(directory, "fake-host.cjs");
  writeFileSync(script, `
const config = JSON.parse(process.argv[process.argv.indexOf("-e") + 2]);
const storage = config.extensions[0].storageDirectory;
${mode === "answer" ? 'require("node:fs").writeFileSync(require("node:path").join(storage, "endpoint.json"), JSON.stringify({ host: "127.0.0.1", port: 1, pid: process.pid, extensionVersion: "test", registryHash: "x", apiVersion: "1.0.0", startedAt: Date.now() }));' : ""}
setTimeout(() => undefined, 60000);
`);
  const node = join(directory, "node");
  writeFileSync(node, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); chmodSync(node, 0o755);
}

test("launching starts Live's Extension Host with Kumi's extension, detached, and waits for its endpoint", { skip: process.platform === "win32" ? "the stand-in host is a shell script" : false }, async () => {
  const host = join(root, "host-answer"); fakeExtensionHost(host, "answer");
  const home = join(root, "launch-answer"); const lines: string[] = [];
  await launchExtension({ storageDirectory: home, scan: false, extension: extensionDir, liveApp: host, log: (line) => lines.push(line), waitMs: 5_000 });
  const endpoint = readExtensionEndpoint(home);
  assert.ok(endpoint, lines.join("\n")); assert.match(lines[0]!, /started Live's Extension Host/);
  assert.equal(readFileSync(join(home, "secret"), "utf8").trim().length >= 32, true);
  assert.equal(existsSync(join(home, "launch.lock")), false);
  process.kill(endpoint!.pid);
});

test("an Extension Host that never reaches Live is stopped, not left waiting", { skip: process.platform === "win32" ? "the stand-in host is a shell script" : false }, async () => {
  const host = join(root, "host-mute"); fakeExtensionHost(host, "mute");
  const home = join(root, "launch-mute"); const lines: string[] = [];
  await launchExtension({ storageDirectory: home, scan: false, extension: extensionDir, liveApp: host, log: (line) => lines.push(line), waitMs: 400 });
  assert.equal(readExtensionEndpoint(home), undefined);
  assert.match(lines.at(-1)!, /didn't reach Live in time; stopping it/);
  // A second bridge arriving while one launches waits for that one instead of starting another.
  writeFileSync(join(home, "launch.lock"), "");
  const waited: string[] = []; const started = Date.now();
  await launchExtension({ storageDirectory: home, scan: false, extension: extensionDir, liveApp: host, log: (line) => waited.push(line), waitMs: 200 });
  assert.deepEqual(waited, []); assert.ok(Date.now() - started >= 150);
});

test("withExtension routes Kumi's extension in once a real Live is connected, and stops looking when closed", async () => {
  let provenance: LiveStatus["provenance"] = "fake-live";
  const remoteScript = {
    status: () => ({ ...remoteStatus, provenance }), snapshot: () => { throw new Error("async"); }, get: () => undefined, invoke: () => undefined, reconnect: () => remoteStatus,
    subscribe: () => () => undefined, snapshotAsync: async () => ({}) as never, discoverAsync: async () => ({}) as never, getAsync: async () => undefined,
    invokeAsync: async () => ({}), reconnectAsync: async () => remoteStatus, close: async () => undefined,
  } as unknown as AsyncLiveAdapter;
  const adapter = withExtension(remoteScript, { storageDirectory: storage, launch: false, retryMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(adapter.status().operations?.includes("render.offline"), false);
  provenance = "real-live";
  await waitFor(() => adapter.status().operations?.includes("render.offline") || undefined);
  await adapter.close();
});

test("a running Extension Host is recognised: another bridge's Kumi one is shared, Live's own is left alone", () => {
  const folder = "/Users/p/.config/bridge-a/live-extension"; const windowsFolder = "C:/Users/p/AppData/Roaming/bridge/live-extension";
  const tag = (path: string) => `kumi-storage:${Buffer.from(path, "utf8").toString("base64url")}`;
  const kumi = `/Applications/Ableton Live 12 Beta.app/Contents/Helpers/ExtensionHost/node -e globalThis.__kumiLaunchedHost = true; const config = JSON.parse(process.argv[1]); {"extensions":[{"path":"/k"}]} /x/ExtensionHostNodeModule.node ${tag(folder)}`;
  // Windows records a JSON argument with its quotes escaped (libuv's quoting); the tag is untouched.
  const windows = `C:\\ProgramData\\Ableton\\Live 12\\Program\\ExtensionHost\\node.exe -e "globalThis.__kumiLaunchedHost = true; …" "{\\"extensions\\":[{\\"storageDirectory\\":\\"${windowsFolder}\\"}]}" C:/x/ExtensionHostNodeModule.node ${tag(windowsFolder)}`;
  const own = "/Applications/Ableton Live 12 Beta.app/Contents/Helpers/ExtensionHost/node --some-live-arguments";
  assert.deepEqual(parseExtensionHosts([kumi, "/usr/bin/other", ""].join("\n")), { kumi: [folder], live: false });
  assert.deepEqual(parseExtensionHosts(windows), { kumi: [windowsFolder], live: false });
  assert.deepEqual(parseExtensionHosts(own), { kumi: [], live: true });
});

test("launching uses another bridge's running Kumi extension, and leaves Live's own Extension Host alone", async () => {
  const shared: string[] = []; const lines: string[] = [];
  await launchExtension({ storageDirectory: join(root, "mine"), scan: () => ({ kumi: [storage], live: false }), onShared: (folder) => shared.push(folder), log: (line) => lines.push(line) });
  assert.deepEqual(shared, [storage]); assert.equal(lines.length, 0);
  await launchExtension({ storageDirectory: join(root, "mine"), scan: () => ({ kumi: [], live: true }), log: (line) => lines.push(line) });
  assert.match(lines[0]!, /Live runs its own Extension Host; Kumi's extension runs there once installed \(kumi bridge, then restart Live\)/);
  // The channel follows a shared extension to its folder for the endpoint and the secret.
  const channel = new ExtensionChannel({ storageDirectory: join(root, "mine") });
  channel.share(storage);
  assert.equal(await channel.connect(), true);
  await channel.close();
});

test("the extension Live runs itself (installed in Live) is used first, and none is started", async () => {
  let launched = 0;
  const channel = new ExtensionChannel({ storageDirectory: join(root, "mine"), installedStorage: storage, launch: async () => { launched++; } });
  assert.equal(await channel.connect(), true);
  assert.equal(launched, 0); assert.equal(channel.status()?.adapter, "extension");
  await channel.close();
  // With nothing installed (or Live not running it), the bridge starts its own (Developer Mode).
  const fallback = new ExtensionChannel({ storageDirectory: join(root, "mine"), installedStorage: join(root, "not-installed"), launch: async () => { launched++; } });
  assert.equal(await fallback.connect(), false);
  assert.equal(launched, 1); assert.equal(fallback.reason, "Kumi's Live extension isn't running");
});

test("Live keeps Kumi's extension in its Extensions folder, and its data beside it", () => {
  assert.deepEqual(kumiExtensionFolders({}, "darwin", "/Users/p"), { code: join("/Users/p", "Library", "Application Support", "Ableton", "Extensions", "kumi.kumi"), data: join("/Users/p", "Library", "Application Support", "Ableton", "Extensions Data", "kumi.kumi") });
  assert.deepEqual(kumiExtensionFolders({ ABLETON_MCP_LIVE_EXTENSIONS_DIR: "/x/Extensions" }, "darwin", "/Users/p"), { code: join("/x/Extensions", "kumi.kumi"), data: join("/x", "Extensions Data", "kumi.kumi") });
  assert.equal(kumiExtensionFolders({}, "linux", "/home/p"), undefined);
  assert.match(kumiExtensionFolders({ APPDATA: "C:/Users/p/AppData/Roaming" }, "win32", "C:/Users/p")!.data, /AppData[\\/]Roaming[\\/]Ableton[\\/]Extensions Data[\\/]kumi\.kumi$/);
});

test("a host that can't reach Live (Developer Mode off) isn't started again until Live starts again", async () => {
  let epoch = 7; const epochs: number[] = [];
  const remoteScript = {
    status: () => ({ ...remoteStatus, epoch, provenance: "real-live" }), snapshot: () => { throw new Error("async"); }, get: () => undefined, invoke: () => undefined, reconnect: () => remoteStatus,
    subscribe: () => () => undefined, snapshotAsync: async () => ({}) as never, discoverAsync: async () => ({}) as never, getAsync: async () => undefined,
    invokeAsync: async () => ({}), reconnectAsync: async () => remoteStatus, close: async () => undefined,
  } as unknown as AsyncLiveAdapter;
  const adapter = withExtension(remoteScript, { storageDirectory: join(root, "nowhere"), installedStorage: join(root, "not-installed"), retryMs: 10, launcher: async () => { epochs.push(epoch); return "failed"; } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(epochs, [7], "one try while Live stays up");
  epoch = 8;
  await waitFor(() => epochs.length === 2 || undefined);
  assert.deepEqual(epochs, [7, 8], "Live started again: one more try, at once");
  await adapter.close();
});
