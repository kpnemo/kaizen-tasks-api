import { Octokit } from "octokit";
import type { Db } from "../db/client.js";
import { notFound, upstreamError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { findUserById } from "../repositories/users.js";
import type { FeatureRequestInput } from "../schemas/feature-requests.js";
import type { FeatureRequestConversationsService } from "./feature-request-conversations.js";

export const FEATURE_REQUEST_LABEL = "feature-request";

export interface GitHubIssues {
  create(params: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; html_url: string }>;
}

export function createOctokitIssues(token: string): GitHubIssues {
  // request.timeout (ms, Node only) keeps a hanging GitHub call from stalling a request.
  const octokit = new Octokit({ auth: token, request: { timeout: 10_000 } });
  return {
    async create(params) {
      const { data } = await octokit.rest.issues.create(params);
      return { number: data.number, html_url: data.html_url };
    },
  };
}

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
}

export function createFeatureRequestsService(deps: {
  db: Db;
  issues: GitHubIssues;
  repo: string;
  logger: Logger;
  conversations: FeatureRequestConversationsService;
}): FeatureRequestsService {
  const [owner, repo] = deps.repo.split("/") as [string, string];

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
      // Never log the raw error: Octokit's RequestError carries `.response.data`, the raw
      // GitHub response body, which pino's default `err` serializer would otherwise dump.
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? (err as { status?: number }).status
          : undefined;
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error({ status, repo: deps.repo, message }, "github issue creation failed");
      throw upstreamError("Could not create the GitHub issue");
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
  };
}
