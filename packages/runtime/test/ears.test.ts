import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodeAmxd } from "../src/devices/amxd.js";
import { EARS_ITEM, KUMI_PORTS, EARS_VERSION, earsCode, earsFile, earsPatcher, installEars } from "../src/ears/device.js";
import { decodeOsc, encodeOsc } from "../src/ears/osc.js";
import { openEarsLink, placeOf, describe, type EarsLink, type Tap } from "../src/ears/link.js";
import { frameAt, parseCapture, readCapture, runs, writeCaptureWav } from "../src/ears/capture.js";
import { openAudio } from "../src/audio/decode.js";
import { listeningTools } from "../src/audio/tools.js";
import type { HeardEvent } from "../src/core/contracts.js";
import { opened, signal, tool } from "./fixtures/synthetic-bridge.js";
import { noise, saw, wav } from "./fixtures/synthetic-audio.js";

const scratch = mkdtempSync(join(tmpdir(), "kumi-ears-test-"));

test("OSC messages go out and come back as Max's udpsend and udpreceive read them", () => {
  const packet = encodeOsc("/kumi/ears/arm", [{ float: 12 }, 47290, "a token", 0.5]);
  assert.equal(packet.length % 4, 0, "every part padded to four bytes");
  assert.deepEqual(decodeOsc(packet), { address: "/kumi/ears/arm", args: [12, 47290, "a token", 0.5] });
  assert.deepEqual(decodeOsc(encodeOsc("/kumi/ears/hello", [47324, 9, 1, 48000, "live_set tracks 3 devices 2"]))?.args, [47324, 9, 1, 48000, "live_set tracks 3 devices 2"]);
  assert.deepEqual(decodeOsc(encodeOsc("/x", [""]))?.args, [""], "an empty string survives");
  assert.equal(decodeOsc(Buffer.from("not osc")), undefined);
});

test("Kumi Ears passes the sound through, records three channels, and every patch cord joins real inlets and outlets", () => {
  const patcher = (earsPatcher() as { patcher: { boxes: { box: Record<string, unknown> }[]; lines: { patchline: { source: [string, number]; destination: [string, number] } }[]; devicewidth: number } }).patcher;
  const boxes = new Map(patcher.boxes.map(({ box }) => [box.id as string, box]));
  for (const { patchline } of patcher.lines) {
    const from = boxes.get(patchline.source[0]); const to = boxes.get(patchline.destination[0]);
    assert.ok(from && to, `${patchline.source[0]} → ${patchline.destination[0]} joins two boxes`);
    assert.ok(patchline.source[1] < (from!.numoutlets as number), `${from!.text ?? from!.maxclass} has outlet ${patchline.source[1]}`);
    assert.ok(patchline.destination[1] < (to!.numinlets as number), `${to!.text ?? to!.maxclass} has inlet ${patchline.destination[1]}`);
  }
  const cord = (source: string, outlet: number, destination: string, inlet: number) => patcher.lines.some(({ patchline }) => patchline.source[0] === source && patchline.source[1] === outlet && patchline.destination[0] === destination && patchline.destination[1] === inlet);
  assert.ok(cord("obj-plugin", 0, "obj-plugout", 0) && cord("obj-plugin", 1, "obj-plugout", 1), "the sound goes straight through");
  assert.ok(cord("obj-plugin", 0, "obj-record", 0) && cord("obj-plugin", 1, "obj-record", 1) && cord("obj-beat1", 0, "obj-record", 2), "left, right and Live's beat are recorded");
  assert.match(String(boxes.get("obj-record")!.text), /^record~ ---kumiears 4$/, "into the device's own buffer");
  assert.ok(cord("obj-sync", 6, "obj-where", 0) && cord("obj-where", 0, "obj-record", 3), "and Live's position, as a fourth channel");
  assert.equal(earsCode().includes("__"), false, "every placeholder filled");
  assert.match(earsCode(), /const VERSION = 3;/);
  // Each of Kumi's ports has a udpsend of its own: one udpsend switched between ports sends some hellos to the wrong one.
  KUMI_PORTS.forEach((kumiPort, index) => {
    assert.equal(boxes.get(`obj-send-${index}`)?.text, `udpsend 127.0.0.1 ${kumiPort}`);
    assert.ok(cord("obj-code", 5 + index, `obj-send-${index}`, 0), `Kumi's port ${kumiPort} has its own way out`);
  });
  const decoded = decodeAmxd(earsFile());
  assert.equal(decoded?.type, "audio_effect");
  assert.equal(EARS_ITEM, "user_library/Kumi/Kumi Ears");
});

test("the device goes into the User Library's Kumi folder once, and again only when it differs", async () => {
  const library = mkdtempSync(join(tmpdir(), "kumi-user-library-"));
  const first = await installEars(library);
  assert.equal(first.written, true);
  assert.equal(first.file, join(library, "Kumi", "Kumi Ears.amxd"));
  assert.equal((await installEars(library)).written, false, "the same device isn't written again");
  writeFileSync(first.file, "changed");
  assert.equal((await installEars(library)).written, true, "a different file is replaced");
  assert.deepEqual(readFileSync(first.file), earsFile());
});

/**
 * A capture as the device writes it: raw floats, left, right and Live's beat (1 + the phase while playing), and
 * with `position`, Live's position as the device polls it (`lag` frames behind; 0 while stopped).
 */
function capture(parts: { frames: number; playing?: { from: number; samplesPerBeat: number }; audio?: (frame: number) => number }[],
  options: { interleaved?: boolean; bigEndian?: boolean; unrecorded?: number; invertRight?: boolean; position?: { lag: number } } = {}) {
  const frames: number[][] = []; const beats: (number | undefined)[] = [];
  for (const part of parts) {
    for (let frame = 0; frame < part.frames; frame++) {
      const value = part.audio?.(frame) ?? 0;
      const beat = part.playing ? part.playing.from + frame / part.playing.samplesPerBeat : undefined;
      beats.push(beat);
      frames.push([value, options.invertRight ? -value : value, beat !== undefined ? 1 + (beat % 1) : 1]);
    }
  }
  if (options.position) frames.forEach((channels, frame) => channels.push(beats[Math.max(0, frame - options.position!.lag)] ?? 0));
  const channels = options.position ? 4 : 3;
  for (let frame = 0; frame < (options.unrecorded ?? 0); frame++) frames.push(new Array(channels).fill(0));
  const bytes = Buffer.alloc(frames.length * channels * 4);
  const write = (value: number, at: number) => (options.bigEndian ? bytes.writeFloatBE(value, at * 4) : bytes.writeFloatLE(value, at * 4));
  frames.forEach((values, frame) => values.forEach((value, channel) => write(value, options.interleaved === false ? channel * frames.length + frame : frame * channels + channel)));
  return bytes;
}

test("a capture is read in whichever layout Max wrote it, trimmed to what was recorded, and placed on Live's beats across a jump", async () => {
  const beat = 480;
  // Stopped a moment, played on from beat 251.3 (Live's "continue"), then jumped to beat 30 and played eight beats.
  const parts = [{ frames: 1000 }, { frames: 600, playing: { from: 251.3, samplesPerBeat: beat } }, { frames: beat * 8, playing: { from: 30, samplesPerBeat: beat }, audio: (frame: number) => (frame % 100) / 1000 }];
  for (const layout of [{ interleaved: true }, { interleaved: false }, { interleaved: true, bigEndian: true }, { interleaved: false, bigEndian: true }]) {
    const read = parseCapture(capture(parts, { ...layout, unrecorded: 5000, invertRight: true }), 3, 48000);
    assert.equal(read.left.length, 1000 + 600 + beat * 8, `${JSON.stringify(layout)}: what wasn't recorded is trimmed`);
    assert.ok(Math.abs(read.left[1600 + 150]! - 0.05) < 1e-6 && Math.abs(read.right[1600 + 150]! + 0.05) < 1e-6, `${JSON.stringify(layout)}: left and right as recorded`);
    const stretches = runs(read, { first: 251.3, afterJump: 30 });
    assert.equal(stretches.length, 2, `${JSON.stringify(layout)}: two stretches, split at the jump`);
    assert.ok(Math.abs(stretches[0]!.beat - 251.3) < 1e-3 && Math.abs(stretches[1]!.beat - 30) < 1e-3, `${JSON.stringify(layout)}: each on its beat`);
    assert.equal(Math.round(stretches[1]!.samplesPerBeat), beat);
    assert.equal(frameAt(stretches[1]!, 32), 1600 + beat * 2, "beat 32 is two beats after the jump");
    assert.equal(frameAt(stretches[1]!, 40), undefined, "past the stretch");
  }
  // An anchor that's a little off is put right by the beat's phase.
  const read = parseCapture(capture([{ frames: beat * 4, playing: { from: 16.25, samplesPerBeat: beat } }]), 3, 48000);
  assert.ok(Math.abs(runs(read, { first: 16.21 })[0]!.beat - 16.25) < 1e-3);
  // A beat's first sample (a phase of exactly 0) doesn't end a stretch.
  assert.equal(runs(parseCapture(capture([{ frames: beat * 3, playing: { from: 4, samplesPerBeat: beat } }]), 3, 48000), { first: 4 }).length, 1);
  // And the part comes out as a WAV the ear reads.
  const file = join(scratch, "part.wav");
  const whole = parseCapture(capture(parts), 3, 48000);
  await writeCaptureWav(file, whole, 1600, 1600 + beat * 2);
  const source = await openAudio(file);
  try {
    assert.equal(source.sampleRate, 48000);
    assert.equal(source.channels, 2);
    assert.equal(source.frames, beat * 2);
  } finally { await source.close(); }
  const raw = join(scratch, "capture.raw"); writeFileSync(raw, capture(parts));
  assert.equal((await readCapture(raw, 3, 48000)).left.length, 1000 + 600 + beat * 8);
});

test("Live's jump that lands on a beat (its launch quantization) is found by the position the device records, not by the phase", () => {
  // 120 BPM at 48 kHz; Live's position, polled, comes 10 ms behind.
  const beat = 24_000; const lag = 480;
  // Played on from beat 251.5 for half a beat, so Live's jump to beat 30 comes exactly as the phase comes round.
  const parts = [{ frames: 1000 }, { frames: beat / 2, playing: { from: 251.5, samplesPerBeat: beat } }, { frames: beat * 8, playing: { from: 30, samplesPerBeat: beat }, audio: (frame: number) => (frame % 100) / 1000 }];
  // Without the position, the phase runs on as if nothing happened: one stretch, on the wrong beats.
  assert.equal(runs(parseCapture(capture(parts), 3, 48000), { first: 251.5 }).length, 1);
  for (const layout of [{ interleaved: true, bigEndian: true }, { interleaved: false }]) {
    const read = parseCapture(capture(parts, { ...layout, position: { lag }, unrecorded: 2000 }), 4, 48000);
    assert.equal(read.left.length, 1000 + beat / 2 + beat * 8, `${JSON.stringify(layout)}: trimmed to what was recorded`);
    const stretches = runs(read);
    assert.equal(stretches.length, 2, `${JSON.stringify(layout)}: split at the jump`);
    assert.equal(stretches[1]!.from, 1000 + beat / 2, "exactly where the phase came round");
    assert.ok(Math.abs(stretches[0]!.beat - 251.5) < 1e-3 && Math.abs(stretches[1]!.beat - 30) < 1e-3, "each on its beat");
    assert.equal(frameAt(stretches[1]!, 32), 1000 + beat / 2 + beat * 2);
  }
  // Live landing on the part's first beat: the ramp reads 0 for its first 64 samples, and the part starts there.
  const landing = [{ frames: 1000 }, { frames: 7000, playing: { from: 14.95, samplesPerBeat: beat } }, { frames: 64 }, { frames: beat * 6, playing: { from: 64 / beat, samplesPerBeat: beat } }];
  const landed = runs(parseCapture(capture(landing, { position: { lag } }), 4, 48000)).at(-1)!;
  assert.equal(landed.from, 8064);
  assert.equal(frameAt(landed, 0), 8000, "beat 0 is where Live landed, a vector before the ramp moved");
  // A jump the phase shows (off the beat) is placed by the position too, the position's catching up going with it.
  const shown = [{ frames: 500 }, { frames: 7000, playing: { from: 12.3, samplesPerBeat: beat } }, { frames: beat * 6, playing: { from: 40.75, samplesPerBeat: beat } }];
  const placed = runs(parseCapture(capture(shown, { position: { lag } }), 4, 48000));
  assert.deepEqual(placed.map((run) => [run.from, Math.round(run.beat * 1000) / 1000]), [[500, 12.3], [500 + 7000, 40.75]]);
});

test("Kumi's socket hears devices' hellos, and arms, writes and stops them by token", async () => {
  const link = await openEarsLink({ port: 0 });
  // A device: says hello, then answers what Kumi sends, as Kumi Ears does.
  const device = createSocket("udp4");
  await new Promise<void>((resolve) => device.bind(0, "127.0.0.1", () => resolve()));
  const port = device.address().port;
  const raw = join(scratch, "device.raw");
  device.on("message", (packet) => {
    const message = decodeOsc(packet)!;
    const [, reply, token] = message.args;
    const answer = (address: string, args: (number | string)[]) => device.send(encodeOsc(address, args), Number(reply), "127.0.0.1");
    if (message.address === "/kumi/ears/arm") answer("/kumi/ears/armed", [String(token), port, 64.5, 1, 48000]);
    if (message.address === "/kumi/ears/write") { writeFileSync(String(message.args[0]), capture([{ frames: 480, playing: { from: 64.5, samplesPerBeat: 480 } }])); answer("/kumi/ears/written", [String(token), port, String(message.args[0]), 48000, 3, 64.5, 1]); }
    if (message.address === "/kumi/ears/ping") answer("/kumi/ears/pong", [String(token), port, 77, EARS_VERSION, 48000, "live_set tracks 2 devices 4", 1500, 33.25, 1]);
  });
  try {
    const found = link.waitFor((tap) => tap.path.startsWith("live_set tracks 2 devices "), 2000);
    device.send(encodeOsc("/kumi/ears/hello", [port, 77, EARS_VERSION, 48000, "live_set tracks 2 devices 4"]), link.port, "127.0.0.1");
    const tap = await found;
    assert.ok(tap, "the hello is heard");
    assert.deepEqual({ id: tap!.id, port: tap!.port, path: tap!.path }, { id: 77, port, path: "live_set tracks 2 devices 4" });
    assert.deepEqual(link.taps().map((item) => item.id), [77]);
    assert.deepEqual(await link.arm(tap!, 10), { beats: 64.5, running: true, sampleRate: 48000 });
    const written = await link.write(tap!, raw);
    assert.equal(written.file, raw); assert.equal(written.channels, 3); assert.equal(written.beats, 64.5);
    assert.equal((await readCapture(raw, 3, 48000)).left.length, 480);
    assert.equal((await link.ping(tap!))?.path, "live_set tracks 2 devices 4");
    assert.deepEqual(await link.transport(tap!), { beats: 33.25, running: true }, "where Live is, as the device hears it");
    // An old device (another version) isn't Kumi's to use.
    device.send(encodeOsc("/kumi/ears/hello", [port + 1, 78, EARS_VERSION + 1, 48000, "live_set tracks 3 devices 0"]), link.port, "127.0.0.1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(link.taps().map((item) => item.id), [77]);
    // A device that doesn't answer says so.
    await assert.rejects(link.arm({ ...tap!, port: port + 2, path: "live_set master_track devices 0" }, 1), /listening device on Main didn't answer/);
  } finally { device.close(); await link.close(); }
  assert.deepEqual(placeOf("live_set return_tracks 1 devices 3"), { kind: "return", index: 1, device: 3 });
  assert.deepEqual(placeOf("live_set master_track devices 0"), { kind: "main", index: 0, device: 0 });
  assert.equal(describe("live_set tracks 0 devices 1"), "track 1");
});

/**
 * Listening devices for the synthetic bridge: one appears (says hello) whenever the bridge loads Kumi Ears onto
 * a track, and what it writes is that track's sound after the transport's jump, on the bridge's beat.
 */
function fakeEars(bridge: () => { requests: { name: string; args: Record<string, unknown> }[]; tempo: number; position: number; transport: { playing: boolean } }, sounds: (path: string) => Float32Array, options: { silent?: boolean } = {}): { open: () => Promise<EarsLink>; armed: string[] } {
  const taps = new Map<number, Tap>();
  const armedAt = new Map<number, { requests: number; position: number; playing: boolean }>();
  const armed: string[] = [];
  let seen = 0; let next = 100;
  const notice = () => {
    if (options.silent) return;
    const loads = bridge().requests.filter((request) => request.name === "live_browser_load_preview" && request.args.itemId === EARS_ITEM);
    for (; seen < loads.length; seen++) {
      const ref = String(loads[seen]!.args.trackRef);
      const path = /main_track/.test(ref) ? "live_set master_track devices 0" : `live_set tracks ${ref.split(":").at(-1)} devices 0`;
      const tap: Tap = { id: next++, port: 1, path, version: EARS_VERSION, sampleRate: 48000, seenAt: Date.now() };
      taps.set(tap.id, tap);
    }
  };
  const link: EarsLink = {
    port: 47299,
    taps: () => { notice(); return [...taps.values()]; },
    async waitFor(match, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { notice(); const found = [...taps.values()].find(match); if (found) return found; await new Promise((resolve) => setTimeout(resolve, 10)); }
      return undefined;
    },
    async arm(tap) {
      armed.push(tap.path); armedAt.set(tap.id, { requests: bridge().requests.length, position: bridge().position, playing: bridge().transport.playing });
      return { beats: bridge().position, running: bridge().transport.playing, sampleRate: 48000 };
    },
    async write(tap, file) {
      // As Live plays it: armed while playing, from where the Set was; armed while stopped, a moment of that, then
      // from where Continue played; and with a jump, Live's quantization holds it to the next beat, then the target on.
      const at = armedAt.get(tap.id) ?? { requests: 0, position: bridge().position, playing: true };
      const jump = bridge().requests.slice(at.requests).filter((request) => request.name === "live_transport_preview" && typeof request.args.position === "number").at(-1)?.args.position as number | undefined;
      const samplesPerBeat = 48000 * 60 / bridge().tempo;
      const sound = sounds(tap.path);
      const before = 200.25;
      const parts = [...(at.playing ? [] : [{ frames: 2000 }]),
        ...(jump !== undefined ? [{ frames: Math.round(samplesPerBeat * 0.75), playing: { from: before, samplesPerBeat } }] : []),
        { frames: sound.length, playing: { from: jump ?? at.position, samplesPerBeat }, audio: (frame: number) => sound[frame]! }];
      writeFileSync(file, capture(parts, { position: { lag: 400 }, bigEndian: true }));
      return { file, sampleRate: 48000, channels: 4, beats: at.playing ? at.position : 0, running: at.playing };
    },
    stop() {},
    async ping(tap) { return tap; },
    async transport() { return { beats: bridge().position, running: bridge().transport.playing }; },
    async close() {},
  };
  return { open: async () => link, armed };
}

const reference = wav("ears-reference.wav", saw(3, 110));
const renders = { "Fixture Bass": wav("ears-bass.wav", saw(10, 110)), "Fixture Drums": wav("ears-drums.wav", noise(10)), Resampling: wav("ears-mix.wav", saw(10, 110)) } as Record<string, string>;
const byPath = (path: string) => (/tracks 1 /.test(path) ? noise(12) : saw(12, 110));

test("an audition hears each candidate through Kumi's listening devices: nothing recorded, no track added, the devices gone after", async () => {
  let b!: Awaited<ReturnType<typeof opened>>;
  const ears = fakeEars(() => b, byPath);
  b = await opened({ transport: true, version: "1.0.73", renders: (source) => renders[source], restoreFile: join(scratch, "restore.json"), ears });
  try {
    const result = await tool(b.tools, "audition").execute({ candidates: [{ track: "track:1", label: "Saw" }, { track: "track:2", label: "Noise" }], from_beat: 8, beats: 2, reference, focus: "sound" }, signal());
    assert.equal(result.isError, false, result.text);
    const reply = JSON.parse(result.text) as { best: string; takes: { label: string; score: number }[] };
    assert.equal(reply.best, "Saw");
    assert.ok(reply.takes[0]!.score >= 75, `the saw is the reference's sound (${reply.takes[0]!.score})`);
    assert.ok(reply.takes[1]!.score < 50, `noise isn't (${reply.takes[1]!.score})`);
    // A listening device on each candidate, armed together; no recording, no scratch track, no arming.
    const loads = b.requests.filter((request) => request.name === "live_browser_load_preview").map((request) => [request.args.itemId, request.args.trackRef]);
    assert.deepEqual(loads, [[EARS_ITEM, "7:track:0"], [EARS_ITEM, "7:track:1"]]);
    assert.deepEqual(ears.armed, ["live_set tracks 0 devices 0", "live_set tracks 1 devices 0"]);
    // Armed, then Live plays and jumps to the pass's count-in (a bar before the part).
    assert.deepEqual(b.requests.filter((request) => request.name === "live_transport_preview" && typeof request.args.position === "number").map((request) => request.args.position).slice(0, 1), [4]);
    assert.equal(b.requests.some((request) => request.name === "live_recording_preview" || request.name === "live_session_structure_preview" || request.name === "live_routing_preview"), false);
    // Main down and back exactly; the devices taken away again; HISTORY one quiet line.
    const mains = b.requests.filter((request) => request.name === "live_mixer_preview" && request.args.trackRef === "7:main_track:0").map((request) => request.args.volume);
    assert.deepEqual(mains, [0, 0.85]);
    assert.equal(b.main.volume, 0.85);
    assert.equal(b.requests.filter((request) => request.name === "live_undo").length >= 2, true, "both devices' loads undone");
    assert.deepEqual(b.records.map((record) => [record.state, record.title]), [["heard", "Auditioned 2 candidates · best Saw"]]);
    assert.deepEqual(b.trackNames(), ["Fixture Bass", "Fixture Drums"]);
  } finally { await b.integration.close(); }
});

test("when the listening device can't start (no Max for Live), the audition records instead", { timeout: 30_000 }, async () => {
  let b!: Awaited<ReturnType<typeof opened>>;
  const ears = fakeEars(() => b, byPath, { silent: true });
  b = await opened({ transport: true, version: "1.0.73", renders: (source) => renders[source], restoreFile: join(scratch, "restore-2.json"), ears });
  try {
    const result = await tool(b.tools, "audition").execute({ candidates: [{ track: "track:1", label: "Saw" }], from_beat: 8, beats: 2, reference, focus: "sound" }, signal());
    assert.equal(result.isError, false, result.text);
    assert.ok(b.requests.some((request) => request.name === "live_recording_preview"), "recorded instead");
    assert.ok((JSON.parse(result.text) as { takes: { score: number }[] }).takes[0]!.score >= 75);
    assert.deepEqual(b.trackNames(), ["Fixture Bass", "Fixture Drums"]);
    assert.equal(b.main.volume, 0.85);
  } finally { await b.integration.close(); }
});

test("with a bridge older than the listening device needs, Kumi records to listen, as before", { timeout: 30_000 }, async () => {
  let b!: Awaited<ReturnType<typeof opened>>;
  const ears = fakeEars(() => b, byPath);
  b = await opened({ transport: true, version: "1.0.72", renders: (source) => renders[source], restoreFile: join(scratch, "restore-old.json"), ears });
  try {
    const result = await tool(b.tools, "audition").execute({ candidates: [{ track: "track:1", label: "Saw" }], from_beat: 8, beats: 2, reference, focus: "sound" }, signal());
    assert.equal(result.isError, false, result.text);
    assert.equal(b.requests.some((request) => request.name === "live_browser_load_preview"), false, "no listening device");
    assert.ok(b.requests.some((request) => request.name === "live_recording_preview"), "recorded instead");
  } finally { await b.integration.close(); }
});

test("listen hears a track in the Set by name: quietly over the loop while Live is stopped, and several tracks with what clashes while it plays", { timeout: 30_000 }, async () => {
  let b!: Awaited<ReturnType<typeof opened>>;
  const ears = fakeEars(() => b, (path) => (/tracks 1 /.test(path) ? saw(12, 112) : saw(12, 110)));
  b = await opened({ transport: true, version: "1.0.73", renders: (source) => renders[source], restoreFile: join(scratch, "restore-3.json"), ears });
  const heard: HeardEvent[] = [];
  const [listen] = listeningTools({ onEvent: (event) => heard.push(event), hear: (request, given) => b.integration.hear!(request, given) });
  try {
    const quietly = await listen!.execute({ track: "Fixture Bass", from_beat: 8, beats: 4 }, signal());
    assert.equal(quietly.isError, undefined, quietly.text);
    const analysis = JSON.parse(quietly.text) as { loudness: { integratedLufs: number }; sound?: { pitch?: { note: string } } };
    assert.ok(analysis.loudness.integratedLufs > -40, "it heard the bass");
    assert.equal(heard.length, 1);
    assert.deepEqual(b.requests.filter((request) => request.name === "live_mixer_preview").map((request) => request.args.volume), [0, 0.85], "quietly: Main down, then back");
    // While the Set plays: both tracks heard as they play, together, and the clash between them named.
    b.startPlayback(16);
    const before = b.requests.length;
    const together = await listen!.execute({ tracks: ["Fixture Bass", "Fixture Drums"], seconds: 2 }, signal());
    assert.equal(together.isError, undefined, together.text);
    const reply = JSON.parse(together.text) as { tracks: { track: string; heard: string }[]; clashes: string[] };
    assert.deepEqual(reply.tracks.map((track) => [track.track, track.heard]), [["Fixture Bass", "as it played"], ["Fixture Drums", "as it played"]]);
    assert.match(reply.clashes[0] ?? "", /^Fixture Bass and Fixture Drums both sit in the /);
    const during = b.requests.slice(before);
    assert.equal(during.some((request) => request.name === "live_mixer_preview" || request.name === "live_transport_action_preview" || request.name === "live_transport_preview"), false, "Main and the transport left alone while it plays");
    assert.equal(during.filter((request) => request.name === "live_browser_load_preview").length, 2);
    assert.ok(during.filter((request) => request.name === "live_undo").length >= 2, "the devices go again");
    assert.equal((await listen!.execute({}, signal())).isError, true, "something to hear is named");
  } finally { await b.integration.close(); }
});
