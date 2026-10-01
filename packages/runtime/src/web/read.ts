/**
 * Reading an address: a page as text, a PDF, a text or code file, a GitHub repository or a file in
 * one, a Max patch or Max for Live device (its controls and gen~ code first), or a picture to look
 * at. Kumi reads it itself; a PDF, a page a browser builds with scripts, and a site that turns Kumi
 * away go through the free services' readers, in turn (free.ts). An address carrying a key or token
 * isn't read at all: every server that sees the address would get the key.
 */
import { decodeAmxd } from "../devices/amxd.js";
import { FREE_SERVICES, freeTrouble, NoFreeService, type FreeServices } from "./free.js";
import { githubTarget, rawUrl, readGithubTree } from "./github.js";
import { readHtml } from "./html.js";
import { carriesKey, checkedUrl, decodeText, statusWords, WebError, type WebClient, type WebResponse } from "./net.js";

export interface Page {
  /** The address as asked for (a github.com one, even when its raw text was read). */
  url: string;
  title?: string;
  /** What it is, in the producer's words: "a page", "a PDF", "code", "a GitHub repository"… */
  kind: string;
  text: string;
  /** Why it was read through a free service's reader ("it's a PDF"), when it was. */
  via?: string;
  /** Whose reader read it ("Exa", "Parallel"…), when one did. */
  reader?: string;
  /** There was more than Kumi reads of one address. */
  truncated?: boolean;
  /** A picture, shown to the model. */
  image?: { data: Buffer; mediaType: string };
  /** A repository's or folder's files. */
  files?: number;
}

const PICTURES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** The largest picture shown to the model, in bytes and pixels a side: what every provider takes. */
const MAX_PICTURE_BYTES = 3_500_000;
const MAX_PICTURE_SIDE = 7_000;

const CODE = /\.(c|h|cc|cpp|cxx|hh|hpp|hxx|inl|ino|m|mm|swift|rs|go|java|kt|scala|cs|fs|js|mjs|cjs|jsx|ts|tsx|py|rb|php|lua|pl|r|jl|dart|zig|nim|sh|bash|zsh|ps1|bat|cmake|mk|gradle|toml|ya?ml|ini|cfg|json|xml|gendsp|genexpr|maxpat|maxhelp|amxd|dsp|lib|sc|scd|ck|pd|csd|orc|sco|jsfx|eel|vhdl?|sv|asm|s|glsl|hlsl|wgsl|metal|cu|cl)$/i;

const sizeWords = (bytes: number) => bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** A file's name from its path, for a title. */
const fileName = (path: string) => { try { return decodeURIComponent(path.split("/").filter(Boolean).at(-1) ?? "") || undefined; } catch { return undefined; } };
/** Text has no NUL bytes; a binary file nearly always does, early. */
const binary = (body: Buffer) => body.subarray(0, 8192).includes(0);

/** A picture's size in pixels, from its header. */
export function pictureSize(data: Buffer, type: string): { width: number; height: number } | undefined {
  if (type === "image/png" && data.length >= 24 && data.toString("latin1", 12, 16) === "IHDR") return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (type === "image/gif" && data.length >= 10 && data.toString("latin1", 0, 3) === "GIF") return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (type === "image/webp" && data.length >= 30 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    const chunk = data.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") { const bits = data.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
    return undefined;
  }
  if (type === "image/jpeg" && data[0] === 0xff && data[1] === 0xd8) {
    let at = 2;
    while (at + 9 < data.length) {
      if (data[at] !== 0xff) return undefined;
      const marker = data[at + 1]!;
      if (marker === 0xff) { at++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
      // A start-of-frame segment holds the height, then the width.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
      at += 2 + data.readUInt16BE(at + 2);
    }
  }
  return undefined;
}

interface MaxBox {
  maxclass?: string; text?: string; code?: string; patcher?: MaxPatcher;
  saved_attribute_attributes?: { valueof?: { parameter_longname?: string; parameter_mmin?: number; parameter_mmax?: number; parameter_initial?: unknown; parameter_enum?: string[] } };
}
interface MaxPatcher { boxes?: { box?: MaxBox }[] }

/**
 * What a Max patch (or a device's) holds, before its JSON: the controls Live sees, the objects it's
 * made of, and the code in its codeboxes (gen~'s GenExpr), each as the text it is.
 */
export function maxPatchSummary(root: unknown): string | undefined {
  const top = (root as { patcher?: MaxPatcher } | undefined)?.patcher;
  if (!top || !Array.isArray(top.boxes)) return undefined;
  const controls: string[] = [];
  const code: { where: string; code: string }[] = [];
  const objects = new Map<string, number>();
  const walk = (patcher: MaxPatcher, where: string, depth: number) => {
    if (depth > 12) return;
    for (const entry of patcher.boxes ?? []) {
      const box = entry?.box;
      if (!box || typeof box !== "object") continue;
      const kind = typeof box.maxclass === "string" ? box.maxclass : "";
      if (kind === "codebox" && typeof box.code === "string") code.push({ where, code: box.code });
      else if (kind === "newobj" && typeof box.text === "string" && box.text.trim()) {
        const name = box.text.trim().split(/\s+/)[0]!;
        objects.set(name, (objects.get(name) ?? 0) + 1);
      }
      const value = box.saved_attribute_attributes?.valueof;
      if (value && typeof value.parameter_longname === "string" && kind.startsWith("live.")) {
        const range = Array.isArray(value.parameter_enum) ? value.parameter_enum.join(" / ")
          : value.parameter_mmin !== undefined || value.parameter_mmax !== undefined ? `${value.parameter_mmin ?? 0} to ${value.parameter_mmax ?? 127}` : "";
        controls.push(`${value.parameter_longname} (${kind}${range ? `, ${range}` : ""}${value.parameter_initial !== undefined ? `, starts at ${JSON.stringify(value.parameter_initial)}` : ""})`);
      }
      if (box.patcher && typeof box.patcher === "object") walk(box.patcher, typeof box.text === "string" && box.text.trim() ? `${where} › ${box.text.trim().split(/\s+/)[0]}` : where, depth + 1);
    }
  };
  walk(top, "the patch", 0);
  if (!controls.length && !code.length && !objects.size) return undefined;
  const lines: string[] = [];
  if (controls.length) lines.push(`Its controls: ${controls.join("; ")}.`);
  if (objects.size) lines.push(`Made of: ${[...objects].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ")}.`);
  for (const [index, block] of code.entries()) lines.push("", `Code ${index + 1} of ${code.length}, a codebox in ${block.where}:`, "```", block.code.replace(/\r\n?/g, "\n").trim(), "```");
  return lines.join("\n");
}

async function throughReader(client: WebClient, address: string, why: string, kind: string, signal: AbortSignal | undefined, services: FreeServices): Promise<Page> {
  const read = await services.first("read", (service) => service.read(client, address, signal), signal ? { signal } : {});
  return { url: address, ...(read.value.title ? { title: read.value.title } : {}), kind, text: read.value.text, via: why, reader: read.service.name };
}

function picture(url: string, response: WebResponse, title: string | undefined): Page {
  const size = pictureSize(response.body, response.contentType);
  const words = size ? `${size.width}×${size.height} pixels, ${sizeWords(response.body.length)}` : sizeWords(response.body.length);
  const base = { url, ...(title ? { title } : {}), kind: "a picture" };
  if (response.truncated || response.body.length > MAX_PICTURE_BYTES || !size || size.width > MAX_PICTURE_SIDE || size.height > MAX_PICTURE_SIDE || !size.width || !size.height) {
    return { ...base, text: `A picture (${words}), too large for Kumi to show.` };
  }
  return { ...base, text: `A picture, ${words}: it's shown to you after this.`, image: { data: response.body, mediaType: response.contentType } };
}

/** A Max patch: what it holds first, then all of it as JSON. */
function patch(url: string, value: unknown, kind: string, title: string | undefined, truncated: boolean): Page | undefined {
  const summary = maxPatchSummary(value);
  if (!summary) return undefined;
  return { url, ...(title ? { title } : {}), kind, text: `${summary}\n\nThe whole patch, as Max saves it:\n${JSON.stringify(value, null, 1)}`, ...(truncated ? { truncated: true } : {}) };
}

export async function readPage(client: WebClient, address: string, signal?: AbortSignal, services: FreeServices = FREE_SERVICES): Promise<Page> {
  if (carriesKey(address)) throw new WebError("That address carries what looks like a key or token, so Kumi won't read it: every server that sees an address gets what's in it. Read it without the key.");
  const url = checkedUrl(address);
  const target = githubTarget(url);
  if (target && target.kind !== "blob") {
    const listing = await readGithubTree(client, target, signal);
    return { url: url.href, title: listing.title, kind: target.kind === "repo" ? "a GitHub repository" : "a folder on GitHub", text: listing.text, files: listing.files };
  }
  const response = await client.fetch(target ? rawUrl(target) : url.href, { ...(signal ? { signal } : {}), wants: (type) => type !== "application/pdf" && !/^(video|audio)\//.test(type) });
  // The address to name it by: the github.com one for a file there, else where the redirects ended.
  const named = target ? url.href : response.url;
  const host = new URL(response.url).hostname;
  const path = target ? target.rest : new URL(response.url).pathname;
  if (response.skipped) {
    if (response.contentType === "application/pdf") return pdf(client, response.url, signal, services);
    throw new WebError(response.contentType.startsWith("video/") ? "That's a video: watch_video watches it." : "That's a sound file: listen hears one saved on this computer.");
  }
  if (response.status >= 400) {
    // A site that turns Kumi away (a sign-in wall, a bot check) may still let a reader service in.
    if (!target && [401, 403, 429, 503].includes(response.status)) {
      try { return await throughReader(client, named, `${host} ${statusWords(response.status)}`, "a page", signal, services); } catch { signal?.throwIfAborted(); }
    }
    throw new WebError(target && response.status === 404 ? `GitHub has no file there (${target.owner}/${target.repo}/${target.rest}).` : `Kumi couldn't read ${host}: ${statusWords(response.status)}.`, response.status);
  }
  const type = response.contentType;
  if (PICTURES.has(type)) return picture(named, response, fileName(path));
  if (type === "application/pdf" || response.body.subarray(0, 5).toString("latin1") === "%PDF-") return pdf(client, response.url, signal, services);
  const device = decodeAmxd(response.body);
  if (device) return patch(named, device.patcher, "a Max for Live device", fileName(path), response.truncated) ?? { url: named, kind: "a Max for Live device", text: JSON.stringify(device.patcher, null, 1) };
  if (binary(response.body)) throw new WebError(`That's a file of another kind (${type || "unnamed"}, ${sizeWords(response.body.length)}), not text Kumi can read.`);
  const text = decodeText(response.body, response.charset);
  const truncated = response.truncated ? { truncated: true } : {};
  if (type === "text/html" || type === "application/xhtml+xml" || (!type && /^\s*<(!doctype html|html)\b/i.test(text))) {
    const read = readHtml(text, response.url);
    if (read.scripted) {
      try { return await throughReader(client, named, "its page is built by scripts", "a page", signal, services); } catch { signal?.throwIfAborted(); }
    }
    const lead = read.description && !read.text.includes(read.description) ? `${read.description}\n\n` : "";
    return { url: named, ...(read.title ? { title: read.title } : {}), kind: "a page", text: `${lead}${read.text}`, ...truncated };
  }
  if (/json/.test(type) || /\.(maxpat|maxhelp|gendsp|json)$/i.test(path)) {
    try {
      const value = JSON.parse(text) as unknown;
      const read = patch(named, value, /\.gendsp$/i.test(path) ? "a gen~ patch" : "a Max patch", fileName(path), response.truncated);
      if (read) return read;
    } catch { /* not whole JSON: read as it is */ }
  }
  return { url: named, ...(fileName(path) ? { title: fileName(path)! } : {}), kind: CODE.test(path) ? "code" : "text", text, ...truncated };
}

async function pdf(client: WebClient, address: string, signal: AbortSignal | undefined, services: FreeServices): Promise<Page> {
  try { return await throughReader(client, address, "it's a PDF", "a PDF", signal, services); } catch (error) {
    signal?.throwIfAborted();
    const said = error instanceof NoFreeService ? freeTrouble(error) : error instanceof Error ? error.message.replace(/\.$/, "") : "it failed";
    throw new WebError(`Kumi reads a PDF through a free reader (${services.services.map((service) => service.name).join(", ")}), and none could read this one: ${said}.`);
  }
}
