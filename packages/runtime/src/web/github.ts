/**
 * GitHub, read the way a developer reads it: a repository (or a folder of one) as its files and its
 * README, a file as its raw text. The API is used without signing in, which allows 60 reads an
 * hour; files come from raw.githubusercontent.com, which doesn't count against that.
 */
import { decodeText, statusWords, WebError, type WebClient, type WebResponse } from "./net.js";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_RAW = "https://raw.githubusercontent.com";

/** Past this many files, a listing shows a folder at a time. */
const MAX_LISTED = 400;

/** First path segments on github.com that aren't owners. */
const NOT_OWNERS = new Set(["about", "apps", "codespaces", "collections", "contact", "copilot", "customer-stories", "enterprise", "events", "explore", "features", "issues",
  "login", "marketplace", "new", "notifications", "organizations", "orgs", "pricing", "pulls", "readme", "resources", "search", "security", "settings", "site", "sponsors",
  "team", "topics", "trending", "users"]);

export type GithubTarget =
  | { kind: "repo"; owner: string; repo: string }
  /** A folder: `rest` is the ref, then the folder's path ("main/src/dsp"). */
  | { kind: "tree"; owner: string; repo: string; rest: string }
  /** A file: `rest` is the ref, then the file's path. */
  | { kind: "blob"; owner: string; repo: string; rest: string };

/** What a github.com address names, when it's a repository, a folder or a file in one. */
export function githubTarget(address: URL): GithubTarget | undefined {
  if (address.hostname !== "github.com" && address.hostname !== "www.github.com") return undefined;
  let parts: string[];
  try { parts = address.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); } catch { return undefined; }
  const [owner, named, kind, ...rest] = parts;
  if (!owner || !named || NOT_OWNERS.has(owner.toLowerCase())) return undefined;
  const repo = named.replace(/\.git$/, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return undefined;
  if (kind === undefined) return { kind: "repo", owner, repo };
  if (kind === "tree" && rest.length) return { kind: "tree", owner, repo, rest: rest.join("/") };
  if ((kind === "blob" || kind === "raw") && rest.length >= 2) return { kind: "blob", owner, repo, rest: rest.join("/") };
  // Issues, pull requests, releases, the wiki: pages like any other.
  return undefined;
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** A file's raw address: GitHub's raw host takes the ref and the path as the page had them. */
export function rawUrl(target: { owner: string; repo: string; rest: string }): string {
  return `${GITHUB_RAW}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${encodePath(target.rest)}`;
}

function header(response: WebResponse, name: string): string | undefined {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function api<T>(client: WebClient, path: string, signal: AbortSignal | undefined): Promise<{ status: number; value?: T }> {
  const response = await client.fetch(`${GITHUB_API}${path}`, { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, maxBytes: 24 * 1024 * 1024, ...(signal ? { signal } : {}) });
  if (response.status === 200) {
    try { return { status: 200, value: JSON.parse(response.body.toString("utf8")) as T }; } catch { throw new WebError("GitHub answered in a way Kumi doesn't follow."); }
  }
  if ((response.status === 403 || response.status === 429) && header(response, "x-ratelimit-remaining") === "0") {
    const reset = Number(header(response, "x-ratelimit-reset")) * 1000;
    const when = Number.isFinite(reset) && reset > Date.now() ? new Date(reset).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "later this hour";
    throw new WebError(`GitHub allows 60 reads an hour without signing in, and they're used up until ${when}. A file can still be read by its own address (github.com/…/blob/…), which doesn't count.`, response.status);
  }
  return { status: response.status };
}

interface Repo {
  full_name?: string; description?: string | null; default_branch?: string; stargazers_count?: number; language?: string | null;
  license?: { spdx_id?: string | null } | null; homepage?: string | null; archived?: boolean; fork?: boolean; pushed_at?: string;
}
interface Tree { tree?: { path?: string; type?: string; size?: number }[]; truncated?: boolean }

export interface Listing {
  title: string;
  text: string;
  files: number;
}

const size = (bytes: number | undefined) => bytes === undefined ? "" : bytes < 1024 ? ` (${bytes} B)` : bytes < 1024 * 1024 ? ` (${Math.round(bytes / 1024)} KB)` : ` (${(bytes / 1024 / 1024).toFixed(1)} MB)`;
const junk = (path: string) => /(^|\/)(\.DS_Store|__MACOSX|Thumbs\.db)(\/|$)/.test(path);

/** A repository, or a folder in one: what it is, its files, then its README. */
export async function readGithubTree(client: WebClient, target: Extract<GithubTarget, { kind: "repo" | "tree" }>, signal?: AbortSignal): Promise<Listing> {
  const base = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const repo = await api<Repo>(client, base, signal);
  if (repo.status === 404) throw new WebError(`GitHub has no public repository ${target.owner}/${target.repo} (it may be private, renamed or misspelled).`, 404);
  if (!repo.value) throw new WebError(`GitHub ${statusWords(repo.status)}.`, repo.status);
  const info = repo.value;
  const name = info.full_name ?? `${target.owner}/${target.repo}`;
  // A folder's address holds its ref and path, and a ref can have slashes: the shortest ref GitHub knows wins.
  const segments = target.kind === "tree" ? target.rest.split("/") : [info.default_branch ?? "HEAD"];
  let tree: Tree | undefined;
  let ref = segments[0]!;
  let folder = "";
  for (let cut = 1; cut <= Math.min(3, segments.length); cut++) {
    ref = segments.slice(0, cut).join("/");
    folder = segments.slice(cut).join("/");
    const found = await api<Tree>(client, `${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`, signal);
    if (found.value) { tree = found.value; break; }
    if (found.status === 409) throw new WebError(`${name} is empty.`, 409);
    if (found.status !== 404 && found.status !== 422) throw new WebError(`GitHub ${statusWords(found.status)}.`, found.status);
  }
  if (!tree) throw new WebError(`${name} has no branch or tag ${JSON.stringify(segments[0])}.`, 404);
  const prefix = folder ? `${folder.replace(/\/$/, "")}/` : "";
  const entries = (tree.tree ?? []).filter((entry) => typeof entry.path === "string" && entry.path.startsWith(prefix) && entry.path !== folder && !junk(entry.path))
    .map((entry) => ({ path: entry.path!.slice(prefix.length), type: entry.type ?? "blob", size: entry.size }));
  if (folder && !entries.length) throw new WebError(`${name} has no folder ${folder} on ${ref}.`, 404);
  const files = entries.filter((entry) => entry.type === "blob");
  const lines: string[] = [];
  const about = [info.description?.trim(), info.stargazers_count !== undefined ? `${info.stargazers_count} stars` : undefined, info.language ?? undefined,
    info.license?.spdx_id && info.license.spdx_id !== "NOASSERTION" ? `license ${info.license.spdx_id}` : undefined, info.homepage ? `homepage ${info.homepage}` : undefined,
    `${ref === info.default_branch ? "default branch" : "ref"} ${ref}`, info.pushed_at ? `last changed ${info.pushed_at.slice(0, 10)}` : undefined,
    info.archived ? "archived" : undefined, info.fork ? "a fork" : undefined].filter(Boolean);
  lines.push(`GitHub repository ${name}${folder ? `, folder ${folder}` : ""}: ${about.join(" · ")}`);
  const blobBase = `https://github.com/${name}/blob/${ref}/${prefix}`;
  lines.push("", `Read a file with read_web and its address, ${blobBase}<path>; a folder with https://github.com/${name}/tree/${ref}/${prefix}<folder>.`);
  if (files.length <= MAX_LISTED) {
    lines.push("", `Files (${files.length}):`);
    for (const entry of entries) {
      if (entry.type === "blob") lines.push(`${entry.path}${size(entry.size)}`);
      else if (entry.type === "commit") lines.push(`${entry.path}/ (another repository, linked in)`);
    }
  } else {
    // Too many to list: the folder's own files, and each folder in it with how many it holds.
    const counts = new Map<string, number>();
    const own: string[] = [];
    for (const entry of files) {
      const slash = entry.path.indexOf("/");
      if (slash === -1) own.push(`${entry.path}${size(entry.size)}`);
      else counts.set(entry.path.slice(0, slash), (counts.get(entry.path.slice(0, slash)) ?? 0) + 1);
    }
    lines.push("", `${files.length} files, too many to list at once; the folders, and the files at the top:`);
    for (const [dir, count] of counts) lines.push(`${dir}/ (${count} files)`);
    lines.push(...own);
  }
  if (tree.truncated) lines.push("(GitHub listed only part of a repository this large; read a folder for the rest.)");
  const readme = entries.filter((entry) => entry.type === "blob" && /^readme(\.(md|markdown|txt|rst|org))?$/i.test(entry.path))
    .sort((a, b) => Number(!/\.md$/i.test(a.path)) - Number(!/\.md$/i.test(b.path)))[0];
  if (readme) {
    const response = await client.fetch(rawUrl({ owner: target.owner, repo: target.repo, rest: `${ref}/${prefix}${readme.path}` }), { maxBytes: 512 * 1024, ...(signal ? { signal } : {}) }).catch((error: unknown) => {
      signal?.throwIfAborted();
      return error instanceof WebError ? undefined : Promise.reject(error);
    });
    if (response?.status === 200) lines.push("", `${readme.path}:`, "", decodeText(response.body, response.charset).trim());
  }
  return { title: `${name}${folder ? `/${folder}` : ""}`, text: lines.join("\n"), files: files.length };
}

export interface RepoFound { name: string; url: string; description?: string; stars?: number; language?: string; updated?: string }

/** GitHub's repository search, best match first. */
export async function searchGithub(client: WebClient, query: string, count: number, signal?: AbortSignal): Promise<RepoFound[]> {
  const found = await api<{ items?: { full_name?: string; html_url?: string; description?: string | null; stargazers_count?: number; language?: string | null; pushed_at?: string }[] }>(
    client, `/search/repositories?q=${encodeURIComponent(query)}&per_page=${count}`, signal);
  if (!found.value) throw new WebError(found.status === 422 ? "GitHub couldn't search for that; try other words." : `GitHub's search ${statusWords(found.status)}.`, found.status);
  return (found.value.items ?? []).filter((item) => item.full_name && item.html_url).map((item) => ({ name: item.full_name!, url: item.html_url!,
    ...(item.description ? { description: item.description } : {}), ...(item.stargazers_count !== undefined ? { stars: item.stargazers_count } : {}),
    ...(item.language ? { language: item.language } : {}), ...(item.pushed_at ? { updated: item.pushed_at.slice(0, 10) } : {}) }));
}
