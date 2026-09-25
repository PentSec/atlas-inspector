/**
 * Upstream file source — the seam between the app and wago.tools.
 * Narrow and honest: exactly what the legacy server did.
 *
 * Contract (parity with legacy httpGetFile):
 *  - HTTP 400/404 resolve to an EMPTY Buffer (caller treats as "no such file")
 *  - any other HTTP error is retried
 *  - after maxRetries it resolves to `null` (caller treats as "upstream down")
 */
export interface WowFileSource {
  /** Low-level GET returning raw bytes with retry/backoff. */
  getFile(url: string): Promise<Buffer | null>;
}

/** Anything thrown while talking to the upstream. */
export class UpstreamConnectionError extends Error {
  readonly causeValue?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "UpstreamConnectionError";
    this.causeValue = cause;
  }
}