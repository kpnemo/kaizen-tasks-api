import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, isUniqueViolation, type Db } from "../../src/db/client.js";
import { featureRequestConversations, users } from "../../src/db/schema.js";

let db: Db;
let end: () => Promise<void>;

beforeAll(() => {
  const created = createDb(process.env.DATABASE_URL ?? "", { max: 1 });
  db = created.db;
  end = () => created.sql.end();
});
afterAll(() => end());

async function user() {
  const [row] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@test.local`, passwordHash: "x", displayName: "T" })
    .returning();
  return row!;
}

describe("feature_request_conversations", () => {
  it("applies the documented defaults", async () => {
    const u = await user();
    const [row] = await db.insert(featureRequestConversations).values({ userId: u.id }).returning();
    expect(row!.status).toBe("open");
    expect(row!.messages).toEqual([]);
    expect(row!.draft).toEqual({});
    expect(row!.score).toBeNull();
    expect(row!.questionCount).toBe(0);
    expect(row!.stillMissing).toEqual([]);
    expect(row!.issueNumber).toBeNull();
    expect(row!.version).toBe(0);
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.updatedAt).toBeInstanceOf(Date);
  });

  it("allows one open or ready conversation per user and rejects a second", async () => {
    const u = await user();
    await db.insert(featureRequestConversations).values({ userId: u.id, status: "open" });
    let caught: unknown;
    try {
      await db.insert(featureRequestConversations).values({ userId: u.id, status: "ready" });
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolation(caught)).toBe(true);
  });

  it("leaves filed and abandoned conversations out of the partial index", async () => {
    const u = await user();
    await db.insert(featureRequestConversations).values({ userId: u.id, status: "filed" });
    await db.insert(featureRequestConversations).values({ userId: u.id, status: "abandoned" });
    await db.insert(featureRequestConversations).values({ userId: u.id, status: "filed" });
    const [fresh] = await db
      .insert(featureRequestConversations)
      .values({ userId: u.id, status: "open" })
      .returning();
    expect(fresh!.status).toBe("open");
  });

  it("cascades when the user is deleted", async () => {
    const u = await user();
    await db.insert(featureRequestConversations).values({ userId: u.id });
    await db.delete(users).where(eq(users.id, u.id));
    const rows = await db.select().from(featureRequestConversations);
    expect(rows.filter((r) => r.userId === u.id)).toHaveLength(0);
  });

  it("round-trips the jsonb columns as typed values", async () => {
    const u = await user();
    const [row] = await db
      .insert(featureRequestConversations)
      .values({
        userId: u.id,
        messages: [
          {
            id: randomUUID(),
            role: "assistant",
            content: "Tell me the idea.",
            at: new Date().toISOString(),
            options: ["a", "b", "c"],
          },
        ],
        draft: { title: "Bulk accept" },
        score: {
          clarity: 4,
          complexity: 2,
          risk: 2,
          archChange: false,
          readiness: 16,
          reasons: { clarity: "c", complexity: "x", risk: "r" },
        },
        stillMissing: ["a third criterion"],
        questionCount: 2,
      })
      .returning();
    expect(row!.messages[0]?.options).toEqual(["a", "b", "c"]);
    expect(row!.draft.title).toBe("Bulk accept");
    expect(row!.score?.readiness).toBe(16);
    expect(row!.stillMissing).toEqual(["a third criterion"]);
  });
});
