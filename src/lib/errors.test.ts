import { describe, expect, it } from "vitest";
import {
  AppError,
  ERROR_CODES,
  notFound,
  rateLimited,
  statusFor,
  validationError,
} from "./errors.js";

describe("statusFor", () => {
  it("maps every code to the spec status", () => {
    expect(statusFor("VALIDATION_ERROR")).toBe(400);
    expect(statusFor("UNAUTHORIZED")).toBe(401);
    expect(statusFor("FORBIDDEN")).toBe(403);
    expect(statusFor("NOT_FOUND")).toBe(404);
    expect(statusFor("CONFLICT")).toBe(409);
    expect(statusFor("RATE_LIMITED")).toBe(429);
    expect(statusFor("UPSTREAM_ERROR")).toBe(502);
    expect(statusFor("UNAVAILABLE")).toBe(503);
    expect(statusFor("INTERNAL")).toBe(500);
  });

  it("covers exactly the closed set of codes", () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        "CONFLICT",
        "FORBIDDEN",
        "INTERNAL",
        "NOT_FOUND",
        "RATE_LIMITED",
        "UNAUTHORIZED",
        "UNAVAILABLE",
        "UPSTREAM_ERROR",
        "VALIDATION_ERROR",
      ].sort(),
    );
  });
});

describe("AppError", () => {
  it("carries code, message, details and derived status", () => {
    const err = new AppError("CONFLICT", "Duplicate");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("Duplicate");
    expect(err.status).toBe(409);
    expect(err.details).toBeUndefined();
  });

  it("constructors set the documented shapes", () => {
    expect(notFound().code).toBe("NOT_FOUND");
    const v = validationError([{ path: "body.title", message: "Required" }]);
    expect(v.code).toBe("VALIDATION_ERROR");
    expect(v.details).toEqual([{ path: "body.title", message: "Required" }]);
    const r = rateLimited({ scope: "user", limit: 20, resetAt: "2026-09-08T10:00:00.000Z" });
    expect(r.code).toBe("RATE_LIMITED");
    expect(r.details).toEqual({ scope: "user", limit: 20, resetAt: "2026-09-08T10:00:00.000Z" });
  });
});
