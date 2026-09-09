import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taskTags, tasks } from "../../src/db/schema.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser, type TestUser } from "../helpers/auth.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const TAGS = "/api/v1/tags";

async function createTag(user: TestUser, name: string, color = "#2563EB") {
  const res = await request(ctx.server).post(TAGS).set(auth(user.token)).send({ name, color });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; name: string; color: string; createdAt: string };
}

describe("tags", () => {
  it("requires authentication", async () => {
    expect((await request(ctx.server).get(TAGS)).status).toBe(401);
  });

  it("creates a tag with a lowercased color and lists tags ordered by name", async () => {
    const user = await registerUser(ctx.server);
    const work = await createTag(user, "Work");
    expect(work).toEqual({
      id: expect.any(String),
      name: "Work",
      color: "#2563eb",
      createdAt: expect.any(String),
    });
    await createTag(user, "alpha");
    await createTag(user, "Zed");
    const res = await request(ctx.server).get(TAGS).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { name: string }) => t.name)).toEqual(["alpha", "Work", "Zed"]);
    expect(res.body.meta).toEqual({ requestId: expect.any(String) });
  });

  it("rejects duplicate names case-insensitively with CONFLICT", async () => {
    const user = await registerUser(ctx.server);
    await createTag(user, "Work");
    const res = await request(ctx.server)
      .post(TAGS)
      .set(auth(user.token))
      .send({ name: "work", color: "#000000" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("validates name and color", async () => {
    const user = await registerUser(ctx.server);
    const res = await request(ctx.server)
      .post(TAGS)
      .set(auth(user.token))
      .send({ name: "", color: "blue" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      "body.color",
      "body.name",
    ]);
  });

  it("updates name and color, rejects an empty patch, and hides other users' tags", async () => {
    const owner = await registerUser(ctx.server);
    const other = await registerUser(ctx.server);
    const tag = await createTag(owner, "Draft");
    const ok = await request(ctx.server)
      .patch(`${TAGS}/${tag.id}`)
      .set(auth(owner.token))
      .send({ name: "Final", color: "#16A34A" });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ id: tag.id, name: "Final", color: "#16a34a" });
    const empty = await request(ctx.server)
      .patch(`${TAGS}/${tag.id}`)
      .set(auth(owner.token))
      .send({});
    expect(empty.status).toBe(400);
    const foreign = await request(ctx.server)
      .patch(`${TAGS}/${tag.id}`)
      .set(auth(other.token))
      .send({ name: "Mine" });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("NOT_FOUND");
  });

  it("deletes a tag, its links, and returns NOT_FOUND for foreign or missing ids", async () => {
    const owner = await registerUser(ctx.server);
    const other = await registerUser(ctx.server);
    const tag = await createTag(owner, "Linked");
    const [task] = await ctx.db
      .insert(tasks)
      .values({ userId: owner.userId, title: "Has a tag" })
      .returning();
    await ctx.db.insert(taskTags).values({ taskId: task!.id, tagId: tag.id });

    expect(
      (await request(ctx.server).delete(`${TAGS}/${tag.id}`).set(auth(other.token))).status,
    ).toBe(404);
    const res = await request(ctx.server).delete(`${TAGS}/${tag.id}`).set(auth(owner.token));
    expect(res.status).toBe(204);
    expect(await ctx.db.select().from(taskTags)).toEqual([]);
    expect(
      (await request(ctx.server).delete(`${TAGS}/${tag.id}`).set(auth(owner.token))).status,
    ).toBe(404);
    const list = await request(ctx.server).get(TAGS).set(auth(owner.token));
    expect(list.body.data).toEqual([]);
  });
});
