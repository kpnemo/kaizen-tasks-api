import { Octokit } from "octokit";
import type { Db } from "../db/client.js";
import { notFound, upstreamError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { findUserById } from "../repositories/users.js";
import type { FeatureRequestInput } from "../schemas/feature-requests.js";
import type { FeatureRequestConversationsService } from "./feature-request-conversations.js";

export const FEATURE_REQUEST_LABEL = "feature-request";

/** One issue as the listing needs it: labels flattened to names, pull requests already excluded. */
export interface GitHubIssueListItem {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  created_at: string;
  closed_at: string | null;
  labels: string[];
}

export interface GitHubIssues {
  create(params: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; html_url: string }>;
  list(params: {
    owner: string;
    repo: string;
    labels: string;
    state: "open" | "closed";
    per_page: number;
    sort: "created";
    direction: "desc";
  }): Promise<GitHubIssueListItem[]>;
}

export function createOctokitIssues(token: string): GitHubIssues {
  // request.timeout (ms, Node only) keeps a hanging GitHub call from stalling a request.
  const octokit = new Octokit({ auth: token, request: { timeout: 10_000 } });
  return {
    async create(params) {
      const { data } = await octokit.rest.issues.create(params);
      return { number: data.number, html_url: data.html_url };
    },
    async list(params) {
      const { data } = await octokit.rest.issues.listForRepo(params);
      // The issues API returns pull requests too; they carry `pull_request`.
      return data
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state === "closed" ? ("closed" as const) : ("open" as const),
          html_url: issue.html_url,
          created_at: issue.created_at,
          closed_at: issue.closed_at ?? null,
          labels: issue.labels
            .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
            .filter((name) => name.length > 0),
        }));
    },
  };
}

export type FeatureRequestStage =
  "new" | "triaged" | "implementing" | "staging" | "shipped" | "closed";

export interface FeatureRequestSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  stage: FeatureRequestStage;
  readiness: number | null;
  labels: string[];
  url: string;
  createdAt: string;
  closedAt: string | null;
}

const STAGE_LABELS = ["shipped", "staging", "implementing", "triaged"] as const;

/** The first lifecycle label in priority order; `closed` or `new` when none is present. */
export function stageOf(labels: string[], state: "open" | "closed"): FeatureRequestStage {
  for (const stage of STAGE_LABELS) if (labels.includes(stage)) return stage;
  return state === "closed" ? "closed" : "new";
}

/** The rubric formula over the triage labels; null unless all three scores are present and 1..5. */
export function readinessOf(labels: string[]): number | null {
  const score = (name: string): number | null => {
    const label = labels.find((l) => l.startsWith(`${name}:`));
    const n = label ? Number(label.slice(name.length + 1)) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  };
  const c = score("clarity");
  const x = score("complexity");
  const r = score("risk");
  return c === null || x === null || r === null ? null : c * 2 + (6 - x) + (6 - r);
}

function summarize(issue: GitHubIssueListItem): FeatureRequestSummary {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    stage: stageOf(issue.labels, issue.state),
    readiness: readinessOf(issue.labels),
    labels: issue.labels,
    url: issue.html_url,
    createdAt: issue.created_at,
    closedAt: issue.closed_at,
  };
}

const newestFirst = (a: GitHubIssueListItem, b: GitHubIssueListItem): number =>
  b.created_at.localeCompare(a.created_at);

/** Mirrors the assembly-line issue form's sections. Only the display name identifies the submitter. */
export function renderIssueBody(input: FeatureRequestInput, submitterName: string): string {
  return [
    "## Problem statement",
    "",
    input.problem,
    "",
    "## Proposed behavior",
    "",
    input.proposedBehavior,
    "",
    "## Acceptance criteria",
    "",
    input.acceptanceCriteria,
    "",
    "## Out of scope",
    "",
    input.outOfScope?.trim() ? input.outOfScope : "_Not specified._",
    "",
    "---",
    `Submitted from Kaizen Tasks by **${submitterName}**.`,
    "",
  ].join("\n");
}

export interface FeatureRequestsService {
  submit(
    userId: string,
    input: FeatureRequestInput,
  ): Promise<{ issueNumber: number; issueUrl: string }>;
  /** Open requests first, then closed, newest first within each group, at most 50 per group. */
  list(): Promise<FeatureRequestSummary[]>;
}

export function createFeatureRequestsService(deps: {
  db: Db;
  issues: GitHubIssues;
  repo: string;
  logger: Logger;
  conversations: FeatureRequestConversationsService;
}): FeatureRequestsService {
  const [owner, repo] = deps.repo.split("/") as [string, string];

  /** Logs status and message only and returns the envelope error to throw. Never log the raw
   *  error: Octokit's RequestError carries `.response.data`, the raw GitHub response body, which
   *  pino's default `err` serializer would otherwise dump. */
  function githubFailure(err: unknown, logMessage: string, userMessage: string) {
    const status =
      typeof err === "object" && err !== null && "status" in err
        ? (err as { status?: number }).status
        : undefined;
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.error({ status, repo: deps.repo, message }, logMessage);
    return upstreamError(userMessage);
  }

  async function createIssue(title: string, body: string) {
    try {
      return await deps.issues.create({
        owner,
        repo,
        title,
        body,
        labels: [FEATURE_REQUEST_LABEL],
      });
    } catch (err) {
      throw githubFailure(err, "github issue creation failed", "Could not create the GitHub issue");
    }
  }

  async function listState(state: "open" | "closed") {
    try {
      return await deps.issues.list({
        owner,
        repo,
        labels: FEATURE_REQUEST_LABEL,
        state,
        per_page: 50,
        sort: "created",
        direction: "desc",
      });
    } catch (err) {
      throw githubFailure(err, "github issue listing failed", "Could not list the GitHub issues");
    }
  }

  return {
    async submit(userId, input) {
      const user = await findUserById(deps.db, userId);
      if (!user) throw notFound("User not found");
      // Ownership and status are checked before the issue exists, so a conversationId that is not
      // the caller's, or one already filed, never creates an issue.
      const attachment = input.conversationId
        ? await deps.conversations.attachToIssue(userId, input.conversationId)
        : undefined;
      const body = renderIssueBody(input, user.displayName) + (attachment?.section ?? "");
      const issue = await createIssue(input.title, body);
      // Only after GitHub accepted it: a failed filing leaves the conversation open to retry.
      await attachment?.markFiled(issue.number);
      return { issueNumber: issue.number, issueUrl: issue.html_url };
    },
    async list() {
      const [open, closed] = await Promise.all([listState("open"), listState("closed")]);
      return [...open.sort(newestFirst), ...closed.sort(newestFirst)].map(summarize);
    },
  };
}
