/**
 * Catching up on a Set. Kumi keeps each saved Set's last state on this computer (the bridge's
 * privacy-redacted semantic snapshot) and, when it sees the Set again, says in plain words what
 * changed while it wasn't running. Nothing here changes Live.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatchUp, ConversationStore, JsonObject, SavedConversation } from "../../core/contracts.js";

/** A Set's state as Kumi last saw it. */
export interface Baseline {
  version: 1;
  /** The Set's file, which is what identifies it between sessions. */
  path: string;
  name: string;
  savedAt: number;
  artifactId: string;
  pages: JsonObject[];
}

export interface ProjectStore {
  load(path: string): Promise<Baseline | undefined>;
  save(baseline: Baseline): Promise<void>;
}

const MAX_BASELINE_BYTES = 8 * 1024 * 1024;

/** A saved Set's id for Kumi: a hash of its file path, which is also its folder's name. */
export const projectIdOf = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 32);

async function writePrivately(folder: string, name: string, text: string): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = join(folder, `.${name}-${randomUUID()}`);
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, join(folder, name));
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** One folder per saved Set, named by a hash of its path; files readable only by this user. */
export function createProjectStore(directory: string): ProjectStore {
  const folder = (path: string) => join(directory, projectIdOf(path));
  return {
    async load(path) {
      try {
        const text = await readFile(join(folder(path), "last-seen.json"), "utf8");
        if (Buffer.byteLength(text) > MAX_BASELINE_BYTES) return undefined;
        const value = JSON.parse(text) as Baseline;
        if (value?.version !== 1 || value.path !== path || !Array.isArray(value.pages) || !value.pages.length || typeof value.savedAt !== "number") return undefined;
        return value;
      } catch { return undefined; }
    },
    async save(baseline) {
      const text = JSON.stringify(baseline);
      if (Buffer.byteLength(text) > MAX_BASELINE_BYTES) return;
      await writePrivately(folder(baseline.path), "last-seen.json", text);
    },
  };
}

/** About 64k tokens: older exchanges drop off the front so a long-lived conversation stays quick. */
const MAX_CONVERSATION_BYTES = 256 * 1024;
const ID = /^[0-9a-f]{32}$/;

/** Each saved Set's conversation, next to its last-seen state; readable only by this user. */
export function createConversationStore(directory: string): ConversationStore {
  const file = (project: string) => { if (!ID.test(project)) throw new Error("invalid project id"); return join(directory, project, "conversation.json"); };
  return {
    async load(project) {
      try {
        const value = JSON.parse(await readFile(file(project), "utf8")) as SavedConversation;
        if (typeof value?.savedAt !== "number" || value.checkpoint?.version !== 1 || !Array.isArray(value.checkpoint.messages)) return undefined;
        return value;
      } catch { return undefined; }
    },
    async save(project, conversation) {
      const all = [...conversation.checkpoint.messages] as { role?: unknown }[];
      const size = (items: unknown[]) => Buffer.byteLength(JSON.stringify(items));
      // Drop whole exchanges from the front: the kept part starts where the producer spoke.
      let messages = all;
      while (messages.length && size(messages) > MAX_CONVERSATION_BYTES) {
        messages = messages.slice(1);
        while (messages.length && messages[0]!.role !== "user") messages = messages.slice(1);
      }
      // One very large exchange on its own is still kept (up to a hard limit), rather than nothing.
      if (!messages.length) {
        const last = all.map((message) => message.role).lastIndexOf("user");
        messages = last >= 0 && size(all.slice(last)) <= 4 * MAX_CONVERSATION_BYTES ? all.slice(last) : [];
      }
      if (!messages.length) return;
      const saved: SavedConversation = { savedAt: conversation.savedAt, checkpoint: { ...conversation.checkpoint, messages } };
      file(project);
      await writePrivately(join(directory, project), "conversation.json", JSON.stringify(saved));
    },
    async clear(project) { await rm(file(project), { force: true }); },
  };
}

type Row = { kind?: unknown; name?: unknown; order?: unknown; snapshotId?: unknown; data?: unknown };
const records = (pages: readonly JsonObject[]) => new Map(pages.flatMap((page) => (Array.isArray(page.records) ? page.records as Row[] : []))
  .filter((item) => typeof item?.snapshotId === "string").map((item) => [item.snapshotId as string, item]));
const quoted = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? `“${value.trim().slice(0, 60)}”` : fallback);
const KINDS: Readonly<Partial<Record<string, [string, string]>>> = { track: ["track", "tracks"], scene: ["scene", "scenes"], clip: ["clip", "clips"], device: ["device", "devices"], locator: ["locator", "locators"] };
/** Differences that only follow from another change (a renamed parent, a recomputed hash). */
const DERIVED = /\/(parentSnapshotId|structureHash|trackCount|sceneCount|clipCount|deviceCount)$|\/hash$/;

function named(kind: string, items: Row[], verb: string): string {
  const [one, many] = KINDS[kind] ?? [kind, `${kind}s`];
  const names = items.map((item) => quoted(item.name, "")).filter(Boolean);
  if (items.length === 1) return `${verb} ${one} ${names[0] ?? ""}`.trim();
  return names.length === items.length && items.length <= 3 ? `${verb} ${many} ${names.join(", ")}` : `${verb} ${items.length} ${many}`;
}

/**
 * The bridge's semantic diff in plain words, most telling first. Renames and edits the bridge
 * couldn't match (a removed and an added track in the same place) read as one change.
 */
export function describeDiff(diff: JsonObject, before: readonly JsonObject[], after: readonly JsonObject[], limit = 8): { lines: string[]; more: number } {
  const was = records(before); const now = records(after);
  const items = (Array.isArray(diff.items) ? diff.items : []) as JsonObject[];
  const lines: string[] = [];
  const added = new Map<string, Row[]>(); const removed = new Map<string, Row[]>();
  const edited = new Map<string, { record: Row; what: Set<string> }[]>();
  for (const item of items) {
    if (item.type === "ambiguity") { resolveAmbiguity(item, was, now, added, removed, lines); continue; }
    if (item.type !== "change" || !Array.isArray(item.facets)) continue;
    const kind = String(item.kind);
    const old = typeof item.beforeSnapshotId === "string" ? was.get(item.beforeSnapshotId) : undefined;
    const current = typeof item.afterSnapshotId === "string" ? now.get(item.afterSnapshotId) : undefined;
    const facets = item.facets as string[];
    if (facets.includes("added") && current) { added.set(kind, [...(added.get(kind) ?? []), current]); continue; }
    if (facets.includes("removed") && old) { removed.set(kind, [...(removed.get(kind) ?? []), old]); continue; }
    const details = (Array.isArray(item.details) ? item.details as JsonObject[] : []).filter((detail) => typeof detail.path === "string" && !DERIVED.test(detail.path));
    if (kind === "set") {
      for (const detail of details) {
        if (detail.path === "/data/tempo" && typeof detail.before === "number" && typeof detail.after === "number") lines.push(`Tempo ${detail.before} → ${detail.after} BPM`);
      }
      continue;
    }
    if (facets.includes("renamed") && old && current) lines.push(`Renamed ${KINDS[kind]?.[0] ?? kind} ${quoted(old.name, "(unnamed)")} → ${quoted(current.name, "(unnamed)")}`);
    const what = new Set(details.map((detail) => String(detail.path).split("/")[2] ?? "").filter(Boolean));
    if (what.size && (current ?? old)) edited.set(kind, [...(edited.get(kind) ?? []), { record: (current ?? old)!, what }]);
  }
  // A removed and an added item of the same kind in the same place: renamed and changed.
  for (const [kind, gone] of removed) {
    const fresh = added.get(kind) ?? [];
    for (const old of [...gone]) {
      const match = fresh.find((item) => item.order === old.order);
      if (!match) continue;
      lines.push(`${quoted(old.name, "An unnamed " + (KINDS[kind]?.[0] ?? kind))} → ${quoted(match.name, "(unnamed)")} (renamed and changed)`);
      gone.splice(gone.indexOf(old), 1); fresh.splice(fresh.indexOf(match), 1);
    }
  }
  for (const kind of Object.keys(KINDS)) {
    if (added.get(kind)?.length) lines.push(named(kind, added.get(kind)!, "Added"));
    if (removed.get(kind)?.length) lines.push(named(kind, removed.get(kind)!, "Removed"));
    const changes = edited.get(kind) ?? [];
    if (changes.length === 1) {
      const [only] = changes;
      const what = [...only!.what].map((key) => (key === "notes" ? "notes" : key === "mixer" ? "mixer" : key === "routing" ? "routing" : key)).join(", ");
      lines.push(`Changed ${KINDS[kind]?.[0] ?? kind} ${quoted(only!.record.name, "(unnamed)")}${what ? ` (${what})` : ""}`);
    } else if (changes.length > 1) lines.push(`Changed ${changes.length} ${KINDS[kind]?.[1] ?? `${kind}s`}`);
  }
  return { lines: lines.slice(0, limit), more: Math.max(0, lines.length - limit) };
}

/**
 * The bridge can't match look-alike items (empty tracks, say) and reports them as one group. Read
 * it the way a person would: the same name is the same item, the same place with a new name is a
 * rename, and the rest were added or removed.
 */
function resolveAmbiguity(item: JsonObject, was: Map<string, Row>, now: Map<string, Row>, added: Map<string, Row[]>, removed: Map<string, Row[]>, lines: string[]): void {
  const kind = String(item.kind);
  if (!KINDS[kind]) return;
  const pick = (ids: unknown, from: Map<string, Row>) => (Array.isArray(ids) ? ids : []).map((id) => from.get(String(id))).filter((row): row is Row => Boolean(row));
  const olds = pick(item.beforeSnapshotIds, was); const news = pick(item.afterSnapshotIds, now);
  for (const old of [...olds]) {
    const same = news.find((row) => row.name === old.name);
    if (same) { olds.splice(olds.indexOf(old), 1); news.splice(news.indexOf(same), 1); }
  }
  for (const old of [...olds]) {
    const same = news.find((row) => row.order === old.order);
    if (!same) continue;
    lines.push(`Renamed ${KINDS[kind]![0]} ${quoted(old.name, "(unnamed)")} → ${quoted(same.name, "(unnamed)")}`);
    olds.splice(olds.indexOf(old), 1); news.splice(news.indexOf(same), 1);
  }
  if (news.length) added.set(kind, [...(added.get(kind) ?? []), ...news]);
  if (olds.length) removed.set(kind, [...(removed.get(kind) ?? []), ...olds]);
}

/** "3 days ago" style, for the catch-up heading. */
export function since(savedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - savedAt) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function catchUpFrom(name: string, baseline: Baseline, described: { lines: string[]; more: number }): CatchUp {
  return { set: name, lastSeenAt: baseline.savedAt, lines: described.lines, more: described.more };
}
