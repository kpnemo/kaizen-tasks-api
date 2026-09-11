import type { Redis } from "ioredis";

/**
 * The pipeline's Redis state: the shared snapshot and its last-good copy, the one-refresher lock,
 * the one-action lock, the passphrase lockout counters and the ship records the API wrote before
 * dispatching. Nothing here must survive a flush: a lost snapshot is rebuilt, a lost lock expires
 * in seconds, a lost ship record is reconciled from the run name.
 */
export const PIPELINE_KEYS = {
  snapshot: "pipeline:snapshot",
  lastGood: "pipeline:last-good",
  refreshing: "pipeline:refreshing",
  action: "pipeline:action",
  latestShip: "pipeline:ship:latest",
  lockout: (userId: string) => `pipeline:lockout:${userId}`,
  ship: (requestId: string) => `pipeline:ship:${requestId}`,
} as const;

export const SNAPSHOT_TTL_SECONDS = 10;
export const LAST_GOOD_TTL_SECONDS = 3600;
export const REFRESH_LOCK_SECONDS = 20;
export const ACTION_LOCK_SECONDS = 60;
export const LOCKOUT_WINDOW_SECONDS = 600;
export const LOCKOUT_LIMIT = 5;
export const SHIP_RECORD_TTL_SECONDS = 600;

/** Releases a lock only when it still holds our value, in one round trip. */
const RELEASE_IF_OWNED = `
if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end
return 0`;

export interface PipelineStore {
  readSnapshot(): Promise<string | null>;
  readLastGood(): Promise<string | null>;
  writeSnapshot(json: string): Promise<void>;
  tryRefreshLock(): Promise<boolean>;
  releaseRefreshLock(): Promise<void>;
  invalidate(): Promise<void>;
  /** Failures so far and the seconds until the window closes (-1 when there is no window). */
  lockout(userId: string): Promise<{ count: number; ttlSeconds: number }>;
  recordFailure(userId: string): Promise<{ count: number; ttlSeconds: number }>;
  tryActionLock(requestId: string): Promise<boolean>;
  releaseActionLock(requestId: string): Promise<void>;
  writeShip(record: { requestId: string; version: string; issues: number[] }): Promise<void>;
  readLatestShip(): Promise<{ requestId: string; version: string; issues: number[] } | null>;
  readShip(
    requestId: string,
  ): Promise<{ requestId: string; version: string; issues: number[] } | null>;
}

export function createPipelineStore(redis: Redis): PipelineStore {
  const parseShip = (json: string | null) => {
    if (!json) return null;
    try {
      const value = JSON.parse(json) as {
        requestId?: unknown;
        version?: unknown;
        issues?: unknown;
      };
      if (
        typeof value.requestId !== "string" ||
        typeof value.version !== "string" ||
        !Array.isArray(value.issues)
      ) {
        return null;
      }
      return {
        requestId: value.requestId,
        version: value.version,
        issues: value.issues.filter((n): n is number => typeof n === "number"),
      };
    } catch {
      return null;
    }
  };
  return {
    readSnapshot: () => redis.get(PIPELINE_KEYS.snapshot),
    readLastGood: () => redis.get(PIPELINE_KEYS.lastGood),
    async writeSnapshot(json) {
      await redis
        .multi()
        .set(PIPELINE_KEYS.snapshot, json, "EX", SNAPSHOT_TTL_SECONDS)
        .set(PIPELINE_KEYS.lastGood, json, "EX", LAST_GOOD_TTL_SECONDS)
        .exec();
    },
    async tryRefreshLock() {
      const set = await redis.set(PIPELINE_KEYS.refreshing, "1", "EX", REFRESH_LOCK_SECONDS, "NX");
      return set === "OK";
    },
    async releaseRefreshLock() {
      await redis.del(PIPELINE_KEYS.refreshing);
    },
    async invalidate() {
      await redis.del(PIPELINE_KEYS.snapshot);
    },
    async lockout(userId) {
      const key = PIPELINE_KEYS.lockout(userId);
      const [count, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
      return { count: Number(count ?? 0), ttlSeconds: ttl };
    },
    async recordFailure(userId) {
      const key = PIPELINE_KEYS.lockout(userId);
      const results = await redis
        .multi()
        .incr(key)
        .expire(key, LOCKOUT_WINDOW_SECONDS, "NX")
        .ttl(key)
        .exec();
      const incr = results?.[0];
      const ttl = results?.[2];
      if (!incr || incr[0]) throw incr?.[0] ?? new Error("lockout transaction returned no result");
      return { count: Number(incr[1]), ttlSeconds: Number(ttl?.[1] ?? LOCKOUT_WINDOW_SECONDS) };
    },
    async tryActionLock(requestId) {
      const set = await redis.set(PIPELINE_KEYS.action, requestId, "EX", ACTION_LOCK_SECONDS, "NX");
      return set === "OK";
    },
    async releaseActionLock(requestId) {
      await redis.eval(RELEASE_IF_OWNED, 1, PIPELINE_KEYS.action, requestId);
    },
    async writeShip(record) {
      const json = JSON.stringify(record);
      await redis
        .multi()
        .set(PIPELINE_KEYS.ship(record.requestId), json, "EX", SHIP_RECORD_TTL_SECONDS)
        .set(PIPELINE_KEYS.latestShip, record.requestId, "EX", SHIP_RECORD_TTL_SECONDS)
        .exec();
    },
    async readLatestShip() {
      const requestId = await redis.get(PIPELINE_KEYS.latestShip);
      return requestId ? parseShip(await redis.get(PIPELINE_KEYS.ship(requestId))) : null;
    },
    async readShip(requestId) {
      return parseShip(await redis.get(PIPELINE_KEYS.ship(requestId)));
    },
  };
}
