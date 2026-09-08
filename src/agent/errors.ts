/** The model declined the task. Not retryable. */
export class BreakdownRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BreakdownRefused";
  }
}

/** The model output could not be parsed or failed post-validation. Not retryable. */
export class BreakdownInvalid extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BreakdownInvalid";
  }
}

/** 429, 5xx, connection or timeout failures. The queue retries these. */
export class ModelRetryableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "model request failed", { cause });
    this.name = "ModelRetryableError";
  }
}

/** Other 4xx API failures. Not retryable. */
export class ModelNonRetryableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "model request rejected", { cause });
    this.name = "ModelNonRetryableError";
  }
}
