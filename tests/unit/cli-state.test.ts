import { createId } from "@freebuff/shared";
import type { AgentEvent } from "@freebuff/shared";
import { describe, expect, test, vi } from "vitest";

import { INITIAL_CLI_STATE, applyAgentEvent, createCliStore } from "@freebuff/cli";

const sessionId = createId("session");

describe("CLI state store", () => {
  test("notifies subscribers on every change and stops after unsubscribe", () => {
    const store = createCliStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setState({ statusLine: "signed in" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.setState({ statusLine: "idle" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().statusLine).toBe("idle");
  });

  test("supports functional patches without mutating the previous state", () => {
    const store = createCliStore();
    const before = store.getState();

    store.setState((state) => ({ ...state, running: true }));
    expect(before.running).toBe(false);
    expect(store.getState().running).toBe(true);
  });
});

describe("agent event reducer", () => {
  test("streams assistant text and keeps tool activity in the status line", () => {
    const events: AgentEvent[] = [
      { type: "run_started", runId: createId("run"), sessionId, modelId: "deepseek-flash" },
      { type: "assistant_delta", text: "Thinking about " },
      { type: "assistant_delta", text: "the fix." },
      {
        type: "tool_call",
        toolCallId: "call_1",
        toolName: "write_file",
        input: { path: "a.ts" },
      },
      {
        type: "tool_result",
        toolCallId: "call_1",
        toolName: "write_file",
        ok: false,
        summary: "failed: write_file",
        durationMs: 12,
      },
      {
        type: "run_completed",
        status: "completed",
        reason: "assistant_finished",
        usage: { inputTokens: 10, outputTokens: 4 },
      },
    ];

    const final = events.reduce(applyAgentEvent, INITIAL_CLI_STATE);

    expect(final.running).toBe(false);
    expect(final.streamingText).toBe("");
    expect(final.statusLine).toBe("Finished (completed) · 10 in / 4 out");
  });

  test("surfaces failures and cancellations without leaving a running state", () => {
    const failed = applyAgentEvent(INITIAL_CLI_STATE, {
      type: "run_failed",
      failure: { code: "provider_unavailable", message: "provider down", retryable: true },
    });
    expect(failed).toMatchObject({ running: false, streamingText: "" });
    expect(failed.statusLine).toContain("provider down");

    const cancelled = applyAgentEvent(
      { ...INITIAL_CLI_STATE, running: true },
      {
        type: "run_cancelled",
        reason: "Run cancelled.",
      },
    );
    expect(cancelled.running).toBe(false);
    expect(cancelled.statusLine).toBe("Run cancelled.");
  });

  test("ignores thinking deltas so private reasoning never renders", () => {
    const state = applyAgentEvent(INITIAL_CLI_STATE, { type: "thinking_delta", text: "secret" });
    expect(state.streamingText).toBe("");
  });
});
