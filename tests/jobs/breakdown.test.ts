import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeBreakdownModel } from "../../src/agent/fake-model.js";
import { tasks } from "../../src/db/schema.js";
import { AI_ERROR_MESSAGES } from "../../src/jobs/processors/breakdown.js";
import {
  breakdownJobId,
  createBreakdownQueue,
  type BreakdownBullQueue,
  type BreakdownQueue,
} from "../../src/jobs/queue.js";
import { reconcileStaleGenerations, STALE_ERROR_MESSAGE } from "../../src/jobs/reconcile.js";
import { startBreakdownWorker, type BreakdownWorker } from "../../src/jobs/worker.js";
import { createLogger } from "../../src/lib/logger.js";
import { createRateLimiter } from "../../src/lib/rate-limit.js";
import { createRedis } from "../../src/lib/redis.js";
import { findOwnedTask, listChildren } from "../../src/repositories/tasks.js";
import { createTasksService, type TasksService } from "../../src/services/tasks.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { registerUser } from "../helpers/auth.js";

let ctx: TestContext;
let queueConnection: Redis;
let workerConnection: Redis;
let queue: BreakdownQueue & { queue: BreakdownBullQueue };
let worker: BreakdownWorker | undefined;
let model: FakeBreakdownModel;
let service: TasksService;
let completed: string[];
const logger = createLogger("silent");

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

beforeEach(() => {
  queueConnection = createRedis(process.env.REDIS_URL ?? "");
  workerConnection = createRedis(process.env.REDIS_URL ?? "");
  queue = createBreakdownQueue(queueConnection);
  model = new FakeBreakdownModel();
  completed = [];
  service = createTasksService({
    db: ctx.db,
    queue,
    rateLimiter: createRateLimiter(ctx.redis, ctx.config),
    logger,
  });
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  await queue.close();
  await queueConnection.quit();
  await workerConnection.quit();
});

function startWorker() {
  worker = startBreakdownWorker({ connection: workerConnection, db: ctx.db, model, logger });
  worker.on("completed", (job) => completed.push(String(job.id)));
  return worker;
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const row = (id: string, userId: string) => () => findOwnedTask(ctx.db, id, userId);

describe("real BullMQ worker", () => {
  it("processes a create job added through enqueueBreakdown to done with suggested children and tags (V6)", async () => {
    const user = await registerUser(ctx.server);
    startWorker();
    const task = await service.create(user.userId, { title: "Plan the Q4 team offsite" });
    expect(task.aiStatus).toBe("pending");
    const [pending] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    const expectedJobId = breakdownJobId(task.id, pending!.generationId!);
    expect(expectedJobId).toMatch(/^[0-9a-f-]{36}-[0-9a-f-]{36}$/);

    const done = await waitFor(row(task.id, user.userId), (t) => t?.aiStatus === "done");
    expect(done?.aiTagSuggestions).toEqual(["planning", "writing"]);
    const children = await listChildren(ctx.db, task.id);
    expect(children).toHaveLength(4);
    expect(
      children.every((c) => c.origin === "ai" && c.suggestionState === "suggested" && c.rationale),
    ).toBe(true);
    expect(completed).toContain(expectedJobId);
  });

  it("marks a refused breakdown failed with a message", async () => {
    const user = await registerUser(ctx.server);
    model.mode = "refuse";
    startWorker();
    const task = await service.create(user.userId, { title: "Something it will refuse" });
    const failed = await waitFor(row(task.id, user.userId), (t) => t?.aiStatus === "failed");
    expect(failed?.aiError).toBe(AI_ERROR_MESSAGES.refused);
  });

  it("regenerate replaces suggested children and keeps an accepted one", async () => {
    const user = await registerUser(ctx.server);
    startWorker();
    const task = await service.create(user.userId, { title: "Regenerate keeps accepted steps" });
    await waitFor(row(task.id, user.userId), (t) => t?.aiStatus === "done");
    const first = await listChildren(ctx.db, task.id);
    const kept = first[0]!;
    await service.update(user.userId, kept.id, { suggestionState: "accepted" });

    const again = await service.breakdown(user.userId, task.id);
    expect(again.aiStatus).toBe("pending");
    await waitFor(row(task.id, user.userId), (t) => t?.aiStatus === "done");
    await waitFor(
      () => listChildren(ctx.db, task.id),
      (c) => c.length === 5,
    );
    const after = await listChildren(ctx.db, task.id);
    expect(after.filter((c) => c.suggestionState === "accepted").map((c) => c.id)).toEqual([
      kept.id,
    ]);
    expect(after.filter((c) => c.suggestionState === "suggested")).toHaveLength(4);
    expect(after.filter((c) => first.some((f) => f.id === c.id && f.id !== kept.id))).toHaveLength(
      0,
    );
    expect(Math.max(...after.map((c) => c.position))).toBeGreaterThan(
      Math.max(...first.map((c) => c.position)),
    );
  });

  it("completes a job whose generation no longer matches without writing", async () => {
    const user = await registerUser(ctx.server);
    const task = await service.create(user.userId, {
      title: "Superseded before the worker starts",
    });
    const [pending] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    const staleJobId = breakdownJobId(task.id, pending!.generationId!);
    const newer = randomUUID();
    await ctx.db.update(tasks).set({ generationId: newer }).where(eq(tasks.id, task.id));

    startWorker();
    await waitFor(
      async () => completed,
      (c) => c.includes(staleJobId),
    );
    const [after] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after).toMatchObject({ aiStatus: "pending", generationId: newer });
    expect(await listChildren(ctx.db, task.id)).toEqual([]);
    expect(model.calls).toEqual([]);
  });
});

describe("reconciler", () => {
  it("fails generations stuck in pending or running past AI_STALE_MINUTES, keeping the generation id", async () => {
    const user = await registerUser(ctx.server);
    const old = new Date(Date.now() - 20 * 60_000);
    const stuckGeneration = randomUUID();
    const [stuck] = await ctx.db
      .insert(tasks)
      .values({
        userId: user.userId,
        title: "Stuck in running",
        aiStatus: "running",
        generationId: stuckGeneration,
        updatedAt: old,
      })
      .returning();
    const [fresh] = await ctx.db
      .insert(tasks)
      .values({
        userId: user.userId,
        title: "Fresh and running",
        aiStatus: "running",
        generationId: randomUUID(),
      })
      .returning();
    const [oldDone] = await ctx.db
      .insert(tasks)
      .values({ userId: user.userId, title: "Old but done", aiStatus: "done", updatedAt: old })
      .returning();

    expect(await reconcileStaleGenerations(ctx.db, 10, logger)).toBe(1);

    const [stuckAfter] = await ctx.db.select().from(tasks).where(eq(tasks.id, stuck!.id));
    expect(stuckAfter).toMatchObject({
      aiStatus: "failed",
      aiError: STALE_ERROR_MESSAGE,
      generationId: stuckGeneration,
    });
    expect(stuckAfter!.updatedAt.getTime()).toBeGreaterThan(old.getTime());
    expect((await ctx.db.select().from(tasks).where(eq(tasks.id, fresh!.id)))[0]?.aiStatus).toBe(
      "running",
    );
    expect((await ctx.db.select().from(tasks).where(eq(tasks.id, oldDone!.id)))[0]?.aiStatus).toBe(
      "done",
    );
    expect(await reconcileStaleGenerations(ctx.db, 10, logger)).toBe(0);
  });
});
