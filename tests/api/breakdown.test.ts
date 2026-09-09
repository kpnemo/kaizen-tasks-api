import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ModelRetryableError } from "../../src/agent/errors.js";
import { tasks } from "../../src/db/schema.js";
import { AI_ERROR_MESSAGES } from "../../src/jobs/processors/breakdown.js";
import { nextHourIso } from "../../src/lib/rate-limit.js";
import { ENQUEUE_FAILED_MESSAGE } from "../../src/services/tasks.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser, type TestUser } from "../helpers/auth.js";
import { createTask } from "../helpers/tasks.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
beforeEach(() => {
  ctx.queue.jobs.length = 0;
  ctx.queue.failNext = false;
  ctx.model.mode = "ok";
  ctx.model.calls.length = 0;
});
afterAll(() => ctx.close());

const TASKS = "/api/v1/tasks";
const breakdown = (c: TestContext, user: TestUser, id: string) =>
  request(c.app).post(`${TASKS}/${id}/breakdown`).set(auth(user.token));
const get = (c: TestContext, user: TestUser, id: string) =>
  request(c.app).get(`${TASKS}/${id}`).set(auth(user.token));

describe("processor through the fake queue", () => {
  it("writes suggested children with rationale, tag suggestions not already on the task, and aiStatus done", async () => {
    const user = await registerUser(ctx.app);
    const tag = await request(ctx.app)
      .post("/api/v1/tags")
      .set(auth(user.token))
      .send({ name: "Planning", color: "#666666" });
    const task = await createTask(ctx.app, user.token, {
      title: "Plan the Q4 team offsite",
      tagIds: [tag.body.data.id],
    });
    expect(await ctx.runQueue()).toBe(1);
    const res = await get(ctx, user, task.id);
    expect(res.body.data.aiStatus).toBe("done");
    expect(res.body.data.aiError).toBeNull();
    expect(res.body.data.children).toHaveLength(4);
    expect(res.body.data.suggestionCount).toBe(4);
    for (const child of res.body.data.children) {
      expect(child).toMatchObject({
        origin: "ai",
        suggestionState: "suggested",
        aiStatus: "skipped",
      });
      expect(child.rationale).toEqual(expect.any(String));
    }
    expect(res.body.data.children.map((c: { position: number }) => c.position)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(res.body.data.aiTagSuggestions).toEqual(["writing"]);
    expect(ctx.model.calls[0]).toMatchObject({
      title: "Plan the Q4 team offsite",
      tags: ["Planning"],
      existingSteps: [],
    });
  });

  it("passes existing steps and up to 30 open root titles to the model", async () => {
    const user = await registerUser(ctx.app);
    // Inserted directly: 32 root creates through the API would exhaust the per-user AI limit (20 per hour)
    // and the 33rd create would be skipped with reason rate_limited instead of enqueuing a job.
    await ctx.db.insert(tasks).values(
      Array.from({ length: 32 }, (_, i) => ({
        userId: user.userId,
        title: `Open task number ${i}`,
        aiStatus: "skipped" as const,
      })),
    );
    const task = await createTask(ctx.app, user.token, { title: "The one being broken down" });
    await createTask(ctx.app, user.token, { title: "Existing manual step", parentId: task.id });
    await ctx.runQueue();
    const call = ctx.model.calls.at(-1)!;
    expect(call.existingSteps).toEqual(["Existing manual step"]);
    expect(call.openTasks).toHaveLength(30);
    expect(call.openTasks).not.toContain("The one being broken down");
  });

  it("skips titles under three words with an empty description", async () => {
    const user = await registerUser(ctx.app);
    const task = await createTask(ctx.app, user.token, { title: "Buy milk" });
    await ctx.runQueue();
    const res = await get(ctx, user, task.id);
    expect(res.body.data).toMatchObject({
      aiStatus: "skipped",
      aiSkipReason: "too_short",
      children: [],
    });
  });

  it("marks refusals and invalid answers failed with a human-readable message", async () => {
    const user = await registerUser(ctx.app);
    ctx.model.mode = "refuse";
    const refused = await createTask(ctx.app, user.token, {
      title: "Something the model declines",
    });
    await ctx.runQueue();
    expect((await get(ctx, user, refused.id)).body.data).toMatchObject({
      aiStatus: "failed",
      aiError: AI_ERROR_MESSAGES.refused,
    });

    ctx.model.mode = "invalid";
    const invalid = await createTask(ctx.app, user.token, { title: "Something the model garbles" });
    await ctx.runQueue();
    expect((await get(ctx, user, invalid.id)).body.data).toMatchObject({
      aiStatus: "failed",
      aiError: AI_ERROR_MESSAGES.invalid,
    });
    ctx.model.mode = "ok";
  });

  it("rethrows retryable failures and leaves the task running for the queue to retry", async () => {
    const user = await registerUser(ctx.app);
    ctx.model.mode = "retryable-error";
    const task = await createTask(ctx.app, user.token, { title: "Upstream is flaky today" });
    await expect(ctx.runQueue()).rejects.toBeInstanceOf(ModelRetryableError);
    expect((await get(ctx, user, task.id)).body.data.aiStatus).toBe("running");
    ctx.model.mode = "ok";
  });

  it("writes nothing when the job's generation no longer owns the task", async () => {
    const user = await registerUser(ctx.app);
    const task = await createTask(ctx.app, user.token, { title: "Superseded before it ran" });
    const newer = randomUUID();
    await ctx.db.update(tasks).set({ generationId: newer }).where(eq(tasks.id, task.id));
    await ctx.runQueue();
    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row).toMatchObject({ aiStatus: "pending", generationId: newer });
    expect((await get(ctx, user, task.id)).body.data.children).toEqual([]);
    expect(ctx.model.calls.some((c) => c.title === "Superseded before it ran")).toBe(false);
  });
});

describe("POST /tasks/:id/breakdown", () => {
  it("two calls in quick succession yield one 202 and one CONFLICT", async () => {
    const user = await registerUser(ctx.app);
    const task = await createTask(ctx.app, user.token, { title: "Regenerate this task please" });
    await ctx.runQueue();
    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    const oldGeneration = row?.generationId;

    const [a, b] = await Promise.all([
      breakdown(ctx, user, task.id),
      breakdown(ctx, user, task.id),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const accepted = a.status === 202 ? a : b;
    const rejected = a.status === 409 ? a : b;
    expect(accepted.body.data).toMatchObject({
      aiStatus: "pending",
      aiError: null,
      aiSkipReason: null,
    });
    expect(rejected.body.error.code).toBe("CONFLICT");
    expect(ctx.queue.jobs).toHaveLength(1);
    expect(ctx.queue.jobs[0]).toMatchObject({
      taskId: task.id,
      userId: user.userId,
      reason: "regenerate",
    });
    expect(ctx.queue.jobs[0]?.generationId).not.toBe(oldGeneration);
  });

  it("returns RATE_LIMITED past the user limit with the documented details", async () => {
    const limited = await createTestApp({ AI_RATE_LIMIT_PER_HOUR: 1 });
    try {
      const user = await registerUser(limited.app);
      const task = await createTask(limited.app, user.token, { title: "Consumes the only slot" });
      await limited.runQueue();
      const res = await breakdown(limited, user, task.id);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("RATE_LIMITED");
      expect(res.body.error.details).toEqual({
        scope: "user",
        limit: 1,
        resetAt: expect.any(String),
      });
      expect(new Date(res.body.error.details.resetAt).getUTCMinutes()).toBe(0);
      expect(res.body.error.details.resetAt).toBe(nextHourIso(new Date()));
    } finally {
      await limited.close();
    }
  });

  it("returns RATE_LIMITED with scope global past the environment budget", async () => {
    const budget = await createTestApp({ AI_RATE_LIMIT_PER_HOUR: 20, AI_GLOBAL_LIMIT_PER_HOUR: 1 });
    try {
      const a = await registerUser(budget.app);
      const b = await registerUser(budget.app);
      await createTask(budget.app, a.token, { title: "Spends the whole budget" });
      const task = await createTask(budget.app, b.token, { title: "Arrives after the budget" });
      expect(task.aiStatus).toBe("skipped");
      expect(task.aiSkipReason).toBe("rate_limited");
      const res = await breakdown(budget, b, task.id);
      expect(res.status).toBe(429);
      expect(res.body.error.details).toEqual({
        scope: "global",
        limit: 1,
        resetAt: expect.any(String),
      });
    } finally {
      await budget.close();
    }
  });

  it("returns UNAVAILABLE 'AI is paused' when AI_ENABLED is false", async () => {
    const paused = await createTestApp({ AI_ENABLED: false });
    try {
      const user = await registerUser(paused.app);
      const task = await createTask(paused.app, user.token, { title: "Nothing happens here" });
      const res = await breakdown(paused, user, task.id);
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: "UNAVAILABLE", message: "AI is paused" });
    } finally {
      await paused.close();
    }
  });

  it("rejects children, hides foreign tasks, and records enqueue failures", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const root = await createTask(ctx.app, owner.token, { title: "Root for breakdown rules" });
    const child = await createTask(ctx.app, owner.token, { title: "A child", parentId: root.id });
    await ctx.runQueue();
    const onChild = await breakdown(ctx, owner, child.id);
    expect(onChild.status).toBe(400);
    expect(onChild.body.error.details[0].message).toBe("Only top-level tasks can be broken down");
    expect((await breakdown(ctx, other, root.id)).status).toBe(404);

    ctx.queue.failNext = true;
    const failed = await breakdown(ctx, owner, root.id);
    expect(failed.status).toBe(202);
    expect(failed.body.data).toMatchObject({ aiStatus: "failed", aiError: ENQUEUE_FAILED_MESSAGE });
  });
});
