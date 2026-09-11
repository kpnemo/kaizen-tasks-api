import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";
import { z } from "zod";
import { conflict, forbidden, rateLimited, upstreamError, unavailable } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import {
  COOLDOWN_MAX_SECONDS,
  COOLDOWN_SECONDS,
  LOCKOUT_LIMIT,
  PIPELINE_KEYS,
  REFRESH_LOCK_SECONDS,
  createPipelineStore,
  type PipelineStore,
  type ShipRecord,
} from "../lib/pipeline-locks.js";
import type {
  DeployStagingResult,
  PipelineEnvironmentShape,
  PipelineIssueShape,
  PipelineIssueShipShape,
  PipelinePullRequestShape,
  PipelineShipRunShape,
  PipelineSnapshotShape,
  ShipInput,
  ShipResult,
  ShipRetryInput,
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
/** A last-good this young is served as fresh while someone else refreshes. */
const FRESH_ENOUGH_MS = 60_000;
const SHIP_POLL_INTERVAL_MS = 2_000;
const SHIP_POLL_TIMEOUT_MS = 20_000;

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

/** Runs the probe script or a by-hand dry run started; never a ship the room should see. */
export function isRehearsalRun(run: RunItem): boolean {
  const parsed = parseRunName(run.name);
  return parsed !== null && /^(probe|dry-)/.test(parsed.requestId);
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
  ship(user: PipelineActor, input: ShipInput): Promise<ShipResult>;
  retryShip(user: PipelineActor, input: ShipRetryInput): Promise<ShipResult>;
}

export interface PipelineDeps {
  github: PipelineGitHub;
  redis: Redis;
  fetchImpl: typeof fetch;
  config: PipelineConfig;
  logger: Logger;
  now?: () => Date;
  /** How often and how long to look for the dispatched run. Tests shorten both. */
  shipPoll?: { intervalMs: number; timeoutMs: number };
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

/** Rate-limit headers of an Octokit RequestError, never its body. */
function rateLimitHeadersOf(err: unknown): Record<string, string> {
  const headers =
    typeof err === "object" && err !== null && "response" in err
      ? (err as { response?: { headers?: unknown } }).response?.headers
      : undefined;
  if (typeof headers !== "object" || headers === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number")
      out[key.toLowerCase()] = String(value);
  }
  return out;
}

export function createPipelineService(deps: PipelineDeps): PipelineService {
  const { github, config, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const shipPoll = deps.shipPoll ?? {
    intervalMs: SHIP_POLL_INTERVAL_MS,
    timeoutMs: SHIP_POLL_TIMEOUT_MS,
  };
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
    // Compares per (served commit, merge commit) pair: the answer is immutable, so it is cached
    // for an hour and only new pairs reach GitHub.
    const pairs = new Map<string, { repo: RepoKey; base: string; head: string }>();
    const onStagingByMerge = new Map<string, boolean>();
    for (const { issue, pulls } of matched) {
      if (issue.state !== "open") continue;
      for (const { repo, pull } of pulls) {
        if (!APP_REPOS.includes(repo) || !pull.merged || pull.mergeSha === null) continue;
        const base = served[repo as "api" | "web"];
        if (!base) {
          onStagingByMerge.set(`${repo}@${pull.mergeSha}`, false);
          continue;
        }
        pairs.set(PIPELINE_KEYS.compare(repo, base, pull.mergeSha), {
          repo,
          base,
          head: pull.mergeSha,
        });
      }
    }
    const pairKeys = [...pairs.keys()];
    const cachedCompares = await withRedis(() => store.readCompares(pairKeys));
    const freshCompares = await Promise.all(
      pairKeys
        .filter((_key, i) => cachedCompares[i] === null)
        .map(async (key) => {
          const pair = pairs.get(key)!;
          const status = await github.compare({
            repo: PIPELINE_REPOS[pair.repo],
            base: pair.base,
            head: pair.head,
          });
          return { key, status };
        }),
    );
    if (freshCompares.length > 0) await withRedis(() => store.writeCompares(freshCompares));
    const compareByKey = new Map<string, string>();
    pairKeys.forEach((key, i) => {
      const cached = cachedCompares[i];
      if (cached !== null && cached !== undefined) compareByKey.set(key, cached);
    });
    for (const { key, status } of freshCompares) compareByKey.set(key, status);
    for (const [key, pair] of pairs) {
      const status = compareByKey.get(key);
      onStagingByMerge.set(
        `${pair.repo}@${pair.head}`,
        status === "identical" || status === "behind",
      );
    }

    // Ship markers only where a ship could have touched the issue: open and labelled staging
    // (the workflow's preflight requires the label; a shipped or closed issue needs no button).
    const markers = new Map<number, ShipMarker | null>();
    await Promise.all(
      matched.map(async ({ issue }) => {
        if (issue.state !== "open" || !issue.labels.includes("staging")) return;
        const comments = await github.listIssueComments({
          repo: PIPELINE_REPOS.harness,
          number: issue.number,
        });
        markers.set(issue.number, newestMarker(comments));
      }),
    );

    // The ship workflow: the newest run, its step when it is running or failed.
    const sortedRuns = runs
      .filter((run) => !isRehearsalRun(run))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
        // The ship workflow's preflight requires the staging label, so readiness does too.
        productionReady:
          issue.state === "open" && stage === "staging" && onStaging && !unfinishedOther,
        // Before the workflow writes its marker, the record this API kept names the issue.
        ship: marker
          ? issueShipOf(marker, sortedRuns, newest, step)
          : ship.active && ship.run?.issues.includes(issue.number)
            ? {
                requestId: ship.run.requestId,
                version: ship.run.version,
                runUrl: ship.run.url,
                done: false,
                status: ship.run.status,
                conclusion: ship.run.conclusion,
                step: ship.run.step,
              }
            : null,
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

  const parseShared = (json: string) => JSON.parse(json) as SharedSnapshot;
  const ageOf = (shared: SharedSnapshot) => now().getTime() - Date.parse(shared.generatedAt);

  /** The last-good snapshot as stale, or UPSTREAM_ERROR when there is none. No GitHub call. */
  function staleOr(lastGood: SharedSnapshot | null, reason: string): SharedSnapshot {
    if (!lastGood) throw upstreamError("Could not read the pipeline from GitHub");
    return { ...lastGood, stale: true, staleReason: reason };
  }

  /** How long to stay away from GitHub after a failed refresh, and what to tell the room. A
   *  rate limit (403/429 with the headers) is honoured until its reset; anything else is 60 s. */
  function cooldownFor(err: unknown): { reason: string; seconds: number } {
    const failure = describeFailure(err);
    if (failure.status === 403 || failure.status === 429) {
      const headers = rateLimitHeadersOf(err);
      const retryAfter = Number(headers["retry-after"]);
      const reset = Number(headers["x-ratelimit-reset"]);
      let seconds: number | null = null;
      if (Number.isFinite(retryAfter) && retryAfter > 0) seconds = retryAfter;
      else if (headers["x-ratelimit-remaining"] === "0" && Number.isFinite(reset) && reset > 0) {
        seconds = reset - Math.floor(now().getTime() / 1000);
      }
      if (seconds !== null) {
        seconds = Math.min(Math.max(seconds, 1), COOLDOWN_MAX_SECONDS);
        const until = new Date(now().getTime() + seconds * 1000).toISOString().slice(11, 16);
        return { reason: `GitHub rate limit until ${until} UTC`, seconds };
      }
    }
    const reason =
      failure.status !== undefined
        ? `GitHub answered ${failure.status}`
        : failure.name === "TimeoutError" || failure.name === "AbortError"
          ? "GitHub timed out"
          : "GitHub unreachable";
    return { reason, seconds: COOLDOWN_SECONDS };
  }

  /** Build under the lock we hold. A failure starts the cooldown and answers last-good as stale. */
  async function refresh(): Promise<SharedSnapshot> {
    let shared: SharedSnapshot;
    try {
      shared = await buildShared();
    } catch (err) {
      const cooldown = cooldownFor(err);
      logger.warn(
        { ...describeFailure(err), cooldownSeconds: cooldown.seconds },
        "pipeline snapshot refresh failed",
      );
      await withRedis(() => store.setCooldown(cooldown.reason, cooldown.seconds));
      const json = await withRedis(() => store.readLastGood());
      return staleOr(json ? parseShared(json) : null, cooldown.reason);
    }
    await withRedis(() => store.writeSnapshot(JSON.stringify(shared)));
    return shared;
  }

  async function refreshUnder(token: string): Promise<SharedSnapshot> {
    try {
      return await refresh();
    } finally {
      await store.releaseRefreshLock(token).catch(() => undefined);
    }
  }

  /** Another caller holds the lock and nothing young enough exists: wait for its result, up to
   *  the lock's TTL, taking the lock over if it lapses without one. */
  async function waitForRefresher(lastGood: SharedSnapshot | null): Promise<SharedSnapshot> {
    const deadline = Date.now() + REFRESH_LOCK_SECONDS * 1000;
    while (Date.now() < deadline) {
      await sleep(REFRESH_WAIT_MS);
      const state = await withRedis(() => store.readState());
      if (state.snapshot) return parseShared(state.snapshot);
      if (state.cooldown) {
        return staleOr(state.lastGood ? parseShared(state.lastGood) : lastGood, state.cooldown);
      }
      const token = await withRedis(() => store.tryRefreshLock());
      if (token) return refreshUnder(token);
    }
    return staleOr(lastGood, "another refresh did not finish in time");
  }

  async function sharedSnapshot(): Promise<SharedSnapshot> {
    const state = await withRedis(() => store.readState());
    if (state.snapshot) return parseShared(state.snapshot);
    const lastGood = state.lastGood ? parseShared(state.lastGood) : null;
    // After a failed refresh nothing reaches GitHub until the cooldown lapses.
    if (state.cooldown) return staleOr(lastGood, state.cooldown);
    const token = await withRedis(() => store.tryRefreshLock());
    if (token) return refreshUnder(token);
    // Someone else is refreshing: a young last-good is good enough, not stale.
    if (lastGood && ageOf(lastGood) < FRESH_ENOUGH_MS) return lastGood;
    return waitForRefresher(lastGood);
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
    if (runs.some((run) => !isRehearsalRun(run) && runStatusOf(run.status) !== "completed")) {
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

  // ---------------------------------------------------------------- ship

  const sameSet = (a: number[], b: number[]) =>
    a.length === b.length && a.every((n, i) => n === b[i]);
  const sortedUnique = (issues: number[]) => [...new Set(issues)].sort((a, b) => a - b);

  async function findRun(
    requestId: string,
    version: string,
  ): Promise<{ id: number; url: string; status: string } | null> {
    const runs = await listRuns();
    const run = runs.find((r) => r.name === runNameOf(requestId, version));
    return run ? { id: run.id, url: run.url, status: run.status } : null;
  }

  /** Polls the runs list for the run named after the request id; null when it is not visible in time. */
  async function pollForRun(requestId: string, version: string): Promise<ShipResult["run"]> {
    const deadline = Date.now() + shipPoll.timeoutMs;
    for (;;) {
      const run = await findRun(requestId, version).catch(() => null);
      if (run) return { id: run.id, url: run.url };
      if (Date.now() >= deadline) return null;
      await sleep(shipPoll.intervalMs);
    }
  }

  /**
   * Record (once: SET NX), dispatch, poll, invalidate. A dispatch that throws may still have been
   * accepted, so the record stays, marked unknown, and the next snapshot reconciles it by run
   * name; while it lives nothing dispatches the same release again.
   */
  async function dispatchShip(
    user: PipelineActor,
    action: "ship" | "ship-retry",
    record: Omit<ShipRecord, "state">,
    options: { retryOf?: string } = {},
  ): Promise<ShipResult> {
    const { requestId, version, issues } = record;
    const created = await withRedis(() =>
      store.createShip({ requestId, version, issues, state: "dispatched" }, options),
    );
    if (!created) {
      // Recorded by a press that got here first: the same answer, no second dispatch.
      logger.info({ userId: user.id, action, requestId }, "pipeline ship already recorded");
      return { requestId, version, issues, run: null };
    }
    try {
      await github.dispatchWorkflow({
        repo: PIPELINE_REPOS.harness,
        workflow: SHIP_WORKFLOW,
        ref: "develop",
        inputs: { request_id: requestId, version, issues: issues.join(",") },
      });
    } catch (err) {
      logger.error({ ...describeFailure(err), requestId }, "pipeline ship dispatch unconfirmed");
      await store.markShipUnknown(requestId).catch(() => undefined);
      throw upstreamError(
        "The ship dispatch did not confirm; the next snapshot reconciles it by run name, do not press again",
      );
    }
    const run = await pollForRun(requestId, version);
    await withRedis(() => store.invalidate());
    logger.info(
      { userId: user.id, action, requestId, version, issues, runId: run?.id ?? null },
      "pipeline ship dispatched",
    );
    return { requestId, version, issues, run };
  }

  async function ship(user: PipelineActor, input: ShipInput): Promise<ShipResult> {
    await authorize(user, input.passphrase);
    const requested = sortedUnique(input.issues);
    return withActionLock(randomUUID(), async () => {
      // A lost response: the same release was already dispatched and its run has not concluded,
      // so answer with that request id and never dispatch twice.
      const latest = await withRedis(() => store.readLatestShip());
      if (latest && latest.version === input.version && sameSet(latest.issues, requested)) {
        const run = await githubRead("the ship runs", () =>
          findRun(latest.requestId, latest.version),
        );
        if (!run || runStatusOf(run.status) !== "completed") {
          return {
            requestId: latest.requestId,
            version: latest.version,
            issues: latest.issues,
            run: run ? { id: run.id, url: run.url } : null,
          };
        }
      }
      // Fresh, never the cache: the ready set and the next version as of this press.
      const shared = await githubRead("the pipeline", buildShared);
      if (shared.ship.active) throw conflict("a ship is running, wait for it to finish");
      for (const number of requested) {
        const issue = shared.issues.find((i) => i.number === number);
        if (issue?.ship && !issue.ship.done && issue.ship.version !== input.version) {
          throw conflict(
            `#${number} carries an unfinished ship for ${issue.ship.version}, retry the earlier ship first`,
          );
        }
      }
      if (shared.nextVersion === null) {
        throw conflict(shared.nextVersionError ?? "nothing to release");
      }
      const ready = sortedUnique(
        shared.issues.filter((i) => i.productionReady).map((i) => i.number),
      );
      if (shared.nextVersion !== input.version || !sameSet(ready, requested)) {
        throw conflict("the release changed, reload");
      }
      return dispatchShip(user, "ship", {
        requestId: randomUUID(),
        version: input.version,
        issues: ready,
      });
    });
  }

  async function retryShip(user: PipelineActor, input: ShipRetryInput): Promise<ShipResult> {
    await authorize(user, input.passphrase);
    return withActionLock(randomUUID(), async () => {
      const [comments, runs] = await githubRead("the ship record", () =>
        Promise.all([
          github.listIssueComments({ repo: PIPELINE_REPOS.harness, number: input.issue }),
          listRuns(),
        ]),
      );
      const marker = newestMarker(comments);
      if (!marker) throw conflict(`no ship recorded on #${input.issue}`);
      if (marker.done)
        throw conflict(`the ship of ${marker.version} for #${input.issue} completed`);
      const base = marker.requestId.replace(/-r\d+$/, "");
      const suffixOf = (id: string) => Number(id.match(/-r(\d+)$/)?.[1] ?? 0);
      // An attempt this API already recorded for that ship whose run has not concluded (or is not
      // visible yet): the same answer, and never a second dispatch of it.
      const prior = await withRedis(() => store.readRetry(base));
      if (prior) {
        const priorRun = runs.find((r) => r.name === runNameOf(prior.requestId, prior.version));
        if (!priorRun || runStatusOf(priorRun.status) !== "completed") {
          return {
            requestId: prior.requestId,
            version: prior.version,
            issues: prior.issues,
            run: priorRun ? { id: priorRun.id, url: priorRun.url } : null,
          };
        }
      }
      const runId = marker.runUrl?.match(/\/actions\/runs\/(\d+)/)?.[1];
      const own = runs.find(
        (r) =>
          r.name === runNameOf(marker.requestId, marker.version) ||
          (runId !== undefined && String(r.id) === runId),
      );
      if (own && runStatusOf(own.status) !== "completed") {
        throw conflict("the ship is still running");
      }
      if (runs.some((r) => !isRehearsalRun(r) && runStatusOf(r.status) !== "completed")) {
        throw conflict("a ship is running, wait for it to finish");
      }
      // The next attempt number: one past the highest the marker, our records or the runs know.
      const attempts = [
        suffixOf(marker.requestId),
        prior ? suffixOf(prior.requestId) : 0,
        ...runs
          .map((r) => parseRunName(r.name))
          .filter((p): p is { requestId: string; version: string } => p !== null)
          .filter((p) => p.requestId.replace(/-r\d+$/, "") === base)
          .map((p) => suffixOf(p.requestId)),
      ];
      const requestId = `${base}-r${Math.max(...attempts) + 1}`;
      const issues = marker.issues.length > 0 ? marker.issues : [input.issue];
      return dispatchShip(
        user,
        "ship-retry",
        { requestId, version: marker.version, issues },
        { retryOf: base },
      );
    });
  }

  return {
    canDeploy,
    authorize,
    deployStaging,
    ship,
    retryShip,
    async snapshot(callerEmail) {
      return { ...(await sharedSnapshot()), canDeploy: canDeploy(callerEmail) };
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
