/**
 * RFC 7807 problem+json errors (ADR-013).
 * The /api/v1 surface returns these; legacy /api/* aliases keep the old
 * `{ error }` shapes because the legacy client still consumes them.
 */
import type { Problem } from "../shared/types.js";

export type ProblemStatus =
  | 400
  | 404
  | 413
  | 422
  | 429
  | 502
  | 503
  | 504;

const TITLES: Record<ProblemStatus, string> = {
  400: "Bad Request",
  404: "Not Found",
  413: "Payload Too Large",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export class AppError extends Error {
  readonly status: ProblemStatus;
  readonly type?: string;

  constructor(status: ProblemStatus, message: string, type?: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.type = type;
  }

  toProblem(instance?: string): Problem {
    const type = this.type ?? `about:blank`;
    return {
      type,
      title: TITLES[this.status],
      status: this.status,
      detail: this.message,
      ...(instance ? { instance } : {}),
    };
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message, "https://wago.tools/errors/not-found");
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Invalid request") {
    super(400, message, "https://wago.tools/errors/bad-request");
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Request body too large") {
    super(413, message, "https://wago.tools/errors/payload-too-large");
  }
}

export class UnprocessableError extends AppError {
  constructor(message = "Unprocessable content") {
    super(422, message, "https://wago.tools/errors/unprocessable");
  }
}

export class UpstreamError extends AppError {
  constructor(message = "Upstream request failed") {
    super(502, message, "https://wago.tools/errors/upstream");
  }
}

export class UpstreamTimeoutError extends AppError {
  constructor(message = "Upstream request timed out") {
    super(504, message, "https://wago.tools/errors/upstream-timeout");
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable") {
    super(503, message, "https://wago.tools/errors/unavailable");
  }
}

/** Map any thrown value to a Problem without leaking stack traces. */
export function problemFromUnknown(err: unknown, instance?: string): Problem {
  if (err instanceof AppError) return err.toProblem(instance);
  // Fastify-generated errors (malformed JSON, body too large, …) carry their
  // own HTTP status — honor it instead of collapsing everything to 500.
  const titles = TITLES as Record<number, string | undefined>;
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  const status = typeof code === "number" ? Math.round(code) : 500;
  if (status >= 400 && status <= 499) {
    return {
      type: "about:blank",
      title: titles[status] ?? "Bad Request",
      status,
      detail: err instanceof Error ? err.message : "Invalid request",
      ...(instance ? { instance } : {}),
    };
  }
  return {
    type: "about:blank",
    title: titles[status] ?? "Internal Server Error",
    status,
    detail: "Unexpected internal error",
    ...(instance ? { instance } : {}),
  };
}