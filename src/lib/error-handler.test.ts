import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorHandler, notFoundHandler } from "./error-handler.js";
import { AppError, ERROR_CODES, statusFor } from "./errors.js";
import { createLogger } from "./logger.js";
import { requestId } from "./request-id.js";

function appWith(exposeInternal: boolean) {
  const app = express();
  app.use(requestId());
  for (const code of ERROR_CODES) {
    app.get(`/throw/${code}`, () => {
      throw new AppError(code, `message for ${code}`, code === "VALIDATION_ERROR" ? [] : undefined);
    });
  }
  app.get("/zod", () => {
    z.object({ title: z.string() }).parse({});
  });
  app.get("/boom", () => {
    throw new Error("secret stack details");
  });
  app.use(notFoundHandler);
  app.use(errorHandler({ exposeInternal, logger: createLogger("silent") }));
  return app;
}

describe("errorHandler", () => {
  it("maps every AppError code to its status and envelope", async () => {
    const app = appWith(false);
    for (const code of ERROR_CODES) {
      const res = await request(app).get(`/throw/${code}`).set("x-request-id", `rid-${code}`);
      expect(res.status).toBe(statusFor(code));
      expect(res.body.error.code).toBe(code);
      expect(res.body.error.message).toBe(`message for ${code}`);
      expect(res.body.error.requestId).toBe(`rid-${code}`);
      expect(res.headers["x-request-id"]).toBe(`rid-${code}`);
      if (code === "VALIDATION_ERROR") {
        expect(res.body.error.details).toEqual([]);
      } else {
        expect(res.body.error).not.toHaveProperty("details");
      }
    }
  });

  it("maps zod errors to VALIDATION_ERROR with per-field details", async () => {
    const res = await request(appWith(false)).get("/zod");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toEqual([{ path: "title", message: expect.any(String) }]);
  });

  it("hides internal messages unless exposeInternal", async () => {
    const hidden = await request(appWith(false)).get("/boom");
    expect(hidden.status).toBe(500);
    expect(hidden.body.error).toEqual({
      code: "INTERNAL",
      message: "Internal server error",
      requestId: expect.any(String),
    });
    const shown = await request(appWith(true)).get("/boom");
    expect(shown.body.error.message).toBe("secret stack details");
  });

  it("returns NOT_FOUND for unknown routes with a generated request id", async () => {
    const res = await request(appWith(false)).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers["x-request-id"]).toBe(res.body.error.requestId);
  });
});
