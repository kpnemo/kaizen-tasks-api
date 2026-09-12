import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ModelRetryableError } from "../../src/agent/errors.js";
import { FakeInterviewModel } from "../../src/agent/interview/fake-interview-model.js";
import type { InterviewModel } from "../../src/agent/interview/model.js";
import { createDb, type Db } from "../../src/db/client.js";
import { users } from "../../src/db/schema.js";
import { AppError } from "../../src/lib/errors.js";
import { createLogger } from "../../src/lib/logger.js";
import type { ConsumeResult, RateLimiter } from "../../src/lib/rate-limit.js";
import { EMPTY_DRAFT, SKIPPED_CONTENT } from "../../src/lib/interview-constants.js";
import type { SseSink } from "../../src/lib/sse.js";
import {
  findLiveConversation,
  findOwnedConversation,
  updateConversationTurn,
} from "../../src/repositories/feature-request-conversations.js";
import type { Conversation, RubricScore } from "../../src/schemas/feature-request-conversations.js";
import {
  createFeatureRequestConversationsService,
  GREETING,
  type FeatureRequestConversationsService,
} from "../../src/services/feature-request-conversations.js";

class RecordingSink implements SseSink {
  readonly events: Array<{ name: string; data: unknown }> = [];
  private done = false;
  get closed(): boolean {
    return this.done;
  }
  event(name: string, data: unknown): void {
    if (!this.done) this.events.push({ name, data });
  }
  comment(): void {}
  close(): void {
    this.done = true;
  }
  /** The PM's browser going away mid-turn. */
  disconnect(): void {
    this.done = true;
  }
  get names(): string[] {
    return this.events.map((e) => e.name);
  }
}

const allow: ConsumeResult = {
  allowed: true,
  reason: "ok",
  scope: "user",
  limit: 60,
  remaining: 59,
  resetAt: "2026-09-10T10:00:00.000Z",
};
const limiterReturning = (result: ConsumeResult): RateLimiter => ({
  consume: () => Promise.resolve(result),
});

let db: Db;
let end: () => Promise<void>;
const logger = createLogger("silent");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Three connections: the create race holds one transaction open while a second create waits on the
// partial unique index.
beforeAll(() => {
  const created = createDb(process.env.DATABASE_URL ?? "", { max: 3 });
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

const lowScore = {
  clarity: 3,
  complexity: 2,
  risk: 2,
  archChange: false,
  readiness: 14,
  reasons: { clarity: "c", complexity: "x", risk: "r" },
};

/** clarity 4 with the same complexity and risk: 4 * 2 + 4 + 4, the rubric's ready score. */
const readyScore = {
  clarity: 4,
  complexity: 2,
  risk: 2,
  archChange: false,
  readiness: 16,
  reasons: { clarity: "c", complexity: "x", risk: "r" },
};

/** A stub model that always asks one more question, whatever the transcript says. */
const askingModel = (reply: string): InterviewModel => ({
  respond: (_input, onDelta) => {
    onDelta(reply);
    return Promise.resolve({
      kind: "ok",
      turn: {
        reply,
        question: { text: "Anything else?", options: ["a", "b", "c"], recommended: "a" },
        draft: EMPTY_DRAFT,
        score: lowScore,
        done: false,
        stillMissing: ["a third criterion"],
      },
    });
  },
});

let model: FakeInterviewModel;
let service: FeatureRequestConversationsService;

/** Fast-forwards a conversation to a given question count without running that many turns. */
async function seedQuestionCount(userId: string, id: string, questionCount: number) {
  const row = (await findOwnedConversation(db, id, userId))!;
  const updated = await updateConversationTurn(
    db,
    { id, userId, expectedVersion: row.version },
    {
      messages: row.messages,
      draft: EMPTY_DRAFT,
      score: lowScore,
      questionCount,
      stillMissing: [],
      status: "open",
    },
  );
  return updated!;
}

function build(
  overrides: {
    db?: Db;
    model?: InterviewModel;
    rateLimiter?: RateLimiter;
    turnTimeoutMs?: number;
  } = {},
) {
  return createFeatureRequestConversationsService({
    db: overrides.db ?? db,
    model: overrides.model ?? model,
    rateLimiter: overrides.rateLimiter ?? limiterReturning(allow),
    logger,
    ...(overrides.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: overrides.turnTimeoutMs }),
  });
}

beforeEach(() => {
  model = new FakeInterviewModel();
  service = build();
});

async function answer(
  userId: string,
  id: string,
  content: string,
  skip = false,
): Promise<RecordingSink> {
  const sink = new RecordingSink();
  await service.turn(userId, id, { content, skip }, () => sink, new AbortController().signal);
  sink.close();
  return sink;
}

describe("create, get and abandon", () => {
  it("creates a conversation whose first message is the greeting", async () => {
    const u = await user();
    const created = await service.create(u.id);
    expect(created.status).toBe("open");
    expect(created.messages).toHaveLength(1);
    expect(created.messages[0]).toMatchObject({ role: "assistant", content: GREETING });
    expect(created.draft).toEqual(EMPTY_DRAFT);
    expect(created.score).toBeNull();
    expect(created.questionCount).toBe(0);
    expect(await service.get(u.id)).toMatchObject({ id: created.id });
  });

  it("throws NOT_FOUND when the caller has no live conversation", async () => {
    const u = await user();
    await expect(service.get(u.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await service.create(u.id);
    await service.abandon(u.id);
    await expect(service.get(u.id)).rejects.toBeInstanceOf(AppError);
  });

  it("a second create abandons the first", async () => {
    const u = await user();
    const first = await service.create(u.id);
    const second = await service.create(u.id);
    expect(second.id).not.toBe(first.id);
    expect((await findOwnedConversation(db, first.id, u.id))?.status).toBe("abandoned");
    expect((await service.get(u.id)).id).toBe(second.id);
  });
});

describe("turn", () => {
  it("streams deltas, then one state, then done, and persists the whole turn once", async () => {
    const u = await user();
    const created = await service.create(u.id);
    const sink = await answer(u.id, created.id, "Supervisors cannot see the drag.");

    expect(sink.names.filter((n) => n === "delta")).toHaveLength(3);
    expect(sink.names.at(-2)).toBe("state");
    expect(sink.names.at(-1)).toBe("done");

    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.messages).toHaveLength(3);
    expect(row.messages[1]).toMatchObject({
      role: "user",
      content: "Supervisors cannot see the drag.",
    });
    expect(row.messages[2]?.role).toBe("assistant");
    expect(row.messages[2]?.options).toHaveLength(3);
    expect(row.questionCount).toBe(1);
    expect(row.status).toBe("open");
    expect(model.calls[0]?.questionCount).toBe(0);
    expect(model.calls[0]?.messages).toHaveLength(2);
  });

  it("reaches ready with a complete draft after four answers", async () => {
    const u = await user();
    const created = await service.create(u.id);
    for (const text of [
      "Supervisors cannot see the drag.",
      "A team supervisor before a coaching session.",
      "A list of agents with the contact reasons.",
      "Opening the page for a team of 12 shows all 12 agents within 2 seconds.",
    ]) {
      await answer(u.id, created.id, text);
    }
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.status).toBe("ready");
    expect(row.questionCount).toBe(3);
    expect(row.score?.readiness).toBe(16);
    expect(row.draft.acceptanceCriteria).toContain("2 seconds");
  });

  it("records a skip as (skipped) and tells the model", async () => {
    const u = await user();
    const created = await service.create(u.id);
    await answer(u.id, created.id, "ignored by the server", true);
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.messages[1]).toMatchObject({ content: SKIPPED_CONTENT, skipped: true });
    expect(row.questionCount).toBe(1);
    expect(model.calls[0]?.skippedLast).toBe(true);
  });

  it("accepts the eighth question and leaves the conversation open for its answer", async () => {
    const u = await user();
    const created = await service.create(u.id);
    await seedQuestionCount(u.id, created.id, 7);

    const sink = new RecordingSink();
    await build({ model: askingModel("Question eight.") }).turn(
      u.id,
      created.id,
      { content: "an answer" },
      () => sink,
      new AbortController().signal,
    );

    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.questionCount).toBe(8);
    // Still open: the PM has to be able to answer the chips the eighth question just put on screen.
    expect(row.status).toBe("open");
    expect(sink.names.at(-2)).toBe("state");
  });

  it("finishes at the cap with a non-empty stillMissing when the request is still short", async () => {
    const u = await user();
    const created = await service.create(u.id);
    await seedQuestionCount(u.id, created.id, 8);

    const capping: InterviewModel = {
      respond: (_input, onDelta) => {
        onDelta("That is as far as we can get.");
        return Promise.resolve({
          kind: "ok",
          turn: {
            reply: "That is as far as we can get.",
            question: null,
            draft: EMPTY_DRAFT,
            score: lowScore,
            done: true,
            stillMissing: ["a third checkable criterion", "what is out of scope"],
          },
        });
      },
    };
    const sink = new RecordingSink();
    await build({ model: capping }).turn(
      u.id,
      created.id,
      { content: "an answer" },
      () => sink,
      new AbortController().signal,
    );

    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.status).toBe("ready");
    expect(row.questionCount).toBe(8);
    expect(row.stillMissing.length).toBeGreaterThan(0);
    expect(row.messages.at(-1)?.options).toBeUndefined();
  });

  it("finishes at the cap with an empty stillMissing when the last answer made it ready", async () => {
    const u = await user();
    const created = await service.create(u.id);
    await seedQuestionCount(u.id, created.id, 8);

    // The eighth answer can be the one that makes the request ready. The prompt then finishes with
    // an empty `stillMissing`, and the service takes that turn exactly like the short one above.
    const readyAtCap: InterviewModel = {
      respond: (_input, onDelta) => {
        onDelta("That is enough to file it.");
        return Promise.resolve({
          kind: "ok",
          turn: {
            reply: "That is enough to file it.",
            question: null,
            draft: EMPTY_DRAFT,
            score: readyScore,
            done: true,
            stillMissing: [],
          },
        });
      },
    };
    const sink = new RecordingSink();
    await build({ model: readyAtCap }).turn(
      u.id,
      created.id,
      { content: "an answer" },
      () => sink,
      new AbortController().signal,
    );

    expect(sink.names.at(-2)).toBe("state");
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.status).toBe("ready");
    expect(row.questionCount).toBe(8);
    expect(row.stillMissing).toEqual([]);
    expect(row.score?.readiness).toBe(16);
    expect(row.messages.at(-1)?.options).toBeUndefined();
  });

  it("recomputes readiness with the rubric's formula and ignores the model's arithmetic", async () => {
    const u = await user();
    const created = await service.create(u.id);
    const miscounting: InterviewModel = {
      respond: (_input, onDelta) => {
        onDelta("Noted.");
        return Promise.resolve({
          kind: "ok",
          turn: {
            reply: "Noted.",
            question: { text: "Anything else?", options: ["a", "b", "c"], recommended: "a" },
            draft: EMPTY_DRAFT,
            // clarity 3, complexity 2, risk 2 is 3 * 2 + 4 + 4 = 14. The model claims 20.
            score: { ...lowScore, readiness: 20 },
            done: false,
            stillMissing: [],
          },
        });
      },
    };

    const sink = new RecordingSink();
    await build({ model: miscounting }).turn(
      u.id,
      created.id,
      { content: "an answer" },
      () => sink,
      new AbortController().signal,
    );

    const state = sink.events.at(-2)!;
    expect(state.name).toBe("state");
    const streamed = (state.data as { conversation: { score: RubricScore | null } }).conversation;
    // The three sub-scores are the model's judgement and are kept; the arithmetic is ours.
    expect(streamed.score).toMatchObject({ clarity: 3, complexity: 2, risk: 2, readiness: 14 });
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.score?.readiness).toBe(14);
  });

  it("rejects a ninth question and persists nothing", async () => {
    const u = await user();
    const created = await service.create(u.id);
    await seedQuestionCount(u.id, created.id, 8);
    const before = (await findOwnedConversation(db, created.id, u.id))!;

    const sink = new RecordingSink();
    await build({ model: askingModel("Question nine.") }).turn(
      u.id,
      created.id,
      { content: "an answer" },
      () => sink,
      new AbortController().signal,
    );

    expect(sink.names).toEqual(["delta", "error", "done"]);
    expect(sink.events.at(-2)?.data).toMatchObject({ code: "UPSTREAM_ERROR" });
    const after = (await findOwnedConversation(db, created.id, u.id))!;
    expect(after.questionCount).toBe(8);
    expect(after.messages).toHaveLength(before.messages.length);
    expect(after.version).toBe(before.version);
  });
});

describe("two turns racing", () => {
  it("lets the first write win and tells the second CONFLICT without persisting it", async () => {
    const u = await user();
    const created = await service.create(u.id);

    // Both turns read version 0 before either model call resolves, so exactly one update matches.
    model.delayMs = 60;
    const a = new RecordingSink();
    const b = new RecordingSink();
    const racing = build();
    await Promise.all([
      racing.turn(u.id, created.id, { content: "first" }, () => a, new AbortController().signal),
      racing.turn(u.id, created.id, { content: "second" }, () => b, new AbortController().signal),
    ]);
    model.delayMs = 0;

    const outcomes = [a, b].map((sink) => sink.events.at(-2));
    const states = outcomes.filter((event) => event?.name === "state");
    const conflicts = outcomes.filter(
      (event) => event?.name === "error" && (event.data as { code: string }).code === "CONFLICT",
    );
    expect(states).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(a.names.at(-1)).toBe("done");
    expect(b.names.at(-1)).toBe("done");

    // Exactly one turn landed: one user message, one assistant message, one question counted.
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.messages).toHaveLength(3);
    expect(row.questionCount).toBe(1);
    expect(row.version).toBe(1);
  });

  it("persists nothing when the deadline passes while the model is thinking", async () => {
    const u = await user();
    const created = await service.create(u.id);
    model.delayMs = 200;
    const sink = new RecordingSink();
    await build({ turnTimeoutMs: 30 }).turn(
      u.id,
      created.id,
      { content: "an answer" },
      () => sink,
      new AbortController().signal,
    );
    model.delayMs = 0;

    expect(sink.events.at(-2)).toMatchObject({ name: "error", data: { code: "UPSTREAM_ERROR" } });
    expect(sink.names.at(-1)).toBe("done");
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.messages).toHaveLength(1);
    expect(row.version).toBe(0);
  });

  it("streams error with code CONFLICT when a filing lands mid-turn", async () => {
    const u = await user();
    const created = await service.create(u.id);
    const sink = new RecordingSink();
    const filesMidTurn: InterviewModel = {
      respond: async (_input, onDelta) => {
        onDelta("Thinking.");
        // Whatever else happened to this conversation while the model was thinking.
        await (await service.attachToIssue(u.id, created.id)).markFiled(11);
        return {
          kind: "ok",
          turn: {
            reply: "Thinking.",
            question: { text: "Who?", options: ["a", "b", "c"], recommended: "a" },
            draft: EMPTY_DRAFT,
            score: lowScore,
            done: false,
            stillMissing: [],
          },
        };
      },
    };

    await build({ model: filesMidTurn }).turn(
      u.id,
      created.id,
      { content: "an answer" },
      () => sink,
      new AbortController().signal,
    );

    expect(sink.events.at(-2)).toMatchObject({ name: "error", data: { code: "CONFLICT" } });
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.status).toBe("filed");
    expect(row.issueNumber).toBe(11);
    expect(row.messages).toHaveLength(1);
  });
});

/**
 * `db` with one seam: a transaction started through it stays open until `released` resolves. That
 * is the repository test's technique (`tests/db/feature-request-conversations-repo.test.ts`) one
 * layer up, so the two racing calls are real `service.create` calls and the second really blocks on
 * the partial unique index instead of serialising behind a committed row.
 */
function dbHoldingTransactionsUntil(released: Promise<void>): Db {
  const holding = Object.create(db) as Db;
  Object.defineProperty(holding, "transaction", {
    value: (fn: Parameters<Db["transaction"]>[0]) =>
      db.transaction(async (tx) => {
        const result = await fn(tx);
        await released;
        return result;
      }),
  });
  return holding;
}

describe("two creates racing", () => {
  it("collides on the partial unique index: one create wins, the other is CONFLICT", async () => {
    const u = await user();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // A inserts and holds the index; B abandons nothing (A is uncommitted) and then blocks on the
    // insert until A commits, which is the 23505 the service has to turn into CONFLICT.
    const a = build({ db: dbHoldingTransactionsUntil(held) }).create(u.id);
    await sleep(100);
    const b = service.create(u.id);
    await sleep(100);
    release();

    const results = await Promise.allSettled([a, b]);
    const rejections = results.filter((r) => r.status === "rejected");
    const wins = results.filter((r) => r.status === "fulfilled");
    // Exactly one collided: this test is worthless if both creates simply serialise.
    expect(rejections).toHaveLength(1);
    expect(wins).toHaveLength(1);
    const reason = (rejections[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(AppError);
    expect((reason as AppError).code).toBe("CONFLICT");

    const live = await findLiveConversation(db, u.id);
    expect(live?.status).toBe("open");
    // The loser rolled back whole: the winner's conversation is the live one, untouched.
    expect(live?.id).toBe((wins[0] as PromiseFulfilledResult<Conversation>).value.id);
  });
});

describe("turn refuses before the stream starts", () => {
  it("is NOT_FOUND for another user's conversation and never opens the sink", async () => {
    const owner = await user();
    const other = await user();
    const created = await service.create(owner.id);
    let opened = 0;
    await expect(
      service.turn(
        other.id,
        created.id,
        { content: "hi" },
        () => {
          opened += 1;
          return new RecordingSink();
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(opened).toBe(0);
  });

  it("is CONFLICT once the conversation is ready, filed or abandoned", async () => {
    const u = await user();
    const created = await service.create(u.id);
    await service.abandon(u.id);
    await expect(
      service.turn(
        u.id,
        created.id,
        { content: "hi" },
        () => new RecordingSink(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("is RATE_LIMITED with the reset hour, and UNAVAILABLE when AI is paused", async () => {
    const u = await user();
    const created = await service.create(u.id);
    const denied = build({
      rateLimiter: limiterReturning({
        ...allow,
        allowed: false,
        reason: "rate_limited",
        remaining: 0,
      }),
    });
    await expect(
      denied.turn(
        u.id,
        created.id,
        { content: "hi" },
        () => new RecordingSink(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { scope: "user", limit: 60, resetAt: "2026-09-10T10:00:00.000Z" },
    });
    const paused = build({
      rateLimiter: limiterReturning({
        ...allow,
        allowed: false,
        reason: "ai_disabled",
        limit: 0,
        remaining: 0,
      }),
    });
    await expect(
      paused.turn(
        u.id,
        created.id,
        { content: "hi" },
        () => new RecordingSink(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("turn fails after the stream started", () => {
  it("emits error then done and persists nothing when both attempts return invalid", async () => {
    const u = await user();
    const created = await service.create(u.id);
    model.mode = "invalid";
    const sink = await answer(u.id, created.id, "Supervisors cannot see the drag.");
    expect(sink.names.at(-2)).toBe("error");
    expect(sink.names.at(-1)).toBe("done");
    expect(sink.events.at(-2)?.data).toMatchObject({ code: "UPSTREAM_ERROR" });
    // One retry, then the error: the second bad answer is the last one this turn asks for.
    expect(model.calls).toHaveLength(2);
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.messages).toHaveLength(1);
    expect(row.questionCount).toBe(0);
  });

  it("retries an invalid turn once and persists the second attempt", async () => {
    const u = await user();
    const created = await service.create(u.id);
    // Invalid on the first call only; the fake falls back to its scripted turn on the second.
    model.modes = ["invalid"];
    const sink = await answer(u.id, created.id, "Supervisors cannot see the drag.");

    expect(model.calls).toHaveLength(2);
    expect(sink.names.filter((name) => name === "state")).toHaveLength(1);
    expect(sink.names.filter((name) => name === "error")).toHaveLength(0);
    expect(sink.names.at(-2)).toBe("state");
    expect(sink.names.at(-1)).toBe("done");

    // The first attempt already streamed a reply that is now void. One newline between the two
    // keeps the browser from gluing the second reply onto the first.
    const deltas = sink.events
      .filter((event) => event.name === "delta")
      .map((event) => (event.data as { text: string }).text);
    expect(deltas).toHaveLength(7);
    expect(deltas[3]).toBe("\n");

    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.messages).toHaveLength(3);
    expect(row.questionCount).toBe(1);
    expect(row.status).toBe("open");
    // What was persisted is the second attempt's reply, not the two glued together.
    expect(row.messages[2]?.content).toBe(deltas.slice(4).join(""));
  });

  it("emits UPSTREAM_ERROR when the model throws the adapter's transport error", async () => {
    const u = await user();
    const created = await service.create(u.id);
    const throwing: InterviewModel = {
      respond: () => Promise.reject(new ModelRetryableError(new Error("429 Too Many Requests"))),
    };
    const sink = new RecordingSink();
    await build({ model: throwing }).turn(
      u.id,
      created.id,
      { content: "hi" },
      () => sink,
      new AbortController().signal,
    );
    expect(sink.names).toEqual(["error", "done"]);
    expect(sink.events[0]?.data).toMatchObject({ code: "UPSTREAM_ERROR" });
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.messages).toHaveLength(1);
  });

  it("emits INTERNAL when the model throws a bare Error", async () => {
    const u = await user();
    const created = await service.create(u.id);
    const throwing: InterviewModel = {
      respond: () => Promise.reject(new Error("upstream exploded")),
    };
    const sink = new RecordingSink();
    await build({ model: throwing }).turn(
      u.id,
      created.id,
      { content: "hi" },
      () => sink,
      new AbortController().signal,
    );
    expect(sink.names).toEqual(["error", "done"]);
    expect(sink.events[0]?.data).toMatchObject({ code: "INTERNAL" });
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.messages).toHaveLength(1);
  });

  it("persists nothing and writes nothing more once the client disconnects", async () => {
    const u = await user();
    const created = await service.create(u.id);
    const sink = new RecordingSink();
    const leaving: InterviewModel = {
      respond: (_input, onDelta) => {
        onDelta("half a sentence");
        sink.disconnect();
        return Promise.resolve({
          kind: "ok",
          turn: {
            reply: "half a sentence",
            question: { text: "Who?", options: ["a", "b", "c"], recommended: "a" },
            draft: EMPTY_DRAFT,
            score: {
              clarity: 2,
              complexity: 2,
              risk: 2,
              archChange: false,
              readiness: 12,
              reasons: { clarity: "c", complexity: "x", risk: "r" },
            },
            done: false,
            stillMissing: [],
          },
        });
      },
    };
    await build({ model: leaving }).turn(
      u.id,
      created.id,
      { content: "hi" },
      () => sink,
      new AbortController().signal,
    );
    expect(sink.names).toEqual(["delta"]);
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.messages).toHaveLength(1);
  });
});

describe("attachToIssue", () => {
  it("renders the section and marks the conversation filed only when told to", async () => {
    const u = await user();
    const created = await service.create(u.id);
    await answer(u.id, created.id, "Supervisors cannot see the drag.");

    const attachment = await service.attachToIssue(u.id, created.id);
    expect(attachment.conversationId).toBe(created.id);
    expect(attachment.section).toContain("How this request was refined");
    expect(attachment.section).toContain("Rubric version:");
    expect((await findOwnedConversation(db, created.id, u.id))?.status).toBe("open");

    await attachment.markFiled(42);
    const row = (await findOwnedConversation(db, created.id, u.id))!;
    expect(row.status).toBe("filed");
    expect(row.issueNumber).toBe(42);
  });

  it("is NOT_FOUND for another user and CONFLICT once already filed", async () => {
    const owner = await user();
    const other = await user();
    const created = await service.create(owner.id);
    await expect(service.attachToIssue(other.id, created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await (await service.attachToIssue(owner.id, created.id)).markFiled(7);
    await expect(service.attachToIssue(owner.id, created.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
