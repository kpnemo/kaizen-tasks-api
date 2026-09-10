import type { DestinationStream } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import { findOwnedConversation } from "../../src/repositories/feature-request-conversations.js";
import { GREETING } from "../../src/services/feature-request-conversations.js";
import type { GitHubIssues } from "../../src/services/feature-requests.js";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser } from "../helpers/auth.js";

const URL = "/api/v1/feature-requests";
const body = {
  title: "Bulk accept from the task list",
  problem: "Accepting suggestions one task at a time is slow when many tasks finish together.",
  proposedBehavior: "A checkbox per task on the list and an Accept all suggestions button.",
  acceptanceCriteria:
    "Given three tasks with suggestions, selecting them and pressing the button accepts every suggestion.",
  outOfScope: "Dismissing in bulk.",
};

class FakeIssues implements GitHubIssues {
  calls: Parameters<GitHubIssues["create"]>[0][] = [];
  fail = false;
  async create(params: Parameters<GitHubIssues["create"]>[0]) {
    this.calls.push(params);
    if (this.fail) throw new Error("GitHub is down");
    return {
      number: 42,
      html_url: "https://github.com/kpnemo/kaizen-tasks-assembly-line/issues/42",
    };
  }
}

/** Captures pino output in memory so a test can assert on what actually got logged. */
class CapturingDestination implements DestinationStream {
  private lines: string[] = [];
  write(msg: string): void {
    this.lines.push(msg);
  }
  get text(): string {
    return this.lines.join("");
  }
}

/** Shaped like an Octokit RequestError: `.status` plus the raw GitHub response on `.response`. */
class LeakyIssues implements GitHubIssues {
  async create(): ReturnType<GitHubIssues["create"]> {
    throw Object.assign(new Error("Validation Failed"), {
      status: 422,
      response: { data: { message: "secret-marker" } },
    });
  }
}

let plain: TestContext;
let configured: TestContext;
let leaky: TestContext;
const issues = new FakeIssues();
const leakyLog = new CapturingDestination();
beforeAll(async () => {
  plain = await createTestApp();
  configured = await createTestApp(
    { GITHUB_TOKEN: "ghp_test_token", GITHUB_REPO: "kpnemo/kaizen-tasks-assembly-line" },
    { github: issues },
  );
  leaky = await createTestApp(
    { GITHUB_TOKEN: "ghp_test_token", GITHUB_REPO: "kpnemo/kaizen-tasks-assembly-line" },
    { github: new LeakyIssues(), logger: createLogger("error", leakyLog) },
  );
});
afterAll(async () => {
  await plain.close();
  await configured.close();
  await leaky.close();
});

describe("POST /feature-requests", () => {
  it("is absent when GITHUB_TOKEN and GITHUB_REPO are not set", async () => {
    const user = await registerUser(plain.server);
    const res = await request(plain.server).post(URL).set(auth(user.token)).send(body);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("requires authentication and validates the body", async () => {
    expect((await request(configured.server).post(URL).send(body)).status).toBe(401);
    const user = await registerUser(configured.server);
    const res = await request(configured.server)
      .post(URL)
      .set(auth(user.token))
      .send({ title: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain("body.problem");
  });

  it("creates a labeled issue carrying the submitter's display name", async () => {
    const user = await registerUser(configured.server, { displayName: "Ada Lovelace" });
    const res = await request(configured.server).post(URL).set(auth(user.token)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      issueNumber: 42,
      issueUrl: "https://github.com/kpnemo/kaizen-tasks-assembly-line/issues/42",
    });
    const call = issues.calls.at(-1)!;
    expect(call).toMatchObject({
      owner: "kpnemo",
      repo: "kaizen-tasks-assembly-line",
      title: body.title,
      labels: ["feature-request"],
    });
    expect(call.body).toContain("Ada Lovelace");
    for (const heading of [
      "## Problem statement",
      "## Proposed behavior",
      "## Acceptance criteria",
      "## Out of scope",
    ]) {
      expect(call.body).toContain(heading);
    }
    expect(call.body).toContain(body.acceptanceCriteria);
    expect(call.body).not.toContain(user.email);
  });

  it("maps GitHub failures to UPSTREAM_ERROR", async () => {
    const user = await registerUser(configured.server);
    issues.fail = true;
    try {
      const res = await request(configured.server).post(URL).set(auth(user.token)).send(body);
      expect(res.status).toBe(502);
      expect(res.body.error).toMatchObject({
        code: "UPSTREAM_ERROR",
        message: "Could not create the GitHub issue",
      });
    } finally {
      issues.fail = false;
    }
  });

  it("never logs the raw GitHub response, only the status and message", async () => {
    const user = await registerUser(leaky.server);
    const res = await request(leaky.server).post(URL).set(auth(user.token)).send(body);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("UPSTREAM_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("secret-marker");
    expect(leakyLog.text).not.toContain("secret-marker");
    expect(leakyLog.text).toContain("422");
  });
});

const CONVERSATION = `${URL}/conversation`;

describe("the conversation routes are mounted with the feature-request route", () => {
  it("are absent when GITHUB_TOKEN and GITHUB_REPO are not set", async () => {
    const user = await registerUser(plain.server);
    for (const res of [
      await request(plain.server).get(CONVERSATION).set(auth(user.token)),
      await request(plain.server).post(CONVERSATION).set(auth(user.token)),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
  });

  it("require authentication", async () => {
    expect((await request(configured.server).get(CONVERSATION)).status).toBe(401);
    expect((await request(configured.server).post(CONVERSATION)).status).toBe(401);
  });

  it("is NOT_FOUND before the first conversation, then creates and resumes one", async () => {
    const user = await registerUser(configured.server);
    const missing = await request(configured.server).get(CONVERSATION).set(auth(user.token));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");

    const created = await request(configured.server).post(CONVERSATION).set(auth(user.token));
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe("open");
    expect(created.body.data.messages).toHaveLength(1);
    expect(created.body.data.messages[0]).toMatchObject({ role: "assistant", content: GREETING });
    expect(created.body.data.draft).toEqual({
      title: "",
      problem: "",
      proposedBehavior: "",
      acceptanceCriteria: "",
      outOfScope: "",
    });
    expect(created.body.meta.requestId).toBeTruthy();

    const resumed = await request(configured.server).get(CONVERSATION).set(auth(user.token));
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.id).toBe(created.body.data.id);

    const restarted = await request(configured.server).post(CONVERSATION).set(auth(user.token));
    expect(restarted.body.data.id).not.toBe(created.body.data.id);
    expect(
      (await findOwnedConversation(configured.db, created.body.data.id, user.userId))?.status,
    ).toBe("abandoned");
  });
});

describe("POST /feature-requests with a conversationId", () => {
  async function startConversation(token: string): Promise<string> {
    const res = await request(configured.server).post(CONVERSATION).set(auth(token));
    return res.body.data.id as string;
  }

  it("appends the refinement section and marks the conversation filed", async () => {
    const user = await registerUser(configured.server, { displayName: "Ada Lovelace" });
    const conversationId = await startConversation(user.token);

    const res = await request(configured.server)
      .post(URL)
      .set(auth(user.token))
      .send({ ...body, conversationId });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      issueNumber: 42,
      issueUrl: "https://github.com/kpnemo/kaizen-tasks-assembly-line/issues/42",
    });
    const issueBody = issues.calls.at(-1)!.body;
    expect(issueBody).toContain("## Problem statement");
    expect(issueBody).toContain("How this request was refined (assistant interview)");
    expect(issueBody).toContain("Rubric version:");
    expect(issueBody).toContain(`- **Assistant:** ${GREETING}`);

    const row = await findOwnedConversation(configured.db, conversationId, user.userId);
    expect(row?.status).toBe("filed");
    expect(row?.issueNumber).toBe(42);
  });

  it("files without a section when no conversationId is given", async () => {
    const user = await registerUser(configured.server);
    const res = await request(configured.server).post(URL).set(auth(user.token)).send(body);
    expect(res.status).toBe(201);
    expect(issues.calls.at(-1)!.body).not.toContain("How this request was refined");
  });

  it("rejects a conversation that is not the caller's, before creating an issue", async () => {
    const owner = await registerUser(configured.server);
    const other = await registerUser(configured.server);
    const conversationId = await startConversation(owner.token);
    const before = issues.calls.length;

    const res = await request(configured.server)
      .post(URL)
      .set(auth(other.token))
      .send({ ...body, conversationId });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(issues.calls).toHaveLength(before);
  });

  it("rejects a conversation that was already filed", async () => {
    const user = await registerUser(configured.server);
    const conversationId = await startConversation(user.token);
    await request(configured.server)
      .post(URL)
      .set(auth(user.token))
      .send({ ...body, conversationId });
    const before = issues.calls.length;

    const res = await request(configured.server)
      .post(URL)
      .set(auth(user.token))
      .send({ ...body, conversationId });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(issues.calls).toHaveLength(before);
  });

  it("validates the conversationId as a uuid", async () => {
    const user = await registerUser(configured.server);
    const res = await request(configured.server)
      .post(URL)
      .set(auth(user.token))
      .send({ ...body, conversationId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(
      "body.conversationId",
    );
  });
});
