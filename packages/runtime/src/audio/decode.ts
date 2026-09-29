/**
 * Reading audio files as blocks of samples, without loading a whole song into memory. WAV and
 * AIFF (the formats Live records and bounces to) are read directly; other formats (MP3, AAC/M4A,
 * FLAC, Ogg) are converted first with the system's own converter (afconvert on macOS) or ffmpeg.
 */
import { execFile } from "node:child_process";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

export interface AudioSource {
  sampleRate: number;
  channels: number;
  /** Sample frames in the file. */
  frames: number;
  /** "wav", "aiff", or the converted format's extension. */
  format: string;
  /** The next frames, one Float32Array per channel (-1…1); undefined at the end. */
  read(frames: number): Promise<Float32Array[] | undefined>;
  /** Move to a frame. */
  seek(frame: number): void;
  close(): Promise<void>;
}

/** Extensions Kumi reads; the rest aren't audio it can open. */
export const AUDIO_EXTENSIONS = [".wav", ".wave", ".aif", ".aiff", ".aifc", ".mp3", ".m4a", ".aac", ".mp4", ".flac", ".ogg", ".oga", ".opus", ".caf"];
const DIRECT = new Set([".wav", ".wave", ".aif", ".aiff", ".aifc"]);

export class AudioError extends Error {}

type Encoding = { kind: "int"; bits: 8 | 16 | 24 | 32; signed: boolean } | { kind: "float"; bits: 32 | 64 };

interface Layout { sampleRate: number; channels: number; frames: number; dataOffset: number; littleEndian: boolean; encoding: Encoding; format: string }

/** Open an audio file for reading in blocks. Throws AudioError for what isn't readable audio. */
export async function openAudio(path: string, options: { signal?: AbortSignal } = {}): Promise<AudioSource> {
  const extension = extname(path).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(extension)) throw new AudioError(`${extension || "That file"} isn't an audio format Kumi reads (WAV, AIFF, MP3, M4A, FLAC, Ogg).`);
  if (DIRECT.has(extension)) return openPcm(path);
  // Converted once to a temporary WAV, deleted when the source is closed.
  const folder = await mkdtemp(join(tmpdir(), "kumi-audio-"));
  const wav = join(folder, "converted.wav");
  try {
    await convert(path, wav, options.signal);
    const source = await openPcm(wav);
    return { ...source, format: extension.slice(1), read: (frames) => source.read(frames), seek: (frame) => source.seek(frame),
      close: async () => { await source.close(); await rm(folder, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

function run(command: string, args: string[], signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) }, (error) => (error ? reject(error) : resolve()));
  });
}

async function convert(input: string, output: string, signal: AbortSignal | undefined): Promise<void> {
  const attempts: [string, string[]][] = [
    ...(process.platform === "darwin" ? [["afconvert", ["-f", "WAVE", "-d", "LEF32", input, output]] as [string, string[]]] : []),
    ["ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", input, "-vn", "-acodec", "pcm_f32le", "-f", "wav", output]],
  ];
  for (const [command, args] of attempts) {
    try { await run(command, args, signal); return; } catch (error) { if (signal?.aborted) throw error; }
  }
  throw new AudioError(`Kumi couldn't decode ${extname(input).slice(1).toUpperCase()} here: it reads WAV and AIFF itself, and other formats with ${process.platform === "darwin" ? "macOS's afconvert or " : ""}ffmpeg. Install ffmpeg, or export the file as WAV.`);
}

async function openPcm(path: string): Promise<AudioSource> {
  let handle: FileHandle;
  try { handle = await open(path, "r"); } catch (error) {
    throw new AudioError((error as NodeJS.ErrnoException).code === "ENOENT" ? "There's no file there." : "Kumi couldn't open that file.");
  }
  try {
    const layout = await readLayout(handle);
    const bytesPerSample = layout.encoding.bits / 8;
    const blockAlign = bytesPerSample * layout.channels;
    let frame = 0;
    return {
      sampleRate: layout.sampleRate, channels: layout.channels, frames: layout.frames, format: layout.format,
      seek(to) { frame = Math.max(0, Math.min(layout.frames, Math.floor(to))); },
      async read(count) {
        const frames = Math.min(count, layout.frames - frame);
        if (frames <= 0) return undefined;
        const buffer = Buffer.alloc(frames * blockAlign);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, layout.dataOffset + frame * blockAlign);
        const got = Math.floor(bytesRead / blockAlign);
        if (got <= 0) return undefined;
        frame += got;
        return deinterleave(buffer, got, layout);
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function bytesAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function readLayout(handle: FileHandle): Promise<Layout> {
  const head = await bytesAt(handle, 0, 12);
  if (head.length < 12) throw new AudioError("That file is too short to be audio.");
  const tag = head.toString("latin1", 0, 4);
  const kind = head.toString("latin1", 8, 12);
  if ((tag === "RIFF" || tag === "RIFX") && kind === "WAVE") return readWav(handle, tag === "RIFF");
  if (tag === "RF64") throw new AudioError("That WAV is in the RF64 format for files over 4 GB; export a shorter part.");
  if (tag === "FORM" && (kind === "AIFF" || kind === "AIFC")) return readAiff(handle, kind === "AIFC");
  throw new AudioError("That file doesn't look like WAV or AIFF audio inside.");
}

async function readWav(handle: FileHandle, littleEndian: boolean): Promise<Layout> {
  const size = (await handle.stat()).size;
  let position = 12;
  let format: { code: number; channels: number; sampleRate: number; bits: number } | undefined;
  while (position + 8 <= size) {
    const header = await bytesAt(handle, position, 8);
    if (header.length < 8) break;
    const id = header.toString("latin1", 0, 4);
    const length = littleEndian ? header.readUInt32LE(4) : header.readUInt32BE(4);
    if (id === "fmt ") {
      const body = await bytesAt(handle, position + 8, Math.min(length, 40));
      const u16 = (at: number) => (littleEndian ? body.readUInt16LE(at) : body.readUInt16BE(at));
      const u32 = (at: number) => (littleEndian ? body.readUInt32LE(at) : body.readUInt32BE(at));
      let code = u16(0);
      // WAVE_FORMAT_EXTENSIBLE names the real format in its sub-format GUID's first two bytes.
      if (code === 0xfffe && body.length >= 26) code = u16(24);
      format = { code, channels: u16(2), sampleRate: u32(4), bits: u16(14) };
    } else if (id === "data") {
      if (!format) throw new AudioError("That WAV has its audio before its format; it can't be read.");
      const bytes = Math.min(length, size - position - 8);
      const encoding: Encoding | undefined = format.code === 1 && [8, 16, 24, 32].includes(format.bits) ? { kind: "int", bits: format.bits as 8 | 16 | 24 | 32, signed: format.bits !== 8 }
        : format.code === 3 && (format.bits === 32 || format.bits === 64) ? { kind: "float", bits: format.bits } : undefined;
      if (!encoding) throw new AudioError(`That WAV's sample format (code ${format.code}, ${format.bits} bits) isn't one Kumi reads.`);
      if (!format.channels || !format.sampleRate) throw new AudioError("That WAV says it has no channels or no sample rate.");
      return { sampleRate: format.sampleRate, channels: format.channels, frames: Math.floor(bytes / (format.channels * format.bits / 8)), dataOffset: position + 8, littleEndian, encoding, format: "wav" };
    }
    position += 8 + length + (length % 2);
  }
  throw new AudioError("That WAV has no audio in it.");
}

/** An 80-bit IEEE extended float, as AIFF stores its sample rate. */
function extended(bytes: Buffer): number {
  const exponent = ((bytes[0]! & 0x7f) << 8) | bytes[1]!;
  const high = bytes.readUInt32BE(2); const low = bytes.readUInt32BE(6);
  if (!exponent && !high && !low) return 0;
  return (high * 2 ** 32 + low) * 2 ** (exponent - 16383 - 63) * (bytes[0]! & 0x80 ? -1 : 1);
}

async function readAiff(handle: FileHandle, compressed: boolean): Promise<Layout> {
  const size = (await handle.stat()).size;
  let position = 12;
  let common: { channels: number; frames: number; bits: number; sampleRate: number; compression: string } | undefined;
  while (position + 8 <= size) {
    const header = await bytesAt(handle, position, 8);
    if (header.length < 8) break;
    const id = header.toString("latin1", 0, 4);
    const length = header.readUInt32BE(4);
    if (id === "COMM") {
      const body = await bytesAt(handle, position + 8, Math.min(length, 26));
      common = { channels: body.readUInt16BE(0), frames: body.readUInt32BE(2), bits: body.readUInt16BE(6), sampleRate: extended(body.subarray(8, 18)),
        compression: compressed && body.length >= 22 ? body.toString("latin1", 18, 22) : "NONE" };
    } else if (id === "SSND") {
      if (!common) throw new AudioError("That AIFF has its audio before its format; it can't be read.");
      const offset = (await bytesAt(handle, position + 8, 4)).readUInt32BE(0);
      const kind = common.compression;
      const encoding: Encoding | undefined = (kind === "NONE" || kind === "twos" || kind === "sowt") && [8, 16, 24, 32].includes(common.bits) ? { kind: "int", bits: common.bits as 8 | 16 | 24 | 32, signed: true }
        : (kind === "fl32" || kind === "FL32") ? { kind: "float", bits: 32 } : (kind === "fl64" || kind === "FL64") ? { kind: "float", bits: 64 } : undefined;
      if (!encoding) throw new AudioError(`That AIFF is compressed as “${kind}”, which Kumi doesn't read; export it as WAV or plain AIFF.`);
      if (!common.channels || !common.sampleRate) throw new AudioError("That AIFF says it has no channels or no sample rate.");
      const dataOffset = position + 16 + offset;
      const available = Math.floor((size - dataOffset) / (common.channels * encoding.bits / 8));
      return { sampleRate: Math.round(common.sampleRate), channels: common.channels, frames: Math.min(common.frames, available), dataOffset,
        littleEndian: kind === "sowt", encoding, format: "aiff" };
    }
    position += 8 + length + (length % 2);
  }
  throw new AudioError("That AIFF has no audio in it.");
}

function deinterleave(buffer: Buffer, frames: number, layout: Layout): Float32Array[] {
  const { channels, encoding, littleEndian } = layout;
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const step = encoding.bits / 8;
  let at = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++, at += step) {
      let value: number;
      if (encoding.kind === "float") value = encoding.bits === 32 ? (littleEndian ? buffer.readFloatLE(at) : buffer.readFloatBE(at)) : (littleEndian ? buffer.readDoubleLE(at) : buffer.readDoubleBE(at));
      else if (encoding.bits === 16) value = (littleEndian ? buffer.readInt16LE(at) : buffer.readInt16BE(at)) / 32768;
      else if (encoding.bits === 24) value = (littleEndian ? buffer.readIntLE(at, 3) : buffer.readIntBE(at, 3)) / 8388608;
      else if (encoding.bits === 32) value = (littleEndian ? buffer.readInt32LE(at) : buffer.readInt32BE(at)) / 2147483648;
      else value = encoding.signed ? buffer.readInt8(at) / 128 : (buffer[at]! - 128) / 128;
      out[channel]![frame] = value;
    }
  }
  return out;
}
