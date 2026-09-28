export type JsonObject = Record<string, unknown>;

export interface KernelTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  execute(input: JsonObject, signal: AbortSignal): Promise<{ text: string; isError?: boolean }>;
}

export type KernelEvent =
  | { type: "text"; text: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-end"; id: string; name: string; isError: boolean; elapsedMs: number }
  /** Guidance accepted mid-turn; it entered the conversation at a model boundary. */
  | { type: "steer"; text: string };

export interface Usage {
  /** All prompt tokens, including cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TurnResult {
  /** "max-steps": the model kept calling tools past the per-turn step bound. */
  stopReason: "completed" | "cancelled" | "max-steps";
  usage?: Usage;
}

export interface Kernel {
  run(input: string, signal: AbortSignal, emit: (event: KernelEvent) => void): Promise<TurnResult>;
  close(): Promise<void>;
}

export interface KernelOptions {
  instructions: string;
  tools: readonly KernelTool[];
  signal: AbortSignal;
}

export type KernelFactory = (options: KernelOptions) => Promise<Kernel>;

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";
export type TurnState = "idle" | "running" | "cancelling" | "closed";

export interface Observation {
  /** Integration-owned identity/catalog generation. Not a durable project ID. */
  key: string;
  label: string;
  context: string;
  instructions: string;
  tools: readonly KernelTool[];
}

export interface Integration {
  start(signal: AbortSignal): Promise<void>;
  observe(signal: AbortSignal): Promise<Observation>;
  close(): Promise<void>;
}
export type IntegrationFactory = (connection: (state: ConnectionState) => void) => Integration;

export type SessionEvent = KernelEvent
  | { type: "state"; state: TurnState }
  | { type: "connection"; state: ConnectionState }
  | { type: "observation"; label: string }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "turn-complete"; result: TurnResult; elapsedMs: number };

export interface SessionStatus {
  state: TurnState;
  connection: ConnectionState;
  turns: number;
  maxTurns: number;
  observation?: string;
}

export interface SessionController {
  start(): Promise<void>;
  submit(input: string): Promise<void>;
  refresh(): Promise<void>;
  newConversation(): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  status(): SessionStatus;
}
