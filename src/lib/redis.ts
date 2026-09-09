import { Redis, type RedisOptions } from "ioredis";

/**
 * ioredis client suited to BullMQ by default (maxRetriesPerRequest must be null for workers).
 * Callers may pass through any ioredis option, e.g. the app's own connection overrides
 * maxRetriesPerRequest and sets a commandTimeout so a Redis outage surfaces as an error
 * instead of hanging requests forever.
 */
export function createRedis(
  url: string,
  options: { lazyConnect?: boolean } & Partial<RedisOptions> = {},
): Redis {
  const { lazyConnect, ...rest } = options;
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: lazyConnect ?? false,
    ...rest,
  });
}
