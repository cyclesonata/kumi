import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEvent } from "../src/core/contracts.js";
import { chooseMoments, formatTime, parseCaptions, parseTime, transcriptLines } from "../src/video/index.js";
import { saidAround } from "../src/video/captions.js";
import { ffmpegAsset, findFfmpeg, findYtDlp, whisperAsset, whisperModel, ytDlpAsset } from "../src/video/programs.js";
import { cuesFromWhisper, speechModelFor } from "../src/video/speech.js";
import { systemProgram } from "../src/system.js";
import { publicAddress, watchVideo, youtubeId } from "../src/video/index.js";
import { videoTools, WATCH_VIDEO_TOOL } from "../src/video/tool.js";

const folder = mkdtempSync(join(tmpdir(), "kumi-video-test-"));
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));
const ffmpeg = await findFfmpeg();
const needsFfmpeg = !ffmpeg && "ffmpeg makes the test video";

test("times read as a producer writes them, and are said back the same way", () => {
  assert.equal(parseTime("2:05"), 125);
  assert.equal(parseTime("1:02:03"), 3723);
  assert.equal(parseTime("90"), 90);
  assert.equal(parseTime(12.5), 12.5);
  assert.equal(parseTime("0:07.5"), 7.5);
  for (const bad of ["", "soon", "2:75:00x", -1, Number.NaN, null, {}]) assert.equal(parseTime(bad), undefined, String(bad));
  assert.equal(formatTime(125), "2:05");
  assert.equal(formatTime(3723), "1:02:03");
  assert.equal(formatTime(-3), "0:00");
});

test("a YouTube address names its video before anything is read", () => {
  assert.equal(youtubeId("https://www.youtube.com/watch?v=W87uuuGcq9c"), "W87uuuGcq9c");
  assert.equal(youtubeId("https://youtu.be/W87uuuGcq9c?t=30"), "W87uuuGcq9c");
  assert.equal(youtubeId("https://www.youtube.com/watch?list=x&v=W87uuuGcq9c"), "W87uuuGcq9c");
  assert.equal(youtubeId("https://www.youtube.com/shorts/W87uuuGcq9c"), "W87uuuGcq9c");
  assert.equal(youtubeId("https://vimeo.com/12345"), undefined);
});

test("Kumi fetches a page's streams and captions only from public addresses, never this computer or a private network", () => {
  for (const good of ["https://rr3---sn-abc.googlevideo.com/videoplayback?x=1", "https://www.youtube.com/api/timedtext?v=x", "http://8.8.8.8/a", "https://[2001:4860::8888]/a"]) assert.equal(publicAddress(good), true, good);
  for (const bad of ["file:///etc/passwd", "http://localhost:8080/", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.20.0.1/", "http://169.254.169.254/latest",
    "http://[::1]/", "http://[fd00::1]/", "http://router.local/", "http://intranet/", "concat:a|b", "ftp://example.com/x", "http://0.0.0.0/"]) assert.equal(publicAddress(bad), false, bad);
});

test("captions from YouTube's json3, WebVTT (rolling repeats dropped) and SRT become timed lines without markup or sound tags", () => {
  const json3 = JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "load " }, { utf8: "Operator" }] },
    { tStartMs: 500, dDurationMs: 100 },
    { tStartMs: 2100, dDurationMs: 1500, segs: [{ utf8: "set voices to one [Music]" }] },
  ] });
  assert.deepEqual(parseCaptions(json3, "json3"), [{ start: 0, end: 2, text: "load Operator" }, { start: 2.1, end: 3.6, text: "set voices to one" }]);
  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<c>crank the</c> drive\n\n00:00:03.000 --> 00:00:05.000\ncrank the drive\nset it to &quot;hard curve&quot;\n";
  assert.deepEqual(parseCaptions(vtt, "vtt"), [{ start: 1, end: 3, text: "crank the drive" }, { start: 3, end: 5, text: "set it to \"hard curve\"" }]);
  const srt = "1\n00:01:00,500 --> 00:01:02,000\nthen add a Saturator\n\n2\n00:00:59,000 --> 00:01:00,000\nfirst\n";
  assert.deepEqual(parseCaptions(srt, "srt").map((cue) => cue.start), [59, 60.5]);
  assert.deepEqual(parseCaptions("not json", "json3"), []);
});

test("cues join into sentences, a new line at a pause, within the stretch asked for", () => {
  const cues = [
    { start: 0, end: 1, text: "load Operator." }, { start: 1, end: 2, text: "set voices to one." },
    { start: 6, end: 7, text: "then a Saturator" }, { start: 7, end: 8, text: "with the drive up" },
    { start: 30, end: 31, text: "later" },
  ];
  assert.deepEqual(transcriptLines(cues), [
    { at: 0, text: "load Operator. set voices to one." }, { at: 6, text: "then a Saturator with the drive up" }, { at: 30, text: "later" }]);
  assert.deepEqual(transcriptLines(cues, { from: 5, to: 10 }).map((line) => line.at), [6]);
  assert.equal(saidAround(cues, 7), "then a Saturator with the drive up");
});

test("moments are where the narration names a device, a setting or a value, spread out, with chapter starts, and filled when there's little said", () => {
  const cues = [
    { start: 5, end: 8, text: "hey everyone welcome back" },
    { start: 20, end: 24, text: "load Operator and set the coarse to 1" },
    { start: 21, end: 25, text: "and the fine all the way" },
    { start: 60, end: 64, text: "then a Saturator, drive to 12 dB, like this" },
    { start: 100, end: 104, text: "thanks for watching" },
  ];
  const moments = chooseMoments(cues, { from: 0, to: 120, count: 3 });
  assert.equal(moments.length, 3);
  assert.ok(moments.some((at) => at > 60 && at < 64), `the Saturator moment: ${moments}`);
  assert.ok(moments.some((at) => at > 20 && at < 24), `the Operator moment: ${moments}`);
  assert.ok(moments.every((at, index) => index === 0 || at - moments[index - 1]! >= 4), `spread: ${moments}`);
  const chaptered = chooseMoments([], { from: 0, to: 120, count: 2, chapters: [{ start: 40, title: "Filter" }] });
  assert.ok(chaptered.includes(43), `a chapter's start: ${chaptered}`);
  assert.equal(chooseMoments([], { from: 0, to: 60, count: 6 }).length, 6);
  assert.deepEqual(chooseMoments(cues, { from: 10, to: 10, count: 4 }), []);
  assert.ok(chooseMoments(cues, { from: 50, to: 70, count: 4 }).every((at) => at >= 50 && at <= 70));
});

test("whisper.cpp's output becomes timed lines, without its music and silence marks", () => {
  const json = JSON.stringify({ transcription: [
    { offsets: { from: 0, to: 6480 }, text: " Load Operator.  Set voices to 1," },
    { offsets: { from: 6480, to: 9000 }, text: " [MUSIC]" },
    { offsets: { from: 9000, to: 12000 }, text: " (upbeat music)" },
    { offsets: { from: 12000 }, text: "no end" },
  ] });
  assert.deepEqual(cuesFromWhisper(json), [{ start: 0, end: 6.48, text: "Load Operator. Set voices to 1," }]);
  assert.deepEqual(cuesFromWhisper("{"), []);
  assert.equal(speechModelFor("en"), "ggml-small.en-q5_1.bin");
  assert.equal(speechModelFor(undefined), "ggml-small.en-q5_1.bin");
  assert.equal(speechModelFor("de"), "ggml-small-q5_1.bin");
});

test("Kumi fetches the build each computer has: yt-dlp's quick-starting one, whisper.cpp where it's published", () => {
  assert.equal(ytDlpAsset("darwin", "arm64"), "yt-dlp_macos.zip");
  assert.equal(ytDlpAsset("win32", "x64"), "yt-dlp_win.zip");
  assert.equal(ytDlpAsset("win32", "arm64"), "yt-dlp_win_arm64.zip");
  assert.equal(ytDlpAsset("linux", "x64"), "yt-dlp_linux");
  assert.equal(ytDlpAsset("freebsd", "x64"), undefined);
  assert.equal(whisperAsset("win32", "x64"), "whisper-bin-x64.zip");
  assert.equal(whisperAsset("linux", "arm64"), "whisper-bin-ubuntu-arm64.tar.gz");
  assert.equal(whisperAsset("darwin", "arm64"), undefined);
});

test("a download that doesn't match its published checksum isn't kept", async () => {
  const toolsDir = join(folder, "tools-mismatch");
  const asset = ytDlpAsset();
  if (!asset) return;
  const download = async (url: string) => (url.endsWith("SHA2-256SUMS") ? new TextEncoder().encode(`${"0".repeat(64)}  ${asset}\n`) : new TextEncoder().encode("not yt-dlp"));
  // With no yt-dlp on the PATH, Kumi fetches one; this one's checksum is wrong.
  await assert.rejects(findYtDlp({ toolsDir, download, env: { PATH: "" } }), /didn't match/);
  assert.deepEqual(existsSync(toolsDir) ? readdirSync(toolsDir) : [], []);
  const model = new TextEncoder().encode("a speech model");
  const sha = createHash("sha256").update(model).digest("hex");
  const tree = (oid: string) => async (url: string) => (url.includes("/api/models/") ? new TextEncoder().encode(JSON.stringify([{ path: "ggml-tiny.en.bin", size: model.length, lfs: { oid } }])) : model);
  await assert.rejects(whisperModel("ggml-tiny.en.bin", { toolsDir, download: tree("f".repeat(64)), env: {}, free: async () => 1e12 }), /didn't match/);
  assert.deepEqual(readdirSync(join(toolsDir, "whisper-models")), []);
  const fetched: string[] = [];
  const path = await whisperModel("ggml-tiny.en.bin", { toolsDir, download: tree(sha), env: {}, free: async () => 1e12, onFetch: (message) => fetched.push(message) });
  assert.equal(readFileSync(path, "utf8"), "a speech model");
  assert.equal(fetched.length, 1);
  // Kept: asked again, nothing is fetched.
  assert.equal(await whisperModel("ggml-tiny.en.bin", { toolsDir, download: async () => { throw new Error("fetched again"); }, env: {} }), path);
  await assert.rejects(whisperModel("../escape.bin", { toolsDir, env: {} }), /isn't a whisper.cpp model/);
  await assert.rejects(findYtDlp({ toolsDir, env: { KUMI_YTDLP: join(folder, "nowhere") } }), /isn't there/);
});

/** A 12-second test video: a moving test picture and a tone, with captions beside it. */
function testVideo(name: string, captions = true): string {
  const path = join(folder, `${name}.mp4`);
  execFileSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10:duration=12", "-f", "lavfi", "-i", "sine=frequency=110:duration=12",
    "-c:v", "mpeg4", "-c:a", "aac", "-shortest", "-y", path]);
  if (captions) {
    writeFileSync(join(folder, `${name}.srt`), "1\n00:00:01,000 --> 00:00:03,000\nload Operator and set the coarse to 1\n\n2\n00:00:06,000 --> 00:00:08,000\nthen a Saturator, drive all the way, like this\n");
  }
  return path;
}

test("watching a video file: its captions, frames at the moments that matter, a close-up, its sound, all kept for next time", { skip: needsFfmpeg }, async () => {
  const video = testVideo("tutorial");
  const videosDir = join(folder, "videos"); const toolsDir = join(folder, "tools");
  const progress: string[] = [];
  const watched = await watchVideo({ url: video, frames: 3, listen: { from: 2, to: 4 } }, { videosDir, toolsDir, onProgress: (text) => progress.push(text) });
  assert.equal(watched.title, "tutorial");
  assert.ok(Math.abs((watched.duration ?? 0) - 12) < 0.5, `duration ${watched.duration}`);
  assert.deepEqual(watched.words, { language: "", source: "captions" });
  assert.deepEqual(watched.lines.map((line) => line.at), [1, 6]);
  assert.equal(watched.frames.length, 3);
  for (const frame of watched.frames) {
    assert.deepEqual([...frame.jpeg.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([frame.thumb.width, frame.thumb.height, frame.thumb.rgb.length], [32, 18, 32 * 18 * 3]);
  }
  assert.ok(watched.frames.some((frame) => frame.said.includes("Saturator")));
  assert.ok(watched.sound && existsSync(watched.sound.file) && watched.sound.from === 2 && watched.sound.to === 4);
  assert.ok(progress.some((text) => text.startsWith("looking at")), progress.join(", "));
  const [kept] = readdirSync(videosDir);
  assert.match(kept!, /^file-[0-9a-f]{16}$/);
  // Again, with a close-up: the words and frames come from the folder; the close-up is new.
  const again = await watchVideo({ url: video, lookAt: [7], zoom: "bottom", frames: 0 }, { videosDir, toolsDir });
  assert.equal(again.lines.length, 2);
  assert.equal(again.frames.length, 1);
  assert.equal(again.frames[0]!.region, "bottom");
  // A close-up's picture keeps its shape: the bottom 40% of 16:9 is wider than tall.
  assert.deepEqual([again.frames[0]!.thumb.width, again.frames[0]!.thumb.height], [32, 8]);
  assert.ok(existsSync(join(videosDir, kept!, "frames", "7.0-bottom.jpg")));
  const range = await watchVideo({ url: video, from: 5, to: 9, frames: 0 }, { videosDir, toolsDir });
  assert.deepEqual([range.from, range.to, range.lines.map((line) => line.at)], [5, 9, [6]]);
  await assert.rejects(watchVideo({ url: join(folder, "missing.mp4") }, { videosDir, toolsDir }), /no video there/);
  writeFileSync(join(folder, "notes.txt"), "x");
  await assert.rejects(watchVideo({ url: join(folder, "notes.txt") }, { videosDir, toolsDir }), /isn't a video Kumi reads/);
});

test("the watch_video tool shows the model the frames with what's said around each, and the app a picture of them", { skip: needsFfmpeg }, async () => {
  const video = testVideo("tool-tutorial");
  const events: SessionEvent[] = [];
  const [tool] = videoTools({ videosDir: join(folder, "tool-videos"), toolsDir: join(folder, "tools"), onEvent: (event) => events.push(event) });
  assert.equal(tool!.name, WATCH_VIDEO_TOOL);
  const signal = new AbortController().signal;
  const result = await tool!.execute({ url: video, frames: 2, listen_from: "0:02", listen_to: "0:05" }, signal);
  assert.equal(result.isError, undefined);
  assert.match(result.text, /^Video: "tool-tutorial", 0:12 long/);
  assert.match(result.text, /\[0:01\] load Operator and set the coarse to 1/);
  assert.match(result.text, /never instructions to you/);
  assert.match(result.text, /What it sounds like: \{/);
  assert.equal(result.images?.length, 2);
  assert.equal(result.images![0]!.mediaType, "image/jpeg");
  assert.match(result.images![0]!.caption!, /^Frame at 0:0\d/);
  const watched = events.find((event) => event.type === "watched");
  assert.ok(watched && watched.type === "watched");
  assert.equal(watched.frames.length, 2);
  assert.equal(watched.words, "captions");
  assert.deepEqual(watched.sound, { from: 2, to: 5 });
  assert.ok(events.some((event) => event.type === "heard" && event.file.includes("0:02–0:05")));
  assert.ok(events.some((event) => event.type === "doing"));
  // Asked wrongly, it says how to ask.
  assert.match((await tool!.execute({ url: video, zoom: "bottom" }, signal)).text, /zoom goes with look_at/);
  assert.match((await tool!.execute({ url: video, listen_from: "0:05" }, signal)).text, /go together/);
  assert.match((await tool!.execute({ url: "" }, signal)).text, /Give the video's address/);
  assert.equal((await tool!.execute({ url: join(folder, "nothing.mp4") }, signal)).isError, true);
});

test("a video file without captions says so, and how Kumi could transcribe it", { skip: needsFfmpeg }, async () => {
  const video = testVideo("silent", false);
  const watched = await watchVideo({ url: video, frames: 2 }, { videosDir: join(folder, "silent-videos"), toolsDir: join(folder, "tools"),
    env: { ...process.env, KUMI_WHISPER: join(folder, "no-whisper") } });
  assert.equal(watched.lines.length, 0);
  assert.equal(watched.frames.length, 2);
  assert.match(watched.notes.join(" "), /no captions beside it/);
  assert.match(watched.notes.join(" "), /whisper\.cpp/);
  mkdirSync(join(folder, "silent-videos"), { recursive: true });
});

test("ffmpeg's build for this computer is the newest numbered LGPL one; a Mac and unknown machines get none", () => {
  const names = ["ffmpeg-master-latest-win64-lgpl.zip", "ffmpeg-n8.1-latest-win64-lgpl-8.1.zip", "ffmpeg-n9.0-latest-win64-lgpl-9.0.zip", "ffmpeg-n9.0-latest-win64-gpl-9.0.zip",
    "ffmpeg-n9.0-latest-winarm64-lgpl-9.0.zip", "ffmpeg-n10.0-latest-linux64-lgpl-10.0.tar.xz", "ffmpeg-n9.0-latest-linuxarm64-lgpl-9.0.tar.xz", "ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip"];
  assert.equal(ffmpegAsset(names, "win32", "x64"), "ffmpeg-n9.0-latest-win64-lgpl-9.0.zip");
  assert.equal(ffmpegAsset(names, "win32", "arm64"), "ffmpeg-n9.0-latest-winarm64-lgpl-9.0.zip");
  assert.equal(ffmpegAsset(names, "linux", "x64"), "ffmpeg-n10.0-latest-linux64-lgpl-10.0.tar.xz");
  assert.equal(ffmpegAsset(names, "linux", "arm64"), "ffmpeg-n9.0-latest-linuxarm64-lgpl-9.0.tar.xz");
  assert.equal(ffmpegAsset(names, "darwin", "arm64"), undefined);
  assert.equal(ffmpegAsset(names, "win32", "ia32"), undefined);
});

test("off a Mac, ffmpeg is fetched once into Kumi's folder, checked against its release's checksum, only the program kept", async () => {
  const root = mkdtempSync(join(tmpdir(), "kumi-ffmpeg-"));
  try {
    const build = join(root, "build", "ffmpeg-n9.0-latest-linux64-lgpl-9.0");
    mkdirSync(join(build, "bin"), { recursive: true });
    writeFileSync(join(build, "bin", "ffmpeg"), "#!/bin/sh\necho ffmpeg version fixture\n"); writeFileSync(join(build, "bin", "ffprobe"), "x"); writeFileSync(join(build, "LICENSE.txt"), "LGPL");
    const archive = join(root, "build.tar.gz");
    execFileSync(systemProgram("tar"), ["-czf", archive, "-C", join(root, "build"), "ffmpeg-n9.0-latest-linux64-lgpl-9.0"]);
    const data = readFileSync(archive);
    const asset = "ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz";
    const release = (digest: string) => new TextEncoder().encode(JSON.stringify({ assets: [{ name: asset, size: 141_000_000, digest, browser_download_url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${asset}` }] }));
    const sha = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    const asked: string[] = []; const said: string[] = [];
    const download = async (url: string) => { asked.push(url); return url.startsWith("https://api.github.com/") ? release(sha) : new Uint8Array(data); };
    const toolsDir = join(root, "tools");
    // Room on the disk, whatever this computer's is.
    const options = { env: {}, toolsDir, platform: "linux", arch: "x64", download, onFetch: (message: string) => said.push(message), free: async () => 1e12 };
    assert.equal(await findFfmpeg({ ...options, installedOnly: true }), undefined, "the doctor fetches nothing");
    assert.equal(asked.length, 0);
    const found = await findFfmpeg(options);
    assert.equal(found, join(toolsDir, "ffmpeg", "ffmpeg"));
    assert.deepEqual(readdirSync(join(toolsDir, "ffmpeg")), ["ffmpeg"], "only the program");
    if (process.platform !== "win32") assert.equal(statSync(found!).mode & 0o111, 0o111);
    assert.deepEqual(said, ["Kumi is fetching ffmpeg, which it reads audio formats and videos with (once, about 141 MB)."]);
    assert.equal(asked.length, 2);
    assert.equal(await findFfmpeg(options), found, "fetched once");
    assert.equal(asked.length, 2);
    // A download that doesn't match what the release lists isn't kept.
    const other = join(root, "other");
    await assert.rejects(findFfmpeg({ ...options, toolsDir: other, download: async (url: string) => (url.startsWith("https://api.github.com/") ? release(`sha256:${"0".repeat(64)}`) : new Uint8Array(data)) }), /didn't match its release's checksum/);
    assert.equal(existsSync(join(other, "ffmpeg")), false);
    assert.deepEqual(readdirSync(other), [], "nothing left behind");
    // A disk without room for it says so, and nothing is fetched.
    const before = asked.length;
    await assert.rejects(findFfmpeg({ ...options, toolsDir: join(root, "third"), free: async () => 150_000_000 }), /Kumi needs ffmpeg for this, and would fetch it\. Only 150 MB is free on the disk Kumi keeps its programs on/);
    assert.equal(asked.length, before + 1, "only the release was looked at");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
