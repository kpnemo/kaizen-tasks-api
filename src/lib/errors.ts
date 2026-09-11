export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "UNAVAILABLE",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** The one place an error code becomes an HTTP status. */
export function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export interface ValidationDetail {
  path: string;
  message: string;
}

export interface RateLimitDetails {
  scope: "user" | "global";
  limit: number;
  resetAt: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return statusFor(this.code);
  }
}

export const validationError = (
  details: ValidationDetail[],
  message = "Request validation failed",
): AppError => new AppError("VALIDATION_ERROR", message, details);

export const unauthorized = (message = "Unauthorized"): AppError =>
  new AppError("UNAUTHORIZED", message);

export const notFound = (message = "Not found"): AppError => new AppError("NOT_FOUND", message);

export interface ForbiddenDetails {
  /** `passphrase`: the caller is allowlisted but the deploy passphrase was wrong. */
  reason: "passphrase";
}

export const forbidden = (message = "Forbidden", details?: ForbiddenDetails): AppError =>
  new AppError("FORBIDDEN", message, details);

export const conflict = (message: string): AppError => new AppError("CONFLICT", message);

export const rateLimited = (details: RateLimitDetails): AppError =>
  new AppError("RATE_LIMITED", "Rate limit exceeded", details);

export const upstreamError = (message: string): AppError => new AppError("UPSTREAM_ERROR", message);

export const unavailable = (message: string): AppError => new AppError("UNAVAILABLE", message);

export const internal = (message = "Internal server error"): AppError =>
  new AppError("INTERNAL", message);
