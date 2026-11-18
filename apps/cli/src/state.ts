import type {
  AdSelection,
  AgentEvent,
  AgentMessage,
  Id,
  ProjectRef,
  QuotaSnapshot,
  SessionSummary,
} from "@freebuff/shared";
import type { AuthUser } from "@freebuff/sdk";

export type CliPhase = "signed_out" | "picking_project" | "ready";

export interface CliState {
  readonly phase: CliPhase;
  readonly user?: AuthUser;
  readonly projects: readonly ProjectRef[];
  readonly activeProject?: ProjectRef;
  readonly sessions: readonly SessionSummary[];
  readonly activeSessionId?: Id<"session">;
  readonly messages: readonly AgentMessage[];
  readonly streamingText: string;
  readonly statusLine: string;
  readonly running: boolean;
  readonly quota?: QuotaSnapshot;
  readonly ad?: AdSelection | null;
}

export const INITIAL_CLI_STATE: CliState = {
  phase: "signed_out",
  projects: [],
  sessions: [],
  messages: [],
  streamingText: "",
  statusLine: "Not signed in.",
  running: false,
};

export type CliStatePatch = Partial<CliState> | ((state: CliState) => CliState);

export interface CliStore {
  getState(): CliState;
  setState(patch: CliStatePatch): CliState;
  subscribe(listener: () => void): () => void;
}

/** Small observable store: the TUI renders from it, flows write to it. */
export function createCliStore(initial: CliState = INITIAL_CLI_STATE): CliStore {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setState(patch) {
      const next = typeof patch === "function" ? patch(state) : { ...state, ...patch };
      state = next;
      for (const listener of listeners) listener();
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Reduces agent events into the UI state. Pure, so the streaming behaviour is testable without a
 * renderer: text accumulates, tool activity becomes the status line, completion clears the stream.
 */
export function applyAgentEvent(state: CliState, event: AgentEvent): CliState {
  switch (event.type) {
    case "run_started":
      return {
        ...state,
        running: true,
        streamingText: "",
        statusLine: `Running on ${event.modelId}`,
      };
    case "step_started":
      return { ...state, statusLine: `Step ${String(event.step)}` };
    case "assistant_delta":
      return { ...state, streamingText: state.streamingText + event.text };
    case "thinking_delta":
      return state;
    case "tool_call":
      return { ...state, statusLine: `▶ ${event.toolName}` };
    case "tool_result":
      return {
        ...state,
        statusLine: `${event.ok ? "✓" : "✗"} ${event.toolName} (${String(Math.round(event.durationMs))} ms)`,
      };
    case "subagent_started":
      return { ...state, statusLine: `Delegating: ${event.title}` };
    case "subagent_completed":
      return { ...state, statusLine: `Subagent ${event.status}` };
    case "usage":
      return state;
    case "run_completed":
      return {
        ...state,
        running: false,
        streamingText: "",
        statusLine: `Finished (${event.status}) · ${String(event.usage.inputTokens)} in / ${String(event.usage.outputTokens)} out`,
      };
    case "run_failed":
      return {
        ...state,
        running: false,
        streamingText: "",
        statusLine: `Failed: ${event.failure.message}`,
      };
    case "run_cancelled":
      return { ...state, running: false, streamingText: "", statusLine: event.reason };
  }
}
