/**
 * Pino logger. Pretty-printed in dev, structured JSON otherwise.
 * Note: pino is CJS (`export =`); the default import is the factory and the
 * `Logger` type comes from the merged namespace (ADR-003).
 */
import pinoDefault from "pino";
import type { Logger as PinoLogger } from "pino";

export type Logger = PinoLogger;
const pino = pinoDefault;

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export function createLogger(level: LogLevel, pretty: boolean): Logger {
    return pino({
        level,
        ...(pretty
            ? {
                  transport: {
                      target: "pino-pretty",
                      options: { colorize: true, translateTime: "HH:MM:ss" },
                  },
              }
            : {}),
    });
}
