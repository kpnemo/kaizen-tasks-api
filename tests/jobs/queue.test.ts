import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import {
  breakdownJobId,
  createBreakdownQueue,
  type BreakdownBullQueue,
  type BreakdownQueue,
} from "../../src/jobs/queue.js";
import { createRedis } from "../../src/lib/redis.js";

let connection: Redis;
let queue: BreakdownQueue & { queue: BreakdownBullQueue };

beforeEach(() => {
  connection = createRedis(process.env.REDIS_URL ?? "");
  queue = createBreakdownQueue(connection);
});

afterEach(async () => {
  await queue.close();
  await connection.quit();
});

describe("breakdown queue", () => {
  it("adds a job whose id is <taskId>-<generationId> with the spec options (V6, part 1)", async () => {
    const taskId = randomUUID();
    const generationId = randomUUID();
    await queue.enqueueBreakdown({ taskId, userId: randomUUID(), generationId, reason: "create" });

    const job = await queue.queue.getJob(breakdownJobId(taskId, generationId));
    expect(job).toBeDefined();
    expect(job?.id).toBe(`${taskId}-${generationId}`);
    expect(job?.data.reason).toBe("create");
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toEqual({ type: "exponential", delay: 3000 });
    expect(job?.opts.removeOnComplete).toBe(true);
    expect(job?.opts.removeOnFail).toEqual({ count: 100 });
    expect(await queue.queue.getWaitingCount()).toBe(1);
  });

  it("keeps its keys under the kaizen prefix", async () => {
    await queue.enqueueBreakdown({
      taskId: randomUUID(),
      userId: randomUUID(),
      generationId: randomUUID(),
      reason: "regenerate",
    });
    const keys = await connection.keys("kaizen:breakdown:*");
    expect(keys.length).toBeGreaterThan(0);
  });
});
