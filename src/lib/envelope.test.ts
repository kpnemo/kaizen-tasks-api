import { describe, expect, it } from "vitest";
import { errorEnvelope, successEnvelope } from "./envelope.js";

describe("envelopes", () => {
  it("wraps data with meta.requestId and no nextCursor for single items", () => {
    expect(successEnvelope({ id: "1" }, "req-1")).toEqual({
      data: { id: "1" },
      meta: { requestId: "req-1" },
    });
  });

  it("adds nextCursor to list envelopes, null on the last page", () => {
    expect(successEnvelope([1], "req-1", "abc")).toEqual({
      data: [1],
      meta: { requestId: "req-1", nextCursor: "abc" },
    });
    expect(successEnvelope([1], "req-1", null)).toEqual({
      data: [1],
      meta: { requestId: "req-1", nextCursor: null },
    });
  });

  it("builds the error envelope with optional details", () => {
    expect(errorEnvelope("NOT_FOUND", "Task not found", "req-2")).toEqual({
      error: { code: "NOT_FOUND", message: "Task not found", requestId: "req-2" },
    });
    expect(
      errorEnvelope("VALIDATION_ERROR", "Bad", "req-3", [{ path: "body.x", message: "m" }]),
    ).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Bad",
        details: [{ path: "body.x", message: "m" }],
        requestId: "req-3",
      },
    });
  });
});
