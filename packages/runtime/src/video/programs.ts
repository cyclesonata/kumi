/**
 * The programs watching a video needs: yt-dlp (what a video page holds: captions, chapters, its
 * streams), ffmpeg (a frame, or a stretch of sound, from a stream) and, for a video without
 * captions, whisper.cpp (its speech, transcribed on this computer) with a speech model. yt-dlp,
 * the speech model and (on Windows and Linux) whisper.cpp and ffmpeg are fetched into Kumi's own
 * folder the first time they're needed, each checked against the checksum its publisher lists; on a
 * Mac, ffmpeg and whisper.cpp are the producer's (Homebrew), and audio formats are read with afconvert.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lowDisk, MB } from "../core/disk.js";

type Env = Readonly<Record<string, string | undefined>>;

/** A failure watching a video, said so the producer knows what to do. */
export class VideoError extends Error {}

/** Run a program without a shell, bounded; rejects with its last line of stderr. */
export function run(command: string, args: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number; maxBuffer?: number; encoding?: "utf8" | "buffer" } = {}): Promise<{ stdout: Buffer | string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: options.timeoutMs ?? 120_000, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, encoding: options.encoding === "buffer" ? "buffer" : "utf8",
      windowsHide: true, ...(options.signal ? { signal: options.signal } : {}) }, (error, stdout, stderr) => {
      if (error) {
        const last = String(stderr ?? "").trim().split("\n").filter(Boolean).at(-1);
        reject(Object.assign(new Error(last ? last.slice(0, 400) : error.message), { cause: error }));
      } else resolve({ stdout: stdout as Buffer | string, stderr: String(stderr ?? "") });
    });
  });
}

/**
 * The release of yt-dlp for this computer; undefined where yt-dlp publishes none. A Mac and Windows
 * get the unpacked build, a zip, which starts in a moment (the single file unpacks itself each run).
 */
export function ytDlpAsset(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "darwin") return "yt-dlp_macos.zip";
  if (platform === "win32") return arch === "arm64" ? "yt-dlp_win_arm64.zip" : arch === "ia32" ? "yt-dlp_win_x86.zip" : "yt-dlp_win.zip";
  if (platform === "linux") return arch === "arm64" ? "yt-dlp_linux_aarch64" : arch === "x64" ? "yt-dlp_linux" : undefined;
  return undefined;
}

const RELEASES = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
/** YouTube changes often, and yt-dlp with it: Kumi's copy is fetched afresh once it's this old. */
const YTDLP_FRESH_MS = 30 * 24 * 60 * 60_000;

/** Whether `command` runs (asked for its version). */
async function runs(command: string, versionArg: string, signal?: AbortSignal): Promise<boolean> {
  try { await run(command, [versionArg], { timeoutMs: 20_000, ...(signal ? { signal } : {}) }); return true; } catch { return false; }
}

export interface ProgramOptions {
  env?: Env;
  /** Where Kumi keeps programs it fetched itself (~/.kumi/tools). */
  toolsDir: string;
  signal?: AbortSignal;
  /** Told once when Kumi fetches yt-dlp, so the wait is explained. */
  onFetch?: (message: string) => void;
  /** How far a fetch is, 0–1, as it downloads. */
  onProgress?: (fraction: number) => void;
  /** What the program is for, in the fetch's notice ("to write down what you say"); a video's use when left out. */
  purpose?: string;
  /** For tests: fetch, instead of the network. */
  download?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Only look for what's there: fetch nothing (for the doctor). */
  installedOnly?: boolean;
  /** For tests: free space on a disk. */
  free?: (path: string) => Promise<number | undefined>;
}

async function download(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow", ...(signal ? { signal } : {}) });
  if (!response.ok) throw new VideoError(`Downloading ${url.split("/").at(-1)} failed (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The yt-dlp program in Kumi's folder, when it fetched one. */
async function ownYtDlp(folder: string): Promise<string | undefined> {
  const names = await readdir(folder).catch(() => [] as string[]);
  const name = names.find((entry) => /^yt-dlp[\w.-]*$/.test(entry) && !entry.endsWith(".zip") && (process.platform !== "win32" || entry.endsWith(".exe")));
  return name ? join(folder, name) : undefined;
}

/**
 * yt-dlp: KUMI_YTDLP, then the copy Kumi fetched (fetched afresh once a month), then one on the
 * PATH; failing those, the release for this computer is fetched into `toolsDir` (checked against the
 * release's SHA2-256SUMS).
 */
export async function findYtDlp(options: ProgramOptions): Promise<string> {
  const env = options.env ?? process.env;
  if (env.KUMI_YTDLP) {
    if (!existsSync(env.KUMI_YTDLP)) throw new VideoError(`KUMI_YTDLP names ${env.KUMI_YTDLP}, which isn't there.`);
    return env.KUMI_YTDLP;
  }
  const folder = join(options.toolsDir, "yt-dlp");
  const own = await ownYtDlp(folder);
  if (own && Date.now() - statSync(folder).mtimeMs < YTDLP_FRESH_MS) return own;
  const installed = own ? undefined : onPath(process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp", env);
  if (installed) return installed;
  const asset = ytDlpAsset();
  if (!asset) {
    if (own) return own;
    throw new VideoError("Kumi can't fetch yt-dlp for this computer; install it (https://github.com/yt-dlp/yt-dlp) and try again.");
  }
  options.onFetch?.(own ? "Kumi is updating yt-dlp, the program it reads videos with (once a month)." : "Kumi is fetching yt-dlp, the program it reads videos with (once, about 35 MB).");
  try {
    const sums = await (options.download ?? download)(`${RELEASES}/SHA2-256SUMS`, options.signal);
    const expected = new TextDecoder().decode(sums).split("\n").map((line) => line.trim().split(/\s+/)).find(([, name]) => name === asset)?.[0];
    await mkdir(options.toolsDir, { recursive: true, mode: 0o700 });
    const fetched = join(options.toolsDir, `.${asset}-${randomUUID()}`);
    const unpacked = join(options.toolsDir, `.yt-dlp-${randomUUID()}`);
    try {
      if (!expected || (await downloadTo(`${RELEASES}/${asset}`, fetched, options)) !== expected.toLowerCase()) throw new VideoError("The yt-dlp Kumi downloaded didn't match its release's checksum, so it wasn't kept.");
      await mkdir(unpacked, { recursive: true, mode: 0o700 });
      // tar reads zip archives too (Windows has had it since 2018).
      if (asset.endsWith(".zip")) await run("tar", ["-xf", fetched, "-C", unpacked], { timeoutMs: 120_000, ...(options.signal ? { signal: options.signal } : {}) });
      else await rename(fetched, join(unpacked, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"));
      const program = await ownYtDlp(unpacked);
      if (!program) throw new VideoError("The yt-dlp Kumi downloaded had no program in it.");
      if (process.platform !== "win32") await chmod(program, 0o755);
      await rm(folder, { recursive: true, force: true });
      await rename(unpacked, folder);
      return (await ownYtDlp(folder))!;
    } finally { await rm(fetched, { force: true }); await rm(unpacked, { recursive: true, force: true }); }
  } catch (error) {
    // Offline, say: the copy Kumi has still works for most videos.
    options.signal?.throwIfAborted();
    if (own) return own;
    throw error;
  }
}

const runtimes = new Map<string, Promise<string[]>>();
/**
 * What yt-dlp is told besides: YouTube's pages need JavaScript run to give their streams, and
 * yt-dlp (from 2025.11) can run it with the Node Kumi runs on.
 */
export function ytDlpExtras(ytdlp: string, signal?: AbortSignal): Promise<string[]> {
  let extras = runtimes.get(ytdlp);
  if (!extras) {
    extras = run(ytdlp, ["--version"], { timeoutMs: 60_000, ...(signal ? { signal } : {}) }).then(({ stdout }) => {
      const [year, month] = String(stdout).trim().split(".").map(Number);
      return (year ?? 0) > 2025 || ((year ?? 0) === 2025 && (month ?? 0) >= 11) ? ["--js-runtimes", `node:${process.execPath}`] : [];
    }, () => []);
    runtimes.set(ytdlp, extras);
  }
  return extras;
}

/** Where Kumi keeps the programs it fetches, and who's told when it fetches one: set once as Kumi starts. */
let programDefaults: { toolsDir?: string; onFetch?: (message: string) => void } = {};
export function configurePrograms(options: { toolsDir?: string; onFetch?: (message: string) => void }): void { programDefaults = { ...options }; }

/** The ffmpeg build for this computer among a release's files: the newest numbered LGPL one; a Mac has none. */
export function ffmpegAsset(names: readonly string[], platform: string = process.platform, arch: string = process.arch): string | undefined {
  const target = platform === "win32" ? (arch === "arm64" ? "winarm64" : arch === "x64" ? "win64" : undefined)
    : platform === "linux" ? (arch === "arm64" ? "linuxarm64" : arch === "x64" ? "linux64" : undefined) : undefined;
  if (!target) return undefined;
  const pattern = new RegExp(`^ffmpeg-n(\\d+)\\.(\\d+)-latest-${target}-lgpl-\\d+\\.\\d+\\.(zip|tar\\.xz)$`);
  const versions = names.flatMap((name) => { const found = pattern.exec(name); return found ? [{ name, major: Number(found[1]), minor: Number(found[2]) }] : []; });
  return versions.sort((a, b) => b.major - a.major || b.minor - a.minor)[0]?.name;
}

const FFMPEG_RELEASE = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";

export interface FfmpegOptions {
  env?: Env;
  signal?: AbortSignal;
  /** Where Kumi keeps programs it fetched (~/.kumi/tools); set by configurePrograms when left out. */
  toolsDir?: string;
  onFetch?: (message: string) => void;
  /** How far a fetch is, 0–1, as it downloads. */
  onProgress?: (fraction: number) => void;
  /** What ffmpeg is for, in the fetch's notice; reading audio and videos when left out. */
  purpose?: string;
  /** Only look for what's there: fetch nothing (for the doctor). */
  installedOnly?: boolean;
  /** For tests: the network, the computer, and its free disk. */
  download?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  platform?: string;
  arch?: string;
  free?: (path: string) => Promise<number | undefined>;
}

/**
 * ffmpeg: KUMI_FFMPEG, one on the PATH, where Homebrew and the usual installers put it, or the copy
 * Kumi fetched; failing those, on Windows and Linux, a release build is fetched into `toolsDir`
 * (checked against the SHA-256 GitHub lists for it). A Mac reads audio with afconvert; its ffmpeg
 * (for a video's frames) comes from Homebrew. Undefined when there's none.
 */
export async function findFfmpeg(options: FfmpegOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (env.KUMI_FFMPEG) return existsSync(env.KUMI_FFMPEG) ? env.KUMI_FFMPEG : undefined;
  const platform = options.platform ?? process.platform;
  const program = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const toolsDir = options.toolsDir ?? programDefaults.toolsDir;
  const own = toolsDir ? join(toolsDir, "ffmpeg", program) : undefined;
  if (own && existsSync(own)) return own;
  if (!options.platform) {
    if (await runs("ffmpeg", "-version", options.signal)) return "ffmpeg";
    const candidates = platform === "win32"
      ? [join(env.ProgramFiles ?? "C:\\Program Files", "ffmpeg", "bin", "ffmpeg.exe"), join(env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "ffmpeg.exe")]
      : ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
    for (const candidate of candidates) if (candidate && existsSync(candidate) && await runs(candidate, "-version", options.signal)) return candidate;
  }
  if (!toolsDir || !own || options.installedOnly) return undefined;
  const get = options.download ?? download;
  let release: { assets?: { name?: string; digest?: string; size?: number; browser_download_url?: string }[] };
  try { release = JSON.parse(new TextDecoder().decode(await get(FFMPEG_RELEASE, options.signal))) as typeof release; } catch { options.signal?.throwIfAborted(); return undefined; }
  const assets = (release.assets ?? []).filter((item) => item.browser_download_url?.startsWith("https://github.com/"));
  const asset = ffmpegAsset(assets.map((item) => item.name ?? ""), platform, options.arch ?? process.arch);
  const published = assets.find((item) => item.name === asset);
  const expected = /^sha256:([0-9a-f]{64})$/i.exec(published?.digest ?? "")?.[1];
  if (!asset || !published || !expected) return undefined;
  // The archive, and the program unpacked from it, side by side for a moment.
  const full = await lowDisk(toolsDir, 2 * (published.size ?? 200 * MB) + 100 * MB, "Kumi keeps its programs on", options.free);
  if (full) throw new VideoError(`Kumi needs ffmpeg for this, and would fetch it. ${full}`);
  (options.onFetch ?? programDefaults.onFetch)?.(`Kumi is fetching ffmpeg, ${options.purpose ?? "which it reads audio formats and videos with"} (once, about ${Math.round((published.size ?? 0) / 1e6)} MB).`);
  const archive = join(toolsDir, `.ffmpeg-${randomUUID()}${asset.endsWith(".zip") ? ".zip" : ".tar.xz"}`);
  const unpacked = join(toolsDir, `.ffmpeg-${randomUUID()}`);
  try {
    if ((await downloadTo(published.browser_download_url!, archive, { toolsDir, ...(options.signal ? { signal: options.signal } : {}), ...(options.download ? { download: options.download } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}) }, published.size)) !== expected.toLowerCase()) {
      throw new VideoError("The ffmpeg Kumi downloaded didn't match its release's checksum, so it wasn't kept.");
    }
    await mkdir(unpacked, { recursive: true, mode: 0o700 });
    // tar reads zip archives too (Windows has had it since 2018), and xz ones.
    await run("tar", ["-xf", archive, "-C", unpacked], { timeoutMs: 300_000, ...(options.signal ? { signal: options.signal } : {}) });
    const inside = (await readdir(unpacked, { recursive: true })).map(String).find((name) => { const parts = name.split(/[\\/]/); return parts.at(-1) === program && parts.at(-2) === "bin"; });
    if (!inside) return undefined;
    // Only the program: the build is static, and the rest (ffprobe, ffplay, docs) isn't needed.
    await mkdir(dirname(own), { recursive: true, mode: 0o700 });
    await rename(join(unpacked, inside), own);
    if (platform !== "win32") await chmod(own, 0o755);
    return own;
  } finally {
    await rm(archive, { force: true }); await rm(unpacked, { recursive: true, force: true });
  }
}

/** How to get ffmpeg on this computer, for the one line that says frames and sound need it. */
export function ffmpegHint(): string {
  return process.platform === "darwin" ? "brew install ffmpeg" : process.platform === "win32" ? "Kumi fetches it the first time it's needed; or winget install ffmpeg" : "Kumi fetches it the first time it's needed; or your package manager (ffmpeg)";
}

/** A program by name on the PATH, as a full path; undefined when it isn't there. */
function onPath(name: string, env: Env): string | undefined {
  for (const folder of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(folder, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A download streamed to `path`, with its SHA-256 (hex); nothing is left there on failure. How far it
 * is goes to onProgress, against its length (or `size`, the length its publisher lists).
 */
async function downloadTo(url: string, path: string, options: ProgramOptions, size?: number): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  try {
    if (options.download) {
      const data = await options.download(url, options.signal);
      hash.update(data);
      await writeFile(path, data, { mode: 0o600 });
      options.onProgress?.(1);
    } else {
      const response = await fetch(url, { redirect: "follow", ...(options.signal ? { signal: options.signal } : {}) });
      if (!response.ok || !response.body) throw new VideoError(`Downloading ${url.split("/").at(-1)} failed (${response.status}).`);
      const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
      const total = Number(response.headers.get("content-length")) || size || 0;
      let received = 0; let told = -1;
      body.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        received += chunk.length;
        // A whole percent at a time: the screen needn't redraw for every packet.
        const percent = total ? Math.min(100, Math.floor(received / total * 100)) : -1;
        if (percent > told) { told = percent; options.onProgress?.(percent / 100); }
      });
      const file = createWriteStream(path, { mode: 0o600 });
      await (options.signal ? pipeline(body, file, { signal: options.signal }) : pipeline(body, file));
    }
    return hash.digest("hex");
  } catch (error) { await rm(path, { force: true }); throw error; }
}

/** whisper.cpp's build for this computer, where its releases have one (a Mac gets it from Homebrew). */
export function whisperAsset(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "win32") return arch === "arm64" ? "whisper-bin-win-cpu-arm64.zip" : arch === "ia32" ? "whisper-bin-Win32.zip" : arch === "x64" ? "whisper-bin-x64.zip" : undefined;
  if (platform === "linux") return arch === "arm64" ? "whisper-bin-ubuntu-arm64.tar.gz" : arch === "x64" ? "whisper-bin-ubuntu-x64.tar.gz" : undefined;
  return undefined;
}

/** How to get whisper.cpp on this computer, for the line that says transcribing needs it. */
export function whisperHint(): string {
  return process.platform === "darwin" ? "brew install whisper-cpp" : "https://github.com/ggml-org/whisper.cpp";
}

const WHISPER_RELEASES = "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20";

/**
 * whisper.cpp's command line (whisper-cli): KUMI_WHISPER, the copy Kumi fetched, one on the PATH
 * or where Homebrew puts it; failing those, on Windows and Linux, the latest release's build is
 * fetched into `toolsDir` (checked against the SHA-256 GitHub lists for it). Undefined when there's none.
 */
export async function findWhisper(options: ProgramOptions): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (env.KUMI_WHISPER) return existsSync(env.KUMI_WHISPER) ? env.KUMI_WHISPER : undefined;
  const program = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const own = join(options.toolsDir, "whisper", program);
  if (existsSync(own)) return own;
  const found = onPath(program, env) ?? (process.platform === "darwin" ? ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"].find((path) => existsSync(path)) : undefined);
  if (found) return found;
  const asset = whisperAsset();
  if (!asset || options.installedOnly) return undefined;
  const get = options.download ?? download;
  const releases = JSON.parse(new TextDecoder().decode(await get(WHISPER_RELEASES, options.signal))) as { assets?: { name?: string; digest?: string; browser_download_url?: string }[] }[];
  const published = releases.flatMap((release) => release.assets ?? []).find((item) => item.name === asset && item.browser_download_url?.startsWith("https://github.com/"));
  const expected = /^sha256:([0-9a-f]{64})$/i.exec(published?.digest ?? "")?.[1];
  if (!published || !expected) return undefined;
  options.onFetch?.(`Kumi is fetching whisper.cpp, ${options.purpose ?? "which transcribes a video's speech when it has no captions"} (once).`);
  const archive = join(options.toolsDir, `.whisper-${randomUUID()}${asset.endsWith(".zip") ? ".zip" : ".tar.gz"}`);
  const unpacked = join(options.toolsDir, `.whisper-${randomUUID()}`);
  try {
    if ((await downloadTo(published.browser_download_url!, archive, options)) !== expected.toLowerCase()) throw new VideoError("The whisper.cpp Kumi downloaded didn't match its release's checksum, so it wasn't kept.");
    await mkdir(unpacked, { recursive: true, mode: 0o700 });
    // tar reads zip archives too (Windows has had it since 2018).
    await run("tar", ["-xf", archive, "-C", unpacked], { timeoutMs: 120_000, ...(options.signal ? { signal: options.signal } : {}) });
    const inside = (await readdir(unpacked, { recursive: true })).map(String).find((name) => name.split(/[\\/]/).at(-1) === program);
    if (!inside) return undefined;
    // The program and its libraries, as they came.
    await rm(join(options.toolsDir, "whisper"), { recursive: true, force: true });
    await rename(dirname(join(unpacked, inside)), join(options.toolsDir, "whisper"));
    if (process.platform !== "win32") await chmod(own, 0o755);
    return existsSync(own) ? own : undefined;
  } finally {
    await rm(archive, { force: true }); await rm(unpacked, { recursive: true, force: true });
  }
}

/** Where whisper.cpp's models are published (Hugging Face): its speech models, and its voice activity model. */
const WHISPER_MODELS = "ggerganov/whisper.cpp";
const VAD_MODELS = "ggml-org/whisper-vad";
/** whisper.cpp's voice activity model (Silero, under a megabyte). */
export const VAD_MODEL = "ggml-silero-v6.2.0.bin";

/**
 * A whisper.cpp speech model: KUMI_WHISPER_MODEL, or `name` (such as ggml-small.en-q5_1.bin)
 * fetched once into `toolsDir`, checked against the SHA-256 Hugging Face lists for it.
 */
export async function whisperModel(name: string, options: ProgramOptions): Promise<string> {
  const env = options.env ?? process.env;
  if (env.KUMI_WHISPER_MODEL) {
    if (!existsSync(env.KUMI_WHISPER_MODEL)) throw new VideoError(`KUMI_WHISPER_MODEL names ${env.KUMI_WHISPER_MODEL}, which isn't there.`);
    return env.KUMI_WHISPER_MODEL;
  }
  return publishedModel(WHISPER_MODELS, name, options);
}

/**
 * whisper.cpp's voice activity model, fetched once beside the speech models, without a word (it's
 * under a megabyte): with it, only stretches of speech are written down, never music or noise.
 */
export function vadModel(options: ProgramOptions): Promise<string> {
  const { onFetch: _onFetch, onProgress: _onProgress, ...quiet } = options;
  return publishedModel(VAD_MODELS, VAD_MODEL, quiet);
}

/** `name` from the Hugging Face repository `repo`, fetched once into `toolsDir`, checked against the SHA-256 it lists. */
async function publishedModel(repo: string, name: string, options: ProgramOptions): Promise<string> {
  if (!/^ggml-[a-z0-9._-]+\.bin$/.test(name)) throw new VideoError(`${name} isn't a whisper.cpp model's name.`);
  const path = join(options.toolsDir, "whisper-models", name);
  if (existsSync(path) && statSync(path).size > 0) return path;
  const get = options.download ?? download;
  const files = JSON.parse(new TextDecoder().decode(await get(`https://huggingface.co/api/models/${repo}/tree/main`, options.signal))) as { path?: string; size?: number; lfs?: { oid?: string } }[];
  const listed = files.find((file) => file.path === name);
  const expected = listed?.lfs?.oid;
  if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) throw new VideoError(`Kumi couldn't find the speech model ${name} to fetch.`);
  const full = await lowDisk(options.toolsDir, (listed?.size ?? 200 * MB) + 100 * MB, "Kumi keeps its programs on", options.free);
  if (full) throw new VideoError(`Transcribing needs a speech model, which Kumi would fetch. ${full}`);
  options.onFetch?.(`Kumi is fetching a speech model, ${options.purpose ?? "to transcribe videos without captions"} (once, about ${Math.round((listed?.size ?? 0) / 1e6)} MB).`);
  const temporary = join(dirname(path), `.${name}-${randomUUID()}`);
  try {
    if ((await downloadTo(`https://huggingface.co/${repo}/resolve/main/${name}`, temporary, options, listed?.size)) !== expected.toLowerCase()) throw new VideoError("The speech model Kumi downloaded didn't match its checksum, so it wasn't kept.");
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return path;
}
