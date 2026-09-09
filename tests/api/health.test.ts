import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp({ RAILWAY_GIT_COMMIT_SHA: "abc123" });
});
afterAll(() => ctx.close());

describe("GET /api/v1/health", () => {
  it("reports the commit SHA, env, passing checks against real Postgres and Redis, and features", async () => {
    const res = await request(ctx.server).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        status: "ok",
        commit: "abc123",
        env: "test",
        checks: { db: "ok", redis: "ok" },
        features: { featureRequests: false },
      },
      meta: { requestId: expect.any(String) },
    });
  });

  it("reports features.featureRequests true when GITHUB_TOKEN and GITHUB_REPO are set", async () => {
    const configured = await createTestApp({
      GITHUB_TOKEN: "ghp_test_token",
      GITHUB_REPO: "kpnemo/kaizen-tasks-assembly-line",
    });
    try {
      const res = await request(configured.server).get("/api/v1/health");
      expect(res.status).toBe(200);
      expect(res.body.data.features).toEqual({ featureRequests: true });
    } finally {
      await configured.close();
    }
  });

  it("returns 503 UNAVAILABLE naming the failing check", async () => {
    const broken = await createTestApp(
      {},
      {
        probes: {
          redis: async () => {
            throw new Error("down");
          },
        },
      },
    );
    try {
      const res = await request(broken.server).get("/api/v1/health");
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("UNAVAILABLE");
      expect(res.body.error.message).toBe("Health check failed: redis");
    } finally {
      await broken.close();
    }
  });

  it("serves the committed openapi.json", async () => {
    const res = await request(ctx.server).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    // Paths are bare with `servers: /api/v1` (fixed in 5d7caa7, predates this brief's test literal).
    expect(res.body.paths["/tasks"]).toBeDefined();
  });

  it("carries the inbound request id in the error envelope", async () => {
    const res = await request(ctx.server).get("/api/v1/nothing").set("x-request-id", "trace-me");
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: "NOT_FOUND",
      message: "Route GET /api/v1/nothing not found",
      requestId: "trace-me",
    });
    expect(res.headers["x-request-id"]).toBe("trace-me");
  });
});
