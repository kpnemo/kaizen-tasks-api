import type { Redis } from "ioredis";
import type { Config } from "../config.js";

export type RateLimitConfig = Pick<
  Config,
  "AI_ENABLED" | "AI_RATE_LIMIT_PER_HOUR" | "AI_GLOBAL_LIMIT_PER_HOUR"
>;

export interface ConsumeResult {
  allowed: boolean;
  reason: "ok" | "ai_disabled" | "rate_limited";
  scope: "user" | "global";
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface RateLimiter {
  consume(userId: string): Promise<ConsumeResult>;
}

const WINDOW_SECONDS = 3600;

export function hourBucket(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}`;
}

export function nextHourIso(now: Date): string {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.toISOString();
}

async function incrWithTtl(redis: Redis, key: string): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SECONDS);
  return count;
}

/**
 * Checks AI_ENABLED, then the per-user hourly counter, then the global hourly counter.
 * A denial on either scope decrements what it incremented.
 */
export function createRateLimiter(
  redis: Redis,
  config: RateLimitConfig,
  now: () => Date = () => new Date(),
): RateLimiter {
  return {
    async consume(userId) {
      const at = now();
      const resetAt = nextHourIso(at);
      if (!config.AI_ENABLED) {
        return {
          allowed: false,
          reason: "ai_disabled",
          scope: "global",
          limit: 0,
          remaining: 0,
          resetAt,
        };
      }
      const bucket = hourBucket(at);
      const userKey = `ratelimit:breakdown:${userId}:${bucket}`;
      const globalKey = `ratelimit:breakdown:global:${bucket}`;

      const userCount = await incrWithTtl(redis, userKey);
      if (userCount > config.AI_RATE_LIMIT_PER_HOUR) {
        await redis.decr(userKey);
        return {
          allowed: false,
          reason: "rate_limited",
          scope: "user",
          limit: config.AI_RATE_LIMIT_PER_HOUR,
          remaining: 0,
          resetAt,
        };
      }

      const globalCount = await incrWithTtl(redis, globalKey);
      if (globalCount > config.AI_GLOBAL_LIMIT_PER_HOUR) {
        await redis.decr(globalKey);
        await redis.decr(userKey);
        return {
          allowed: false,
          reason: "rate_limited",
          scope: "global",
          limit: config.AI_GLOBAL_LIMIT_PER_HOUR,
          remaining: 0,
          resetAt,
        };
      }

      return {
        allowed: true,
        reason: "ok",
        scope: "user",
        limit: config.AI_RATE_LIMIT_PER_HOUR,
        remaining: config.AI_RATE_LIMIT_PER_HOUR - userCount,
        resetAt,
      };
    },
  };
}
