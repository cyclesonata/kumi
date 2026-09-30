/**
 * Watching a video: what it is (title, chapters), what's said in it (its captions, or its speech
 * transcribed on this computer, timed), what it shows at the moments that matter (frames, and
 * close-ups of them) and the sound it plays (to compare with later). A video page is read with
 * yt-dlp and nothing is downloaded whole: frames and sound come from the streams at the moments
 * asked for. Each video keeps a folder, so asking again is quick.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { audioPath } from "../audio/index.js";
import { formatTime, parseCaptions, saidAround, transcriptLines, type Cue } from "./captions.js";
import { durationOf, frameAt, REGIONS, soundBetween, type Input, type Region, type Thumb } from "./frames.js";
import { chooseMoments } from "./moments.js";
import { ffmpegHint, findFfmpeg, findWhisper, findYtDlp, run, VideoError, whisperHint, whisperModel, ytDlpExtras } from "./programs.js";
import { speechModelFor, speechPrompt, transcribe } from "./speech.js";

export { formatTime, parseCaptions, parseTime, transcriptLines, type Cue } from "./captions.js";
export { REGIONS, type Region, type Thumb } from "./frames.js";
export { chooseMoments } from "./moments.js";
export { findFfmpeg, findWhisper, findYtDlp, VideoError, whisperAsset, ytDlpAsset } from "./programs.js";

export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"];
/** Videos kept; the least recently watched go first. */
const MAX_VIDEOS = 24;
/** The transcript the model gets at once; past that, it asks for a later stretch. */
const MAX_TRANSCRIPT = 24_000;
/** The longest stretch of sound taken at once. */
export const MAX_SOUND = 120;
/** The most of a video transcribed at once. */
const MAX_SPEECH = 90 * 60;
/** Stream addresses last hours; a page read this recently is used again. */
const PAGE_FRESH_MS = 60 * 60_000;

type Env = Readonly<Record<string, string | undefined>>;

export interface WatchRequest {
  url: string;
  from?: number;
  to?: number;
  /** Particular moments to see; otherwise Kumi picks them. */
  lookAt?: number[];
  /** A part of the picture to see closely at those moments (Live's devices are at the bottom). */
  zoom?: Region;
  /** How many moments Kumi picks (0 for the words alone). */
  frames?: number;
  /** A stretch where the video plays the sound it makes, kept as a WAV to hear and compare. */
  listen?: { from: number; to: number };
}

export interface WatchOptions {
  /** One folder per video (~/.kumi/videos). */
  videosDir: string;
  /** Where Kumi keeps the programs it fetches (~/.kumi/tools). */
  toolsDir: string;
  env?: Env;
  signal?: AbortSignal;
  /** Said when Kumi fetches a program or a speech model, the first time. */
  onFetch?: (message: string) => void;
  /** What's happening now ("looking at 2:05"), for NOW. */
  onProgress?: (text: string) => void;
}

export interface VideoMeta {
  version: 1;
  key: string;
  url: string;
  title: string;
  channel?: string;
  duration?: number;
  chapters: { start: number; title: string }[];
  /** Where the words come from: captions (the video's own, or automatic), or Kumi's transcription. */
  words?: { language: string; source: "captions" | "automatic" | "transcribed" };
}

export interface Watched extends VideoMeta {
  from: number;
  to: number;
  lines: { at: number; text: string }[];
  /** Where the transcript given stops, when the stretch asked for says more. */
  cutAt?: number;
  frames: { at: number; said: string; region?: Region; jpeg: Buffer; thumb: Thumb }[];
  sound?: { file: string; from: number; to: number };
  /** What couldn't be done, in words for the producer and the model. */
  notes: string[];
}

interface Format { url?: string; protocol?: string; vcodec?: string; acodec?: string; height?: number; ext?: string; abr?: number; tbr?: number; http_headers?: Record<string, string> }
interface Info {
  id?: string; title?: string; uploader?: string; channel?: string; duration?: number; webpage_url?: string; extractor_key?: string; language?: string;
  chapters?: { start_time?: number; title?: string }[];
  subtitles?: Record<string, { ext?: string; url?: string }[]>;
  automatic_captions?: Record<string, { ext?: string; url?: string }[]>;
  formats?: Format[];
}

/** The 11-character id of a YouTube address, which names its folder before anything is read. */
export function youtubeId(url: string): string | undefined {
  const match = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(url.trim());
  return match?.[1];
}

/**
 * Whether a page's address for a stream or captions is somewhere public: http(s), and not this
 * computer or a private network by name or number. A page is untrusted, so Kumi fetches nothing
 * else on its behalf.
 */
export function publicAddress(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") && !host.includes(":")) return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)?.slice(1).map(Number);
  if (v4) {
    const [a, b] = v4 as [number, number];
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  if (host.includes(":")) return !(host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:"));
  return true;
}

const safe = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "video";

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; }
}

/** The least recently watched videos' folders go once there are more than MAX_VIDEOS. */
async function prune(videosDir: string): Promise<void> {
  let names: string[] = [];
  try { names = await readdir(videosDir); } catch { return; }
  const folders = (await Promise.all(names.map(async (name) => {
    try { return { name, used: (await stat(join(videosDir, name, "meta.json"))).mtimeMs }; } catch { return undefined; }
  }))).filter((folder): folder is { name: string; used: number } => Boolean(folder)).sort((a, b) => b.used - a.used);
  for (const folder of folders.slice(MAX_VIDEOS)) await rm(join(videosDir, folder.name), { recursive: true, force: true });
}

/** The captions to read: the video's own in English or its language first, then its automatic ones. */
function captionTrack(info: Info): { code: string; automatic: boolean; url?: string; ext?: string } | undefined {
  const spoken = (info.language ?? "en").split(/[-_]/)[0]!.toLowerCase();
  const tracks = [...Object.entries(info.subtitles ?? {}).map(([code, list]) => ({ code, list, automatic: false })),
    ...Object.entries(info.automatic_captions ?? {}).map(([code, list]) => ({ code, list, automatic: true }))].filter((track) => Array.isArray(track.list) && !/live_chat/i.test(track.code));
  const rank = (track: { code: string; automatic: boolean }) => {
    const base = track.code.split(/[-_]/)[0]!.toLowerCase();
    if (!track.automatic) return base === "en" ? 0 : base === spoken ? 1 : 6;
    if (/-orig$/.test(track.code) && base === spoken) return 2;
    if (track.code.toLowerCase() === spoken) return 3;
    if (base === "en") return 4;
    return 9;
  };
  const best = tracks.map((track) => ({ ...track, rank: rank(track) })).filter((track) => track.rank < 9).sort((a, b) => a.rank - b.rank)[0];
  if (!best) return undefined;
  const format = ["json3", "vtt", "srt"].map((ext) => best.list.find((item) => item.ext === ext && typeof item.url === "string")).find(Boolean);
  return { code: best.code, automatic: best.automatic, ...(format?.url ? { url: format.url, ext: format.ext! } : {}) };
}

/**
 * The streams frames and sound come from, direct ones (not playlists): the picture up to 720p for
 * whole frames (h264 first: quickest to seek), the sharpest up to 1440p for close-ups, and the sound.
 */
function streams(info: Info): { video?: Input; sharp?: Input; audio?: Input } {
  const formats = (info.formats ?? []).filter((format) => typeof format.url === "string" && /^https?$/.test(format.protocol ?? "https") && publicAddress(format.url));
  const input = (format: Format | undefined): Input | undefined => (format ? { url: format.url!, ...(format.http_headers ? { headers: format.http_headers } : {}) } : undefined);
  const h264 = (format: Format) => Number(/^avc1/.test(format.vcodec ?? ""));
  const pictures = formats.filter((format) => format.vcodec && format.vcodec !== "none" && (format.height ?? 0) > 0);
  const video = pictures.filter((format) => format.height! <= 720).sort((a, b) => b.height! - a.height! || h264(b) - h264(a))[0];
  const sharp = pictures.filter((format) => format.height! <= 1440).sort((a, b) => b.height! - a.height! || h264(b) - h264(a))[0];
  const sounds = formats.filter((format) => format.acodec && format.acodec !== "none" && (!format.vcodec || format.vcodec === "none"))
    .sort((a, b) => Number(b.ext === "m4a") - Number(a.ext === "m4a") || (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0));
  const combined = formats.find((format) => format.acodec && format.acodec !== "none" && format.vcodec && format.vcodec !== "none");
  const result: { video?: Input; sharp?: Input; audio?: Input } = {};
  const chosen = { video: input(video ?? combined), sharp: input(sharp ?? video ?? combined), audio: input(sounds[0] ?? combined) };
  for (const [name, value] of Object.entries(chosen)) if (value) result[name as keyof typeof result] = value;
  return result;
}

/**
 * Captions from their address, or written by yt-dlp when the address alone doesn't give them.
 * `refused`: YouTube turned the request away (it does, from some networks), so asking again is no use.
 */
async function captionsFor(info: Info, url: string, ytdlp: string, folder: string, signal?: AbortSignal): Promise<{ cues: Cue[]; track?: { code: string; automatic: boolean }; refused?: boolean }> {
  const track = captionTrack(info);
  if (!track) return { cues: [] };
  if (track.url && track.ext && publicAddress(track.url)) {
    try {
      const response = await fetch(track.url, { headers: { "User-Agent": "Mozilla/5.0" }, ...(signal ? { signal } : {}) });
      if (response.status === 429 || response.status === 403) return { cues: [], track, refused: true };
      if (response.ok) { const cues = parseCaptions(await response.text(), track.ext); if (cues.length) return { cues, track }; }
    } catch { signal?.throwIfAborted(); }
  }
  const scratch = join(folder, "captions");
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  try {
    await run(ytdlp, ["--skip-download", "--no-playlist", "--no-warnings", ...(await ytDlpExtras(ytdlp, signal)), track.automatic ? "--write-auto-subs" : "--write-subs", "--sub-langs", track.code,
      "--sub-format", "json3/vtt/srt/best", "-o", join(scratch, "captions.%(ext)s"), "--", url], { timeoutMs: 90_000, ...(signal ? { signal } : {}) });
    for (const name of await readdir(scratch)) {
      const ext = name.split(".").at(-1) ?? "";
      if (["json3", "vtt", "srt"].includes(ext)) { const cues = parseCaptions(await readFile(join(scratch, name), "utf8"), ext); if (cues.length) return { cues, track }; }
    }
  } catch { signal?.throwIfAborted(); } finally { await rm(scratch, { recursive: true, force: true }); }
  return { cues: [], track };
}

/** Pages read lately, by address: their stream addresses still work, so frames need no new read. */
const pages = new Map<string, { info: Info; at: number }>();

/** Watch `request.url` (a video page or a video file): see WatchRequest and Watched. */
export async function watchVideo(request: WatchRequest, options: WatchOptions): Promise<Watched> {
  const signal = options.signal; const env = options.env ?? process.env;
  const progress = (text: string) => { try { options.onProgress?.(text); } catch { /* a listener failure must not stop watching */ } };
  const notes: string[] = [];
  let address = request.url.trim();
  if (/^file:\/\//i.test(address)) address = fileURLToPath(address);
  const remote = /^https?:\/\//i.test(address);
  let file: string | undefined;
  if (!remote) {
    file = audioPath(address);
    if (!existsSync(file)) throw new VideoError("There's no video there: give a video's address (a YouTube link, say) or a video file's path.");
    if (!VIDEO_EXTENSIONS.includes(extname(file).toLowerCase())) throw new VideoError(`${extname(file) || "That file"} isn't a video Kumi reads (${VIDEO_EXTENSIONS.join(", ")}).`);
  }
  // The folder: a YouTube address names it at once; another site's page once read; a file by what it is.
  const localKey = file ? `file-${createHash("sha256").update(`${file}|${statSync(file).size}|${statSync(file).mtimeMs}`).digest("hex").slice(0, 16)}` : undefined;
  const known = localKey ?? (youtubeId(address) ? `youtube-${youtubeId(address)}` : undefined);
  let meta = known ? await readJson<VideoMeta>(join(options.videosDir, known, "meta.json")) : undefined;
  let cues = known ? await readJson<Cue[]>(join(options.videosDir, known, "cues.json")) : undefined;
  let ytdlp: string | undefined;
  const ytdlpPath = async () => ytdlp ??= await findYtDlp({ env, toolsDir: options.toolsDir, ...(signal ? { signal } : {}), ...(options.onFetch ? { onFetch: options.onFetch } : {}) });
  const readPage = async (): Promise<Info> => {
    const recent = pages.get(address);
    if (recent && Date.now() - recent.at < PAGE_FRESH_MS) return recent.info;
    const program = await ytdlpPath();
    progress("reading the video's page");
    let text: string;
    try { text = String((await run(program, ["-J", "--no-playlist", "--no-warnings", ...(await ytDlpExtras(program, signal)), "--", address], { timeoutMs: 120_000, ...(signal ? { signal } : {}) })).stdout); }
    catch (error) { signal?.throwIfAborted(); throw new VideoError(`Kumi couldn't read that video's page: ${(error as Error).message}`); }
    let page: Info;
    try { page = JSON.parse(text) as Info; } catch { throw new VideoError("Kumi couldn't make sense of that video's page."); }
    pages.set(address, { info: page, at: Date.now() });
    for (const [key, value] of pages) if (pages.size > 16 || Date.now() - value.at >= PAGE_FRESH_MS) pages.delete(key);
    return page;
  };
  let info: Info | undefined;
  let refused = false;
  if (!meta || !cues) {
    if (file) {
      const ffmpeg = await findFfmpeg({ env, ...(signal ? { signal } : {}) });
      const duration = ffmpeg ? await durationOf(ffmpeg, file, signal) : undefined;
      meta = { version: 1, key: localKey!, url: file, title: basename(file, extname(file)), ...(duration ? { duration } : {}), chapters: [] };
      // Captions beside the file (the same name, .srt or .vtt), when there are any.
      cues = [];
      for (const ext of [".srt", ".vtt"]) {
        const sidecar = join(dirname(file), `${basename(file, extname(file))}${ext}`);
        if (existsSync(sidecar)) { cues = parseCaptions(await readFile(sidecar, "utf8"), ext.slice(1)); meta.words = { language: "", source: "captions" }; break; }
      }
    } else {
      info = await readPage();
      const key = `${safe(info.extractor_key ?? "video")}-${safe(info.id ?? createHash("sha256").update(address).digest("hex").slice(0, 16))}`;
      const folder = join(options.videosDir, key);
      // Another site's video, watched before: its folder has its words.
      meta = await readJson<VideoMeta>(join(folder, "meta.json"));
      cues = meta ? await readJson<Cue[]>(join(folder, "cues.json")) : undefined;
      if (!meta || !cues) {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        progress("reading the captions");
        const captions = await captionsFor(info, address, await ytdlpPath(), folder, signal);
        cues = captions.cues; refused = Boolean(captions.refused);
        meta = { version: 1, key, url: info.webpage_url ?? address, title: (info.title ?? "Untitled video").slice(0, 200), ...(info.channel ?? info.uploader ? { channel: String(info.channel ?? info.uploader).slice(0, 120) } : {}),
          ...(typeof info.duration === "number" ? { duration: info.duration } : {}),
          chapters: (info.chapters ?? []).filter((chapter) => typeof chapter.start_time === "number").slice(0, 64).map((chapter) => ({ start: chapter.start_time!, title: String(chapter.title ?? "").slice(0, 120) })),
          ...(cues.length && captions.track ? { words: { language: captions.track.code, source: captions.track.automatic ? "automatic" as const : "captions" as const } } : {}) };
      }
    }
  }
  const folder = join(options.videosDir, meta.key);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const end = meta.duration ?? Math.max(0, ...cues.map((cue) => cue.end));
  const from = Math.max(0, Math.min(request.from ?? 0, end));
  const to = Math.max(from, Math.min(request.to ?? end, end || Infinity));

  // The picture and the sound: both need ffmpeg, and a page's streams (read afresh when they may have expired).
  const ffmpeg = await findFfmpeg({ env, ...(signal ? { signal } : {}) });
  let sources: { video?: Input; sharp?: Input; audio?: Input } | undefined;
  const streamsFor = async () => sources ??= file ? { video: { url: file }, sharp: { url: file }, audio: { url: file } } : streams(info ??= await readPage());

  // No captions: the speech, transcribed here, when whisper.cpp is on this computer.
  if (!cues.length && !meta.words) {
    const whisper = ffmpeg ? await findWhisper({ env, toolsDir: options.toolsDir, ...(signal ? { signal } : {}), ...(options.onFetch ? { onFetch: options.onFetch } : {}) }).catch(() => undefined) : undefined;
    const why = refused ? "YouTube turned away the request for its captions" : file ? "it has no captions beside it (a .srt or .vtt of the same name)" : "it has no captions";
    if (!ffmpeg) notes.push(`There's no transcript: ${why}, and transcribing its speech needs ffmpeg (${ffmpegHint()}).`);
    else if (!whisper) notes.push(`There's no transcript: ${why}, and Kumi transcribes speech with whisper.cpp (${whisperHint()}). The frames show what it does.`);
    else {
      const audio = (await streamsFor()).audio;
      if (!audio) notes.push(`There's no transcript: ${why}, and Kumi couldn't find the video's sound to transcribe.`);
      else {
        const language = info?.language ?? "en";
        const model = await whisperModel(speechModelFor(language), { env, toolsDir: options.toolsDir, ...(signal ? { signal } : {}), ...(options.onFetch ? { onFetch: options.onFetch } : {}) });
        // A long video is transcribed a stretch at a time; one that fits is transcribed whole, once.
        const whole = !end || end <= MAX_SPEECH;
        const start = whole ? 0 : from; const stop = whole ? (end || MAX_SPEECH) : Math.min(to, from + MAX_SPEECH);
        progress("taking the video's speech");
        const wav = await soundBetween(ffmpeg, audio, start, stop, join(folder, `speech-${start.toFixed(0)}-${stop.toFixed(0)}.wav`), signal, true);
        try {
          progress("transcribing what's said");
          const heard = await transcribe(whisper, model, wav, { language, prompt: speechPrompt(meta.title), ...(signal ? { signal } : {}),
            onProgress: (percent) => progress(`transcribing what's said · ${percent}%`) });
          cues = heard.map((cue) => ({ ...cue, start: cue.start + start, end: cue.end + start }));
          // A stretch of a long video isn't kept as the whole video's words.
          if (whole) meta.words = { language, source: "transcribed" };
          else notes.push(`Kumi transcribed ${formatTime(start)}–${formatTime(stop)} of this long video; ask for a later stretch to hear more.`);
        } catch (error) {
          signal?.throwIfAborted();
          notes.push(`Kumi couldn't transcribe the video's speech (${(error as Error).message.slice(0, 160)}).`);
        } finally { await rm(wav, { force: true }); }
      }
    }
  }
  if (meta.words || !cues.length) await writeFile(join(folder, "cues.json"), JSON.stringify(meta.words ? cues : []), { mode: 0o600 });
  await writeFile(join(folder, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
  const now = new Date(); await utimes(join(folder, "meta.json"), now, now).catch(() => {});
  await prune(options.videosDir);

  // The transcript, as much as the model reads at once.
  const lines: { at: number; text: string }[] = []; let size = 0; let cutAt: number | undefined;
  for (const line of transcriptLines(cues, { from, to })) { if (size + line.text.length > MAX_TRANSCRIPT) { cutAt = line.at; break; } lines.push(line); size += line.text.length + 12; }

  // Frames at the moments that matter, and the sound asked for.
  const region = request.zoom && request.zoom in REGIONS ? request.zoom : undefined;
  const wanted = request.lookAt?.length ? [...new Set(request.lookAt.filter((time) => time >= 0 && (!end || time <= end)).map((time) => Math.round(time * 10) / 10))].slice(0, 12)
    : chooseMoments(cues, { from, to, count: request.frames ?? (cues.length ? 8 : 12), chapters: meta.chapters });
  const frames: Watched["frames"] = [];
  let sound: Watched["sound"];
  const needsSound = request.listen && request.listen.to > request.listen.from;
  if ((wanted.length || needsSound) && !ffmpeg) notes.push(`Frames and the video's sound need ffmpeg (${ffmpegHint()}); this is the transcript alone.`);
  else if (ffmpeg) {
    const framePath = (time: number) => join(folder, "frames", `${time.toFixed(1)}${region ? `-${region}` : ""}.jpg`);
    const missing = wanted.some((time) => !existsSync(framePath(time)));
    const input = missing ? (region ? (await streamsFor()).sharp : (await streamsFor()).video) : undefined;
    if (missing && !input) notes.push("Kumi couldn't find a stream of that video to take frames from; this is the transcript alone.");
    else {
      // A few at a time: each is a seek into the stream.
      for (let index = 0; index < wanted.length; index += 3) {
        await Promise.all(wanted.slice(index, index + 3).map(async (time) => {
          progress(`looking at ${formatTime(time)}`);
          try {
            const frame = await frameAt(ffmpeg, input, time, framePath(time), signal, region);
            frames.push({ at: time, said: saidAround(cues!, time), ...(region ? { region } : {}), ...frame });
          } catch (error) { signal?.throwIfAborted(); notes.push(`Kumi couldn't take the frame at ${formatTime(time)} (${(error as Error).message.slice(0, 120)}).`); }
        }));
      }
      frames.sort((a, b) => a.at - b.at);
    }
    if (needsSound) {
      const start = Math.max(0, request.listen!.from); const stop = Math.min(request.listen!.to, start + MAX_SOUND, end || Infinity);
      const audio = stop > start ? (await streamsFor()).audio : undefined;
      if (!audio) notes.push("Kumi couldn't find the video's sound to take.");
      else {
        progress(`taking the sound at ${formatTime(start)}–${formatTime(stop)}`);
        try { sound = { file: await soundBetween(ffmpeg, audio, start, stop, join(folder, "sound", `${start.toFixed(1)}-${stop.toFixed(1)}.wav`), signal), from: start, to: stop }; }
        catch (error) { signal?.throwIfAborted(); notes.push(`Kumi couldn't take the sound at ${formatTime(start)}–${formatTime(stop)} (${(error as Error).message.slice(0, 120)}).`); }
      }
    }
  }
  return { ...meta, from, to, lines, ...(cutAt !== undefined ? { cutAt } : {}), frames, ...(sound ? { sound } : {}), notes };
}
