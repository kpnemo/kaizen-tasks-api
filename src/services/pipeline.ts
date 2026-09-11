import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";
import { z } from "zod";
import { conflict, forbidden, rateLimited, upstreamError, unavailable } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { LOCKOUT_LIMIT, createPipelineStore, type PipelineStore } from "../lib/pipeline-locks.js";
import type {
  DeployStagingResult,
  PipelineEnvironmentShape,
  PipelineIssueShape,
  PipelineIssueShipShape,
  PipelinePullRequestShape,
  PipelineShipRunShape,
  PipelineSnapshotShape,
} from "../schemas/pipeline.js";
import { readinessOf, stageOf } from "./feature-requests.js";
import type {
  CheckRun,
  CommentItem,
  JobItem,
  PipelineGitHub,
  PullItem,
  RunItem,
} from "./pipeline-github.js";

/** The three repositories the pipeline reads and writes; constants, not settings. */
export const PIPELINE_REPOS = {
  harness: "kpnemo/kaizen-tasks-assembly-line",
  api: "kpnemo/kaizen-tasks-api",
  web: "kpnemo/kaizen-tasks-web",
} as const;
export type RepoKey = keyof typeof PIPELINE_REPOS;
/** Merge order, and the order pull requests are listed in. */
const REPO_ORDER: RepoKey[] = ["api", "web", "harness"];
const APP_REPOS: RepoKey[] = ["api", "web"];

export const SHIP_WORKFLOW = "ship.yml";
const SHIPPED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const ISSUE_PAGE = 100;
const PULL_PAGE = 100;
const RUNS_LISTED = 10;
const ENVIRONMENT_TIMEOUT_MS = 5_000;
const REFRESH_WAIT_MS = 500;
const REFRESH_WAITS = 4;

export interface PipelineConfig {
  token: string;
  facilitatorEmails: Set<string>;
  passphrase: string;
  stagingUrl: string;
  productionUrl: string;
}

export type PipelineSnapshot = PipelineSnapshotShape;
/** Everything but `canDeploy`, which is per caller and never cached. */
export type SharedSnapshot = Omit<PipelineSnapshot, "canDeploy">;

// ---------------------------------------------------------------- pure derivations

/** Pull requests for issue `n`: heads `feat/<n>-` or `fix/<n>-`, or a `docs/` head whose body
 *  names the issue (`kaizen-tasks-assembly-line#<n>`). */
export function matchPullsToIssue(pulls: PullItem[], n: number): PullItem[] {
  const byHead = new RegExp(`^(feat|fix)/${n}-`);
  const byBody = new RegExp(`kaizen-tasks-assembly-line#${n}(?!\\d)`);
  return pulls.filter(
    (pull) =>
      byHead.test(pull.headRef) || (pull.headRef.startsWith("docs/") && byBody.test(pull.body)),
  );
}

/** The checks a base branch requires: `ci` on develop, `ci` and `promote` on main. */
export function requiredChecksFor(base: string): string[] {
  return base === "main" ? ["ci", "promote"] : ["ci"];
}

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
]);

/**
 * `green` when every required check has a completed successful run on the head, `red` when any
 * completed run on the head failed, else `pending`. A missing required check is pending. Order
 * does not matter: GitHub lists check runs with `filter=latest` by default, so a rerun replaces
 * its predecessor, and a failed run that is still listed is a failure the facilitator should see.
 */
export function checksOf(required: string[], runs: CheckRun[]): "green" | "red" | "pending" {
  if (
    runs.some((run) => run.status === "completed" && FAILED_CONCLUSIONS.has(run.conclusion ?? ""))
  ) {
    return "red";
  }
  const allGreen = required.every((name) =>
    runs.some(
      (run) => run.name === name && run.status === "completed" && run.conclusion === "success",
    ),
  );
  return allGreen ? "green" : "pending";
}

/** The shared definition: open, not draft, on the expected base, no conflicts, checks green. */
export function isGreen(
  pull: PullItem,
  runs: CheckRun[],
  base: string,
): { green: true } | { green: false; reason: string } {
  if (pull.state !== "open" || pull.merged) return { green: false, reason: "is not open" };
  if (pull.draft) return { green: false, reason: "is a draft" };
  if (pull.baseRef !== base) {
    return { green: false, reason: `targets ${pull.baseRef}, not ${base}` };
  }
  if (pull.mergeableState === "dirty") return { green: false, reason: "has conflicts" };
  if (pull.mergeableState === "blocked") return { green: false, reason: "is blocked" };
  const checks = checksOf(requiredChecksFor(base), runs);
  if (checks === "red") return { green: false, reason: "a check is red" };
  if (checks === "pending") return { green: false, reason: "checks are running" };
  return { green: true };
}

const MINOR_HEADINGS = new Set(["added", "changed", "removed", "deprecated"]);

/** Bullet counts under `[Unreleased]`: those under Added/Changed (a minor bump) and the rest. */
export function parseUnreleased(changelog: string): { minor: number; patch: number } {
  const counts = { minor: 0, patch: 0 };
  let inside = false;
  let heading = "";
  for (const line of changelog.split("\n")) {
    if (/^## \[Unreleased\]/i.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^## /.test(line)) break;
    const sub = line.match(/^### (.+)$/);
    if (sub) {
      heading = sub[1]!.trim().toLowerCase();
      continue;
    }
    if (/^\s*[-*] /.test(line)) {
      if (MINOR_HEADINGS.has(heading)) counts.minor += 1;
      else counts.patch += 1;
    }
  }
  return counts;
}

export function nextVersionOf(input: {
  apiVersion: string;
  webVersion: string;
  apiUnreleased: string;
  webUnreleased: string;
}): { version: string; error: null } | { version: null; error: string } {
  if (input.apiVersion !== input.webVersion) {
    return { version: null, error: "versions differ, fix by hand" };
  }
  const match = input.apiVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return { version: null, error: `unreadable version ${input.apiVersion}` };
  const api = parseUnreleased(input.apiUnreleased);
  const web = parseUnreleased(input.webUnreleased);
  const minor = api.minor + web.minor;
  const patch = api.patch + web.patch;
  if (minor === 0 && patch === 0) return { version: null, error: "nothing to release" };
  const [, major, minorNo, patchNo] = match.map(Number) as [number, number, number, number];
  return minor > 0
    ? { version: `${major}.${minorNo + 1}.0`, error: null }
    : { version: `${major}.${minorNo}.${patchNo + 1}`, error: null };
}

export interface ShipMarker {
  version: string;
  requestId: string;
  issues: number[];
  runUrl: string | null;
  done: boolean;
}

const MARKER_RE = /<!-- kaizen-ship (\{.*?\}) -->/g;

/** The newest `<!-- kaizen-ship {…} -->` marker on the issue, or null. */
export function newestMarker(comments: CommentItem[]): ShipMarker | null {
  let found: ShipMarker | null = null;
  for (const comment of comments) {
    for (const match of comment.body.matchAll(MARKER_RE)) {
      try {
        const raw = JSON.parse(match[1]!) as Record<string, unknown>;
        if (typeof raw.version !== "string" || typeof raw.requestId !== "string") continue;
        found = {
          version: raw.version,
          requestId: raw.requestId,
          issues: Array.isArray(raw.issues)
            ? raw.issues.filter((n): n is number => typeof n === "number")
            : [],
          runUrl: typeof raw.runUrl === "string" ? raw.runUrl : null,
          done: raw.done === true,
        };
      } catch {
        // An unreadable marker is not a marker.
      }
    }
  }
  return found;
}

export const runNameOf = (requestId: string, version: string): string =>
  `ship ${requestId} ${version}`;

export function parseRunName(name: string): { requestId: string; version: string } | null {
  const match = name.match(/^ship (\S+) (\S+)$/);
  return match ? { requestId: match[1]!, version: match[2]! } : null;
}

function runStatusOf(status: string): PipelineShipRunShape["status"] {
  if (status === "in_progress") return "in_progress";
  if (status === "completed") return "completed";
  return "queued";
}

function runConclusionOf(conclusion: string | null): PipelineShipRunShape["conclusion"] {
  if (conclusion === null) return null;
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") {
    return "success";
  }
  if (conclusion === "cancelled" || conclusion === "timed_out") return conclusion;
  return "failure";
}

/** The step in progress, else the step that failed, else null. */
export function currentStepOf(jobs: JobItem[]): string | null {
  const steps = jobs.flatMap((job) => job.steps);
  const active = steps.find((step) => step.status === "in_progress");
  if (active) return active.name;
  const failed = steps.find(
    (step) => step.status === "completed" && FAILED_CONCLUSIONS.has(step.conclusion ?? ""),
  );
  return failed?.name ?? null;
}

// ---------------------------------------------------------------- environment reads

const HealthAnswer = z.object({
  data: z.object({
    version: z.string(),
    commit: z.string(),
    checks: z.object({ db: z.enum(["ok", "failed"]), redis: z.enum(["ok", "failed"]) }),
  }),
});
const VersionAnswer = z.object({ version: z.string(), commit: z.string() });

// ---------------------------------------------------------------- the service

export interface PipelineActor {
  id: string;
  email: string;
}

export interface PipelineService {
  snapshot(callerEmail: string): Promise<PipelineSnapshot>;
  canDeploy(email: string): boolean;
  /** Allowlist, lockout (read before the comparison), constant-time passphrase; fails closed. */
  authorize(user: PipelineActor, passphrase: string): Promise<void>;
  deployStaging(
    user: PipelineActor,
    issueNumber: number,
    passphrase: string,
  ): Promise<DeployStagingResult>;
}

export interface PipelineDeps {
  github: PipelineGitHub;
  redis: Redis;
  fetchImpl: typeof fetch;
  config: PipelineConfig;
  logger: Logger;
  now?: () => Date;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Status and name only; never the message of an HTTP failure, which carries the response body. */
function describeFailure(err: unknown): { status?: number; name: string; message?: string } {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? (err as { status?: number }).status
      : undefined;
  const name = err instanceof Error ? err.name : typeof err;
  const message =
    status === undefined ? (err instanceof Error ? err.message : String(err)) : undefined;
  return { status, name, message };
}

export function createPipelineService(deps: PipelineDeps): PipelineService {
  const { github, config, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const store: PipelineStore = createPipelineStore(deps.redis);

  /** Redis is the cache and every lock; without it the pipeline fails closed. */
  async function withRedis<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      logger.error({ err }, "pipeline redis failure");
      throw unavailable("Pipeline state unavailable");
    }
  }

  async function readJson(url: string): Promise<unknown | null> {
    try {
      const res = await deps.fetchImpl(url, {
        signal: AbortSignal.timeout(ENVIRONMENT_TIMEOUT_MS),
        headers: { "cache-control": "no-cache" },
      });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    } catch {
      return null;
    }
  }

  async function readEnvironment(
    base: string,
    heads: { api: string; web: string },
  ): Promise<PipelineEnvironmentShape> {
    const [health, version] = await Promise.all([
      readJson(`${base}/api/v1/health`),
      readJson(`${base}/version.json`),
    ]);
    const parsedApi = HealthAnswer.safeParse(health);
    const parsedWeb = VersionAnswer.safeParse(version);
    const api = parsedApi.success
      ? {
          version: parsedApi.data.data.version,
          commit: parsedApi.data.data.commit,
          db: parsedApi.data.data.checks.db,
          redis: parsedApi.data.data.checks.redis,
        }
      : null;
    const web = parsedWeb.success ? parsedWeb.data : null;
    const state =
      !api || !web
        ? "unreachable"
        : api.commit === heads.api && web.commit === heads.web
          ? "current"
          : "deploying";
    return { api, web, state };
  }

  const listPulls = (repo: RepoKey) =>
    github.listPulls({ repo: PIPELINE_REPOS[repo], state: "all", perPage: PULL_PAGE });
  const listIssues = (labels: string) =>
    github.listIssues({ repo: PIPELINE_REPOS.harness, labels, state: "all", perPage: ISSUE_PAGE });
  const branchHead = (repo: RepoKey, branch: string) =>
    github.branchHead({ repo: PIPELINE_REPOS[repo], branch });
  const fileText = (repo: RepoKey, path: string) =>
    github.fileText({ repo: PIPELINE_REPOS[repo], path, ref: "develop" });
  const listRuns = () =>
    github.listRuns({
      repo: PIPELINE_REPOS.harness,
      workflow: SHIP_WORKFLOW,
      perPage: RUNS_LISTED,
    });

  function toPullRequest(
    repo: RepoKey,
    pull: PullItem,
    checks: PipelinePullRequestShape["checks"],
  ): PipelinePullRequestShape {
    return {
      repo,
      number: pull.number,
      url: pull.url,
      state: pull.merged ? "merged" : pull.state === "open" ? "open" : "closed",
      checks: pull.state === "open" && !pull.merged ? checks : null,
      mergeSha: pull.merged ? pull.mergeSha : null,
      headSha: pull.headSha,
      draft: pull.draft,
    };
  }

  /** The shared snapshot, built from GitHub and the two environments. Throws on a GitHub
   *  failure; environment reads never throw (an unreachable half is reported as such). */
  async function buildShared(): Promise<SharedSnapshot> {
    const at = now();
    const [
      featureIssues,
      bugIssues,
      apiPulls,
      webPulls,
      harnessPulls,
      apiDevelop,
      apiMain,
      webDevelop,
      webMain,
      apiPackage,
      webPackage,
      apiChangelog,
      webChangelog,
      runs,
    ] = await Promise.all([
      listIssues("feature-request"),
      listIssues("bug"),
      listPulls("api"),
      listPulls("web"),
      listPulls("harness"),
      branchHead("api", "develop"),
      branchHead("api", "main"),
      branchHead("web", "develop"),
      branchHead("web", "main"),
      fileText("api", "package.json"),
      fileText("web", "package.json"),
      fileText("api", "CHANGELOG.md"),
      fileText("web", "CHANGELOG.md"),
      listRuns(),
    ]);
    const branches = {
      api: { develop: apiDevelop, main: apiMain },
      web: { develop: webDevelop, main: webMain },
    };
    const [staging, production] = await Promise.all([
      readEnvironment(config.stagingUrl, { api: apiDevelop, web: webDevelop }),
      readEnvironment(config.productionUrl, { api: apiMain, web: webMain }),
    ]);

    const next = nextVersionOf({
      apiVersion: readVersion(apiPackage),
      webVersion: readVersion(webPackage),
      apiUnreleased: apiChangelog,
      webUnreleased: webChangelog,
    });

    // Issues: open first, then those shipped within the window; newest first in each group.
    const seen = new Set<number>();
    const issues = [...featureIssues, ...bugIssues]
      .filter((issue) => (seen.has(issue.number) ? false : (seen.add(issue.number), true)))
      .filter(
        (issue) =>
          issue.state === "open" ||
          (stageOf(issue.labels, issue.state) === "shipped" &&
            issue.closedAt !== null &&
            at.getTime() - Date.parse(issue.closedAt) <= SHIPPED_WINDOW_MS),
      )
      .sort((a, b) =>
        a.state !== b.state
          ? a.state === "open"
            ? -1
            : 1
          : b.createdAt.localeCompare(a.createdAt),
      );

    const pullsByRepo: Record<RepoKey, PullItem[]> = {
      api: apiPulls,
      web: webPulls,
      harness: harnessPulls,
    };
    const matched = issues.map((issue) => ({
      issue,
      pulls: REPO_ORDER.flatMap((repo) =>
        matchPullsToIssue(pullsByRepo[repo], issue.number).map((pull) => ({ repo, pull })),
      ),
    }));

    // Check runs for every open head, compares for every merged app-repo pull of an open issue.
    const openHeads = matched.flatMap(({ issue, pulls }) =>
      issue.state === "open"
        ? pulls.filter(({ pull }) => pull.state === "open" && !pull.merged)
        : [],
    );
    const checksByHead = new Map<string, PipelinePullRequestShape["checks"]>();
    await Promise.all(
      openHeads.map(async ({ repo, pull }) => {
        const runs = await github.checkRuns({ repo: PIPELINE_REPOS[repo], ref: pull.headSha });
        checksByHead.set(
          `${repo}@${pull.headSha}`,
          checksOf(requiredChecksFor(pull.baseRef), runs),
        );
      }),
    );
    const served = { api: staging.api?.commit ?? null, web: staging.web?.commit ?? null };
    const onStagingByMerge = new Map<string, boolean>();
    await Promise.all(
      matched.flatMap(({ issue, pulls }) =>
        issue.state !== "open"
          ? []
          : pulls
              .filter(
                ({ repo, pull }) =>
                  APP_REPOS.includes(repo) && pull.merged && pull.mergeSha !== null,
              )
              .map(async ({ repo, pull }) => {
                const base = served[repo as "api" | "web"];
                const key = `${repo}@${pull.mergeSha}`;
                if (!base) {
                  onStagingByMerge.set(key, false);
                  return;
                }
                const status = await github.compare({
                  repo: PIPELINE_REPOS[repo],
                  base,
                  head: pull.mergeSha!,
                });
                onStagingByMerge.set(key, status === "identical" || status === "behind");
              }),
      ),
    );

    // Ship markers, only where a ship could have touched the issue.
    const markers = new Map<number, ShipMarker | null>();
    await Promise.all(
      matched.map(async ({ issue, pulls }) => {
        const stage = stageOf(issue.labels, issue.state);
        const allMerged = pulls.length > 0 && pulls.every(({ pull }) => pull.merged);
        if (stage !== "staging" && stage !== "shipped" && !allMerged) return;
        const comments = await github.listIssueComments({
          repo: PIPELINE_REPOS.harness,
          number: issue.number,
        });
        markers.set(issue.number, newestMarker(comments));
      }),
    );

    // The ship workflow: the newest run, its step when it is running or failed.
    const sortedRuns = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const newest = sortedRuns[0];
    let step: string | null = null;
    if (newest) {
      const status = runStatusOf(newest.status);
      const conclusion = runConclusionOf(newest.conclusion);
      if (status !== "completed" || (conclusion !== null && conclusion !== "success")) {
        step = currentStepOf(
          await github.runJobs({ repo: PIPELINE_REPOS.harness, runId: newest.id }),
        );
      }
    }
    const ship = await shipStateOf(newest, step, markers);

    const built: PipelineIssueShape[] = matched.map(({ issue, pulls }) => {
      const stage = stageOf(issue.labels, issue.state);
      const pullRequests = pulls.map(({ repo, pull }) =>
        toPullRequest(repo, pull, checksByHead.get(`${repo}@${pull.headSha}`) ?? "pending"),
      );
      const allMerged = pulls.length > 0 && pulls.every(({ pull }) => pull.merged);
      const onStaging =
        issue.state === "open"
          ? allMerged &&
            pulls
              .filter(({ repo, pull }) => APP_REPOS.includes(repo) && pull.merged)
              .every(({ repo, pull }) => onStagingByMerge.get(`${repo}@${pull.mergeSha}`) === true)
          : allMerged;
      const marker = markers.get(issue.number) ?? null;
      const unfinishedOther = marker !== null && !marker.done && marker.version !== next.version;
      return {
        number: issue.number,
        title: issue.title,
        kind: issue.labels.includes("bug") ? "bug" : "feature-request",
        state: issue.state,
        stage,
        readiness: readinessOf(issue.labels),
        url: issue.url,
        labels: issue.labels,
        createdAt: issue.createdAt,
        closedAt: issue.closedAt,
        pullRequests,
        onStaging,
        productionReady: issue.state === "open" && onStaging && !unfinishedOther,
        ship: marker ? issueShipOf(marker, sortedRuns, newest, step) : null,
      };
    });

    return {
      generatedAt: at.toISOString(),
      stale: false,
      nextVersion: next.version,
      ...(next.error ? { nextVersionError: next.error } : {}),
      ship,
      environments: { staging, production },
      branches,
      issues: built,
    };
  }

  async function shipStateOf(
    newest: RunItem | undefined,
    step: string | null,
    markers: Map<number, ShipMarker | null>,
  ): Promise<PipelineSnapshot["ship"]> {
    const parsed = newest ? parseRunName(newest.name) : null;
    if (!newest || !parsed) return { active: false, run: null };
    const status = runStatusOf(newest.status);
    // The issue set: the record this API wrote before dispatching, else the markers that name it.
    const record = await withRedis(() => store.readShip(parsed.requestId));
    const issues =
      record?.issues ??
      [...markers.entries()]
        .filter(([, marker]) => marker?.requestId === parsed.requestId)
        .map(([number]) => number)
        .sort((a, b) => a - b);
    return {
      active: status !== "completed",
      run: {
        id: newest.id,
        url: newest.url,
        requestId: parsed.requestId,
        version: parsed.version,
        status,
        conclusion: runConclusionOf(newest.conclusion),
        step,
        issues,
        createdAt: newest.createdAt,
      },
    };
  }

  function issueShipOf(
    marker: ShipMarker,
    runs: RunItem[],
    newest: RunItem | undefined,
    newestStep: string | null,
  ): PipelineIssueShipShape {
    const runId = marker.runUrl?.match(/\/actions\/runs\/(\d+)/)?.[1];
    const run = runs.find(
      (r) =>
        r.name === runNameOf(marker.requestId, marker.version) ||
        (runId !== undefined && String(r.id) === runId),
    );
    return {
      requestId: marker.requestId,
      version: marker.version,
      runUrl: run?.url ?? marker.runUrl,
      done: marker.done,
      status: run ? runStatusOf(run.status) : "unknown",
      conclusion: run ? runConclusionOf(run.conclusion) : null,
      step: run && newest && run.id === newest.id ? newestStep : null,
    };
  }

  /** Serve the last-good snapshot as stale, or fail with UPSTREAM_ERROR when there is none. */
  async function lastGoodOr(err: unknown): Promise<SharedSnapshot> {
    const failure = describeFailure(err);
    logger.warn(failure, "pipeline snapshot refresh failed");
    const json = await withRedis(() => store.readLastGood());
    if (!json) throw upstreamError("Could not read the pipeline from GitHub");
    const reason =
      failure.status !== undefined
        ? `GitHub answered ${failure.status}`
        : failure.name === "TimeoutError" || failure.name === "AbortError"
          ? "GitHub timed out"
          : "GitHub unreachable";
    return { ...(JSON.parse(json) as SharedSnapshot), stale: true, staleReason: reason };
  }

  async function refreshOrWait(): Promise<SharedSnapshot> {
    for (let attempt = 0; attempt <= REFRESH_WAITS; attempt++) {
      if (await withRedis(() => store.tryRefreshLock())) {
        try {
          let shared: SharedSnapshot;
          try {
            shared = await buildShared();
          } catch (err) {
            return await lastGoodOr(err);
          }
          await withRedis(() => store.writeSnapshot(JSON.stringify(shared)));
          return shared;
        } finally {
          await store.releaseRefreshLock().catch(() => undefined);
        }
      }
      await sleep(REFRESH_WAIT_MS);
      const cached = await withRedis(() => store.readSnapshot());
      if (cached) return JSON.parse(cached) as SharedSnapshot;
    }
    return lastGoodOr(new Error("another refresh did not finish in time"));
  }

  const canDeploy = (email: string) => config.facilitatorEmails.has(email.trim().toLowerCase());

  const expectedPassphrase = Buffer.from(config.passphrase, "utf8");
  function passphraseMatches(given: string): boolean {
    const bytes = Buffer.from(given, "utf8");
    return bytes.length === expectedPassphrase.length && timingSafeEqual(bytes, expectedPassphrase);
  }

  async function authorize(user: PipelineActor, passphrase: string): Promise<void> {
    if (!canDeploy(user.email)) throw forbidden("Not a facilitator");
    const lockout = await withRedis(() => store.lockout(user.id));
    if (lockout.count >= LOCKOUT_LIMIT) {
      throw rateLimited({
        scope: "user",
        limit: LOCKOUT_LIMIT,
        resetAt: new Date(now().getTime() + Math.max(lockout.ttlSeconds, 0) * 1000).toISOString(),
      });
    }
    if (!passphraseMatches(passphrase)) {
      const failure = await withRedis(() => store.recordFailure(user.id));
      logger.warn({ userId: user.id, failures: failure.count }, "pipeline passphrase rejected");
      throw forbidden("Wrong passphrase", { reason: "passphrase" });
    }
  }

  /** One facilitator action at a time; the lock is released whatever the outcome. */
  async function withActionLock<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    if (!(await withRedis(() => store.tryActionLock(requestId)))) {
      throw conflict("another deploy is in progress");
    }
    try {
      return await fn();
    } finally {
      await store.releaseActionLock(requestId).catch(() => undefined);
    }
  }

  /** A GitHub read that fails is UPSTREAM_ERROR; the log carries status and name, never the body. */
  async function githubRead<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      logger.error(describeFailure(err), `pipeline github read failed: ${what}`);
      throw upstreamError(`Could not read ${what} from GitHub`);
    }
  }

  async function refuseWhileShipping(): Promise<void> {
    const runs = await githubRead("the ship runs", listRuns);
    if (runs.some((run) => runStatusOf(run.status) !== "completed")) {
      throw conflict("a ship is running, wait for it to finish");
    }
  }

  async function deployStaging(
    user: PipelineActor,
    issueNumber: number,
    passphrase: string,
  ): Promise<DeployStagingResult> {
    await authorize(user, passphrase);
    const requestId = randomUUID();
    return withActionLock(requestId, async () => {
      await refuseWhileShipping();
      // Fresh from GitHub, never the cache: the open pull requests, then each one's current head,
      // mergeable state and check runs, all inspected before anything merges.
      const candidates = await githubRead("the pull requests", async () => {
        const lists = await Promise.all(REPO_ORDER.map((repo) => listPulls(repo)));
        return REPO_ORDER.flatMap((repo, i) =>
          matchPullsToIssue(lists[i]!, issueNumber)
            .filter((pull) => pull.state === "open" && !pull.merged)
            .map((pull) => ({ repo, number: pull.number })),
        );
      });
      if (candidates.length === 0) throw conflict(`#${issueNumber} has no open pull requests`);
      const inspected = await githubRead("the pull requests", () =>
        Promise.all(
          candidates.map(async ({ repo, number }) => {
            const pull = await github.getPull({ repo: PIPELINE_REPOS[repo], number });
            const runs = await github.checkRuns({ repo: PIPELINE_REPOS[repo], ref: pull.headSha });
            return { repo, pull, verdict: isGreen(pull, runs, "develop") };
          }),
        ),
      );
      const notGreen = inspected.find((entry) => !entry.verdict.green);
      if (notGreen && !notGreen.verdict.green) {
        throw conflict(`${notGreen.repo} #${notGreen.pull.number} ${notGreen.verdict.reason}`);
      }

      const merged: DeployStagingResult["merged"] = [];
      const remaining: DeployStagingResult["remaining"] = [];
      let firstFailure: { repo: RepoKey; number: number; status?: number } | null = null;
      for (const { repo, pull } of inspected) {
        if (remaining.length > 0) {
          remaining.push({ repo, number: pull.number, reason: "not attempted" });
          continue;
        }
        try {
          const result = await github.mergePull({
            repo: PIPELINE_REPOS[repo],
            number: pull.number,
            sha: pull.headSha,
            method: "squash",
          });
          merged.push({ repo, number: pull.number, sha: result.sha });
        } catch (err) {
          const failure = describeFailure(err);
          logger.error({ ...failure, repo, number: pull.number }, "pipeline merge failed");
          firstFailure = { repo, number: pull.number, status: failure.status };
          remaining.push({ repo, number: pull.number, reason: mergeFailureReason(failure.status) });
        }
      }
      await withRedis(() => store.invalidate());
      logger.info(
        {
          userId: user.id,
          issue: issueNumber,
          action: "deploy-staging",
          requestId,
          merged: merged.map((m) => `${m.repo}#${m.number}`),
          remaining: remaining.map((r) => `${r.repo}#${r.number}`),
        },
        "pipeline deploy to staging",
      );
      // Nothing merged and the first merge refused: a clean refusal, not a partial success.
      if (merged.length === 0 && firstFailure) {
        const { repo, number, status } = firstFailure as {
          repo: RepoKey;
          number: number;
          status?: number;
        };
        if (status === 409) throw conflict(`${repo} #${number} moved since you looked, reload`);
        if (status === 405) throw conflict(`${repo} #${number} is not mergeable, reload`);
        throw upstreamError(`Could not merge ${repo} #${number}`);
      }
      return { merged, remaining };
    });
  }

  return {
    canDeploy,
    authorize,
    deployStaging,
    async snapshot(callerEmail) {
      const cached = await withRedis(() => store.readSnapshot());
      const shared = cached ? (JSON.parse(cached) as SharedSnapshot) : await refreshOrWait();
      return { ...shared, canDeploy: canDeploy(callerEmail) };
    },
  };
}

function mergeFailureReason(status: number | undefined): string {
  if (status === 409) return "moved since you looked";
  if (status === 405) return "not mergeable";
  return status === undefined ? "merge failed" : `merge failed (${status})`;
}

function readVersion(packageJson: string): string {
  try {
    const parsed = JSON.parse(packageJson) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
}
