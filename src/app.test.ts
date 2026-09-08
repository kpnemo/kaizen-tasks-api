import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";

const env = {
  DATABASE_URL: "postgres://localhost:5432/kaizen_test",
  REDIS_URL: "redis://localhost:6379/1",
  JWT_SECRET: "x".repeat(32),
  AI_MODEL_PROVIDER: "fake",
  APP_ENV: "test",
  RAILWAY_GIT_COMMIT_SHA: "abc123",
};
const config = loadConfig(env);

const okProbes = { db: async () => {}, redis: async () => {} };

describe("createApp", () => {
  it("serves health with the commit SHA, env, checks and feature flags", async () => {
    const app = createApp({ config, logger: createLogger("silent"), probes: okProbes });
    const res = await request(app).get("/api/v1/health");
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
    const configured = loadConfig({
      ...env,
      GITHUB_TOKEN: "ghp_test_token",
      GITHUB_REPO: "kpnemo/kaizen-tasks-assembly-line",
    });
    const app = createApp({ config: configured, logger: createLogger("silent"), probes: okProbes });
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.data.features).toEqual({ featureRequests: true });
  });

  it("returns 503 UNAVAILABLE naming the failing check", async () => {
    const app = createApp({
      config,
      logger: createLogger("silent"),
      probes: {
        ...okProbes,
        redis: async () => {
          throw new Error("down");
        },
      },
    });
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("UNAVAILABLE");
    expect(res.body.error.message).toBe("Health check failed: redis");
  });

  it("serves the committed openapi.json", async () => {
    const app = createApp({ config, logger: createLogger("silent"), probes: okProbes });
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
  });

  it("echoes x-request-id in the error envelope of unknown routes", async () => {
    const app = createApp({ config, logger: createLogger("silent"), probes: okProbes });
    const res = await request(app).get("/api/v1/nothing").set("x-request-id", "trace-me");
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: "NOT_FOUND",
      message: "Route GET /api/v1/nothing not found",
      requestId: "trace-me",
    });
  });
});
