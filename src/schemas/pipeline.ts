import { z } from "zod";
import { envelope, errorResponses, jsonResponse } from "./common.js";
import { bearerAuth, registry } from "./registry.js";

const RepoKey = z.enum(["api", "web", "harness"]);
const RunStatus = z.enum(["queued", "in_progress", "completed"]);
const RunConclusion = z.enum(["success", "failure", "cancelled", "timed_out"]).nullable();

export const PipelinePullRequest = z
  .object({
    repo: RepoKey,
    number: z.number().int(),
    url: z.url(),
    state: z.enum(["open", "merged", "closed"]),
    /** Only for open pull requests; null once merged or closed. */
    checks: z.enum(["pending", "green", "red"]).nullable(),
    mergeSha: z.string().nullable(),
    headSha: z.string(),
    draft: z.boolean(),
  })
  .openapi("PipelinePullRequest");

export const PipelineIssueShip = z
  .object({
    requestId: z.string(),
    version: z.string(),
    runUrl: z.url().nullable(),
    done: z.boolean(),
    /** `unknown` when the marker's run is not among the newest ship runs. */
    status: z.enum(["queued", "in_progress", "completed", "unknown"]),
    conclusion: RunConclusion,
    step: z.string().nullable(),
  })
  .openapi("PipelineIssueShip");

export const PipelineIssue = z
  .object({
    number: z.number().int(),
    title: z.string(),
    kind: z.enum(["feature-request", "bug"]),
    state: z.enum(["open", "closed"]),
    stage: z.enum(["new", "triaged", "implementing", "staging", "shipped", "closed"]),
    readiness: z.number().int().nullable(),
    url: z.url(),
    labels: z.array(z.string()),
    createdAt: z.string(),
    closedAt: z.string().nullable(),
    pullRequests: z.array(PipelinePullRequest),
    onStaging: z.boolean(),
    productionReady: z.boolean(),
    ship: PipelineIssueShip.nullable(),
  })
  .openapi("PipelineIssue");

const CheckState = z.enum(["ok", "failed"]);

export const PipelineEnvironment = z
  .object({
    api: z
      .object({ version: z.string(), commit: z.string(), db: CheckState, redis: CheckState })
      .nullable(),
    web: z.object({ version: z.string(), commit: z.string() }).nullable(),
    /** `current` when both halves serve the tracked branch's head, `deploying` when a served
     *  commit differs from it, `unreachable` when either half did not answer within 5 s. */
    state: z.enum(["current", "deploying", "unreachable"]),
  })
  .openapi("PipelineEnvironment");

const BranchHeads = z.object({ develop: z.string(), main: z.string() });

export const PipelineShipRun = z
  .object({
    id: z.number().int(),
    url: z.url(),
    requestId: z.string(),
    version: z.string(),
    status: RunStatus,
    conclusion: RunConclusion,
    /** The step in progress, or the step that failed; null while queued or after success. */
    step: z.string().nullable(),
    issues: z.array(z.number().int()),
    createdAt: z.string(),
  })
  .openapi("PipelineShipRun");

export const PipelineSnapshot = z
  .object({
    generatedAt: z.iso.datetime(),
    /** True when this is the last-good snapshot served because GitHub could not be read. */
    stale: z.boolean(),
    staleReason: z.string().optional(),
    /** Per caller, outside the cache: the session email is on the facilitator allowlist. */
    canDeploy: z.boolean(),
    nextVersion: z.string().nullable(),
    nextVersionError: z.string().optional(),
    ship: z.object({ active: z.boolean(), run: PipelineShipRun.nullable() }),
    environments: z.object({ staging: PipelineEnvironment, production: PipelineEnvironment }),
    branches: z.object({ api: BranchHeads, web: BranchHeads }),
    issues: z.array(PipelineIssue),
  })
  .openapi("PipelineSnapshot");

export type PipelineSnapshotShape = z.infer<typeof PipelineSnapshot>;
export type PipelineIssueShape = z.infer<typeof PipelineIssue>;
export type PipelinePullRequestShape = z.infer<typeof PipelinePullRequest>;
export type PipelineEnvironmentShape = z.infer<typeof PipelineEnvironment>;
export type PipelineShipRunShape = z.infer<typeof PipelineShipRun>;
export type PipelineIssueShipShape = z.infer<typeof PipelineIssueShip>;

registry.registerPath({
  method: "get",
  path: `/pipeline`,
  tags: ["pipeline"],
  summary: "One snapshot of the delivery pipeline",
  description:
    "Mounted only when PIPELINE_GITHUB_TOKEN, FACILITATOR_EMAILS, DEPLOY_PASSPHRASE, STAGING_WEB_URL and PRODUCTION_WEB_URL are all set (`features.pipeline` in /health). Environments, branch heads, the open feature-request and bug issues plus those shipped in the last 14 days with their pull requests across the api, web and harness repositories, `onStaging` by comparing merge commits with what staging serves, the next release version from both changelogs, and the ship workflow's state. The shared part is cached for 10 seconds and rebuilt by one request at a time; when GitHub cannot be read the last-good snapshot (up to an hour old) is served with `stale: true`. `canDeploy` is computed per caller.",
  security: bearerAuth,
  responses: {
    200: jsonResponse("The snapshot", envelope(PipelineSnapshot)),
    ...errorResponses("UNAUTHORIZED", "UPSTREAM_ERROR", "UNAVAILABLE"),
  },
});
