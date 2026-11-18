import type {
  LlmProvider,
  ProviderEvent,
  ProviderRequest,
  ProviderStopReason,
  StreamOptions,
} from "@freebuff/llm-providers";

export interface Script {
  readonly prompt: string;
  readonly events: readonly ProviderEvent[];
  /** Keeps the stream open until the caller aborts, to exercise mid-stream cancellation. */
  readonly hangAfterMs?: number;
  consumed?: boolean;
}

function firstPrompt(request: ProviderRequest): string {
  for (const turn of request.turns) {
    if (turn.role === "user" && turn.text !== "") return turn.text;
  }
  return "";
}

/** Replays a script per prompt. Deterministic regardless of subagent scheduling. */
export class ScriptedProvider implements LlmProvider {
  readonly id = "deepseek" as const;
  readonly calls: ProviderRequest[] = [];
  closedStreams = 0;

  constructor(private readonly scripts: Script[]) {}

  async *stream(request: ProviderRequest, options: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push(request);
    const prompt = firstPrompt(request);
    const script = this.scripts.find((entry) => entry.consumed !== true && entry.prompt === prompt);
    if (!script) throw new Error(`No scripted response for prompt: ${prompt}`);
    script.consumed = true;

    try {
      for (const event of script.events) {
        if (options.signal.aborted) return;
        yield event;
      }

      if (script.hangAfterMs !== undefined) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, script.hangAfterMs);
          options.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    } finally {
      this.closedStreams += 1;
    }
  }
}

export function toolCall(
  index: number,
  toolCallId: string,
  toolName: string,
  args: unknown,
): ProviderEvent[] {
  return [
    { type: "tool_call_start", index, toolCallId, toolName },
    { type: "tool_call_arguments_delta", index, delta: JSON.stringify(args) },
    { type: "tool_call_end", index },
  ];
}

export function completed(stopReason: ProviderStopReason): ProviderEvent {
  return { type: "completed", stopReason };
}

export function finalText(text: string): ProviderEvent[] {
  return [
    { type: "assistant_text_delta", text },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 4 } },
    { type: "completed", stopReason: "end_turn" },
  ];
}

export function script(
  prompt: string,
  events: readonly ProviderEvent[],
  hangAfterMs?: number,
): Script {
  return { prompt, events, ...(hangAfterMs === undefined ? {} : { hangAfterMs }) };
}
