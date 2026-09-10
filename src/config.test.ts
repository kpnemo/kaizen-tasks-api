import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, isSecureCookieEnv, loadConfig } from "./config.js";

const valid = {
  DATABASE_URL: "postgres://localhost:5432/kaizen_test",
  REDIS_URL: "redis://localhost:6379/1",
  JWT_SECRET: "x".repeat(32),
  AI_MODEL_PROVIDER: "fake",
};

describe("loadConfig", () => {
  it("lists every missing required variable in one error", () => {
    let caught: unknown;
    try {
      loadConfig({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const problems = (caught as ConfigError).problems;
    expect(problems.some((p) => p.startsWith("DATABASE_URL:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("REDIS_URL:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("JWT_SECRET:"))).toBe(true);
    expect((caught as ConfigError).message).toContain("DATABASE_URL");
  });

  it("requires ANTHROPIC_API_KEY unless the provider is fake", () => {
    expect(() => loadConfig({ ...valid, AI_MODEL_PROVIDER: "anthropic" })).toThrow(ConfigError);
    expect(
      loadConfig({ ...valid, AI_MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" })
        .ANTHROPIC_API_KEY,
    ).toBe("sk-test");
    expect(loadConfig(valid).AI_MODEL_PROVIDER).toBe("fake");
  });

  it("applies defaults and coerces numbers and booleans", () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(3000);
    expect(config.AI_RATE_LIMIT_PER_HOUR).toBe(20);
    expect(config.AI_GLOBAL_LIMIT_PER_HOUR).toBe(300);
    expect(config.AI_ENABLED).toBe(true);
    expect(config.AI_STALE_MINUTES).toBe(10);
    expect(config.INTERVIEW_HOURLY_LIMIT).toBe(60);
    expect(config.AI_MODEL).toBe("claude-sonnet-5");
    expect(config.APP_ENV).toBe("development");
    expect(config.WORKER_ENABLED).toBe(true);
    expect(config.SEED_DEMO_USER).toBe(false);
    expect(config.SEED_DEMO_PASSWORD).toBe("kaizen-demo-2026");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.RAILWAY_GIT_COMMIT_SHA).toBe("local");
    const overridden = loadConfig({
      ...valid,
      PORT: "4010",
      AI_ENABLED: "false",
      WORKER_ENABLED: "0",
    });
    expect(overridden.PORT).toBe(4010);
    expect(overridden.AI_ENABLED).toBe(false);
    expect(overridden.WORKER_ENABLED).toBe(false);
  });

  it("treats empty strings as unset and rejects short secrets", () => {
    expect(loadConfig({ ...valid, ADMIN_TOKEN: "" }).ADMIN_TOKEN).toBeUndefined();
    expect(() => loadConfig({ ...valid, ADMIN_TOKEN: "short" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, JWT_SECRET: "short" })).toThrow(ConfigError);
  });

  it("takes INTERVIEW_HOURLY_LIMIT as a positive integer", () => {
    expect(loadConfig({ ...valid, INTERVIEW_HOURLY_LIMIT: "5" }).INTERVIEW_HOURLY_LIMIT).toBe(5);
    expect(() => loadConfig({ ...valid, INTERVIEW_HOURLY_LIMIT: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, INTERVIEW_HOURLY_LIMIT: "x" })).toThrow(ConfigError);
  });

  it("marks cookies secure outside development and test", () => {
    expect(isSecureCookieEnv(loadConfig(valid))).toBe(false);
    expect(isSecureCookieEnv(loadConfig({ ...valid, APP_ENV: "test" }))).toBe(false);
    expect(isSecureCookieEnv(loadConfig({ ...valid, APP_ENV: "staging" }))).toBe(true);
    expect(isSecureCookieEnv(loadConfig({ ...valid, APP_ENV: "production" }))).toBe(true);
  });
});

const OPERATOR_VARIABLES = [
  "AI_ENABLED",
  "AI_RATE_LIMIT_PER_HOUR",
  "AI_GLOBAL_LIMIT_PER_HOUR",
  "AI_STALE_MINUTES",
  "INTERVIEW_HOURLY_LIMIT",
] as const;

describe("the operator surface", () => {
  const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

  it("documents every tunable AI variable in .env.example and the Railway declaration", () => {
    const example = read("../.env.example");
    const railway = read("../.railway/railway.ts");
    for (const name of OPERATOR_VARIABLES) {
      expect(example, `${name} in .env.example`).toContain(`${name}=`);
      expect(railway, `${name} in .railway/railway.ts`).toContain(`${name}:`);
    }
    expect(example).toContain("INTERVIEW_HOURLY_LIMIT=60");
    expect(railway).toContain('INTERVIEW_HOURLY_LIMIT: "60"');
  });

  it("never writes a secret into the Railway declaration", () => {
    const railway = read("../.railway/railway.ts");
    for (const secret of [
      "JWT_SECRET",
      "ANTHROPIC_API_KEY",
      "ADMIN_TOKEN",
      "SEED_DEMO_PASSWORD",
      "GITHUB_TOKEN",
      "GITHUB_REPO",
    ]) {
      expect(railway, secret).toContain(`${secret}: preserve()`);
    }
  });
});
