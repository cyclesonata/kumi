import { loadLiveRegistry } from "./registry.js";

type FollowSchema = { type: "boolean" | "integer" | "number"; minimum?: number; maximum?: number };
const request = loadLiveRegistry().operations.find(operation => operation.id === "clip.follow-actions.set")!.request;
export const FOLLOW_ACTION_SCHEMA = Object.fromEntries(Object.entries(request.properties as Record<string, FollowSchema>).filter(([field]) => field.startsWith("followAction")));
export const FOLLOW_ACTION_FIELDS = Object.keys(FOLLOW_ACTION_SCHEMA);
export function validateFollowActions(state: Record<string, unknown>): void {
  for (const [field, schema] of Object.entries(FOLLOW_ACTION_SCHEMA)) {
    const value = state[field];
    if (schema.type === "boolean") { if (typeof value !== "boolean") throw new Error(`${field} must be boolean`); }
    else if (typeof value !== "number" || !Number.isFinite(value) || value < schema.minimum! || value > schema.maximum! || (schema.type === "integer" && !Number.isInteger(value))) throw new Error(`${field} is unavailable or out of bounds`);
  }
  if ((state.followActionChanceA as number) + (state.followActionChanceB as number) !== 100) throw new Error("Follow Action probabilities must sum to 100");
}
