import type { Config } from "../../src/config.js";
import type {
  CheckRun,
  CommentItem,
  CompareStatus,
  IssueItem,
  JobItem,
  PipelineGitHub,
  PullItem,
  RunItem,
} from "../../src/services/pipeline-github.js";

/** The five settings that switch the pipeline on. The allowlist is mixed-case on purpose. */
export const PIPELINE_ENV: Partial<Config> = {
  PIPELINE_GITHUB_TOKEN: "ghp_pipeline_test",
  FACILITATOR_EMAILS: "Mike@Example.com, second@example.com",
  DEPLOY_PASSPHRASE: "correct-horse-battery",
  STAGING_WEB_URL: "https://s.test",
  PRODUCTION_WEB_URL: "https://p.test",
};

export const PASSPHRASE = "correct-horse-battery";
export const FACILITATOR_EMAIL = "mike@example.com";

export const HARNESS = "kpnemo/kaizen-tasks-assembly-line";
export const API = "kpnemo/kaizen-tasks-api";
export const WEB = "kpnemo/kaizen-tasks-web";

/**
 * An in-memory GitHub. Every read is answered from the maps below; every write is recorded.
 * `calls` lists method names in order so a test can assert what was (not) called.
 */
export class FakePipelineGitHub implements PipelineGitHub {
  issues: IssueItem[] = [];
  /** Pull requests by repo. */
  pulls: Record<string, PullItem[]> = {};
  /** Check runs by `${repo}@${ref}`. */
  checks: Record<string, CheckRun[]> = {};
  /** Compare answers by `${repo}:${base}...${head}`; default `identical`. */
  compares: Record<string, CompareStatus> = {};
  /** Branch heads by `${repo}:${branch}`. */
  heads: Record<string, string> = {};
  /** File contents by `${repo}:${ref}:${path}`. */
  files: Record<string, string> = {};
  /** Issue comments by issue number (harness). */
  comments: Record<number, CommentItem[]> = {};
  runs: RunItem[] = [];
  /** Jobs by run id. */
  jobs: Record<number, JobItem[]> = {};

  calls: string[] = [];
  merges: { repo: string; number: number; sha: string; method: string }[] = [];
  dispatches: { repo: string; workflow: string; ref: string; inputs: Record<string, string> }[] =
    [];
  posted: { repo: string; number: number; body: string }[] = [];

  /** When set, every call throws it. */
  failure: Error | null = null;
  /** Decides per merge whether it fails; returns the error to throw. */
  mergeFailure: (p: { repo: string; number: number }) => Error | undefined = () => undefined;
  /** When set, a dispatch is recorded (GitHub accepted it) and then throws (the answer was lost). */
  dispatchFailure: Error | null = null;
  /** When set, replaces the run list on the next `listRuns` call (used to simulate a run
   *  appearing after a dispatch). */
  onListRuns: (() => void) | null = null;

  private record(name: string): void {
    this.calls.push(name);
    if (this.failure) throw this.failure;
  }
  countOf(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }

  async listIssues(p: { repo: string; labels: string }): Promise<IssueItem[]> {
    this.record("listIssues");
    return this.issues.filter((i) => i.labels.includes(p.labels));
  }
  async listPulls(p: { repo: string }): Promise<PullItem[]> {
    this.record("listPulls");
    return this.pulls[p.repo] ?? [];
  }
  async getPull(p: { repo: string; number: number }): Promise<PullItem> {
    this.record("getPull");
    const pull = (this.pulls[p.repo] ?? []).find((x) => x.number === p.number);
    if (!pull) throw Object.assign(new Error("Not Found"), { status: 404 });
    return pull;
  }
  async checkRuns(p: { repo: string; ref: string }): Promise<CheckRun[]> {
    this.record("checkRuns");
    return this.checks[`${p.repo}@${p.ref}`] ?? [];
  }
  async compare(p: { repo: string; base: string; head: string }): Promise<CompareStatus> {
    this.record("compare");
    return this.compares[`${p.repo}:${p.base}...${p.head}`] ?? "identical";
  }
  async branchHead(p: { repo: string; branch: string }): Promise<string> {
    this.record("branchHead");
    const sha = this.heads[`${p.repo}:${p.branch}`];
    if (!sha) throw Object.assign(new Error("Branch not found"), { status: 404 });
    return sha;
  }
  async fileText(p: { repo: string; path: string; ref: string }): Promise<string> {
    this.record("fileText");
    const text = this.files[`${p.repo}:${p.ref}:${p.path}`];
    if (text === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
    return text;
  }
  async mergePull(p: {
    repo: string;
    number: number;
    sha: string;
    method: "squash" | "merge";
  }): Promise<{ sha: string }> {
    this.record("mergePull");
    const err = this.mergeFailure(p);
    if (err) throw err;
    this.merges.push(p);
    const pull = (this.pulls[p.repo] ?? []).find((x) => x.number === p.number);
    const sha = `merged-${p.repo.split("/")[1]}-${p.number}`;
    if (pull) {
      pull.state = "closed";
      pull.merged = true;
      pull.mergeSha = sha;
    }
    return { sha };
  }
  async commentIssue(p: { repo: string; number: number; body: string }): Promise<void> {
    this.record("commentIssue");
    this.posted.push(p);
  }
  async dispatchWorkflow(p: {
    repo: string;
    workflow: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void> {
    this.record("dispatchWorkflow");
    this.dispatches.push(p);
    if (this.dispatchFailure) throw this.dispatchFailure;
  }
  async listRuns(): Promise<RunItem[]> {
    this.record("listRuns");
    this.onListRuns?.();
    return this.runs;
  }
  async runJobs(p: { repo: string; runId: number }): Promise<JobItem[]> {
    this.record("runJobs");
    return this.jobs[p.runId] ?? [];
  }
  async listIssueComments(p: { repo: string; number: number }): Promise<CommentItem[]> {
    this.record("listIssueComments");
    return this.comments[p.number] ?? [];
  }
}

// ---------------------------------------------------------------- fixtures

export function issue(over: Partial<IssueItem> & { number: number }): IssueItem {
  return {
    title: `Issue ${over.number}`,
    state: "open",
    url: `https://github.com/${HARNESS}/issues/${over.number}`,
    createdAt: "2026-09-01T00:00:00Z",
    closedAt: null,
    labels: ["feature-request"],
    ...over,
  };
}

export function pull(
  repo: string,
  over: Partial<PullItem> & { number: number; headRef: string },
): PullItem {
  const merged = over.merged ?? false;
  return {
    title: `PR ${over.number}`,
    url: `https://github.com/${repo}/pull/${over.number}`,
    state: merged ? "closed" : "open",
    draft: false,
    headSha: `head-${repo.split("/")[1]}-${over.number}`,
    baseRef: "develop",
    body: "",
    mergeSha: merged ? `merged-${repo.split("/")[1]}-${over.number}` : null,
    mergeableState: null,
    ...over,
    merged,
  };
}

export function green(name = "ci"): CheckRun {
  return { name, status: "completed", conclusion: "success" };
}
export function red(name = "ci"): CheckRun {
  return { name, status: "completed", conclusion: "failure" };
}
export function running(name = "ci"): CheckRun {
  return { name, status: "in_progress", conclusion: null };
}

export function marker(m: {
  version: string;
  requestId: string;
  issues: number[];
  runUrl?: string;
  done?: boolean;
}): CommentItem {
  const json = JSON.stringify({
    version: m.version,
    requestId: m.requestId,
    startedAt: "2026-09-11T08:00:00Z",
    runUrl: m.runUrl ?? `https://github.com/${HARNESS}/actions/runs/900`,
    issues: m.issues,
    ...(m.done ? { done: true } : {}),
  });
  return {
    id: Math.floor(Math.random() * 1e6),
    body: `<!-- kaizen-ship ${json} -->\nShip started.`,
    createdAt: "2026-09-11T08:00:00Z",
  };
}

export function changelog(sections: Partial<Record<"Added" | "Changed" | "Fixed", string[]>>) {
  const lines = ["# Changelog", "", "## [Unreleased]", ""];
  for (const [heading, bullets] of Object.entries(sections)) {
    lines.push(`### ${heading}`, "", ...bullets.map((b) => `- ${b}`), "");
  }
  lines.push("## [1.3.0] - 2026-09-11", "", "### Added", "", "- Older.", "");
  return lines.join("\n");
}

export interface EnvAnswer {
  api?: { version: string; commit: string; db?: string; redis?: string } | null;
  web?: { version: string; commit: string } | null;
}

/**
 * A `fetch` that answers `/api/v1/health` and `/version.json` for the given base URLs and
 * fails for everything else. A `null` half is unreachable (the fetch rejects).
 */
export function fakeFetch(answers: Record<string, EnvAnswer>): typeof fetch {
  const impl = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [base, answer] of Object.entries(answers)) {
      if (url === `${base}/api/v1/health`) {
        if (!answer.api) throw new TypeError("fetch failed");
        const { version, commit, db = "ok", redis = "ok" } = answer.api;
        return Response.json({
          data: { status: "ok", commit, version, env: "staging", checks: { db, redis } },
        });
      }
      if (url === `${base}/version.json`) {
        if (!answer.web) throw new TypeError("fetch failed");
        return Response.json(answer.web);
      }
    }
    throw new TypeError(`fetch failed: ${url}`);
  };
  return impl as typeof fetch;
}

/**
 * The plan's first fixture: issue 22 open at stage staging with three merged PRs that staging
 * serves, issue 19 shipped two days ago, both repos at 1.3.0 with `### Added` bullets, one merged
 * release PR in web. Everything green, nothing shipping.
 */
export function seedWorld(gh: FakePipelineGitHub, now: Date): void {
  const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  gh.issues = [
    issue({
      number: 22,
      title: "Show existing requests",
      labels: ["feature-request", "staging", "clarity:5", "complexity:2", "risk:2"],
      createdAt: "2026-09-11T08:28:47Z",
    }),
    issue({
      number: 19,
      title: "Theme preference",
      state: "closed",
      closedAt: twoDaysAgo,
      labels: ["feature-request", "shipped"],
      createdAt: "2026-09-10T15:12:50Z",
    }),
  ];
  gh.pulls = {
    [WEB]: [
      pull(WEB, { number: 19, headRef: "feat/22-request-list", merged: true }),
      pull(WEB, { number: 20, headRef: "release/1.3.0", merged: true }),
    ],
    [API]: [pull(API, { number: 18, headRef: "feat/22-request-list", merged: true })],
    [HARNESS]: [pull(HARNESS, { number: 30, headRef: "feat/22-request-list", merged: true })],
  };
  gh.heads = {
    [`${API}:develop`]: "c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4",
    [`${API}:main`]: "a1774e5a1774e5a1774e5a1774e5a1774e5a1774e5",
    [`${WEB}:develop`]: "e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8",
    [`${WEB}:main`]: "33272c533272c533272c533272c533272c533272c5",
  };
  gh.compares = {
    [`${API}:c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4...merged-kaizen-tasks-api-18`]: "behind",
    [`${WEB}:e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8...merged-kaizen-tasks-web-19`]: "behind",
  };
  gh.files = {
    [`${API}:develop:package.json`]: JSON.stringify({ version: "1.3.0" }),
    [`${WEB}:develop:package.json`]: JSON.stringify({ version: "1.3.0" }),
    [`${API}:develop:CHANGELOG.md`]: changelog({ Added: ["GET /feature-requests."] }),
    [`${WEB}:develop:CHANGELOG.md`]: changelog({ Added: ["The request list."] }),
  };
  gh.runs = [];
  gh.comments = {};
}

export function seedEnvironments(): typeof fetch {
  return fakeFetch({
    "https://s.test": {
      api: { version: "1.3.0", commit: "c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4c4ec3f4" },
      web: { version: "1.3.0", commit: "e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8e9b52c8" },
    },
    "https://p.test": {
      api: { version: "1.2.0", commit: "a1774e5a1774e5a1774e5a1774e5a1774e5a1774e5" },
      web: { version: "1.2.0", commit: "33272c533272c533272c533272c533272c533272c5" },
    },
  });
}
