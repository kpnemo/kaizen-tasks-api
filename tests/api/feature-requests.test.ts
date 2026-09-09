import type { DestinationStream } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
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
    const user = await registerUser(plain.app);
    const res = await request(plain.app).post(URL).set(auth(user.token)).send(body);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("requires authentication and validates the body", async () => {
    expect((await request(configured.app).post(URL).send(body)).status).toBe(401);
    const user = await registerUser(configured.app);
    const res = await request(configured.app).post(URL).set(auth(user.token)).send({ title: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain("body.problem");
  });

  it("creates a labeled issue carrying the submitter's display name", async () => {
    const user = await registerUser(configured.app, { displayName: "Ada Lovelace" });
    const res = await request(configured.app).post(URL).set(auth(user.token)).send(body);
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
    const user = await registerUser(configured.app);
    issues.fail = true;
    try {
      const res = await request(configured.app).post(URL).set(auth(user.token)).send(body);
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
    const user = await registerUser(leaky.app);
    const res = await request(leaky.app).post(URL).set(auth(user.token)).send(body);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("UPSTREAM_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("secret-marker");
    expect(leakyLog.text).not.toContain("secret-marker");
    expect(leakyLog.text).toContain("422");
  });
});
