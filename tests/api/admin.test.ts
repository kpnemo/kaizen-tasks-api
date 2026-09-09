import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tasks } from "../../src/db/schema.js";
import { DEMO_EMAIL, ensureDemoSeed, SEED_IDS } from "../../src/db/seed.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth } from "../helpers/auth.js";

const ADMIN_TOKEN = "facilitator-token-with-at-least-32-characters";
const RESET = "/api/v1/admin/seed-reset";

let plain: TestContext;
let admin: TestContext;
beforeAll(async () => {
  plain = await createTestApp();
  admin = await createTestApp({ ADMIN_TOKEN, SEED_DEMO_PASSWORD: "demo-password-1" });
});
afterAll(async () => {
  await plain.close();
  await admin.close();
});

describe("POST /admin/seed-reset", () => {
  it("is absent without ADMIN_TOKEN", async () => {
    const res = await request(plain.app).post(RESET).set("x-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: "NOT_FOUND",
      message: "Route POST /api/v1/admin/seed-reset not found",
    });
  });

  it("returns the same NOT_FOUND for a wrong or missing token", async () => {
    const wrong = await request(admin.app).post(RESET).set("x-admin-token", "nope");
    const missing = await request(admin.app).post(RESET);
    for (const res of [wrong, missing]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({
        code: "NOT_FOUND",
        message: "Route POST /api/v1/admin/seed-reset not found",
      });
    }
  });

  it("recreates the fixtures with their stable ids on a correct token, undoing changes", async () => {
    const first = await request(admin.app).post(RESET).set("x-admin-token", ADMIN_TOKEN);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ demoUserId: SEED_IDS.demoUser });

    const login = await request(admin.app)
      .post("/api/v1/auth/login")
      .send({ email: DEMO_EMAIL, password: "demo-password-1" });
    expect(login.status).toBe(200);
    const token = login.body.data.accessToken as string;

    const offsite = await request(admin.app)
      .get(`/api/v1/tasks/${SEED_IDS.tasks.offsite}`)
      .set(auth(token));
    expect(offsite.status).toBe(200);
    expect(offsite.body.data).toMatchObject({
      title: "Plan the Q4 team offsite",
      status: "in_progress",
      aiStatus: "done",
      progress: { done: 2, total: 4 },
      suggestionCount: 0,
      aiError: null,
    });
    expect(offsite.body.data.children.map((c: { id: string }) => c.id)).toEqual([
      SEED_IDS.children.offsite1,
      SEED_IDS.children.offsite2,
      SEED_IDS.children.offsite3,
      SEED_IDS.children.offsite4,
    ]);
    expect(
      offsite.body.data.children.every(
        (c: { rationale: string | null; suggestionState: string }) =>
          c.rationale && c.suggestionState === "accepted",
      ),
    ).toBe(true);

    const onboarding = await request(admin.app)
      .get(`/api/v1/tasks/${SEED_IDS.tasks.onboarding}`)
      .set(auth(token));
    expect(
      onboarding.body.data.children.map((c: { suggestionState: string }) => c.suggestionState),
    ).toEqual(["suggested", "suggested", "suggested"]);
    expect(onboarding.body.data.suggestionCount).toBe(3);
    const flaky = await request(admin.app)
      .get(`/api/v1/tasks/${SEED_IDS.tasks.flakyTest}`)
      .set(auth(token));
    expect(flaky.body.data).toMatchObject({ aiStatus: "failed", aiError: expect.any(String) });
    const tagsRes = await request(admin.app).get("/api/v1/tags").set(auth(token));
    expect(tagsRes.body.data.map((t: { id: string }) => t.id).sort()).toEqual(
      Object.values(SEED_IDS.tags).sort(),
    );

    // mutate, then reset again: everything is pristine
    await request(admin.app).delete(`/api/v1/tasks/${SEED_IDS.children.offsite1}`).set(auth(token));
    await request(admin.app)
      .patch(`/api/v1/tasks/${SEED_IDS.tasks.offsite}`)
      .set(auth(token))
      .send({ title: "Changed" });
    const second = await request(admin.app).post(RESET).set("x-admin-token", ADMIN_TOKEN);
    expect(second.status).toBe(200);
    const [restored] = await admin.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, SEED_IDS.tasks.offsite));
    expect(restored?.title).toBe("Plan the Q4 team offsite");
    const [child] = await admin.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, SEED_IDS.children.offsite1));
    expect(child).toBeDefined();
  });
});

describe("ensureDemoSeed", () => {
  it("creates once and is a no-op afterwards", async () => {
    expect(await ensureDemoSeed(plain.db, "demo-password-1")).toEqual({
      demoUserId: SEED_IDS.demoUser,
      created: true,
    });
    expect(await ensureDemoSeed(plain.db, "demo-password-1")).toEqual({
      demoUserId: SEED_IDS.demoUser,
      created: false,
    });
    expect(await plain.db.select().from(tasks)).toHaveLength(15);
  });
});
