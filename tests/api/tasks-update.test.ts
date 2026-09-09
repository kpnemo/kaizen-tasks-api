import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tasks } from "../../src/db/schema.js";
import type { SuggestionState, TaskDetail } from "../../src/schemas/tasks.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser, type TestUser } from "../helpers/auth.js";
import { createTask } from "../helpers/tasks.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const TASKS = "/api/v1/tasks";

async function aiChild(
  user: TestUser,
  parentId: string,
  title: string,
  position: number,
  state: SuggestionState = "suggested",
) {
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      userId: user.userId,
      parentId,
      title,
      position,
      origin: "ai",
      suggestionState: state,
      rationale: `Because ${title.toLowerCase()} comes here`,
      aiStatus: "skipped",
    })
    .returning();
  return row!;
}

async function detail(user: TestUser, id: string): Promise<TaskDetail> {
  const res = await request(ctx.server).get(`${TASKS}/${id}`).set(auth(user.token));
  expect(res.status).toBe(200);
  return res.body.data as TaskDetail;
}

const patch = (user: TestUser, id: string, body: object) =>
  request(ctx.server).patch(`${TASKS}/${id}`).set(auth(user.token)).send(body);

describe("children ordering", () => {
  it("returns children ordered by position with rationale on AI-created ones", async () => {
    const user = await registerUser(ctx.server);
    const root = await createTask(ctx.server, user.token, { title: "Root for ordering" });
    await createTask(ctx.server, user.token, { title: "User step A", parentId: root.id });
    await aiChild(user, root.id, "AI step B", 1);
    await createTask(ctx.server, user.token, { title: "User step C", parentId: root.id });
    const d = await detail(user, root.id);
    expect(d.children.map((c) => c.title)).toEqual(["User step A", "AI step B", "User step C"]);
    expect(d.children.map((c) => c.position)).toEqual([0, 1, 2]);
    expect(d.suggestionCount).toBe(1);
    expect(d.children.map((c) => c.suggestionCount)).toEqual([0, 0, 0]);
    const ai = d.children[1]!;
    expect(ai.origin).toBe("ai");
    expect(ai.suggestionState).toBe("suggested");
    expect(ai.rationale).toBe("Because ai step b comes here");
    expect(d.children[0]!.rationale).toBeNull();
  });
});

describe("PATCH /tasks/:id", () => {
  it("moves a child to a target index, shifts siblings, and keeps positions dense", async () => {
    const user = await registerUser(ctx.server);
    const root = await createTask(ctx.server, user.token, { title: "Root for reorder" });
    const names = ["A", "B", "C", "D"];
    const ids: Record<string, string> = {};
    for (const n of names)
      ids[n] = (await createTask(ctx.server, user.token, { title: n, parentId: root.id })).id;

    const moved = await patch(user, ids.D!, { position: 1 });
    expect(moved.status).toBe(200);
    let d = await detail(user, root.id);
    expect(d.children.map((c) => c.title)).toEqual(["A", "D", "B", "C"]);
    expect(d.children.map((c) => c.position)).toEqual([0, 1, 2, 3]);

    await patch(user, ids.A!, { position: 99 });
    d = await detail(user, root.id);
    expect(d.children.map((c) => c.title)).toEqual(["D", "B", "C", "A"]);
    expect(d.children.map((c) => c.position)).toEqual([0, 1, 2, 3]);

    await patch(user, ids.C!, { position: 0 });
    d = await detail(user, root.id);
    expect(d.children.map((c) => c.title)).toEqual(["C", "D", "B", "A"]);
    expect(d.children.map((c) => c.position)).toEqual([0, 1, 2, 3]);
  });

  it("updates title, description and status; null clears the description", async () => {
    const user = await registerUser(ctx.server);
    const task = await createTask(ctx.server, user.token, {
      title: "Before edit",
      description: "old",
    });
    const res = await patch(user, task.id, {
      title: "After edit",
      description: null,
      status: "in_progress",
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      title: "After edit",
      description: null,
      status: "in_progress",
    });
    expect(new Date(res.body.data.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(task.updatedAt).getTime(),
    );
  });

  it("walks every allowed suggestion transition and rejects a disallowed one", async () => {
    const user = await registerUser(ctx.server);
    const root = await createTask(ctx.server, user.token, { title: "Root for transitions" });
    const child = await aiChild(user, root.id, "Suggested step", 0);

    for (const to of ["accepted", "dismissed", "accepted"] as const) {
      const res = await patch(user, child.id, { suggestionState: to });
      expect(res.status, `-> ${to}`).toBe(200);
      expect(res.body.data.suggestionState).toBe(to);
    }
    const other = await aiChild(user, root.id, "Another suggested", 1);
    expect(
      (await patch(user, other.id, { suggestionState: "dismissed" })).body.data.suggestionState,
    ).toBe("dismissed");

    const back = await patch(user, child.id, { suggestionState: "suggested" });
    expect(back.status).toBe(400);
    expect(back.body.error.code).toBe("VALIDATION_ERROR");
    expect(back.body.error.details[0].path).toBe("body.suggestionState");

    const userStep = await createTask(ctx.server, user.token, {
      title: "User step",
      parentId: root.id,
    });
    const onUser = await patch(user, userStep.id, { suggestionState: "accepted" });
    expect(onUser.status).toBe(400);
    expect(onUser.body.error.details[0].path).toBe("body.suggestionState");
  });

  it("rejects an empty patch and hides other users' tasks", async () => {
    const owner = await registerUser(ctx.server);
    const other = await registerUser(ctx.server);
    const task = await createTask(ctx.server, owner.token, { title: "Mine" });
    expect((await patch(owner, task.id, {})).status).toBe(400);
    expect((await patch(other, task.id, { title: "Taken" })).status).toBe(404);
  });

  it("does not deadlock when two siblings are patched concurrently (title and position both)", async () => {
    const user = await registerUser(ctx.server);
    const root = await createTask(ctx.server, user.token, { title: "Root for concurrent patch" });
    const names = ["A", "B", "C", "D"];
    const ids: Record<string, string> = {};
    for (const n of names)
      ids[n] = (await createTask(ctx.server, user.token, { title: n, parentId: root.id })).id;

    const [r1, r2] = await Promise.all([
      patch(user, ids.A!, { title: "A2", position: 3 }),
      patch(user, ids.C!, { title: "C2", position: 0 }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const d = await detail(user, root.id);
    expect(d.children.map((c) => c.position).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(new Set(d.children.map((c) => c.id)).size).toBe(4);
  });
});

describe("accept-all and dismiss-all", () => {
  it("only touch suggested children and progress follows", async () => {
    const user = await registerUser(ctx.server);
    const root = await createTask(ctx.server, user.token, { title: "Root for bulk" });
    await createTask(ctx.server, user.token, { title: "User step", parentId: root.id });
    await aiChild(user, root.id, "S1", 1);
    await aiChild(user, root.id, "S2", 2);
    const dismissed = await aiChild(user, root.id, "Already dismissed", 3, "dismissed");

    // suggestionCount counts the two suggested children, on the detail and on the list row alike.
    expect((await detail(user, root.id)).suggestionCount).toBe(2);
    const listed = await request(ctx.server).get(TASKS).set(auth(user.token));
    expect(listed.body.data.find((t: { id: string }) => t.id === root.id).suggestionCount).toBe(2);

    const accepted = await request(ctx.server)
      .post(`${TASKS}/${root.id}/suggestions/accept-all`)
      .set(auth(user.token));
    expect(accepted.status).toBe(200);
    const states = Object.fromEntries(
      accepted.body.data.children.map((c: { title: string; suggestionState: string | null }) => [
        c.title,
        c.suggestionState,
      ]),
    );
    expect(states).toEqual({
      "User step": null,
      S1: "accepted",
      S2: "accepted",
      "Already dismissed": "dismissed",
    });
    expect(accepted.body.data.progress).toEqual({ done: 0, total: 3 });
    expect(accepted.body.data.suggestionCount).toBe(0);

    // Idempotent: a second accept-all touches nothing (no children are still "suggested"),
    // so the detail comes back identical.
    const acceptedAgain = await request(ctx.server)
      .post(`${TASKS}/${root.id}/suggestions/accept-all`)
      .set(auth(user.token));
    expect(acceptedAgain.status).toBe(200);
    expect(acceptedAgain.body.data).toEqual(accepted.body.data);

    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, dismissed.id));
    expect(row?.suggestionState).toBe("dismissed");

    const root2 = await createTask(ctx.server, user.token, { title: "Root for dismiss" });
    await aiChild(user, root2.id, "S3", 0);
    await aiChild(user, root2.id, "S4", 1);
    expect((await detail(user, root2.id)).suggestionCount).toBe(2);
    const res = await request(ctx.server)
      .post(`${TASKS}/${root2.id}/suggestions/dismiss-all`)
      .set(auth(user.token));
    expect(res.status).toBe(200);
    expect(
      res.body.data.children.map((c: { suggestionState: string }) => c.suggestionState),
    ).toEqual(["dismissed", "dismissed"]);
    expect(res.body.data.progress).toEqual({ done: 0, total: 0 });
    expect(res.body.data.suggestionCount).toBe(0);
  });

  it("hides other users' tasks with 404 on both endpoints", async () => {
    const owner = await registerUser(ctx.server);
    const other = await registerUser(ctx.server);
    const root = await createTask(ctx.server, owner.token, { title: "Root for cross-user bulk" });
    await aiChild(owner, root.id, "S1", 0);

    const acceptRes = await request(ctx.server)
      .post(`${TASKS}/${root.id}/suggestions/accept-all`)
      .set(auth(other.token));
    expect(acceptRes.status).toBe(404);

    const dismissRes = await request(ctx.server)
      .post(`${TASKS}/${root.id}/suggestions/dismiss-all`)
      .set(auth(other.token));
    expect(dismissRes.status).toBe(404);
  });
});

describe("PUT /tasks/:id/tags", () => {
  it("replaces the set with owned ids and rejects a foreign id", async () => {
    const owner = await registerUser(ctx.server);
    const other = await registerUser(ctx.server);
    const mk = async (u: TestUser, name: string) =>
      (
        await request(ctx.server)
          .post("/api/v1/tags")
          .set(auth(u.token))
          .send({ name, color: "#555555" })
      ).body.data.id as string;
    const t1 = await mk(owner, "t1");
    const t2 = await mk(owner, "t2");
    const t3 = await mk(other, "t3");
    const task = await createTask(ctx.server, owner.token, { title: "Tag me", tagIds: [t1] });

    const put = (ids: string[]) =>
      request(ctx.server)
        .put(`${TASKS}/${task.id}/tags`)
        .set(auth(owner.token))
        .send({ tagIds: ids });
    expect((await put([t1, t2])).body.data.tags.map((t: { id: string }) => t.id).sort()).toEqual(
      [t1, t2].sort(),
    );
    const foreign = await put([t3]);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details).toEqual([
      { path: "body.tagIds", message: `Unknown tag id ${t3}` },
    ]);
    expect((await put([])).body.data.tags).toEqual([]);
    expect(
      (
        await request(ctx.server)
          .put(`${TASKS}/${task.id}/tags`)
          .set(auth(other.token))
          .send({ tagIds: [] })
      ).status,
    ).toBe(404);
  });

  it("de-duplicates repeated tag ids in the body", async () => {
    const owner = await registerUser(ctx.server);
    const tagRes = await request(ctx.server)
      .post("/api/v1/tags")
      .set(auth(owner.token))
      .send({ name: "dup-tag", color: "#123456" });
    const tagId = tagRes.body.data.id as string;
    const task = await createTask(ctx.server, owner.token, { title: "Tag me twice" });

    const res = await request(ctx.server)
      .put(`${TASKS}/${task.id}/tags`)
      .set(auth(owner.token))
      .send({ tagIds: [tagId, tagId] });
    expect(res.status).toBe(200);
    expect(res.body.data.tags.map((t: { id: string }) => t.id)).toEqual([tagId]);
  });
});
