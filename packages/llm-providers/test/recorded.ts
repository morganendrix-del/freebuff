import { findModel } from "@freebuff/shared";
import type { RetryPolicy } from "@freebuff/shared";

import type { ProviderEvent, ProviderRequest, Transport, TransportRequest } from "../src/types";

export interface Exchange {
  readonly status?: number;
  readonly body: string;
}

export interface RecordingTransport {
  readonly transport: Transport;
  readonly requests: TransportRequest[];
}

/** Replays recorded exchanges in order; repeats the last one once exhausted. */
export function createRecordingTransport(exchanges: readonly Exchange[]): RecordingTransport {
  const requests: TransportRequest[] = [];

  const transport: Transport = (request) => {
    requests.push(request);
    const exchange = exchanges[Math.min(requests.length - 1, exchanges.length - 1)];
    if (exchange === undefined) {
      return Promise.reject(new Error("recorded transport ran out of exchanges"));
    }

    const status = exchange.status ?? 200;
    if (status < 200 || status >= 300) {
      return Promise.resolve(new Response(exchange.body, { status }));
    }
    return Promise.resolve(
      new Response(exchange.body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };

  return { transport, requests };
}

export const FAST_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 2,
  jitterRatio: 0,
};

export const SINGLE_ATTEMPT: RetryPolicy = { ...FAST_RETRY, maxAttempts: 1 };

export async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export function fixtureModel(modelId: string) {
  const model = findModel(modelId);
  if (model === undefined) throw new Error(`Unknown fixture model ${modelId}`);
  return model;
}

export function fixtureRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: fixtureModel("deepseek-flash"),
    systemPrompt: "You are a coding agent.",
    turns: [{ role: "user", text: "Fix the add function." }],
    tools: [
      {
        name: "read_file",
        description: "Read a file from the workspace",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    ...overrides,
  };
}
