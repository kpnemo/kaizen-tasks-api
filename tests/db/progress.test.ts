import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { tasks, users } from "../../src/db/schema.js";
import { childAggregates } from "../../src/repositories/tasks.js";

let db: Db;
let end: () => Promise<void>;
beforeAll(() => {
  const created = createDb(process.env.DATABASE_URL ?? "", { max: 1 });
  db = created.db;
  end = () => created.sql.end();
});
afterAll(() => end());

describe("childAggregates", () => {
  it("counts user children and accepted AI children (done is the done subset) and suggested AI children", async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `${randomUUID()}@t.local`, passwordHash: "x", displayName: "P" })
      .returning();
    const [root] = await db.insert(tasks).values({ userId: u!.id, title: "root" }).returning();
    const [empty] = await db.insert(tasks).values({ userId: u!.id, title: "empty" }).returning();
    const child = (extra: Partial<typeof tasks.$inferInsert>) => ({
      userId: u!.id,
      parentId: root!.id,
      title: "c",
      aiStatus: "skipped" as const,
      ...extra,
    });
    await db
      .insert(tasks)
      .values([
        child({ origin: "user", status: "done" }),
        child({ origin: "user", status: "todo" }),
        child({ origin: "ai", suggestionState: "accepted", status: "done" }),
        child({ origin: "ai", suggestionState: "accepted", status: "in_progress" }),
        child({ origin: "ai", suggestionState: "suggested", status: "done" }),
        child({ origin: "ai", suggestionState: "dismissed", status: "done" }),
      ]);
    const aggregates = await childAggregates(db, [root!.id, empty!.id]);
    expect(aggregates.get(root!.id)).toEqual({ done: 2, total: 4, suggestionCount: 1 });
    expect(aggregates.get(empty!.id)).toBeUndefined();
    expect(await childAggregates(db, [])).toEqual(new Map());
  });
});
