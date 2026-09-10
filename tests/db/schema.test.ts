import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, isCheckViolation, isUniqueViolation, type Db } from "../../src/db/client.js";
import { tags, tasks, users } from "../../src/db/schema.js";

let db: Db;
let end: () => Promise<void>;

beforeAll(() => {
  const created = createDb(process.env.DATABASE_URL ?? "", { max: 1 });
  db = created.db;
  end = () => created.sql.end();
});
afterAll(() => end());

async function user(email = `${randomUUID()}@test.local`) {
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "x", displayName: "T" })
    .returning();
  return row!;
}

describe("schema", () => {
  it("has the four tables and six enums", async () => {
    const tables = await db.execute<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const names = tables.map((r) => r.table_name);
    for (const t of ["users", "tasks", "tags", "task_tags"]) expect(names).toContain(t);
    const enums = await db.execute<{ typname: string }>(
      `select typname from pg_type where typtype = 'e' order by typname`,
    );
    expect(enums.map((r) => r.typname).sort()).toEqual(
      [
        "ai_skip_reason",
        "ai_status",
        "feature_request_conversation_status",
        "suggestion_state",
        "task_origin",
        "task_status",
      ].sort(),
    );
  });

  it("applies the documented defaults on tasks", async () => {
    const u = await user();
    const [t] = await db.insert(tasks).values({ userId: u.id, title: "Defaults" }).returning();
    expect(t!.status).toBe("todo");
    expect(t!.position).toBe(0);
    expect(t!.origin).toBe("user");
    expect(t!.suggestionState).toBeNull();
    expect(t!.aiStatus).toBe("pending");
    expect(t!.aiTagSuggestions).toEqual([]);
    expect(t!.generationId).toBeNull();
    expect(t!.createdAt).toBeInstanceOf(Date);
  });

  it("enforces suggestion_state non-null exactly when origin is ai", async () => {
    const u = await user();
    let caught: unknown;
    try {
      await db
        .insert(tasks)
        .values({ userId: u.id, title: "bad", origin: "user", suggestionState: "suggested" });
    } catch (err) {
      caught = err;
    }
    expect(isCheckViolation(caught)).toBe(true);
    caught = undefined;
    try {
      await db.insert(tasks).values({ userId: u.id, title: "bad", origin: "ai" });
    } catch (err) {
      caught = err;
    }
    expect(isCheckViolation(caught)).toBe(true);
    const [ok] = await db
      .insert(tasks)
      .values({ userId: u.id, title: "ok", origin: "ai", suggestionState: "suggested" })
      .returning();
    expect(ok!.suggestionState).toBe("suggested");
  });

  it("rejects duplicate tag names per user case-insensitively but allows them across users", async () => {
    const a = await user();
    const b = await user();
    await db.insert(tags).values({ userId: a.id, name: "Work", color: "#2563eb" });
    let caught: unknown;
    try {
      await db.insert(tags).values({ userId: a.id, name: "work", color: "#000000" });
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    const [other] = await db
      .insert(tags)
      .values({ userId: b.id, name: "work", color: "#000000" })
      .returning();
    expect(other!.name).toBe("work");
  });

  it("cascades user deletion to tasks and children", async () => {
    const u = await user();
    const [root] = await db.insert(tasks).values({ userId: u.id, title: "root" }).returning();
    await db
      .insert(tasks)
      .values({ userId: u.id, title: "child", parentId: root!.id, aiStatus: "skipped" });
    await db.delete(users).where(eq(users.id, u.id));
    expect(await db.select().from(tasks)).toEqual([]);
  });
});
