/**
 * Kumi Ears: the small Max for Live audio effect Kumi puts at the end of a track's chain (or Main's)
 * when it needs to hear it. The sound passes through untouched. On Kumi's word it records what the
 * track plays into a buffer, with two more channels saying where Live was: the beat's phase, sample for
 * sample (plugphasor~), and Live's position in beats, polled every few milliseconds (plugsync~). Together
 * they place every sample on the Arrangement's beats, wherever Live jumped. It writes that to a file Kumi reads. Kumi and the device talk
 * over OSC on this computer's loopback: the device says hello to Kumi's ports every two seconds, with
 * the port it listens on and where it sits in the Set; Kumi sends arm, write, stop and ping.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { devicePatcher, encodeAmxd, type Box, type Line } from "../devices/amxd.js";

/** Bumped whenever the device changes: Kumi rewrites its file, and only talks to a device of this version. */
export const EARS_VERSION = 3;
export const EARS_NAME = "Kumi Ears";
/** Live's Browser lists the device by this path, as it lists the devices Kumi makes. */
export const EARS_ITEM = `user_library/Kumi/${EARS_NAME}`;
/** Where Kumi listens for the devices' hellos: the first of these that's free (several Kumis can run). */
export const KUMI_PORTS = [47290, 47291, 47292, 47293, 47294] as const;
/** Each device listens on one of these, picked from its own id in Live. */
export const DEVICE_PORT_BASE = 47300;
export const DEVICE_PORTS = 600;
/** Left, right, the beat's phase and Live's position. */
export const EARS_CHANNELS = 4;

/** The device's own code (Max's v8), with __VERSION__, __PORTS__, __BASE__ and __SPAN__ filled in. */
const CODE = String.raw`// Kumi Ears (made by Kumi). Kumi listens here; the sound passes through untouched.
inlets = 1;
outlets = 10;
// 0: record~ (1 starts, 0 stops) · 1: buffer~ · 2: udpsend for any other port · 3: udpreceive (its port) · 4: the face's status line
// 5–9: a udpsend for each of Kumi's ports (one udpsend told a new port per message sends some to the wrong one)
const VERSION = __VERSION__;
const KUMI_PORTS = __PORTS__;
let sampleRate = 44100;
let port = 0;
let id = 0;
let beats = 0;
let running = 0;
let ready = false;
let armed = { beats: 0, running: 0 };
let loadedAt = Date.now();
const greeter = new Task(greet);
function loaded() {
  loadedAt = Date.now();
  try { id = Number(new LiveAPI("this_device").id) || 0; } catch (error) { id = 0; }
  if (!id) id = 1 + Math.floor(Math.random() * 100000);
  port = __BASE__ + (id % __SPAN__);
  outlet(3, "port", port);
  ready = true;
  status("Kumi Ears");
  greet();
  greeter.interval = 2000;
  greeter.repeat();
}
function samplerate(rate) { if (rate > 0) sampleRate = rate; }
function playing(value) { running = value ? 1 : 0; }
function position(value) { beats = value; }
function where() {
  try { const device = new LiveAPI("this_device"); return String(device.unquotedpath || device.path || "").replace(/"/g, ""); } catch (error) { return ""; }
}
function say(to, address, args) {
  const fixed = KUMI_PORTS.indexOf(to);
  if (fixed >= 0) { outlet(5 + fixed, address, ...args); return; }
  outlet(2, "port", to); outlet(2, address, ...args);
}
function greet() {
  if (!ready) return;
  const path = where();
  // How long ago it loaded, too: Live can give a new device a removed one's id, and Kumi wants the one it just put there.
  for (const to of KUMI_PORTS) say(to, "/kumi/ears/hello", [port, id, VERSION, sampleRate, path, Date.now() - loadedAt]);
}
function status(text) { outlet(4, "set", text); }
function anything(...args) {
  const reply = Number(args[1]) || 0;
  const token = String(args[2] || "");
  switch (messagename) {
    // Every command is (what, the port to answer on, a token the answer carries back).
    case "/kumi/ears/ping":
      // Where Live is now, too (its position in beats, and whether it plays).
      say(reply, "/kumi/ears/pong", [token, port, id, VERSION, sampleRate, where(), Date.now() - loadedAt, beats, running]);
      return;
    case "/kumi/ears/arm": {
      // Seconds to hold, then where to answer: the buffer is cleared, so what wasn't recorded reads as zeros.
      const seconds = Math.max(0.1, Math.min(900, Number(args[0]) || 10));
      outlet(0, 0);
      outlet(1, "sizeinsamps", Math.ceil(seconds * sampleRate));
      outlet(1, "clear");
      armed = { beats: beats, running: running };
      outlet(0, 1);
      status("Kumi is listening");
      say(reply, "/kumi/ears/armed", [token, port, beats, running, sampleRate]);
      return;
    }
    case "/kumi/ears/stop":
      outlet(0, 0);
      status("Kumi Ears");
      say(reply, "/kumi/ears/stopped", [token, port]);
      return;
    case "/kumi/ears/write": {
      // The whole buffer as raw 32-bit floats; Kumi trims what wasn't recorded.
      const file = String(args[0] || "");
      outlet(0, 0);
      if (file) outlet(1, "writeraw", file, "float32");
      status("Kumi Ears");
      say(reply, "/kumi/ears/written", [token, port, file, sampleRate, __CHANNELS__, armed.beats, armed.running]);
      return;
    }
  }
}
`;

/** The device's code, as its v8.codebox holds it. */
export function earsCode(): string {
  return CODE.replace("__VERSION__", String(EARS_VERSION)).replace("__PORTS__", JSON.stringify(KUMI_PORTS)).replace("__BASE__", String(DEVICE_PORT_BASE))
    .replace("__SPAN__", String(DEVICE_PORTS)).replace("__CHANNELS__", String(EARS_CHANNELS));
}

/** Kumi's mint, for the device's name on its face. */
const MINT = [0.525, 0.890, 0.710, 1.0];

/** The device's patcher. */
export function earsPatcher(): object {
  const boxes: Box[] = []; const lines: Line[] = [];
  const obj = (id: string, text: string, ins: number, outs: number, rect: number[], outlettype: string[] = Array.from({ length: outs }, () => ""), extra: Record<string, unknown> = {}) =>
    boxes.push({ box: { id, maxclass: "newobj", text, numinlets: ins, numoutlets: outs, outlettype, patching_rect: rect, ...extra } });
  const wire = (source: string, outlet: number, destination: string, inlet = 0) => lines.push({ patchline: { source: [source, outlet], destination: [destination, inlet] } });
  // The sound, straight through.
  obj("obj-plugin", "plugin~ 1 2", 1, 2, [40.0, 30.0, 80.0, 22.0], ["signal", "signal"]);
  obj("obj-plugout", "plugout~ 1 2", 2, 0, [40.0, 330.0, 80.0, 22.0], []);
  wire("obj-plugin", 0, "obj-plugout", 0); wire("obj-plugin", 1, "obj-plugout", 1);
  // Live's beat, sample for sample: a ramp 0–1 each beat while the transport runs, 0 while it's stopped.
  // One is added so every recorded sample reads 1 or more, and one never recorded reads 0.
  obj("obj-beat", "plugphasor~", 1, 2, [200.0, 30.0, 80.0, 22.0], ["signal", "list"]);
  obj("obj-beat1", "+~ 1.", 2, 1, [200.0, 70.0, 50.0, 22.0], ["signal"]);
  wire("obj-beat", 0, "obj-beat1", 0);
  // Four channels into one buffer the device alone names (--- makes the name its own).
  obj("obj-record", `record~ ---kumiears ${EARS_CHANNELS}`, EARS_CHANNELS + 2, 1, [40.0, 160.0, 160.0, 22.0], ["signal"]);
  obj("obj-buffer", `buffer~ ---kumiears 1000 ${EARS_CHANNELS}`, 1, 2, [40.0, 230.0, 180.0, 22.0], ["float", "bang"]);
  wire("obj-plugin", 0, "obj-record", 0); wire("obj-plugin", 1, "obj-record", 1); wire("obj-beat1", 0, "obj-record", 2);
  // Where the Set is, polled: the beat count and whether it plays.
  obj("obj-poll", "metro 10", 2, 1, [360.0, 60.0, 60.0, 22.0], ["bang"]);
  obj("obj-pollon", "loadmess 1", 1, 1, [360.0, 30.0, 70.0, 22.0]);
  obj("obj-sync", "plugsync~", 1, 9, [360.0, 100.0, 120.0, 22.0], ["int", "int", "int", "float", "list", "float", "float", "int", "int"]);
  obj("obj-playing", "change", 1, 3, [360.0, 140.0, 50.0, 22.0], ["", "int", "int"]);
  obj("obj-playingmsg", "prepend playing", 1, 1, [360.0, 170.0, 100.0, 22.0]);
  obj("obj-positionmsg", "prepend position", 1, 1, [480.0, 170.0, 100.0, 22.0]);
  wire("obj-pollon", 0, "obj-poll", 0); wire("obj-poll", 0, "obj-sync", 0);
  wire("obj-sync", 0, "obj-playing", 0); wire("obj-playing", 0, "obj-playingmsg", 0);
  wire("obj-sync", 6, "obj-positionmsg", 0);
  // And recorded: Live's own jumps wait for its launch quantization and land on a beat, where the phase alone
  // can't show them; the position says where every stretch was.
  obj("obj-where", "sig~", 1, 1, [480.0, 200.0, 40.0, 22.0], ["signal"]);
  wire("obj-sync", 6, "obj-where", 0); wire("obj-where", 0, "obj-record", 3);
  obj("obj-dsp", "dspstate~", 1, 4, [600.0, 30.0, 70.0, 22.0], ["int", "float", "int", "int"]);
  obj("obj-ratemsg", "prepend samplerate", 1, 1, [600.0, 70.0, 120.0, 22.0]);
  wire("obj-dsp", 1, "obj-ratemsg", 0);
  // The device's own id in Live is known once Live has loaded it. The sample rate is asked for first
  // (dspstate~ says it only when asked or when audio restarts), then the code starts.
  obj("obj-loaded", "live.thisdevice", 1, 3, [760.0, 30.0, 90.0, 22.0], ["bang", "int", "int"]);
  obj("obj-order", "t b b", 1, 2, [760.0, 60.0, 40.0, 22.0], ["bang", "bang"]);
  boxes.push({ box: { id: "obj-loadedmsg", maxclass: "message", text: "loaded", numinlets: 2, numoutlets: 1, outlettype: [""], patching_rect: [760.0, 90.0, 50.0, 22.0] } });
  wire("obj-loaded", 0, "obj-order", 0); wire("obj-order", 1, "obj-dsp", 0); wire("obj-order", 0, "obj-loadedmsg", 0);
  // Talking to Kumi.
  obj("obj-receive", `udpreceive ${DEVICE_PORT_BASE}`, 1, 1, [40.0, 400.0, 140.0, 22.0]);
  obj("obj-send", `udpsend 127.0.0.1 ${KUMI_PORTS[0]}`, 1, 0, [400.0, 520.0, 160.0, 22.0], []);
  // One for each of Kumi's ports, so a hello to all of them reaches each.
  KUMI_PORTS.forEach((kumiPort, index) => obj(`obj-send-${index}`, `udpsend 127.0.0.1 ${kumiPort}`, 1, 0, [40.0 + index * 150.0, 560.0, 140.0, 22.0], []));
  boxes.push({ box: { id: "obj-code", maxclass: "v8.codebox", filename: "none", code: earsCode(), fontface: 0, fontname: "Menlo", fontsize: 11.0,
    numinlets: 1, numoutlets: 10, outlettype: Array.from({ length: 10 }, () => ""), patching_rect: [40.0, 450.0, 560.0, 50.0] } });
  for (const source of ["obj-receive", "obj-playingmsg", "obj-positionmsg", "obj-ratemsg", "obj-loadedmsg"]) wire(source, 0, "obj-code", 0);
  wire("obj-code", 0, "obj-record", 0); wire("obj-code", 1, "obj-buffer", 0); wire("obj-code", 2, "obj-send", 0); wire("obj-code", 3, "obj-receive", 0);
  KUMI_PORTS.forEach((_, index) => wire("obj-code", 5 + index, `obj-send-${index}`, 0));
  // Its face: the name, what it's doing, and a meter so a glance says sound passes.
  boxes.push({ box: { id: "obj-name", maxclass: "comment", text: EARS_NAME, numinlets: 1, numoutlets: 0, presentation: 1, presentation_rect: [6.0, 4.0, 100.0, 18.0],
    patching_rect: [700.0, 300.0, 100.0, 18.0], fontname: "Arial Bold", fontsize: 11.0, textcolor: MINT } });
  boxes.push({ box: { id: "obj-status", maxclass: "comment", text: "Kumi listens here", numinlets: 1, numoutlets: 0, presentation: 1, presentation_rect: [6.0, 24.0, 104.0, 30.0],
    patching_rect: [700.0, 330.0, 104.0, 30.0], fontname: "Arial", fontsize: 9.0, linecount: 2 } });
  obj("obj-statusmsg", "prepend set", 1, 1, [640.0, 520.0, 80.0, 22.0]);
  wire("obj-code", 4, "obj-statusmsg", 0); wire("obj-statusmsg", 0, "obj-status", 0);
  for (const [index, channel] of [0, 1].entries()) {
    boxes.push({ box: { id: `obj-meter-${channel}`, maxclass: "live.meter~", numinlets: 1, numoutlets: 2, outlettype: ["float", "int"], presentation: 1,
      presentation_rect: [8.0 + index * 10.0, 62.0, 6.0, 96.0], patching_rect: [860.0 + index * 20.0, 300.0, 6.0, 96.0] } });
    wire("obj-plugin", channel, `obj-meter-${channel}`, 0);
  }
  return devicePatcher("audio_effect", { title: EARS_NAME, width: 112,
    description: "Kumi listens here when it needs to hear this track. The sound passes through untouched, and Kumi takes the device away when it's done.", boxes, lines });
}

/** The device's file, as Kumi writes it. */
export function earsFile(): Buffer { return encodeAmxd("audio_effect", earsPatcher()); }

/**
 * The device in the User Library's Kumi folder, written when it's missing or isn't this version's
 * (compared by content, so a file the producer left alone isn't touched); whether it was written.
 */
export async function installEars(userLibrary: string): Promise<{ file: string; written: boolean }> {
  const folder = join(userLibrary, "Kumi");
  const file = join(folder, `${EARS_NAME}.amxd`);
  const bytes = earsFile();
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  if (existsSync(file)) {
    try { if (digest(readFileSync(file)) === digest(bytes)) return { file, written: false }; } catch { /* rewrite it */ }
  }
  await mkdir(folder, { recursive: true, mode: 0o755 });
  const temporary = join(folder, `.${randomUUID()}.amxd`);
  try { await writeFile(temporary, bytes, { mode: 0o644 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
  return { file, written: true };
}
