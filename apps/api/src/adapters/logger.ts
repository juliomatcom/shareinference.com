import { createLogger as createLibraryLogger, type LogLevel } from "@shareinference/logger";
import type { Logger } from "../core/ports.js";

export type Level = LogLevel;

/**
 * The core Logger port on top of the shared library (wiki-llm/logging.md): `(msg, fields)` becomes
 * `(message, context)` in the envelope of app `api` and the given module. `level` comes from config (`LOG_LEVEL`).
 */
export function createLogger(module: string, level: Level = "info"): Logger {
  const log = createLibraryLogger("api", module, { level });
  return {
    debug: (msg, fields) => log.debug(msg, fields),
    info: (msg, fields) => log.info(msg, fields),
    warn: (msg, fields) => log.warn(msg, fields),
    error: (msg, fields) => log.error(msg, fields),
  };
}
