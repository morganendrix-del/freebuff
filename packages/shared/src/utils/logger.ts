import { redact } from "./redact";

export type LogLevel = "debug" | "error" | "info" | "warn";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, error?: unknown, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly bindings?: LogFields;
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Structured JSON logger. Every field passes through `redact`, so a prompt, file body, token or API
 * key cannot reach the sink even by accident.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const bindings = options.bindings ?? {};
  const now = options.now ?? (() => new Date());
  const sink =
    options.sink ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });

  const emit = (
    entryLevel: LogLevel,
    message: string,
    error: unknown,
    fields: LogFields | undefined,
  ): void => {
    if (LEVEL_RANK[entryLevel] < LEVEL_RANK[level]) return;

    const payload: Record<string, unknown> = {
      level: entryLevel,
      time: now().toISOString(),
      msg: message,
      ...(redact(bindings) as Record<string, unknown>),
      ...(fields === undefined ? {} : (redact(fields) as Record<string, unknown>)),
    };

    if (error !== undefined) payload.err = redact(error);

    try {
      sink(JSON.stringify(payload));
    } catch {
      // Logging must never break the caller (circular refs, throwing sinks, EPIPE).
    }
  };

  return {
    level,
    debug: (message, fields) => {
      emit("debug", message, undefined, fields);
    },
    info: (message, fields) => {
      emit("info", message, undefined, fields);
    },
    warn: (message, fields) => {
      emit("warn", message, undefined, fields);
    },
    error: (message, error, fields) => {
      emit("error", message, error, fields);
    },
    child: (extraBindings) =>
      createLogger({ level, bindings: { ...bindings, ...extraBindings }, sink, now }),
  };
}

/** Silent logger for tests and for places where output must not interleave (terminal UI). */
export function createNullLogger(): Logger {
  return createLogger({ sink: () => undefined });
}
