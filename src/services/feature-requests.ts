import { Octokit } from "octokit";
import type { Db } from "../db/client.js";
import { notFound, upstreamError } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { findUserById } from "../repositories/users.js";
import type { FeatureRequestInput } from "../schemas/feature-requests.js";

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
  const octokit = new Octokit({ auth: token });
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
}): FeatureRequestsService {
  const [owner, repo] = deps.repo.split("/") as [string, string];
  return {
    async submit(userId, input) {
      const user = await findUserById(deps.db, userId);
      if (!user) throw notFound("User not found");
      try {
        const issue = await deps.issues.create({
          owner,
          repo,
          title: input.title,
          body: renderIssueBody(input, user.displayName),
          labels: [FEATURE_REQUEST_LABEL],
        });
        return { issueNumber: issue.number, issueUrl: issue.html_url };
      } catch (err) {
        deps.logger.error({ err, repo: deps.repo }, "github issue creation failed");
        throw upstreamError("Could not create the GitHub issue");
      }
    },
  };
}
