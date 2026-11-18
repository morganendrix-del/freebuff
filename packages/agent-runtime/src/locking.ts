import { CancelledError, PlatformError } from "@freebuff/shared";

export type LockPolicy = "reject" | "serialize";

export interface AcquireOptions {
  readonly policy?: LockPolicy;
  readonly signal?: AbortSignal;
}

/**
 * Serialises writes per path so parallel subagents cannot interleave edits to the same file.
 * `reject` refuses the write instead of queueing; both behaviours are covered by the gate tests.
 */
export class PathLockManager {
  private readonly busy = new Set<string>();
  private readonly waiters = new Map<string, (() => void)[]>();
  private readonly defaultPolicy: LockPolicy;

  constructor(defaultPolicy: LockPolicy = "serialize") {
    this.defaultPolicy = defaultPolicy;
  }

  async acquire(paths: readonly string[], options: AcquireOptions = {}): Promise<() => void> {
    const keys = [...new Set(paths)].sort();
    if (keys.length === 0) return () => undefined;

    const policy = options.policy ?? this.defaultPolicy;
    if (policy === "reject") {
      for (const key of keys) {
        if (this.busy.has(key)) {
          throw new PlatformError("file_locked", `Another agent is editing ${key}.`);
        }
      }
    }

    for (const key of keys) {
      while (this.busy.has(key)) {
        await this.waitForKey(key, options.signal);
      }
      this.busy.add(key);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        this.busy.delete(key);
        const queue = this.waiters.get(key);
        const next = queue?.shift();
        if (next) next();
      }
    };
  }

  isBusy(relativePath: string): boolean {
    return this.busy.has(relativePath);
  }

  private async waitForKey(key: string, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const queue = this.waiters.get(key) ?? [];

      const settle = (): void => {
        signal?.removeEventListener("abort", onAbort);
        const index = queue.indexOf(notify);
        if (index >= 0) queue.splice(index, 1);
      };

      const notify = (): void => {
        settle();
        resolve();
      };

      const onAbort = (): void => {
        settle();
        reject(new CancelledError(`Cancelled while waiting for ${key}.`));
      };

      queue.push(notify);
      this.waiters.set(key, queue);

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}
