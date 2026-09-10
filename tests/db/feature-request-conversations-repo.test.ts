import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { users } from "../../src/db/schema.js";
import {
  abandonLiveConversations,
  findLiveConversation,
  findOwnedConversation,
  insertConversation,
  markConversationFiled,
  replaceLiveConversation,
  updateConversationTurn,
} from "../../src/repositories/feature-request-conversations.js";
import type { ConversationMessage } from "../../src/schemas/feature-request-conversations.js";

let db: Db;
let end: () => Promise<void>;

// Three connections: the concurrency test holds one transaction open while a second waits on the
// partial unique index.
beforeAll(() => {
  const created = createDb(process.env.DATABASE_URL ?? "", { max: 3 });
  db = created.db;
  end = () => created.sql.end();
});
afterAll(() => end());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function user() {
  const [row] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@test.local`, passwordHash: "x", displayName: "T" })
    .returning();
  return row!;
}

const greeting = (): ConversationMessage[] => [
  {
    id: randomUUID(),
    role: "assistant",
    content: "Tell me the idea in a sentence or two.",
    at: new Date().toISOString(),
  },
];

const score = {
  clarity: 4,
  complexity: 2,
  risk: 2,
  archChange: false,
  readiness: 16,
  reasons: { clarity: "c", complexity: "x", risk: "r" },
};

const draft = {
  title: "Bulk accept",
  problem: "Slow.",
  proposedBehavior: "A button.",
  acceptanceCriteria: "- Pressing it accepts every suggestion.",
  outOfScope: "Dismissing in bulk.",
};

describe("feature-request conversation repository", () => {
  it("inserts with the greeting and finds it as the caller's live conversation", async () => {
    const u = await user();
    const inserted = await insertConversation(db, { userId: u.id, messages: greeting() });
    expect(inserted.status).toBe("open");
    expect(inserted.messages).toHaveLength(1);
    const found = await findLiveConversation(db, u.id);
    expect(found?.id).toBe(inserted.id);
  });

  it("does not return another user's conversation", async () => {
    const owner = await user();
    const other = await user();
    const row = await insertConversation(db, { userId: owner.id, messages: greeting() });
    expect(await findOwnedConversation(db, row.id, owner.id)).toBeDefined();
    expect(await findOwnedConversation(db, row.id, other.id)).toBeUndefined();
    expect(await findLiveConversation(db, other.id)).toBeUndefined();
  });

  it("abandons every live conversation and reports the count", async () => {
    const u = await user();
    await insertConversation(db, { userId: u.id, messages: greeting() });
    expect(await abandonLiveConversations(db, u.id)).toBe(1);
    expect(await findLiveConversation(db, u.id)).toBeUndefined();
    expect(await abandonLiveConversations(db, u.id)).toBe(0);
  });

  it("writes a whole turn in one conditional update and bumps version and updated_at", async () => {
    const u = await user();
    const row = await insertConversation(db, { userId: u.id, messages: greeting() });
    expect(row.version).toBe(0);
    const messages = [
      ...row.messages,
      { id: randomUUID(), role: "user" as const, content: "An idea", at: new Date().toISOString() },
    ];
    const updated = await updateConversationTurn(
      db,
      { id: row.id, userId: u.id, expectedVersion: row.version },
      {
        messages,
        draft,
        score,
        questionCount: 1,
        stillMissing: ["a third criterion"],
        status: "ready",
      },
    );
    expect(updated).toBeDefined();
    expect(updated!.messages).toHaveLength(2);
    expect(updated!.draft).toEqual(draft);
    expect(updated!.score?.readiness).toBe(16);
    expect(updated!.questionCount).toBe(1);
    expect(updated!.stillMissing).toEqual(["a third criterion"]);
    expect(updated!.status).toBe("ready");
    expect(updated!.version).toBe(1);
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(row.updatedAt.getTime());
  });

  it("matches zero rows for a stale version, another owner, or a non-open status", async () => {
    const u = await user();
    const other = await user();
    const row = await insertConversation(db, { userId: u.id, messages: greeting() });
    const values = {
      messages: row.messages,
      draft,
      score,
      questionCount: 1,
      stillMissing: [],
      status: "open" as const,
    };

    expect(
      await updateConversationTurn(db, { id: row.id, userId: u.id, expectedVersion: 7 }, values),
    ).toBeUndefined();
    expect(
      await updateConversationTurn(
        db,
        { id: row.id, userId: other.id, expectedVersion: 0 },
        values,
      ),
    ).toBeUndefined();

    // The first writer wins; the second, holding the version it read, updates nothing.
    const first = await updateConversationTurn(
      db,
      { id: row.id, userId: u.id, expectedVersion: 0 },
      values,
    );
    expect(first?.version).toBe(1);
    expect(
      await updateConversationTurn(db, { id: row.id, userId: u.id, expectedVersion: 0 }, values),
    ).toBeUndefined();

    await markConversationFiled(db, row.id, u.id, 9);
    expect(
      await updateConversationTurn(db, { id: row.id, userId: u.id, expectedVersion: 1 }, values),
    ).toBeUndefined();
  });

  it("marks a conversation filed with its issue number, once, and only for its owner", async () => {
    const u = await user();
    const other = await user();
    const row = await insertConversation(db, { userId: u.id, messages: greeting() });

    expect(await markConversationFiled(db, row.id, other.id, 42)).toBeUndefined();

    const filed = await markConversationFiled(db, row.id, u.id, 42);
    expect(filed?.status).toBe("filed");
    expect(filed?.issueNumber).toBe(42);
    expect(await findLiveConversation(db, u.id)).toBeUndefined();

    // Already terminal: a second filing matches nothing.
    expect(await markConversationFiled(db, row.id, u.id, 43)).toBeUndefined();
  });
});

describe("replaceLiveConversation", () => {
  it("abandons the live conversation and inserts the new one in one transaction", async () => {
    const u = await user();
    const first = await insertConversation(db, { userId: u.id, messages: greeting() });
    const second = await replaceLiveConversation(db, { userId: u.id, messages: greeting() });
    expect(second).toBeDefined();
    expect(second!.id).not.toBe(first.id);
    expect((await findOwnedConversation(db, first.id, u.id))?.status).toBe("abandoned");
    expect((await findLiveConversation(db, u.id))?.id).toBe(second!.id);
  });

  it("returns undefined and rolls back when a concurrent create already holds the index", async () => {
    const u = await user();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Transaction A inserts a live row and stays open, holding the partial unique index.
    const a = db.transaction(async (tx) => {
      const row = await insertConversation(tx, { userId: u.id, messages: greeting() });
      await held;
      return row;
    });
    await sleep(100);

    // B abandons nothing (A is uncommitted), then blocks on the index until A commits.
    const b = replaceLiveConversation(db, { userId: u.id, messages: greeting() });
    await sleep(100);
    release();

    const winner = await a;
    expect(await b).toBeUndefined();
    // B rolled back entirely: A's conversation is untouched and still the live one.
    expect((await findLiveConversation(db, u.id))?.id).toBe(winner.id);
    expect((await findOwnedConversation(db, winner.id, u.id))?.status).toBe("open");
  });
});
