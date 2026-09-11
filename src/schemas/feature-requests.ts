import { z } from "zod";
import { envelope, errorResponses, jsonResponse } from "./common.js";
import { bearerAuth, registry } from "./registry.js";

export const FeatureRequestBody = z
  .object({
    title: z.string().trim().min(3).max(120),
    problem: z.string().trim().min(10).max(4000),
    proposedBehavior: z.string().trim().min(10).max(4000),
    acceptanceCriteria: z.string().trim().min(10).max(4000),
    outOfScope: z.string().trim().max(4000).optional(),
    /** An interview conversation of the caller's, status `open` or `ready` (spec 3.2). */
    conversationId: z.uuid().optional(),
  })
  .openapi("FeatureRequestBody");

export const FeatureRequestResponse = z
  .object({ issueNumber: z.number().int(), issueUrl: z.url() })
  .openapi("FeatureRequestResponse");

export type FeatureRequestInput = z.infer<typeof FeatureRequestBody>;

export const FeatureRequestSummary = z
  .object({
    number: z.number().int(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    stage: z.enum(["new", "triaged", "implementing", "staging", "shipped", "closed"]),
    readiness: z.number().int().nullable(),
    labels: z.array(z.string()),
    url: z.url(),
    createdAt: z.string(),
    closedAt: z.string().nullable(),
  })
  .openapi("FeatureRequestSummary");

registry.registerPath({
  method: "get",
  path: `/feature-requests`,
  tags: ["feature-requests"],
  summary: "List the feature requests filed to GitHub",
  description:
    "Mounted only when GITHUB_TOKEN and GITHUB_REPO are configured. Issues labelled `feature-request`, open first then closed, newest first within each group, at most 50 per group. `stage` is the first lifecycle label in the order shipped, staging, implementing, triaged, else `closed` or `new`; `readiness` is the rubric score from the clarity, complexity and risk labels, null when any is missing.",
  security: bearerAuth,
  responses: {
    200: jsonResponse("Feature requests", envelope(z.array(FeatureRequestSummary))),
    ...errorResponses("UNAUTHORIZED", "UPSTREAM_ERROR"),
  },
});

registry.registerPath({
  method: "post",
  path: `/feature-requests`,
  tags: ["feature-requests"],
  summary: "File a feature request as a GitHub issue",
  description:
    "Mounted only when GITHUB_TOKEN and GITHUB_REPO are configured. The issue is labeled `feature-request` and carries the submitter's display name. With `conversationId`, the issue body also carries the interview's self-score and transcript, and the conversation becomes `filed`.",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: FeatureRequestBody } } } },
  responses: {
    201: jsonResponse("Issue created", envelope(FeatureRequestResponse)),
    ...errorResponses(
      "VALIDATION_ERROR",
      "UNAUTHORIZED",
      "NOT_FOUND",
      "CONFLICT",
      "UPSTREAM_ERROR",
    ),
  },
});
