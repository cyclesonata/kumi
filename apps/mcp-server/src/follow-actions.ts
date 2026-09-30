export const FOLLOW_ACTION_SCHEMA = {
  "followActionEnabled": {
    "type": "boolean"
  },
  "followActionLinked": {
    "type": "boolean"
  },
  "followActionA": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9
  },
  "followActionB": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9
  },
  "followActionChanceA": {
    "type": "integer",
    "minimum": 0,
    "maximum": 100
  },
  "followActionChanceB": {
    "type": "integer",
    "minimum": 0,
    "maximum": 100
  },
  "followActionLoopCount": {
    "type": "integer",
    "minimum": 1,
    "maximum": 1073741823
  },
  "followActionTime": {
    "type": "number",
    "minimum": 0.25,
    "maximum": 1000000000
  },
  "followActionJumpA": {
    "type": "integer",
    "minimum": 1,
    "maximum": 8388608
  },
  "followActionJumpB": {
    "type": "integer",
    "minimum": 1,
    "maximum": 8388608
  }
} as const;
export const FOLLOW_ACTION_FIELDS = Object.keys(FOLLOW_ACTION_SCHEMA);
export function validateFollowActions(state: Record<string, unknown>): void {
  for (const [field, schema] of Object.entries(FOLLOW_ACTION_SCHEMA)) {
    const value = state[field];
    if (schema.type === "boolean") { if (typeof value !== "boolean") throw new Error(`${field} must be boolean`); }
    else if (typeof value !== "number" || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum || (schema.type === "integer" && !Number.isInteger(value))) throw new Error(`${field} is unavailable or out of bounds`);
  }
  if ((state.followActionChanceA as number) + (state.followActionChanceB as number) !== 100) throw new Error("Follow Action probabilities must sum to 100");
}
