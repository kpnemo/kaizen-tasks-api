import { Redis } from "ioredis";

/** ioredis client suited to BullMQ (maxRetriesPerRequest must be null for workers). */
export function createRedis(url: string, options: { lazyConnect?: boolean } = {}): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: options.lazyConnect ?? false,
  });
}
