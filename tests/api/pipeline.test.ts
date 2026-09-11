import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestContext } from "../helpers/app.js";
import { auth, registerUser } from "../helpers/auth.js";
import {
  API,
  FACILITATOR_EMAIL,
  FakePipelineGitHub,
  HARNESS,
  PASSPHRASE,
  PIPELINE_ENV,
  WEB,
  fakeFetch,
  green,
  issue,
  marker,
  pull,
  running,
  seedWorld,
  type EnvAnswer,
} from "../helpers/pipeline.js";

const URL = "/api/v1/pipeline";

let plain: TestContext;
let configured: TestContext;
const gh = new FakePipelineGitHub();
/** Mutable so a test can take one environment down; reset before each test. */
const envAnswers: Record<string, EnvAnswer> = {};

function resetEnvironments(): void {
  envAnswers["https://s.test"] = {
    api: { version: "1.3.0", commit: "c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4" },
    web: { version: "1.3.0", commit: "e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8" },
  };
  envAnswers["https://p.test"] = {
    api: { version: "1.2.0", commit: "a1774e5a1774e5a1774e5a1774e5a1774e5a1774e5" },
    web: { version: "1.2.0", commit: "33272c533272c533272c533272c533272c533272c5" },
  };
}

beforeAll(async () => {
  plain = await createTestApp();
  configured = await createTestApp(PIPELINE_ENV, {
    pipelineGithub: gh,
    fetchImpl: fakeFetch(envAnswers),
  });
});
afterAll(async () => {
  await plain.close();
  await configured.close();
});
beforeEach(() => {
  seedWorld(gh, new Date());
  gh.calls = [];
  gh.merges = [];
  gh.dispatches = [];
  gh.posted = [];
  gh.jobs = {};
  gh.failure = null;
  gh.mergeFailure = () => undefined;
  resetEnvironments();
});

const facilitator = () => registerUser(configured.server, { email: FACILITATOR_EMAIL });
const viewer = () => registerUser(configured.server);

describe("the pipeline routes are mounted only with the five settings", () => {
  it("is NOT_FOUND on the plain app", async () => {
    const user = await registerUser(plain.server);
    const res = await request(plain.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("requires a session on the configured app", async () => {
    const res = await request(configured.server).get(URL);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /pipeline", () => {
  it("builds the snapshot: environments, branches, issues with PRs, stage, readiness, next version", async () => {
    // A second, open issue: a bug at implementing with one green and one still-running PR.
    gh.issues.push(
      issue({
        number: 23,
        title: "Footer overlaps",
        labels: ["bug", "implementing"],
        createdAt: "2026-09-11T09:00:00Z",
      }),
    );
    gh.pulls[API]!.push(pull(API, { number: 21, headRef: "fix/23-footer" }));
    gh.pulls[WEB]!.push(pull(WEB, { number: 22, headRef: "fix/23-footer" }));
    gh.checks[`${API}@head-kaizen-tasks-api-21`] = [green()];
    gh.checks[`${WEB}@head-kaizen-tasks-web-22`] = [running()];

    const user = await viewer();
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    const snap = res.body.data;
    expect(snap.stale).toBe(false);
    expect(snap.canDeploy).toBe(false);
    expect(snap.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snap.nextVersion).toBe("1.4.0");
    expect(snap.ship).toEqual({ active: false, run: null });

    expect(snap.environments.staging).toEqual({
      api: {
        version: "1.3.0",
        commit: "c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4",
        db: "ok",
        redis: "ok",
      },
      web: { version: "1.3.0", commit: "e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8" },
      state: "current",
    });
    expect(snap.environments.production.state).toBe("current");
    expect(snap.branches).toEqual({
      api: {
        develop: "c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4",
        main: "a1774e5a1774e5a1774e5a1774e5a1774e5a1774e5",
      },
      web: {
        develop: "e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8",
        main: "33272c533272c533272c533272c533272c533272c5",
      },
    });

    expect(snap.issues.map((i: { number: number }) => i.number)).toEqual([23, 22, 19]);
    const [bug, feature, shipped] = snap.issues;
    expect(feature).toMatchObject({
      number: 22,
      title: "Show existing requests",
      kind: "feature-request",
      state: "open",
      stage: "staging",
      readiness: 18,
      url: `https://github.com/${HARNESS}/issues/22`,
      onStaging: true,
      productionReady: true,
      ship: null,
    });
    expect(feature.pullRequests).toEqual([
      {
        repo: "api",
        number: 18,
        url: `https://github.com/${API}/pull/18`,
        state: "merged",
        checks: null,
        mergeSha: "merged-kaizen-tasks-api-18",
        headSha: "head-kaizen-tasks-api-18",
        draft: false,
      },
      {
        repo: "web",
        number: 19,
        url: `https://github.com/${WEB}/pull/19`,
        state: "merged",
        checks: null,
        mergeSha: "merged-kaizen-tasks-web-19",
        headSha: "head-kaizen-tasks-web-19",
        draft: false,
      },
      {
        repo: "harness",
        number: 30,
        url: `https://github.com/${HARNESS}/pull/30`,
        state: "merged",
        checks: null,
        mergeSha: "merged-kaizen-tasks-assembly-line-30",
        headSha: "head-kaizen-tasks-assembly-line-30",
        draft: false,
      },
    ]);
    expect(bug).toMatchObject({
      number: 23,
      kind: "bug",
      stage: "implementing",
      readiness: null,
      onStaging: false,
      productionReady: false,
    });
    expect(bug.pullRequests.map((p: { checks: string }) => p.checks)).toEqual(["green", "pending"]);
    expect(shipped).toMatchObject({ number: 19, state: "closed", stage: "shipped" });

    // Bounded: pulls listed once per repo, check runs only for the two open heads.
    expect(gh.countOf("listPulls")).toBe(3);
    expect(gh.countOf("listIssues")).toBe(2);
    expect(gh.countOf("checkRuns")).toBe(2);
  });

  it("marks canDeploy for an allowlisted email, outside the cache", async () => {
    const a = await viewer();
    const b = await facilitator();
    const first = await request(configured.server).get(URL).set(auth(a.token));
    const second = await request(configured.server).get(URL).set(auth(b.token));
    expect(first.body.data.canDeploy).toBe(false);
    expect(second.body.data.canDeploy).toBe(true);
    expect(second.body.data.generatedAt).toBe(first.body.data.generatedAt);
    // One generation served both callers.
    expect(gh.countOf("listPulls")).toBe(3);
  });

  it("serves the last-good snapshot with stale=true when GitHub fails after a success", async () => {
    const user = await viewer();
    const ok = await request(configured.server).get(URL).set(auth(user.token));
    expect(ok.status).toBe(200);
    await configured.redis.del("pipeline:snapshot");
    gh.failure = Object.assign(new Error("boom"), { status: 503 });
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.stale).toBe(true);
    expect(res.body.data.staleReason).toEqual(expect.any(String));
    expect(res.body.data.generatedAt).toBe(ok.body.data.generatedAt);
    expect(res.body.data.issues.map((i: { number: number }) => i.number)).toEqual([22, 19]);
  });

  it("answers UPSTREAM_ERROR when GitHub fails and nothing is cached", async () => {
    const user = await viewer();
    gh.failure = Object.assign(new Error("Bad credentials"), { status: 401 });
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("UPSTREAM_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("Bad credentials");
  });

  it("shows an unreachable environment without failing the snapshot", async () => {
    envAnswers["https://p.test"] = { api: null, web: null };
    const user = await viewer();
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.environments.production).toEqual({
      api: null,
      web: null,
      state: "unreachable",
    });
    expect(res.body.data.environments.staging.state).toBe("current");
    expect(res.body.data.issues[0].onStaging).toBe(true);
  });

  it("derives production readiness from served commits, not from the staging label", async () => {
    gh.compares[`${API}:c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4...merged-kaizen-tasks-api-18`] =
      "ahead";
    const user = await viewer();
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.issues[0]).toMatchObject({
      number: 22,
      stage: "staging",
      onStaging: false,
      productionReady: false,
    });
  });

  it("reports the active ship run and its current step", async () => {
    gh.runs = [
      {
        id: 900,
        name: "ship 7f2a6d1e-0000-4000-8000-000000000001 1.4.0",
        status: "in_progress",
        conclusion: null,
        url: `https://github.com/${HARNESS}/actions/runs/900`,
        createdAt: "2026-09-11T08:00:00Z",
      },
    ];
    gh.jobs[900] = [
      {
        name: "ship",
        status: "in_progress",
        conclusion: null,
        steps: [
          { name: "Validate the inputs", status: "completed", conclusion: "success" },
          { name: "Record the ship on the issues", status: "completed", conclusion: "success" },
          { name: "Promote api", status: "in_progress", conclusion: null },
          { name: "Promote web", status: "queued", conclusion: null },
        ],
      },
    ];
    gh.comments[22] = [
      marker({ version: "1.4.0", requestId: "7f2a6d1e-0000-4000-8000-000000000001", issues: [22] }),
    ];
    const user = await viewer();
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.ship).toEqual({
      active: true,
      run: {
        id: 900,
        url: `https://github.com/${HARNESS}/actions/runs/900`,
        requestId: "7f2a6d1e-0000-4000-8000-000000000001",
        version: "1.4.0",
        status: "in_progress",
        conclusion: null,
        step: "Promote api",
        issues: [22],
        createdAt: "2026-09-11T08:00:00Z",
      },
    });
    expect(res.body.data.issues[0].ship).toEqual({
      requestId: "7f2a6d1e-0000-4000-8000-000000000001",
      version: "1.4.0",
      runUrl: `https://github.com/${HARNESS}/actions/runs/900`,
      done: false,
      status: "in_progress",
      conclusion: null,
      step: "Promote api",
    });
  });

  it("reports a failed ship on the issue and keeps an unfinished marker for another version from readiness", async () => {
    gh.runs = [
      {
        id: 901,
        name: "ship old-request 1.3.1",
        status: "completed",
        conclusion: "failure",
        url: `https://github.com/${HARNESS}/actions/runs/901`,
        createdAt: "2026-09-11T07:00:00Z",
      },
    ];
    gh.jobs[901] = [
      {
        name: "ship",
        status: "completed",
        conclusion: "failure",
        steps: [
          { name: "Validate the inputs", status: "completed", conclusion: "success" },
          { name: "Cut release in api", status: "completed", conclusion: "failure" },
        ],
      },
    ];
    gh.comments[22] = [
      marker({
        version: "1.3.1",
        requestId: "old-request",
        issues: [22],
        runUrl: `https://github.com/${HARNESS}/actions/runs/901`,
      }),
    ];
    const user = await viewer();
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.ship.active).toBe(false);
    expect(res.body.data.issues[0]).toMatchObject({
      onStaging: true,
      productionReady: false,
      ship: {
        requestId: "old-request",
        version: "1.3.1",
        done: false,
        status: "completed",
        conclusion: "failure",
        step: "Cut release in api",
      },
    });
  });

  it("reports the version conflict instead of a next version", async () => {
    gh.files[`${WEB}:develop:package.json`] = JSON.stringify({ version: "1.3.1" });
    const user = await viewer();
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.nextVersion).toBeNull();
    expect(res.body.data.nextVersionError).toBe("versions differ, fix by hand");
  });
});

/** A Redis whose every command fails; `quit` resolves so the test app can close. */
function brokenRedis(): Redis {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === "quit") return () => Promise.resolve("OK");
      return () => Promise.reject(new Error("redis down"));
    },
  }) as unknown as Redis;
}

/** Issue 24 at implementing with one open, green pull request in each repository. */
function seedDeployable(): void {
  gh.issues.push(
    issue({ number: 24, title: "Bulk accept", labels: ["feature-request", "implementing"] }),
  );
  gh.pulls[API]!.push(pull(API, { number: 40, headRef: "feat/24-bulk-accept" }));
  gh.pulls[WEB]!.push(pull(WEB, { number: 41, headRef: "feat/24-bulk-accept" }));
  gh.pulls[HARNESS]!.push(pull(HARNESS, { number: 50, headRef: "feat/24-bulk-accept" }));
  gh.checks[`${API}@head-kaizen-tasks-api-40`] = [green()];
  gh.checks[`${WEB}@head-kaizen-tasks-web-41`] = [green()];
  gh.checks[`${HARNESS}@head-kaizen-tasks-assembly-line-50`] = [green()];
}

const DEPLOY = (n: number) => `${URL}/issues/${n}/deploy-staging`;

describe("POST /pipeline/issues/:number/deploy-staging", () => {
  beforeEach(seedDeployable);

  it("validates the body and the issue number", async () => {
    const user = await facilitator();
    const noBody = await request(configured.server).post(DEPLOY(24)).set(auth(user.token)).send({});
    expect(noBody.status).toBe(400);
    expect(noBody.body.error.details.map((d: { path: string }) => d.path)).toContain(
      "body.passphrase",
    );
    const badNumber = await request(configured.server)
      .post(`${URL}/issues/abc/deploy-staging`)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE });
    expect(badNumber.status).toBe(400);
  });

  it("is FORBIDDEN for a non-facilitator, before any GitHub call", async () => {
    const user = await viewer();
    const res = await request(configured.server)
      .post(DEPLOY(24))
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.body.error.details).toBeUndefined();
    expect(gh.calls).toEqual([]);
  });

  it("is FORBIDDEN with details.reason passphrase on a wrong passphrase, and RATE_LIMITED after five", async () => {
    const user = await facilitator();
    for (let i = 0; i < 5; i++) {
      const res = await request(configured.server)
        .post(DEPLOY(24))
        .set(auth(user.token))
        .send({ passphrase: "wrong-passphrase-" + i });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({
        code: "FORBIDDEN",
        details: { reason: "passphrase" },
      });
    }
    // The lockout is read before the comparison: the right passphrase is still refused.
    const locked = await request(configured.server)
      .post(DEPLOY(24))
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("RATE_LIMITED");
    expect(Date.parse(locked.body.error.details.resetAt)).toBeGreaterThan(Date.now());
    expect(gh.calls).toEqual([]);
    // Per user: another facilitator is not locked out.
    const other = await registerUser(configured.server, { email: "second@example.com" });
    const ok = await request(configured.server)
      .post(DEPLOY(24))
      .set(auth(other.token))
      .send({ passphrase: PASSPHRASE });
    expect(ok.status).toBe(200);
  });

  it("is UNAVAILABLE when Redis is down", async () => {
    const user = await facilitator();
    const broken = await createTestApp(PIPELINE_ENV, {
      pipelineGithub: gh,
      fetchImpl: fakeFetch(envAnswers),
      redis: brokenRedis(),
    });
    try {
      const res = await request(broken.server)
        .post(DEPLOY(24))
        .set(auth(user.token))
        .send({ passphrase: PASSPHRASE });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("UNAVAILABLE");
      expect(gh.calls).toEqual([]);
      const snapshot = await request(broken.server).get(URL).set(auth(user.token));
      expect(snapshot.status).toBe(503);
    } finally {
      await broken.close();
    }
  });

  it("merges every green PR api → web → harness with the inspected head sha, and invalidates the snapshot", async () => {
    const user = await facilitator();
    const issue24 = (res: request.Response) =>
      res.body.data.issues.find((i: { number: number }) => i.number === 24);
    const before = await request(configured.server).get(URL).set(auth(user.token));
    expect(issue24(before).pullRequests.map((p: { state: string }) => p.state)).toEqual([
      "open",
      "open",
      "open",
    ]);
    expect(await configured.redis.get("pipeline:snapshot")).not.toBeNull();

    const res = await request(configured.server)
      .post(DEPLOY(24))
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      merged: [
        { repo: "api", number: 40, sha: "merged-kaizen-tasks-api-40" },
        { repo: "web", number: 41, sha: "merged-kaizen-tasks-web-41" },
        { repo: "harness", number: 50, sha: "merged-kaizen-tasks-assembly-line-50" },
      ],
      remaining: [],
    });
    expect(gh.merges).toEqual([
      { repo: API, number: 40, sha: "head-kaizen-tasks-api-40", method: "squash" },
      { repo: WEB, number: 41, sha: "head-kaizen-tasks-web-41", method: "squash" },
      { repo: HARNESS, number: 50, sha: "head-kaizen-tasks-assembly-line-50", method: "squash" },
    ]);
    expect(await configured.redis.get("pipeline:snapshot")).toBeNull();
    expect(await configured.redis.get("pipeline:action")).toBeNull();

    const after = await request(configured.server).get(URL).set(auth(user.token));
    expect(issue24(after).pullRequests.map((p: { state: string }) => p.state)).toEqual([
      "merged",
      "merged",
      "merged",
    ]);
  });

  it("refuses with CONFLICT naming the first PR that is not green", async () => {
    gh.checks[`${WEB}@head-kaizen-tasks-web-41`] = [running()];
    const user = await facilitator();
    const res = await request(configured.server)
      .post(DEPLOY(24))
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(res.body.error.message).toBe("web #41 checks are running");
    expect(gh.merges).toEqual([]);
  });

  it("refuses with CONFLICT when the issue has no open pull request", async () => {
    const user = await facilitator();
    const res = await request(configured.server)
      .post(DEPLOY(22))
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("#22 has no open pull requests");
  });

  it("reports partial completion when the second merge fails", async () => {
    gh.mergeFailure = (p) =>
      p.repo === WEB
        ? Object.assign(new Error("Head branch was modified"), { status: 409 })
        : undefined;
    try {
      const user = await facilitator();
      const res = await request(configured.server)
        .post(DEPLOY(24))
        .set(auth(user.token))
        .send({ passphrase: PASSPHRASE });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        merged: [{ repo: "api", number: 40, sha: "merged-kaizen-tasks-api-40" }],
        remaining: [
          { repo: "web", number: 41, reason: "moved since you looked" },
          { repo: "harness", number: 50, reason: "not attempted" },
        ],
      });
      expect(await configured.redis.get("pipeline:snapshot")).toBeNull();
    } finally {
      gh.mergeFailure = () => undefined;
    }
  });

  it("answers CONFLICT when the first merge finds a moved head, with nothing merged", async () => {
    gh.mergeFailure = (p) =>
      p.repo === API
        ? Object.assign(new Error("Head branch was modified"), { status: 409 })
        : undefined;
    try {
      const user = await facilitator();
      const res = await request(configured.server)
        .post(DEPLOY(24))
        .set(auth(user.token))
        .send({ passphrase: PASSPHRASE });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe("api #40 moved since you looked, reload");
    } finally {
      gh.mergeFailure = () => undefined;
    }
  });

  it("refuses with CONFLICT while a ship run is active or another action holds the lock", async () => {
    const user = await facilitator();
    gh.runs = [
      {
        id: 950,
        name: "ship abc 1.4.0",
        status: "queued",
        conclusion: null,
        url: `https://github.com/${HARNESS}/actions/runs/950`,
        createdAt: "2026-09-11T08:00:00Z",
      },
    ];
    const shipping = await request(configured.server)
      .post(DEPLOY(24))
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE });
    expect(shipping.status).toBe(409);
    expect(shipping.body.error.message).toBe("a ship is running, wait for it to finish");

    gh.runs = [];
    await configured.redis.set("pipeline:action", "someone-else", "EX", 60);
    const locked = await request(configured.server)
      .post(DEPLOY(24))
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE });
    expect(locked.status).toBe(409);
    expect(locked.body.error.message).toBe("another deploy is in progress");
    expect(gh.merges).toEqual([]);
    // The lock belongs to the other action and is left in place.
    expect(await configured.redis.get("pipeline:action")).toBe("someone-else");
  });
});
