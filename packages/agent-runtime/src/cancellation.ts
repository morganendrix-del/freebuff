import { CancelledError } from "@freebuff/shared";

/**
 * Cancellation tree for a run and its subagents. Hooks run exactly once when cancelled, which is how
 * sandbox processes and provider requests get torn down (gate: no orphaned subprocesses).
 */
export class CancellationScope {
  private readonly controller = new AbortController();
  private readonly hooks: (() => void | Promise<void>)[] = [];
  private hooksRun = false;
  private readonly children = new Set<CancellationScope>();

  constructor(parent?: AbortSignal) {
    if (parent) {
      if (parent.aborted) this.cancel();
      else
        parent.addEventListener(
          "abort",
          () => {
            this.cancel();
          },
          { once: true },
        );
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  child(): CancellationScope {
    const child = new CancellationScope(this.controller.signal);
    this.children.add(child);
    return child;
  }

  onCancel(hook: () => void | Promise<void>): () => void {
    if (this.controller.signal.aborted) {
      void hook();
      return () => undefined;
    }
    this.hooks.push(hook);
    return () => {
      const index = this.hooks.indexOf(hook);
      if (index >= 0) this.hooks.splice(index, 1);
    };
  }

  cancel(reason = "Run cancelled."): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(new CancelledError(reason));

    if (!this.hooksRun) {
      this.hooksRun = true;
      for (const hook of this.hooks.splice(0)) {
        try {
          void hook();
        } catch {
          // Cleanup hooks must not mask the cancellation.
        }
      }
    }

    for (const child of this.children) child.cancel(reason);
    this.children.clear();
  }
}
