import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taskTags, tasks } from "../../src/db/schema.js";
import { DEPTH_MESSAGE, ENQUEUE_FAILED_MESSAGE } from "../../src/services/tasks.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser } from "../helpers/auth.js";
import { createTask } from "../helpers/tasks.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const TASKS = "/api/v1/tasks";
const UUID = /^[0-9a-f-]{36}$/;

describe("POST /tasks", () => {
  it("root create enqueues a breakdown with reason create and returns pending with a generation id", async () => {
    const user = await registerUser(ctx.app);
    const task = await createTask(ctx.app, user.token, {
      title: "Plan the team offsite",
      description: "Three days",
    });
    expect(task).toMatchObject({
      parentId: null,
      title: "Plan the team offsite",
      description: "Three days",
      status: "todo",
      aiStatus: "pending",
      aiSkipReason: null,
      position: 0,
      origin: "user",
      suggestionState: null,
      rationale: null,
      tags: [],
      progress: { done: 0, total: 0 },
      suggestionCount: 0,
      children: [],
      aiTagSuggestions: [],
      aiError: null,
    });
    expect(ctx.queue.jobs).toHaveLength(1);
    const job = ctx.queue.jobs[0]!;
    expect(job).toEqual({
      taskId: task.id,
      userId: user.userId,
      generationId: expect.stringMatching(UUID),
      reason: "create",
    });
    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.generationId).toBe(job.generationId);
  });

  it("returns 201 with aiStatus failed when the queue is unavailable", async () => {
    const user = await registerUser(ctx.app);
    ctx.queue.failNext = true;
    ctx.queue.jobs.length = 0;
    const task = await createTask(ctx.app, user.token, { title: "Queue is down today" });
    expect(task.aiStatus).toBe("failed");
    expect(task.aiError).toBe(ENQUEUE_FAILED_MESSAGE);
    expect(ctx.queue.jobs).toHaveLength(0);
  });

  it("creates a child under a root with aiStatus skipped and no job; a grandchild fails with the depth message", async () => {
    const user = await registerUser(ctx.app);
    const root = await createTask(ctx.app, user.token, { title: "Root task here" });
    ctx.queue.jobs.length = 0;
    const child = await createTask(ctx.app, user.token, { title: "First step", parentId: root.id });
    expect(child.parentId).toBe(root.id);
    expect(child.aiStatus).toBe("skipped");
    expect(child.aiSkipReason).toBeNull();
    expect(child.position).toBe(0);
    expect(ctx.queue.jobs).toHaveLength(0);

    const grandchild = await request(ctx.app)
      .post(TASKS)
      .set(auth(user.token))
      .send({ title: "Too deep", parentId: child.id });
    expect(grandchild.status).toBe(400);
    expect(grandchild.body.error.code).toBe("VALIDATION_ERROR");
    expect(grandchild.body.error.details).toEqual([
      { path: "body.parentId", message: DEPTH_MESSAGE },
    ]);
  });

  it("assigns child positions after the current maximum", async () => {
    const user = await registerUser(ctx.app);
    const root = await createTask(ctx.app, user.token, { title: "Ordered steps" });
    const a = await createTask(ctx.app, user.token, { title: "A", parentId: root.id });
    const b = await createTask(ctx.app, user.token, { title: "B", parentId: root.id });
    expect([a.position, b.position]).toEqual([0, 1]);
  });

  it("rejects a foreign parent with NOT_FOUND and foreign tag ids with VALIDATION_ERROR", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const root = await createTask(ctx.app, owner.token, { title: "Owner root" });
    const foreignParent = await request(ctx.app)
      .post(TASKS)
      .set(auth(other.token))
      .send({ title: "Sneaky", parentId: root.id });
    expect(foreignParent.status).toBe(404);

    const tag = await request(ctx.app)
      .post("/api/v1/tags")
      .set(auth(owner.token))
      .send({ name: "work", color: "#111111" });
    const foreignTag = await request(ctx.app)
      .post(TASKS)
      .set(auth(other.token))
      .send({ title: "Sneaky tag", tagIds: [tag.body.data.id] });
    expect(foreignTag.status).toBe(400);
    expect(foreignTag.body.error.details).toEqual([
      { path: "body.tagIds", message: `Unknown tag id ${tag.body.data.id}` },
    ]);
  });

  it("attaches owned tags on create", async () => {
    const user = await registerUser(ctx.app);
    const tag = await request(ctx.app)
      .post("/api/v1/tags")
      .set(auth(user.token))
      .send({ name: "home", color: "#222222" });
    const task = await createTask(ctx.app, user.token, {
      title: "Tagged task",
      tagIds: [tag.body.data.id, tag.body.data.id],
    });
    expect(task.tags).toEqual([
      { id: tag.body.data.id, name: "home", color: "#222222", createdAt: expect.any(String) },
    ]);
  });

  it("with AI_ENABLED=false creates the task skipped with reason ai_disabled", async () => {
    const paused = await createTestApp({ AI_ENABLED: false });
    try {
      const user = await registerUser(paused.app);
      const task = await createTask(paused.app, user.token, { title: "Paused assistant" });
      expect(task.aiStatus).toBe("skipped");
      expect(task.aiSkipReason).toBe("ai_disabled");
      expect(paused.queue.jobs).toHaveLength(0);
    } finally {
      await paused.close();
    }
  });

  it("past the user limit still creates the task, skipped with reason rate_limited", async () => {
    const limited = await createTestApp({ AI_RATE_LIMIT_PER_HOUR: 1 });
    try {
      const user = await registerUser(limited.app);
      const first = await createTask(limited.app, user.token, { title: "First one counts" });
      const second = await createTask(limited.app, user.token, { title: "Second is limited" });
      expect(first.aiStatus).toBe("pending");
      expect(second.aiStatus).toBe("skipped");
      expect(second.aiSkipReason).toBe("rate_limited");
      expect(limited.queue.jobs).toHaveLength(1);
    } finally {
      await limited.close();
    }
  });
});

describe("GET /tasks/:id", () => {
  it("returns children, tags and progress computed over user and accepted children", async () => {
    const user = await registerUser(ctx.app);
    const root = await createTask(ctx.app, user.token, { title: "Root with children" });
    const c1 = await createTask(ctx.app, user.token, { title: "Child one", parentId: root.id });
    await createTask(ctx.app, user.token, { title: "Child two", parentId: root.id });
    await ctx.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, c1.id));
    const res = await request(ctx.app).get(`${TASKS}/${root.id}`).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.children.map((c: { title: string }) => c.title)).toEqual([
      "Child one",
      "Child two",
    ]);
    expect(res.body.data.progress).toEqual({ done: 1, total: 2 });
  });

  it("returns NOT_FOUND for another user's task and for an unknown id", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const root = await createTask(ctx.app, owner.token, { title: "Private task" });
    expect((await request(ctx.app).get(`${TASKS}/${root.id}`).set(auth(other.token))).status).toBe(
      404,
    );
    expect(
      (
        await request(ctx.app)
          .get(`${TASKS}/00000000-0000-4000-8000-000000000000`)
          .set(auth(owner.token))
      ).status,
    ).toBe(404);
    expect((await request(ctx.app).get(`${TASKS}/not-a-uuid`).set(auth(owner.token))).status).toBe(
      400,
    );
  });
});

describe("GET /tasks", () => {
  it("walks three pages without duplicates, newest first, nextCursor null on the last page", async () => {
    const user = await registerUser(ctx.app);
    const created: string[] = [];
    for (let i = 1; i <= 7; i += 1) {
      created.push((await createTask(ctx.app, user.token, { title: `Task number ${i}` })).id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = cursor
        ? `${TASKS}?limit=3&cursor=${encodeURIComponent(cursor)}`
        : `${TASKS}?limit=3`;
      const res: request.Response = await request(ctx.app).get(url).set(auth(user.token));
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((t: { id: string }) => t.id));
      cursor = res.body.meta.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual([...created].reverse());
  });

  it("filters by status and by tag, and lists top-level only unless parentId is given", async () => {
    const user = await registerUser(ctx.app);
    const tag = await request(ctx.app)
      .post("/api/v1/tags")
      .set(auth(user.token))
      .send({ name: "focus", color: "#333333" });
    const tagged = await createTask(ctx.app, user.token, {
      title: "Tagged root",
      tagIds: [tag.body.data.id],
    });
    const plain = await createTask(ctx.app, user.token, { title: "Plain root" });
    const child = await createTask(ctx.app, user.token, { title: "A child", parentId: plain.id });
    await ctx.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, plain.id));

    const all = await request(ctx.app).get(TASKS).set(auth(user.token));
    expect(all.body.data.map((t: { id: string }) => t.id).sort()).toEqual(
      [tagged.id, plain.id].sort(),
    );

    const done = await request(ctx.app).get(`${TASKS}?status=done`).set(auth(user.token));
    expect(done.body.data.map((t: { id: string }) => t.id)).toEqual([plain.id]);

    const byTag = await request(ctx.app)
      .get(`${TASKS}?tagId=${tag.body.data.id}`)
      .set(auth(user.token));
    expect(byTag.body.data.map((t: { id: string }) => t.id)).toEqual([tagged.id]);

    const children = await request(ctx.app)
      .get(`${TASKS}?parentId=${plain.id}`)
      .set(auth(user.token));
    expect(children.body.data.map((t: { id: string }) => t.id)).toEqual([child.id]);
  });

  it("rejects a garbage cursor and an out-of-range limit", async () => {
    const user = await registerUser(ctx.app);
    const bad = await request(ctx.app).get(`${TASKS}?cursor=%%%`).set(auth(user.token));
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([{ path: "query.cursor", message: "Invalid cursor" }]);
    const big = await request(ctx.app).get(`${TASKS}?limit=500`).set(auth(user.token));
    expect(big.status).toBe(400);
    expect(big.body.error.details[0].path).toBe("query.limit");
  });
});

describe("DELETE /tasks/:id", () => {
  it("cascades to children and tag links, and hides other users' tasks", async () => {
    const owner = await registerUser(ctx.app);
    const other = await registerUser(ctx.app);
    const tag = await request(ctx.app)
      .post("/api/v1/tags")
      .set(auth(owner.token))
      .send({ name: "gone", color: "#444444" });
    const root = await createTask(ctx.app, owner.token, {
      title: "Doomed root",
      tagIds: [tag.body.data.id],
    });
    const child = await createTask(ctx.app, owner.token, {
      title: "Doomed child",
      parentId: root.id,
    });

    expect(
      (await request(ctx.app).delete(`${TASKS}/${root.id}`).set(auth(other.token))).status,
    ).toBe(404);
    expect(
      (await request(ctx.app).delete(`${TASKS}/${root.id}`).set(auth(owner.token))).status,
    ).toBe(204);
    expect((await request(ctx.app).get(`${TASKS}/${child.id}`).set(auth(owner.token))).status).toBe(
      404,
    );
    expect(await ctx.db.select().from(taskTags)).toEqual([]);
    expect(
      (await request(ctx.app).delete(`${TASKS}/${root.id}`).set(auth(owner.token))).status,
    ).toBe(404);
  });
});
