import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInterviewRateLimiter,
  createRateLimiter,
  hourBucket,
  nextHourIso,
} from "../../src/lib/rate-limit.js";
import { createRedis } from "../../src/lib/redis.js";

let redis: Redis;
beforeAll(() => {
  redis = createRedis(process.env.REDIS_URL ?? "");
});
afterAll(() => redis.quit());

const NOW = new Date("2026-09-08T10:17:00.000Z");
const limiter = (user: number, global: number, enabled = true) =>
  createRateLimiter(
    redis,
    { AI_ENABLED: enabled, AI_RATE_LIMIT_PER_HOUR: user, AI_GLOBAL_LIMIT_PER_HOUR: global },
    () => NOW,
  );

describe("hour helpers", () => {
  it("buckets by UTC hour and resets at the next hour", () => {
    expect(hourBucket(NOW)).toBe("2026090810");
    expect(nextHourIso(NOW)).toBe("2026-09-08T11:00:00.000Z");
  });
});

describe("consume", () => {
  it("allows up to the user limit, then denies with scope user and the reset time", async () => {
    const userId = randomUUID();
    const rl = limiter(2, 100);
    const first = await rl.consume(userId);
    expect(first).toEqual({
      allowed: true,
      reason: "ok",
      scope: "user",
      limit: 2,
      remaining: 1,
      resetAt: "2026-09-08T11:00:00.000Z",
    });
    expect((await rl.consume(userId)).remaining).toBe(0);
    const denied = await rl.consume(userId);
    expect(denied).toEqual({
      allowed: false,
      reason: "rate_limited",
      scope: "user",
      limit: 2,
      remaining: 0,
      resetAt: "2026-09-08T11:00:00.000Z",
    });
    // a denial does not count: the key stays at the limit
    expect(await redis.get(`ratelimit:breakdown:${userId}:2026090810`)).toBe("2");
    expect(await redis.get("ratelimit:breakdown:global:2026090810")).toBe("2");
  });

  it("denies with scope global past the environment budget and undoes both increments", async () => {
    const rl = limiter(10, 3);
    const a = randomUUID();
    const b = randomUUID();
    await rl.consume(a);
    await rl.consume(a);
    await rl.consume(b);
    const denied = await rl.consume(b);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("rate_limited");
    expect(denied.scope).toBe("global");
    expect(denied.limit).toBe(3);
    expect(await redis.get("ratelimit:breakdown:global:2026090810")).toBe("3");
    expect(await redis.get(`ratelimit:breakdown:${b}:2026090810`)).toBe("1");
  });

  it("reports ai_disabled without touching Redis when AI_ENABLED is false", async () => {
    const userId = randomUUID();
    const result = await limiter(10, 10, false).consume(userId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("ai_disabled");
    expect(await redis.keys("ratelimit:*")).toEqual([]);
  });

  it("sets a one-hour TTL on new keys", async () => {
    const userId = randomUUID();
    await limiter(5, 5).consume(userId);
    const ttl = await redis.ttl(`ratelimit:breakdown:${userId}:2026090810`);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });
});

const interview = (limit: number, enabled = true) =>
  createInterviewRateLimiter(
    redis,
    { AI_ENABLED: enabled, INTERVIEW_HOURLY_LIMIT: limit },
    () => NOW,
  );

describe("createInterviewRateLimiter", () => {
  it("counts on its own key so the breakdown limiter is untouched", async () => {
    const userId = randomUUID();
    const rl = interview(2);
    expect((await rl.consume(userId)).allowed).toBe(true);
    expect(await redis.get(`ratelimit:interview:${userId}:${hourBucket(NOW)}`)).toBe("1");
    expect(await redis.get(`ratelimit:breakdown:${userId}:${hourBucket(NOW)}`)).toBeNull();
    expect(await redis.ttl(`ratelimit:interview:${userId}:${hourBucket(NOW)}`)).toBeGreaterThan(0);
  });

  it("allows up to the hourly limit, then denies with scope user and the reset time", async () => {
    const userId = randomUUID();
    const rl = interview(2);
    expect(await rl.consume(userId)).toEqual({
      allowed: true,
      reason: "ok",
      scope: "user",
      limit: 2,
      remaining: 1,
      resetAt: "2026-09-08T11:00:00.000Z",
    });
    expect((await rl.consume(userId)).remaining).toBe(0);
    expect(await rl.consume(userId)).toEqual({
      allowed: false,
      reason: "rate_limited",
      scope: "user",
      limit: 2,
      remaining: 0,
      resetAt: "2026-09-08T11:00:00.000Z",
    });
  });

  it("decrements what a denial incremented, so the counter never runs away", async () => {
    const userId = randomUUID();
    const rl = interview(1);
    await rl.consume(userId);
    await rl.consume(userId);
    await rl.consume(userId);
    expect(await redis.get(`ratelimit:interview:${userId}:${hourBucket(NOW)}`)).toBe("1");
  });

  it("honours the AI_ENABLED kill switch without touching Redis", async () => {
    const userId = randomUUID();
    const result = await interview(60, false).consume(userId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("ai_disabled");
    expect(await redis.get(`ratelimit:interview:${userId}:${hourBucket(NOW)}`)).toBeNull();
  });

  it("counts each user separately", async () => {
    const rl = interview(1);
    expect((await rl.consume(randomUUID())).allowed).toBe(true);
    expect((await rl.consume(randomUUID())).allowed).toBe(true);
  });
});
