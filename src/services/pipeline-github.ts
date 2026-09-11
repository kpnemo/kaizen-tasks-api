import { Octokit } from "octokit";

/**
 * The second GitHub port: everything the pipeline reads and the two things it writes (merge,
 * dispatch). Built from PIPELINE_GITHUB_TOKEN only; the issue-filing GITHUB_TOKEN is never a
 * fallback. Tests inject an in-memory implementation; nothing here is reached by a test.
 */

export interface IssueItem {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  createdAt: string;
  closedAt: string | null;
  labels: string[];
}

export interface PullItem {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  body: string;
  /** The merge commit once merged; GitHub's test-merge SHA while open (ignored). */
  mergeSha: string | null;
  /** Only `getPull` fills it; the list endpoint does not carry it. */
  mergeableState: string | null;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export type CompareStatus = "identical" | "behind" | "ahead" | "diverged";

export interface RunItem {
  id: number;
  /** The run's display title, which `run-name:` sets: `ship <requestId> <version>`. */
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
}

export interface JobStep {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface JobItem {
  name: string;
  status: string;
  conclusion: string | null;
  steps: JobStep[];
}

export interface CommentItem {
  id: number;
  body: string;
  createdAt: string;
}

export interface PipelineGitHub {
  listIssues(p: {
    repo: string;
    labels: string;
    state: "all";
    perPage: number;
  }): Promise<IssueItem[]>;
  listPulls(p: { repo: string; state: "all"; perPage: number }): Promise<PullItem[]>;
  getPull(p: { repo: string; number: number }): Promise<PullItem>;
  checkRuns(p: { repo: string; ref: string }): Promise<CheckRun[]>;
  /** `GET /compare/{base}...{head}`: where `head` stands relative to `base`. */
  compare(p: { repo: string; base: string; head: string }): Promise<CompareStatus>;
  branchHead(p: { repo: string; branch: string }): Promise<string>;
  fileText(p: { repo: string; path: string; ref: string }): Promise<string>;
  mergePull(p: {
    repo: string;
    number: number;
    sha: string;
    method: "squash" | "merge";
  }): Promise<{ sha: string }>;
  commentIssue(p: { repo: string; number: number; body: string }): Promise<void>;
  dispatchWorkflow(p: {
    repo: string;
    workflow: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void>;
  listRuns(p: { repo: string; workflow: string; perPage: number }): Promise<RunItem[]>;
  runJobs(p: { repo: string; runId: number }): Promise<JobItem[]>;
  listIssueComments(p: { repo: string; number: number }): Promise<CommentItem[]>;
}

/** Same bound as the issue port: `request.timeout` is ignored by the fetch transport, so every
 *  call carries its own AbortSignal. */
const GITHUB_DEADLINE_MS = 10_000;
const deadline = () => ({ request: { signal: AbortSignal.timeout(GITHUB_DEADLINE_MS) } });
/** Mutations are never retried by the client: a retried POST after a 5xx could dispatch or merge
 *  twice. The service reconciles an unconfirmed dispatch from the run name instead. */
const mutation = () => ({
  request: { signal: AbortSignal.timeout(GITHUB_DEADLINE_MS), retries: 0 },
});

/**
 * The `octokit` package bundles the throttling plugin, whose default `onRateLimit` waits for the
 * reset (up to an hour) once; that wait is outside the per-call AbortSignal and would hold the
 * refresh lock past its TTL. Both handlers say no, so a rate-limited call fails at once and the
 * service's cooldown takes over.
 */
export function octokitOptionsFor(token: string) {
  return {
    auth: token,
    throttle: {
      onRateLimit: (
        _retryAfter: number,
        _options: object,
        _octokit: Octokit,
        _retryCount: number,
      ) => false,
      onSecondaryRateLimit: (
        _retryAfter: number,
        _options: object,
        _octokit: Octokit,
        _retryCount: number,
      ) => false,
    },
  };
}

function split(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/") as [string, string];
  return { owner, repo };
}

function labelNames(labels: (string | { name?: string })[]): string[] {
  return labels
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .filter((name) => name.length > 0);
}

export function createOctokitPipeline(
  token: string,
  octokit: Octokit = new Octokit(octokitOptionsFor(token)),
): PipelineGitHub {
  return {
    async listIssues(p) {
      const { data } = await octokit.rest.issues.listForRepo({
        ...split(p.repo),
        labels: p.labels,
        state: p.state,
        per_page: p.perPage,
        sort: "created",
        direction: "desc",
        ...deadline(),
      });
      return data
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state === "closed" ? ("closed" as const) : ("open" as const),
          url: issue.html_url,
          createdAt: issue.created_at,
          closedAt: issue.closed_at ?? null,
          labels: labelNames(issue.labels),
        }));
    },
    async listPulls(p) {
      const { data } = await octokit.rest.pulls.list({
        ...split(p.repo),
        state: p.state,
        per_page: p.perPage,
        sort: "updated",
        direction: "desc",
        ...deadline(),
      });
      return data.map((pull) => ({
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        state: pull.state === "closed" ? ("closed" as const) : ("open" as const),
        merged: pull.merged_at !== null,
        draft: pull.draft ?? false,
        headRef: pull.head.ref,
        headSha: pull.head.sha,
        baseRef: pull.base.ref,
        body: pull.body ?? "",
        mergeSha: pull.merge_commit_sha ?? null,
        mergeableState: null,
      }));
    },
    async getPull(p) {
      const { data } = await octokit.rest.pulls.get({
        ...split(p.repo),
        pull_number: p.number,
        ...deadline(),
      });
      return {
        number: data.number,
        title: data.title,
        url: data.html_url,
        state: data.state === "closed" ? "closed" : "open",
        merged: data.merged,
        draft: data.draft ?? false,
        headRef: data.head.ref,
        headSha: data.head.sha,
        baseRef: data.base.ref,
        body: data.body ?? "",
        mergeSha: data.merge_commit_sha ?? null,
        mergeableState: data.mergeable_state ?? null,
      };
    },
    async checkRuns(p) {
      const { data } = await octokit.rest.checks.listForRef({
        ...split(p.repo),
        ref: p.ref,
        per_page: 100,
        ...deadline(),
      });
      return data.check_runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion ?? null,
      }));
    },
    async compare(p) {
      const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
        ...split(p.repo),
        basehead: `${p.base}...${p.head}`,
        per_page: 1,
        ...deadline(),
      });
      return data.status;
    },
    async branchHead(p) {
      const { data } = await octokit.rest.repos.getBranch({
        ...split(p.repo),
        branch: p.branch,
        ...deadline(),
      });
      return data.commit.sha;
    },
    async fileText(p) {
      const { data } = await octokit.rest.repos.getContent({
        ...split(p.repo),
        path: p.path,
        ref: p.ref,
        ...deadline(),
      });
      if (Array.isArray(data) || data.type !== "file") {
        throw new Error(`${p.repo}:${p.ref}:${p.path} is not a file`);
      }
      return Buffer.from(data.content, "base64").toString("utf8");
    },
    async mergePull(p) {
      const { data } = await octokit.rest.pulls.merge({
        ...split(p.repo),
        pull_number: p.number,
        sha: p.sha,
        merge_method: p.method,
        ...mutation(),
      });
      return { sha: data.sha };
    },
    async commentIssue(p) {
      await octokit.rest.issues.createComment({
        ...split(p.repo),
        issue_number: p.number,
        body: p.body,
        ...mutation(),
      });
    },
    async dispatchWorkflow(p) {
      await octokit.rest.actions.createWorkflowDispatch({
        ...split(p.repo),
        workflow_id: p.workflow,
        ref: p.ref,
        inputs: p.inputs,
        ...mutation(),
      });
    },
    async listRuns(p) {
      const { data } = await octokit.rest.actions.listWorkflowRuns({
        ...split(p.repo),
        workflow_id: p.workflow,
        event: "workflow_dispatch",
        per_page: p.perPage,
        ...deadline(),
      });
      return data.workflow_runs.map((run) => ({
        id: run.id,
        // `display_title` is what `run-name:` sets; `name` stays the workflow's name.
        name: run.display_title ?? run.name ?? "",
        status: run.status ?? "",
        conclusion: run.conclusion ?? null,
        url: run.html_url,
        createdAt: run.created_at,
      }));
    },
    async runJobs(p) {
      const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
        ...split(p.repo),
        run_id: p.runId,
        per_page: 20,
        ...deadline(),
      });
      return data.jobs.map((job) => ({
        name: job.name,
        status: job.status,
        conclusion: job.conclusion ?? null,
        steps: (job.steps ?? []).map((step) => ({
          name: step.name,
          status: step.status,
          conclusion: step.conclusion ?? null,
        })),
      }));
    },
    async listIssueComments(p) {
      const { data } = await octokit.rest.issues.listComments({
        ...split(p.repo),
        issue_number: p.number,
        per_page: 100,
        ...deadline(),
      });
      return data.map((comment) => ({
        id: comment.id,
        body: comment.body ?? "",
        createdAt: comment.created_at,
      }));
    },
  };
}
