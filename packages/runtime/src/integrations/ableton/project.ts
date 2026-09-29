/**
 * Catching up on a Set. Kumi keeps each saved Set's last state on this computer (the bridge's
 * privacy-redacted semantic snapshot) and, when it sees the Set again, says in plain words what
 * changed while it wasn't running. Nothing here changes Live.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import type { CatchUp, ConversationStore, JsonObject, SavedConversation } from "../../core/contracts.js";
import { dropEarliest, noteShortened, transcriptOf } from "../../kernel/budget.js";

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
/** HISTORY kept with each conversation. */
const MAX_KEPT_CHANGES = 100;

/** A new conversation's id: when it started, and a little randomness. */
export const newConversationId = (at = Date.now()) => `${at.toString(36)}${randomBytes(3).toString("hex")}`;
const PLACE = /^([0-9a-f]{32}|unsaved)$/;
const CONVERSATION = /^[0-9a-z]{6,24}$/;
/** Conversations kept per Set. */
const MAX_KEPT = 20;

/**
 * Each Set's conversations, in its folder next to its last-seen state (an unsaved Set's in
 * "unsaved"), one file each, with "current" naming the one the Set carries on with. Readable only
 * by this user.
 */
export function createConversationStore(directory: string): ConversationStore {
  const folder = (place: string) => { if (!PLACE.test(place)) throw new Error("invalid place"); return join(directory, place); };
  const kept = (place: string) => join(folder(place), "conversations");
  const fileOf = (place: string, id: string) => { if (!CONVERSATION.test(id)) throw new Error("invalid conversation id"); return join(kept(place), `${id}.json`); };
  async function read(file: string): Promise<SavedConversation | undefined> {
    try {
      const value = JSON.parse(await readFile(file, "utf8")) as SavedConversation;
      if (typeof value?.savedAt !== "number" || value.checkpoint?.version !== 1 || !Array.isArray(value.checkpoint.messages)) return undefined;
      return { savedAt: value.savedAt, checkpoint: value.checkpoint, ...(Array.isArray(value.changes) ? { changes: value.changes } : {}),
        ...(typeof value.first === "string" ? { first: value.first } : {}), ...(typeof value.turns === "number" ? { turns: value.turns } : {}) };
    } catch { return undefined; }
  }
  const currentId = async (place: string) => {
    try { const id = (await readFile(join(folder(place), "current"), "utf8")).trim(); return CONVERSATION.test(id) ? id : undefined; } catch { return undefined; }
  };
  /** An older Kumi kept one conversation per Set, in conversation.json: it becomes the first one kept. */
  async function migrate(place: string) {
    const legacy = join(folder(place), "conversation.json");
    const value = await read(legacy);
    if (!value) return;
    const id = newConversationId(value.savedAt);
    await writePrivately(kept(place), `${id}.json`, JSON.stringify(value));
    if (!await currentId(place)) await writePrivately(folder(place), "current", id);
    await rm(legacy, { force: true });
  }
  /** MAX_KEPT stay: the current one, and the others last saved most recently. */
  async function trim(place: string) {
    const current = `${await currentId(place)}.json`;
    const names = (await readdir(kept(place)).catch(() => [])).filter((name) => /^[0-9a-z]{6,24}\.json$/.test(name));
    const others = await Promise.all(names.filter((name) => name !== current).map(async (name) => ({ name, at: (await stat(join(kept(place), name)).catch(() => undefined))?.mtimeMs ?? 0 })));
    const old = others.sort((a, b) => b.at - a.at).slice(MAX_KEPT - (names.includes(current) ? 1 : 0));
    await Promise.all(old.map((file) => rm(join(kept(place), file.name), { force: true })));
  }
  return {
    async current(place) {
      try {
        await migrate(place);
        const id = await currentId(place);
        const conversation = id ? await read(fileOf(place, id)) : undefined;
        return id && conversation ? { id, conversation } : undefined;
      } catch { return undefined; }
    },
    async load(place, id) {
      try { await migrate(place); return await read(fileOf(place, id)); } catch { return undefined; }
    },
    async save(place, id, conversation) {
      const all = [...conversation.checkpoint.messages] as { role?: unknown }[];
      // Drop whole exchanges from the front: the kept part starts where the producer spoke.
      let messages = dropEarliest(all, MAX_CONVERSATION_BYTES);
      // One very large exchange on its own is still kept (up to a hard limit), rather than nothing.
      if (!messages.length) {
        const last = all.map((message) => message.role).lastIndexOf("user");
        messages = last >= 0 && Buffer.byteLength(JSON.stringify(all.slice(last))) <= 4 * MAX_CONVERSATION_BYTES ? all.slice(last) : [];
      }
      if (!messages.length) return;
      // As in the kernel, the model is told when the start of the conversation is gone.
      if (messages.length < all.length) messages = noteShortened(messages as LanguageModelV4Message[]);
      // What /conversations shows is counted before any of it is dropped.
      const said = transcriptOf(all).filter((line) => line.role === "user");
      const saved: SavedConversation = { savedAt: conversation.savedAt, checkpoint: { ...conversation.checkpoint, messages },
        ...(conversation.changes?.length ? { changes: conversation.changes.slice(-MAX_KEPT_CHANGES) } : {}),
        first: (conversation.first ?? said[0]?.text ?? "").slice(0, 200), turns: Math.max(conversation.turns ?? 0, said.length) };
      fileOf(place, id);
      await writePrivately(kept(place), `${id}.json`, JSON.stringify(saved));
      await writePrivately(folder(place), "current", id);
      await trim(place);
    },
    async fresh(place) {
      folder(place);
      if (await currentId(place)) await writePrivately(folder(place), "current", "");
    },
    async list(place) {
      try {
        await migrate(place);
        const current = await currentId(place);
        const names = (await readdir(kept(place)).catch(() => [])).filter((name) => /^[0-9a-z]{6,24}\.json$/.test(name));
        const rows = await Promise.all(names.map(async (name) => {
          const id = name.slice(0, -5);
          const value = await read(join(kept(place), name));
          if (!value) return undefined;
          const said = transcriptOf(value.checkpoint.messages).filter((line) => line.role === "user");
          return { id, savedAt: value.savedAt, first: value.first ?? said[0]?.text.slice(0, 200) ?? "", turns: value.turns ?? said.length, current: id === current };
        }));
        return rows.filter((row) => row !== undefined).sort((a, b) => b.savedAt - a.savedAt);
      } catch { return []; }
    },
    async move(id, from, to) {
      const value = await read(fileOf(from, id));
      if (!value) return;
      fileOf(to, id);
      await writePrivately(kept(to), `${id}.json`, JSON.stringify(value));
      await writePrivately(folder(to), "current", id);
      await rm(fileOf(from, id), { force: true });
      if (await currentId(from) === id) await writePrivately(folder(from), "current", "");
      await trim(to);
    },
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

/**
 * Each track's coordinate in a snapshot (what its devices and clips name as their parent), to its
 * name: the bridge's own derivation, a short hash of the track's kind, name and structure, counted
 * where tracks look alike.
 */
function trackCoordinates(pages: readonly JsonObject[]): Map<string, string> {
  const tracks = [...records(pages).values()].filter((row) => row.kind === "track").sort((a, b) => Number(a.order) - Number(b.order));
  const counts = new Map<string, number>(); const names = new Map<string, string>();
  for (const row of tracks) {
    const data = (row.data ?? {}) as JsonObject;
    const canonical = `{"kind":${JSON.stringify(data.kind ?? null)},"name":${JSON.stringify(row.name ?? null)},"structureHash":${JSON.stringify(data.structureHash ?? null)}}`;
    const base = `track-snapshot:${createHash("sha256").update(canonical).digest("hex").slice(0, 20)}`;
    const count = (counts.get(base) ?? 0) + 1; counts.set(base, count);
    names.set(`${base}-${count}`, typeof row.name === "string" ? row.name : "(unnamed)");
  }
  return names;
}

const small = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return typeof value === "string" ? value.slice(0, 120) : value;
  const text = JSON.stringify(value);
  return text.length <= 240 ? value : `${text.slice(0, 237)}…`;
};

/** What a newly added item is, in the fields that say how to make it again. */
function madeOf(kind: string, row: Row): JsonObject {
  const data = (row.data ?? {}) as JsonObject; const location = (data.location ?? {}) as JsonObject;
  const name = typeof row.name === "string" && row.name !== "unavailable" ? row.name : undefined;
  if (kind === "track") {
    const mixer = (data.mixer ?? {}) as JsonObject;
    const kept = Object.fromEntries(["volume", "pan", "sends", "mute", "solo"].filter((key) => mixer[key] !== null && mixer[key] !== undefined).map((key) => [key, mixer[key]!]));
    return { ...(name ? { name } : {}), trackKind: data.kind ?? null, routing: small(data.routing) as JsonObject, armed: data.armed ?? null, monitoring: data.monitoring ?? null, mixer: kept };
  }
  if (kind === "device") return { ...(name ? { name } : {}), className: data.className ?? null, position: data.siblingOrder ?? null, ...(typeof data.depth === "number" && data.depth > 0 ? { insideRack: true } : {}) };
  if (kind === "clip") return { ...(name ? { name } : {}), clipKind: data.clipKind ?? null, lane: location.lane ?? null, ...(typeof location.sceneOrder === "number" ? { scene: location.sceneOrder } : {}), start: data.start ?? null, length: data.length ?? null };
  return name ? { name } : {};
}

/**
 * What changed in the Set while Kumi watched the producer work, compact and exact, for the model
 * to turn into a recipe: what was added (with how it's set up), removed, renamed or changed, and
 * on which track.
 */
export function describeWatch(diff: JsonObject, before: readonly JsonObject[], after: readonly JsonObject[], limit = 40): { changes: JsonObject[]; more: number } {
  const was = records(before); const now = records(after);
  const tracks = new Map([...trackCoordinates(before), ...trackCoordinates(after)]);
  const on = (row: Row | undefined) => { const parent = ((row?.data ?? {}) as JsonObject).parentSnapshotId; return typeof parent === "string" && tracks.has(parent) ? { on: tracks.get(parent)! } : {}; };
  const changes: JsonObject[] = [];
  for (const item of (Array.isArray(diff.items) ? diff.items : []) as JsonObject[]) {
    const kind = String(item.kind);
    if (!["set", "track", "scene", "clip", "device", "locator"].includes(kind)) continue;
    if (item.type === "ambiguity") {
      const names = (ids: unknown, from: Map<string, Row>) => (Array.isArray(ids) ? ids : []).map((id) => from.get(String(id))?.name).filter((name): name is string => typeof name === "string");
      changes.push({ unclear: kind, before: names(item.beforeSnapshotIds, was), after: names(item.afterSnapshotIds, now) });
      continue;
    }
    if (item.type !== "change" || !Array.isArray(item.facets)) continue;
    const facets = item.facets as string[];
    const old = typeof item.beforeSnapshotId === "string" ? was.get(item.beforeSnapshotId) : undefined;
    const current = typeof item.afterSnapshotId === "string" ? now.get(item.afterSnapshotId) : undefined;
    if (facets.includes("added") && current) { changes.push({ added: kind, ...madeOf(kind, current), ...on(current), order: current.order ?? null }); continue; }
    if (facets.includes("removed") && old) { changes.push({ removed: kind, name: old.name ?? null, ...on(old), order: old.order ?? null }); continue; }
    const what = (Array.isArray(item.details) ? item.details as JsonObject[] : [])
      .filter((detail) => typeof detail.path === "string" && !DERIVED.test(detail.path) && !/Hash$|Fingerprint$|\/hash$/.test(detail.path))
      .map((detail) => ({ what: String(detail.path).replace(/^\/data\//, "").replace(/\//g, "."), from: small(detail.before) ?? null, to: small(detail.after) ?? null }));
    const renamed = facets.includes("renamed") && old && current && old.name !== current.name;
    if (!what.length && !renamed) {
      // A device's settings are compared as a whole: say it changed, the model reads the values if they matter.
      if (kind === "device" && (current ?? old)) changes.push({ changed: kind, name: (current ?? old)!.name ?? null, ...on(current ?? old), what: "its settings" });
      continue;
    }
    changes.push({ changed: kind, name: (current ?? old)?.name ?? null, ...on(current ?? old), ...(renamed ? { renamedFrom: old!.name ?? null } : {}), ...(what.length ? { what: what.slice(0, 12) } : {}) });
  }
  // A removed and an added item of one kind in the same place: renamed (and maybe changed).
  for (const gone of changes.filter((change) => change.removed !== undefined)) {
    const fresh = changes.find((change) => change.added === gone.removed && change.order === gone.order && change.on === gone.on);
    if (!fresh) continue;
    const { added, order: _order, ...rest } = fresh;
    changes.splice(changes.indexOf(fresh), 1, { changed: added!, ...rest, renamedFrom: gone.name ?? null, note: "renamed and changed" });
    changes.splice(changes.indexOf(gone), 1);
  }
  // In the order a recipe would make them: the Set, then tracks, scenes, devices and clips.
  const rank = (change: JsonObject) => ["set", "track", "scene", "device", "clip", "locator"].indexOf(String(change.added ?? change.removed ?? change.changed ?? change.unclear));
  const ordered = changes.map((change, index) => ({ change, index })).sort((a, b) => rank(a.change) - rank(b.change) || a.index - b.index)
    .map(({ change }) => { const { order: _order, ...rest } = change; return rest; });
  return { changes: ordered.slice(0, limit), more: Math.max(0, ordered.length - limit) };
}
