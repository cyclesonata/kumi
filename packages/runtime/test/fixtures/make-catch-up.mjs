// Regenerates catch-up.json from the bridge's own semantic snapshot code (run after building
// apps/mcp-server): a simulator Set, then the same Set after edits made "without Kumi".
import { writeFileSync } from "node:fs";
import { DeterministicLiveSimulator } from "../../../../apps/mcp-server/dist/src/live.js";
import { createSemanticProjectSnapshot, pageSemanticProjectSnapshot } from "../../../../apps/mcp-server/dist/src/project-semantic.js";
import { diffSemanticProjectSnapshots, pageSemanticProjectDiff } from "../../../../apps/mcp-server/dist/src/project-semantic-diff.js";

const options = { profile: "local", exporterVersion: "fixture", live: { protocol: "ableton-live/v1", adapter: "simulator", provenance: "simulator", registryHash: "a".repeat(64) } };
const before = new DeterministicLiveSimulator().snapshot();
// The simulator Set has one track, Drums, with a clip and a device. Add a second before the
// "earlier" snapshot so a rename and an edit can happen on different tracks.
const bass = structuredClone(before.tracks[0]);
Object.assign(bass, { ref: "1:track:1", objectIdentity: "bass", name: "Bass", devices: [] });
bass.clips = bass.clips.map((clip) => ({ ...clip, ref: "1:clip:bass", objectIdentity: "bass-clip", name: "Bassline", notes: clip.notes.map((note) => ({ ...note, pitch: note.pitch - 24 })) }));
bass.clipSlots = (bass.clipSlots ?? []).map((slot) => ({ ...slot, ref: "1:slot:bass", parentRef: bass.ref, clipRef: "1:clip:bass" }));
before.tracks.push(bass);
const after = structuredClone(before);
after.set.tempo = 124;
after.tracks[0].name = "Beats";
after.tracks[0].devices = [];
const pad = structuredClone(after.tracks[1]);
Object.assign(pad, { ref: "1:track:9", objectIdentity: "pad", name: "Pad", clips: [], clipSlots: [], devices: [] });
after.tracks.push(pad);
const clip = after.tracks[1].clips[0];
clip.notes = [...clip.notes, { ...clip.notes[0], id: 999, pitch: 72, start: 1 }];
const pages = (artifact) => [pageSemanticProjectSnapshot(artifact, { limit: 200 })];
const a = createSemanticProjectSnapshot(before, options); const b = createSemanticProjectSnapshot(after, options);
const diff = pageSemanticProjectDiff(diffSemanticProjectSnapshots(a, b), { limit: 200 });
// Empty tracks the bridge can't tell apart: Vox renamed Lead Vox and an empty Bells added after it.
const empty = (name, ref) => ({ ...structuredClone(before.tracks[1]), ref, objectIdentity: ref, name, clips: [], clipSlots: [], devices: [] });
const plain = structuredClone(before); plain.tracks = [plain.tracks[0], empty("Vox", "1:track:5")];
const edited = structuredClone(plain); edited.tracks = [edited.tracks[0], empty("Lead Vox", "1:track:5"), empty("Bells", "1:track:6")];
const c = createSemanticProjectSnapshot(plain, options); const d = createSemanticProjectSnapshot(edited, options);
const ambiguous = { before: pages(c), after: pages(d), diff: pageSemanticProjectDiff(diffSemanticProjectSnapshots(c, d), { limit: 200 }) };
writeFileSync(new URL("catch-up.json", import.meta.url), JSON.stringify({ before: pages(a), after: pages(b), diff, ambiguous }) + "\n");
console.log("ambiguous", ambiguous.diff.items.map((item) => `${item.type}:${item.kind}:${(item.facets ?? []).join("+")}:${item.beforeCandidateCount ?? ""}/${item.afterCandidateCount ?? ""}`).join(" | "));
console.log("tracks before", before.tracks.map((t) => t.name).join(", "), "| after", after.tracks.map((t) => t.name).join(", "));
console.log("diff", JSON.stringify(diff.summary), diff.items.map((item) => `${item.kind}:${item.facets.join("+")}:${item.details.map((d) => d.path).join(",")}`).join(" | "));
