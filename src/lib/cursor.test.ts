import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { AppError } from "./errors.js";

describe("cursor", () => {
  it("round-trips createdAt and id", () => {
    const createdAt = new Date("2026-09-08T10:15:30.123Z");
    const id = "6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7";
    const encoded = encodeCursor({ createdAt, id });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual({ createdAt, id });
  });

  it("encodes the documented JSON shape", () => {
    const encoded = encodeCursor({
      createdAt: new Date("2026-09-08T10:15:30.123Z"),
      id: "6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7",
    });
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual({
      c: "2026-09-08T10:15:30.123Z",
      i: "6f1a2b3c-4d5e-4f60-8a71-829394a5b6c7",
    });
  });

  it("rejects garbage with VALIDATION_ERROR on query.cursor", () => {
    for (const garbage of [
      "",
      "not-base64!",
      Buffer.from("{}").toString("base64url"),
      Buffer.from('{"c":"nope","i":"x"}').toString("base64url"),
    ]) {
      let caught: unknown;
      try {
        decodeCursor(garbage);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).code).toBe("VALIDATION_ERROR");
      expect((caught as AppError).details).toEqual([
        { path: "query.cursor", message: "Invalid cursor" },
      ]);
    }
  });
});
