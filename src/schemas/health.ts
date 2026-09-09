import { z } from "zod";
import { envelope, errorResponses, jsonResponse } from "./common.js";
import { registry } from "./registry.js";

const CheckState = z.enum(["ok", "failed"]);

export const HealthSchema = z
  .object({
    status: z.literal("ok"),
    commit: z.string(),
    version: z
      .string()
      .describe("package.json version of the running build; the web app prints it in its footer"),
    env: z.enum(["development", "test", "staging", "production"]),
    checks: z.object({ db: CheckState, redis: CheckState }),
    // Master plan section 4: true exactly when POST /feature-requests is mounted.
    features: z.object({ featureRequests: z.boolean() }),
  })
  .openapi("Health");

registry.registerPath({
  method: "get",
  path: `/health`,
  tags: ["system"],
  summary: "Health check with the running commit SHA",
  responses: {
    200: jsonResponse("Healthy", envelope(HealthSchema)),
    ...errorResponses("UNAVAILABLE"),
  },
});

registry.registerPath({
  method: "get",
  path: `/openapi.json`,
  tags: ["system"],
  summary: "This OpenAPI document",
  responses: {
    200: {
      description: "The committed openapi.json",
      content: { "application/json": { schema: z.looseObject({}) } },
    },
  },
});
