import type { Redis } from "ioredis";
import type { DestinationStream } from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
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
  changelog,
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
    shipPoll: { intervalMs: 5, timeoutMs: 40 },
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
  gh.dispatchFailure = null;
  gh.onListRuns = null;
  resetEnvironments();
});

/** Captures pino output so a test can assert on what was (not) logged. */
class CapturingDestination implements DestinationStream {
  private lines: string[] = [];
  write(msg: string): void {
    this.lines.push(msg);
  }
  get text(): string {
    return this.lines.join("");
  }
}

const runAt = (over: {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  createdAt?: string;
}) => ({
  conclusion: null,
  createdAt: "2026-09-11T08:00:00Z",
  url: `https://github.com/${HARNESS}/actions/runs/${over.id}`,
  ...over,
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

  it("treats a staging issue with no pull requests as on staging and production-ready", async () => {
    // Work that landed without pull requests referencing the issue (the 2026-09-11 rework) is
    // tracked by an issue labelled staging by hand; with nothing to compare, the label decides,
    // exactly as the ship workflow's preflight does.
    gh.issues.push(
      issue({ number: 28, title: "Pipeline control room", labels: ["feature-request", "staging"] }),
    );
    const user = await viewer();
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    const row = res.body.data.issues.find((i: { number: number }) => i.number === 28);
    expect(row).toMatchObject({ stage: "staging", onStaging: true, productionReady: true });
    expect(row.pullRequests).toEqual([]);
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

  it("enters a cooldown after a failed refresh: the next call serves last-good with zero port calls", async () => {
    const user = await viewer();
    const ok = await request(configured.server).get(URL).set(auth(user.token));
    expect(ok.status).toBe(200);
    await configured.redis.del("pipeline:snapshot");
    gh.failure = Object.assign(new Error("boom"), { status: 503 });
    const failed = await request(configured.server).get(URL).set(auth(user.token));
    expect(failed.status).toBe(200);
    expect(failed.body.data).toMatchObject({ stale: true, staleReason: "GitHub answered 503" });
    const ttl = await configured.redis.ttl("pipeline:cooldown");
    expect(ttl).toBeGreaterThan(50);
    expect(ttl).toBeLessThanOrEqual(60);

    gh.failure = null;
    gh.calls = [];
    const cooled = await request(configured.server).get(URL).set(auth(user.token));
    expect(cooled.status).toBe(200);
    expect(cooled.body.data).toMatchObject({
      stale: true,
      staleReason: "GitHub answered 503",
      generatedAt: ok.body.data.generatedAt,
    });
    expect(gh.calls).toEqual([]);
    expect(await configured.redis.get("pipeline:refreshing")).toBeNull();
  });

  it("uses the rate-limit reset for the cooldown when GitHub answers 403 with x-ratelimit-remaining 0", async () => {
    const user = await viewer();
    await request(configured.server).get(URL).set(auth(user.token));
    await configured.redis.del("pipeline:snapshot");
    const reset = Math.floor(Date.now() / 1000) + 300;
    gh.failure = Object.assign(new Error("API rate limit exceeded for installation"), {
      status: 403,
      response: {
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        data: { message: "secret-marker" },
      },
    });
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.stale).toBe(true);
    expect(res.body.data.staleReason).toMatch(/^GitHub rate limit until /);
    expect(JSON.stringify(res.body)).not.toContain("secret-marker");
    const ttl = await configured.redis.ttl("pipeline:cooldown");
    expect(ttl).toBeGreaterThan(280);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it("serves a last-good younger than 60 s at once, not stale, while another caller holds the refresh lock", async () => {
    const user = await viewer();
    await request(configured.server).get(URL).set(auth(user.token));
    const lastGood = JSON.parse((await configured.redis.get("pipeline:last-good")) ?? "{}");
    lastGood.generatedAt = new Date(Date.now() - 20_000).toISOString();
    await configured.redis.set("pipeline:last-good", JSON.stringify(lastGood), "EX", 3600);
    await configured.redis.del("pipeline:snapshot");
    await configured.redis.set("pipeline:refreshing", "someone-else", "EX", 20);
    gh.calls = [];
    const started = Date.now();
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stale: false, generatedAt: lastGood.generatedAt });
    expect(res.body.data.staleReason).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(400);
    expect(gh.calls).toEqual([]);
    expect(await configured.redis.get("pipeline:refreshing")).toBe("someone-else");
  });

  it("waits for the other refresher when nothing younger than 60 s exists", async () => {
    const user = await viewer();
    await request(configured.server).get(URL).set(auth(user.token));
    const lastGood = JSON.parse((await configured.redis.get("pipeline:last-good")) ?? "{}");
    lastGood.generatedAt = new Date(Date.now() - 90_000).toISOString();
    await configured.redis.set("pipeline:last-good", JSON.stringify(lastGood), "EX", 3600);
    await configured.redis.del("pipeline:snapshot");
    await configured.redis.set("pipeline:refreshing", "someone-else", "EX", 20);
    gh.calls = [];
    const freshAt = new Date().toISOString();
    setTimeout(() => {
      void configured.redis.set(
        "pipeline:snapshot",
        JSON.stringify({ ...lastGood, generatedAt: freshAt }),
        "EX",
        30,
      );
    }, 300);
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stale: false, generatedAt: freshAt });
    expect(gh.calls).toEqual([]);
  });

  it("bounds the calls per refresh: markers only for open staging issues, compares cached for an hour", async () => {
    // Eleven issues: three at staging with merged app PRs, three implementing with two open PRs
    // each, three without pull requests, two shipped.
    gh.issues.push(
      issue({ number: 25, labels: ["feature-request", "staging"] }),
      issue({ number: 26, labels: ["bug", "staging"] }),
      issue({ number: 27, labels: ["feature-request", "implementing"] }),
      issue({ number: 28, labels: ["feature-request", "implementing"] }),
      issue({ number: 29, labels: ["bug", "implementing"] }),
      issue({ number: 30, labels: ["feature-request", "triaged"] }),
      issue({ number: 31, labels: ["feature-request"] }),
      issue({ number: 32, labels: ["bug"] }),
      issue({
        number: 20,
        state: "closed",
        closedAt: new Date(Date.now() - 86_400_000).toISOString(),
        labels: ["feature-request", "shipped"],
      }),
    );
    for (const n of [25, 26]) {
      gh.pulls[API]!.push(pull(API, { number: 60 + n, headRef: `feat/${n}-x`, merged: true }));
      gh.pulls[WEB]!.push(pull(WEB, { number: 60 + n, headRef: `feat/${n}-x`, merged: true }));
      gh.compares[
        `${API}:c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4...merged-kaizen-tasks-api-${60 + n}`
      ] = "behind";
      gh.compares[
        `${WEB}:e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8...merged-kaizen-tasks-web-${60 + n}`
      ] = "behind";
    }
    for (const n of [27, 28, 29]) {
      gh.pulls[API]!.push(pull(API, { number: 70 + n, headRef: `fix/${n}-y` }));
      gh.pulls[WEB]!.push(pull(WEB, { number: 70 + n, headRef: `fix/${n}-y` }));
    }
    const user = await viewer();
    const first = await request(configured.server).get(URL).set(auth(user.token));
    expect(first.status).toBe(200);
    expect(first.body.data.issues).toHaveLength(11);
    const counts = () => ({
      total: gh.calls.length,
      checks: gh.countOf("checkRuns"),
      compares: gh.countOf("compare"),
      markers: gh.countOf("listIssueComments"),
    });
    // 14 fixed reads + 6 open heads + 6 compares + 3 markers (the open staging issues only).
    expect(counts()).toEqual({ total: 29, checks: 6, compares: 6, markers: 3 });

    await configured.redis.del("pipeline:snapshot");
    gh.calls = [];
    const second = await request(configured.server).get(URL).set(auth(user.token));
    expect(second.status).toBe(200);
    expect(counts()).toEqual({ total: 23, checks: 6, compares: 0, markers: 3 });
    expect(second.body.data.issues.find((i: { number: number }) => i.number === 25)).toMatchObject({
      onStaging: true,
      productionReady: true,
    });
  });

  it("ignores probe and dry runs when picking the ship run", async () => {
    gh.runs = [
      runAt({
        id: 1500,
        name: "ship probe-1757577600000 9.9.9",
        status: "completed",
        conclusion: "failure",
        createdAt: "2026-09-11T09:00:00Z",
      }),
      runAt({
        id: 1501,
        name: "ship dry-check 9.9.9",
        status: "in_progress",
        createdAt: "2026-09-11T08:59:00Z",
      }),
      runAt({
        id: 900,
        name: "ship 7f2a6d1e-0000-4000-8000-000000000001 1.4.0",
        status: "in_progress",
      }),
    ];
    gh.jobs[900] = [
      {
        name: "ship",
        status: "in_progress",
        conclusion: null,
        steps: [{ name: "Promote api", status: "in_progress", conclusion: null }],
      },
    ];
    gh.comments[22] = [
      marker({ version: "1.4.0", requestId: "7f2a6d1e-0000-4000-8000-000000000001", issues: [22] }),
    ];
    const user = await viewer();
    const res = await request(configured.server).get(URL).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.ship).toMatchObject({
      active: true,
      run: { id: 900, requestId: "7f2a6d1e-0000-4000-8000-000000000001", step: "Promote api" },
    });
    expect(res.body.data.issues[0].ship).toMatchObject({
      status: "in_progress",
      step: "Promote api",
    });

    gh.runs = gh.runs.filter((r) => r.id !== 900);
    await configured.redis.del("pipeline:snapshot");
    const alone = await request(configured.server).get(URL).set(auth(user.token));
    expect(alone.body.data.ship).toEqual({ active: false, run: null });
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

const SHIP = `${URL}/ship`;
const RETRY = `${URL}/ship/retry`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Makes the fake behave like GitHub: the run for the last dispatch appears on the next list. */
function surfaceDispatchedRuns(status = "queued"): void {
  gh.onListRuns = () => {
    const dispatch = gh.dispatches.at(-1);
    if (!dispatch) return;
    const name = `ship ${dispatch.inputs.request_id} ${dispatch.inputs.version}`;
    if (gh.runs.some((r) => r.name === name)) return;
    const id = 1000 + gh.dispatches.length;
    gh.runs.unshift({
      id,
      name,
      status,
      conclusion: null,
      url: `https://github.com/${HARNESS}/actions/runs/${id}`,
      createdAt: new Date().toISOString(),
    });
  };
}

describe("POST /pipeline/ship", () => {
  it("validates the body", async () => {
    const user = await facilitator();
    const res = await request(configured.server)
      .post(SHIP)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, version: "v1", issues: [] });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toContain("body.version");
    expect(paths).toContain("body.issues");
  });

  it("dispatches ship.yml with request_id, version and the issue set, and returns the run found by run name", async () => {
    surfaceDispatchedRuns();
    const user = await facilitator();
    await request(configured.server).get(URL).set(auth(user.token));
    const res = await request(configured.server)
      .post(SHIP)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, version: "1.4.0", issues: [22] });
    expect(res.status).toBe(200);
    const { requestId, version, issues, run } = res.body.data;
    expect(requestId).toMatch(UUID);
    expect(version).toBe("1.4.0");
    expect(issues).toEqual([22]);
    expect(run).toEqual({ id: 1001, url: `https://github.com/${HARNESS}/actions/runs/1001` });
    expect(gh.dispatches).toEqual([
      {
        repo: HARNESS,
        workflow: "ship.yml",
        ref: "develop",
        inputs: { request_id: requestId, version: "1.4.0", issues: "22" },
      },
    ]);
    expect(JSON.parse((await configured.redis.get(`pipeline:ship:${requestId}`)) ?? "{}")).toEqual({
      requestId,
      version: "1.4.0",
      issues: [22],
      state: "dispatched",
    });
    expect(await configured.redis.get("pipeline:snapshot")).toBeNull();
    expect(await configured.redis.get("pipeline:action")).toBeNull();

    // The next snapshot shows the run on the issue before the workflow has written its marker.
    const snap = await request(configured.server).get(URL).set(auth(user.token));
    expect(snap.body.data.ship).toMatchObject({
      active: true,
      run: { id: 1001, requestId, version: "1.4.0", status: "queued", issues: [22] },
    });
    expect(snap.body.data.issues[0].ship).toEqual({
      requestId,
      version: "1.4.0",
      runUrl: `https://github.com/${HARNESS}/actions/runs/1001`,
      done: false,
      status: "queued",
      conclusion: null,
      step: null,
    });
  });

  it("refuses with CONFLICT when the body's version or issue set differs from the fresh computation", async () => {
    const user = await facilitator();
    const stale = await request(configured.server)
      .post(SHIP)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, version: "1.3.1", issues: [22] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toBe("the release changed, reload");
    const moreIssues = await request(configured.server)
      .post(SHIP)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, version: "1.4.0", issues: [22, 19] });
    expect(moreIssues.status).toBe(409);
    expect(moreIssues.body.error.message).toBe("the release changed, reload");
    expect(gh.dispatches).toEqual([]);
  });

  it("refuses with CONFLICT when there is nothing to release", async () => {
    gh.files[`${API}:develop:CHANGELOG.md`] = changelog({});
    gh.files[`${WEB}:develop:CHANGELOG.md`] = changelog({});
    const user = await facilitator();
    const res = await request(configured.server)
      .post(SHIP)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, version: "1.4.0", issues: [22] });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("nothing to release");
  });

  it("refuses with CONFLICT when an issue carries an unfinished marker for another version", async () => {
    gh.comments[22] = [marker({ version: "1.3.1", requestId: "old-request", issues: [22] })];
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
    const user = await facilitator();
    const res = await request(configured.server)
      .post(SHIP)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, version: "1.4.0", issues: [22] });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(
      "#22 carries an unfinished ship for 1.3.1, retry the earlier ship first",
    );
    expect(gh.dispatches).toEqual([]);
  });

  it("does not dispatch twice for the same requestId when the first response was lost", async () => {
    surfaceDispatchedRuns("in_progress");
    const user = await facilitator();
    const body = { passphrase: PASSPHRASE, version: "1.4.0", issues: [22] };
    const first = await request(configured.server).post(SHIP).set(auth(user.token)).send(body);
    expect(first.status).toBe(200);
    const second = await request(configured.server).post(SHIP).set(auth(user.token)).send(body);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(gh.dispatches).toHaveLength(1);
  });

  it("returns run null when the run is not visible within the poll window, and the next snapshot reconciles it", async () => {
    const user = await facilitator();
    const res = await request(configured.server)
      .post(SHIP)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, version: "1.4.0", issues: [22] });
    expect(res.status).toBe(200);
    expect(res.body.data.run).toBeNull();
    const { requestId } = res.body.data;
    expect(gh.dispatches).toHaveLength(1);
    expect(gh.countOf("listRuns")).toBeGreaterThan(2);

    // GitHub catches up: the run appears, named after the request id.
    gh.runs = [
      {
        id: 1200,
        name: `ship ${requestId} 1.4.0`,
        status: "in_progress",
        conclusion: null,
        url: `https://github.com/${HARNESS}/actions/runs/1200`,
        createdAt: new Date().toISOString(),
      },
    ];
    const snap = await request(configured.server).get(URL).set(auth(user.token));
    expect(snap.body.data.ship).toMatchObject({
      active: true,
      run: { id: 1200, requestId, version: "1.4.0", status: "in_progress", issues: [22] },
    });
    expect(snap.body.data.issues[0].ship).toMatchObject({ requestId, status: "in_progress" });
  });

  it("keeps the ship record when the dispatch throws, and never dispatches the same release twice", async () => {
    gh.dispatchFailure = Object.assign(new Error("Bad Gateway"), { status: 502 });
    const user = await facilitator();
    const body = { passphrase: PASSPHRASE, version: "1.4.0", issues: [22] };
    const first = await request(configured.server).post(SHIP).set(auth(user.token)).send(body);
    expect(first.status).toBe(502);
    expect(first.body.error.code).toBe("UPSTREAM_ERROR");
    expect(first.body.error.message).toMatch(/reconcile/);
    expect(gh.dispatches).toHaveLength(1);
    const requestId = gh.dispatches[0]!.inputs.request_id!;
    expect(JSON.parse((await configured.redis.get(`pipeline:ship:${requestId}`)) ?? "{}")).toEqual({
      requestId,
      version: "1.4.0",
      issues: [22],
      state: "unknown",
    });

    gh.dispatchFailure = null;
    const second = await request(configured.server).post(SHIP).set(auth(user.token)).send(body);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ requestId, version: "1.4.0", issues: [22], run: null });
    expect(gh.dispatches).toHaveLength(1);

    // GitHub had accepted it after all: the run appears and the snapshot reconciles it by name.
    gh.runs = [runAt({ id: 1300, name: `ship ${requestId} 1.4.0`, status: "queued" })];
    const snap = await request(configured.server).get(URL).set(auth(user.token));
    expect(snap.body.data.ship).toMatchObject({
      active: true,
      run: { id: 1300, requestId, issues: [22] },
    });
  });

  it("refuses with CONFLICT while a ship run is active, and FORBIDDEN for a non-facilitator", async () => {
    gh.runs = [
      {
        id: 950,
        name: "ship abc 1.4.0",
        status: "in_progress",
        conclusion: null,
        url: `https://github.com/${HARNESS}/actions/runs/950`,
        createdAt: "2026-09-11T08:00:00Z",
      },
    ];
    const user = await facilitator();
    const res = await request(configured.server)
      .post(SHIP)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, version: "1.4.0", issues: [22] });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("a ship is running, wait for it to finish");
    const other = await viewer();
    const denied = await request(configured.server)
      .post(SHIP)
      .set(auth(other.token))
      .send({ passphrase: PASSPHRASE, version: "1.4.0", issues: [22] });
    expect(denied.status).toBe(403);
    expect(gh.dispatches).toEqual([]);
  });
});

describe("POST /pipeline/ship/retry", () => {
  function failedShip(requestId: string, runId: number): void {
    gh.comments[22] = [
      ...(gh.comments[22] ?? []),
      marker({
        version: "1.3.1",
        requestId,
        issues: [22, 19],
        runUrl: `https://github.com/${HARNESS}/actions/runs/${runId}`,
      }),
    ];
    gh.runs.unshift({
      id: runId,
      name: `ship ${requestId} 1.3.1`,
      status: "completed",
      conclusion: "failure",
      url: `https://github.com/${HARNESS}/actions/runs/${runId}`,
      createdAt: `2026-09-11T07:0${gh.runs.length}:00Z`,
    });
  }

  it("re-dispatches with the marker's version and issue set for a failed or cancelled run", async () => {
    failedShip("old-request", 901);
    surfaceDispatchedRuns();
    const user = await facilitator();
    const res = await request(configured.server)
      .post(RETRY)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, issue: 22 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      requestId: "old-request-r1",
      version: "1.3.1",
      issues: [22, 19],
      run: { id: 1001, url: `https://github.com/${HARNESS}/actions/runs/1001` },
    });
    expect(gh.dispatches).toEqual([
      {
        repo: HARNESS,
        workflow: "ship.yml",
        ref: "develop",
        inputs: { request_id: "old-request-r1", version: "1.3.1", issues: "22,19" },
      },
    ]);
    expect(await configured.redis.get("pipeline:snapshot")).toBeNull();

    // The retry failed too and the workflow wrote its marker: the next retry is -r2.
    gh.runs = gh.runs.filter((r) => r.id !== 1001);
    failedShip("old-request-r1", 902);
    const again = await request(configured.server)
      .post(RETRY)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, issue: 22 });
    expect(again.status).toBe(200);
    expect(again.body.data.requestId).toBe("old-request-r2");
    expect(gh.dispatches.at(-1)!.inputs.request_id).toBe("old-request-r2");
  });

  it("dispatches one retry for two presses before the run is visible, and the next attempt once it concluded", async () => {
    failedShip("old-request", 901);
    const user = await facilitator();
    const press = () =>
      request(configured.server)
        .post(RETRY)
        .set(auth(user.token))
        .send({ passphrase: PASSPHRASE, issue: 22 });
    const first = await press();
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({
      requestId: "old-request-r1",
      version: "1.3.1",
      issues: [22, 19],
      run: null,
    });
    const second = await press();
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(gh.dispatches).toHaveLength(1);
    expect(await configured.redis.get("pipeline:ship:retry:old-request")).toBe("old-request-r1");

    // The run becomes visible and runs: the same answer, now with the run, still one dispatch.
    gh.runs.unshift(runAt({ id: 1400, name: "ship old-request-r1 1.3.1", status: "in_progress" }));
    const third = await press();
    expect(third.status).toBe(200);
    expect(third.body.data).toEqual({
      ...first.body.data,
      run: { id: 1400, url: `https://github.com/${HARNESS}/actions/runs/1400` },
    });
    expect(gh.dispatches).toHaveLength(1);

    // It failed too, before writing its marker: the next attempt is -r2, once.
    gh.runs = gh.runs.filter((r) => r.id !== 1400);
    gh.runs.unshift(
      runAt({
        id: 1401,
        name: "ship old-request-r1 1.3.1",
        status: "completed",
        conclusion: "failure",
      }),
    );
    const fourth = await press();
    expect(fourth.status).toBe(200);
    expect(fourth.body.data.requestId).toBe("old-request-r2");
    const fifth = await press();
    expect(fifth.body.data.requestId).toBe("old-request-r2");
    expect(gh.dispatches).toHaveLength(2);
    expect(gh.dispatches.map((d) => d.inputs.request_id)).toEqual([
      "old-request-r1",
      "old-request-r2",
    ]);
  });

  it("refuses while the marker's run is still queued or running", async () => {
    gh.comments[22] = [marker({ version: "1.3.1", requestId: "old-request", issues: [22] })];
    gh.runs = [
      {
        id: 901,
        name: "ship old-request 1.3.1",
        status: "in_progress",
        conclusion: null,
        url: `https://github.com/${HARNESS}/actions/runs/901`,
        createdAt: "2026-09-11T07:00:00Z",
      },
    ];
    const user = await facilitator();
    const res = await request(configured.server)
      .post(RETRY)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, issue: 22 });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("the ship is still running");
    expect(gh.dispatches).toEqual([]);
  });

  it("refuses when the issue has no ship recorded or the recorded ship completed", async () => {
    const user = await facilitator();
    const none = await request(configured.server)
      .post(RETRY)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, issue: 22 });
    expect(none.status).toBe(409);
    expect(none.body.error.message).toBe("no ship recorded on #22");

    gh.comments[22] = [
      marker({ version: "1.3.1", requestId: "old-request", issues: [22] }),
      marker({ version: "1.3.1", requestId: "old-request", issues: [22], done: true }),
    ];
    const finished = await request(configured.server)
      .post(RETRY)
      .set(auth(user.token))
      .send({ passphrase: PASSPHRASE, issue: 22 });
    expect(finished.status).toBe(409);
    expect(finished.body.error.message).toBe("the ship of 1.3.1 for #22 completed");
  });
});

describe("a malformed JSON body", () => {
  it("is answered without echoing the body, and nothing of it is logged", async () => {
    const log = new CapturingDestination();
    const app = await createTestApp(PIPELINE_ENV, {
      pipelineGithub: gh,
      fetchImpl: fakeFetch(envAnswers),
      logger: createLogger("info", log),
    });
    try {
      const user = await facilitator();
      const res = await request(app.server)
        .post(SHIP)
        .set(auth(user.token))
        .set("content-type", "application/json")
        .send('{"passphrase": hunter2-top-secret, "version": "1.4.0", "issues": [22]}');
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({
        code: "VALIDATION_ERROR",
        message: "Malformed JSON body",
        requestId: expect.any(String),
      });
      expect(res.text).not.toContain("hunter2");
      // The parser fails before the request logger runs, so nothing of this request is logged at
      // all; a well-formed request afterwards shows the capture works and still carries nothing.
      const wellFormed = await request(app.server)
        .post(SHIP)
        .set(auth(user.token))
        .send({ passphrase: "wrong-passphrase-x", version: "1.4.0", issues: [22] });
      expect(wellFormed.status).toBe(403);
      expect(log.text).toContain('"statusCode":403');
      expect(log.text).not.toContain("hunter2");
    } finally {
      await app.close();
    }
  });
});
