import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_INTERVIEW_SCORE } from "../../src/agent/interview/fake-interview-model.js";
import { FINISHED_CONTENT, SKIPPED_CONTENT } from "../../src/lib/interview-constants.js";
import { findOwnedConversation } from "../../src/repositories/feature-request-conversations.js";
import type { GitHubIssues } from "../../src/services/feature-requests.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser } from "../helpers/auth.js";

const GITHUB = {
  GITHUB_TOKEN: "ghp_test_token",
  GITHUB_REPO: "kpnemo/kaizen-tasks-assembly-line",
};
const CONVERSATION = "/api/v1/feature-requests/conversation";
const SUBMIT = "/api/v1/feature-requests";

const requestBody = {
  title: "Show what drags a team's score",
  problem: "Supervisors cannot see which contact reasons drag a team's score down.",
  proposedBehavior: "A list of agents with the contact reasons where they score below the team.",
  acceptanceCriteria: "Opening the page for a team of 12 shows all 12 agents within 2 seconds.",
};

class FakeIssues implements GitHubIssues {
  async list(): ReturnType<GitHubIssues["list"]> {
    return [];
  }
  calls: Parameters<GitHubIssues["create"]>[0][] = [];
  async create(params: Parameters<GitHubIssues["create"]>[0]) {
    this.calls.push(params);
    return {
      number: 100 + this.calls.length,
      html_url: `https://github.com/kpnemo/kaizen-tasks-assembly-line/issues/${100 + this.calls.length}`,
    };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A real socket that is destroyed as soon as the first stream chunk arrives. supertest buffers a
 * whole response, so only a raw request can model a PM closing the tab mid-turn.
 */
function disconnectAfterFirstChunk(
  server: Server,
  token: string,
  id: string,
  body: object,
): Promise<void> {
  const { port } = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `${CONVERSATION}/${id}/messages`,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
        res.once("end", () => resolve());
      },
    );
    req.on("error", () => resolve());
    req.end(payload);
  });
}

/**
 * A real socket destroyed as soon as the request has been written, before a single response byte
 * comes back. That is the window `openSse` cannot see: its `close` listener goes on only once the
 * service's ownership, status and rate-limit round trips are done, so a tab closed during them was
 * invisible until the route started listening first.
 */
function disconnectBeforeResponse(
  server: Server,
  token: string,
  id: string,
  body: object,
): Promise<void> {
  const { port } = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `${CONVERSATION}/${id}/messages`,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => res.resume(),
    );
    req.on("error", () => resolve());
    req.end(payload, () => {
      req.destroy();
      resolve();
    });
  });
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Splits a buffered `text/event-stream` body into its events, ignoring `: ping` comments. */
function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").filter((line) => line.length > 0))
    .filter((lines) => lines.some((line) => line.startsWith("event: ")))
    .map((lines) => ({
      event: lines.find((line) => line.startsWith("event: "))!.slice("event: ".length),
      data: JSON.parse(
        lines.find((line) => line.startsWith("data: "))!.slice("data: ".length),
      ) as Record<string, unknown>,
    }));
}

let ctx: TestContext;
let limited: TestContext;
let impatient: TestContext;
const issues = new FakeIssues();

beforeAll(async () => {
  ctx = await createTestApp(GITHUB, { github: issues });
  limited = await createTestApp({ ...GITHUB, INTERVIEW_HOURLY_LIMIT: 1 });
  // A 40 ms per-turn deadline, so the timeout path finishes in milliseconds instead of 45 seconds.
  impatient = await createTestApp(GITHUB, { github: issues, interviewTurnTimeoutMs: 40 });
});
afterAll(async () => {
  await ctx.close();
  await limited.close();
  await impatient.close();
});

async function startConversation(context: TestContext, token: string): Promise<string> {
  const res = await request(context.server).post(CONVERSATION).set(auth(token));
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

function sendTurn(
  context: TestContext,
  token: string,
  id: string,
  body: { content: string; skip?: boolean; finish?: boolean },
) {
  return request(context.server).post(`${CONVERSATION}/${id}/messages`).set(auth(token)).send(body);
}

describe("POST /feature-requests/conversation/{id}/messages", () => {
  it("streams deltas, then one state carrying the new question, then done", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);

    const res = await sendTurn(ctx, user.token, id, {
      content: "Supervisors cannot see which contact reasons drag a team's score down.",
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["x-accel-buffering"]).toBe("no");

    const events = parseSse(res.text);
    const deltas = events.filter((e) => e.event === "delta");
    expect(deltas).toHaveLength(3);
    expect(events.at(-2)?.event).toBe("state");
    expect(events.at(-1)).toEqual({ event: "done", data: {} });

    const conversation = (events.at(-2)!.data as { conversation: Record<string, unknown> })
      .conversation;
    expect(conversation.status).toBe("open");
    expect(conversation.questionCount).toBe(1);
    const messages = conversation.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages[2]?.role).toBe("assistant");
    expect(messages[2]?.options).toEqual([
      "A team supervisor before a coaching session",
      "An agent during a call",
      "A workforce planner on Monday",
    ]);
    expect(deltas.map((d) => d.data.text).join("")).toBe(messages[2]?.content);

    const row = await findOwnedConversation(ctx.db, id, user.userId);
    expect(row?.questionCount).toBe(1);
    expect(row?.messages).toHaveLength(3);
  });

  it("reaches ready with a complete draft after four answers", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    let last = "";
    for (const content of [
      "Supervisors cannot see which contact reasons drag a team's score down.",
      "A team supervisor before a coaching session.",
      "A list of agents with the contact reasons where they score below the team.",
      "Opening the page for a team of 12 shows all 12 agents within 2 seconds.",
    ]) {
      const res = await sendTurn(ctx, user.token, id, { content });
      expect(res.status).toBe(200);
      last = res.text;
    }
    const state = parseSse(last).find((e) => e.event === "state")!;
    const conversation = (state.data as { conversation: Record<string, unknown> }).conversation;
    expect(conversation.status).toBe("ready");
    expect(conversation.questionCount).toBe(3);
    expect(conversation.score).toEqual(FAKE_INTERVIEW_SCORE);
    const draft = conversation.draft as Record<string, string>;
    expect(draft.acceptanceCriteria).toContain("2 seconds");
    // Every field the four answers imply is filled from what the PM actually said. `outOfScope` is
    // the one the scripted ladder never reaches, and the fake never invents prose for it.
    for (const field of ["title", "problem", "proposedBehavior", "acceptanceCriteria"]) {
      expect(draft[field]?.length).toBeGreaterThan(0);
    }
    expect(draft.problem).toContain("A team supervisor before a coaching session.");
    expect(draft.proposedBehavior).toBe(
      "A list of agents with the contact reasons where they score below the team.",
    );
    expect(draft.outOfScope).toBe("");
  });

  it("counts a skip as an answered question and records (skipped)", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);

    const res = await sendTurn(ctx, user.token, id, { content: SKIPPED_CONTENT, skip: true });
    expect(res.status).toBe(200);

    const row = (await findOwnedConversation(ctx.db, id, user.userId))!;
    expect(row.messages[1]).toMatchObject({ content: SKIPPED_CONTENT, skipped: true });
    expect(row.questionCount).toBe(1);
    expect(ctx.interviewModel.calls.at(-1)?.skippedLast).toBe(true);
  });

  it("persists the recommended answer on the assistant's question", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    const res = await sendTurn(ctx, user.token, id, {
      content: "Supervisors cannot see the drag.",
    });
    const state = parseSse(res.text).find((e) => e.event === "state")!.data as {
      conversation: { messages: Array<Record<string, unknown>> };
    };
    const asked = state.conversation.messages.at(-1)!;
    expect(asked.options).toContain(asked.recommended);
  });

  it("finish ends the interview as ready without counting a question", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    await sendTurn(ctx, user.token, id, { content: "Supervisors cannot see the drag." });
    const res = await sendTurn(ctx, user.token, id, { content: FINISHED_CONTENT, finish: true });
    expect(res.status).toBe(200);
    const state = parseSse(res.text).find((e) => e.event === "state")!.data as {
      conversation: Record<string, unknown>;
    };
    expect(state.conversation.status).toBe("ready");
    expect(state.conversation.questionCount).toBe(1);
    const messages = state.conversation.messages as Array<Record<string, unknown>>;
    expect(messages.at(-2)).toMatchObject({
      role: "user",
      content: FINISHED_CONTENT,
      finished: true,
    });
    expect(messages.at(-1)).not.toHaveProperty("options");
  });

  it("rejects skip together with finish", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    const res = await sendTurn(ctx, user.token, id, { content: "x", skip: true, finish: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("is 404 for another user's conversation, with a JSON envelope and no stream", async () => {
    const owner = await registerUser(ctx.server);
    const other = await registerUser(ctx.server);
    const id = await startConversation(ctx, owner.token);

    const res = await sendTurn(ctx, other.token, id, { content: "hello" });

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("is 409 once the conversation is ready or abandoned", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    for (const content of ["one", "two", "three", "four"]) {
      await sendTurn(ctx, user.token, id, { content });
    }
    expect((await findOwnedConversation(ctx.db, id, user.userId))?.status).toBe("ready");

    const afterReady = await sendTurn(ctx, user.token, id, { content: "five" });
    expect(afterReady.status).toBe(409);
    expect(afterReady.body.error.code).toBe("CONFLICT");

    await request(ctx.server).post(CONVERSATION).set(auth(user.token));
    const afterAbandon = await sendTurn(ctx, user.token, id, { content: "six" });
    expect(afterAbandon.status).toBe(409);
    expect(afterAbandon.body.error.code).toBe("CONFLICT");
  });

  it("is 429 before the stream starts once the hourly limit is spent", async () => {
    const user = await registerUser(limited.server);
    const id = await startConversation(limited, user.token);

    expect((await sendTurn(limited, user.token, id, { content: "one" })).status).toBe(200);
    const denied = await sendTurn(limited, user.token, id, { content: "two" });

    expect(denied.status).toBe(429);
    expect(denied.headers["content-type"]).toContain("application/json");
    expect(denied.body.error.code).toBe("RATE_LIMITED");
    expect(denied.body.error.details).toMatchObject({ scope: "user", limit: 1 });
    expect(denied.body.error.details.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
    expect((await findOwnedConversation(limited.db, id, user.userId))?.questionCount).toBe(1);
  });

  it("emits an error event and persists nothing when the model returns invalid", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    ctx.interviewModel.mode = "invalid";
    try {
      const res = await sendTurn(ctx, user.token, id, { content: "Supervisors cannot see it." });

      expect(res.status).toBe(200);
      const events = parseSse(res.text);
      expect(events.at(-2)).toMatchObject({
        event: "error",
        data: { code: "UPSTREAM_ERROR" },
      });
      expect(events.at(-1)?.event).toBe("done");
      expect(events.some((e) => e.event === "state")).toBe(false);

      const row = (await findOwnedConversation(ctx.db, id, user.userId))!;
      expect(row.messages).toHaveLength(1);
      expect(row.questionCount).toBe(0);
      expect(row.status).toBe("open");
    } finally {
      ctx.interviewModel.mode = "ok";
    }
  });

  it("validates the body and the path id, and requires authentication", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);

    const empty = await sendTurn(ctx, user.token, id, { content: "   " });
    expect(empty.status).toBe(400);
    expect(empty.body.error.details.map((d: { path: string }) => d.path)).toContain("body.content");

    const tooLong = await sendTurn(ctx, user.token, id, { content: "x".repeat(2001) });
    expect(tooLong.status).toBe(400);

    const badId = await request(ctx.server)
      .post(`${CONVERSATION}/not-a-uuid/messages`)
      .set(auth(user.token))
      .send({ content: "hi" });
    expect(badId.status).toBe(400);
    expect(badId.body.error.details.map((d: { path: string }) => d.path)).toContain("params.id");

    const anonymous = await request(ctx.server)
      .post(`${CONVERSATION}/${id}/messages`)
      .send({ content: "hi" });
    expect(anonymous.status).toBe(401);
  });

  it("ends the HTTP body immediately after the done event", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    const res = await sendTurn(ctx, user.token, id, { content: "Supervisors cannot see it." });
    expect(res.text.trimEnd().endsWith("data: {}")).toBe(true);
    expect(parseSse(res.text).at(-1)?.event).toBe("done");
  });
});

describe("cancellation", () => {
  it("streams UPSTREAM_ERROR and persists nothing when the per-turn deadline passes", async () => {
    const user = await registerUser(impatient.server);
    const id = await startConversation(impatient, user.token);
    impatient.interviewModel.delayMs = 300;
    try {
      const res = await sendTurn(impatient, user.token, id, { content: "an answer" });
      expect(res.status).toBe(200);
      const events = parseSse(res.text);
      expect(events.at(-2)).toMatchObject({ event: "error", data: { code: "UPSTREAM_ERROR" } });
      expect(events.at(-1)?.event).toBe("done");
      const row = (await findOwnedConversation(impatient.db, id, user.userId))!;
      expect(row.messages).toHaveLength(1);
      expect(row.questionCount).toBe(0);
      expect(row.version).toBe(0);
    } finally {
      impatient.interviewModel.delayMs = 0;
    }
  });

  it("opens no stream and calls no model when the client is gone before the first byte", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    const before = (await findOwnedConversation(ctx.db, id, user.userId))!;
    const callsBefore = ctx.interviewModel.calls.length;
    ctx.interviewModel.delayMs = 120;
    try {
      await disconnectBeforeResponse(ctx.server, user.token, id, { content: "an answer" });
      // Long enough for a turn that had started to have finished streaming and persisted.
      await sleep(400);

      const row = (await findOwnedConversation(ctx.db, id, user.userId))!;
      expect(row.questionCount).toBe(before.questionCount);
      expect(row.version).toBe(before.version);
      expect(row.messages).toHaveLength(before.messages.length);
      expect(row.status).toBe("open");
      // The turn never reached the model, so nothing was spent on it either.
      expect(ctx.interviewModel.calls).toHaveLength(callsBefore);
    } finally {
      ctx.interviewModel.delayMs = 0;
    }
  });

  it("leaves the conversation untouched when the client disconnects mid-stream", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    const before = (await findOwnedConversation(ctx.db, id, user.userId))!;
    ctx.interviewModel.delayMs = 120;
    try {
      await disconnectAfterFirstChunk(ctx.server, user.token, id, { content: "an answer" });
      // Long enough for the model's remaining chunks to have been due.
      await sleep(400);

      const resumed = await request(ctx.server).get(CONVERSATION).set(auth(user.token));
      expect(resumed.status).toBe(200);
      expect(resumed.body.data.id).toBe(id);
      expect(resumed.body.data.messages).toHaveLength(before.messages.length);
      expect(resumed.body.data.questionCount).toBe(0);
      expect(resumed.body.data.status).toBe("open");
    } finally {
      ctx.interviewModel.delayMs = 0;
    }
  });
});

describe("two turns racing", () => {
  it("writes one of them and answers the other with an error carrying CONFLICT", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    ctx.interviewModel.delayMs = 80;
    try {
      const [a, b] = await Promise.all([
        sendTurn(ctx, user.token, id, { content: "first" }),
        sendTurn(ctx, user.token, id, { content: "second" }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const last = [a, b].map((res) => parseSse(res.text).at(-2));
      expect(last.filter((event) => event?.event === "state")).toHaveLength(1);
      const conflicts = last.filter(
        (event) => event?.event === "error" && (event.data as { code: string }).code === "CONFLICT",
      );
      expect(conflicts).toHaveLength(1);

      const row = (await findOwnedConversation(ctx.db, id, user.userId))!;
      expect(row.messages).toHaveLength(3);
      expect(row.questionCount).toBe(1);
      expect(row.version).toBe(1);
    } finally {
      ctx.interviewModel.delayMs = 0;
    }
  });

  it("lets a filing land mid-turn and tells the turn CONFLICT", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    ctx.interviewModel.delayMs = 150;
    try {
      // A supertest request is lazy: chaining .then is what actually puts it on the wire, so the
      // filing below really does land while this turn is waiting on the model.
      const turning = sendTurn(ctx, user.token, id, { content: "an answer" }).then((res) => res);
      await sleep(40);
      const filed = await request(ctx.server)
        .post(SUBMIT)
        .set(auth(user.token))
        .send({ ...requestBody, conversationId: id });
      expect(filed.status).toBe(201);

      const events = parseSse((await turning).text);
      expect(events.at(-2)).toMatchObject({ event: "error", data: { code: "CONFLICT" } });
      const row = (await findOwnedConversation(ctx.db, id, user.userId))!;
      expect(row.status).toBe("filed");
      expect(row.messages).toHaveLength(1);
    } finally {
      ctx.interviewModel.delayMs = 0;
    }
  });
});

describe("the conversation lifecycle around filing", () => {
  it("is 409 on messages once the conversation has been filed", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    await sendTurn(ctx, user.token, id, { content: "Supervisors cannot see it." });

    const filed = await request(ctx.server)
      .post(SUBMIT)
      .set(auth(user.token))
      .send({ ...requestBody, conversationId: id });
    expect(filed.status).toBe(201);

    const afterFiling = await sendTurn(ctx, user.token, id, { content: "one more" });
    expect(afterFiling.status).toBe(409);
    expect(afterFiling.headers["content-type"]).toContain("application/json");
    expect(afterFiling.body.error.code).toBe("CONFLICT");
  });

  it("is 404 on GET once the conversation has been filed", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    await request(ctx.server)
      .post(SUBMIT)
      .set(auth(user.token))
      .send({ ...requestBody, conversationId: id });

    const resumed = await request(ctx.server).get(CONVERSATION).set(auth(user.token));
    expect(resumed.status).toBe(404);
    expect(resumed.body.error.code).toBe("NOT_FOUND");
  });

  it("is 409 on submit with an abandoned conversationId, and files no issue", async () => {
    const user = await registerUser(ctx.server);
    const id = await startConversation(ctx, user.token);
    // Starting over abandons the first conversation.
    await request(ctx.server).post(CONVERSATION).set(auth(user.token));
    const before = issues.calls.length;

    const res = await request(ctx.server)
      .post(SUBMIT)
      .set(auth(user.token))
      .send({ ...requestBody, conversationId: id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(issues.calls).toHaveLength(before);
  });
});
