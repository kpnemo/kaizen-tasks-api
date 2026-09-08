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
  })
  .openapi("FeatureRequestBody");

export const FeatureRequestResponse = z
  .object({ issueNumber: z.number().int(), issueUrl: z.url() })
  .openapi("FeatureRequestResponse");

export type FeatureRequestInput = z.infer<typeof FeatureRequestBody>;

registry.registerPath({
  method: "post",
  path: `/feature-requests`,
  tags: ["feature-requests"],
  summary: "File a feature request as a GitHub issue",
  description:
    "Mounted only when GITHUB_TOKEN and GITHUB_REPO are configured. The issue is labeled `feature-request` and carries the submitter's display name.",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: FeatureRequestBody } } } },
  responses: {
    201: jsonResponse("Issue created", envelope(FeatureRequestResponse)),
    ...errorResponses("VALIDATION_ERROR", "UNAUTHORIZED", "UPSTREAM_ERROR"),
  },
});
