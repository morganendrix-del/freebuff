import { CancelledError, PlatformError, TimeoutError } from "@freebuff/shared";

export interface SseFrame {
  readonly data: string;
  readonly event?: string;
}

const FRAME_SEPARATOR = /\r?\n\r?\n/;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

function parseFrame(raw: string): SseFrame | undefined {
  const dataLines: string[] = [];
  let event: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
  }

  if (dataLines.length === 0) return undefined;
  return { data: dataLines.join("\n"), ...(event === undefined ? {} : { event }) };
}

/**
 * Yields SSE frames as they arrive, racing each read against an idle timeout and the caller's abort
 * signal. The reader is always cancelled and released, so an aborted run never leaves a socket open
 * (gate: no orphaned connections).
 */
export async function* readSseFrames(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Read through a function so TypeScript does not narrow `aborted` across the loop.
  const isAborted = (): boolean => signal.aborted;

  try {
    while (true) {
      if (isAborted()) throw new CancelledError("Provider stream cancelled.");

      const cleanups: (() => void)[] = [];
      const chunk = await new Promise<{ done: boolean; value?: unknown }>((resolve, reject) => {
        const onAbort = (): void => {
          reject(new CancelledError("Provider stream cancelled."));
        };
        signal.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(() => {
          reject(
            new TimeoutError(
              `Provider stream stalled for ${String(idleTimeoutMs)}ms.`,
              idleTimeoutMs,
            ),
          );
        }, idleTimeoutMs);

        cleanups.push(() => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        });

        if (isAborted()) onAbort();
        void reader.read().then(resolve, reject);
      });
      for (const cleanup of cleanups) cleanup();

      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw new PlatformError("malformed_stream", "Provider stream yielded a non-byte chunk.");
      }

      buffer += decoder.decode(chunk.value, { stream: true });

      let match = FRAME_SEPARATOR.exec(buffer);
      while (match) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseFrame(raw);
        if (frame) yield frame;
        match = FRAME_SEPARATOR.exec(buffer);
      }
    }

    buffer += decoder.decode();
    const trailing = parseFrame(buffer);
    if (trailing) yield trailing;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream already closed or errored: nothing to release.
    }
    reader.releaseLock();
  }
}
