import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

/**
 * The pipeline's Redis state: the shared snapshot and its last-good copy, the one-refresher lock
 * and the cooldown after a failed refresh, the one-action lock, the passphrase lockout counters,
 * the ship records the API wrote before dispatching, and the compare answers (immutable per pair).
 * Nothing here must survive a flush: a lost snapshot is rebuilt, a lost lock expires in seconds,
 * a lost ship record is reconciled from the run name.
 */
export const PIPELINE_KEYS = {
  snapshot: "pipeline:snapshot",
  lastGood: "pipeline:last-good",
  refreshing: "pipeline:refreshing",
  cooldown: "pipeline:cooldown",
  action: "pipeline:action",
  latestShip: "pipeline:ship:latest",
  lockout: (userId: string) => `pipeline:lockout:${userId}`,
  ship: (requestId: string) => `pipeline:ship:${requestId}`,
  /** The newest retry attempt recorded for a ship, by the original request id. */
  retryOf: (requestId: string) => `pipeline:ship:retry:${requestId}`,
  compare: (repo: string, served: string, mergeSha: string) =>
    `pipeline:compare:${repo}:${served}:${mergeSha}`,
} as const;

export const SNAPSHOT_TTL_SECONDS = 30;
export const LAST_GOOD_TTL_SECONDS = 3600;
export const REFRESH_LOCK_SECONDS = 20;
export const COOLDOWN_SECONDS = 60;
export const COOLDOWN_MAX_SECONDS = 3600;
export const ACTION_LOCK_SECONDS = 60;
export const LOCKOUT_WINDOW_SECONDS = 600;
export const LOCKOUT_LIMIT = 5;
export const SHIP_RECORD_TTL_SECONDS = 600;
export const COMPARE_TTL_SECONDS = 3600;

/** Releases a lock only when it still holds our value, in one round trip. */
const RELEASE_IF_OWNED = `
if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end
return 0`;

export interface ShipRecord {
  requestId: string;
  version: string;
  issues: number[];
  /** `dispatched` once GitHub accepted the dispatch; `unknown` when the call threw after the
   *  record was written, so the next snapshot reconciles by run name and nothing re-dispatches. */
  state: "dispatched" | "unknown";
}

export interface PipelineStore {
  /** Snapshot, last-good and cooldown in one round trip. */
  readState(): Promise<{
    snapshot: string | null;
    lastGood: string | null;
    cooldown: string | null;
  }>;
  readSnapshot(): Promise<string | null>;
  readLastGood(): Promise<string | null>;
  writeSnapshot(json: string): Promise<void>;
  /** The lock token when acquired, else null. */
  tryRefreshLock(): Promise<string | null>;
  releaseRefreshLock(token: string): Promise<void>;
  setCooldown(reason: string, seconds: number): Promise<void>;
  readCooldown(): Promise<string | null>;
  invalidate(): Promise<void>;
  /** Failures so far and the seconds until the window closes (-1 when there is no window). */
  lockout(userId: string): Promise<{ count: number; ttlSeconds: number }>;
  recordFailure(userId: string): Promise<{ count: number; ttlSeconds: number }>;
  tryActionLock(requestId: string): Promise<boolean>;
  releaseActionLock(requestId: string): Promise<void>;
  /** `SET NX`: false when a record with that request id already exists. */
  createShip(record: ShipRecord, options?: { retryOf?: string }): Promise<boolean>;
  markShipUnknown(requestId: string): Promise<void>;
  readLatestShip(): Promise<ShipRecord | null>;
  readShip(requestId: string): Promise<ShipRecord | null>;
  readRetry(requestId: string): Promise<ShipRecord | null>;
  readCompares(keys: string[]): Promise<(string | null)[]>;
  writeCompares(entries: { key: string; status: string }[]): Promise<void>;
}

export function createPipelineStore(redis: Redis): PipelineStore {
  const parseShip = (json: string | null): ShipRecord | null => {
    if (!json) return null;
    try {
      const value = JSON.parse(json) as {
        requestId?: unknown;
        version?: unknown;
        issues?: unknown;
        state?: unknown;
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
        state: value.state === "unknown" ? "unknown" : "dispatched",
      };
    } catch {
      return null;
    }
  };
  const readShip = async (requestId: string) =>
    parseShip(await redis.get(PIPELINE_KEYS.ship(requestId)));
  return {
    async readState() {
      const [snapshot, lastGood, cooldown] = await redis.mget(
        PIPELINE_KEYS.snapshot,
        PIPELINE_KEYS.lastGood,
        PIPELINE_KEYS.cooldown,
      );
      return { snapshot: snapshot ?? null, lastGood: lastGood ?? null, cooldown: cooldown ?? null };
    },
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
      const token = randomUUID();
      const set = await redis.set(
        PIPELINE_KEYS.refreshing,
        token,
        "EX",
        REFRESH_LOCK_SECONDS,
        "NX",
      );
      return set === "OK" ? token : null;
    },
    async releaseRefreshLock(token) {
      await redis.eval(RELEASE_IF_OWNED, 1, PIPELINE_KEYS.refreshing, token);
    },
    async setCooldown(reason, seconds) {
      await redis.set(PIPELINE_KEYS.cooldown, reason, "EX", Math.max(1, Math.round(seconds)));
    },
    readCooldown: () => redis.get(PIPELINE_KEYS.cooldown),
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
    async createShip(record, options = {}) {
      const created = await redis.set(
        PIPELINE_KEYS.ship(record.requestId),
        JSON.stringify(record),
        "EX",
        SHIP_RECORD_TTL_SECONDS,
        "NX",
      );
      if (created !== "OK") return false;
      const pointers = redis
        .multi()
        .set(PIPELINE_KEYS.latestShip, record.requestId, "EX", SHIP_RECORD_TTL_SECONDS);
      if (options.retryOf) {
        pointers.set(
          PIPELINE_KEYS.retryOf(options.retryOf),
          record.requestId,
          "EX",
          SHIP_RECORD_TTL_SECONDS,
        );
      }
      await pointers.exec();
      return true;
    },
    async markShipUnknown(requestId) {
      const record = await readShip(requestId);
      if (!record) return;
      await redis.set(
        PIPELINE_KEYS.ship(requestId),
        JSON.stringify({ ...record, state: "unknown" }),
        "EX",
        SHIP_RECORD_TTL_SECONDS,
      );
    },
    async readLatestShip() {
      const requestId = await redis.get(PIPELINE_KEYS.latestShip);
      return requestId ? readShip(requestId) : null;
    },
    readShip,
    async readRetry(requestId) {
      const attempt = await redis.get(PIPELINE_KEYS.retryOf(requestId));
      return attempt ? readShip(attempt) : null;
    },
    async readCompares(keys) {
      if (keys.length === 0) return [];
      const values = await redis.mget(...keys);
      return values.map((value) => value ?? null);
    },
    async writeCompares(entries) {
      if (entries.length === 0) return;
      const pipeline = redis.multi();
      for (const { key, status } of entries) pipeline.set(key, status, "EX", COMPARE_TTL_SECONDS);
      await pipeline.exec();
    },
  };
}
