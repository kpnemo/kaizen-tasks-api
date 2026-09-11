import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineStore, type PipelineStore } from "../../src/lib/pipeline-locks.js";

let redis: Redis;
let store: PipelineStore;
beforeAll(() => {
  redis = new Redis(process.env.REDIS_URL ?? "");
  store = createPipelineStore(redis);
});
afterAll(() => redis.quit());

describe("the pipeline store", () => {
  it("hands out one refresh lock as a token and releases it only for its holder", async () => {
    const token = await store.tryRefreshLock();
    expect(token).toEqual(expect.any(String));
    expect(await store.tryRefreshLock()).toBeNull();
    await store.releaseRefreshLock("someone-else");
    expect(await redis.get("pipeline:refreshing")).toBe(token);
    await store.releaseRefreshLock(token!);
    expect(await redis.get("pipeline:refreshing")).toBeNull();
    expect(await store.tryRefreshLock()).toEqual(expect.any(String));
  });

  it("creates a ship record once and can mark it unknown without losing it", async () => {
    const record = {
      requestId: "abc-r1",
      version: "1.4.0",
      issues: [22],
      state: "dispatched" as const,
    };
    expect(await store.createShip(record, { retryOf: "abc" })).toBe(true);
    expect(await store.createShip(record, { retryOf: "abc" })).toBe(false);
    expect(await store.readShip("abc-r1")).toEqual(record);
    expect(await store.readLatestShip()).toEqual(record);
    expect(await store.readRetry("abc")).toEqual(record);
    await store.markShipUnknown("abc-r1");
    expect(await store.readShip("abc-r1")).toEqual({ ...record, state: "unknown" });
    expect(await redis.ttl("pipeline:ship:abc-r1")).toBeGreaterThan(500);
  });

  it("keeps a cooldown with its reason and expiry", async () => {
    expect(await store.readCooldown()).toBeNull();
    await store.setCooldown("GitHub answered 503", 60);
    expect(await store.readCooldown()).toBe("GitHub answered 503");
    expect(await redis.ttl("pipeline:cooldown")).toBeGreaterThan(50);
    const state = await store.readState();
    expect(state).toEqual({ snapshot: null, lastGood: null, cooldown: "GitHub answered 503" });
  });

  it("caches compare answers per pair for an hour", async () => {
    await store.writeCompares([{ key: "pipeline:compare:api:served:merge1", status: "behind" }]);
    expect(
      await store.readCompares([
        "pipeline:compare:api:served:merge1",
        "pipeline:compare:api:served:merge2",
      ]),
    ).toEqual(["behind", null]);
    expect(await redis.ttl("pipeline:compare:api:served:merge1")).toBeGreaterThan(3500);
  });
});
