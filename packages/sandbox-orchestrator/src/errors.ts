export type SandboxErrorCode =
  | "conflict"
  | "internal"
  | "invalid_config"
  | "invalid_input"
  | "not_configured"
  | "not_found"
  | "output_too_large"
  | "permission_denied"
  | "timeout";

/**
 * Error type used inside the sandbox runtime and orchestrator. It is deliberately free of
 * `@freebuff/shared` imports: the runtime module is copied into the sandbox image, which contains no
 * node_modules, so the whole isolation layer must run on `node:` builtins alone.
 */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SandboxError";
    this.code = code;
  }
}

export function isSandboxError(error: unknown): error is SandboxError {
  return error instanceof SandboxError;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
