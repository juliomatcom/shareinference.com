// Structured logs for every ShareInference service: one JSON object per line, always the same envelope.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

/** One log line. `context` is any JSON; errors inside it are serialized. */
export interface LogEvent {
  timestamp: string;
  severity: Severity;
  app: string;
  module: string;
  message: string;
  context?: unknown;
}

export type Logger = Record<LogLevel, (message: string, context?: unknown) => void>;

export interface LoggerOptions {
  /** Lowest level written (default `info`). The library never reads the environment: the caller passes it. */
  level?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const SEVERITY: Record<LogLevel, Severity> = { debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR" };

/** Nesting deeper than this (objects, arrays and error causes) is replaced by a marker. */
const MAX_DEPTH = 8;

/** Turns any value into plain JSON data: errors become objects, bigints strings, cycles and deep nesting markers. */
function toJson(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  ancestors.add(value);
  try {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
        // fetch failures say only "fetch failed"; the reason (ECONNREFUSED, DNS, TLS) is in the cause.
        ...(value.cause !== undefined && { cause: toJson(value.cause, depth + 1, ancestors) }),
      };
    }
    if ("toJSON" in value && typeof value.toJSON === "function") {
      return toJson((value.toJSON as () => unknown)(), depth + 1, ancestors);
    }
    if (Array.isArray(value)) return value.map((item) => toJson(item, depth + 1, ancestors) ?? null);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const json = toJson(item, depth + 1, ancestors);
      if (json !== undefined) out[key] = json;
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function serializeContext(context: unknown): unknown {
  try {
    return toJson(context, 0, new Set()) ?? null;
  } catch (error) {
    // A throwing getter or toJSON must never take the caller down.
    return { serializationError: error instanceof Error ? error.message : String(error) };
  }
}

/** `app` is the service (`api`), `module` the part of it (`http`, `db`). debug and info go to stdout, warn and error to stderr. */
export function createLogger(app: string, module: string, options: LoggerOptions = {}): Logger {
  const minimum = LEVEL_ORDER[options.level ?? "info"];
  const write = (level: LogLevel, message: string, context?: unknown): void => {
    if (LEVEL_ORDER[level] < minimum) return;
    // Key order is part of the contract: timestamp, severity, app, module, message, context.
    const event: LogEvent = { timestamp: new Date().toISOString(), severity: SEVERITY[level], app, module, message };
    if (context !== undefined) event.context = serializeContext(context);
    const line = `${JSON.stringify(event)}\n`;
    if (level === "debug" || level === "info") process.stdout.write(line);
    else process.stderr.write(line);
  };
  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
